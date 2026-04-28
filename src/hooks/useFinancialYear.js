// ── useFinancialYear ──────────────────────────────────────────────────
//
// Single source of truth for the company's configured Financial Year
// start/end. Used by every period picker on every page so they all
// default to the same window without each one fetching settings on
// mount (was causing flicker — picker would show null → today's date
// → the real FY value over ~200ms after the API call resolved).
//
// Hydration model:
//   1. On import, read cached fyStart/fyEnd from localStorage. This is
//      synchronous, so the first paint already shows correct defaults.
//   2. After login, a top-level effect calls `refreshFinancialYear()`
//      to pull the live values from /api/settings/system. If they
//      changed (admin updated FY config), components re-render with
//      the new values via the Zustand subscription.
//   3. Cache is dropped on logout (handled in authStore).
//
// Format: ISO YYYY-MM-DD strings (or null if not yet loaded). The
// component-side helper `dayjs(fyStart)` builds the picker value.

import { create } from 'zustand';
import { settingsAPI } from '../api';

const LS_START = 'fy_start_v1';
const LS_END   = 'fy_end_v1';

function readCached(key) {
  try {
    const v = localStorage.getItem(key);
    if (!v || v === 'undefined' || v === 'null') return null;
    // Sanity: must look like a YYYY-MM-DD prefix.
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
    return v.slice(0, 10);
  } catch { return null; }
}

const store = create((set) => ({
  // Synchronous initial hydration from localStorage so the first paint
  // of any picker already has the right default, no flicker.
  fyStart: readCached(LS_START),
  fyEnd:   readCached(LS_END),

  setFy: (fyStart, fyEnd) => {
    if (fyStart) {
      try { localStorage.setItem(LS_START, fyStart); } catch {}
    }
    if (fyEnd) {
      try { localStorage.setItem(LS_END, fyEnd); } catch {}
    }
    set({ fyStart, fyEnd });
  },

  clear: () => {
    try { localStorage.removeItem(LS_START); localStorage.removeItem(LS_END); } catch {}
    set({ fyStart: null, fyEnd: null });
  },
}));

// Hook — returns fyStart, fyEnd. Components subscribe to changes so
// when admin updates FY in settings, every open picker re-renders
// with the new default (next page load also picks it up via cache).
export function useFinancialYear() {
  const { fyStart, fyEnd } = store();
  return { fyStart, fyEnd };
}

// Imperative refresh — call after login + after FY settings save.
// Safe to call repeatedly; updates cache only if the server has
// values. Ignores network errors (we already have a cached fallback).
export async function refreshFinancialYear() {
  try {
    const { data: s } = await settingsAPI.getSystem();
    const sys = s?.data || s || {};
    const start = sys.financial_year_start ? String(sys.financial_year_start).slice(0, 10) : null;
    const end   = sys.financial_year_end   ? String(sys.financial_year_end).slice(0, 10)   : null;
    if (start && end) store.getState().setFy(start, end);
  } catch { /* keep cache; pickers stay usable */ }
}

export function clearFinancialYearCache() {
  store.getState().clear();
}
