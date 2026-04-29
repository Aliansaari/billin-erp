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
    const sql = `
      WITH per_product AS (
        SELECT p.product_id,
               p.product_name,
               p.barcode,
               p.unit_of_measurement,
               p.hsn_code,
               p.purchase_rate,
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
                  p.hsn_code, p.purchase_rate, p.category_id, c.category_name
      )
      SELECT *, (opening_qty + in_qty - out_qty) AS closing_qty
        FROM per_product
       ORDER BY product_name ASC`;

    const rows = await sequelize.query(sql, {
      replacements,
      type: sequelize.QueryTypes.SELECT,
    });

    const products = rows.map((r) => {
      const closing = num(r.closing_qty);
      const rate    = num(r.purchase_rate);
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
        closing_value: r2(closing * rate),
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
    const summary = await sequelize.query(
      `SELECT g.godown_id, g.code, g.name, g.is_default,
              COUNT(DISTINCT pgs.product_id)::int                  AS products,
              COALESCE(SUM(pgs.current_stock), 0)::float           AS total_qty,
              COALESCE(SUM(pgs.current_stock * p.purchase_rate), 0)::float
                                                                   AS total_value
         FROM godowns g
         LEFT JOIN product_godown_stock pgs ON pgs.godown_id = g.godown_id
         LEFT JOIN products p              ON p.product_id   = pgs.product_id
                                            AND p.is_active = true
        WHERE g.is_active = true
        GROUP BY g.godown_id, g.code, g.name, g.is_default
        ORDER BY g.is_default DESC, g.code ASC`,
      { type: sequelize.QueryTypes.SELECT },
    );

    let detail = null;
    if (req.query.detail === 'true') {
      detail = await sequelize.query(
        `SELECT pgs.godown_id, pgs.product_id,
                p.product_name, p.barcode, p.unit_of_measurement,
                p.category_id, c.category_name,
                pgs.current_stock::float AS current_stock,
                p.purchase_rate::float   AS purchase_rate,
                (pgs.current_stock * p.purchase_rate)::float AS value
           FROM product_godown_stock pgs
           JOIN products p   ON p.product_id   = pgs.product_id AND p.is_active = true
           LEFT JOIN categories c ON c.category_id = p.category_id
          WHERE pgs.current_stock > 0
          ORDER BY pgs.godown_id ASC, p.product_name ASC`,
        { type: sequelize.QueryTypes.SELECT },
      );
    }

    const totals = summary.reduce((acc, g) => {
      acc.total_qty   += parseFloat(g.total_qty)   || 0;
      acc.total_value += parseFloat(g.total_value) || 0;
      acc.godowns     += 1;
      return acc;
    }, { godowns: 0, total_qty: 0, total_value: 0 });
    totals.total_qty   = r2(totals.total_qty);
    totals.total_value = r2(totals.total_value);

    res.json({ summary, detail, totals });
  } catch (err) {
    console.error('godownValuation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
