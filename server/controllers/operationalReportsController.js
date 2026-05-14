// ── Operational Reports Controller (Phase R3) ──────────────────────────
//
// Item-level reports: HSN Summary, Stock Summary, Fast/Slow Movers.
// (Sales/Purchase Registers were folded into the canonical
//  /api/reports/sales and /api/reports/purchases endpoints — single
//  source of truth for bill-by-bill listings.)
//
// Period:
//   • from_date / to_date in req.query — defaults to current FY (start
//     → today) when missing.
//
// Source of truth:
//   • HSN Summary reads from sales_bill_items / purchase_bill_items
//     joined to the bill header. Cancelled bills are excluded.
//   • Stock Summary + Fast/Slow Movers read from stock_ledger so that
//     opening, in, out, and closing tie to ledger movements (not the
//     denormalised products.current_stock which can drift).

const sequelize = require('../config/database');
const { Op, fn, col, literal } = require('sequelize');
const { fetchBatchAggregate, fetchBatchAggregateByGodown, computeDisplayCost, attachDisplayCost } = require('../utils/displayCost');
const {
  SystemSettings, SalesBillItem, PurchaseBillItem,
  Product, StockLedger, Category,
} = require('../models');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }

async function resolvePeriod(query) {
  let from = (query && query.from_date) ? String(query.from_date).slice(0, 10) : null;
  let to   = (query && query.to_date)   ? String(query.to_date).slice(0, 10)   : null;
  if (!from || !to) {
    const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
    if (!from) from = settings && settings.financial_year_start
      ? String(settings.financial_year_start).slice(0, 10) : '1900-01-01';
    if (!to) to = new Date().toISOString().slice(0, 10);
  }
  return { from, to };
}

