import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* ── Current-company store ───────────────────────────────────────────
 *
 * Tracks which company is "currently selected" on this device. Two
 * separate states:
 *
 *   list        — every active company the master DB knows about.
 *                 Refreshed on every login + every Manage Companies
 *                 page load. Used by the topbar switcher dropdown.
 *
 *   currentId   — the company the user picked at login (or by
 *                 switching mid-session). Persisted in localStorage so
 *                 a reload returns to the same company instead of
 *                 re-prompting.
 *
 * Phase 1 note: the server doesn't actually route per-request based on
 * this id yet — that comes in Phase 2 with the connection-pool
 * refactor. For now, the value is used purely for UI state (which
 * company name shows in the topbar, which the picker pre-selects).
 *
 * The currentId is cleared on logout so the next user picks fresh.
 * ────────────────────────────────────────────────────────────────── */
const useCompanyStore = create(
  persist(
    (set, get) => ({
      list: [],
      currentId: null,
      loading: false,

      setList: (rows) => set({ list: rows || [] }),
      setLoading: (v) => set({ loading: !!v }),

      // Pick a company. Triggers a topbar re-render via store
      // subscription. Phase 2 will additionally re-issue the JWT with
      // the new company_id claim and redirect to a clean dashboard.
      pick: (companyId) => set({ currentId: Number(companyId) || null }),

      clear: () => set({ currentId: null }),

      // Convenience selector for components that want the full row of
      // the active company (logo, accent, name, gstin).
      getCurrent: () => {
        const id = get().currentId;
        if (!id) return null;
        return (get().list || []).find((c) => Number(c.company_id) === id) || null;
      },
    }),
    {
      name: 'billing_erp_company',
      partialize: (s) => ({ currentId: s.currentId }),
    },
  ),
);

export default useCompanyStore;
