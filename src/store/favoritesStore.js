import { create } from 'zustand';
import { favoritesAPI } from '../api';

/*
 * Favorites store — single source of truth for the user's pinned
 * reports across the app. Both the Reports hub (/reports) and the
 * Reports nav dropdown subscribe; mutations are optimistic with
 * server reconciliation, so the UI feels instant.
 *
 * State shape:
 *   ids       — string[] of report ids in pin order (oldest first,
 *               matches server's order by pinned_at ASC)
 *   loading   — true on the first load (gates the dropdown's empty-
 *               state placeholder vs "loading" placeholder)
 *   loaded    — flips true after the first successful list-fetch.
 *               Used by consumers that want to render a skeleton
 *               only on the initial load, not on subsequent
 *               refreshes.
 *
 * Mutations:
 *   pin(id)   — optimistically prepends to ids → server POST.
 *               On failure: revert + caller's toast.
 *   unpin(id) — optimistically removes from ids → server DELETE.
 *               Same revert-on-failure shape.
 *   toggle(id) — convenience for FavoriteStar's onClick.
 *
 * Why optimistic without revalidation: the only writers are this
 * store's own mutations (server returns the same shape we already
 * applied). Network errors are the only divergence path, and we
 * handle those by reverting.
 */

const useFavoritesStore = create((set, get) => ({
  ids: [],
  loading: false,
  loaded: false,

  // Initial fetch on auth. Idempotent — calling it again refreshes
  // from server (useful after a manual logout/login or settings reset).
  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const { data } = await favoritesAPI.list();
      set({ ids: Array.isArray(data) ? data : [], loaded: true });
    } catch (err) {
      // Don't blow up the app on a 401/403 here — the store stays in
      // an empty state and the UI degrades gracefully (dropdown shows
      // empty state, hub still renders all reports without stars
      // filled). Loading flag clears in the finally below.
      console.warn('[favorites] load failed:', err?.response?.data?.error || err.message);
    } finally {
      set({ loading: false });
    }
  },

  // True iff this report is currently in the user's pin list.
  has: (reportId) => get().ids.includes(reportId),

  pin: async (reportId) => {
    if (get().has(reportId)) return;
    // Optimistic: append to maintain pin-order semantics (oldest first
    // — same as the server returns). Newer pins go to the END so the
    // dropdown stays predictable.
    set((s) => ({ ids: [...s.ids, reportId] }));
    try {
      await favoritesAPI.pin(reportId);
    } catch (err) {
      // Revert on failure — drop just the id we added.
      set((s) => ({ ids: s.ids.filter((id) => id !== reportId) }));
      throw err;
    }
  },

  unpin: async (reportId) => {
    if (!get().has(reportId)) return;
    const before = get().ids;
    set((s) => ({ ids: s.ids.filter((id) => id !== reportId) }));
    try {
      await favoritesAPI.unpin(reportId);
    } catch (err) {
      // Revert by restoring the previous list (preserves ordering).
      set({ ids: before });
      throw err;
    }
  },

  toggle: async (reportId) => {
    return get().has(reportId)
      ? get().unpin(reportId)
      : get().pin(reportId);
  },

  // For test setups + the auth logout flow (clearing favorites when a
  // different user logs in on the same device).
  reset: () => set({ ids: [], loaded: false, loading: false }),
}));

export default useFavoritesStore;
