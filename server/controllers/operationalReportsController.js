// ── Operational Reports Controller (Phase R3) ──────────────────────────
//
// Bill-level + item-level operational reports. Distinct from the existing
// list reports (`salesReport`, `purchaseReport`, `stockReport`) which are
// paginated UI listings — these are *registers*: full-period, one-row-
// per-bill (or per-HSN / per-product), suitable for audit, GSTR
// reconciliation, and management review.
//
// Period:
//   • from_date / to_date in req.query — defaults to current FY (start
//     → today) when missing.
//
// Source of truth:
//   • Sales/Purchase Registers + HSN Summary read directly from
//     sales_bill_items / purchase_bill_items joined to the bill header.
//     Cancelled bills are excluded.
//   • Stock Summary + Fast/Slow Movers read from stock_ledger so that
//     opening, in, out, and closing tie to ledger movements (not the
//     denormalised products.current_stock which can drift).

const sequelize = require('../config/database');
const { Op, fn, col, literal } = require('sequelize');
const {
  SystemSettings, SalesBill, PurchaseBill, SalesBillItem, PurchaseBillItem,
  Party, Product, StockLedger, Category,
} = require('../models');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v) { return Math.round(num(v) * 100) / 100; }

// Net activity (Cr − Dr for income accounts, Dr − Cr for expense) on a
// named ledger within a date range. Live entries only.
async function ledgerNetWithinPeriod(ledgerName, from, to) {
  const [r] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount), 0)::float  AS dr,
            COALESCE(SUM(le.credit_amount), 0)::float AS cr
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
      WHERE la.ledger_name = :name
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries m
           WHERE m.reversal_of_id = le.entry_id
        )
        AND le.entry_date BETWEEN :from AND :to`,
    { replacements: { name: ledgerName, from, to }, type: sequelize.QueryTypes.SELECT },
  );
  return { dr: r2(r.dr), cr: r2(r.cr) };
}

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

// ── Sales Register ─────────────────────────────────────────────────────
//
// Full-period bill-by-bill listing. Each row carries headline numbers
// (taxable, CGST, SGST, IGST, total, paid, balance) plus the customer
// label. No pagination — the consumer is expected to be a report screen
// or Excel exporter that wants the entire period in memory.
exports.salesRegister = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const where = { is_cancelled: false, bill_date: { [Op.between]: [from, to] } };
    if (req.query.customer_id) where.customer_id = req.query.customer_id;

    const rows = await SalesBill.findAll({
      where,
      include: [{ model: Party, as: 'customer', attributes: ['party_id', 'party_name', 'gstin', 'state'] }],
      order: [['bill_date', 'ASC'], ['sales_bill_id', 'ASC']],
    });

    const data = rows.map((b) => ({
      sales_bill_id: b.sales_bill_id,
      bill_number:   b.bill_number,
      bill_date:     b.bill_date,
      customer_id:   b.customer_id,
      customer_name: b.customer ? b.customer.party_name : '(Walk-in)',
      gstin:         b.customer ? b.customer.gstin : null,
      state:         b.customer ? b.customer.state : null,
      taxable:       r2(b.sub_total),
      discount:      r2(b.discount_amount),
      cgst:          r2(b.cgst_amount),
      sgst:          r2(b.sgst_amount),
      igst:          r2(b.igst_amount),
      cess:          r2(b.cess_amount),
      round_off:     r2(b.round_off),
      total:         r2(b.total_amount),
      paid:          r2(b.paid_amount),
      balance:       r2(b.balance_amount),
      status:        b.payment_status,
      bill_mode:     b.bill_mode,
    }));

    const totals = data.reduce((acc, r) => {
      acc.taxable  += r.taxable;
      acc.discount += r.discount;
      acc.cgst     += r.cgst;
      acc.sgst     += r.sgst;
      acc.igst     += r.igst;
      acc.cess     += r.cess;
      acc.total    += r.total;
      acc.paid     += r.paid;
      acc.balance  += r.balance;
      return acc;
    }, { taxable: 0, discount: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, paid: 0, balance: 0 });
    Object.keys(totals).forEach((k) => { totals[k] = r2(totals[k]); });
    totals.bills_count = data.length;

    // Capture the non-taxable charges that the voucher builder bundles
    // into the Sales Account credit (Net Sales method —
    // see services/voucherBuilders.js): Sales Cr posts as
    //   sub_total − discount + other_charges + freight_charges.
    // The register's `taxable` is sub_total alone, so the apples-to-
    // apples comparison for ledger reconciliation requires adding
    // freight + other and subtracting discount.
    let regFreight = 0, regOther = 0;
    for (const b of rows) {
      regFreight += num(b.freight_charges);
      regOther   += num(b.other_charges);
    }
    regFreight = r2(regFreight); regOther = r2(regOther);

    // Cross-reconciliation: Sales Account ledger net Cr (in period)
    // should equal Σ(sub_total − discount + other + freight) — the
    // same formula the voucher builder posts. Drift surfaces a banner
    // (genuine causes: manual JV against Sales that bypasses billing,
    // amount-mode bills with mismatched fields).
    const salesLedger      = await ledgerNetWithinPeriod('Sales Account', from, to);
    const salesNetCr       = r2(salesLedger.cr - salesLedger.dr);
    const registerNetToLedger = r2(totals.taxable - totals.discount + regOther + regFreight);
    const reconciliation = {
      ledger_name:            'Sales Account',
      ledger_net_credit:      salesNetCr,
      register_net_to_ledger: registerNetToLedger,
      // Breakdown — the banner displays the formula so any future
      // drift is diagnosable from the screen.
      register_taxable:  totals.taxable,
      register_discount: totals.discount,
      register_freight:  regFreight,
      register_other:    regOther,
      difference:        r2(salesNetCr - registerNetToLedger),
      balanced:          Math.abs(salesNetCr - registerNetToLedger) < 0.01,
    };

    res.json({ from, to, bills: data, totals, reconciliation });
  } catch (err) {
    console.error('salesRegister error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Purchase Register ──────────────────────────────────────────────────
exports.purchaseRegister = async (req, res) => {
  try {
    const { from, to } = await resolvePeriod(req.query);
    const where = { is_cancelled: false, bill_date: { [Op.between]: [from, to] } };
    if (req.query.supplier_id) where.supplier_id = req.query.supplier_id;

    const rows = await PurchaseBill.findAll({
      where,
      include: [{ model: Party, as: 'supplier', attributes: ['party_id', 'party_name', 'gstin', 'state'] }],
      order: [['bill_date', 'ASC'], ['purchase_bill_id', 'ASC']],
    });

    const data = rows.map((b) => ({
      purchase_bill_id: b.purchase_bill_id,
      bill_number:      b.bill_number,
      supplier_bill_no: b.supplier_bill_number,
      bill_date:        b.bill_date,
      supplier_id:      b.supplier_id,
      supplier_name:    b.supplier ? b.supplier.party_name : '(Cash purchase)',
      gstin:            b.supplier ? b.supplier.gstin : null,
      state:            b.supplier ? b.supplier.state : null,
      taxable:          r2(b.sub_total),
      discount:         r2(b.discount_amount),
      cgst:             r2(b.cgst_amount),
      sgst:             r2(b.sgst_amount),
      igst:             r2(b.igst_amount),
      cess:             r2(b.cess_amount),
      round_off:        r2(b.round_off),
      total:            r2(b.total_amount),
      paid:             r2(b.paid_amount),
      balance:          r2(b.balance_amount),
      status:           b.payment_status,
      bill_mode:        b.bill_mode,
    }));

    const totals = data.reduce((acc, r) => {
      acc.taxable  += r.taxable;
      acc.discount += r.discount;
      acc.cgst     += r.cgst;
      acc.sgst     += r.sgst;
      acc.igst     += r.igst;
      acc.cess     += r.cess;
      acc.total    += r.total;
      acc.paid     += r.paid;
      acc.balance  += r.balance;
      return acc;
    }, { taxable: 0, discount: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, paid: 0, balance: 0 });
    Object.keys(totals).forEach((k) => { totals[k] = r2(totals[k]); });
    totals.bills_count = data.length;

    let regFreight = 0, regOther = 0;
    for (const b of rows) {
      regFreight += num(b.freight_charges);
      regOther   += num(b.other_charges);
    }
    regFreight = r2(regFreight); regOther = r2(regOther);

    // Cross-reconciliation: Purchase Account ledger net Dr should equal
    // Σ(sub_total − discount + other + freight) — the same formula
    // buildPurchaseBillVouchers uses (Net Purchase method).
    const purLedger      = await ledgerNetWithinPeriod('Purchase Account', from, to);
    const purNetDr       = r2(purLedger.dr - purLedger.cr);
    const registerNetToLedger = r2(totals.taxable - totals.discount + regOther + regFreight);
    const reconciliation = {
      ledger_name:            'Purchase Account',
      ledger_net_debit:       purNetDr,
      register_net_to_ledger: registerNetToLedger,
      register_taxable:  totals.taxable,
      register_discount: totals.discount,
      register_freight:  regFreight,
      register_other:    regOther,
      difference:        r2(purNetDr - registerNetToLedger),
      balanced:          Math.abs(purNetDr - registerNetToLedger) < 0.01,
    };

    res.json({ from, to, bills: data, totals, reconciliation });
  } catch (err) {
    console.error('purchaseRegister error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

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
    const replacements = { from, to };
    if (req.query.category_id) replacements.cid = req.query.category_id;

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
        WHERE p.is_active = true
        GROUP BY p.product_id, p.product_name, p.barcode, p.hsn_code,
                 p.unit_of_measurement, p.purchase_rate, c.category_name`,
      { replacements: { from, to }, type: sequelize.QueryTypes.SELECT },
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
