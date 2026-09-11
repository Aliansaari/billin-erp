/**
 * Serving screens from the mirror.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────
 *
 * Every function here returns `null` the moment it meets a query it cannot
 * answer *exactly* as the server would. Null means "fall through to the
 * shop", and the caller then behaves as it always did.
 *
 * That is deliberate and it is the whole safety model. A local reader that
 * guesses — approximates a filter, ignores a parameter it does not
 * understand, silently returns fewer rows — produces a screen that looks
 * right and is wrong, which is worse than a screen that waits. So the
 * supported cases are enumerated, and anything outside them is handed back
 * to the server rather than approximated.
 *
 * `stock_status: 'top'` is the worked example: it means "has a Sales row in
 * stock_ledger", the mirror holds no stock_ledger, and there is no honest
 * local approximation of it. It falls through.
 *
 * ── SCALED INTEGERS COME BACK OUT AS NUMBERS ─────────────────────────
 *
 * Storage keeps money in paise and stock in thousandths so nothing drifts.
 * Dividing happens here, at the display edge, on values that are about to be
 * rendered and never summed. That is the one place a float is harmless.
 */
import { openMirror } from './mirrorDb';
import { mirrorState } from './mirrorSync';

/* Which search prefixes map to which stored column. Mirrors the server's
 * FIELDS map in productController.getAll — if one gains a scope the other
 * must too, or the same search would mean different things depending on
 * whether the shop happened to be reachable. */
const SEARCH_COLS = {
  article: ['article_number'],
  barcode: ['barcode'],
  name:    ['product_name'],
  hsn:     ['hsn_code'],
};
const UNSCOPED_COLS = ['product_name', 'article_number', 'barcode', 'hsn_code'];

/* Exactly the server's definitions (productController.getAll):
 *   out — current_stock <= 0
 *   low — current_stock <= minimum_stock_level AND minimum_stock_level > 0
 *         (the guard matters: without it every imported product with no
 *         reorder level set counts as low purely because both are zero)
 *   in  — current_stock > 0 */
const STATUS_SQL = {
  out: 'stock_milli <= 0',
  low: 'stock_milli <= min_stock_milli AND min_stock_milli > 0',
  /* In stock = in hand AND not below a configured reorder level.
   *
   * Not simply "stock > 0": the chips are a partition and the count is
   * computed as total − low − out, so counting a low item as in would put
   * more rows in the list than the chip above it claims. Verified against the
   * live endpoint — 105 in + 1 low + 14 out = 120, the whole catalogue. */
  in:  'stock_milli > 0 AND (min_stock_milli <= 0 OR stock_milli > min_stock_milli)',
};

const rowOut = (r) => ({
  product_id: r.product_id,
  product_name: r.product_name,
  article_number: r.article_number || null,
  barcode: r.barcode || null,
  hsn_code: r.hsn_code || null,
  size_value: r.size_value || null,
  unit_of_measurement: r.unit_of_measurement || null,
  category_name: r.category_name || null,
  current_stock: Number(r.stock_milli) / 1000,
  minimum_stock_level: Number(r.min_stock_milli) / 1000,
  sale_rate: Number(r.sale_rate_paise) / 100,
  purchase_rate: Number(r.purchase_rate_paise) / 100,
});

/**
 * The stock list, shaped exactly like productAPI.getAll's response.
 *
 * Returns null when the mirror is missing, untrusted, or the query uses
 * anything not enumerated above.
 */
