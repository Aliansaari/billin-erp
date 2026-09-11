/**
 * Stored responses, for the screens whose data is not a bounded set.
 *
 * ── TWO KINDS OF MIRRORED DATA ───────────────────────────────────────
 *
 * Parties and products are small, bounded, and wanted by every screen, so
 * they are synced on a loop into real tables with checksums (mirrorSync).
 *
 * Everything else — a statement, a day book, a dashboard, a voucher list —
 * is a QUESTION WITH ARGUMENTS. There is one answer per party per date range,
 * per day, per filter. Syncing every answer anyone might ask for would be
 * enormous and almost entirely wasted, so these are stored the moment they
 * are successfully fetched: the questions someone asks are the ones they are
 * likely to ask again.
 *
 * ── WHY VERBATIM ─────────────────────────────────────────────────────
 *
 * The server's answer goes in unchanged and comes back out unchanged, so the
 * same component renders the same shape whether the shop was reachable or
 * not. There is no field mapping, which means there is no field mapping to
 * get wrong — the class of bug where an offline screen quietly differs from
 * the live one cannot arise here.
 *
 * This holds figures the SERVER computed. It is not a licence to cache
 * something the device worked out for itself; that rule is unchanged.
 */
import { openMirror } from './mirrorDb';

/* Enough for the parties, days and views anyone actually works with, bounded
 * so months of browsing cannot quietly fill the phone. */
const KEEP = 300;

/**
 * Build a cache key from a name and its arguments.
 *
 * Arguments are sorted and included in full, deliberately. A key that ignored
 * one would serve the answer to a DIFFERENT question — a statement for the
 * wrong period, a day book for the wrong day — and that is far worse than a
 * miss, because it looks right.
 */
export function cacheKey(name, args = {}) {
  const parts = Object.keys(args)
    .filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== '')
    .sort()
    .map((k) => `${k}=${args[k]}`);
  return parts.length ? `${name}?${parts.join('&')}` : name;
}

/** Store one answer. Never throws — failing to cache must not break a screen
 *  that has just loaded successfully. */
export async function putCached(key, payload) {
  if (!key || payload === undefined || payload === null) return false;
  const db = await openMirror();
  if (!db) return false;
  try {
    await db.run(
      'INSERT INTO response_cache (cache_key, payload, synced_at) VALUES (?,?,?) ' +
      'ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, ' +
      'synced_at = excluded.synced_at;',
      [key, JSON.stringify(payload), Date.now()],
    );
    // Evicted here rather than on a timer: this is the only moment the table
    // can grow.
    await db.run(
      `DELETE FROM response_cache WHERE rowid NOT IN (
         SELECT rowid FROM response_cache ORDER BY synced_at DESC LIMIT ?);`,
      [KEEP],
    );
    return true;
  } catch (e) {
    console.warn('[mirror] putCached failed:', e?.message || e);
    return false;
  }
}

/** The stored answer to exactly this question, with when it was stored. */
export async function getCached(key) {
  if (!key) return null;
  const db = await openMirror();
  if (!db) return null;
  try {
    const r = await db.query(
      'SELECT payload, synced_at FROM response_cache WHERE cache_key = ?;',
      [key],
    );
    const row = r?.values?.[0];
    if (!row?.payload) return null;
    return { data: JSON.parse(row.payload), syncedAt: Number(row.synced_at) || null };
  } catch (e) {
    console.warn('[mirror] getCached failed:', e?.message || e);
    return null;
  }
}
