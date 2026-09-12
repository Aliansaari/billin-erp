/**
 * The mirror feed — what the phone is allowed to keep a copy of.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────
 *
 * Every figure here is computed HERE and shipped as a finished number. The
 * phone stores answers; it never derives them.
 *
 * A party's balance is `parties.current_balance`, the column the posting
 * service maintains — the same source the dashboard tiles, the customer list
 * and the outstanding report all read, which is why those three agree. See
 * the long note above reportController.partyOutstanding for what happened the
 * last time a balance was derived instead: a bill-derived formula broke on
 * imported data, overstated every supplier and flipped the net sign.
 *
 * A phone that caches answers can show an OLD number. A phone that computes
 * them can show a WRONG one, and a wrong one gets quoted to a customer's
 * face. That is the whole reason this endpoint exists rather than letting the
 * device sync raw ledger rows and add them up itself.
 *
 * ── WHY WHOLE SETS, NOT DELTAS ───────────────────────────────────────
 *
 * None of the money tables carry `updated_at`, and ledger_entries,
 * bill_payment_allocations and stock_ledger have no soft-delete either — rows
 * are hard-deleted. A delta feed therefore has no way to tell a phone that a
 * row is GONE, so a cancelled bill would live on the device forever and keep
 * being counted. Whole-set replacement is immune to that by construction: if
 * a row is not in the new set, it is not in the mirror.
 */
const sequelize = require('../config/database');
const { respondWithError } = require('../utils/helpers');
const { getLedgerStatement, resolveLedgerForParty } = require('../services/ledgerStatementService');

/* Numbers are compared as scaled INTEGERS, never as floats.
 *
 * The point of the checksum is for the phone to prove it stored exactly what
 * was sent. Summing decimals as doubles on two different platforms
 * reintroduces the very class of disagreement the checksum exists to detect.
 * Measured on real data: summing 75 balances as floats gives
 * -6387970.259999999. Converting each row to an integer first is exact on
 * both sides.
 *
 * Money scales by 100 (paise). Quantities scale by 1000, because stock is
 * kept to three decimals and a kilogram is not a rupee.
 */
const scaled = (v, scale) => Math.round(Number(v || 0) * scale);

/* Per-field sums rather than one combined digest.
 *
 * A single number would say THAT the mirror disagrees without saying which
 * column drifted, and "something is wrong with your money" is not a
 * diagnosis. Each field is reported separately so a mismatch names itself. */
const checksumOf = (rows, fields) => ({
  count: rows.length,
  sums: Object.fromEntries(
    Object.entries(fields).map(([field, scale]) => [
      field,
      rows.reduce((acc, r) => acc + scaled(r[field], scale), 0),
    ]),
  ),
});

const SETS = {
  /* Parties and what they owe. A few hundred rows even for a large
   * wholesaler, so it is replaced whole on every sync. */
  parties: {
    fields: { current_balance: 100 },
    load: () => sequelize.query(
      `SELECT p.party_id,
              p.party_name,
              p.party_type,
              p.mobile_1,
              -- Searched by the server on name + both mobiles + email, and
              -- the result rows show city and GSTIN. Carried so an offline
              -- search matches the same parties and renders the same row.
              p.mobile_2,
              p.email,
              p.city,
              p.gstin,
              COALESCE(p.credit_limit, 0)::float                       AS credit_limit,
              COALESCE(p.credit_days, 0)::int                          AS credit_days,
              ROUND(COALESCE(p.current_balance, 0)::numeric, 2)::float AS current_balance
         FROM parties p
        ORDER BY p.party_id`,
      { type: sequelize.QueryTypes.SELECT },
    ),
  },

  /* The item list. Tens of thousands of rows on a real wholesaler, and
   * deliberately NOT paged.
   *
   * One query sees one consistent Postgres snapshot. Paged requests would
   * each see a different one, so a single sale between page 1 and page 8
   * would leave the set internally inconsistent and fail its own checksum
   * every time — a sync that could never succeed on a shop that was open.
   * gzip is already applied to every response, and the compact projection
   * below is what makes one request affordable.
   *
   * Field names match what the stock screen already renders, so the offline
   * path goes through the same components as the live one. */
  products: {
    fields: { sale_rate: 100, purchase_rate: 100, current_stock: 1000 },
    load: () => sequelize.query(
      `SELECT pr.product_id,
              pr.product_name,
              pr.article_number,
              pr.barcode,
              pr.hsn_code,
              pr.size_value,
              pr.unit_of_measurement::text                              AS unit_of_measurement,
              ROUND(COALESCE(pr.current_stock, 0)::numeric, 3)::float   AS current_stock,
              ROUND(COALESCE(pr.minimum_stock_level, 0)::numeric, 3)::float AS minimum_stock_level,
              ROUND(COALESCE(pr.sale_rate, 0)::numeric, 2)::float       AS sale_rate,
              ROUND(COALESCE(pr.purchase_rate, 0)::numeric, 2)::float   AS purchase_rate,
              c.category_name
         FROM products pr
         LEFT JOIN categories c ON c.category_id = pr.category_id
        WHERE pr.is_active = true
        ORDER BY pr.product_id`,
      { type: sequelize.QueryTypes.SELECT },
    ),
  },
};