// ── HSN Summary ────────────────────────────────────────────────────────
//
// Aggregates sales/purchase line items by HSN code. Required by GSTR-1
// (Table 12) and GSTR-9. Lines without an HSN code roll up under
// "(no HSN)" so user can spot products that need cleanup.
//
// `direction` query param: 'sales' (default) or 'purchase'.
exports.hsnSummary = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const direction = (req.query.direction === 'purchase') ? 'purchase' : 'sales';

    const sql = direction === 'sales'
      ? `SELECT COALESCE(NULLIF(it.hsn_code, ''), '(no HSN)') AS hsn_code,
                MIN(it.unit_type)                              AS unit_type,
                COALESCE(SUM(it.quantity), 0)::float           AS quantity,
                COALESCE(SUM(it.taxable_amount), 0)::float     AS taxable,
                COALESCE(SUM(it.cgst_amount), 0)::float        AS cgst,
                COALESCE(SUM(it.sgst_amount), 0)::float        AS sgst,
                COALESCE(SUM(it.igst_amount), 0)::float        AS igst,
                COALESCE(SUM(it.cess_amount), 0)::float        AS cess,
                COALESCE(SUM(it.total_amount), 0)::float       AS total,
                MAX(it.gst_rate)::float                        AS gst_rate
           FROM sales_bill_items it
           JOIN sales_bills b ON b.sales_bill_id = it.sales_bill_id
          WHERE b.is_cancelled = false
            AND b.bill_date BETWEEN :from AND :to
          GROUP BY 1
          ORDER BY taxable DESC`
      : `SELECT COALESCE(NULLIF(it.hsn_code, ''), '(no HSN)') AS hsn_code,
                MIN(p.unit_of_measurement)                     AS unit_type,
                COALESCE(SUM(it.quantity), 0)::float           AS quantity,
                COALESCE(SUM(it.taxable_amount), 0)::float     AS taxable,
                COALESCE(SUM(it.cgst_amount), 0)::float        AS cgst,
                COALESCE(SUM(it.sgst_amount), 0)::float        AS sgst,
                COALESCE(SUM(it.igst_amount), 0)::float        AS igst,
                COALESCE(SUM(it.cess_amount), 0)::float        AS cess,
                COALESCE(SUM(it.total_amount), 0)::float       AS total,
                MAX(it.gst_rate)::float                        AS gst_rate
           FROM purchase_bill_items it
           JOIN purchase_bills b ON b.purchase_bill_id = it.purchase_bill_id
           LEFT JOIN products p ON p.product_id = it.product_id
          WHERE b.is_cancelled = false
            AND b.bill_date BETWEEN :from AND :to
          GROUP BY 1
          ORDER BY taxable DESC`;

    const rows = await sequelize.query(sql, {
      replacements: { from, to },
      type: sequelize.QueryTypes.SELECT,
    });

    const data = rows.map((r) => ({
      hsn_code:  r.hsn_code,
      unit_type: r.unit_type || 'Pcs',
      quantity:  r2(r.quantity),
      gst_rate:  num(r.gst_rate),
      taxable:   r2(r.taxable),
      cgst:      r2(r.cgst),
      sgst:      r2(r.sgst),
      igst:      r2(r.igst),
      cess:      r2(r.cess),
      total:     r2(r.total),
    }));

    const totals = data.reduce((acc, r) => {
      acc.quantity += r.quantity;
      acc.taxable  += r.taxable;
      acc.cgst     += r.cgst;
      acc.sgst     += r.sgst;
      acc.igst     += r.igst;
      acc.cess     += r.cess;
      acc.total    += r.total;
      return acc;
    }, { quantity: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 });
    Object.keys(totals).forEach((k) => { totals[k] = r2(totals[k]); });
    totals.hsn_count = data.length;

    res.json({ from, to, direction, hsn: data, totals });
  } catch (err) {
    console.error('hsnSummary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Stock Summary ──────────────────────────────────────────────────────
//
// Per-product opening / in / out / closing for the period. Reads the
// stock_ledger so the figures tie to ledger movements regardless of any
// drift in products.current_stock. Closing is computed inside the SQL
// (cumulative sum from earliest entry up to to_date) so we don't have
// to walk Node-side.
//
// Value (₹) uses each product's purchase_rate as a snapshot — a simple
// FIFO/MA cost model is a follow-up. For now this matches Stock Value
// tile in BalanceSheet (and so reconciles with it).
exports.stockSummary = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const categoryFilter = req.query.category_id ? ' AND p.category_id = :cid ' : '';
    // Optional godown scope. When set, every Opening/In/Out value is
    // computed from stock_ledger rows AT THAT GODOWN ONLY — so the
    // report tells the operator "what's at MAIN" rather than "what's
    // anywhere in the company". Without this, the same physical
    // movement of stock between godowns (a transfer) would inflate
    // both In and Out at the company level even though net is zero.
    const godownFilter = req.query.godown_id
      ? ' AND sl.godown_id = :gid '
      : '';
    const replacements = { from, to };
    if (req.query.category_id) replacements.cid = req.query.category_id;
    if (req.query.godown_id)   replacements.gid = req.query.godown_id;

    // Opening = sum of (in − out) for entries STRICTLY BEFORE from_date.
    // In/Out = sum within [from, to].  Closing = opening + in − out.
    // Pull mode + cost basis columns alongside the period-rollup so the
    // post-query mapper can resolve closing_value via the per-mode
    // helper (audit Hotspot F). For variant + single-no-batch the helper
    // is pure JS; single+batch needs the per-product batch aggregate
    // fetched after the main query.
    const sql = `
      WITH per_product AS (
        SELECT p.product_id,
               p.product_name,
               p.barcode,
               p.unit_of_measurement,
               p.hsn_code,
               p.purchase_rate,
               p.weighted_avg_cost,
               p.product_mode,
               p.is_batch_tracked,
               p.category_id,
               c.category_name,
               COALESCE(SUM(CASE WHEN sl.transaction_date < :from
                                  THEN sl.quantity_in - sl.quantity_out
                                  ELSE 0 END), 0)::float                       AS opening_qty,
               COALESCE(SUM(CASE WHEN sl.transaction_date BETWEEN :from AND :to
                                  THEN sl.quantity_in ELSE 0 END), 0)::float   AS in_qty,
               COALESCE(SUM(CASE WHEN sl.transaction_date BETWEEN :from AND :to
                                  THEN sl.quantity_out ELSE 0 END), 0)::float  AS out_qty
          FROM products p
          LEFT JOIN categories c ON c.category_id = p.category_id
          LEFT JOIN stock_ledger sl ON sl.product_id = p.product_id
                                    AND sl.transaction_date <= :to
                                    ${godownFilter}
         WHERE p.is_active = true
           ${categoryFilter}
         GROUP BY p.product_id, p.product_name, p.barcode, p.unit_of_measurement,
                  p.hsn_code, p.purchase_rate, p.weighted_avg_cost,
                  p.product_mode, p.is_batch_tracked,
                  p.category_id, c.category_name
      )
      SELECT *, (opening_qty + in_qty - out_qty) AS closing_qty
        FROM per_product
       ORDER BY product_name ASC`;

    const rows = await sequelize.query(sql, {
      replacements,
      type: sequelize.QueryTypes.SELECT,
    });

    // For single+batch products, closing_value isn't qty × cost — it's
    // SUM(batch.qty × batch.rate). Fetch the batch aggregate once for
    // the page, then look up per-product. Approximation note: the
    // batch aggregate reads CURRENT product_batch_stock, not as-of-date
    // — Stock Summary is "current stock as of to_date" not "historical
    // batch state", so this matches existing behaviour.
    const batchPids = rows
      .filter(r => r.product_mode === 'single' && r.is_batch_tracked)
      .map(r => r.product_id);
    const batchAgg = await fetchBatchAggregate(batchPids);

    const products = rows.map((r) => {
      const closing = num(r.closing_qty);
      let rate, closingValue;
      if (r.product_mode === 'single' && r.is_batch_tracked) {
        const agg = batchAgg.get(r.product_id);
        const tv = agg ? agg.total_value : 0;
        const tq = agg ? agg.total_qty   : 0;
        rate = tq > 0 ? tv / tq : 0;
        closingValue = tv;
      } else {
        rate = computeDisplayCost(r);
        closingValue = closing * rate;
      }
      return {
        product_id:    r.product_id,
        product_name:  r.product_name,
        barcode:       r.barcode,
        unit:          r.unit_of_measurement || 'PCS',
        hsn_code:      r.hsn_code,
        category_id:   r.category_id,
        category_name: r.category_name,
        purchase_rate: r2(rate),
        opening_qty:   r2(r.opening_qty),
        in_qty:        r2(r.in_qty),
        out_qty:       r2(r.out_qty),
        closing_qty:   r2(closing),
        closing_value: r2(closingValue),
      };
    });

    const totals = products.reduce((acc, p) => {
      acc.opening_qty   += p.opening_qty;
      acc.in_qty        += p.in_qty;
      acc.out_qty       += p.out_qty;
      acc.closing_qty   += p.closing_qty;
      acc.closing_value += p.closing_value;
      return acc;
    }, { opening_qty: 0, in_qty: 0, out_qty: 0, closing_qty: 0, closing_value: 0 });
    Object.keys(totals).forEach((k) => { totals[k] = r2(totals[k]); });
    totals.products_count = products.length;

    res.json({ from, to, products, totals });
  } catch (err) {
    console.error('stockSummary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Fast / Slow Movers ─────────────────────────────────────────────────
//
// Ranks active products by quantity sold within [from, to]. `limit` is
// honoured as the page size for both the top (fast movers) and bottom
// (slow movers) slices — slow movers EXCLUDE products that did not move
// at all (zero sales) so the user can distinguish "moved a little" from
// "didn't move". A separate `dead_stock_count` reports how many active
// products had zero sales over the period.
exports.movers = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    // Optional godown scope — restrict the sales window to bills issued
    // from the given godown. Lets a multi-warehouse op see "what moved
    // at MAIM" without bleed from PIMP / branch sales.
    const godownFilter = req.query.godown_id
      ? ' AND b.godown_id = :gid '
      : '';
    const replacements = { from, to };
    if (req.query.godown_id) replacements.gid = req.query.godown_id;

    const rows = await sequelize.query(
      // CASE WHEN guards on b.sales_bill_id ensure we only count line items
      // whose parent bill matches the period filter (and isn't cancelled).
      // Without the guard, items from out-of-window bills would still
      // contribute via the LEFT JOIN — making a future-window query
      // return non-zero sales.
      `SELECT p.product_id,
              p.product_name,
              p.barcode,
              p.hsn_code,
              p.unit_of_measurement,
              p.purchase_rate,
              c.category_name,
              COALESCE(SUM(CASE WHEN b.sales_bill_id IS NOT NULL THEN it.quantity            ELSE 0 END), 0)::float AS qty_sold,
              COALESCE(SUM(CASE WHEN b.sales_bill_id IS NOT NULL THEN it.taxable_amount      ELSE 0 END), 0)::float AS revenue,
              COALESCE(SUM(CASE WHEN b.sales_bill_id IS NOT NULL THEN it.quantity * it.cost_rate ELSE 0 END), 0)::float AS cogs,
              COUNT(DISTINCT b.sales_bill_id)::int       AS bills_touched
         FROM products p
         LEFT JOIN categories c ON c.category_id = p.category_id
         LEFT JOIN sales_bill_items it ON it.product_id = p.product_id
         LEFT JOIN sales_bills b ON b.sales_bill_id = it.sales_bill_id
                                AND b.is_cancelled = false
                                AND b.bill_date BETWEEN :from AND :to
                                ${godownFilter}
        WHERE p.is_active = true
        GROUP BY p.product_id, p.product_name, p.barcode, p.hsn_code,
                 p.unit_of_measurement, p.purchase_rate, c.category_name`,
      { replacements, type: sequelize.QueryTypes.SELECT },
    );

    const enriched = rows.map((r) => {
      const qty = num(r.qty_sold);
      const rev = num(r.revenue);
      const cogs = num(r.cogs);
      return {
        product_id:    r.product_id,
        product_name:  r.product_name,
        barcode:       r.barcode,
        hsn_code:      r.hsn_code,
        unit:          r.unit_of_measurement || 'PCS',
        category_name: r.category_name,
        qty_sold:      r2(qty),
        revenue:       r2(rev),
        cogs:          r2(cogs),
        gross_profit:  r2(rev - cogs),
        bills_touched: r.bills_touched || 0,
      };
    });

    const moved = enriched.filter((e) => e.qty_sold > 0);
    const fast  = moved.slice().sort((a, b) => b.qty_sold - a.qty_sold).slice(0, limit);
    const slow  = moved.slice().sort((a, b) => a.qty_sold - b.qty_sold).slice(0, limit);
    const deadStockCount = enriched.length - moved.length;

    const totals = enriched.reduce((acc, p) => {
      acc.qty_sold  += p.qty_sold;
      acc.revenue   += p.revenue;
      acc.cogs      += p.cogs;
      acc.gross_profit += p.gross_profit;
      return acc;
    }, { qty_sold: 0, revenue: 0, cogs: 0, gross_profit: 0 });
    Object.keys(totals).forEach((k) => { totals[k] = r2(totals[k]); });
    totals.products_active = enriched.length;
    totals.products_moved  = moved.length;
    totals.dead_stock_count = deadStockCount;

    res.json({ from, to, limit, fast, slow, totals });
  } catch (err) {
    console.error('movers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Stock Velocity (v2 Movers report) ────────────────────────────────
//
// Powers the redesigned Fast & Slow Movers page. Returns per-product
// velocity metrics + a single classification each row falls into:
//
//   fast     — cover < 30 days  AND qty_sold > 0
//   average  — cover 30 – 90 days
//   slow     — cover 90+ days   AND qty_sold > 0
//   slow     — qty_sold == 0 in period AND last sale ≤ DEAD_DAYS ago
//   dead     — qty_sold == 0 in period AND (no sale ever, or last sale > DEAD_DAYS ago)
//
// Classification math:
//   period_days     = inclusive day count from..to (≥ 1)
//   velocity_per_day  = qty_sold / period_days
//   velocity_per_month = velocity_per_day × 30  (display unit)
//   cover_days       = current_stock / velocity_per_day  (∞ when no sales)
//
// The cover-display class is computed independently — a "Fast" product
// running out (cover < 7 days) gets a red Cover column even though its
// row class is still 'fast'. That's deliberate: the action is "Reorder
// urgently", not "this product is slow".
//
// Totals are always over the FULL dataset (no class filter applied) so
// the tab counts on the UI stay constant across filter changes. The
// `rows` array is filtered + sorted + top-N capped per the request.
//
// Query params:
//   from_date      ISO YYYY-MM-DD (default = today − 89, i.e. 90-day window)
//   to_date        ISO YYYY-MM-DD (default = today)
//   class          'all' (default) | 'fast' | 'average' | 'slow' | 'dead'
//   limit          int 1–10000 (default 50)  — Top-N
//   sort           velocity_desc (default) | velocity_asc | cover_asc
//                  | cover_desc | stock_desc | sold_desc | name_asc
//   category_id    optional int filter
//   godown_id      optional int filter (scopes the SALES window only)
//   search         substring match on product_name / barcode / hsn_code
exports.stockVelocity = async (req, res) => {
  try {
    // ── Period ─────────────────────────────────────────────────────
    // Client always passes explicit dates (the frontend resolves the
    // preset). But we default to the last 90 days to make this endpoint
    // usable from a curl test without supplying dates.
    let from = (req.query && req.query.from_date) ? String(req.query.from_date).slice(0, 10) : null;
    let to   = (req.query && req.query.to_date)   ? String(req.query.to_date).slice(0, 10)   : null;
    if (!to) to = new Date().toISOString().slice(0, 10);
    if (!from) {
      const d = new Date(to + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 89);
      from = d.toISOString().slice(0, 10);
    }

    // Inclusive day count for velocity normalisation. Cap at 1 so a
    // single-day query doesn't divide by zero.
    const periodDays = Math.max(
      1,
      Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1,
    );

    // ── Filter inputs ──────────────────────────────────────────────
    const klass     = String(req.query.class || 'all').toLowerCase();
    const limit     = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 10000);
    const search    = String(req.query.search || '').trim();
    const categoryId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
    const godownId   = req.query.godown_id   ? parseInt(req.query.godown_id, 10)   : null;
    const sort      = String(req.query.sort || 'velocity_desc').toLowerCase();

    // ── Fetch ──────────────────────────────────────────────────────
    // Same shape as exports.movers() but enriched with last-sale-date.
    // The CASE-WHEN guards on b.sales_bill_id ensure line items from
    // out-of-window or cancelled bills don't contribute via the LEFT
    // JOIN — without them, future-window queries would return non-zero
    // sales for any product that ever sold.
    const godownSql = godownId ? ' AND b.godown_id = :gid ' : '';
    const categorySql = categoryId ? ' AND p.category_id = :cid ' : '';
    const searchSql = search
      ? ` AND (p.product_name ILIKE :q OR p.barcode ILIKE :q OR p.hsn_code ILIKE :q) `
      : '';
    const replacements = { from, to };
    if (godownId)   replacements.gid = godownId;
    if (categoryId) replacements.cid = categoryId;
    if (search)     replacements.q   = `%${search}%`;

    const rows = await sequelize.query(
      `SELECT p.product_id,
              p.product_name,
              p.barcode,
              p.hsn_code,
              p.size_value,
              p.size_unit,
              p.article_number,
              p.unit_of_measurement,
              p.purchase_rate,
              p.sale_rate,
              p.mrp,
              p.minimum_stock_level,
              p.reorder_level,
              p.current_stock,
              c.category_id,
              c.category_name,
              COALESCE(SUM(CASE WHEN b.sales_bill_id IS NOT NULL THEN it.quantity            ELSE 0 END), 0)::float AS qty_sold,
              COALESCE(SUM(CASE WHEN b.sales_bill_id IS NOT NULL THEN it.taxable_amount      ELSE 0 END), 0)::float AS revenue,
              COALESCE(SUM(CASE WHEN b.sales_bill_id IS NOT NULL THEN it.quantity * it.cost_rate ELSE 0 END), 0)::float AS cogs,
              COUNT(DISTINCT b.sales_bill_id)::int AS bills_touched,
              -- last-sale date — independent sub-query so the period
              -- WHERE clause doesn't restrict it. Lets us detect dead
              -- stock that hasn't sold in YEARS, not just outside the
              -- selected period.
              (SELECT MAX(b2.bill_date)::text
                 FROM sales_bill_items it2
                 JOIN sales_bills      b2 ON b2.sales_bill_id = it2.sales_bill_id
                WHERE it2.product_id = p.product_id
                  AND b2.is_cancelled = false) AS last_sale_date
         FROM products p
         LEFT JOIN categories c ON c.category_id = p.category_id
         LEFT JOIN sales_bill_items it ON it.product_id = p.product_id
         LEFT JOIN sales_bills b ON b.sales_bill_id = it.sales_bill_id
                                AND b.is_cancelled = false
                                AND b.bill_date BETWEEN :from AND :to
                                ${godownSql}
        WHERE p.is_active = true
          ${categorySql}
          ${searchSql}
        GROUP BY p.product_id, p.product_name, p.barcode, p.hsn_code,
                 p.size_value, p.size_unit, p.article_number,
                 p.unit_of_measurement, p.purchase_rate, p.sale_rate, p.mrp,
                 p.minimum_stock_level, p.reorder_level, p.current_stock,
                 c.category_id, c.category_name`,
      { replacements, type: sequelize.QueryTypes.SELECT },
    );

    // ── Classification thresholds (industry-standard / Tally defaults) ─
    const COVER_FAST = 30;     // <30 days cover  → fast
    const COVER_AVG  = 90;     // 30–90 days cover → average
    const DEAD_DAYS  = 180;    // >180 days since last sale → dead

    const todayD = new Date(to + 'T00:00:00Z');

    // Audit (stock M1) — operational dashboard's stock_value should mirror
    // the same mode-aware basis the main stock report uses (purchase_rate
    // for variant, weighted_avg_cost for single, batch-aggregate for
    // batched). Pre-fix, this dashboard pill used raw purchase_rate for
    // every product, which swings 10-30% under volatile pricing vs the
    // canonical Closing Stock figure on the Balance Sheet.
    //
    // attachDisplayCost takes the rows array and populates each row with
    // a `display_cost` (mode-aware) and `display_stock_value` field. We
    // use those when available, falling back to purchase_rate * qty for
    // legacy rows. Keeps the dashboard pill = BS stock_value to the rupee.
    let enrichedRows;
    try {
      enrichedRows = await attachDisplayCost(rows);
    } catch (_) { enrichedRows = rows; }
    const enriched = enrichedRows.map((r) => {
      const qtySold       = num(r.qty_sold);
      const stockQty      = num(r.current_stock);
      const purchaseRate  = num(r.purchase_rate);
      const stockValue    = r.display_stock_value != null
        ? r2(num(r.display_stock_value))
        : r2(stockQty * purchaseRate);
      const revenue       = r2(num(r.revenue));
      const cogs          = r2(num(r.cogs));
      const grossProfit   = r2(revenue - cogs);

      const velocityPerDay   = qtySold / periodDays;
      const velocityPerMonth = r2(velocityPerDay * 30);

      // Cover days — current stock at the current sales pace. NULL
      // (rendered as ∞) when there are no sales in the window.
      // Clamped to ≥ 0: a product with negative current_stock (sold
      // more than we have, eg. backorder) reports cover = 0 ("already
      // stocked-out, reorder now") rather than a meaningless negative
      // number. The classification then correctly lands in 'fast'.
      let coverDays = null;
      if (velocityPerDay > 0) {
        coverDays = Math.max(0, r2(stockQty / velocityPerDay));
      }

      // Last-sale tracking — for dead-stock detection.
      const lastSaleDate = r.last_sale_date || null;
      let daysSinceLastSale = null;
      if (lastSaleDate) {
        daysSinceLastSale = Math.floor(
          (todayD - new Date(lastSaleDate + 'T00:00:00Z')) / 86400000,
        );
      }

      // Row classification.
      let cls;
      if (qtySold === 0) {
        // No sales in the requested period.
        if (lastSaleDate === null || (daysSinceLastSale != null && daysSinceLastSale > DEAD_DAYS)) {
          cls = 'dead';
        } else {
          cls = 'slow';
        }
      } else if (coverDays !== null && coverDays < COVER_FAST) {
        cls = 'fast';
      } else if (coverDays !== null && coverDays < COVER_AVG) {
        cls = 'average';
      } else {
        cls = 'slow';
      }

      // Cover-column display class — independent of row class. Lets the
      // UI flag a "Fast" product about to stock out (cover < 7 d) in
      // red even though the row pill says "Fast".
      let coverClass;
      if (qtySold === 0)              coverClass = cls;          // dead or slow
      else if (coverDays < 7)         coverClass = 'low';        // < 1 week  → urgent reorder
      else if (coverDays < COVER_FAST) coverClass = 'fast';      // healthy fast
      else if (coverDays < COVER_AVG)  coverClass = 'avg';       // healthy
      else                             coverClass = 'slow';      // overstocked

      // Build a single "size" string the UI can render in its own
      // column. size_value is free-form ("32", "Free", "Set of 3");
      // size_unit is an enum (S/M/L/XL/XXL/Numeric/Custom). Combine
      // sensibly: numeric/custom show only the value; S/M/L/XL/XXL
      // show only the unit; otherwise both. Empty when neither set.
      const sizeStr = (() => {
        const v = (r.size_value || '').toString().trim();
        const u = (r.size_unit  || '').toString().trim();
        if (!v && !u) return '';
        if (!v) return u;
        if (!u || u === 'Numeric' || u === 'Custom') return v;
        return `${v} ${u}`;
      })();

      // Margin % — gross profit as a percentage of revenue. Anchored
      // on revenue (not COGS) because that's what accountants quote
      // for retail/wholesale ("we made 22% on this product"). NULL
      // when there's no revenue (no sales in period) so the UI can
      // dim it rather than showing a misleading 0%.
      const marginPct = revenue > 0 ? r2((grossProfit / revenue) * 100) : null;
      const saleRate     = r2(num(r.sale_rate));
      const mrp          = r2(num(r.mrp));
      const minStock     = num(r.minimum_stock_level);
      const reorderLevel = num(r.reorder_level);
      const billsTouched = r.bills_touched || 0;

      return {
        product_id:    r.product_id,
        product_name:  r.product_name,
        barcode:       r.barcode,
        hsn_code:      r.hsn_code,
        size:          sizeStr,
        size_value:    r.size_value || null,
        size_unit:     r.size_unit  || null,
        article_number: r.article_number || null,
        unit:          r.unit_of_measurement || 'PCS',
        category_id:   r.category_id,
        category_name: r.category_name,
        current_stock: stockQty,
        minimum_stock: minStock,
        reorder_level: reorderLevel,
        purchase_rate: r2(purchaseRate),
        sale_rate:     saleRate,
        mrp,
        stock_value:   stockValue,
        qty_sold:      r2(qtySold),
        revenue,
        cogs,
        gross_profit:  grossProfit,
        margin_pct:    marginPct,
        bills_touched: billsTouched,
        velocity_per_month: velocityPerMonth,
        cover_days:    coverDays,
        last_sale_date: lastSaleDate,
        days_since_last_sale: daysSinceLastSale,
        class:         cls,
        cover_class:   coverClass,
      };
    });

    // ── Totals (over the full dataset, regardless of filter) ──────
    const sumByClass = (cls, key) => r2(
      enriched.filter((p) => p.class === cls).reduce((s, p) => s + (p[key] || 0), 0),
    );

    // KPI helpers
    // ─ reorder_count: products whose cover-class is 'low' (<7d) — what
    //   the operator must reorder this week.
    // ─ capital_at_risk: stock value of slow + dead — money sitting on
    //   shelves without moving. The single most actionable inventory
    //   number on this page.
    // ─ avg_cover_days: average over products WITH sales (excludes
    //   dead/zero-velocity rows so they don't pull the average to ∞).
    const reorderCount = enriched.filter((p) => p.cover_class === 'low').length;
    const capitalAtRisk = r2(
      enriched.filter((p) => p.class === 'slow' || p.class === 'dead')
              .reduce((s, p) => s + p.stock_value, 0),
    );
    const withCover = enriched.filter((p) => p.cover_days != null);
    const avgCoverDays = withCover.length > 0
      ? r2(withCover.reduce((s, p) => s + p.cover_days, 0) / withCover.length)
      : null;

    // Margin % overall — revenue-weighted (not a simple average), so
    // big-ticket products carry their proper weight.
    const totalRevenue = enriched.reduce((s, p) => s + p.revenue, 0);
    const totalGp      = enriched.reduce((s, p) => s + p.gross_profit, 0);
    const overallMarginPct = totalRevenue > 0
      ? r2((totalGp / totalRevenue) * 100)
      : null;

    const totals = {
      products_active:  enriched.length,
      products_fast:    enriched.filter((p) => p.class === 'fast').length,
      products_average: enriched.filter((p) => p.class === 'average').length,
      products_slow:    enriched.filter((p) => p.class === 'slow').length,
      products_dead:    enriched.filter((p) => p.class === 'dead').length,

      stock_value_total:   r2(enriched.reduce((s, p) => s + p.stock_value, 0)),
      stock_value_fast:    sumByClass('fast',    'stock_value'),
      stock_value_average: sumByClass('average', 'stock_value'),
      stock_value_slow:    sumByClass('slow',    'stock_value'),
      stock_value_dead:    sumByClass('dead',    'stock_value'),

      qty_sold_total:     r2(enriched.reduce((s, p) => s + p.qty_sold, 0)),
      revenue_total:      r2(totalRevenue),
      gross_profit_total: r2(totalGp),
      margin_pct_overall: overallMarginPct,

      // Action-oriented aggregates for the KPI cards.
      reorder_count:    reorderCount,
      capital_at_risk:  capitalAtRisk,
      avg_cover_days:   avgCoverDays,
    };

    // ── Filter by selected class ──────────────────────────────────
    let filtered = enriched;
    if (klass !== 'all') {
      filtered = enriched.filter((p) => p.class === klass);
    }

    // ── Sort ──────────────────────────────────────────────────────
    // Cover ascending must put nulls (no sales) at the END so the user
    // sees "running out" rows first. Hence (a.cover_days ?? Infinity).
    const sorters = {
      velocity_desc: (a, b) => b.velocity_per_month - a.velocity_per_month,
      velocity_asc:  (a, b) => a.velocity_per_month - b.velocity_per_month,
      cover_asc:     (a, b) => (a.cover_days ?? Infinity) - (b.cover_days ?? Infinity),
      cover_desc:    (a, b) => (b.cover_days ?? -1)        - (a.cover_days ?? -1),
      stock_desc:    (a, b) => b.current_stock - a.current_stock,
      stock_asc:     (a, b) => a.current_stock - b.current_stock,
      sold_desc:     (a, b) => b.qty_sold - a.qty_sold,
      sold_asc:      (a, b) => a.qty_sold - b.qty_sold,
      name_asc:      (a, b) => (a.product_name || '').localeCompare(b.product_name || ''),
      name_desc:     (a, b) => (b.product_name || '').localeCompare(a.product_name || ''),
    };
    filtered.sort(sorters[sort] || sorters.velocity_desc);

    // ── Top-N cap ─────────────────────────────────────────────────
    const paged = filtered.slice(0, limit);

    res.json({
      period:         { from, to, days: periodDays },
      filters:        { class: klass, limit, sort, category_id: categoryId, godown_id: godownId, search },
      filtered_count: filtered.length,
      rows:           paged,
      totals,
    });
  } catch (err) {
    console.error('stockVelocity error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Godown Transfer Register ─────────────────────────────────────────
//
// Date-windowed list of stock_transfers with optional from/to/status
// filters. Includes line items and from/to godown labels. Same data
// the Stock Transfers list shows, but exposed as a report so it can
// be filed alongside the inventory reports the operator already
// reviews monthly. Date defaults via resolvePeriod (FY-aware).
//
// Output shape mirrors the existing operational-report endpoints:
// `{ from, to, transfers: [...], totals: {...} }` so the client can
// render headers + table + summary in the usual three-strip layout.
exports.transferRegister = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const where = ['t.transfer_date BETWEEN :from AND :to'];
    const replacements = { from, to };
    if (req.query.from_godown_id) {
      where.push('t.from_godown_id = :fid');
      replacements.fid = req.query.from_godown_id;
    }
    if (req.query.to_godown_id) {
      where.push('t.to_godown_id = :tid');
      replacements.tid = req.query.to_godown_id;
    }
    if (req.query.status) {
      where.push('t.status = :status');
      replacements.status = req.query.status;
    }

    const transfers = await sequelize.query(
      `SELECT t.transfer_id, t.transfer_number, t.transfer_date,
              t.status, t.notes,
              t.total_quantity::float AS total_quantity,
              t.total_value::float    AS total_value,
              t.from_godown_id, gf.code AS from_code, gf.name AS from_name,
              t.to_godown_id,   gt.code AS to_code,   gt.name AS to_name,
              (SELECT COUNT(*)::int FROM stock_transfer_items i
                 WHERE i.transfer_id = t.transfer_id) AS item_count
         FROM stock_transfers t
         LEFT JOIN godowns gf ON gf.godown_id = t.from_godown_id
         LEFT JOIN godowns gt ON gt.godown_id = t.to_godown_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.transfer_date DESC, t.transfer_id DESC`,
      { replacements, type: sequelize.QueryTypes.SELECT },
    );

    // Bucket-totals by status — useful for the report summary strip
    // (e.g. "12 Received · 3 In-Transit · 1 Cancelled").
    const totals = transfers.reduce((acc, t) => {
      acc.count += 1;
      acc.total_quantity += parseFloat(t.total_quantity) || 0;
      acc.total_value    += parseFloat(t.total_value)    || 0;
      acc.by_status[t.status] = (acc.by_status[t.status] || 0) + 1;
      return acc;
    }, { count: 0, total_quantity: 0, total_value: 0, by_status: {} });
    totals.total_quantity = r2(totals.total_quantity);
    totals.total_value    = r2(totals.total_value);

    res.json({ from, to, transfers, totals });
  } catch (err) {
    console.error('transferRegister error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Godown-wise Stock Valuation ───────────────────────────────────────
//
// Aggregates per-godown stock value: SUM(pgs.current_stock * p.purchase_rate)
// grouped by godown. Active godowns only. Inactive godowns are skipped
// rather than shown with zeros — the operator wants a snapshot of where
// inventory currently sits, not an audit of every godown ever created.
//
// `?detail=true` adds a per-product breakdown for each godown (used by
// the drill-in panel of the report); without it, only the per-godown
// roll-up rows are returned (cheap default for the dashboard tile).
exports.godownValuation = async (req, res) => {
  try {
    // Mode-aware godown summary (audit Hotspots G + H). The SQL CASE
    // handles variant + single-no-batch in one pass; single+batch
    // contribution per-godown is added in JS via
    // fetchBatchAggregateByGodown — single+batch values can differ per
    // godown because batches sit at specific godowns.
    const summary = await sequelize.query(
      `SELECT g.godown_id, g.code, g.name, g.is_default,
              COUNT(DISTINCT pgs.product_id)::int                  AS products,
              COALESCE(SUM(pgs.current_stock), 0)::float           AS total_qty,
              COALESCE(SUM(pgs.current_stock * (CASE
                WHEN p.product_mode = 'single' AND p.is_batch_tracked = false
                  THEN COALESCE(p.weighted_avg_cost, p.purchase_rate, 0)
                WHEN p.product_mode = 'single' AND p.is_batch_tracked = true
                  THEN 0
                ELSE p.purchase_rate
              END)), 0)::float                                     AS partial_total_value
         FROM godowns g
         LEFT JOIN product_godown_stock pgs ON pgs.godown_id = g.godown_id
         LEFT JOIN products p              ON p.product_id   = pgs.product_id
                                            AND p.is_active = true
        WHERE g.is_active = true
        GROUP BY g.godown_id, g.code, g.name, g.is_default
        ORDER BY g.is_default DESC, g.code ASC`,
      { type: sequelize.QueryTypes.SELECT },
    );

    // Single+batch product_ids that have stock somewhere. One fetch
    // covers every godown — Map keyed by `${pid}:${gid}`.
    const batchPidRows = await sequelize.query(
      `SELECT DISTINCT p.product_id
         FROM products p
         JOIN product_batch_stock pbs ON pbs.product_id = p.product_id
        WHERE p.is_active = true AND p.product_mode = 'single' AND p.is_batch_tracked = true
          AND pbs.current_stock > 0`,
      { type: sequelize.QueryTypes.SELECT },
    );
    const batchAggByGodown = await fetchBatchAggregateByGodown(batchPidRows.map(r => r.product_id));
    // Per-godown roll-up of batch values for the summary row totals.
    const batchValueByGodown = new Map();
    for (const [key, v] of batchAggByGodown) {
      const [, godownId] = key.split(':');
      const gid = parseInt(godownId, 10);
      batchValueByGodown.set(gid, (batchValueByGodown.get(gid) || 0) + (v.total_value || 0));
    }
    const enrichedSummary = summary.map(g => ({
      ...g,
      total_value: r2(parseFloat(g.partial_total_value || 0) + (batchValueByGodown.get(g.godown_id) || 0)),
    }));

    let detail = null;
    if (req.query.detail === 'true') {
      // Detail rows are still one per (godown, product). For single+
      // batch products, value comes from the per-godown batch aggregate
      // (since one product can have different batches at different
      // godowns). Variant + single-no-batch use the master cost basis
      // via computeDisplayCost.
      const rawDetail = await sequelize.query(
        `SELECT pgs.godown_id, pgs.product_id,
                p.product_name, p.barcode, p.unit_of_measurement,
                p.category_id, c.category_name,
                pgs.current_stock::float    AS current_stock,
                p.purchase_rate::float      AS purchase_rate,
                p.weighted_avg_cost::float  AS weighted_avg_cost,
                p.product_mode              AS product_mode,
                p.is_batch_tracked          AS is_batch_tracked
           FROM product_godown_stock pgs
           JOIN products p   ON p.product_id   = pgs.product_id AND p.is_active = true
           LEFT JOIN categories c ON c.category_id = p.category_id
          WHERE pgs.current_stock > 0
          ORDER BY pgs.godown_id ASC, p.product_name ASC`,
        { type: sequelize.QueryTypes.SELECT },
      );
      detail = rawDetail.map(r => {
        let rate, value;
        if (r.product_mode === 'single' && r.is_batch_tracked) {
          const agg = batchAggByGodown.get(`${r.product_id}:${r.godown_id}`);
          const tv = agg ? agg.total_value : 0;
          const tq = agg ? agg.total_qty   : 0;
          rate = tq > 0 ? tv / tq : 0;
          value = tv;
        } else {
          rate = computeDisplayCost(r);
          value = (parseFloat(r.current_stock) || 0) * rate;
        }
        return {
          godown_id: r.godown_id,
          product_id: r.product_id,
          product_name: r.product_name,
          barcode: r.barcode,
          unit_of_measurement: r.unit_of_measurement,
          category_id: r.category_id,
          category_name: r.category_name,
          current_stock: r.current_stock,
          purchase_rate: r2(rate),
          value: r2(value),
        };
      });
    }

    const totals = enrichedSummary.reduce((acc, g) => {
      acc.total_qty   += parseFloat(g.total_qty)   || 0;
      acc.total_value += parseFloat(g.total_value) || 0;
      acc.godowns     += 1;
      return acc;
    }, { godowns: 0, total_qty: 0, total_value: 0 });
    totals.total_qty   = r2(totals.total_qty);
    totals.total_value = r2(totals.total_value);

    res.json({ summary: enrichedSummary, detail, totals });
  } catch (err) {
    console.error('godownValuation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Stock by Color ────────────────────────────────────────────────────
//
// ONE row per multi-color product. Each row carries an aggregate of its
// active color rows (color_count, total_stock, stock_value) plus has_low /
// has_out flags so the operator can scan a list of products and spot
// which families have at least one color short. Tapping a row drills
// into a per-color detail page (handled by GET /api/products/:id/colors
// — already wired by productColorAPI).
//
// Why per-product, not per-color: a Stock-Report-style master list with
// a "8 colors" badge is what the operator wants for purchase decisions.
// "80 in stock" hides "0 Blue" — but at master level the operator
// just needs to see "Lyra has issues, drill in."
//
// Filters:
//   • category_id   — single id (numeric)
//   • search        — case-insensitive substring on product_name,
//                     barcode, article_number (mirror of Stock Report)
//   • status        — 'all' (default), 'short' (any color out OR low),
//                     'ok' (all colors OK)
//
// Pagination + summary contract matches the rest of the report endpoints
// so the page can use useVirtualizedReport / VirtualReportTable
// unchanged.
exports.stockByColor = async (req, res) => {
  try {
    const { sanitizePagination } = require('../utils/helpers');
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);

    const replacements = {};
    let categoryFilter = '';
    if (req.query.category_id) {
      categoryFilter = ' AND p.category_id = :cid ';
      replacements.cid = parseInt(req.query.category_id, 10);
    }
    let searchFilter = '';
    if (req.query.search) {
      searchFilter = ` AND (
        p.product_name    ILIKE :search OR
        p.barcode         ILIKE :search OR
        p.article_number  ILIKE :search
      ) `;
      replacements.search = `%${String(req.query.search).trim()}%`;
    }

    // Per-product roll-up. A LEFT JOIN onto product_colors keeps a
    // multi-color product with no active colors visible (count = 0)
    // rather than disappearing.
    //
    // Status-aware aggregates use FILTER (...) clauses so the helper
    // count-of-low / count-of-out doesn't require a second pass.
    const baseSql = `
      WITH per_product AS (
        SELECT p.product_id,
               p.product_name,
               p.barcode,
               p.size_value,
               p.article_number,
               p.product_mode,
               p.is_batch_tracked,
               p.purchase_rate::float        AS purchase_rate,
               p.weighted_avg_cost::float    AS weighted_avg_cost,
               p.unit_of_measurement,
               p.category_id,
               c.category_name,
               COUNT(pc.color_id) FILTER (WHERE pc.is_active = true)::int  AS color_count,
               COALESCE(SUM(pc.current_stock) FILTER (WHERE pc.is_active = true), 0)::float AS total_stock,
               COUNT(pc.color_id) FILTER (
                 WHERE pc.is_active = true AND pc.current_stock <= 0
               )::int AS out_count,
               COUNT(pc.color_id) FILTER (
                 WHERE pc.is_active = true
                   AND pc.low_stock_alert > 0
                   AND pc.current_stock > 0
                   AND pc.current_stock <= pc.low_stock_alert
               )::int AS low_count
          FROM products p
          LEFT JOIN categories c ON c.category_id = p.category_id
          LEFT JOIN product_colors pc ON pc.product_id = p.product_id
         WHERE p.is_active = true
           AND p.color_mode = 'multi'
           ${categoryFilter}
           ${searchFilter}
         GROUP BY p.product_id, p.product_name, p.barcode, p.size_value,
                  p.article_number, p.product_mode, p.is_batch_tracked,
                  p.purchase_rate, p.weighted_avg_cost,
                  p.unit_of_measurement, p.category_id, c.category_name
      )`;

    // Status filter applied AFTER the aggregate so out_count/low_count
    // are available. Three modes mirror the Stock Report's chip filter.
    let statusFilter = '';
    const status = (req.query.status || 'all').toString();
    if (status === 'short') statusFilter = ' WHERE (out_count > 0 OR low_count > 0) ';
    else if (status === 'ok') statusFilter = ' WHERE out_count = 0 AND low_count = 0 ';

    // Page query — ordered, paginated.
    const pagedSql = `
      ${baseSql}
      SELECT * FROM per_product
      ${statusFilter}
      ORDER BY product_name ASC, size_value ASC NULLS LAST
      LIMIT :limit OFFSET :offset
    `;
    const pagedRows = await sequelize.query(pagedSql, {
      replacements: { ...replacements, limit, offset },
      type: sequelize.QueryTypes.SELECT,
    });

    // Total + summary across the FULL filtered set (not just the page)
    // so the KPI strip + paginator stay correct as the user scrolls.
    const summarySql = `
      ${baseSql}
      SELECT COUNT(*)::int                                           AS total_count,
             COALESCE(SUM(total_stock), 0)::float                    AS total_qty,
             COUNT(*) FILTER (WHERE out_count > 0)::int              AS short_out_count,
             COUNT(*) FILTER (WHERE low_count > 0 AND out_count = 0)::int AS short_low_count,
             COUNT(*) FILTER (WHERE out_count = 0 AND low_count = 0)::int AS ok_count
        FROM per_product
        ${statusFilter}
    `;
    const summaryRow = (await sequelize.query(summarySql, {
      replacements,
      type: sequelize.QueryTypes.SELECT,
    }))[0] || {};

    // Per-row stock value via the same display-cost helper the rest of
    // the inventory reports use. Single+batch rows fall back to 0 — per-
    // color batch rates aren't tracked, so we don't fabricate a number.
    let totalValue = 0;
    const enriched = pagedRows.map((r) => {
      let rate = 0;
      if (r.product_mode === 'single' && r.is_batch_tracked) {
        rate = 0;
      } else {
        rate = computeDisplayCost(r);
      }
      const value = num(r.total_stock) * rate;
      totalValue += value;
      const isShort = (r.out_count > 0) || (r.low_count > 0);
      return {
        product_id:      r.product_id,
        product_name:    r.product_name,
        barcode:         r.barcode,
        size_value:      r.size_value,
        article_number:  r.article_number,
        category_id:     r.category_id,
        category_name:   r.category_name,
        unit_of_measurement: r.unit_of_measurement,
        color_count:     r.color_count,
        total_stock:     r2(num(r.total_stock)),
        out_count:       r.out_count,
        low_count:       r.low_count,
        purchase_rate:   r2(rate),
        stock_value:     r2(value),
        is_short:        isShort,
      };
    });

    // total_value is a page-level total, not a global one — the global
    // value would need a second pass over every product (heavy) and
    // isn't usually what the operator wants on a paginated list.
    const summary = {
      total_count:   parseInt(summaryRow.total_count || 0, 10),
      total_qty:     r2(num(summaryRow.total_qty)),
      short_out_count: parseInt(summaryRow.short_out_count || 0, 10),
      short_low_count: parseInt(summaryRow.short_low_count || 0, 10),
      ok_count:      parseInt(summaryRow.ok_count || 0, 10),
      page_value:    r2(totalValue),
    };

    res.json({
      total: summary.total_count,
      page,
      limit,
      data: enriched,
      summary,
    });
  } catch (err) {
    console.error('stockByColor error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