export async function readProducts(params = {}) {
  const { trusted, syncedAt } = await mirrorState('products');
  if (!trusted) return null;

  /* Any parameter not understood means fall through. Listing the KNOWN keys
   * rather than the unknown ones is the point: a parameter added to the
   * server later starts falling through automatically instead of being
   * silently ignored by a reader that never heard of it. */
  const KNOWN = new Set(['limit', 'page', 'stock_status', 'search', 'search_field']);
  for (const k of Object.keys(params)) {
    if (params[k] !== undefined && !KNOWN.has(k)) return null;
  }

  const status = params.stock_status;
  if (status && !STATUS_SQL[status]) return null;     // 'top' and anything new

  const db = await openMirror();
  if (!db) return null;

  const where = [];
  const args = [];

  if (status) where.push(`(${STATUS_SQL[status]})`);

  const term = String(params.search || '').trim();
  if (term) {
    const scope = params.search_field
      ? SEARCH_COLS[String(params.search_field).toLowerCase()]
      : UNSCOPED_COLS;
    // An unknown scope must not quietly become an unscoped search — that
    // returns MORE rows than asked for, which reads as the filter being
    // broken. Fall through instead.
    if (!scope) return null;
    where.push(`(${scope.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    // LIKE wildcards in user input are escaped, same as the server's
    // escapeLike, so searching for "%" does not match everything.
    const esc = term.replace(/[\\%_]/g, (m) => `\\${m}`);
    for (let i = 0; i < scope.length; i += 1) args.push(`%${esc}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Number(params.limit) || 100);
  const page = Math.max(1, Number(params.page) || 1);

  try {
    const rowsRes = await db.query(
      `SELECT * FROM products ${whereSql} ORDER BY product_name LIMIT ? OFFSET ?;`,
      [...args, limit, (page - 1) * limit],
    );
    const totalRes = await db.query(
      `SELECT COUNT(*) AS n FROM products ${whereSql};`,
      args,
    );

    /* Whole-catalogue counts for the filter chips.
     *
     * Counting rows the device already holds in full is exact — it is not a
     * derived money figure, and the alternative (the server's `summary`) is
     * unreachable in the very situation this exists for. */
    const sumRes = await db.query(
      `SELECT COUNT(*) AS total_count,
              SUM(CASE WHEN ${STATUS_SQL.low} THEN 1 ELSE 0 END) AS low_count,
              SUM(CASE WHEN ${STATUS_SQL.out} THEN 1 ELSE 0 END) AS out_count
         FROM products;`,
    );
    const s = sumRes?.values?.[0] || {};
    const total_count = Number(s.total_count || 0);
    const low_count   = Number(s.low_count || 0);
    const out_count   = Number(s.out_count || 0);

    return {
      data: {
        data: (rowsRes?.values || []).map(rowOut),
        total: Number(totalRes?.values?.[0]?.n || 0),
        summary: {
          total_count,
          low_count,
          out_count,
          /* The server's exact formula, not "stock > 0".
           *
           * Measured against the live endpoint: counting stock > 0 gives 106
           * where the server reports 105, because the chips are a partition —
           * a low item is low, not in. One item's worth of disagreement is
           * still a chip that contradicts the shop. */
          in_count: Math.max(0, total_count - low_count - out_count),
        },
      },
      syncedAt,
      fromMirror: true,
    };
  } catch (e) {
    console.warn('[mirror] readProducts failed:', e?.message || e);
    return null;
  }
}

/** Party balances, newest sync. Returns null unless the set is trusted. */
export async function readParties() {
  const { trusted, syncedAt } = await mirrorState('parties');
  if (!trusted) return null;
  const db = await openMirror();
  if (!db) return null;
  try {
    const r = await db.query('SELECT * FROM parties ORDER BY party_name;');
    return {
      rows: (r?.values || []).map((p) => ({
        party_id: p.party_id,
        party_name: p.party_name,
        party_type: p.party_type,
        mobile_1: p.mobile_1 || null,
        credit_limit: Number(p.credit_limit || 0),
        credit_days: Number(p.credit_days || 0),
        current_balance: Number(p.balance_paise) / 100,
      })),
      syncedAt,
      fromMirror: true,
    };
  } catch (e) {
    console.warn('[mirror] readParties failed:', e?.message || e);
    return null;
  }
}

/**
 * Who owes what — the screen a balance actually gets quoted from.
 *
 * Replicates reportController.partyOutstanding exactly, including the part
 * that matters most: the balance is `parties.current_balance` as the server
 * maintains it, carried across unchanged. Nothing here re-adds ledger rows to
 * arrive at its own answer. That controller carries a long note about the
 * last time something did — a bill-derived formula that broke on imported
 * data, overstated every supplier and flipped the net sign — and a phone
 * standing in front of a customer is the worst possible place to repeat it.
 *
 * Customers are the parties with a positive balance, suppliers the negative
 * ones, and 'Both' appears under either. Ordered by size, which is the order
 * the server uses and the order anyone reads a collection list in.
 */
export async function readOutstanding(mode) {
  if (mode !== 'Customer' && mode !== 'Supplier') return null;
  const { trusted, syncedAt } = await mirrorState('parties');
  if (!trusted) return null;
  const db = await openMirror();
  if (!db) return null;

  const types = mode === 'Customer' ? ['Customer', 'Both'] : ['Supplier', 'Both'];
  const sign  = mode === 'Customer' ? '> 0' : '< 0';

  try {
    const r = await db.query(
      `SELECT * FROM parties
        WHERE party_type IN (?, ?) AND balance_paise ${sign}
        ORDER BY ABS(balance_paise) DESC;`,
      types,
    );
    return {
      rows: (r?.values || []).map((p) => ({
        party_id: p.party_id,
        party_name: p.party_name,
        party_type: p.party_type,
        mobile_1: p.mobile_1 || null,
        credit_limit: Number(p.credit_limit || 0),
        credit_days: Number(p.credit_days || 0),
        current_balance: Number(p.balance_paise) / 100,
      })),
      syncedAt,
      fromMirror: true,
    };
  } catch (e) {
    console.warn('[mirror] readOutstanding failed:', e?.message || e);
    return null;
  }
}
