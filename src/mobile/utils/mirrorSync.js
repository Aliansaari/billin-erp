/**
 * Filling the mirror.
 *
 * ── HOW A SYNC CANNOT LEAVE A WRONG NUMBER BEHIND ────────────────────
 *
 * Three properties, each closing a different way this could quote a false
 * figure to a customer:
 *
 *   Whole-set replacement.  The device deletes and rewrites the entire set in
 *   one transaction. No money table carries `updated_at`, and ledger rows are
 *   hard-deleted, so a delta feed could never say "this row is gone" — a
 *   cancelled bill would survive on the phone and keep being counted. If a
 *   row is not in the new set, it is not in the mirror.
 *
 *   Atomic.  The delete and every insert commit together, so a sync
 *   interrupted halfway leaves the previous set intact rather than a mixture
 *   of two days. There is no moment at which the mirror is half-populated.
 *
 *   Verified.  After committing, the device recomputes every numeric sum FROM
 *   ITS OWN STORAGE and compares each one to what the server sent. Any
 *   mismatch marks the set untrusted and stops it being served — it does not
 *   "mostly work".
 *
 * The third is the one that earns its keep. The first two make corruption
 * unlikely; only the third makes it detectable, which is the sole property
 * worth anything when the alternative is finding out in front of a customer.
 *
 * ── SCALED INTEGERS ──────────────────────────────────────────────────
 *
 * Every number crossing this boundary is an integer: money in paise, stock in
 * thousandths. Doubles on two platforms disagree in the last place — measured
 * on the real data, summing 75 balances as floats yields
 * -6387970.259999999 — and a checksum built from them would be checking
 * floating point rather than the data.
 */
import api from '../../api';
import { openMirror, setMeta, getMeta } from './mirrorDb';

const scaled = (v, scale) => Math.round(Number(v || 0) * scale);
const num = (v) => Number(v || 0);
const str = (v) => (v == null ? '' : String(v));

/* Chunked because one statement with thousands of bound parameters is
 * refused by SQLite (SQLITE_MAX_VARIABLE_NUMBER), and the failure arrives as
 * an opaque prepare error that names nothing. */
const CHUNK = 100;

/**
 * One entry per set, declaring how the server's rows become local rows and —
 * critically — how each server checksum field is recomputed from storage.
 *
 * `verify` keys MUST match the server's checksum field names. That is what
 * makes a mismatch name the column that drifted instead of just announcing
 * that something, somewhere, is wrong.
 */
const SETS = {
  parties: {
    table: 'parties',
    insert:
      'INSERT INTO parties (party_id, party_name, party_type, mobile_1, ' +
      'credit_limit, credit_days, balance_paise) VALUES (?,?,?,?,?,?,?);',
    map: (r) => [
      r.party_id, str(r.party_name), str(r.party_type), str(r.mobile_1),
      num(r.credit_limit), num(r.credit_days), scaled(r.current_balance, 100),
    ],
    verify: { current_balance: 'COALESCE(SUM(balance_paise),0)' },
  },

  products: {
    table: 'products',
    insert:
      'INSERT INTO products (product_id, product_name, article_number, barcode, ' +
      'hsn_code, size_value, unit_of_measurement, category_name, stock_milli, ' +
      'min_stock_milli, sale_rate_paise, purchase_rate_paise) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?);',
    map: (r) => [
      r.product_id, str(r.product_name), str(r.article_number), str(r.barcode),
      str(r.hsn_code), str(r.size_value), str(r.unit_of_measurement),
      str(r.category_name),
      scaled(r.current_stock, 1000), scaled(r.minimum_stock_level, 1000),
      scaled(r.sale_rate, 100), scaled(r.purchase_rate, 100),
    ],
    verify: {
      sale_rate:     'COALESCE(SUM(sale_rate_paise),0)',
      purchase_rate: 'COALESCE(SUM(purchase_rate_paise),0)',
      current_stock: 'COALESCE(SUM(stock_milli),0)',
    },
  },
};

const metaKeys = (set) => ({
  syncedAt: `${set}_synced_at`,
  trusted:  `${set}_trusted`,
  checksum: `${set}_checksum`,
});

/** Stable string form of a checksum, so "still the same" is one comparison. */
const fingerprint = (c) =>
  `${c.count}:${Object.keys(c.sums || {}).sort().map((k) => `${k}=${c.sums[k]}`).join(',')}`;

/**
 * Pull one set and replace the device's copy with it.
 *
 * Returns { ok, reason, count, syncedAt } and never throws: a failed sync
 * must leave the app running on what it already had rather than taking a
 * screen down.
 */