/* ── Prefetch sets ───────────────────────────────────────────────────
 *
 * Statements and movement histories are answers to questions with
 * arguments — one per party per date range, one per product — so they were
 * cached only when a screen asked for one. That works, and it means nothing
 * is there offline until you have visited it, which is not what "show me the
 * statements offline" means to anybody.
 *
 * These two sets fetch the ones worth having in advance, in a single request
 * each rather than one per party. Bounded hard: the point is the handful
 * anyone actually works with, not the whole book.
 */
const PREFETCH_LIMIT = 40;

/* The financial year the mobile screens default to, computed the same way:
 * April to March, the year chosen by which side of April today falls. */
function currentFY() {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const p = (n) => String(n).padStart(2, '0');
  return { from: `${y}-04-01`, to: `${y + 1}-03-${p(31)}` };
}

/**
 * Statements for the parties with the most money outstanding.
 *
 * Ordered by absolute balance because that is the order anyone works a
 * collection list in, and because if the cache can only hold some of them it
 * should hold the ones a conversation is most likely to be about.
 */
async function prefetchStatements(limit = PREFETCH_LIMIT) {
  const { from, to } = currentFY();
  const parties = await sequelize.query(
    `SELECT party_id FROM parties
      WHERE COALESCE(current_balance, 0) <> 0
      ORDER BY ABS(COALESCE(current_balance, 0)) DESC
      LIMIT :limit`,
    { replacements: { limit }, type: sequelize.QueryTypes.SELECT },
  );
  const out = [];
  for (const { party_id } of parties) {
    try {
      const ledgerId = await resolveLedgerForParty(party_id);
      if (!ledgerId) continue;
      const payload = await getLedgerStatement(ledgerId, { from_date: from, to_date: to });
      out.push({ party_id, from, to, payload });
    } catch {
      /* One party failing must not cost the other thirty-nine. */
    }
  }
  return { rows: out, period: { from, to } };
}

/**
 * Movement histories for the items that have actually moved lately.
 *
 * Recency, not stock value: the thing someone checks the history of is the
 * thing that has been selling, and a warehouse full of dead stock should not
 * crowd it out.
 */
