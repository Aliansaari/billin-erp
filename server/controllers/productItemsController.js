// ── Product Items Detail Controller (R11) ────────────────────────────
//
//   GET /api/reports/product-sales-items
//   GET /api/reports/product-purchase-items
//
// Per-LINE-ITEM detail. One row per (bill, product) — the operator sees
// every item sold/purchased in the period with full party + product +
// price + tax breakdown. Sales side carries cost_rate so the report
// renders a per-line Profit; purchase side replaces Profit with
// Line Value.
//
// Pagination: page/limit (matches the useVirtualizedReport hook so the
// frontend can chunk-load 10k+ rows without dropping frames).
//
// Filters (URL query params):
//   from_date       YYYY-MM-DD     bill-date floor (default: current FY)
//   to_date         YYYY-MM-DD     bill-date ceiling (default: today)
//   party_ids       int[]          customer/supplier multi-select
//   category_ids    int[]          category multi-select
//   product_search  string         ILIKE on product_name
//   barcode         string         exact match
//   hsn_code        string         exact match (or ILIKE prefix)
//   search          string         free-text bill_no / party_name / product_name
//   sort            enum           one of SORTABLE_COLS keys
//   dir             asc | desc
//   page, limit     pagination
//
// Response:
//   {
//     data: ItemRow[],
//     total: int,                       full filtered count
//     page, limit,
//     summary: {
//       row_count, bill_count, party_count, product_count,
//       total_qty, total_taxable, total_tax, total_value,
//       total_cost   (sales only),
//       total_profit (sales only),
//     },
//   }
//
// Filter dropdown options (categories, parties, products) are loaded
// directly by the frontend from their master-list endpoints — keeps
// this controller focused on the per-item query and avoids the
// snapshot-NULL trap (legacy bill items whose category_id wasn't
// captured at write time would otherwise be invisible to the filter).

const sequelize = require('../config/database');
const { SystemSettings } = require('../models');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function defaultPeriod() {
  const s = await SystemSettings.findOne({ where: { setting_id: 1 } });
  if (s && s.financial_year_start) {
    return { from_date: String(s.financial_year_start).slice(0, 10), to_date: localDateString() };
  }
  const today = new Date();
  const start = new Date(today.getFullYear(), 0, 1);
  return { from_date: localDateString(start), to_date: localDateString(today) };
}

function toIntArr(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((s) => parseInt(s, 10)).filter(Number.isFinite);
}

// Sort whitelist — value interpolated into ORDER BY. The query-param
// is untrusted; whitelisting prevents SQL injection.
const SORTABLE_COLS = {
  bill_date:    'b.bill_date',
  bill_number:  'b.bill_number',
  party_name:   'p.party_name',
  product_name: 'i.product_name',
  category_name:'i.category_name',
  quantity:     'i.quantity',
  rate:         'i.rate',
  taxable:      'i.taxable_amount',
  total:        'i.total_amount',
};

