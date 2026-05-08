/*
 * Shared, in-memory cache for /api/settings/system.
 *
 * Many surfaces depend on the same handful of feature flags
 * (multi_warehouse_enabled, batch_tracking_enabled, gst_enabled, …)
 * — sidebar, settings rail, every bill form, every stock report.
 * Refetching per page on every render hammers the API for data that
 * almost never changes during a session, so we hold the response in
 * a module-scoped cache and let any number of components subscribe
 * via `useSystemSettings()`.
 *
 * Cache lifecycle:
 *   - First subscriber triggers the fetch; further subscribers wait
 *     on the in-flight promise.
 *   - Once resolved, every subscriber gets the value synchronously.
 *   - `refreshSystemSettings()` invalidates and refetches — call this
 *     from the Features settings page after a save so flag changes
 *     propagate to consumers without a full reload.
 */
import { useEffect, useState } from 'react';
import { settingsAPI } from '../api';
import useDevModeStore from '../store/devModeStore';

let cache = null;
let pending = null;
const subscribers = new Set();

function notify() {
  for (const cb of subscribers) cb(cache);
}

function fetchSettings() {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  pending = settingsAPI.getSystem()
    .then(({ data }) => {
      cache = (data && data.data) ? data.data : (data || {});
      pending = null;
      notify();
      return cache;
    })
    .catch((err) => { pending = null; throw err; });
  return pending;
}

export function refreshSystemSettings() {
  cache = null;
  return fetchSettings();
}

export function useSystemSettings() {
  const [settings, setSettings] = useState(cache);
  useEffect(() => {
    let active = true;
    fetchSettings().then((s) => { if (active) setSettings(s); }).catch(() => {});
    const cb = (s) => { if (active) setSettings(s); };
    subscribers.add(cb);
    return () => { active = false; subscribers.delete(cb); };
  }, []);
  return settings;
}

// Selector helpers — return null while loading so callers can choose
// whether to hide UI optimistically (safer default) or render a
// placeholder. Most consumers treat null as "loading, hide".
export function useMultiWarehouseEnabled() {
  const s = useSystemSettings();
  return s == null ? null : !!s.multi_warehouse_enabled;
}

/* ── Developer-tier feature gates ─────────────────────────────────────
 *
 * Returns true when the named feature should be VISIBLE for the current
 * session. The rule is:
 *
 *   - Developer-mode unlock?  → always visible (developers see everything)
 *   - dev_show_<feature> flag in system_settings is true? → visible
 *   - else → hidden
 *
 * Use the named helpers below for consumers; new flags need a one-line
 * addition. Loading state returns `false` (the safer default — hide
 * power-tools while we're unsure, rather than risk an accidental click).
 * ─────────────────────────────────────────────────────────────── */

function useDevOrFlag(flagName) {
  const settings = useSystemSettings();
  const devUnlocked = useDevModeStore((s) => s.unlocked);
  const previewAsUser = useDevModeStore((s) => s.previewAsUser);
  // "Preview as user" makes the dev experience exactly mirror what a
  // regular user sees. The developer can flip toggles, then enable
  // preview to verify; flip preview off to get full dev access back.
  if (devUnlocked && !previewAsUser) return true;
  if (settings == null) return false;
  return !!settings[flagName];
}

export const useShowLedgerIntegrity = () => useDevOrFlag('dev_show_ledger_integrity');
export const useShowDataCleanup     = () => useDevOrFlag('dev_show_data_cleanup');
export const useShowBackupRestore   = () => useDevOrFlag('dev_show_backup_restore');
export const useShowTallySync       = () => useDevOrFlag('dev_show_tally_sync');
export const useShowImportExport    = () => useDevOrFlag('dev_show_import_export');
export const useShowServerSettings  = () => useDevOrFlag('dev_show_server_settings');

/** Convenience: are we currently in developer mode (unlocked on this
 *  device)? Same value as useDevModeStore(s => s.unlocked) but exported
 *  here so feature code only needs one import. */
export const useDeveloperMode = () => useDevModeStore((s) => s.unlocked);
