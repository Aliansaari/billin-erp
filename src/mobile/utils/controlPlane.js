/**
 * Where the ZEHEN control plane lives.
 *
 * Resolution order, highest wins:
 *   1. localStorage 'zehen_control_plane'  — runtime override
 *   2. VITE_CONTROL_PLANE_URL              — build-time
 *   3. production default
 *
 * The runtime override exists because the build-time value is baked into a
 * shipped app: without it, pointing a single phone at a staging control plane
 * (or at a developer's machine to reproduce a pairing bug) would mean cutting
 * a whole new build. It is read-only configuration — it carries no
 * credentials and grants nothing on its own.
 */
export const CONTROL_PLANE_KEY = 'zehen_control_plane';

const BUILD_DEFAULT =
  (import.meta?.env?.VITE_CONTROL_PLANE_URL
    || 'https://zehen-control-plane.aliansari7131.workers.dev');

export function controlPlaneUrl() {
  try {
    const override = localStorage.getItem(CONTROL_PLANE_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch { /* private mode */ }
  return String(BUILD_DEFAULT).replace(/\/+$/, '');
}

/**
 * A stable id for THIS installation of the app.
 *
 * Device slots are keyed on (account, install), so re-signing-in on the same
 * phone reuses its slot instead of consuming another — and, more importantly,
 * signing in on a second device no longer silently evicts the first.
 *
 * Generated once and kept in local storage. Losing it (reinstall, cleared
 * data) simply looks like a new device, which is the honest interpretation.
 */
export function installId() {
  const KEY = 'zehen_install_id';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto?.randomUUID?.() || `i${Date.now()}${Math.random().toString(16).slice(2)}`)
        .replace(/[^A-Za-z0-9_-]/g, '');
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return '';   // private mode — server falls back to per-account behaviour
  }
}
