// ── useFinancialYear ──────────────────────────────────────────────────
//
// Single source of truth for the company's configured Financial Year
// AND the related compliance settings (soft-lock date, hard-lock date,
// audit toggle). Used by every period picker, the workspace-pill FY
// switcher, the past-FY banner, the smart cross-FY date detector, and
// the lock-check that gates bill saves in audit mode.
//
// Hydration model:
//   1. On import, read cached values from localStorage. Synchronous, so
//      the first paint already shows correct defaults (no flicker as the
//      API round-trips after login).
//   2. After login, refreshFinancialYear() pulls /api/settings/system
//      and updates the store. Subscribers re-render with the live data.
//   3. Cache is dropped on logout (handled in authStore).
//
// State shape (everything in one store so re-renders are coherent):
//   · Configured FY:      fyStart, fyEnd, fyStartMonth (1-12, default 4=April)
//   · Compliance:         complianceMode, softLockDate, hardLockDate,
//                         requireOverridePassword
//   · UI context:         viewingFYOffset (0 = current, -1 = prev, etc.)
//
// What this file exports:
//   · useFinancialYear()    → { fyStart, fyEnd }  — back-compat, 25+ callers
//   · useFYContext()        → richer state for FY switcher / banner / etc.
//   · useFYCompliance()     → just the compliance triple (toggle + locks)
//   · refreshFinancialYear() → imperative reload from /api/settings/system
//   · clearFinancialYearCache() → on logout
//   · fyForDate(date, fyStart) → which FY contains this date
//   · fyLabel(fy)           → "2026-27" display string
//
// Why "viewing offset" not "viewing start/end":
//   Storing an offset means the viewing context auto-adjusts if the
//   admin reconfigures the FY start month later — viewingFY is always
//   computed from currentFY ± offset, never stale.

import { create } from 'zustand';
import dayjs from 'dayjs';
import { settingsAPI } from '../api';

// localStorage keys — versioned so a schema bump invalidates old caches.
const LS_START      = 'fy_start_v1';
const LS_END        = 'fy_end_v1';
const LS_COMPLIANCE = 'fy_compliance_v1';
const LS_SOFT_LOCK  = 'fy_soft_lock_v1';
const LS_HARD_LOCK  = 'fy_hard_lock_v1';
const LS_REQ_PW     = 'fy_req_pw_v1';

function readCached(key) {
  try {
    const v = localStorage.getItem(key);
    if (!v || v === 'undefined' || v === 'null') return null;
    return v;
  } catch { return null; }
}
function readCachedDate(key) {
  const v = readCached(key);
  if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  return v.slice(0, 10);
}
function readCachedBool(key) {
  return readCached(key) === '1';
}

// ── FY math helpers ────────────────────────────────────────────────────
// Pure functions — no store access — so they're safe to import anywhere.

/* Given any date + the configured FY-start ISO date, return the FY
 * window (start + end + label) that contains the date. Handles
 * non-April FY starts (some firms use Jan or Jul). */
export function fyForDate(date, configuredStartISO) {
  if (!date || !configuredStartISO) return null;
  const d         = dayjs(date);
  const cfgStart  = dayjs(configuredStartISO);
  if (!d.isValid() || !cfgStart.isValid()) return null;
  const startMon  = cfgStart.month();        // 0-indexed
  const startDay  = cfgStart.date();
  // Build candidate FY start = same month/day as configured, in d's year
  let s = dayjs(new Date(d.year(), startMon, startDay));
  if (d.isBefore(s)) {
    // d falls before this year's FY start, so it belongs to the PREVIOUS FY
    s = s.subtract(1, 'year');
  }
  const e = s.add(1, 'year').subtract(1, 'day');
  return {
    start: s.format('YYYY-MM-DD'),
    end:   e.format('YYYY-MM-DD'),
    label: fyLabel({ start: s.format('YYYY-MM-DD') }),
    startYear: s.year(),
  };
}

/* "2026-27" display label from an FY object or start date. Indian
 * convention: short year on each side, hyphen between. */
export function fyLabel(fy) {
  if (!fy) return '';
  const startISO = typeof fy === 'string' ? fy : fy.start;
  if (!startISO) return '';
  const s = dayjs(startISO);
  if (!s.isValid()) return '';
  const startYr = s.year();
  const endYr   = startYr + 1;
  // "2026-27" — last two digits of end year, padded
  return `${startYr}-${String(endYr).slice(-2).padStart(2, '0')}`;
}

/* Shift an FY by N years (negative = past). Used to build the
 * pastFYs list off currentFY. */
function shiftFY(fy, years) {
  if (!fy) return null;
  const s = dayjs(fy.start).add(years, 'year');
  const e = dayjs(fy.end).add(years, 'year');
  return {
    start: s.format('YYYY-MM-DD'),
    end:   e.format('YYYY-MM-DD'),
    label: fyLabel({ start: s.format('YYYY-MM-DD') }),
    startYear: s.year(),
  };
}

// ── Zustand store ──────────────────────────────────────────────────────

