/**
 * Statements, kept as they were served.
 *
 * ── WHY THIS ONE IS CACHE-ON-VIEW, NOT SCHEDULED ─────────────────────
 *
 * Parties and products are small, bounded sets that every screen needs, so
 * they are synced on a loop. Statements are neither: there is one per party
 * PER DATE RANGE, and pulling every party's history for every range anyone
 * might pick would be enormous and almost entirely wasted.
 *
 * So a statement is stored the moment it is successfully fetched. The ones
 * you looked at are exactly the ones you are likely to want again — and
 * looking at a party's statement is usually what happens just BEFORE needing
 * it in front of them.
 *
 * ── STORED VERBATIM ──────────────────────────────────────────────────
 *
 * The server's response goes in unchanged. A statement is read back whole and
 * rendered by the same component either way, so splitting it into columns
 * would buy nothing and every field mapping would be a chance for the offline
 * copy to differ from the live one.
 *
 * The running balance is deliberately NOT stored: the screen derives it from
 * `opening_balance` and each line's debit and credit. That is the same code
 * on the same inputs whether the figures came from the shop or from here, so
 * online and offline cannot disagree — which is the only property that
 * matters. The opening and closing figures ARE the server's, carried across
 * untouched.
 */
import { openMirror } from './mirrorDb';

/* Enough to cover the parties anyone actually works with, bounded so a year
 * of browsing cannot quietly fill the phone. Evicted oldest-first. */
const KEEP = 200;

const key = (partyId, from, to) => [Number(partyId), String(from), String(to)];

/** Store a statement exactly as served. Never throws — failing to cache must
 *  not break the screen that just loaded successfully. */
export async function saveStatement(partyId, from, to, payload) {
  if (!partyId || !from || !to || !payload) return false;
  const db = await openMirror();
  if (!db) return false;
  try {
    await db.run(
      'INSERT INTO statements (party_id, from_date, to_date, payload, synced_at) ' +
      'VALUES (?,?,?,?,?) ON CONFLICT(party_id, from_date, to_date) ' +
      'DO UPDATE SET payload = excluded.payload, synced_at = excluded.synced_at;',
      [...key(partyId, from, to), JSON.stringify(payload), Date.now()],
    );
    // Evict oldest beyond the cap, in the same pass rather than on a timer —
    // the only moment the table can grow is right here.
    await db.run(
      `DELETE FROM statements WHERE rowid NOT IN (
         SELECT rowid FROM statements ORDER BY synced_at DESC LIMIT ?);`,
      [KEEP],
    );
    return true;
  } catch (e) {
    console.warn('[mirror] saveStatement failed:', e?.message || e);
    return false;
  }
}

/**
 * The stored statement for exactly this party and period, or null.
 *
 * Deliberately an exact match on the range. Serving a statement for a
 * different period than the one asked for would produce a correct-looking
 * document with the wrong opening balance, which is worse than showing
 * nothing.
 */
export async function readStatement(partyId, from, to) {
  if (!partyId || !from || !to) return null;
  const db = await openMirror();
  if (!db) return null;
  try {
    const r = await db.query(
      'SELECT payload, synced_at FROM statements WHERE party_id = ? AND from_date = ? AND to_date = ?;',
      key(partyId, from, to),
    );
    const row = r?.values?.[0];
    if (!row?.payload) return null;
    return { data: JSON.parse(row.payload), syncedAt: Number(row.synced_at) || null };
  } catch (e) {
    console.warn('[mirror] readStatement failed:', e?.message || e);
    return null;
  }
}
