import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_TILE_IDS, getTileById } from '../config/dashboardTiles';

/**
 * dashboardSettingsStore — per-user tile selection, ordering, AND
 * per-tile configuration for the Dashboard. Persisted to localStorage so
 * the dashboard hydrates with the operator's choice on first paint.
 *
 * Schema:
 *   tiles  — ordered array of tile ids; the dashboard renders left-to-right
 *            top-to-bottom in this order
 *   config — sparse map of {tileId: { size?, days? }} — only populated
 *            when the user overrides a default. Stale ids are cleaned up
 *            at hydrate time so a renamed/removed tile never dangles.
 *
 * Per-tile config keys (all optional — when missing, the catalog default
 * applies):
 *   size     — grid columns the tile spans: 1 | 2 | 3
 *   interval — chart bucket size: 'day' | 'week' | 'month'
 *   periods  — how many buckets the chart shows; valid range depends on
 *              interval (see PERIOD_CHOICES_FOR_INTERVAL below)
 */
const defaults = () => ({
  tiles: [...DEFAULT_TILE_IDS],
  config: {},
});

const useDashboardSettingsStore = create(
  persist(
    (set, get) => ({
      ...defaults(),

      /* Replace the entire ordered tile list. */
      setTiles: (ids) => set({ tiles: Array.isArray(ids) ? [...ids] : [] }),

      /* Append a tile id (no-op if already present). */
      add: (id) => set((s) => (s.tiles.includes(id) ? s : { tiles: [...s.tiles, id] })),

      /* Drop a tile id AND its per-tile config (so a re-add starts clean). */
      remove: (id) => set((s) => {
        const nextConfig = { ...(s.config || {}) };
        delete nextConfig[id];
        return { tiles: s.tiles.filter((t) => t !== id), config: nextConfig };
      }),

      /* Move a tile by delta (-1 / +1). */
      move: (id, delta) => set((s) => {
        const i = s.tiles.indexOf(id);
        if (i < 0) return s;
        const j = i + delta;
        if (j < 0 || j >= s.tiles.length) return s;
        const next = s.tiles.slice();
        const [it] = next.splice(i, 1);
        next.splice(j, 0, it);
        return { tiles: next };
      }),

      /* Merge per-tile config. Pass partial: { size: 2 } to override one
       * key; leave other keys untouched. Pass null/empty to reset to
       * defaults — the absence of a key means "use catalog default". */
      setConfig: (id, partial) => set((s) => {
        const current = (s.config || {})[id] || {};
        const merged = { ...current, ...(partial || {}) };
        // Drop keys explicitly set to null/undefined so the entry is
        // pure overrides — keeps localStorage clean.
        for (const k of Object.keys(merged)) {
          if (merged[k] == null) delete merged[k];
        }
        const nextConfig = { ...(s.config || {}) };
        if (Object.keys(merged).length === 0) delete nextConfig[id];
        else nextConfig[id] = merged;
        return { config: nextConfig };
      }),

      /* Read merged config for a tile — catalog defaults plus user
       * overrides. Returns a fresh object every call so callers can
       * destructure without worrying about mutation. */
      getConfig: (id) => {
        const def = getTileById(id) || {};
        const userCfg = (get().config || {})[id] || {};
        const interval = userCfg.interval ?? def.defaultInterval ?? 'day';
        // Periods default depends on interval — 30 daily buckets, 13
        // weekly, 12 monthly are typical "see one cycle" picks.
        const periodsDefault = def.defaultPeriods
          ?? (interval === 'month' ? 12 : interval === 'week' ? 13 : 30);
        return {
          size: userCfg.size ?? def.size ?? 1,
          interval,
          periods: userCfg.periods ?? periodsDefault,
        };
      },

      /* Reset to factory defaults. */
      reset: () => set(defaults()),
    }),
    {
      name: 'erp-dashboard-settings',
      version: 2,
      /* Drop unknown ids and orphaned config entries at hydrate time so
       * a catalog rename never leaves the dashboard with broken state. */
      migrate: (persisted) => {
        if (!persisted) return defaults();
        const tiles = Array.isArray(persisted.tiles) ? persisted.tiles : [];
        const validIds = tiles.filter((id) => !!getTileById(id));
        const rawCfg = (persisted.config && typeof persisted.config === 'object') ? persisted.config : {};
        const cfg = {};
        for (const id of validIds) {
          const c = rawCfg[id];
          if (c && typeof c === 'object') cfg[id] = c;
        }
        return {
          tiles: validIds.length ? validIds : [...DEFAULT_TILE_IDS],
          config: cfg,
        };
      },
    },
  ),
);

export default useDashboardSettingsStore;

/* Allowed values for the per-tile config controls — used by the
 * settings page to render the segmented controls AND validated when
 * setConfig is called from anywhere else. */
export const SIZE_CHOICES = [1, 2, 3];
export const INTERVAL_CHOICES = ['day', 'week', 'month'];

// Period (bucket-count) choices vary by interval. The settings popover
// uses this map to update its segmented control whenever the operator
// switches interval — e.g. selecting "month" from "day, 30 buckets"
// snaps the period to a sensible monthly default.
export const PERIOD_CHOICES_FOR_INTERVAL = {
  day:   [7, 14, 30, 60, 90],
  week:  [4, 8, 13, 26, 52],
  month: [3, 6, 12, 24, 36],
};
export const DEFAULT_PERIODS_FOR_INTERVAL = {
  day:   30,
  week:  13,
  month: 12,
};
