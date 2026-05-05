import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * homeSettingsStore — per-user layout preferences for the Command Center
 * (route /). Persisted to localStorage so the home page hydrates with the
 * operator's chosen layout on first paint, never with the default.
 *
 * Reading via Zustand `persist` is synchronous: by the time the React tree
 * renders, the store already holds the rehydrated values. That's the trick
 * that keeps the home page from "flinching" on refresh.
 *
 * Each KPI card and each chrome region (clock, greeting, search, actions)
 * has its own boolean so an operator can pare the page down to just a
 * search bar if that's all they want, or pump it full of context.
 */

const defaults = {
  /* Top KPI strip — the row of five summary cards. */
  showKpiStrip:    true,
  showKpiSales:    true,
  showKpiBills:    true,
  showKpiRecv:     true,
  showKpiPay:      true,
  showKpiProfit:   true,
  showKpiSparks:   true,   // sparkline on each card

  /* Middle hero block. */
  showGreeting:    true,
  showHeadline:    true,
  showClock:       true,
  showClockDate:   true,
  showLivePulse:   true,   // animated dot on the clock
  showSearch:      true,   // hero search bar
  showSearchHint:  true,   // "type ⌥S to start a sale, ⌘K to find anything"
  clockFormat:     '24',   // '24' | '12'
  clockDateFormat: 'long', // 'long' (TUESDAY · 05 MAY 2026) | 'numeric' (TUE · 05/05/2026)
  showSeconds:     false,  // when true, time reads HH:mm:ss (or h:mm:ss A) and the clock ticks every second

  /* Bottom action ribbon. */
  showActionRibbon: true,
  /* Which actions to show, in display order. The render layer filters this
   * against the canonical action catalog; unknown ids are ignored. */
  actions: ['sale-new', 'purchase-new', 'receipt-new', 'payment-new', 'reports', 'dashboard'],

  /* Background ambience. Off by default (Classic) — Modern themes can opt
   * the operator into a soft gradient wash via the toggle. */
  showAmbientGradient: false,
};

const useHomeSettingsStore = create(
  persist(
    (set) => ({
      ...defaults,

      /* Single setter — accepts a partial state and merges. Keeps the
       * settings page boilerplate-free (one `update({ showKpiStrip: true })`
       * call per toggle). */
      update: (partial) => set((s) => ({ ...s, ...partial })),

      /* Reset every toggle to defaults — used by the "Restore defaults"
       * button on the settings page. */
      reset: () => set(defaults),
    }),
    {
      name: 'erp-home-settings',
      version: 1,
      /* Future-proof migration: when fields are added, fill them with the
       * default value so old persisted state never produces undefined. */
      migrate: (persisted) => ({ ...defaults, ...(persisted || {}) }),
    },
  ),
);

export default useHomeSettingsStore;

/* Stable list of action ids the home page knows how to render — a single
 * source of truth for both the settings UI (which actions are toggleable)
 * and the Home component (which actions to render in order). */
export const KNOWN_ACTIONS = [
  'sale-new', 'purchase-new', 'receipt-new', 'payment-new',
  'sales-return', 'purchase-return', 'journal-new',
  'customers', 'suppliers', 'products',
  'reports', 'dashboard', 'day-book', 'banks',
];
