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
import { cacheKey, putCached, getCached } from './mirrorCache';

const keyFor = (partyId, from, to) =>
  cacheKey('statement', { party: Number(partyId), from, to });

/** Store a statement exactly as served. */
export async function saveStatement(partyId, from, to, payload) {
  if (!partyId || !from || !to || !payload) return false;
  return putCached(keyFor(partyId, from, to), payload);
}

/**
 * The stored statement for exactly this party and period, or null.
 *
 * The period is part of the key, so a statement can never be served for a
 * range it was not computed for. Doing so would produce a correct-looking
 * document with the wrong opening balance — worse than showing nothing,
 * because nothing about it would look wrong.
 */
export async function readStatement(partyId, from, to) {
  if (!partyId || !from || !to) return null;
  return getCached(keyFor(partyId, from, to));
}