// ── Main per-side query ──────────────────────────────────────────────
async function _itemsList(req, side) {
  const isSales = side === 'sales';
  const itemTbl  = isSales ? 'sales_bill_items'    : 'purchase_bill_items';
  const billTbl  = isSales ? 'sales_bills'         : 'purchase_bills';
  const billPK   = isSales ? 'sales_bill_id'       : 'purchase_bill_id';
  const partyFK  = isSales ? 'customer_id'         : 'supplier_id';
  const partyLbl = isSales ? 'Customer'            : 'Supplier';
  const rateCol  = isSales ? 'i.rate'              : 'i.purchase_rate';

  const q = req.query || {};
  const defaults = await defaultPeriod();
  const from_date = (q.from_date && /^\d{4}-\d{2}-\d{2}$/.test(q.from_date)) ? q.from_date : defaults.from_date;
  const to_date   = (q.to_date   && /^\d{4}-\d{2}-\d{2}$/.test(q.to_date))   ? q.to_date   : defaults.to_date;

  const partyIds    = toIntArr(q.party_ids);
  const categoryIds = toIntArr(q.category_ids);
  const productSearch = q.product_search ? String(q.product_search).trim() : '';
  const barcode       = q.barcode ? String(q.barcode).trim() : '';
  const hsnCode       = q.hsn_code ? String(q.hsn_code).trim() : '';
  const search        = q.search ? String(q.search).trim() : '';

  const sortKey = SORTABLE_COLS[q.sort] ? q.sort : 'bill_date';
  const sortCol = SORTABLE_COLS[sortKey];
  const dir     = q.dir === 'asc' ? 'ASC' : 'DESC';

  const page  = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 200));
  const offset = (page - 1) * limit;

  const where = [
    'b.is_cancelled = false',
    `b.${partyFK} IS NOT NULL`,
    'b.bill_date >= :from',
    'b.bill_date <= :to',
  ];
  const params = { from: from_date, to: to_date, limit, offset };

  if (partyIds.length) {
    where.push(`b.${partyFK} IN (:partyIds)`);
    params.partyIds = partyIds;
  }
  if (categoryIds.length) {
    // sales_bill_items has category_id; purchase_bill_items doesn't —
    // resolve via the products table on the purchase side. Sales path
    // stays direct so the index on (category_id) keeps working.
    // Either way, we ALSO match items whose category_id is null but
    // whose product currently belongs to one of the requested
    // categories — covers seed rows where category_id wasn't snapshot
    // on the line at bill-creation time.
    where.push('('
      + (isSales ? 'i.category_id IN (:categoryIds) OR ' : '')
      + 'EXISTS (SELECT 1 FROM products pp WHERE pp.product_id = i.product_id AND pp.category_id IN (:categoryIds))'
      + ')');
    params.categoryIds = categoryIds;
  }
  if (toIntArr(q.product_ids).length) {
    where.push('i.product_id IN (:productIds)');
    params.productIds = toIntArr(q.product_ids);
  }
  if (productSearch) {
    where.push('i.product_name ILIKE :productSearch');
    params.productSearch = `%${productSearch}%`;
  }
  if (barcode) {
    where.push('i.barcode = :barcode');
    params.barcode = barcode;
  }
  if (hsnCode) {
    where.push('i.hsn_code ILIKE :hsnCode');
    params.hsnCode = `${hsnCode}%`;
  }
  if (search) {
    where.push(`(b.bill_number ILIKE :search OR p.party_name ILIKE :search OR i.product_name ILIKE :search)`);
    params.search = `%${search}%`;
  }
  const whereSql = where.join(' AND ');

  // Per-line profit on sales side: (rate − cost_rate) × qty − discount_amount.
  // Falls back to 0 when cost_rate is null (item with no cost recorded).
  // Purchase side: line_value = rate × qty (raw before discount/tax).
  const profitOrLineValue = isSales
    ? `((COALESCE(i.rate, 0) - COALESCE(i.cost_rate, 0)) * COALESCE(i.quantity, 0) - COALESCE(i.discount_amount, 0))::float`
    : `(COALESCE(i.purchase_rate, 0) * COALESCE(i.quantity, 0))::float`;
  const profitColAlias = isSales ? 'profit' : 'line_value';
  const costRateSelect = isSales ? `COALESCE(i.cost_rate, 0)::float AS cost_rate,` : '';

  const dataSql = `
    SELECT
      i.item_id,
      i.${billPK}                AS bill_id,
      b.bill_number,
      b.bill_date,
      i.product_id,
      i.product_name,
      ${isSales
        ? `COALESCE(i.category_id, pp.category_id) AS category_id`
        : `pp.category_id AS category_id`},
      COALESCE(NULLIF(i.category_name, ''), c.category_name, '—') AS category_name,
      i.hsn_code,
      i.barcode,
      i.size,
      i.article_number,
      ${isSales ? 'i.unit_type,' : 'NULL::text AS unit_type,'}
      i.quantity::float           AS quantity,
      ${rateCol}::float           AS rate,
      i.mrp::float                AS mrp,
      i.discount_percentage::float AS discount_percentage,
      i.discount_amount::float    AS discount_amount,
      i.gst_rate::float           AS gst_rate,
      i.cgst_amount::float        AS cgst_amount,
      i.sgst_amount::float        AS sgst_amount,
      i.igst_amount::float        AS igst_amount,
      i.taxable_amount::float     AS taxable_amount,
      i.total_amount::float       AS total_amount,
      ${costRateSelect}
      ${profitOrLineValue}        AS ${profitColAlias},
      p.party_id,
      p.party_name,
      p.mobile_1                  AS party_mobile,
      p.gstin                     AS party_gstin,
      p.city                      AS party_city,
      p.state                     AS party_state
      FROM ${itemTbl} i
      JOIN ${billTbl} b ON b.${billPK} = i.${billPK}
      JOIN parties p   ON p.party_id  = b.${partyFK}
      LEFT JOIN products pp  ON pp.product_id   = i.product_id
      LEFT JOIN categories c ON c.category_id   = pp.category_id
     WHERE ${whereSql}
     ORDER BY ${sortCol} ${dir}, i.item_id ${dir}
     LIMIT :limit OFFSET :offset
  `;
  const dataRows = await sequelize.query(dataSql, { replacements: params, type: sequelize.QueryTypes.SELECT });

  // Total count (same filter set, no pagination).
  const [{ total }] = await sequelize.query(
    `SELECT COUNT(*)::int AS total
       FROM ${itemTbl} i
       JOIN ${billTbl} b ON b.${billPK} = i.${billPK}
       JOIN parties p   ON p.party_id  = b.${partyFK}
      WHERE ${whereSql}`,
    { replacements: params, type: sequelize.QueryTypes.SELECT },
  );

  // Aggregates over the FULL filtered set.
  const aggSql = `
    SELECT
      COUNT(*)::int                                     AS row_count,
      COUNT(DISTINCT b.${billPK})::int                  AS bill_count,
      COUNT(DISTINCT p.party_id)::int                   AS party_count,
      COUNT(DISTINCT i.product_id)::int                 AS product_count,
      COALESCE(SUM(i.quantity), 0)::float               AS total_qty,
      COALESCE(SUM(i.taxable_amount), 0)::float         AS total_taxable,
      COALESCE(SUM(i.cgst_amount + i.sgst_amount + i.igst_amount), 0)::float AS total_tax,
      COALESCE(SUM(i.total_amount), 0)::float           AS total_value
      ${isSales
        ? `, COALESCE(SUM(i.cost_rate * i.quantity), 0)::float                                        AS total_cost
           , COALESCE(SUM((${rateCol} - COALESCE(i.cost_rate, 0)) * i.quantity - i.discount_amount), 0)::float AS total_profit`
        : ''}
      FROM ${itemTbl} i
      JOIN ${billTbl} b ON b.${billPK} = i.${billPK}
      JOIN parties p   ON p.party_id  = b.${partyFK}
     WHERE ${whereSql}
  `;
  const [agg] = await sequelize.query(aggSql, { replacements: params, type: sequelize.QueryTypes.SELECT });

  return {
    data: dataRows.map((r) => _normalise(r, isSales)),
    total,
    page, limit,
    summary: {
      row_count:     agg.row_count,
      bill_count:    agg.bill_count,
      party_count:   agg.party_count,
      product_count: agg.product_count,
      total_qty:     r2(agg.total_qty),
      total_taxable: r2(agg.total_taxable),
      total_tax:     r2(agg.total_tax),
      total_value:   r2(agg.total_value),
      ...(isSales
        ? { total_cost: r2(agg.total_cost), total_profit: r2(agg.total_profit) }
        : {}),
    },
    side,
    party_label: partyLbl,
    from_date, to_date,
  };
}