export async function syncSet(setName) {
  const def = SETS[setName];
  if (!def) return { ok: false, reason: `unknown set ${setName}` };

  const db = await openMirror();
  if (!db) return { ok: false, reason: 'no mirror on this device' };

  const keys = metaKeys(setName);

  let body;
  try {
    const res = await api.get('/mirror/pull', { params: { set: setName } });
    body = res?.data;
  } catch {
    /* The shop is unreachable. Not a corruption — whatever is stored stays
     * exactly as trustworthy as it was a moment ago, so the trusted flag is
     * deliberately left alone. */
    return { ok: false, reason: 'shop unreachable' };
  }

  const rows = Array.isArray(body?.rows) ? body.rows : null;
  const sent = body?.checksum;
  if (!rows || !sent?.sums) return { ok: false, reason: 'malformed response' };

  try {
    const statements = [{ statement: `DELETE FROM ${def.table};`, values: [] }];
    for (let i = 0; i < rows.length; i += CHUNK) {
      statements.push({
        statement: def.insert,
        values: rows.slice(i, i + CHUNK).map(def.map),
      });
    }
    // transaction: true — delete and inserts commit together or not at all.
    await db.executeSet(statements, true);
  } catch (e) {
    await setMeta(keys.trusted, '0');
    return { ok: false, reason: `write failed: ${e?.message || e}` };
  }

  /* Verify against what actually landed on disk, not against what we believe
   * we wrote. Re-reading is the entire point: it is the only check that
   * catches a truncated transfer, a dropped chunk, or a coercion that turned
   * a figure into something else on the way in. */
  const fields = Object.keys(def.verify);
  let stored;
  try {
    const exprs = fields.map((f) => `${def.verify[f]} AS ${f}`).join(', ');
    const r = await db.query(`SELECT COUNT(*) AS n${exprs ? ', ' + exprs : ''} FROM ${def.table};`);
    stored = r?.values?.[0] || {};
  } catch (e) {
    await setMeta(keys.trusted, '0');
    return { ok: false, reason: `verify failed: ${e?.message || e}` };
  }

  const problems = [];
  if (Number(stored.n) !== Number(sent.count)) {
    problems.push(`count ${stored.n}≠${sent.count}`);
  }
  for (const f of fields) {
    if (Number(stored[f]) !== Number(sent.sums[f])) {
      problems.push(`${f} ${stored[f]}≠${sent.sums[f]}`);
    }
  }
  if (problems.length) {
    await setMeta(keys.trusted, '0');
    return { ok: false, reason: `checksum: ${problems.join('; ')}` };
  }

  await setMeta(keys.syncedAt, body.generated_at);
  await setMeta(keys.checksum, fingerprint(sent));
  await setMeta(keys.trusted, '1');
  return { ok: true, count: rows.length, syncedAt: body.generated_at };
}

export const syncParties  = () => syncSet('parties');
export const syncProducts = () => syncSet('products');

/** Sync everything, reporting per set rather than collapsing to one verdict. */
export async function syncAll() {
  const out = {};
  for (const name of Object.keys(SETS)) out[name] = await syncSet(name);
  return out;
}

/**
 * Is a stored set safe to quote from, and how old is it?
 *
 * `syncedAt` is the SERVER's clock at the moment the figures were produced —
 * deliberately not the device's, because a phone with a wrong clock must not
 * be able to make stale figures look fresh.
 */
export async function mirrorState(setName) {
  const keys = metaKeys(setName);
  return {
    trusted: (await getMeta(keys.trusted)) === '1',
    syncedAt: Number(await getMeta(keys.syncedAt)) || null,
  };
}

/**
 * The cheap confirmation — "is what I hold still what the shop holds?"
 *
 * One small request, no rows. This is what backs saying a number out loud: it
 * either agrees, or it says plainly that it could not check.
 */
export async function confirmSet(setName) {
  const held = await getMeta(metaKeys(setName).checksum);
  if (!held) return { state: 'unknown', reason: 'nothing synced yet' };
  try {
    const res = await api.get('/mirror/checksum', { params: { set: setName } });
    const c = res?.data?.checksum;
    if (!c?.sums) return { state: 'unknown', reason: 'malformed response' };
    return fingerprint(c) === held
      ? { state: 'current', at: res.data.generated_at }
      : { state: 'changed', at: res.data.generated_at };
  } catch {
    return { state: 'unreachable' };
  }
}