async function prefetchMovements(limit = PREFETCH_LIMIT) {
  /* One query for every product, not one per product.
   *
   * party_name is NOT a column on stock_ledger — productController derives
   * it in JS by looking the reference up in purchase_bills or sales_bills
   * and falling back to remarks, or to "Cash Sale" for a sale with no
   * customer. Reproduced here in SQL so the offline rows carry exactly what
   * the live ones do; an offline history missing the party it traded with
   * would be a different screen wearing the same name.
   *
   * The reversal filter matches getStockMovement's default: hide reversal
   * rows AND the originals they reverse, so only currently-active rows
   * remain. The pair nets to zero, so nothing is lost but noise. */
  const rows = await sequelize.query(
    `WITH recent AS (
       SELECT product_id
         FROM stock_ledger
        GROUP BY product_id
        ORDER BY MAX(transaction_date) DESC
        LIMIT :limit
     )
     SELECT sl.ledger_id, sl.product_id, sl.transaction_date, sl.transaction_type,
            sl.reference_number, sl.reference_id,
            sl.quantity_in::float  AS quantity_in,
            sl.quantity_out::float AS quantity_out,
            sl.remarks,
            CASE
              WHEN sl.transaction_type IN ('Purchase', 'Purchase Return')
                THEN COALESCE(pp.party_name, sl.remarks, '')
              WHEN sl.transaction_type IN ('Sales', 'Sales Return')
                THEN COALESCE(sp.party_name, 'Cash Sale')
              ELSE COALESCE(sl.remarks, '')
            END AS party_name
       FROM stock_ledger sl
       JOIN recent r ON r.product_id = sl.product_id
       LEFT JOIN purchase_bills pb
              ON pb.purchase_bill_id = sl.reference_id
             AND sl.transaction_type IN ('Purchase', 'Purchase Return')
       LEFT JOIN parties pp ON pp.party_id = pb.supplier_id
       LEFT JOIN sales_bills sb
              ON sb.sales_bill_id = sl.reference_id
             AND sl.transaction_type IN ('Sales', 'Sales Return')
       LEFT JOIN parties sp ON sp.party_id = sb.customer_id
      WHERE sl.is_reversal_of_ledger_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM stock_ledger rv
                         WHERE rv.is_reversal_of_ledger_id = sl.ledger_id)
      ORDER BY sl.product_id, sl.transaction_date ASC, sl.ledger_id ASC`,
    { replacements: { limit }, type: sequelize.QueryTypes.SELECT },
  );

  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }
  const ids = [...byProduct.keys()];
  if (!ids.length) return { rows: [] };

  /* The product record too, or the offline screen has a movement list under
   * a blank header. Deliberately WITHOUT display_stock_value: that figure is
   * computed per stock-valuation mode by attachDisplayCost, and inventing it
   * here would be the device showing a money figure the server never said.
   * The screen renders it as unknown rather than zero. */
  const products = await sequelize.query(
    `SELECT pr.product_id, pr.product_name, pr.article_number, pr.barcode,
            pr.hsn_code, pr.size_value,
            pr.unit_of_measurement::text                            AS unit_of_measurement,
            ROUND(COALESCE(pr.current_stock, 0)::numeric, 3)::float AS current_stock,
            ROUND(COALESCE(pr.sale_rate, 0)::numeric, 2)::float     AS sale_rate,
            ROUND(COALESCE(pr.purchase_rate, 0)::numeric, 2)::float AS purchase_rate
       FROM products pr
      WHERE pr.product_id IN (:ids)`,
    { replacements: { ids }, type: sequelize.QueryTypes.SELECT },
  );
  const pmap = new Map(products.map((p) => [p.product_id, p]));

  return {
    rows: ids.map((product_id) => ({
      product_id,
      product: pmap.get(product_id) || null,
      movements: byProduct.get(product_id),
    })),
  };
}


const buildSet = async (name) => {
  const def = SETS[name];
  if (!def) return null;
  const rows = await def.load();
  return { rows, checksum: checksumOf(rows, def.fields) };
};

/**
 * GET /api/mirror/pull?set=parties
 *
 * `generated_at` is the SERVER's clock on purpose. The phone shows this as
 * "synced at …" when it cannot reach the shop, and a phone with a wrong clock
 * must not be able to make stale figures look fresh.
 */
exports.pull = async (req, res) => {
  try {
    const set = String(req.query.set || '');

    /* The prefetch sets are shaped differently from the table sets — a list
     * of answers rather than rows with a checksum — so they answer here
     * rather than being forced through buildSet's contract. */
    if (set === 'statements' || set === 'movements') {
      const limit = Math.max(1, Math.min(PREFETCH_LIMIT, Number(req.query.limit) || PREFETCH_LIMIT));
      const body = set === 'statements'
        ? await prefetchStatements(limit)
        : await prefetchMovements(limit);
      return res.json({ set, generated_at: Date.now(), ...body });
    }

    if (!SETS[set]) {
      return res.status(400).json({ message: `Unknown mirror set: ${set || '(none)'}` });
    }
    const { rows, checksum } = await buildSet(set);
    return res.json({ set, generated_at: Date.now(), rows, checksum });
  } catch (error) {
    console.error('Mirror pull error:', error);
    return respondWithError(res, error);
  }
};

/**
 * GET /api/mirror/checksum?set=parties
 *
 * The cheap half of the contract. Standing in front of a customer, the phone
 * needs to know whether the figure it holds is still the figure the shop
 * holds — and it needs to know in milliseconds, without pulling every row.
 * Same computation as `pull`, so agreement here means the mirror is current.
 */
exports.checksum = async (req, res) => {
  try {
    const set = String(req.query.set || '');
    if (!SETS[set]) {
      return res.status(400).json({ message: `Unknown mirror set: ${set || '(none)'}` });
    }
    const { checksum } = await buildSet(set);
    return res.json({ set, generated_at: Date.now(), checksum });
  } catch (error) {
    console.error('Mirror checksum error:', error);
    return respondWithError(res, error);
  }
};