function _normalise(r, isSales) {
  const out = {
    item_id:        r.item_id,
    bill_id:        r.bill_id,
    bill_number:    r.bill_number,
    bill_date:      r.bill_date,
    product_id:     r.product_id,
    product_name:   r.product_name,
    category_id:    r.category_id,
    category_name:  r.category_name || '—',
    hsn_code:       r.hsn_code || '—',
    barcode:        r.barcode || '—',
    size:           r.size || null,
    article_number: r.article_number || null,
    unit_type:      r.unit_type || null,
    quantity:       Number(r.quantity)            || 0,
    rate:           r2(r.rate),
    mrp:            r2(r.mrp),
    discount_percentage: r2(r.discount_percentage),
    discount_amount: r2(r.discount_amount),
    gst_rate:       r2(r.gst_rate),
    cgst_amount:    r2(r.cgst_amount),
    sgst_amount:    r2(r.sgst_amount),
    igst_amount:    r2(r.igst_amount),
    tax_amount:     r2((Number(r.cgst_amount) || 0) + (Number(r.sgst_amount) || 0) + (Number(r.igst_amount) || 0)),
    taxable_amount: r2(r.taxable_amount),
    total_amount:   r2(r.total_amount),
    party_id:       r.party_id,
    party_name:     r.party_name,
    party_mobile:   r.party_mobile,
    party_gstin:    r.party_gstin,
    party_city:     r.party_city,
    party_state:    r.party_state,
  };
  if (isSales) {
    out.cost_rate = r2(r.cost_rate);
    out.profit    = r2(r.profit);
    // Profit % on the line's rate × qty (sale value), to keep it
    // comparable across products of different magnitudes.
    const lineRevenue = (Number(r.rate) || 0) * (Number(r.quantity) || 0);
    out.profit_pct = lineRevenue > 0 ? r2((Number(r.profit) / lineRevenue) * 100) : null;
  } else {
    out.line_value = r2(r.line_value);
  }
  return out;
}

// ── HTTP handlers ────────────────────────────────────────────────────
exports.productSalesItems = async (req, res) => {
  try {
    res.json(await _itemsList(req, 'sales'));
  } catch (err) {
    console.error('productSalesItems error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.productPurchaseItems = async (req, res) => {
  try {
    res.json(await _itemsList(req, 'purchase'));
  } catch (err) {
    console.error('productPurchaseItems error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