const store = create((set, get) => ({
  // Configured FY — from /api/settings/system, hydrated from localStorage
  fyStart: readCachedDate(LS_START),
  fyEnd:   readCachedDate(LS_END),

  // Compliance triple — null/false until first load
  complianceMode:           readCachedBool(LS_COMPLIANCE),
  softLockDate:             readCachedDate(LS_SOFT_LOCK),
  hardLockDate:             readCachedDate(LS_HARD_LOCK),
  requireOverridePassword:  readCachedBool(LS_REQ_PW),

  // UI: how many years back from currentFY are we viewing?
  //   0 = current (default), -1 = previous, -2 = two years ago, etc.
  // Positive values disallowed (you don't "switch into" a future FY —
  // future-dated bills route automatically by date in simple mode).
  viewingFYOffset: 0,

  setFy: (fyStart, fyEnd) => {
    if (fyStart) try { localStorage.setItem(LS_START, fyStart); } catch {}
    if (fyEnd)   try { localStorage.setItem(LS_END,   fyEnd);   } catch {}
    set({ fyStart, fyEnd });
  },

  setCompliance: (mode, soft, hard, reqPw) => {
    try {
      localStorage.setItem(LS_COMPLIANCE, mode ? '1' : '0');
      localStorage.setItem(LS_REQ_PW,     reqPw ? '1' : '0');
      if (soft) localStorage.setItem(LS_SOFT_LOCK, soft); else localStorage.removeItem(LS_SOFT_LOCK);
      if (hard) localStorage.setItem(LS_HARD_LOCK, hard); else localStorage.removeItem(LS_HARD_LOCK);
    } catch {}
    set({
      complianceMode:          !!mode,
      softLockDate:            soft || null,
      hardLockDate:            hard || null,
      requireOverridePassword: !!reqPw,
    });
  },

  switchTo: (offset) => {
    // Defensive: clamp non-positive integer
    const n = Math.min(0, Math.floor(Number(offset) || 0));
    set({ viewingFYOffset: n });
  },

  resetView: () => set({ viewingFYOffset: 0 }),

  clear: () => {
    try {
      localStorage.removeItem(LS_START);
      localStorage.removeItem(LS_END);
      localStorage.removeItem(LS_COMPLIANCE);
      localStorage.removeItem(LS_SOFT_LOCK);
      localStorage.removeItem(LS_HARD_LOCK);
      localStorage.removeItem(LS_REQ_PW);
    } catch {}
    set({
      fyStart: null, fyEnd: null,
      complianceMode: false, softLockDate: null, hardLockDate: null,
      requireOverridePassword: false,
      viewingFYOffset: 0,
    });
  },
}));

// ── Hooks ──────────────────────────────────────────────────────────────

/* Back-compat hook. 25+ callers destructure { fyStart, fyEnd } and
 * default their period pickers to it. Keep the shape stable. */
export function useFinancialYear() {
  const fyStart = store((s) => s.fyStart);
  const fyEnd   = store((s) => s.fyEnd);
  return { fyStart, fyEnd };
}

/* Richer hook for the FY switcher / banner / smart-date detector.
 * Returns derived currentFY + viewingFY + pastFYs in addition to the
 * raw fyStart/fyEnd. */
export function useFYContext() {
  const fyStart        = store((s) => s.fyStart);
  const fyEnd          = store((s) => s.fyEnd);
  const viewingOffset  = store((s) => s.viewingFYOffset);
  const switchTo       = store((s) => s.switchTo);
  const resetView      = store((s) => s.resetView);

  if (!fyStart || !fyEnd) {
    return {
      currentFY: null, viewingFY: null, pastFYs: [],
      isViewingPast: false, viewingOffset: 0,
      switchTo, resetView, fyForDate: () => null,
    };
  }
  const currentFY = {
    start: fyStart,
    end:   fyEnd,
    label: fyLabel({ start: fyStart }),
    startYear: dayjs(fyStart).year(),
  };
  const viewingFY = viewingOffset === 0 ? currentFY : shiftFY(currentFY, viewingOffset);
  // Last 3 past FYs (offset -1 / -2 / -3). Plus current at offset 0.
  // Display order in the switcher: current first, then most-recent past.
  const pastFYs = [-1, -2, -3].map((off) => ({ ...shiftFY(currentFY, off), offset: off }));
  return {
    currentFY,
    viewingFY,
    pastFYs,
    isViewingPast: viewingOffset !== 0,
    viewingOffset,
    switchTo,
    resetView,
    fyForDate: (d) => fyForDate(d, fyStart),
  };
}

/* Compliance-only hook — what audit mode is on and what the locks are.
 * Used by the Settings page + the (Stage 2) useFiscalLock hook. */
export function useFYCompliance() {
  const complianceMode          = store((s) => s.complianceMode);
  const softLockDate            = store((s) => s.softLockDate);
  const hardLockDate            = store((s) => s.hardLockDate);
  const requireOverridePassword = store((s) => s.requireOverridePassword);
  return { complianceMode, softLockDate, hardLockDate, requireOverridePassword };
}

// ── Imperative API ─────────────────────────────────────────────────────

/* Reload from /api/settings/system. Called after login, after the
 * Settings → Financial Year page saves, and after Company Profile
 * saves (where FY dates also live). Safe to call repeatedly. */
export async function refreshFinancialYear() {
  try {
    const { data: s } = await settingsAPI.getSystem();
    const sys = s?.data || s || {};
    const start = sys.financial_year_start ? String(sys.financial_year_start).slice(0, 10) : null;
    const end   = sys.financial_year_end   ? String(sys.financial_year_end).slice(0, 10)   : null;
    if (start && end) store.getState().setFy(start, end);
    store.getState().setCompliance(
      !!sys.fy_compliance_mode,
      sys.fy_soft_lock_date ? String(sys.fy_soft_lock_date).slice(0, 10) : null,
      sys.fy_hard_lock_date ? String(sys.fy_hard_lock_date).slice(0, 10) : null,
      !!sys.fy_require_override_password,
    );
  } catch { /* keep cache; pickers stay usable */ }
}

export function clearFinancialYearCache() {
  store.getState().clear();
}
