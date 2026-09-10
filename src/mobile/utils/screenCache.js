/**
 * Stale-while-revalidate cache for screen data.
 *
 * Every tab switch refetched from scratch, so returning to a screen you were
 * looking at two seconds ago meant a spinner and a blank list again. Nothing
 * was slow in isolation — no long tasks, a 260-node DOM — but the app felt
 * unresponsive because it kept throwing away work it had already done.
 *
 * Now a screen paints its last known data immediately and refreshes behind
 * that. The figures on screen are never older than one tab switch, and the
 * refresh replaces them silently when it lands.
 *
 * It also survives a relaunch, but only briefly. The original version was
 * memory-only on the principle that money figures must not outlive a restart
 * pretending to be current — which is right, and is why the offline snapshot
 * carries a visible "as of" age. But a WebView is restarted for reasons that
 * have nothing to do with the operator (memory pressure, a background purge),
 * and after each one every tab went back to a spinner. That is the thing that
 * makes an app feel like a web page.
 *
 * So: persisted, with a short rehydrate window, and ONLY as the first paint of
 * a screen that is already fetching. Nothing here is ever the final answer —
 * the live request lands a moment later and replaces it. Past the window the
 * stored copy is ignored entirely rather than shown with a caveat, because a
 * caveat on a number is not something anyone reads mid-sale.
 */

const store = new Map();

// Long enough to make back-and-forth navigation instant, short enough that a
// bill entered on the desktop shows up on the next visit rather than the one
// after.
const DEFAULT_TTL_MS = 60_000;

/* How long a persisted copy may still be used as a first paint after a
 * relaunch. Minutes, not hours: long enough to cover a WebView restart while
 * the phone is in the operator's hand, too short to cover a lunch break. */
const REHYDRATE_MS = 10 * 60_000;

const PERSIST_KEY = 'zehen_screen_cache';

/* A 30,000-row catalogue is not going in localStorage. Anything past this is
 * cached in memory only — the screens that hold that much data are the ones
 * that page from the server anyway. */
const MAX_PERSIST_BYTES = 192 * 1024;

/** Load the persisted copies once, at module load, dropping anything stale. */
(function rehydrate() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const now = Date.now();
    for (const [k, hit] of Object.entries(saved || {})) {
      if (hit && typeof hit.at === 'number' && now - hit.at <= REHYDRATE_MS) {
        store.set(k, hit);
      }
    }
  } catch { /* corrupt or unavailable — start empty, which is always safe */ }
})();

let flushTimer = null;
function schedulePersist() {
  if (flushTimer) return;
  // Coalesced and deferred: several screens settle at once on boot, and
  // serialising on each one would be the most expensive thing happening.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      const out = {};
      for (const [k, hit] of store.entries()) {
        const json = JSON.stringify(hit);
        if (json.length <= MAX_PERSIST_BYTES) out[k] = hit;
      }
      localStorage.setItem(PERSIST_KEY, JSON.stringify(out));
    } catch { /* quota or private mode — memory cache still works */ }
  }, 800);
}

export function getCached(key, { ttl = DEFAULT_TTL_MS } = {}) {
  const hit = store.get(key);
  if (!hit) return null;
  // A copy restored from a previous run is allowed the longer window; one
  // written in this session gets the short one.
  const limit = Math.max(ttl, hit.persisted ? REHYDRATE_MS : 0);
  if (Date.now() - hit.at > limit) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function setCached(key, value) {
  store.set(key, { value, at: Date.now(), persisted: true });
  schedulePersist();
  return value;
}

/** Drop cached data — call after any write, so the next read is authoritative. */
export function invalidateCache(prefix) {
  if (!prefix) { store.clear(); } 
  else { for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k); }
  schedulePersist();
}
