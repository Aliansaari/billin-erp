/**
 * Filling the mirror.
 *
 * ── HOW A SYNC CANNOT LEAVE A WRONG NUMBER BEHIND ────────────────────
 *
 * Three properties, each closing a different way this could quote a false
 * balance to a customer:
 *
 *   Whole-set replacement.  The device deletes and rewrites the entire set in
 *   one transaction. None of the money tables carry `updated_at`, and ledger
 *   rows are hard-deleted, so a delta feed could never say "this row is
 *   gone" — a cancelled bill would survive on the phone and keep being
 *   counted. If a row is not in the new set, it is not in the mirror.
 *
 *   Atomic.  The rewrite is one transaction, so a sync interrupted halfway
 *   leaves the previous set intact rather than a half-populated one. There is
 *   no moment at which the mirror holds some of yesterday and some of today.
 *
 *   Verified.  After committing, the device recomputes the row count and the
 *   sum of balances FROM ITS OWN STORAGE and compares both to the figures the
 *   server sent. They must match exactly, in integer paise. If they do not,
 *   the mirror is marked untrusted and the app stops serving money from it —
 *   it does not "mostly work".
 *
 * The last one is the important one. The first two make corruption unlikely;
 * the third makes it *detectable*, which is the only property worth anything
 * when the alternative is finding out in front of a customer.
 */
import api from '../../api';
import { openMirror, setMeta, getMeta } from './mirrorDb';

export const META_SYNCED_AT   = 'parties_synced_at';   // the SERVER's clock
export const META_TRUSTED     = 'parties_trusted';     // '1' | '0'
export const META_CHECKSUM    = 'parties_checksum';

const toPaise = (v) => Math.round(Number(v || 0) * 100);

/* Inserted in chunks because a single statement with thousands of bound
 * parameters is refused by SQLite (SQLITE_MAX_VARIABLE_NUMBER), and the
 * failure arrives as an opaque prepare error rather than anything that names
 * the cause. Seven columns per row, so this stays well inside the limit. */
const CHUNK = 100;

/**
 * Pull the party set and replace the device's copy with it.
 *
 * Returns { ok, trusted, syncedAt, count, reason } — never throws, because a
 * failed sync must leave the app working on whatever it already had rather
 * than taking a screen down.
 */
export async function syncParties() {
  const db = await openMirror();
  if (!db) return { ok: false, reason: 'no mirror on this device' };

  let body;
  try {
    const res = await api.get('/mirror/pull', { params: { set: 'parties' } });
    body = res?.data;
  } catch (e) {
    // The shop is unreachable. That is not a corruption — whatever is already
    // stored stays exactly as trustworthy as it was a moment ago.
    return { ok: false, reason: 'shop unreachable' };
  }

  const rows = Array.isArray(body?.rows) ? body.rows : null;
  const sent = body?.checksum;
  if (!rows || !sent) return { ok: false, reason: 'malformed response' };

  try {
    const set = [{ statement: 'DELETE FROM parties;', values: [] }];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      set.push({
        statement:
          'INSERT INTO parties (party_id, party_name, party_type, mobile_1, ' +
          'credit_limit, credit_days, balance_paise) VALUES (?,?,?,?,?,?,?);',
        values: slice.map((r) => [
          r.party_id,
          r.party_name ?? '',
          r.party_type ?? '',
          r.mobile_1 ?? '',
          Number(r.credit_limit || 0),
          Number(r.credit_days || 0),
          toPaise(r.current_balance),
        ]),
      });
    }
    // transaction: true — the delete and every insert commit together or not
    // at all, so an interrupted sync cannot leave a partial set behind.
    await db.executeSet(set, true);
  } catch (e) {
    await setMeta(META_TRUSTED, '0');
    return { ok: false, trusted: false, reason: `write failed: ${e?.message || e}` };
  }

  /* Verify against what actually landed on disk, not against what we believe
   * we wrote. Re-reading is the entire point: it is the only check that
   * catches a truncated transfer, a silently dropped chunk, or a type
   * coercion that turned a balance into something else on the way in. */
  let stored;
  try {
    const r = await db.query(
      'SELECT COUNT(*) AS n, COALESCE(SUM(balance_paise), 0) AS paise FROM parties;',
    );
    stored = r?.values?.[0] || {};
  } catch (e) {
    await setMeta(META_TRUSTED, '0');
    return { ok: false, trusted: false, reason: `verify failed: ${e?.message || e}` };
  }

  const countOk = Number(stored.n) === Number(sent.count);
  const moneyOk = Number(stored.paise) === Number(sent.paise);

  if (!countOk || !moneyOk) {
    await setMeta(META_TRUSTED, '0');
    return {
      ok: false,
      trusted: false,
      reason: `checksum mismatch — stored ${stored.n}/${stored.paise}, sent ${sent.count}/${sent.paise}`,
    };
  }

  await setMeta(META_SYNCED_AT, body.generated_at);
  await setMeta(META_CHECKSUM, `${sent.count}:${sent.paise}`);
  await setMeta(META_TRUSTED, '1');

  return { ok: true, trusted: true, syncedAt: body.generated_at, count: rows.length };
}

/**
 * Is the stored party set safe to quote from, and how old is it?
 *
 * `syncedAt` is the SERVER's clock at the moment the figures were produced.
 * Deliberately not the device's: a phone with a wrong clock must not be able
 * to make stale figures look fresh.
 */
export async function partiesMirrorState() {
  const trusted = (await getMeta(META_TRUSTED)) === '1';
  const syncedAt = Number(await getMeta(META_SYNCED_AT)) || null;
  return { trusted, syncedAt };
}

/**
 * The cheap confirmation — "is what I'm holding still what the shop holds?"
 *
 * One small request, no rows. This is what backs saying a number out loud:
 * it either agrees, or it tells you plainly that it could not check.
 */
export async function confirmParties() {
  const held = await getMeta(META_CHECKSUM);
  if (!held) return { state: 'unknown', reason: 'nothing synced yet' };
  try {
    const res = await api.get('/mirror/checksum', { params: { set: 'parties' } });
    const c = res?.data?.checksum;
    if (!c) return { state: 'unknown', reason: 'malformed response' };
    const live = `${c.count}:${c.paise}`;
    return live === held
      ? { state: 'current', at: res.data.generated_at }
      : { state: 'changed', at: res.data.generated_at };
  } catch {
    return { state: 'unreachable' };
  }
}
