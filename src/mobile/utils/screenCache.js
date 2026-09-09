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
 * Deliberately in-memory only: money figures should not survive an app
 * restart pretending to be current. That is what the offline snapshot is for,
 * and it carries a visible "as of" age precisely because it can be stale.
 */

const store = new Map();

// Long enough to make back-and-forth navigation instant, short enough that a
// bill entered on the desktop shows up on the next visit rather than the one
// after.
const DEFAULT_TTL_MS = 60_000;

export function getCached(key, { ttl = DEFAULT_TTL_MS } = {}) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function setCached(key, value) {
  store.set(key, { value, at: Date.now() });
  return value;
}

/** Drop cached data — call after any write, so the next read is authoritative. */
export function invalidateCache(prefix) {
  if (!prefix) { store.clear(); return; }
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
}
