// ── Back-dated entry guard ──────────────────────────────────────────
//
// Enforces SystemSettings.allow_backdated_entries +
// Role.can_enter_backdated for every controller that writes a
// transactional record (sales, purchase, returns, payment, journal,
// expense, loan EMI). Both flags default to TRUE so an upgrade is
// behaviourally identical — only an admin who deliberately flips one
// of them tightens the policy.
//
// Decision rule:
//   • voucherDate >= today (local TZ) → always allowed
//   • SystemSettings.allow_backdated_entries === false → reject
//   • Role.can_enter_backdated === false → reject
//   • otherwise → allow
//
// Reads SystemSettings once per process and caches for 60 s — the
// flag changes are an admin-driven event, not per-request, so a short
// cache keeps the hot path off the DB while still picking up changes
// within a minute of toggling in the UI.

const { SystemSettings } = require('../models');

let _cache = { value: null, ts: 0 };
const TTL_MS = 60 * 1000;

async function readSettings(transaction) {
  const now = Date.now();
  if (_cache.value && now - _cache.ts < TTL_MS) return _cache.value;
  const row = await SystemSettings.findByPk(1, { transaction });
  _cache = { value: row || { allow_backdated_entries: true }, ts: now };
  return _cache.value;
}

// Force-invalidate the cache when settings change (called from
// settingsController.update). Cheap and safe to call.
function invalidateCache() {
  _cache = { value: null, ts: 0 };
}

// Local-tz today as 'YYYY-MM-DD'. Matches the DATEONLY columns the
// bill/voucher tables use; avoids UTC-edge timezone bugs on hosts
// west of UTC where new Date().toISOString() is yesterday's date.
function todayLocalIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Normalise a date input (Date | 'YYYY-MM-DD' | ISO string) to a
// 'YYYY-MM-DD' local-tz day. Returns null if the input is missing.
function dateKey(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    // Already ISO-day → trust it (the controllers store DATEONLY).
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
    // Full ISO timestamp → take the leading 10 chars.
    if (/^\d{4}-\d{2}-\d{2}T/.test(input)) return input.slice(0, 10);
    // Anything else falls through to Date parsing.
    const d = new Date(input);
    if (!Number.isFinite(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (input instanceof Date) {
    return `${input.getFullYear()}-${String(input.getMonth() + 1).padStart(2, '0')}-${String(input.getDate()).padStart(2, '0')}`;
  }
  return null;
}

// Compute the end of the CURRENT financial year (local-tz 'YYYY-MM-DD').
//
// Prefers `system_settings.financial_year_end` when present (admin-set), else
// computes from `fy_start_month` (defaults to 4 = April for India). The FY
// "current" semantic is anchored at today: whichever FY today falls into,
// that FY's end is the boundary. So on 2026-05-15 with April-start the
// current FY end is 2027-03-31; on 2026-02-10 it's 2026-03-31.
function currentFyEndIso(settings) {
  // Prefer the explicit setting if it's still in the future
  if (settings && settings.financial_year_end) {
    const end = String(settings.financial_year_end).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end >= todayLocalIso()) return end;
  }
  // Derive from fy_start_month. fy_start_month defaults to 4 (April).
  const startMonth = Math.max(1, Math.min(12, parseInt(settings && settings.fy_start_month, 10) || 4));
  const d = new Date();
  const todayMonth = d.getMonth() + 1; // 1..12
  const todayYear  = d.getFullYear();
  // If today is BEFORE the FY-start month, we're in the FY that began LAST year.
  // FY end is then 'this year, startMonth-1, last-day'.
  // If today is AT/AFTER startMonth, FY end is 'next year, startMonth-1, last-day'.
  const endYear = todayMonth < startMonth ? todayYear : todayYear + 1;
  const endMonth = startMonth - 1 === 0 ? 12 : startMonth - 1;
  const endYearAdj = startMonth === 1 ? endYear - 1 : endYear;
  // Last day of endMonth: take 1st of next month, subtract 1.
  const lastDay = new Date(endYearAdj, endMonth, 0).getDate();
  return `${endYearAdj}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

// Main guard. Returns { ok: boolean, reason?: string }.
// Controllers call this after they've parsed the voucher date and
// before they open the write transaction. A failed check returns a
// 403 with a clear message naming WHICH flag blocked the entry so
// the user knows whether to escalate to admin or company-wide setting.
//
// Audit CR-5 (modified) — also blocks FUTURE-dated entries that fall
// BEYOND the current financial year. Future-within-FY is allowed
// silently (operators routinely back/forward-dating within the FY for
// legitimate reasons: post-dated cheques, planned-purchase orders).
// Beyond-FY is hard-blocked with FUTURE_DATE_BEYOND_FY — mirrors the
// BACKDATED_BLOCKED_BY_COMPANY behaviour (no override path; admin must
// move into the next FY first).
async function checkBackdated({ voucherDate, user, transaction }) {
  const dKey = dateKey(voucherDate);
  if (!dKey) return { ok: true }; // controller-side validation will catch a missing date
  const today = todayLocalIso();
  const settings = await readSettings(transaction);

  // ── Future-date branch (CR-5) ───────────────────────────────────────
  if (dKey > today) {
    const fyEnd = currentFyEndIso(settings || {});
    if (dKey > fyEnd) {
      return {
        ok: false,
        reason: `Date ${dKey} is beyond the current financial year (ends ${fyEnd}). Move into the next FY before posting voucher dates after ${fyEnd}.`,
        code: 'FUTURE_DATE_BEYOND_FY',
      };
    }
    return { ok: true }; // future-within-FY allowed silently
  }

  // ── Same-day branch ─────────────────────────────────────────────────
  if (dKey === today) return { ok: true };

  // ── Back-date branch (original logic) ───────────────────────────────
  if (settings && settings.allow_backdated_entries === false) {
    return {
      ok: false,
      reason: 'Back-dated entries are disabled company-wide. Ask an admin to enable them in Settings → Defaults.',
      code: 'BACKDATED_BLOCKED_BY_COMPANY',
    };
  }

  // Role check — if user has no role attached (system/internal callers
  // like the import worker), allow. Production controllers always set
  // req.user with the Role include.
  const role = user && user.Role;
  if (role && role.can_enter_backdated === false) {
    return {
      ok: false,
      reason: `Your role (${role.role_name}) cannot post back-dated entries. Ask an admin to grant "Allow back-dated entries" in User Management.`,
      code: 'BACKDATED_BLOCKED_BY_ROLE',
    };
  }

  return { ok: true };
}

module.exports = {
  checkBackdated,
  invalidateCache,
  // Exposed for tests + the settings update hook.
  _readSettings: readSettings,
  _todayLocalIso: todayLocalIso,
  _dateKey: dateKey,
  _currentFyEndIso: currentFyEndIso,
};
