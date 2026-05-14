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

// Main guard. Returns { ok: boolean, reason?: string }.
// Controllers call this after they've parsed the voucher date and
// before they open the write transaction. A failed check returns a
// 403 with a clear message naming WHICH flag blocked the entry so
// the user knows whether to escalate to admin or company-wide setting.
async function checkBackdated({ voucherDate, user, transaction }) {
  const dKey = dateKey(voucherDate);
  if (!dKey) return { ok: true }; // controller-side validation will catch a missing date
  const today = todayLocalIso();
  if (dKey >= today) return { ok: true };

  const settings = await readSettings(transaction);
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
};
