const { Op, fn, col, literal } = require('sequelize');
const sequelize = require('../config/database');
const { SalesBill, SalesBillItem, PurchaseBill, PurchaseBillItem, Party, Product, Category, PaymentReceipt, StockLedger, SalesReturnBill, SalesReturnBillItem, PurchaseReturnBill, PurchaseReturnBillItem, SystemSettings, ProductGodownStock } = require('../models');
const { sanitizePagination, escapeLike, respondWithError } = require('../utils/helpers');
const { aggregateAging, distributeOpenBalanceFifo, round2 } = require('../utils/aging');
const { fetchBatchAggregate, computeDisplayCost, attachDisplayCost } = require('../utils/displayCost');
const { scopeWhereByGodown, effectiveGodownIds } = require('../middleware/godownScope');

// Local calendar date (YYYY-MM-DD) in the server's timezone. We deliberately
// avoid toISOString().split('T')[0] here because that returns a UTC date — for
// any server running outside UTC (e.g. IST +5:30), "today" in UTC can fall on a
// different calendar day than the user's, making dashboard "today" totals off
// by a whole day during the evening/morning hours.
const localDateString = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

exports.dashboardStats = async (req, res) => {
  try {
    // Honor optional from/to query params so the dashboard filters its
    // "today's sales/purchases/receipts" and "monthly" aggregates to the
    // operator-selected date range. When omitted we fall back to today +
    // month-to-date (the legacy default behaviour).
    const fromQ = String(req.query.from || '').slice(0, 10);
    const toQ   = String(req.query.to   || '').slice(0, 10);
    const today      = /^\d{4}-\d{2}-\d{2}$/.test(toQ)   ? toQ   : localDateString();
    const monthStart = /^\d{4}-\d{2}-\d{2}$/.test(fromQ) ? fromQ : today.substring(0, 8) + '01';
    // Date-range mode = "from" and "to" both supplied. Sales/purchases
    // counted across the full window (not just the end-date) so the operator
    // sees range totals when they pick a custom span.
    const rangeMode = fromQ && toQ;

    // Prior-period bounds for the comparison deltas the dashboard tiles
    // render. "Today vs yesterday" + "MTD vs same window of last month" —
    // i.e. if today is the 7th, prior MTD = 1st through 7th of last month.
    // Computed in JS (not SQL) so we can pass plain date strings to the
    // existing Sequelize calls.
    const todayDateObj      = new Date(today + 'T00:00:00');
    const yesterdayDateObj  = new Date(todayDateObj);
    yesterdayDateObj.setDate(yesterdayDateObj.getDate() - 1);
    const yesterday         = localDateString(yesterdayDateObj);
    const priorMonthStartObj = new Date(todayDateObj);
    priorMonthStartObj.setMonth(priorMonthStartObj.getMonth() - 1);
    priorMonthStartObj.setDate(1);
    const priorMonthStart   = localDateString(priorMonthStartObj);
    // Same-day cap on prior month — clamps Mar-31 vs Feb-28 to "1st-28th"
    // by relying on JS Date overflow: setting day-of-month to today's day
    // beyond the month's last day rolls into the next month, which we
    // then back off via the day-overflow check below.
    const priorMonthEndObj  = new Date(priorMonthStartObj);
    priorMonthEndObj.setDate(todayDateObj.getDate());
    if (priorMonthEndObj.getMonth() !== priorMonthStartObj.getMonth()) {
      // Day-of-month overflowed (e.g. trying to set Feb 30 → Mar 2).
      // Walk back to the last valid day of the prior month.
      priorMonthEndObj.setDate(0);
    }
    const priorMonthEnd     = localDateString(priorMonthEndObj);

    // Like-for-like comparison window. In range mode the delta must compare
    // the selected window against the SAME-LENGTH window immediately before
    // it — comparing "last 30 days" against "last month same-days" produced
    // absurd chips (e.g. ↑601%) whenever the two windows overlapped oddly.
    // Legacy no-range mode keeps the classic "MTD vs last month same days".
    let priorFrom = priorMonthStart;
    let priorTo   = priorMonthEnd;
    if (rangeMode) {
      const fromObj    = new Date(monthStart + 'T00:00:00');
      const spanMs     = Math.max(0, todayDateObj.getTime() - fromObj.getTime());
      const priorToObj = new Date(fromObj);
      priorToObj.setDate(priorToObj.getDate() - 1);
      const priorFromObj = new Date(priorToObj.getTime() - spanMs);
      priorFrom = localDateString(priorFromObj);
      priorTo   = localDateString(priorToObj);
    }

    /* ── Parallel fetch of all independent aggregates ─────────────────────
     *
     * Every read below is independent of every other read in this block.
     * Running them sequentially (the old code did) wasted ~80% of the
     * wall-clock time waiting on Postgres round-trips that could have
     * been overlapped. Promise.all collapses that to a single batch and
     * lets Sequelize pull connections from the pool concurrently — what
     * used to be ~21 queries × 30 ms = 630 ms drops to ~80 ms (the slowest
     * query alone). Crucial for 10–20 LAN clients each hitting the
     * dashboard on cold-load.
     *
     * Rules to keep this safe when adding a new read:
     *   1. The query must NOT depend on a value computed from another
     *      read in this block. If it does, await that one upstream and
     *      pass the value in via `replacements`.
     *   2. Every query opens its own pool connection — DON'T use
     *      `sequelize.transaction(...)` here; it would serialise them.
     *   3. Order of destructure matches the order of the array literal.
     *      Add new entries at the end so existing indexes don't shift.
     */
    const [
      todaySales,
      todayPurchases,
      monthlySales,
      monthlyPurchases,
      receivableRows,
      payableRows,
      todayReceiptsRows,
      opexRows,
      salesmanRows,
    ] = await Promise.all([
      // Today's (or range) sales
      SalesBill.findAll({
        where: rangeMode
          ? { bill_date: { [Op.gte]: monthStart, [Op.lte]: today }, is_cancelled: false }
          : { bill_date: today, is_cancelled: false },
        attributes: [
          [fn('COUNT', col('sales_bill_id')), 'count'],
          [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
        ],
        raw: true,
      }),

      // Today's (or range) purchases
      PurchaseBill.findAll({
        where: rangeMode
          ? { bill_date: { [Op.gte]: monthStart, [Op.lte]: today }, is_cancelled: false }
          : { bill_date: today, is_cancelled: false },
        attributes: [
          [fn('COUNT', col('purchase_bill_id')), 'count'],
          [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
        ],
        raw: true,
      }),

      // Monthly (or range) sales — pull gross and GST components so we can derive
      // true revenue (revenue excluding tax) for the profit metric. GST is
      // collected on behalf of the tax authority, NOT income — mixing it into
      // profit overstates margin by up to 18%.
      SalesBill.findAll({
        where: { bill_date: { [Op.gte]: monthStart, [Op.lte]: today }, is_cancelled: false },
        attributes: [
          // COUNT feeds the dashboard's Avg-ticket card (total ÷ count).
          // Without it the frontend fell back to dividing by 1 and the
          // "Avg ticket" tile silently displayed the whole MTD total.
          [fn('COUNT', col('sales_bill_id')), 'count'],
          [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
          [fn('COALESCE', fn('SUM', col('cgst_amount')), 0), 'cgst'],
          [fn('COALESCE', fn('SUM', col('sgst_amount')), 0), 'sgst'],
          [fn('COALESCE', fn('SUM', col('igst_amount')), 0), 'igst'],
          [fn('COALESCE', fn('SUM', col('cess_amount')), 0), 'cess'],
        ],
        raw: true,
      }),

      // Monthly (or range) purchases
      PurchaseBill.findAll({
        where: { bill_date: { [Op.gte]: monthStart, [Op.lte]: today }, is_cancelled: false },
        attributes: [
          [fn('COUNT', col('purchase_bill_id')), 'count'],
          [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
          [fn('COALESCE', fn('SUM', col('cgst_amount')), 0), 'cgst'],
          [fn('COALESCE', fn('SUM', col('sgst_amount')), 0), 'sgst'],
          [fn('COALESCE', fn('SUM', col('igst_amount')), 0), 'igst'],
          [fn('COALESCE', fn('SUM', col('cess_amount')), 0), 'cess'],
        ],
        raw: true,
      }),

      // Receivables and payables — use party.current_balance directly.
      // recalculatePartyBalance maintains this as:
      //   opening + sales - purchases - receipts + payments + returns
      // which is the single source of truth. The old bill-based formula
      // double-counted opening balances (added them on top of bill balances
      // that already reflected those openings via payment reconciliation).
      //
      // Scope by party_type so these tiles MATCH the Customers / Suppliers
      // list pages exactly:
      //   • Receivables = Customer/Both dues  (= Customers page "Total Receivable")
      //   • Payables    = Supplier/Both dues  (= Suppliers page "Total Payable")
      // Without this filter the tiles summed EVERY credit/debit balance —
      // e.g. a customer sitting on an advance (credit balance) inflated
      // Payables — so the dashboard never agreed with the party lists.
      // 'Both' parties net to a single signed balance and land on the
      // correct side by sign, so they're never double-counted.
      sequelize.query(`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(current_balance), 0)::float AS total
        FROM parties
        WHERE current_balance > 0
          AND party_type IN ('Customer', 'Both')
          AND COALESCE(is_system_cash, false) = false
      `).then(([rows]) => rows),
      sequelize.query(`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(ABS(current_balance)), 0)::float AS total
        FROM parties
        WHERE current_balance < 0
          AND party_type IN ('Supplier', 'Both')
          AND COALESCE(is_system_cash, false) = false
      `).then(([rows]) => rows),

      // Today's (or range) receipts — money received from customers
      PaymentReceipt.findAll({
        where: rangeMode
          ? { transaction_date: { [Op.gte]: monthStart, [Op.lte]: today }, transaction_type: 'Receipt', is_cancelled: false }
          : { transaction_date: today, transaction_type: 'Receipt', is_cancelled: false },
        attributes: [
          [fn('COUNT', col('transaction_id')), 'count'],
          [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
        ],
        raw: true,
      }),

      // Operating expenses for the SAME window as the sales/purchase
      // aggregates — feeds the P&L panel's "Operating expenses" row, which
      // previously rendered a hardcoded ₹0 even though the Expenses module
      // was busy booking vouchers. Period-consistent with revenue/COGS so
      // Net profit = Gross − opex is honest for any selected range.
      sequelize.query(
        `SELECT COALESCE(SUM(total_amount), 0)::float AS total
           FROM expense_vouchers
          WHERE is_cancelled = false
            AND voucher_date BETWEEN :from AND :to`,
        { replacements: { from: monthStart, to: today }, type: sequelize.QueryTypes.SELECT },
      ).catch(() => [{ total: 0 }]),   // table absent on very old installs

      // Salesman leaderboard for the window. The unassigned bucket
      // (walk-in / legacy bills with no salesman) is kept as a sentinel
      // row so the frontend can show it as a footnote instead of letting
      // it drown the named leaderboard on counter-heavy shops.
      sequelize.query(
        `SELECT COALESCE(NULLIF(TRIM(salesman_name), ''), '__none__') AS name,
                COUNT(*)::int AS bills,
                COALESCE(SUM(total_amount), 0)::float AS total
           FROM sales_bills
          WHERE is_cancelled = false
            AND bill_date BETWEEN :from AND :to
          GROUP BY 1
          ORDER BY total DESC`,
        { replacements: { from: monthStart, to: today }, type: sequelize.QueryTypes.SELECT },
      ).catch(() => []),
    ]);

    const receivables = [{
      count: receivableRows[0]?.count || 0,
      total: receivableRows[0]?.total || 0,
    }];
    const payables = [{
      count: payableRows[0]?.count || 0,
      total: payableRows[0]?.total || 0,
    }];

    /* ── Second parallel batch ──────────────────────────────────────────
     * Stock-value, low-stock, recent-bills, and the COGS roll-up are all
     * independent of the receivables/payables pulled above. Run them in
     * parallel too. The single sequential dependency that remains is
     * `dashBatchAgg → batchProductIds`, which we resolve right after. */
    const [lowStock, stockValue, batchProductIds, recentSales, recentPurchases, cogsRow] = await Promise.all([
      // Low stock count
      Product.count({
        where: {
          is_active: true,
          minimum_stock_level: { [Op.gt]: 0 },
          current_stock: { [Op.lte]: col('minimum_stock_level') },
        },
      }),

      // Stock value — mode-aware (audit-driven, Commit 3c).
      //   purchase_value: variant uses purchase_rate; single (no batch)
      //                   uses weighted_avg_cost (with COALESCE to
      //                   purchase_rate to 0); single+batch uses
      //                   SUM(batch.qty × batch.rate) via separate query.
      //   sale_value:     unchanged — sale_rate is the catalog list price
      //                   in all modes.
      Product.findAll({
        where: { is_active: true, current_stock: { [Op.gt]: 0 } },
        attributes: [
          [fn('COALESCE', fn('SUM', literal(`
            "current_stock" * (CASE
              WHEN "product_mode" = 'single' AND "is_batch_tracked" = false
                THEN COALESCE("weighted_avg_cost", "purchase_rate", 0)
              WHEN "product_mode" = 'single' AND "is_batch_tracked" = true
                THEN 0
              ELSE "purchase_rate"
            END)
          `)), 0), 'partial_purchase_value'],
          [fn('COALESCE', fn('SUM', literal('"current_stock" * "sale_rate"')), 0), 'sale_value'],
        ],
        raw: true,
      }),

      // Single+batch contribution to purchase_value — same active-and-on-hand
      // filter as the main aggregate. fetchBatchAggregate (called below)
      // covers the batch dimension; we only need to sum the per-product
      // total_value across the rows it returns for batch-tracked active
      // products.
      Product.findAll({
        where: { is_active: true, product_mode: 'single', is_batch_tracked: true },
        attributes: ['product_id'],
        raw: true,
      }),

      // Recent bills (used to render the recent-activity strip)
      SalesBill.findAll({
        where: { is_cancelled: false },
        include: [{ model: Party, as: 'customer', attributes: ['party_name'] }],
        order: [['created_date', 'DESC']],
        limit: 10,
      }),
      PurchaseBill.findAll({
        where: { is_cancelled: false },
        include: [{ model: Party, as: 'supplier', attributes: ['party_name'] }],
        order: [['created_date', 'DESC']],
        limit: 10,
      }),

      // Real gross profit COGS — moved up from the section below so it can
      // run in parallel with all the other reads. The rest of the profit
      // calculation (which depends on monthlySales/monthlyPurchases) stays
      // where it was.
      sequelize.query(
        `
        SELECT
          (
            SELECT COALESCE(SUM(sbi.quantity * sbi.cost_rate), 0)::float
            FROM sales_bill_items sbi
            JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
            WHERE sb.is_cancelled = false AND sb.bill_date >= :monthStart
          ) AS cogs,
          (
            SELECT COALESCE(SUM(return_amount), 0)::float
            FROM sales_bills
            WHERE is_cancelled = false AND bill_date >= :monthStart
          ) AS adjustments
        `,
        { replacements: { monthStart }, type: sequelize.QueryTypes.SELECT },
      ).then(rows => rows[0]),
    ]);

    // Single small sequential step that genuinely depends on the parallel
    // batch above — fetchBatchAggregate needs the IDs we just fetched.
    const dashBatchAgg = await fetchBatchAggregate(batchProductIds.map(r => r.product_id));
    const dashBatchPurchaseValue = Array.from(dashBatchAgg.values())
      .reduce((s, a) => s + (a.total_value || 0), 0);

    // Compute tax-excluded figures for the profit metric.
    const ms = monthlySales[0], mp = monthlyPurchases[0];
    const monthlySalesGross   = parseFloat(ms.total);
    const monthlyPurchGross   = parseFloat(mp.total);
    const monthlySalesGST     = parseFloat(ms.cgst) + parseFloat(ms.sgst) + parseFloat(ms.igst) + parseFloat(ms.cess);
    const monthlyPurchGST     = parseFloat(mp.cgst) + parseFloat(mp.sgst) + parseFloat(mp.igst) + parseFloat(mp.cess);
    const monthlySalesExGST   = +(monthlySalesGross - monthlySalesGST).toFixed(2);
    const monthlyPurchExGST   = +(monthlyPurchGross - monthlyPurchGST).toFixed(2);
    const monthlyGSTLiability = +(monthlySalesGST - monthlyPurchGST).toFixed(2); // output GST – input credit

    // Real gross profit — uses per-line COGS from sales_bill_items.cost_rate,
    // which we snapshot at the moment each sale is created. This is the
    // correct accounting definition: revenue (ex-GST) minus COGS on items
    // actually sold this month. The legacy "sales-minus-purchases" figure
    // mixed inflow vs. outflow and double-counted stock that stayed in
    // inventory; this number replaces it without breaking the existing
    // `monthly_profit` contract on the dashboard.
    //
    // The cogsRow query was hoisted up into the second parallel batch to
    // overlap with the stock-value reads.
    const monthlyCOGS   = parseFloat(cogsRow.cogs) || 0;
    const monthlyAdj    = parseFloat(cogsRow.adjustments) || 0;
    const monthlyProfit = +(monthlySalesExGST - monthlyCOGS - monthlyAdj).toFixed(2);

    /* ── Prior-period aggregates for delta chips ───────────────────────
     * Yesterday's sales/purchases (for the "today" tiles' delta) plus
     * last-month-MTD sales / purchases / cogs (for the monthly tiles).
     * One statement each — the indices on (bill_date, is_cancelled) keep
     * them cheap. All independent → run in parallel. */
    const [yPriorSales, yPriorPurchases, priorMonthSales, priorMonthPurchases, priorCogsRow] = await Promise.all([
      sequelize.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(total_amount), 0)::float AS total
           FROM sales_bills
          WHERE bill_date = :yesterday AND is_cancelled = false`,
        { replacements: { yesterday }, type: sequelize.QueryTypes.SELECT },
      ).then(rows => rows[0]),
      sequelize.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(total_amount), 0)::float AS total
           FROM purchase_bills
          WHERE bill_date = :yesterday AND is_cancelled = false`,
        { replacements: { yesterday }, type: sequelize.QueryTypes.SELECT },
      ).then(rows => rows[0]),
      sequelize.query(
        `SELECT COALESCE(SUM(total_amount), 0)::float AS total,
                COALESCE(SUM(cgst_amount + sgst_amount + igst_amount + cess_amount), 0)::float AS gst,
                COALESCE(SUM(return_amount), 0)::float AS adjustments
           FROM sales_bills
          WHERE is_cancelled = false
            AND bill_date BETWEEN :from AND :to`,
        { replacements: { from: priorFrom, to: priorTo }, type: sequelize.QueryTypes.SELECT },
      ).then(rows => rows[0]),
      sequelize.query(
        `SELECT COALESCE(SUM(total_amount), 0)::float AS total,
                COALESCE(SUM(cgst_amount + sgst_amount + igst_amount + cess_amount), 0)::float AS gst
           FROM purchase_bills
          WHERE is_cancelled = false
            AND bill_date BETWEEN :from AND :to`,
        { replacements: { from: priorFrom, to: priorTo }, type: sequelize.QueryTypes.SELECT },
      ).then(rows => rows[0]),
      sequelize.query(
        `SELECT COALESCE(SUM(sbi.quantity * sbi.cost_rate), 0)::float AS cogs
           FROM sales_bill_items sbi
           JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
          WHERE sb.is_cancelled = false
            AND sb.bill_date BETWEEN :from AND :to`,
        { replacements: { from: priorFrom, to: priorTo }, type: sequelize.QueryTypes.SELECT },
      ).then(rows => rows[0]),
    ]);

    const priorSalesGross   = parseFloat(priorMonthSales.total)    || 0;
    const priorSalesGST     = parseFloat(priorMonthSales.gst)      || 0;
    const priorAdj          = parseFloat(priorMonthSales.adjustments) || 0;
    const priorPurchGross   = parseFloat(priorMonthPurchases.total) || 0;
    const priorPurchGST     = parseFloat(priorMonthPurchases.gst)   || 0;
    const priorSalesExGST   = +(priorSalesGross  - priorSalesGST).toFixed(2);
    const priorPurchExGST   = +(priorPurchGross  - priorPurchGST).toFixed(2);
    const priorCOGS         = parseFloat(priorCogsRow.cogs) || 0;
    const priorProfit       = +(priorSalesExGST - priorCOGS - priorAdj).toFixed(2);
    const priorGSTLiability = +(priorSalesGST - priorPurchGST).toFixed(2);

    /* Fourteen days of sales, oldest first, with empty days present as zero.
     *
     * The home screen shows one number for today and had no way to say whether
     * that number is a good day or a bad one. A percentage against yesterday
     * was tried and removed, correctly — a bare "+12%" is a verdict with no
     * evidence, and yesterday is an arbitrary thing to be measured against.
     *
     * A short series is the evidence instead: the shape says "normal",
     * "quiet", or "best day this fortnight" without asserting any of them.
     * generate_series fills the gaps so a closed day is a gap in the line
     * rather than a missing point that flatters the trend. */
    const salesSeries = await sequelize.query(
      `SELECT d::date AS date,
              COALESCE(SUM(sb.total_amount), 0)::float AS total
         FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d
    LEFT JOIN sales_bills sb
           ON sb.bill_date = d::date
          AND sb.is_cancelled = false
        GROUP BY d
        ORDER BY d ASC`,
      { type: sequelize.QueryTypes.SELECT },
    );

    res.json({
      today_sales: { count: parseInt(todaySales[0].count), total: parseFloat(todaySales[0].total) },
      sales_series: (salesSeries || []).map((r) => ({
        date: String(r.date).slice(0, 10),
        total: Number(r.total) || 0,
      })),
      today_purchases: { count: parseInt(todayPurchases[0].count), total: parseFloat(todayPurchases[0].total) },
      today_receipts: { count: parseInt(todayReceiptsRows[0].count), total: parseFloat(todayReceiptsRows[0].total) },
      // Monthly totals — both gross (invoice) and tax-excluded views are returned
      // so the UI can display either. monthly_profit is the CORRECT one (excl. GST).
      monthly_sales: monthlySalesGross,
      monthly_purchases: monthlyPurchGross,
      monthly_sales_count: parseInt(ms.count) || 0,
      monthly_purchases_count: parseInt(mp.count) || 0,
      monthly_sales_excl_gst: monthlySalesExGST,
      monthly_purchases_excl_gst: monthlyPurchExGST,
      monthly_gst_collected: +monthlySalesGST.toFixed(2),
      monthly_gst_paid: +monthlyPurchGST.toFixed(2),
      monthly_gst_liability: monthlyGSTLiability,
      monthly_profit: monthlyProfit,
      // Period-consistent operating expenses (see opex query above).
      monthly_opex: +parseFloat(opexRows[0]?.total || 0).toFixed(2),
      // Named-salesman leaderboard + the unassigned remainder, split so a
      // counter-heavy shop's walk-in bills don't bury the actual salesmen.
      salesman_leaderboard: (salesmanRows || [])
        .filter(r => r.name !== '__none__')
        .slice(0, 5)
        .map(r => ({ name: r.name, bills: r.bills, total: +parseFloat(r.total || 0).toFixed(2) })),
      salesman_unassigned: (() => {
        const u = (salesmanRows || []).find(r => r.name === '__none__');
        return u ? { bills: u.bills, total: +parseFloat(u.total || 0).toFixed(2) } : { bills: 0, total: 0 };
      })(),
      receivables: { count: parseInt(receivables[0].count || 0), total: +parseFloat(receivables[0].total || 0).toFixed(2) },
      payables:    { count: parseInt(payables[0].count    || 0), total: +parseFloat(payables[0].total    || 0).toFixed(2) },
      low_stock_count: lowStock,
      stock_value: {
        purchase: +(parseFloat(stockValue[0].partial_purchase_value || 0) + dashBatchPurchaseValue).toFixed(2),
        sale: parseFloat(stockValue[0].sale_value),
      },
      // Comparison snapshot — the tiles render a "vs <label>" delta chip
      // based on these. `prior.window` is the date range used for the
      // monthly comparison so the UI can label the chip honestly
      // (e.g. "vs 1-7 Apr").
      prior: {
        yesterday_date: yesterday,
        today_sales:     { count: yPriorSales.count,     total: yPriorSales.total },
        today_purchases: { count: yPriorPurchases.count, total: yPriorPurchases.total },
        window: { from: priorFrom, to: priorTo },
        monthly_sales:           priorSalesGross,
        monthly_purchases:       priorPurchGross,
        monthly_sales_excl_gst:  priorSalesExGST,
        monthly_purchases_excl_gst: priorPurchExGST,
        monthly_gst_collected:   +priorSalesGST.toFixed(2),
        monthly_gst_paid:        +priorPurchGST.toFixed(2),
        monthly_gst_liability:   priorGSTLiability,
        monthly_profit:          priorProfit,
      },
      recent_sales: recentSales,
      recent_purchases: recentPurchases,
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    respondWithError(res, error);
  }
};

// Rich actionable insights for the dashboard tiles — top overdue
// customers / suppliers, bills due this week, top-selling products this
// week, dead-stock value, cheques pending. One endpoint, six parallel
// queries; the response stays small (each list capped at 5-10 items)
// so the dashboard fetch stays under 100ms.
//
// "Overdue" is bills past their due_date with a non-zero balance. "Due
// soon" is bills with due_date in the next 7 days, balance still owed.
// "Dead stock" is active products with on-hand stock and no sales in
// the last 60 days. "Cheques pending" counts cheques in PENDING status.
exports.dashboardInsights = async (req, res) => {
  try {
    // "Overdue" ages from due_date when set, else bill_date. Imported bills
    // routinely carry NULL due_date; the old `due_date IS NOT NULL` filter
    // made both lists come back EMPTY on such data, which blanked the
    // dashboard's Top-customers panel and under-counted overdue chips.
    const top5OverdueCustomers = await sequelize.query(
      `SELECT p.party_id, p.party_name,
              COALESCE(SUM(sb.balance_amount), 0)::float AS balance,
              MAX((CURRENT_DATE - COALESCE(sb.due_date, sb.bill_date))::int) AS oldest_days
         FROM sales_bills sb
         JOIN parties p ON p.party_id = sb.customer_id
        WHERE sb.is_cancelled = false
          AND sb.balance_amount > 0
          AND COALESCE(sb.due_date, sb.bill_date) < CURRENT_DATE
        GROUP BY p.party_id, p.party_name
        ORDER BY balance DESC
        LIMIT 5`,
      { type: sequelize.QueryTypes.SELECT },
    );

    const top5OverdueSuppliers = await sequelize.query(
      `SELECT p.party_id, p.party_name,
              COALESCE(SUM(pb.balance_amount), 0)::float AS balance,
              MAX((CURRENT_DATE - COALESCE(pb.due_date, pb.bill_date))::int) AS oldest_days
         FROM purchase_bills pb
         JOIN parties p ON p.party_id = pb.supplier_id
        WHERE pb.is_cancelled = false
          AND pb.balance_amount > 0
          AND COALESCE(pb.due_date, pb.bill_date) < CURRENT_DATE
        GROUP BY p.party_id, p.party_name
        ORDER BY balance DESC
        LIMIT 5`,
      { type: sequelize.QueryTypes.SELECT },
    );

    /* How much is actually OVERDUE, in total.
     *
     * The two queries above return the worst five parties, which answers
     * "who" but not "how much" — and on a phone the home screen has room for
     * one number, not five. For a wholesaler the overdue total is the number
     * the day turns on: an outstanding balance is normal, an overdue one is
     * money that should already be in the account. Same predicate as the
     * top-five queries, so the two can never disagree. */
    const [overdueReceivable] = await sequelize.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(balance_amount), 0)::float AS total
         FROM sales_bills
        WHERE is_cancelled = false
          AND balance_amount > 0
          AND COALESCE(due_date, bill_date) < CURRENT_DATE`,
      { type: sequelize.QueryTypes.SELECT },
    );

    const [overduePayable] = await sequelize.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(balance_amount), 0)::float AS total
         FROM purchase_bills
        WHERE is_cancelled = false
          AND balance_amount > 0
          AND COALESCE(due_date, bill_date) < CURRENT_DATE`,
      { type: sequelize.QueryTypes.SELECT },
    );

    const [billsDueSales] = await sequelize.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(balance_amount), 0)::float AS total
         FROM sales_bills
        WHERE is_cancelled = false
          AND balance_amount > 0
          AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`,
      { type: sequelize.QueryTypes.SELECT },
    );

    const [billsDuePurchase] = await sequelize.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(balance_amount), 0)::float AS total
         FROM purchase_bills
        WHERE is_cancelled = false
          AND balance_amount > 0
          AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`,
      { type: sequelize.QueryTypes.SELECT },
    );

    const top5SellingProducts = await sequelize.query(
      `SELECT p.product_id, p.product_name,
              COALESCE(SUM(sbi.quantity), 0)::float       AS qty,
              COALESCE(SUM(sbi.total_amount), 0)::float   AS value
         FROM sales_bill_items sbi
         JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
         JOIN products p ON p.product_id = sbi.product_id
        WHERE sb.is_cancelled = false
          AND sb.bill_date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY p.product_id, p.product_name
        ORDER BY value DESC
        LIMIT 5`,
      { type: sequelize.QueryTypes.SELECT },
    );

    // Top categories — same 7-day window as top products. With thousands of
    // SKUs (and generic "loose stock" items), the category roll-up often
    // says more about what's actually selling than any single product row.
    // category_name is the snapshot stored on each bill item, so renames
    // don't rewrite history and no extra join is needed.
    const top5Categories = await sequelize.query(
      `SELECT COALESCE(NULLIF(TRIM(sbi.category_name), ''), 'Uncategorised') AS category_name,
              COALESCE(SUM(sbi.quantity), 0)::float     AS qty,
              COALESCE(SUM(sbi.total_amount), 0)::float AS value,
              COUNT(DISTINCT sbi.product_id)::int       AS skus
         FROM sales_bill_items sbi
         JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
        WHERE sb.is_cancelled = false
          AND sb.bill_date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY 1
        ORDER BY value DESC
        LIMIT 5`,
      { type: sequelize.QueryTypes.SELECT },
    );

    // Dead stock — count of active SKUs with on-hand qty and zero sales
    // in the last 60 days, plus the cost-basis value of that idle stock.
    // Capital that's frozen on shelves; the actionable signal is the
    // total value, the count is the secondary detail.
    const [deadStock] = await sequelize.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(p.current_stock * p.purchase_rate), 0)::float AS total_value
         FROM products p
        WHERE p.is_active = true
          AND p.current_stock > 0
          AND NOT EXISTS (
            SELECT 1
              FROM sales_bill_items sbi
              JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
             WHERE sbi.product_id = p.product_id
               AND sb.is_cancelled = false
               AND sb.bill_date >= CURRENT_DATE - INTERVAL '60 days'
          )`,
      { type: sequelize.QueryTypes.SELECT },
    );

    // Cheques pending — issued or received but not yet cleared/bounced.
    // PENDING status covers both directions; the UI splits by `direction`
    // (OUTWARD = we issued; INWARD = we received) when it cares.
    const [chequesPending] = await sequelize.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(amount), 0)::float AS total
         FROM cheques
        WHERE status = 'PENDING'`,
      { type: sequelize.QueryTypes.SELECT },
    ).catch(() => [{ count: 0, total: 0 }]);  // table may not exist on older installs

    res.json({
      overdue_receivables: top5OverdueCustomers,
      overdue_payables:    top5OverdueSuppliers,
      overdue_totals: {
        receivable: overdueReceivable || { count: 0, total: 0 },
        payable:    overduePayable    || { count: 0, total: 0 },
      },
      bills_due_soon: {
        sales:    billsDueSales,
        purchase: billsDuePurchase,
      },
      top_selling_products: top5SellingProducts,
      top_categories: top5Categories,
      dead_stock: deadStock,
      cheques_pending: chequesPending,
    });
  } catch (error) {
    console.error('Dashboard insights error:', error);
    respondWithError(res, error);
  }
};

// Wholesale business intelligence — the editorial dashboard's "deep" view.
// Computes everything the headline KPI strip + working-capital + business-
// velocity panels need that the legacy dashboardStats doesn't already
// produce. Kept as its own endpoint so the classic tile dashboard isn't
// affected and so the heavier joins can be cached / rate-limited later
// without touching the lightweight stats endpoint.
//
// Returns:
//   cash_position           — current cash + bank balances (closing)
//   cash_runway_days        — days of runway at last-90d avg outflow
//   monthly_cogs            — COGS for current month
//   monthly_opex            — expense vouchers for current month
//   working_capital         — { current_assets, current_liabilities,
//                                current_ratio, quick_ratio }
//   business_velocity       — { dso, dpo, dio, ccc, dso_prior, dpo_prior, dio_prior }
//   inventory_turnover      — annualised (last-90d COGS × 4 / avg inv)
//   inventory_breakdown     — { fast, med, slow, dead } SKU counts
//   customer_concentration  — { pct, risk, top_n, top: [...] }
//   actions                 — top-3 recommendations
exports.dashboardBusiness = async (req, res) => {
  try {
    const today = localDateString();
    const monthStart = today.slice(0, 7) + '-01';
    const d90 = new Date(); d90.setDate(d90.getDate() - 90);
    const day90Start = d90.toISOString().slice(0, 10);

    // ─── Cash position from the cash/bank LEDGERS ────────────────────────
    //
    // Σ(Dr − Cr) over ledgers grouped under Cash-in-Hand / Bank Accounts /
    // Bank OD A/c — the same balances the Bank module and Day Book show,
    // so the dashboard tile always agrees with them. Reversed entries are
    // excluded pair-wise (same pattern as ledgerNetWithinPeriod).
    //
    // The old formula (all-time receipts − payments from payments_receipts)
    // ignored opening balances and at-billing cash entirely, which on real
    // imported data produced a large NEGATIVE "cash" — and that poisoned
    // current assets and flipped the quick ratio to nonsense like −21.
    // Fallback: when the install has no cash/bank ledger rows at all
    // (entry_count = 0), keep the legacy receipts−payments signal rather
    // than showing a hard 0.
    const [cashRow] = await sequelize.query(`
      SELECT
        COALESCE((SELECT SUM(le.debit_amount - le.credit_amount)
                    FROM ledger_entries le
                    JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
                   WHERE la.sub_group IN ('Cash-in-Hand','Bank Accounts','Bank OD A/c')
                     AND le.reversal_of_id IS NULL
                     AND NOT EXISTS (
                       SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id
                     )), 0)::float AS ledger_cash,

        COALESCE((SELECT COUNT(*)
                    FROM ledger_entries le
                    JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
                   WHERE la.sub_group IN ('Cash-in-Hand','Bank Accounts','Bank OD A/c')), 0)::int AS ledger_entry_count,

        COALESCE((SELECT SUM(total_amount) FROM payments_receipts
                   WHERE transaction_type = 'Receipt' AND is_cancelled = false), 0)::float
        -
        COALESCE((SELECT SUM(total_amount) FROM payments_receipts
                   WHERE transaction_type = 'Payment' AND is_cancelled = false), 0)::float
        AS flow_cash,

        COALESCE((SELECT SUM(total_amount) FROM payments_receipts
                   WHERE transaction_type = 'Payment' AND is_cancelled = false
                     AND transaction_date >= :day90Start), 0)::float AS out90,

        COALESCE((SELECT SUM(total_amount) FROM expense_vouchers
                   WHERE is_cancelled = false
                     AND voucher_date >= :day90Start), 0)::float AS expense90,

        COALESCE((SELECT SUM(total_amount) FROM expense_vouchers
                   WHERE is_cancelled = false
                     AND voucher_date >= :monthStart), 0)::float AS opex_mtd
    `, { replacements: { day90Start, monthStart }, type: sequelize.QueryTypes.SELECT });

    const cashPosition = +(((cashRow.ledger_entry_count || 0) > 0
      ? cashRow.ledger_cash
      : cashRow.flow_cash) || 0).toFixed(2);
    const out90Combined = +(((cashRow.out90 || 0) + (cashRow.expense90 || 0)) / 90).toFixed(2);
    const cashRunway = out90Combined > 0
      ? Math.max(0, Math.round(cashPosition / out90Combined))
      : null;

    // ─── 90-day windowed sums for DSO / DPO / DIO ───────────────────────
    const [d90Row] = await sequelize.query(`
      SELECT
        COALESCE((SELECT SUM(total_amount) FROM sales_bills
                   WHERE is_cancelled = false AND bill_date >= :day90Start), 0)::float AS sales90,
        COALESCE((SELECT SUM(total_amount) FROM purchase_bills
                   WHERE is_cancelled = false AND bill_date >= :day90Start), 0)::float AS purch90,
        COALESCE((SELECT SUM(sbi.quantity * sbi.cost_rate) FROM sales_bill_items sbi
                   JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
                   WHERE sb.is_cancelled = false AND sb.bill_date >= :day90Start), 0)::float AS cogs90,
        COALESCE((SELECT SUM(p.current_stock *
                              CASE
                                WHEN p.product_mode = 'single' AND p.is_batch_tracked = false
                                  THEN COALESCE(p.weighted_avg_cost, p.purchase_rate, 0)
                                WHEN p.product_mode = 'single' AND p.is_batch_tracked = true
                                  THEN 0
                                ELSE p.purchase_rate
                              END)
                  FROM products p WHERE p.is_active = true AND p.current_stock > 0), 0)::float AS inv_value
    `, { replacements: { day90Start }, type: sequelize.QueryTypes.SELECT });

    const sales90 = d90Row.sales90 || 0;
    const purch90 = d90Row.purch90 || 0;
    const cogs90 = d90Row.cogs90 || 0;
    const invValue = d90Row.inv_value || 0;

    // Current AR/AP — party.current_balance, the single source of truth
    // (maintained by recalculatePartyBalance). Uses the EXACT same query
    // shape as dashboardStats' Receivables/Payables tiles and the
    // Customers/Suppliers list pages, so DSO / working capital are
    // computed from the same ₹ figure the operator sees on those tiles.
    // The old canonical re-derivation summed NET across all parties
    // (advances subtracted), which on real data could collapse AR to ~0
    // and read DSO = 0 days while the tile showed lakhs outstanding.
    const [arRow] = await sequelize.query(`
      SELECT COALESCE(SUM(current_balance), 0)::float AS ar
        FROM parties
       WHERE current_balance > 0
         AND party_type IN ('Customer', 'Both')
         AND COALESCE(is_system_cash, false) = false
    `, { type: sequelize.QueryTypes.SELECT });
    const [apRow] = await sequelize.query(`
      SELECT COALESCE(SUM(ABS(current_balance)), 0)::float AS ap
        FROM parties
       WHERE current_balance < 0
         AND party_type IN ('Supplier', 'Both')
         AND COALESCE(is_system_cash, false) = false
    `, { type: sequelize.QueryTypes.SELECT });
    const ar = Math.max(0, arRow.ar || 0);
    const ap = Math.max(0, apRow.ap || 0);

    // ─── Business velocity (DSO / DPO / DIO / CCC) ─────────────────────
    // Formulae use 90-day windows for stability — short windows make
    // these wildly noisy (a single big bill can swing DSO by 20 days).
    const dso = sales90 > 0 ? Math.round((ar / sales90) * 90) : null;
    const dpo = purch90 > 0 ? Math.round((ap / purch90) * 90) : null;
    const dio = cogs90 > 0 ? Math.round((invValue / cogs90) * 90) : null;
    const ccc = (dso != null && dpo != null && dio != null) ? dio + dso - dpo : null;

    // Annualised inventory turnover — industry benchmark for textile
    // wholesale is ~6×/yr (~60-day DIO). Below 4 = capital frozen on
    // shelves; above 8 = great velocity but stock-out risk.
    const invTurnover = invValue > 0 ? +((cogs90 * 4) / invValue).toFixed(1) : null;

    // ─── Working capital ────────────────────────────────────────────────
    // current_assets    = cash + AR + inventory cost basis
    // current_liabilities = AP + (GST output - GST input)
    // Quick ratio excludes inventory — "can I pay bills without
    // selling stock right now?"
    const [gstRow] = await sequelize.query(`
      SELECT
        COALESCE((SELECT SUM(cgst_amount + sgst_amount + igst_amount + cess_amount)
                    FROM sales_bills WHERE is_cancelled = false
                      AND bill_date >= :monthStart), 0)::float AS gst_out,
        COALESCE((SELECT SUM(cgst_amount + sgst_amount + igst_amount + cess_amount)
                    FROM purchase_bills WHERE is_cancelled = false
                      AND bill_date >= :monthStart), 0)::float AS gst_in
    `, { replacements: { monthStart }, type: sequelize.QueryTypes.SELECT });
    const gstNet = Math.max(0, (gstRow.gst_out || 0) - (gstRow.gst_in || 0));

    const currentAssets = cashPosition + ar + invValue;
    const currentLiabs = ap + gstNet;
    const currentRatio = currentLiabs > 0 ? +(currentAssets / currentLiabs).toFixed(2) : null;
    const quickRatio   = currentLiabs > 0 ? +((cashPosition + ar) / currentLiabs).toFixed(2) : null;

    // ─── Customer concentration (top 5 by revenue last 90 days) ─────────
    // System Cash is EXCLUDED: walk-in counter sales are hundreds of small
    // anonymous buyers, the exact opposite of concentration risk. With it
    // included, a counter-heavy shop showed "Cash 42% · High risk" — the
    // inverse of the truth. Counter sales are reported separately so the
    // panel can still account for 100% of revenue.
    const [top5Cust, [counterRow]] = await Promise.all([
      sequelize.query(`
        SELECT p.party_id, p.party_name,
               COALESCE(SUM(sb.total_amount), 0)::float AS revenue
          FROM sales_bills sb
          JOIN parties p ON p.party_id = sb.customer_id
         WHERE sb.is_cancelled = false
           AND sb.bill_date >= :day90Start
           AND COALESCE(p.is_system_cash, false) = false
         GROUP BY p.party_id, p.party_name
         ORDER BY revenue DESC
         LIMIT 5`,
        { replacements: { day90Start }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`
        SELECT COALESCE(SUM(sb.total_amount), 0)::float AS revenue,
               COUNT(*)::int AS bills
          FROM sales_bills sb
          JOIN parties p ON p.party_id = sb.customer_id
         WHERE sb.is_cancelled = false
           AND sb.bill_date >= :day90Start
           AND COALESCE(p.is_system_cash, false) = true`,
        { replacements: { day90Start }, type: sequelize.QueryTypes.SELECT }),
    ]);

    const totalRev90 = sales90 || 1;
    const top5Sum = top5Cust.reduce((s, c) => s + (c.revenue || 0), 0);
    const concPct = +((top5Sum / totalRev90) * 100).toFixed(1);
    const concRisk = concPct < 30 ? 'low' : concPct < 50 ? 'moderate' : 'high';
    const counterSales = {
      revenue: +parseFloat(counterRow?.revenue || 0).toFixed(2),
      bills: counterRow?.bills || 0,
      pct: +(((counterRow?.revenue || 0) / totalRev90) * 100).toFixed(1),
    };

    // ─── Win-back list — regulars who went silent ────────────────────────
    // Customers with ≥2 bills in the 60–240-day window and NOTHING in the
    // last 60 days. In wholesale this is where revenue quietly leaks: the
    // buyer moved to a competitor and nobody noticed. Ranked by what they
    // used to spend, so the calls happen in value order.
    const winbackCustomers = await sequelize.query(`
      SELECT p.party_id, p.party_name, p.mobile_1,
             MAX(sb.bill_date)::date AS last_bill,
             (CURRENT_DATE - MAX(sb.bill_date))::int AS days_silent,
             COALESCE(SUM(sb.total_amount) FILTER (
               WHERE sb.bill_date >= CURRENT_DATE - INTERVAL '240 days'), 0)::float AS past_revenue,
             COUNT(*) FILTER (
               WHERE sb.bill_date >= CURRENT_DATE - INTERVAL '240 days')::int AS past_bills
        FROM parties p
        JOIN sales_bills sb ON sb.customer_id = p.party_id AND sb.is_cancelled = false
       WHERE p.party_type IN ('Customer','Both')
         AND p.is_active = true
         AND COALESCE(p.is_system_cash, false) = false
       GROUP BY p.party_id, p.party_name, p.mobile_1
      HAVING MAX(sb.bill_date) < CURRENT_DATE - INTERVAL '60 days'
         AND COUNT(*) FILTER (
               WHERE sb.bill_date >= CURRENT_DATE - INTERVAL '240 days'
                 AND sb.bill_date <  CURRENT_DATE - INTERVAL '60 days') >= 2
       ORDER BY past_revenue DESC
       LIMIT 5`,
      { type: sequelize.QueryTypes.SELECT });

    // ─── Per-account cash & bank balances ────────────────────────────────
    // Same ledger basis + reversal-pair exclusion as the headline cash
    // position, broken out per account so the owner sees "SBI ₹X · HDFC ₹Y
    // · Cash ₹Z" at a glance. The rows sum to cash_position by construction.
    const bankBalances = await sequelize.query(`
      SELECT la.ledger_id, la.ledger_name, la.sub_group,
             COALESCE(SUM(le.debit_amount - le.credit_amount), 0)::float AS balance
        FROM ledger_accounts la
        LEFT JOIN ledger_entries le ON le.ledger_id = la.ledger_id
             AND le.reversal_of_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id
             )
       WHERE la.sub_group IN ('Cash-in-Hand','Bank Accounts','Bank OD A/c')
       GROUP BY la.ledger_id, la.ledger_name, la.sub_group
       ORDER BY ABS(COALESCE(SUM(le.debit_amount - le.credit_amount), 0)) DESC
       LIMIT 6`,
      { type: sequelize.QueryTypes.SELECT });

    // ─── Inventory breakdown by velocity ────────────────────────────────
    // Fast/Med/Slow/Dead classification based on 30-day unit sales.
    const invBreakdown = await sequelize.query(`
      WITH velo AS (
        SELECT p.product_id,
               COALESCE(SUM(sbi.quantity), 0)::float AS qty30
          FROM products p
          LEFT JOIN sales_bill_items sbi ON sbi.product_id = p.product_id
          LEFT JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
             AND sb.is_cancelled = false
             AND sb.bill_date >= CURRENT_DATE - INTERVAL '30 days'
         WHERE p.is_active = true AND p.current_stock > 0
         GROUP BY p.product_id
      ),
      moved60 AS (
        SELECT DISTINCT sbi.product_id
          FROM sales_bill_items sbi
          JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
         WHERE sb.is_cancelled = false
           AND sb.bill_date >= CURRENT_DATE - INTERVAL '60 days'
      )
      SELECT
        COUNT(*) FILTER (WHERE v.qty30 / 30.0 >= 10)::int AS fast,
        COUNT(*) FILTER (WHERE v.qty30 / 30.0 >= 3 AND v.qty30 / 30.0 < 10)::int AS med,
        COUNT(*) FILTER (WHERE v.qty30 / 30.0 > 0 AND v.qty30 / 30.0 < 3)::int AS slow_with_movement,
        COUNT(*) FILTER (WHERE v.qty30 = 0 AND v.product_id IN (SELECT product_id FROM moved60))::int AS slow_no_30d,
        COUNT(*) FILTER (WHERE v.qty30 = 0 AND v.product_id NOT IN (SELECT product_id FROM moved60))::int AS dead
      FROM velo v
    `, { type: sequelize.QueryTypes.SELECT });
    const ivb = invBreakdown[0] || {};
    const breakdown = {
      fast: ivb.fast || 0,
      med:  ivb.med  || 0,
      slow: (ivb.slow_with_movement || 0) + (ivb.slow_no_30d || 0),
      dead: ivb.dead || 0,
    };

    // ─── Recommended actions ────────────────────────────────────────────
    // Top 3 actions by estimated cash impact. Each action carries a
    // human label, a ₹ impact estimate, and a deep-link route the
    // frontend can navigate to. The rules engine fires the rules in
    // order; we keep up to 3 firings.
    const actions = computeRecommendedActions({
      ar, ap, cashPosition, invValue,
      sales90, purch90,
      deadSkuCount: breakdown.dead,
      dso, dpo, dio,
    });

    // ─── Top-N customers detail with credit utilisation ─────────────────
    // For each top-5 customer, compute their current outstanding ÷ credit
    // limit so the receivables table can show a "credit used" % column.
    const topCustomersWithCredit = await sequelize.query(`
      SELECT p.party_id, p.party_name, p.gstin, p.mobile_1,
             p.credit_limit::float AS credit_limit,
             p.credit_days::int AS credit_days,
             COALESCE(SUM(sb.balance_amount), 0)::float AS outstanding,
             COUNT(sb.sales_bill_id)::int AS bills,
             MAX(sb.bill_date)::date AS last_bill,
             -- Age from due_date when the bill has one, else from bill_date —
             -- imported bills routinely have NULL due_date, and MAX over all-
             -- NULLs made every row render "Oldest bill · d" with a blank age.
             MAX((CURRENT_DATE - COALESCE(sb.due_date, sb.bill_date))::int) AS oldest_days
        FROM parties p
        LEFT JOIN sales_bills sb ON sb.customer_id = p.party_id
             AND sb.is_cancelled = false AND sb.balance_amount > 0
       WHERE p.party_type IN ('Customer','Both') AND p.is_active = true
       GROUP BY p.party_id, p.party_name, p.gstin, p.mobile_1, p.credit_limit, p.credit_days
      HAVING COALESCE(SUM(sb.balance_amount), 0) > 0
       ORDER BY outstanding DESC
       LIMIT 10
    `, { type: sequelize.QueryTypes.SELECT });

    res.json({
      cash_position: cashPosition,
      cash_runway_days: cashRunway,
      monthly_opex: +(cashRow.opex_mtd || 0).toFixed(2),

      working_capital: {
        current_assets: +currentAssets.toFixed(2),
        current_liabilities: +currentLiabs.toFixed(2),
        net_working_capital: +(currentAssets - currentLiabs).toFixed(2),
        current_ratio: currentRatio,
        quick_ratio: quickRatio,
        breakdown: {
          cash: cashPosition,
          receivables: +ar.toFixed(2),
          inventory: +invValue.toFixed(2),
          payables: +ap.toFixed(2),
          gst_net: +gstNet.toFixed(2),
        },
      },

      business_velocity: { dso, dpo, dio, ccc },

      inventory: {
        value: +invValue.toFixed(2),
        turnover: invTurnover,
        breakdown,
      },

      customer_concentration: {
        pct: concPct,
        risk: concRisk,
        top_n: top5Cust.length,
        total_revenue_90d: +totalRev90.toFixed(2),
        counter_sales: counterSales,
        top: top5Cust.map(c => ({
          party_id: c.party_id,
          party_name: c.party_name,
          revenue: +(c.revenue || 0).toFixed(2),
          pct: +(((c.revenue || 0) / totalRev90) * 100).toFixed(1),
        })),
      },

      winback_customers: winbackCustomers.map(c => ({
        party_id: c.party_id,
        party_name: c.party_name,
        mobile_1: c.mobile_1,
        last_bill: c.last_bill,
        days_silent: c.days_silent,
        past_revenue: +parseFloat(c.past_revenue || 0).toFixed(2),
        past_bills: c.past_bills,
      })),

      bank_balances: bankBalances.map(b => ({
        ledger_id: b.ledger_id,
        ledger_name: b.ledger_name,
        sub_group: b.sub_group,
        balance: +parseFloat(b.balance || 0).toFixed(2),
      })),

      top_overdue_with_credit: topCustomersWithCredit.map(c => ({
        ...c,
        credit_used_pct: c.credit_limit > 0 ? +((c.outstanding / c.credit_limit) * 100).toFixed(0) : null,
      })),

      actions,
    });
  } catch (error) {
    console.error('Dashboard business error:', error);
    respondWithError(res, error);
  }
};

// Rules-based "what should I do today?" recommender. Returns up to 3
// actions, each with:
//   { id, title, impact, impact_label, type, route }
//
// Impact is an estimated ₹ amount the action could free up / generate.
// Frontend renders these in the bottom Insight Bar.
function computeRecommendedActions({ ar, ap, cashPosition, invValue,
                                     sales90, purch90, deadSkuCount,
                                     dso, dpo, dio }) {
  const actions = [];

  // R1: Collect from overdue customers — biggest cash unlock when DSO is high
  if (dso != null && dso > 45 && ar > 50000) {
    const targetDSO = 45;
    const targetAR = (sales90 / 90) * targetDSO;
    const unlock = Math.max(0, ar - targetAR);
    actions.push({
      id: 'collect_overdue',
      title: `Collect from top overdue customers`,
      detail: `Bring DSO from ${dso} to ${targetDSO} days`,
      impact: +unlock.toFixed(0),
      impact_label: `≈ ${formatCompact(unlock)} freed`,
      type: 'cash',
      route: '/reports/aging?party_type=Customer',
    });
  }

  // R2: Liquidate dead stock — recover ~70% of cost basis
  if (deadSkuCount > 0 && invValue > 0) {
    // Estimate dead-stock value as proportional to count (we don't have
    // per-SKU dead value from this slim breakdown; the dashboardInsights
    // endpoint surfaces the precise dead_stock.total_value).
    // Use a conservative 60% recovery on dead inventory.
    const estDeadValue = invValue * Math.min(0.4, deadSkuCount / 200);
    const recovery = +(estDeadValue * 0.6).toFixed(0);
    if (recovery > 5000) {
      actions.push({
        id: 'clear_dead_stock',
        title: `Liquidate ${deadSkuCount} dead SKUs`,
        detail: `60% recovery on stuck capital`,
        impact: recovery,
        impact_label: `≈ ${formatCompact(recovery)} recovered`,
        type: 'cash',
        // Fast/Slow Stock report — /reports/stock was removed; navigating
        // there 404'd the two inventory actions.
        route: '/reports/fast-slow-stock',
      });
    }
  }

  // R3: Stretch payables — paying suppliers too fast wastes working capital
  if (dpo != null && dpo < 30 && purch90 > 0) {
    const targetDPO = 40;
    const dailyPurch = purch90 / 90;
    const freed = +(dailyPurch * (targetDPO - dpo)).toFixed(0);
    if (freed > 1000) {
      actions.push({
        id: 'stretch_payables',
        title: `Stretch payables to ${targetDPO} days`,
        detail: `Currently paying suppliers in ${dpo}d (industry: 40d)`,
        impact: freed,
        impact_label: `≈ ${formatCompact(freed)} working capital`,
        type: 'working_capital',
        route: '/reports/aging?party_type=Supplier',
      });
    }
  }

  // R4: Increase inventory turnover (DIO too high)
  if (dio != null && dio > 90 && invValue > 0) {
    const targetDIO = 60;
    const dailyCOGS = invValue / dio;
    const reduction = +(dailyCOGS * (dio - targetDIO)).toFixed(0);
    if (reduction > 5000) {
      actions.push({
        id: 'reduce_inventory',
        title: `Reduce inventory to ${targetDIO}-day cover`,
        detail: `Capital frozen on shelves for ${dio} days`,
        impact: reduction,
        impact_label: `≈ ${formatCompact(reduction)} freed`,
        type: 'cash',
        // Fast/Slow Stock report — /reports/stock was removed; navigating
        // there 404'd the two inventory actions.
        route: '/reports/fast-slow-stock',
      });
    }
  }

  // Sort by impact descending and keep top 3
  return actions.sort((a, b) => b.impact - a.impact).slice(0, 3);
}

function formatCompact(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
  if (v >= 1e3) return `₹${Math.round(v / 1e3)}K`;
  return `₹${Math.round(v)}`;
}

// Aggregates for the dashboard sparklines + chart tiles. One row per
// bucket — the bucket size is controlled by `interval`:
//
//   interval=day    (default) — one row per calendar day
//   interval=week   — one row per ISO week (Monday-anchored)
//   interval=month  — one row per calendar month
//
// `periods` controls how many trailing buckets to return. The cap varies
// by interval so the response stays bounded:
//
//   day:    7..90        (default 30)
//   week:   4..52        (default 13)
//   month:  3..36        (default 12)
//
// Each row carries the same fields as the daily series — sales,
// purchases, receipts, payments, and gross profit — so the catalog
// builders can switch interval without rewriting their projection
// logic. Gaps are filled via generate_series so a quiet bucket still
// shows up as a 0 instead of being missing.
exports.dashboardSeries = async (req, res) => {
  try {
    // Whitelist the interval — it's interpolated into the SQL string
    // (PostgreSQL doesn't allow parameter binding for INTERVAL strings
    // or date_trunc field names) so we have to vet it here.
    const VALID = { day: { def: 30, min: 7,  max: 90 },
                    week:{ def: 13, min: 4,  max: 52 },
                    month:{def: 12, min: 3,  max: 36 } };
    const interval = VALID[req.query.interval] ? req.query.interval : 'day';
    const cfg = VALID[interval];
    const periods = Math.min(cfg.max, Math.max(cfg.min, parseInt(req.query.periods, 10) || cfg.def));

    // Buckets all live on the truncated start-of-period for clean joins.
    // For weeks PostgreSQL anchors at Monday by default — fine here, the
    // dashboard never displays the underlying date.
    const sql = `
      WITH buckets AS (
        SELECT generate_series(
          date_trunc('${interval}', CURRENT_DATE - (:periods - 1) * INTERVAL '1 ${interval}'),
          date_trunc('${interval}', CURRENT_DATE),
          INTERVAL '1 ${interval}'
        )::date AS d
      ),
      s AS (
        SELECT date_trunc('${interval}', bill_date)::date AS d,
               COALESCE(SUM(total_amount), 0)::float AS sales,
               COALESCE(SUM(total_amount - cgst_amount - sgst_amount - igst_amount - cess_amount), 0)::float AS sales_ex_gst,
               COALESCE(SUM(return_amount), 0)::float AS adjustments,
               COUNT(*)::int AS sales_count
          FROM sales_bills
         WHERE is_cancelled = false
           AND bill_date >= date_trunc('${interval}', CURRENT_DATE - (:periods - 1) * INTERVAL '1 ${interval}')
         GROUP BY date_trunc('${interval}', bill_date)
      ),
      p AS (
        SELECT date_trunc('${interval}', bill_date)::date AS d,
               COALESCE(SUM(total_amount), 0)::float AS purchases,
               COUNT(*)::int AS purchases_count
          FROM purchase_bills
         WHERE is_cancelled = false
           AND bill_date >= date_trunc('${interval}', CURRENT_DATE - (:periods - 1) * INTERVAL '1 ${interval}')
         GROUP BY date_trunc('${interval}', bill_date)
      ),
      cogs AS (
        SELECT date_trunc('${interval}', sb.bill_date)::date AS d,
               COALESCE(SUM(sbi.quantity * sbi.cost_rate), 0)::float AS cogs
          FROM sales_bills sb
          JOIN sales_bill_items sbi ON sbi.sales_bill_id = sb.sales_bill_id
         WHERE sb.is_cancelled = false
           AND sb.bill_date >= date_trunc('${interval}', CURRENT_DATE - (:periods - 1) * INTERVAL '1 ${interval}')
         GROUP BY date_trunc('${interval}', sb.bill_date)
      ),
      r AS (
        SELECT date_trunc('${interval}', transaction_date)::date AS d,
               COALESCE(SUM(total_amount), 0)::float AS receipts
          FROM payments_receipts
         WHERE is_cancelled = false AND transaction_type = 'Receipt'
           AND transaction_date >= date_trunc('${interval}', CURRENT_DATE - (:periods - 1) * INTERVAL '1 ${interval}')
         GROUP BY date_trunc('${interval}', transaction_date)
      ),
      pm AS (
        SELECT date_trunc('${interval}', transaction_date)::date AS d,
               COALESCE(SUM(total_amount), 0)::float AS payments
          FROM payments_receipts
         WHERE is_cancelled = false AND transaction_type = 'Payment'
           AND transaction_date >= date_trunc('${interval}', CURRENT_DATE - (:periods - 1) * INTERVAL '1 ${interval}')
         GROUP BY date_trunc('${interval}', transaction_date)
      )
      SELECT to_char(buckets.d, 'YYYY-MM-DD') AS date,
             COALESCE(s.sales, 0)              AS sales,
             COALESCE(s.sales_count, 0)        AS sales_count,
             COALESCE(p.purchases, 0)          AS purchases,
             COALESCE(p.purchases_count, 0)    AS purchases_count,
             COALESCE(r.receipts, 0)           AS receipts,
             COALESCE(pm.payments, 0)          AS payments,
             COALESCE(s.sales_ex_gst, 0) - COALESCE(cogs.cogs, 0) - COALESCE(s.adjustments, 0) AS profit
        FROM buckets
        LEFT JOIN s    ON s.d    = buckets.d
        LEFT JOIN p    ON p.d    = buckets.d
        LEFT JOIN cogs ON cogs.d = buckets.d
        LEFT JOIN r    ON r.d    = buckets.d
        LEFT JOIN pm   ON pm.d   = buckets.d
       ORDER BY buckets.d
    `;

    const rows = await sequelize.query(sql, {
      replacements: { periods },
      type: sequelize.QueryTypes.SELECT,
    });
    res.json({ interval, periods, series: rows });
  } catch (error) {
    console.error('Dashboard series error:', error);
    respondWithError(res, error);
  }
};

// ── Ledger-vs-register reconciliation helpers ────────────────────────
// Replicates the reconciliation block previously surfaced by the now-
// removed Sales/Purchase Register endpoints. Sales Account Cr (or
// Purchase Account Dr) is posted by the voucher builder as
//   sub_total − discount + other_charges + freight_charges
// (the "Net Sales/Purchase method"). The bill side computes the same
// formula across the filtered rows; mismatch surfaces a banner.
async function ledgerNetWithinPeriod(ledgerName, from, to, voucherTypes) {
  // Audit NEW-HI-2 — optionally scope to specific voucher types so
  // the sales/purchase reconciliation compares like-with-like. Without
  // the filter, a manual JV crediting Sales Account drifts the
  // ledger total above the register total (legit ledger entry, but
  // not bill-derived). The reconciliation banner should only fire
  // when bill→ledger posting drifts; explicit JV adjustments are a
  // separate concern.
  const params = { name: ledgerName, from, to };
  let voucherClause = '';
  if (Array.isArray(voucherTypes) && voucherTypes.length > 0) {
    voucherClause = `AND le.voucher_type IN (:voucherTypes)`;
    params.voucherTypes = voucherTypes;
  }
  const [r] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount), 0)::float  AS dr,
            COALESCE(SUM(le.credit_amount), 0)::float AS cr
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
      WHERE la.ledger_name = :name
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id
        )
        AND le.entry_date BETWEEN :from AND :to
        ${voucherClause}`,
    { replacements: params, type: sequelize.QueryTypes.SELECT },
  );
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  return { dr: r2(r.dr), cr: r2(r.cr) };
}
function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

exports.salesReport = async (req, res) => {
  try {
    const { from_date, to_date, customer_id, payment_status, search } = req.query;
    // Reports allow larger pages (maxLimit 1000) because exports fetch page=1&limit=10000 is common;
    // still capped so an attacker can't request limit=10^9 and hang the worker.
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit, { maxLimit: 1000 });
    const where = { is_cancelled: false };
    scopeWhereByGodown(where, req.user);

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (payment_status) where.payment_status = payment_status;

    // Server-side search across bill_number / total_amount / customer.party_name.
    //
    // Strategy: when a search term is present, we resolve the matching
    // sales_bill_ids upfront with a single raw query (one join, one
    // pass over the index), then inject `sales_bill_id IN (...)` into
    // the existing `where`. This keeps every downstream query (rows,
    // totals, cogs, reconciliation) join-free — they all just see an
    // ID list, no `customer` reference, no Sequelize `subQuery:false`
    // gymnastics. Strips thousand-separator commas so "9,097.20"
    // matches a bill of 9097.20.
    const trimmedSearch = (search || '').toString().trim();
    if (trimmedSearch) {
      const like = `%${trimmedSearch}%`;
      const numericRaw = parseFloat(trimmedSearch.replace(/,/g, ''));
      const numeric = Number.isFinite(numericRaw) ? numericRaw : null;
      const conds = [
        'sb.bill_number ILIKE :like',
        'c.party_name ILIKE :like',
      ];
      if (numeric !== null) conds.push('sb.total_amount = :numeric');
      const idRows = await sequelize.query(
        `SELECT sb.sales_bill_id
           FROM sales_bills sb
           LEFT JOIN parties c ON c.party_id = sb.customer_id
          WHERE (${conds.join(' OR ')})`,
        { replacements: { like, numeric: numeric ?? 0 }, type: sequelize.QueryTypes.SELECT },
      );
      const ids = idRows.map((r) => r.sales_bill_id);
      // Empty IN () is invalid SQL — use a sentinel that matches no
      // rows so the page renders "0 bills" instead of erroring.
      where.sales_bill_id = { [Op.in]: ids.length ? ids : [-1] };
    }

    const { count, rows } = await SalesBill.findAndCountAll({
      where,
      // GSTIN + state + city included so the operational column
      // toggles (GSTR-1 reconciliation, dispatch routing, etc.)
      // have data to show.
      include: [{ model: Party, as: 'customer',
        attributes: ['party_id', 'party_name', 'mobile_1', 'gstin', 'state', 'city', 'credit_days'] }],
      // Computed COGS per bill (Σ qty × cost_rate across line items).
      // cost_rate is the snapshot of products.purchase_rate frozen at
      // bill creation, so historic gross profit stays stable even if
      // the master rate changes later.
      attributes: {
        include: [
          [literal(`(SELECT COALESCE(SUM("quantity" * "cost_rate"), 0) FROM "sales_bill_items" WHERE "sales_bill_items"."sales_bill_id" = "SalesBill"."sales_bill_id")`), 'cogs'],
        ],
      },
      order: [['bill_date', 'DESC']],
      limit,
      offset,
    });

    // Totals — aggregate over the ENTIRE filtered dataset, not just the visible page.
    // The summary bar in the UI depends on these keys:
    //   total_sales / total_amount (gross), total_gst, total_discount, total_paid,
    //   total_balance, total_bills.
    // Previously only total_sales/total_paid/total_pending were returned, so
    // total_gst/total_discount/total_balance rendered as ₹0.
    const totals = await SalesBill.findAll({
      where,
      attributes: [
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total_sales'],
        [fn('COALESCE', fn('SUM', col('sub_total')), 0), 'total_sub'],
        [fn('COALESCE', fn('SUM', col('discount_amount')), 0), 'total_discount'],
        [fn('COALESCE', fn('SUM', col('cgst_amount')), 0), 'total_cgst'],
        [fn('COALESCE', fn('SUM', col('sgst_amount')), 0), 'total_sgst'],
        [fn('COALESCE', fn('SUM', col('igst_amount')), 0), 'total_igst'],
        [fn('COALESCE', fn('SUM', col('cess_amount')), 0), 'total_cess'],
        // CR-10 — derive from total − balance − return so manual receipt
        // allocations are reflected. paid_amount is the at-billing snapshot.
        [literal('COALESCE(SUM(total_amount - balance_amount - COALESCE(return_amount, 0)), 0)'), 'total_paid'],
        [fn('COALESCE', fn('SUM', col('balance_amount')), 0), 'total_pending'],
        [fn('COUNT', col('sales_bill_id')), 'total_bills'],
      ],
      raw: true,
    });

    // COGS aggregate over the same filtered set. Joined SQL query
    // because Sequelize aggregate via include is awkward when the
    // outer where filter is on the parent. Mirrors every filter the
    // findAndCountAll above applies — including the search-derived
    // sales_bill_id IN list, otherwise total_profit would be sub_total
    // (search-scoped) − COGS (full-period), going wildly negative.
    const searchIdsForCogs = trimmedSearch
      ? (where.sales_bill_id?.[Op.in] || [])
      : null;
    const cogsWhereSql = [
      'b.is_cancelled = false',
      from_date && to_date ? 'b.bill_date BETWEEN :from_date AND :to_date' : null,
      customer_id ? 'b.customer_id = :customer_id' : null,
      payment_status ? 'b.payment_status = :payment_status' : null,
      // IN (:array) is the Sequelize-friendly array form; `= ANY(...)`
      // splats the array as bare comma-separated values without the
      // required `ARRAY[...]` wrapper and Postgres rejects it as a
      // syntax error. The empty-list guard upstream already replaced
      // an empty searchIds with the [-1] sentinel, so IN never
      // generates an invalid `IN ()`.
      searchIdsForCogs ? 'b.sales_bill_id IN (:searchIds)' : null,
    ].filter(Boolean).join(' AND ');
    const [cogsRow] = await sequelize.query(
      `SELECT COALESCE(SUM(it.quantity * it.cost_rate), 0)::float AS total_cogs
         FROM sales_bill_items it
         JOIN sales_bills b ON b.sales_bill_id = it.sales_bill_id
        WHERE ${cogsWhereSql}`,
      {
        replacements: {
          from_date, to_date, customer_id, payment_status,
          // IN (:searchIds) needs at least one element; pass [-1]
          // (matches no rows) when there's no search rather than
          // omitting the replacement, which would crash on missing key.
          searchIds: searchIdsForCogs && searchIdsForCogs.length ? searchIdsForCogs : [-1],
        },
        type: sequelize.QueryTypes.SELECT,
      },
    );
    const total_cogs = r2(cogsRow.total_cogs);

    const t0 = totals[0];
    const total_gst = +(parseFloat(t0.total_cgst) + parseFloat(t0.total_sgst) + parseFloat(t0.total_igst) + parseFloat(t0.total_cess)).toFixed(2);
    const total_sub = +parseFloat(t0.total_sub).toFixed(2);
    // Profit = Σ(taxable) − Σ COGS. Margin = profit / taxable × 100.
    // Computed off taxable (sub_total) rather than total_amount so GST
    // doesn't dilute the margin — the operator wants to see the
    // markup over cost, not the markup over cost+tax.
    const total_profit = r2(total_sub - total_cogs);
    const margin_pct = total_sub > 0 ? r2((total_profit / total_sub) * 100) : 0;
    const summary = {
      total_bills:    parseInt(t0.total_bills),
      total_sales:    +parseFloat(t0.total_sales).toFixed(2),
      total_amount:   +parseFloat(t0.total_sales).toFixed(2),       // alias for UI code reading total_amount
      total_sub,
      total_discount: +parseFloat(t0.total_discount).toFixed(2),
      total_cgst:     +parseFloat(t0.total_cgst).toFixed(2),
      total_sgst:     +parseFloat(t0.total_sgst).toFixed(2),
      total_igst:     +parseFloat(t0.total_igst).toFixed(2),
      total_cess:     +parseFloat(t0.total_cess).toFixed(2),
      total_gst,
      total_paid:     +parseFloat(t0.total_paid).toFixed(2),
      total_pending:  +parseFloat(t0.total_pending).toFixed(2),
      total_balance:  +parseFloat(t0.total_pending).toFixed(2),     // alias for UI code reading total_balance
      total_cogs,
      total_profit,
      margin_pct,
    };

    // Ledger reconciliation — only meaningful when filtering by date
    // range AND viewing the full result set. When a search is narrowing
    // results, the bill aggregate would compare apples-to-oranges
    // against the full-period Sales Account ledger — banner falsely
    // triggers. Skip in that case; the next un-searched view restores
    // the correct comparison.
    let reconciliation = null;
    if (from_date && to_date && !trimmedSearch) {
      const reconWhere = { ...where };
      const breakdown = await SalesBill.findAll({
        where: reconWhere,
        attributes: [
          [fn('COALESCE', fn('SUM', col('sub_total')),       0), 'sub'],
          [fn('COALESCE', fn('SUM', col('discount_amount')), 0), 'disc'],
          [fn('COALESCE', fn('SUM', col('other_charges')),   0), 'other'],
          [fn('COALESCE', fn('SUM', col('freight_charges')), 0), 'freight'],
        ],
        raw: true,
      });
      const b = breakdown[0] || {};
      const sub     = r2(b.sub);
      const disc    = r2(b.disc);
      const other   = r2(b.other);
      const freight = r2(b.freight);
      // Audit NEW-HI-2 — read the actual line-level taxable sum, not the
      // header `sub_total - discount_amount`. Pre-fix, `sub_total` is the
      // qty*rate sum BEFORE line-level item discounts, and `discount_amount`
      // is only the BILL-level trade discount. Bills with per-line discount%
      // (driver writes 3% on every 7th bill) had `sub_total` overstating
      // revenue by the line-discount amount → reconciliation banner
      // falsely fired with difference equal to ΣΣ line_discounts.
      // Sales Account ledger credits the post-discount taxable, so we
      // compare apples-to-apples by reading items.taxable_amount directly.
      const itemAgg = await sequelize.query(
        `SELECT COALESCE(SUM(i.taxable_amount),0) AS register_taxable
         FROM sales_bill_items i
         JOIN sales_bills s ON s.sales_bill_id = i.sales_bill_id
         WHERE s.is_cancelled = false
           AND s.bill_date BETWEEN :from_date AND :to_date`,
        { replacements: { from_date, to_date }, type: sequelize.QueryTypes.SELECT },
      );
      const registerTaxableLines = r2(itemAgg[0]?.register_taxable || 0);
      const registerNetToLedger = r2(registerTaxableLines + other + freight);
      const salesLedger = await ledgerNetWithinPeriod('Sales Account', from_date, to_date, ['Sales']);
      const salesNetCr  = r2(salesLedger.cr - salesLedger.dr);
      reconciliation = {
        ledger_name: 'Sales Account',
        ledger_net_credit: salesNetCr,
        register_net_to_ledger: registerNetToLedger,
        register_taxable: registerTaxableLines,
        register_taxable_header: sub,
        register_discount: disc,
        register_freight: freight,
        register_other: other,
        difference: r2(salesNetCr - registerNetToLedger),
        balanced: Math.abs(salesNetCr - registerNetToLedger) < 0.01,
      };
    }

    res.json({ total: count, page, data: rows, summary, reconciliation });
  } catch (error) {
    console.error('Sales report error:', error);
    respondWithError(res, error);
  }
};

/*
 * Sales-by-Salesman report — one row per salesman, aggregated over the
 * filtered period.
 *
 * PURE ATTRIBUTION: this is a read-only roll-up of EXISTING bill figures
 * grouped by the credited salesman. It computes NOTHING new on the money side
 * — every rupee comes straight from the already-saved sales_bills columns. The
 * "indicative commission" is a display convenience (period taxable × the
 * salesman's stored commission %); it is NOT a ledger entry, payout, or
 * anything that touches a bill total.
 *
 * Grouping:
 *   - Bills with a managed salesman_id group under that salesman (label from
 *     the salesmen master, so renames flow through).
 *   - Bills with no salesman_id (legacy free-text or simply unassigned) fall
 *     into a single honest "Unassigned" bucket. We intentionally do NOT try to
 *     reconstruct groups from the free-text salesman_name snapshot — that field
 *     is unreliable; the per-bill snapshot is still visible on the main Sales
 *     Report.
 *
 * Filters mirror the Sales Report: from_date/to_date, optional salesman_id,
 * and the same godown access scoping (a godown-restricted user only sees sales
 * from their reachable godowns).
 */
exports.salesBySalesmanReport = async (req, res) => {
  try {
    const { from_date, to_date, salesman_id } = req.query;

    const conds = ['sb.is_cancelled = false'];
    const repl = {};
    if (from_date && to_date) {
      conds.push('sb.bill_date BETWEEN :from_date AND :to_date');
      repl.from_date = from_date;
      repl.to_date = to_date;
    }
    if (salesman_id) {
      conds.push('sb.salesman_id = :salesman_id');
      repl.salesman_id = parseInt(salesman_id, 10);
    }

    // Apply the same godown scoping the Sales Report uses, but for raw SQL.
    // null => unrestricted; [] => locked out (return empty); [ids] => filter.
    const godownIds = effectiveGodownIds(req.user);
    if (Array.isArray(godownIds)) {
      if (godownIds.length === 0) {
        return res.json({ data: [], summary: emptySalesmanSummary(), from_date, to_date });
      }
      conds.push('sb.godown_id IN (:godownIds)');
      repl.godownIds = godownIds;
    }

    const rows = await sequelize.query(
      `SELECT
         sb.salesman_id,
         CASE WHEN sb.salesman_id IS NULL THEN 'Unassigned'
              ELSE COALESCE(sm.name, 'Salesman #' || sb.salesman_id) END AS salesman_name,
         COALESCE(sm.code, '')                    AS salesman_code,
         COALESCE(sm.commission_percentage, 0)::float AS commission_percentage,
         sm.is_active                             AS salesman_active,
         COUNT(sb.sales_bill_id)::int             AS bill_count,
         COALESCE(SUM(sb.sub_total), 0)::float     AS total_sub,
         COALESCE(SUM(sb.discount_amount), 0)::float AS total_discount,
         COALESCE(SUM(COALESCE(sb.cgst_amount,0) + COALESCE(sb.sgst_amount,0)
                    + COALESCE(sb.igst_amount,0) + COALESCE(sb.cess_amount,0)), 0)::float AS total_gst,
         COALESCE(SUM(sb.total_amount), 0)::float  AS total_amount,
         COALESCE(SUM(sb.total_amount - sb.balance_amount - COALESCE(sb.return_amount, 0)), 0)::float AS total_paid,
         COALESCE(SUM(sb.balance_amount), 0)::float AS total_balance,
         COALESCE(SUM(COALESCE(sb.return_amount, 0)), 0)::float AS total_return,
         COALESCE(SUM(ic.cogs), 0)::float          AS total_cogs
       FROM sales_bills sb
       LEFT JOIN salesmen sm ON sm.salesman_id = sb.salesman_id
       LEFT JOIN (
         SELECT sales_bill_id, SUM(quantity * cost_rate) AS cogs
           FROM sales_bill_items
          GROUP BY sales_bill_id
       ) ic ON ic.sales_bill_id = sb.sales_bill_id
       WHERE ${conds.join(' AND ')}
       GROUP BY sb.salesman_id, sm.name, sm.code, sm.commission_percentage, sm.is_active
       ORDER BY total_amount DESC`,
      { replacements: repl, type: sequelize.QueryTypes.SELECT },
    );

    // Per-row derived fields + running summary. All arithmetic is over numbers
    // already produced by the DB — no re-pricing, no tax recompute.
    const summary = emptySalesmanSummary();
    const data = rows.map((r) => {
      const total_sub = r2(r.total_sub);
      const total_cogs = r2(r.total_cogs);
      const total_profit = r2(total_sub - total_cogs);
      const margin_pct = total_sub > 0 ? r2((total_profit / total_sub) * 100) : 0;
      // Indicative commission only — period taxable × stored %. Never posted.
      const commission_amount = r2(total_sub * (parseFloat(r.commission_percentage) || 0) / 100);

      summary.salesmen_count += 1;
      summary.total_bills    += parseInt(r.bill_count, 10) || 0;
      summary.total_sub      += total_sub;
      summary.total_discount += r2(r.total_discount);
      summary.total_gst      += r2(r.total_gst);
      summary.total_amount   += r2(r.total_amount);
      summary.total_paid     += r2(r.total_paid);
      summary.total_balance  += r2(r.total_balance);
      summary.total_return   += r2(r.total_return);
      summary.total_cogs     += total_cogs;
      summary.total_profit   += total_profit;
      summary.total_commission += commission_amount;

      return {
        salesman_id: r.salesman_id,
        salesman_name: r.salesman_name,
        salesman_code: r.salesman_code,
        salesman_active: r.salesman_active,
        commission_percentage: r2(r.commission_percentage),
        bill_count: parseInt(r.bill_count, 10) || 0,
        total_sub,
        total_discount: r2(r.total_discount),
        total_gst: r2(r.total_gst),
        total_amount: r2(r.total_amount),
        total_paid: r2(r.total_paid),
        total_balance: r2(r.total_balance),
        total_return: r2(r.total_return),
        total_cogs,
        total_profit,
        margin_pct,
        commission_amount,
      };
    });

    // Round the accumulated summary and derive its margin.
    Object.keys(summary).forEach((k) => {
      if (k !== 'salesmen_count' && k !== 'total_bills') summary[k] = r2(summary[k]);
    });
    summary.margin_pct = summary.total_sub > 0
      ? r2((summary.total_profit / summary.total_sub) * 100)
      : 0;

    res.json({ data, summary, from_date, to_date });
  } catch (error) {
    console.error('Sales-by-salesman report error:', error);
    respondWithError(res, error);
  }
};

// Zeroed summary skeleton for the salesman report (also returned on lockout).
function emptySalesmanSummary() {
  return {
    salesmen_count: 0, total_bills: 0, total_sub: 0, total_discount: 0,
    total_gst: 0, total_amount: 0, total_paid: 0, total_balance: 0,
    total_return: 0, total_cogs: 0, total_profit: 0, margin_pct: 0,
    total_commission: 0,
  };
}

exports.purchaseReport = async (req, res) => {
  try {
    const { from_date, to_date, supplier_id, payment_status, search } = req.query;
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit, { maxLimit: 1000 });
    const where = { is_cancelled: false };
    scopeWhereByGodown(where, req.user);

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (supplier_id) where.supplier_id = supplier_id;
    if (payment_status) where.payment_status = payment_status;

    // Server-side search across bill_number / total_amount / supplier.party_name.
    // Pre-resolve matching purchase_bill_ids in one raw query, then inject as
    // an Op.in filter so the totals + reconciliation queries below can apply
    // the search filter without needing to also include the parties join.
    // Same approach used for salesReport.
    const trimmedSearch = (search || '').toString().trim();
    if (trimmedSearch) {
      const like = `%${trimmedSearch}%`;
      const numericRaw = parseFloat(trimmedSearch.replace(/,/g, ''));
      const numeric = Number.isFinite(numericRaw) ? numericRaw : null;
      const conds = [
        'pb.bill_number ILIKE :like',
        's.party_name ILIKE :like',
      ];
      if (numeric !== null) conds.push('pb.total_amount = :numeric');
      const idRows = await sequelize.query(
        `SELECT pb.purchase_bill_id
           FROM purchase_bills pb
           LEFT JOIN parties s ON s.party_id = pb.supplier_id
          WHERE (${conds.join(' OR ')})`,
        { replacements: { like, numeric: numeric ?? 0 }, type: sequelize.QueryTypes.SELECT },
      );
      const ids = idRows.map((r) => r.purchase_bill_id);
      where.purchase_bill_id = { [Op.in]: ids.length ? ids : [-1] };
    }

    const { count, rows } = await PurchaseBill.findAndCountAll({
      where,
      include: [{ model: Party, as: 'supplier',
        attributes: ['party_id', 'party_name', 'mobile_1', 'gstin', 'state', 'city', 'credit_days'] }],
      order: [['bill_date', 'DESC']],
      limit,
      offset,
    });

    // Same expanded summary as salesReport — covers total_gst, total_discount,
    // total_balance keys that the UI summary bar displays.
    const totals = await PurchaseBill.findAll({
      where,
      attributes: [
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total_purchases'],
        [fn('COALESCE', fn('SUM', col('sub_total')), 0), 'total_sub'],
        [fn('COALESCE', fn('SUM', col('discount_amount')), 0), 'total_discount'],
        [fn('COALESCE', fn('SUM', col('cgst_amount')), 0), 'total_cgst'],
        [fn('COALESCE', fn('SUM', col('sgst_amount')), 0), 'total_sgst'],
        [fn('COALESCE', fn('SUM', col('igst_amount')), 0), 'total_igst'],
        [fn('COALESCE', fn('SUM', col('cess_amount')), 0), 'total_cess'],
        // CR-10 — derive from total − balance so manual allocations show.
        [literal('COALESCE(SUM(total_amount - balance_amount), 0)'), 'total_paid'],
        [fn('COALESCE', fn('SUM', col('balance_amount')), 0), 'total_pending'],
        [fn('COUNT', col('purchase_bill_id')), 'total_bills'],
      ],
      raw: true,
    });

    const t0 = totals[0];
    const total_gst = +(parseFloat(t0.total_cgst) + parseFloat(t0.total_sgst) + parseFloat(t0.total_igst) + parseFloat(t0.total_cess)).toFixed(2);
    const summary = {
      total_bills:     parseInt(t0.total_bills),
      total_purchases: +parseFloat(t0.total_purchases).toFixed(2),
      total_amount:    +parseFloat(t0.total_purchases).toFixed(2), // alias for UI code reading total_amount
      total_sub:       +parseFloat(t0.total_sub).toFixed(2),
      total_discount:  +parseFloat(t0.total_discount).toFixed(2),
      total_cgst:      +parseFloat(t0.total_cgst).toFixed(2),
      total_sgst:      +parseFloat(t0.total_sgst).toFixed(2),
      total_igst:      +parseFloat(t0.total_igst).toFixed(2),
      total_cess:      +parseFloat(t0.total_cess).toFixed(2),
      total_gst,
      total_paid:      +parseFloat(t0.total_paid).toFixed(2),
      total_pending:   +parseFloat(t0.total_pending).toFixed(2),
      total_balance:   +parseFloat(t0.total_pending).toFixed(2),   // alias for UI code reading total_balance
    };

    // Ledger reconciliation — Purchase Account Dr (period) should equal
    // the same Net-Purchase formula as the voucher builder uses. Skip
    // when a search is narrowing the result set: comparing a
    // search-scoped bill aggregate against the full-period Purchase
    // Account ledger would falsely trigger the drift banner.
    let reconciliation = null;
    if (from_date && to_date && !trimmedSearch) {
      const reconWhere = { ...where };
      const breakdown = await PurchaseBill.findAll({
        where: reconWhere,
        attributes: [
          [fn('COALESCE', fn('SUM', col('sub_total')),       0), 'sub'],
          [fn('COALESCE', fn('SUM', col('discount_amount')), 0), 'disc'],
          [fn('COALESCE', fn('SUM', col('other_charges')),   0), 'other'],
          [fn('COALESCE', fn('SUM', col('freight_charges')), 0), 'freight'],
        ],
        raw: true,
      });
      const b = breakdown[0] || {};
      const sub     = r2(b.sub);
      const disc    = r2(b.disc);
      const other   = r2(b.other);
      const freight = r2(b.freight);
      // Audit NEW-HI-2 — mirror salesReport fix. Use items.taxable_amount
      // sum, not header sub_total minus bill discount, to correctly
      // include line-level item discounts in the reconciliation.
      const itemAgg = await sequelize.query(
        `SELECT COALESCE(SUM(i.taxable_amount),0) AS register_taxable
         FROM purchase_bill_items i
         JOIN purchase_bills s ON s.purchase_bill_id = i.purchase_bill_id
         WHERE s.is_cancelled = false
           AND s.bill_date BETWEEN :from_date AND :to_date`,
        { replacements: { from_date, to_date }, type: sequelize.QueryTypes.SELECT },
      );
      const registerTaxableLines = r2(itemAgg[0]?.register_taxable || 0);
      const registerNetToLedger = r2(registerTaxableLines + other + freight);
      const purLedger = await ledgerNetWithinPeriod('Purchase Account', from_date, to_date, ['Purchase']);
      const purNetDr  = r2(purLedger.dr - purLedger.cr);
      reconciliation = {
        ledger_name: 'Purchase Account',
        ledger_net_debit: purNetDr,
        register_net_to_ledger: registerNetToLedger,
        register_taxable: registerTaxableLines,
        register_taxable_header: sub,
        register_discount: disc,
        register_freight: freight,
        register_other: other,
        difference: r2(purNetDr - registerNetToLedger),
        balanced: Math.abs(purNetDr - registerNetToLedger) < 0.01,
      };
    }

    res.json({ total: count, page, data: rows, summary, reconciliation });
  } catch (error) {
    respondWithError(res, error);
  }
};

exports.stockReport = async (req, res) => {
  try {
    const { category_id, stock_status, search,
            sort_by = 'product_name', sort_dir = 'ASC' } = req.query;
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit, {
      defaultLimit: 100,
      maxLimit: 1000,
    });

    const safeDir = sort_dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    // Godown filter: when set, current_stock/opening_stock are sourced from
    // product_godown_stock for that godown. When NULL, the products table's
    // denormalized totals (sum across all godowns) are used.
    const godownId = req.query.godown_id ? parseInt(req.query.godown_id) : null;

    // Party filter — "show only items purchased from this supplier". Links
    // products → purchase_bill_items → purchase_bills.supplier_id. Applied
    // as a correlated EXISTS so it composes with category/status/search and
    // with both the godown and non-godown stock sources without altering
    // any other query's shape. parseInt makes it injection-safe to inline
    // into the Sequelize literal below (which can't take a bind param).
    const partyId = req.query.party_id ? parseInt(req.query.party_id) : null;
    const partyId_safe = Number.isFinite(partyId) ? partyId : null;

    // Period for Inward / Outward — accepts an explicit `period_from`/
    // `period_to` from the client. Default is ALL-TIME (no date floor)
    // so the columns show every movement ever recorded unless the user
    // narrows the range. We use a far-past sentinel rather than no WHERE
    // because the query keeps a single shape.
    const periodFrom = (req.query.period_from || req.query.from_date || '1900-01-01').slice(0, 10);
    const periodTo   = (req.query.period_to   || req.query.to_date   || new Date().toISOString().slice(0, 10)).slice(0, 10);

    // Status filters: when godown_id is set we can't push these into the
    // Sequelize WHERE because the values come from product_godown_stock.
    // We apply them in a post-fetch filter then. Without godown, push down.
    const where = { is_active: true };
    if (category_id) where.category_id = category_id;
    if (!godownId) {
      if (stock_status === 'ok')  where.current_stock = { [Op.gt]: 0 };
      if (stock_status === 'low') {
        where.minimum_stock_level = { [Op.gt]: 0 };
        where.current_stock = { [Op.lte]: col('minimum_stock_level') };
      }
      if (stock_status === 'out') where.current_stock = { [Op.lte]: 0 };
      if (stock_status === 'neg') where.current_stock = { [Op.lt]: 0 };
    }
    if (search) {
      // Audit P3-D — escape LIKE wildcards.
      const s = escapeLike(search);
      where[Op.or] = [
        { product_name:   { [Op.iLike]: `%${s}%` } },
        { barcode:        { [Op.iLike]: `%${s}%` } },
        { article_number: { [Op.iLike]: `%${s}%` } },
        // Category name match. The Category include is added below; the
        // $assoc.column$ syntax tells Sequelize to qualify against that
        // join (subQuery: false is set on the include so the WHERE pushes
        // into the outer query).
        { '$Category.category_name$': { [Op.iLike]: `%${s}%` } },
      ];
    }
    // Restrict to products purchased from the chosen party (supplier).
    if (partyId_safe) {
      where[Op.and] = [
        ...(where[Op.and] || []),
        literal(`EXISTS (SELECT 1 FROM purchase_bill_items pbi
          JOIN purchase_bills pb ON pb.purchase_bill_id = pbi.purchase_bill_id
          WHERE pbi.product_id = "Product"."product_id"
            AND pb.supplier_id = ${partyId_safe}
            AND pb.is_cancelled = false)`),
      ];
    }

    // Dynamic sort order (whitelisted)
    //
    // stock_value sort key is mode-aware (audit Hotspot C). Variant +
    // single-no-batch sort EXACTLY by their per-mode cost basis. Single+
    // batch products fall back to purchase_rate for sort positioning —
    // approximate but defensible (their true value sums per-batch and
    // can't be inlined into ORDER BY without a costly per-row JOIN).
    // Operators sorting by "highest stock value" still see the right
    // ordering for the dominant variant + single-no-batch population.
    const SORT_ORDERS = {
      product_name:  [['product_name', safeDir]],
      category_name: [[Category, 'category_name', safeDir], ['product_name', 'ASC']],
      current_stock: [['current_stock', safeDir], ['product_name', 'ASC']],
      purchase_rate: [['purchase_rate', safeDir], ['product_name', 'ASC']],
      sale_rate:     [['sale_rate', safeDir], ['product_name', 'ASC']],
      stock_value:   [[literal(`"Product"."current_stock" * (CASE
        WHEN "Product"."product_mode" = 'single' AND "Product"."is_batch_tracked" = false
          THEN COALESCE("Product"."weighted_avg_cost", "Product"."purchase_rate", 0)
        ELSE "Product"."purchase_rate"
      END)`), safeDir], ['product_name', 'ASC']],
    };
    const orderClause = SORT_ORDERS[sort_by] || SORT_ORDERS['product_name'];

    // Base WHERE for raw queries — status is appended via rawStatusFrag
    // below (so godown / non-godown paths can express it differently).
    const rawWhere = ['p.is_active = true'];
    const rawRepl  = {};
    if (category_id) { rawWhere.push('p.category_id = :category_id'); rawRepl.category_id = parseInt(category_id); }
    if (search) {
      rawWhere.push(`(
        p.product_name   ILIKE :search
        OR p.barcode     ILIKE :search
        OR p.article_number ILIKE :search
        OR EXISTS (SELECT 1 FROM categories c2 WHERE c2.category_id = p.category_id AND c2.category_name ILIKE :search)
      )`);
      rawRepl.search = `%${search}%`;
    }
    // Same party (purchased-from) restriction for the raw aggregate
    // queries — summary KPIs, period inward/outward, and the category
    // breakdown all build off rawWhere, so adding it here keeps every
    // total tied to exactly the rows the user sees.
    if (partyId_safe) {
      rawWhere.push(`EXISTS (SELECT 1 FROM purchase_bill_items pbi
        JOIN purchase_bills pb ON pb.purchase_bill_id = pbi.purchase_bill_id
        WHERE pbi.product_id = p.product_id
          AND pb.supplier_id = :party_id
          AND pb.is_cancelled = false)`);
      rawRepl.party_id = partyId_safe;
    }

    // Page-of-products query. Godown variant attaches the per-godown
    // row via the `godownStock` association so we can swap stock values
    // post-fetch — keeps Sequelize sort/page semantics intact.
    //
    // Category include is `required: false` (LEFT JOIN) so the
    // $Category.category_name$ search filter doesn't drop uncategorised
    // products from the rest of the report.
    const productInclude = [{ model: Category, attributes: ['category_name'], required: false }];
    if (godownId) {
      productInclude.push({
        model: ProductGodownStock,
        as: 'godownStock',
        where: { godown_id: godownId },
        required: false,
        attributes: ['current_stock', 'opening_stock'],
      });
    }

    // Build summary + category-breakdown SQL fragments. Stock fields swap
    // to product_godown_stock when a godown is selected, so totals match
    // what the user sees row-by-row.
    const stkExpr  = godownId ? 'COALESCE(pgs.current_stock, 0)' : 'p.current_stock';
    const openExpr = godownId ? 'COALESCE(pgs.opening_stock, 0)' : 'p.opening_stock';
    const stkJoin  = godownId
      ? `LEFT JOIN product_godown_stock pgs ON pgs.product_id = p.product_id AND pgs.godown_id = :godown_id`
      : '';

    // Status filter pushed into raw queries. Mirrors the Sequelize where
    // for the no-godown path; uses pgs.* values for the godown path.
    const rawStatusFrag = (() => {
      if (stock_status === 'ok')  return `AND ${stkExpr} > 0`;
      if (stock_status === 'low') return `AND p.minimum_stock_level > 0 AND ${stkExpr} > 0 AND ${stkExpr} <= p.minimum_stock_level`;
      if (stock_status === 'out') return `AND ${stkExpr} = 0`;
      if (stock_status === 'neg') return `AND ${stkExpr} < 0`;
      return '';
    })();

    const summaryRepl = { ...rawRepl };
    if (godownId) summaryRepl.godown_id = godownId;
    summaryRepl.from = periodFrom;
    summaryRepl.to   = periodTo;

    // Mode-aware cost basis used in the SUM expressions below (audit
    // Hotspot B + the negative_value variant). Variant + single-no-
    // batch resolve inside the SQL CASE for a single-pass aggregate.
    // Single+batch products contribute 0 here; their value is added
    // post-query via fetchBatchAggregate / fetchBatchAggregateByGodown
    // (depending on whether the report is godown-filtered).
    const costExpr = `(CASE
      WHEN p.product_mode = 'single' AND p.is_batch_tracked = false
        THEN COALESCE(p.weighted_avg_cost, p.purchase_rate, 0)
      WHEN p.product_mode = 'single' AND p.is_batch_tracked = true
        THEN 0
      ELSE p.purchase_rate
    END)`;

    const summarySql = `
      SELECT
        COUNT(*)::int                                          AS total_items,
        COALESCE(SUM(${stkExpr} * ${costExpr}), 0)::float      AS partial_purchase_value,
        COALESCE(SUM(${stkExpr} * p.sale_rate), 0)::float      AS total_sale_value,
        COALESCE(SUM(${openExpr}),                  0)::float  AS total_opening,
        COALESCE(SUM(${stkExpr}),                   0)::float  AS total_current_stock,
        COUNT(*) FILTER (WHERE ${stkExpr} < 0)::int            AS negative_count,
        COUNT(*) FILTER (WHERE ${stkExpr} = 0)::int            AS out_count,
        COUNT(*) FILTER (WHERE p.minimum_stock_level > 0 AND ${stkExpr} > 0 AND ${stkExpr} <= p.minimum_stock_level)::int AS low_count,
        COALESCE(SUM(CASE WHEN ${stkExpr} < 0 THEN ${stkExpr}                  ELSE 0 END), 0)::float AS negative_units,
        COALESCE(SUM(CASE WHEN ${stkExpr} < 0 THEN ${stkExpr} * ${costExpr}    ELSE 0 END), 0)::float AS negative_value
      FROM products p
      ${stkJoin}
      WHERE ${rawWhere.join(' AND ')} ${rawStatusFrag}
    `;

    // Period inward / outward totals — sum from stock_ledger, joined
    // to the SAME filtered product set so the period totals match the
    // visible rows.
    const periodTotalsSql = `
      WITH filtered AS (
        SELECT p.product_id
          FROM products p
          ${stkJoin}
         WHERE ${rawWhere.join(' AND ')} ${rawStatusFrag}
      )
      SELECT
        COALESCE(SUM(quantity_in),  0)::float AS total_inward,
        COALESCE(SUM(quantity_out), 0)::float AS total_outward
      FROM stock_ledger sl
      WHERE sl.product_id IN (SELECT product_id FROM filtered)
        AND sl.transaction_date BETWEEN :from AND :to
        ${godownId ? 'AND sl.godown_id = :godown_id' : ''}
    `;

    // Category breakdown — same mode-aware cost expression. Per-
    // category stock_value covers variant + single-no-batch in SQL;
    // batch contribution is added in JS (per category) below.
    const categoryBreakdownSql = `
      SELECT p.category_id, c.category_name,
        COUNT(p.product_id)::int                                  AS item_count,
        COALESCE(SUM(${stkExpr} * ${costExpr}), 0)::float         AS stock_value
      FROM products p
      ${stkJoin}
      LEFT JOIN categories c ON c.category_id = p.category_id
      WHERE ${rawWhere.join(' AND ')} ${rawStatusFrag}
      GROUP BY p.category_id, c.category_name
      ORDER BY c.category_name ASC NULLS LAST
    `;

    // Run the page query, summary, period totals, and category breakdown
    // in parallel. Per-row inward/outward come after we know the page IDs.
    const [products, [summaryRow], [periodRow], categoryBreakdown] = await Promise.all([
      Product.findAll({
        where,
        include: productInclude,
        order: orderClause,
        limit,
        offset,
        // subQuery: false — push the WHERE into the outer SELECT so the
        // $Category.category_name$ filter resolves against the JOINed
        // table (and so LIMIT/OFFSET are applied AFTER the join, matching
        // total count from the summary aggregate).
        subQuery: false,
      }),
      sequelize.query(summarySql,        { replacements: summaryRepl, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(periodTotalsSql,   { replacements: summaryRepl, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(categoryBreakdownSql, { replacements: summaryRepl, type: sequelize.QueryTypes.SELECT }),
    ]);

    // For godown filter: low/out/neg push-down isn't possible at the
    // Sequelize layer (the values live on the join), so re-filter the
    // page rows here. Counts are already correct in `summaryRow`.
    let pageProducts = products;
    if (godownId && ['ok', 'low', 'out', 'neg'].includes(stock_status)) {
      const pickStock = (p) => {
        const g = p.godownStock?.[0];
        return g ? parseFloat(g.current_stock) : 0;
      };
      pageProducts = products.filter((p) => {
        const s   = pickStock(p);
        const min = parseFloat(p.minimum_stock_level || 0);
        if (stock_status === 'ok')  return s > 0;
        if (stock_status === 'low') return min > 0 && s > 0 && s <= min;
        if (stock_status === 'out') return s === 0;
        if (stock_status === 'neg') return s < 0;
        return true;
      });
    }

    // Override per-product current_stock / opening_stock for godown
    // filter so the listing matches the godown view.
    if (godownId) {
      for (const p of pageProducts) {
        const g = p.godownStock?.[0];
        p.dataValues.current_stock = g ? parseFloat(g.current_stock) : 0;
        p.dataValues.opening_stock = g ? parseFloat(g.opening_stock) : 0;
      }
    }

    // Per-row inward / outward over the period. One aggregate query for
    // the page IDs; cheap (<= limit rows × stock_ledger group-by).
    if (pageProducts.length > 0) {
      const pageIds = pageProducts.map(p => p.product_id);
      const movRows = await sequelize.query(`
        SELECT product_id,
               COALESCE(SUM(quantity_in),  0)::float AS qty_in,
               COALESCE(SUM(quantity_out), 0)::float AS qty_out
          FROM stock_ledger
         WHERE product_id IN (:ids)
           AND transaction_date BETWEEN :from AND :to
           ${godownId ? 'AND godown_id = :godown_id' : ''}
         GROUP BY product_id
      `, {
        replacements: { ids: pageIds, from: periodFrom, to: periodTo, ...(godownId ? { godown_id: godownId } : {}) },
        type: sequelize.QueryTypes.SELECT,
      });
      const movMap = new Map(movRows.map(r => [r.product_id, r]));
      for (const p of pageProducts) {
        const m = movMap.get(p.product_id);
        p.dataValues.inward_qty  = m ? +m.qty_in.toFixed(2)  : 0;
        p.dataValues.outward_qty = m ? +m.qty_out.toFixed(2) : 0;
      }
    }

    // Batch contribution to total_purchase_value + category breakdown.
    // Single+batch products contributed 0 in the SQL CASE above; their
    // value lives on product_batches.purchase_rate, not the master row.
    // Pull the filtered set's batch products + their category, then
    // fetch per-product (or per-godown-product) batch aggregates and
    // distribute into category buckets.
    const batchProductsInScope = await sequelize.query(
      `SELECT p.product_id, p.category_id
         FROM products p
         ${stkJoin}
        WHERE ${rawWhere.join(' AND ')} ${rawStatusFrag}
          AND p.product_mode = 'single' AND p.is_batch_tracked = true`,
      { replacements: summaryRepl, type: sequelize.QueryTypes.SELECT },
    );
    const batchPids = batchProductsInScope.map(r => r.product_id);
    const { fetchBatchAggregateByGodown } = require('../utils/displayCost');
    let batchValueByProduct = new Map();
    if (godownId) {
      const aggByGodown = await fetchBatchAggregateByGodown(batchPids);
      for (const pid of batchPids) {
        const entry = aggByGodown.get(`${pid}:${godownId}`);
        if (entry) batchValueByProduct.set(pid, entry.total_value);
      }
    } else {
      const agg = await fetchBatchAggregate(batchPids);
      for (const [pid, v] of agg) batchValueByProduct.set(pid, v.total_value);
    }
    const batchPurchaseValue = Array.from(batchValueByProduct.values())
      .reduce((s, v) => s + (v || 0), 0);
    // Distribute batch value into category buckets so the breakdown ties
    // back to the summary total. category_id → SUM(batch_value).
    const batchValueByCategory = new Map();
    for (const r of batchProductsInScope) {
      const v = batchValueByProduct.get(r.product_id) || 0;
      if (v === 0) continue;
      batchValueByCategory.set(r.category_id, (batchValueByCategory.get(r.category_id) || 0) + v);
    }
    const enrichedBreakdown = categoryBreakdown.map(c => ({
      ...c,
      stock_value: +(parseFloat(c.stock_value || 0) + (batchValueByCategory.get(c.category_id) || 0)).toFixed(2),
    }));

    const totalPV = parseFloat(summaryRow.partial_purchase_value || 0) + batchPurchaseValue;
    const totalSV = parseFloat(summaryRow.total_sale_value || 0);

    // Attach mode-aware display_cost + display_stock_value to each row so
    // the page columns (margin %, stock value) compute against the right
    // basis — variant: purchase_rate, single: weighted_avg_cost, single+
    // batch: SUM(qty × batch.rate). Without this the frontend falls back
    // to current_stock × purchase_rate, which understates batch stock and
    // mis-states single-mode rows once their wac diverges from the master
    // purchase_rate.
    //
    // For godown-filtered views, single+batch rows use the per-godown
    // batch aggregate already fetched above (batchValueByProduct). This
    // keeps display_stock_value consistent with the per-godown
    // current_stock that was swapped onto the row at line ~875. attach-
    // DisplayCost itself reads cross-godown batch totals, so we override
    // for godown+batch rows.
    const baseRows = pageProducts.map((p) => (typeof p.toJSON === 'function' ? p.toJSON() : p));
    const enrichedRows = await attachDisplayCost(baseRows);
    if (godownId) {
      for (const r of enrichedRows) {
        if (r.product_mode === 'single' && r.is_batch_tracked) {
          const tv = batchValueByProduct.get(r.product_id) || 0;
          const tq = parseFloat(r.current_stock || 0);
          r.display_stock_value = +tv.toFixed(2);
          r.display_cost = tq > 0 ? +(tv / tq).toFixed(4) : 0;
        }
      }
    }

    res.json({
      data: enrichedRows,
      total: parseInt(summaryRow.total_items || 0),
      summary: {
        total_items:          parseInt(summaryRow.total_items || 0),
        total_purchase_value: +totalPV.toFixed(2),
        total_sale_value:     +totalSV.toFixed(2),
        potential_profit:     +(totalSV - totalPV).toFixed(2),
        total_opening:        +parseFloat(summaryRow.total_opening || 0).toFixed(2),
        total_current_stock:  +parseFloat(summaryRow.total_current_stock || 0).toFixed(2),
        total_inward:         +parseFloat(periodRow.total_inward || 0).toFixed(2),
        total_outward:        +parseFloat(periodRow.total_outward || 0).toFixed(2),
        negative_count:       parseInt(summaryRow.negative_count || 0),
        out_count:            parseInt(summaryRow.out_count || 0),
        low_count:            parseInt(summaryRow.low_count || 0),
        negative_units:       +parseFloat(summaryRow.negative_units || 0).toFixed(2),
        negative_value:       +parseFloat(summaryRow.negative_value || 0).toFixed(2),
        period: { from: periodFrom, to: periodTo },
        godown_id:            godownId,
      },
      category_breakdown: enrichedBreakdown,
    });
  } catch (error) {
    console.error('Stock report error:', error);
    respondWithError(res, error);
  }
};

// Profit & Loss moved to financialReportsController.profitLoss — now
// sourced from ledger_entries (single source of truth) with full
// classic accounting-style structure (Opening Stock, Net Purchases/Sales with
// Returns netting, Direct/Indirect splits, balancing GP/NP figures).
// The legacy implementation here read sales_bills/purchase_bills,
// bypassing the journal — manual JVs and opening balances were
// invisible to the report.

exports.partyOutstanding = async (req, res) => {
  try {
    const { party_type } = req.query;

    // Per-party balance = the maintained `parties.current_balance` ledger
    // column — the SAME source the Dashboard tiles and the Customers/Suppliers
    // list totals use (see dashboardStats above), so all three agree.
    //
    // This replaces an earlier bill-derived formula (opening + Σ(total−paid)
    // − non-auto receipts). That formula silently broke on imported data:
    // purchase bills there carry paid_amount = 0 with the real dues living in
    // balance_amount / the ledger, so Σ(total−paid) overstated every supplier
    // and the net flipped sign — collapsing all real creditors and parking a
    // phantom payable on the system "Cash" party (whose cash-payment vouchers
    // the formula misread as money owed). current_balance is kept correct by
    // the posting service, matches the per-party ledger (Sundry Debtors /
    // Creditors), and needs no recomputation here.
    const buildQuery = (mode) => {
      const partyTypes = mode === 'Customer' ? `'Customer','Both'` : `'Supplier','Both'`;
      return `
        SELECT p.party_id, p.party_name, p.party_type, p.mobile_1,
               p.credit_limit, p.credit_days,
               COALESCE(p.current_balance, 0)::float AS current_balance
        FROM parties p
        WHERE p.party_type IN (${partyTypes})
      `;
    };

    let parties;
    if (party_type === 'Customer') {
      parties = await sequelize.query(
        `SELECT * FROM (${buildQuery('Customer')}) x WHERE current_balance > 0
         ORDER BY ABS(current_balance) DESC`,
        { type: sequelize.QueryTypes.SELECT }
      );
    } else if (party_type === 'Supplier') {
      parties = await sequelize.query(
        `SELECT * FROM (${buildQuery('Supplier')}) x WHERE current_balance < 0
         ORDER BY ABS(current_balance) DESC`,
        { type: sequelize.QueryTypes.SELECT }
      );
    } else {
      // No filter — return both sides, customers first.
      const [cust, sup] = await Promise.all([
        sequelize.query(
          `SELECT * FROM (${buildQuery('Customer')}) x WHERE current_balance != 0
           ORDER BY ABS(current_balance) DESC`,
          { type: sequelize.QueryTypes.SELECT }
        ),
        sequelize.query(
          `SELECT * FROM (${buildQuery('Supplier')}) x WHERE current_balance != 0
           ORDER BY ABS(current_balance) DESC`,
          { type: sequelize.QueryTypes.SELECT }
        ),
      ]);
      parties = [...cust, ...sup];
    }

    const total = parties.reduce((sum, p) => sum + Math.abs(parseFloat(p.current_balance || 0)), 0);
    res.json({ data: parties, total: +total.toFixed(2) });
  } catch (error) {
    console.error('Party outstanding error:', error);
    respondWithError(res, error);
  }
};

// =========================================================================
// REPORT EXPORT ENDPOINTS — stream XLSX of the full filtered result set.
// The old /api/data/export/sales dump gave the same "all sales ever" workbook
// regardless of what the Sales Report page was showing, which was useless for
// real reporting (e.g., "send this month's ₹-payable customers to the GM").
// These endpoints read the SAME filter params as the on-screen report queries,
// apply them identically, and stream the full dataset (no pagination limit).
// =========================================================================
const ExcelJS = require('exceljs');

const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';
const toMoney = (v) => parseFloat(v || 0);

function _sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return wb.xlsx.write(res).then(() => res.end());
}

exports.exportSalesReport = async (req, res) => {
  try {
    // Audit C1 — pre-fix this destructure ignored `search`, so the export
    // produced every bill in the date range while the screen showed only
    // the search-filtered subset. Mirror the salesReport() filter set.
    const { from_date, to_date, customer_id, payment_status, search } = req.query;
    const where = { is_cancelled: false };
    scopeWhereByGodown(where, req.user);
    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (payment_status) where.payment_status = payment_status;

    // Same search-to-IDs resolution as salesReport() so the export's filter
    // set is always identical to the on-screen one.
    const trimmedSearch = (search || '').toString().trim();
    if (trimmedSearch) {
      const like = `%${trimmedSearch}%`;
      const numericRaw = parseFloat(trimmedSearch.replace(/,/g, ''));
      const numeric = Number.isFinite(numericRaw) ? numericRaw : null;
      const conds = [
        'sb.bill_number ILIKE :like',
        'c.party_name ILIKE :like',
      ];
      if (numeric !== null) conds.push('sb.total_amount = :numeric');
      const idRows = await sequelize.query(
        `SELECT sb.sales_bill_id
           FROM sales_bills sb
           LEFT JOIN parties c ON c.party_id = sb.customer_id
          WHERE (${conds.join(' OR ')})`,
        { replacements: { like, numeric: numeric ?? 0 }, type: sequelize.QueryTypes.SELECT },
      );
      const ids = idRows.map((r) => r.sales_bill_id);
      where.sales_bill_id = { [Op.in]: ids.length ? ids : [-1] };
    }

    const rows = await SalesBill.findAll({
      where,
      include: [{ model: Party, as: 'customer', attributes: ['party_name', 'mobile_1'] }],
      order: [['bill_date', 'DESC'], ['sales_bill_id', 'DESC']],
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sales Report');
    ws.columns = [
      { header: 'Bill No',   key: 'bill_number',     width: 18 },
      { header: 'Date',      key: 'bill_date',       width: 12 },
      { header: 'Customer',  key: 'customer',        width: 28 },
      { header: 'Mobile',    key: 'mobile',          width: 14 },
      { header: 'Items',     key: 'total_items',     width: 8  },
      { header: 'Sub Total', key: 'sub_total',       width: 14 },
      { header: 'Discount',  key: 'discount_amount', width: 12 },
      { header: 'CGST',      key: 'cgst_amount',     width: 10 },
      { header: 'SGST',      key: 'sgst_amount',     width: 10 },
      { header: 'IGST',      key: 'igst_amount',     width: 10 },
      { header: 'Cess',      key: 'cess_amount',     width: 10 },
      { header: 'Total',     key: 'total_amount',    width: 14 },
      { header: 'Paid',      key: 'paid_amount',     width: 12 },
      { header: 'Balance',   key: 'balance_amount',  width: 12 },
      { header: 'Status',    key: 'payment_status',  width: 10 },
    ];
    ws.getRow(1).font = { bold: true };

    rows.forEach(r => ws.addRow({
      bill_number: r.bill_number,
      bill_date: fmtDate(r.bill_date),
      customer: r.customer?.party_name || 'Cash Sale',
      mobile: r.customer?.mobile_1 || '',
      total_items: r.total_items,
      sub_total: toMoney(r.sub_total),
      discount_amount: toMoney(r.discount_amount),
      cgst_amount: toMoney(r.cgst_amount),
      sgst_amount: toMoney(r.sgst_amount),
      igst_amount: toMoney(r.igst_amount),
      cess_amount: toMoney(r.cess_amount),
      total_amount: toMoney(r.total_amount),
      paid_amount: toMoney(r.paid_amount),
      balance_amount: toMoney(r.balance_amount),
      payment_status: r.payment_status,
    }));

    // Totals row. Audit C2 — round each summed value to 2dp so a 500-bill
    // export doesn't display 12,34,567.1999999... while the on-screen
    // summary (server-aggregated, already rounded) shows 12,34,567.20.
    if (rows.length) {
      const sumRound = (key) => +(rows.reduce((s, r) => s + toMoney(r[key]), 0)).toFixed(2);
      const totalRow = ws.addRow({
        bill_number: `TOTAL (${rows.length})`,
        sub_total:       sumRound('sub_total'),
        discount_amount: sumRound('discount_amount'),
        cgst_amount:     sumRound('cgst_amount'),
        sgst_amount:     sumRound('sgst_amount'),
        igst_amount:     sumRound('igst_amount'),
        cess_amount:     sumRound('cess_amount'),
        total_amount:    sumRound('total_amount'),
        paid_amount:     sumRound('paid_amount'),
        balance_amount:  sumRound('balance_amount'),
      });
      totalRow.font = { bold: true };
    }

    return _sendWorkbook(res, wb, `sales_report_${from_date || 'all'}_to_${to_date || 'now'}.xlsx`);
  } catch (err) {
    console.error('Sales export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.exportPurchaseReport = async (req, res) => {
  try {
    // Audit C1 — same search-filter parity fix as exportSalesReport.
    const { from_date, to_date, supplier_id, payment_status, search } = req.query;
    const where = { is_cancelled: false };
    scopeWhereByGodown(where, req.user);
    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (supplier_id) where.supplier_id = supplier_id;
    if (payment_status) where.payment_status = payment_status;

    const trimmedSearch = (search || '').toString().trim();
    if (trimmedSearch) {
      const like = `%${trimmedSearch}%`;
      const numericRaw = parseFloat(trimmedSearch.replace(/,/g, ''));
      const numeric = Number.isFinite(numericRaw) ? numericRaw : null;
      const conds = [
        'pb.bill_number ILIKE :like',
        's.party_name ILIKE :like',
      ];
      if (numeric !== null) conds.push('pb.total_amount = :numeric');
      const idRows = await sequelize.query(
        `SELECT pb.purchase_bill_id
           FROM purchase_bills pb
           LEFT JOIN parties s ON s.party_id = pb.supplier_id
          WHERE (${conds.join(' OR ')})`,
        { replacements: { like, numeric: numeric ?? 0 }, type: sequelize.QueryTypes.SELECT },
      );
      const ids = idRows.map((r) => r.purchase_bill_id);
      where.purchase_bill_id = { [Op.in]: ids.length ? ids : [-1] };
    }

    const rows = await PurchaseBill.findAll({
      where,
      include: [{ model: Party, as: 'supplier', attributes: ['party_name', 'mobile_1'] }],
      order: [['bill_date', 'DESC'], ['purchase_bill_id', 'DESC']],
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Purchase Report');
    ws.columns = [
      { header: 'Bill No',      key: 'bill_number',     width: 18 },
      { header: 'Supp. Inv#',   key: 'supplier_invoice', width: 18 },
      { header: 'Date',         key: 'bill_date',       width: 12 },
      { header: 'Supplier',     key: 'supplier',        width: 28 },
      { header: 'Mobile',       key: 'mobile',          width: 14 },
      { header: 'Items',        key: 'total_items',     width: 8  },
      { header: 'Sub Total',    key: 'sub_total',       width: 14 },
      { header: 'Discount',     key: 'discount_amount', width: 12 },
      { header: 'CGST',         key: 'cgst_amount',     width: 10 },
      { header: 'SGST',         key: 'sgst_amount',     width: 10 },
      { header: 'IGST',         key: 'igst_amount',     width: 10 },
      { header: 'Cess',         key: 'cess_amount',     width: 10 },
      { header: 'Total',        key: 'total_amount',    width: 14 },
      { header: 'Paid',         key: 'paid_amount',     width: 12 },
      { header: 'Balance',      key: 'balance_amount',  width: 12 },
      { header: 'Status',       key: 'payment_status',  width: 10 },
    ];
    ws.getRow(1).font = { bold: true };

    rows.forEach(r => ws.addRow({
      bill_number: r.bill_number,
      supplier_invoice: r.supplier_invoice_number || '',
      bill_date: fmtDate(r.bill_date),
      supplier: r.supplier?.party_name || '',
      mobile: r.supplier?.mobile_1 || '',
      total_items: r.total_items,
      sub_total: toMoney(r.sub_total),
      discount_amount: toMoney(r.discount_amount),
      cgst_amount: toMoney(r.cgst_amount),
      sgst_amount: toMoney(r.sgst_amount),
      igst_amount: toMoney(r.igst_amount),
      cess_amount: toMoney(r.cess_amount),
      total_amount: toMoney(r.total_amount),
      paid_amount: toMoney(r.paid_amount),
      balance_amount: toMoney(r.balance_amount),
      payment_status: r.payment_status,
    }));

    if (rows.length) {
      // Audit C2 — round each summed value to 2dp.
      const sumRound = (key) => +(rows.reduce((s, r) => s + toMoney(r[key]), 0)).toFixed(2);
      const totalRow = ws.addRow({
        bill_number: `TOTAL (${rows.length})`,
        sub_total:       sumRound('sub_total'),
        discount_amount: sumRound('discount_amount'),
        cgst_amount:     sumRound('cgst_amount'),
        sgst_amount:     sumRound('sgst_amount'),
        igst_amount:     sumRound('igst_amount'),
        cess_amount:     sumRound('cess_amount'),
        total_amount:    sumRound('total_amount'),
        paid_amount:     sumRound('paid_amount'),
        balance_amount:  sumRound('balance_amount'),
      });
      totalRow.font = { bold: true };
    }

    return _sendWorkbook(res, wb, `purchase_report_${from_date || 'all'}_to_${to_date || 'now'}.xlsx`);
  } catch (err) {
    console.error('Purchase export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.exportStockReport = async (req, res) => {
  try {
    const { category_id, stock_status, search } = req.query;
    const partyId = req.query.party_id ? parseInt(req.query.party_id) : null;
    const partyId_safe = Number.isFinite(partyId) ? partyId : null;
    const where = { is_active: true };
    if (category_id) where.category_id = category_id;
    if (stock_status === 'low') {
      where.minimum_stock_level = { [Op.gt]: 0 };
      where.current_stock = { [Op.lte]: col('minimum_stock_level') };
    }
    if (stock_status === 'out') where.current_stock = { [Op.lte]: 0 };
    if (search) {
      // Audit P3-D — escape LIKE wildcards.
      const s = escapeLike(search);
      where[Op.or] = [
        { product_name: { [Op.iLike]: `%${s}%` } },
        { barcode: { [Op.iLike]: `%${s}%` } },
        { article_number: { [Op.iLike]: `%${s}%` } },
      ];
    }
    // Match the on-screen "purchased from party" filter so an export taken
    // while a supplier is selected lists exactly the same items.
    if (partyId_safe) {
      where[Op.and] = [
        ...(where[Op.and] || []),
        literal(`EXISTS (SELECT 1 FROM purchase_bill_items pbi
          JOIN purchase_bills pb ON pb.purchase_bill_id = pbi.purchase_bill_id
          WHERE pbi.product_id = "Product"."product_id"
            AND pb.supplier_id = ${partyId_safe}
            AND pb.is_cancelled = false)`),
      ];
    }

    const products = await Product.findAll({
      where,
      include: [{ model: Category, attributes: ['category_name'] }],
      order: [['product_name', 'ASC']],
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Stock Report');
    ws.columns = [
      { header: 'Barcode',       key: 'barcode',             width: 15 },
      { header: 'Product',       key: 'product_name',        width: 28 },
      { header: 'Size',          key: 'size_value',          width: 10 },
      { header: 'Article',       key: 'article_number',      width: 14 },
      { header: 'Category',      key: 'category',            width: 18 },
      { header: 'HSN',           key: 'hsn_code',            width: 10 },
      { header: 'Unit',          key: 'unit_of_measurement', width: 8  },
      { header: 'Qty/Box',       key: 'quantity_per_box',    width: 9  },
      { header: 'Min Stock',     key: 'minimum_stock_level', width: 10 },
      { header: 'Current Stock', key: 'current_stock',       width: 12 },
      { header: 'Purchase Rate', key: 'purchase_rate',       width: 13 },
      { header: 'Sale Rate',     key: 'sale_rate',           width: 13 },
      { header: 'MRP',           key: 'mrp',                 width: 10 },
      { header: 'Stock Value (Purchase)', key: 'stock_value_p', width: 18 },
      { header: 'Stock Value (Sale)',     key: 'stock_value_s', width: 18 },
    ];
    ws.getRow(1).font = { bold: true };

    // Audit C3 — pick cost basis the same way stockReport() does:
    //   single, non-batch  → weighted_avg_cost (fallback purchase_rate)
    //   single, batch      → 0 here (batch contribution is intentional gap;
    //                                a future per-batch aggregate would add it)
    //   variant            → purchase_rate (latest landed)
    // Pre-fix the export ALWAYS used purchase_rate, so weighted-average
    // installs saw the dashboard "Stock Value" diverge from the exported total.
    const resolveCost = (p) => {
      if (p.product_mode === 'single' && !p.is_batch_tracked) {
        return toMoney(p.weighted_avg_cost ?? p.purchase_rate);
      }
      if (p.product_mode === 'single' && p.is_batch_tracked) {
        return 0;
      }
      return toMoney(p.purchase_rate);
    };
    let totalPV = 0, totalSV = 0;
    products.forEach(p => {
      const cs = toMoney(p.current_stock);
      const cost = resolveCost(p);
      const sr = toMoney(p.sale_rate);
      const pv = cs * cost;
      const sv = cs * sr;
      totalPV += pv;
      totalSV += sv;
      ws.addRow({
        barcode: p.barcode,
        product_name: p.product_name,
        size_value: p.size_value || '',
        article_number: p.article_number || '',
        category: p.Category?.category_name || '',
        hsn_code: p.hsn_code || '',
        unit_of_measurement: p.unit_of_measurement,
        quantity_per_box: toMoney(p.quantity_per_box),
        minimum_stock_level: toMoney(p.minimum_stock_level),
        current_stock: cs,
        purchase_rate: cost,
        sale_rate: sr,
        mrp: toMoney(p.mrp),
        stock_value_p: +pv.toFixed(2),
        stock_value_s: +sv.toFixed(2),
      });
    });

    if (products.length) {
      const totalRow = ws.addRow({
        barcode: `TOTAL (${products.length})`,
        stock_value_p: +totalPV.toFixed(2),
        stock_value_s: +totalSV.toFixed(2),
      });
      totalRow.font = { bold: true };
    }

    return _sendWorkbook(res, wb, `stock_report_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (err) {
    console.error('Stock export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

exports.exportPartyOutstanding = async (req, res) => {
  try {
    const { party_type } = req.query;

    // Outstanding per party = the maintained `parties.current_balance` ledger
    // column — identical basis to the on-screen report (partyOutstanding) and
    // the Dashboard/lists, so the Excel export never disagrees with the screen.
    // (See the long note on partyOutstanding for why the old bill-derived
    // formula was wrong on imported paid_amount=0 data.)
    const buildQuery = (mode) => {
      const partyTypes = mode === 'Customer' ? `'Customer','Both'` : `'Supplier','Both'`;
      return `
        SELECT p.party_id, p.party_name, p.mobile_1, p.party_type, p.gstin,
               p.credit_limit, p.credit_days,
               COALESCE(p.current_balance, 0)::float AS current_balance
        FROM parties p
        WHERE p.party_type IN (${partyTypes})
      `;
    };

    let parties = [];
    if (party_type === 'Customer') {
      parties = await sequelize.query(
        `SELECT * FROM (${buildQuery('Customer')}) x WHERE current_balance > 0 ORDER BY current_balance DESC`,
        { type: sequelize.QueryTypes.SELECT }
      );
    } else if (party_type === 'Supplier') {
      parties = await sequelize.query(
        `SELECT * FROM (${buildQuery('Supplier')}) x WHERE current_balance < 0 ORDER BY ABS(current_balance) DESC`,
        { type: sequelize.QueryTypes.SELECT }
      );
    } else {
      const [cust, sup] = await Promise.all([
        sequelize.query(`SELECT * FROM (${buildQuery('Customer')}) x WHERE current_balance != 0 ORDER BY ABS(current_balance) DESC`,
          { type: sequelize.QueryTypes.SELECT }),
        sequelize.query(`SELECT * FROM (${buildQuery('Supplier')}) x WHERE current_balance != 0 ORDER BY ABS(current_balance) DESC`,
          { type: sequelize.QueryTypes.SELECT }),
      ]);
      parties = [...cust, ...sup];
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Outstanding');
    ws.columns = [
      { header: 'Party Name', key: 'party_name', width: 30 },
      { header: 'Type',       key: 'party_type', width: 10 },
      { header: 'Mobile',     key: 'mobile_1',   width: 14 },
      { header: 'GSTIN',      key: 'gstin',      width: 18 },
      { header: 'Balance',    key: 'balance',    width: 14 },
      { header: 'Status',     key: 'status',     width: 14 },
    ];
    ws.getRow(1).font = { bold: true };

    parties.forEach(p => ws.addRow({
      party_name: p.party_name,
      party_type: p.party_type,
      mobile_1:   p.mobile_1 || '',
      gstin:      p.gstin || '',
      balance:    +parseFloat(p.current_balance || 0).toFixed(2),
      status:     parseFloat(p.current_balance) >= 0 ? 'Receivable' : 'Payable',
    }));

    return _sendWorkbook(res, wb, `outstanding_${party_type || 'all'}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (err) {
    console.error('Outstanding export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

// =========================================================================
// AGING REPORT — per-party outstanding bills bucketed by days overdue.
// Math lives in utils/aging.js (pure, fully unit-tested). This controller
// is just data-plumbing: load bills + parties, hand the normalized shape
// to aggregateAging, stream the result back.
// =========================================================================

function _agingBounds(settings) {
  return {
    b1: parseInt(settings?.aging_bucket_1_days ?? 30, 10),
    b2: parseInt(settings?.aging_bucket_2_days ?? 60, 10),
    b3: parseInt(settings?.aging_bucket_3_days ?? 90, 10),
  };
}

// Load every non-cancelled bill that existed on/before `asOf` whose
// historical balance on that date was > 0, along with the associated
// party. The historical balance is `total - paid_at_billing -
// SUM(bill_payment_allocations dated <= asOf via the parent receipt's
// transaction_date)`. This is the dataset aggregateAging operates on.
//
// Audit B4 fix: previously this loader filtered only by `balance_amount > 0`
// and ignored `asOf`, so a historical aging picker (e.g., last FY close)
// returned bills created AFTER that date and used the LIVE balance — a bill
// paid yesterday showed as fully paid on a March 31 aging. The reconciliation
// banner already filtered correctly, so the banner would flag drift but the
// aging table itself was wrong. Now both legs use the same temporal cut.
async function _loadAgingBills(partyType, asOf, openingDate) {
  const isCustomer = partyType === 'Customer';
  const Bill = isCustomer ? SalesBill : PurchaseBill;
  const billIdKey = isCustomer ? 'sales_bill_id' : 'purchase_bill_id';
  const partyAssoc = isCustomer ? 'customer' : 'supplier';
  const billType   = isCustomer ? 'Sales' : 'Purchase';
  const billTable  = isCustomer ? 'sales_bills' : 'purchase_bills';
  const partyFk    = isCustomer ? 'customer_id' : 'supplier_id';

  const where = { is_cancelled: false };
  if (asOf) where.bill_date = { [Op.lte]: asOf };

  const rows = await Bill.findAll({
    where,
    attributes: ['bill_number', 'bill_date', 'due_date', 'total_amount',
                 'paid_amount', 'balance_amount', 'return_amount', billIdKey],
    include: [{
      model: Party,
      as: partyAssoc,
      // Exclude the system Cash party — cash sales/purchases are settled
      // at point-of-sale and have no credit window to age. A cash bill
      // with balance_amount > 0 is a half-saved entry, not a receivable.
      where: { is_system_cash: { [Op.or]: [false, null] } },
      required: true,
      attributes: ['party_id', 'party_name', 'mobile_1', 'city', 'state',
                   'credit_days', 'credit_limit',
                   'current_balance', 'opening_balance', 'opening_balance_type'],
    }],
    order: [['bill_date', 'ASC']],
  });

  if (rows.length === 0) return [];

  // ── Ledger-anchored aging ─────────────────────────────────────────────
  // Each party's total MUST equal its true open balance (current_balance /
  // Sundry Debtors-Creditors ledger), not the gross sum of unpaid bills.
  // On this dataset many receipts are recorded on-account (never tagged to
  // a bill) and opening balances aren't bills, so Σ(bill balance) does not
  // equal the real receivable. We take current_balance as truth and lay it
  // back over each party's charge timeline (opening, then bills oldest-
  // first): credits pay the oldest charges, whatever remains is aged by its
  // own date. Compute-only — no data is written.
  //
  // Opening balance is aged from the financial-year start (its carry-
  // forward date). NOTE: current_balance is the balance as of *today*, so
  // for a historical as_of the distribution is an approximation; the
  // default (today) is exact.
  const FALLBACK_OPENING_DATE = '2000-04-01';
  const openDt = (openingDate && /^\d{4}-\d{2}-\d{2}$/.test(String(openingDate).slice(0, 10)))
    ? String(openingDate).slice(0, 10) : FALLBACK_OPENING_DATE;

  // Bills grouped by party (only parties that have ≥ 1 bill on/before asOf).
  const billsByParty = new Map();
  for (const r of rows) {
    const p = r[partyAssoc];
    if (!p) continue;
    if (!billsByParty.has(p.party_id)) billsByParty.set(p.party_id, []);
    billsByParty.get(p.party_id).push(r);
  }

  // Master party list: EVERY party that owes (receivable) / is owed
  // (payable) per its ledger balance — INCLUDING parties with only an
  // opening balance or on-account debits and no bills, so the report's
  // grand total reconciles to the Sundry Debtors/Creditors ledger rather
  // than just the subset of parties that happen to have open bills.
  const sign     = isCustomer ? 1 : -1;          // receivable +, payable −
  const typeList = isCustomer ? ['Customer', 'Both'] : ['Supplier', 'Both'];
  const openType = isCustomer ? 'Receivable' : 'Payable';
  const partyRows = await sequelize.query(
    `SELECT party_id, party_name, mobile_1, city, state, credit_days, credit_limit,
            current_balance, opening_balance, opening_balance_type
       FROM parties
      WHERE (is_system_cash IS NULL OR is_system_cash = false)
        AND party_type IN (:types)
        AND ${isCustomer ? 'current_balance > 0.005' : 'current_balance < -0.005'}`,
    { replacements: { types: typeList }, type: sequelize.QueryTypes.SELECT },
  );

  const out = [];
  for (const party of partyRows) {
    // Authoritative open balance (positive on this report's axis).
    const openBalance = Math.max(0, round2(sign * (Number(party.current_balance) || 0)));
    if (openBalance <= 0.005) continue;

    // Charge timeline oldest-first: opening debit (if any), then each
    // bill's net invoice value (total − return).
    const charges = [];
    const openingDebit = (String(party.opening_balance_type) === openType)
      ? (Number(party.opening_balance) || 0) : 0;
    // Opening sorts oldest ('0001-01-01') so on-account credits pay it down
    // before any invoice (FIFO oldest-first); its display date is openDt.
    if (openingDebit > 0.005) {
      charges.push({ date: '0001-01-01', amount: openingDebit, meta: { __opening: true } });
    }
    for (const b of (billsByParty.get(party.party_id) || [])) {
      const charge = (Number(b.total_amount) || 0) - (Number(b.return_amount) || 0);
      if (charge > 0.005) {
        charges.push({
          date: String(b.bill_date).slice(0, 10),
          amount: charge,
          meta: {
            bill_id: b[billIdKey], bill_number: b.bill_number,
            bill_date: b.bill_date, due_date: b.due_date || null,
            total_amount: Number(b.total_amount) || 0,
          },
        });
      }
    }
    // Balance with no charges to hang it on (pure on-account / opening with
    // no opening_balance row) → carry it forward as a single oldest item so
    // the party still appears and the grand total reconciles.
    if (charges.length === 0) {
      charges.push({ date: '0001-01-01', amount: openBalance, meta: { __opening: true } });
    }

    const openItems = distributeOpenBalanceFifo(charges, openBalance);
    const partyLite = {
      party_id: party.party_id, party_name: party.party_name,
      mobile_1: party.mobile_1, city: party.city, state: party.state,
      credit_days: party.credit_days, credit_limit: Number(party.credit_limit) || 0,
    };

    for (const item of openItems) {
      const m = item.meta || {};
      if (m.__opening) {
        out.push({
          bill_id: `opening-${party.party_id}`, bill_number: 'Opening / B-F',
          bill_date: openDt, due_date: openDt,
          total_amount: round2(item.amount), paid_amount: 0,
          balance_amount: round2(item.amount),
          is_opening: true, is_onaccount: true, party: partyLite,
        });
      } else {
        out.push({
          bill_id: m.bill_id, bill_number: m.bill_number,
          bill_date: m.bill_date, due_date: m.due_date,
          total_amount: round2(m.total_amount),
          paid_amount: round2((m.total_amount || 0) - item.amount),
          balance_amount: round2(item.amount), party: partyLite,
        });
      }
    }
  }
  return out;
}

// ── Aging reconciliation ───────────────────────────────────────────────
//
// The naïve invariant `Σ bill.balance_amount == Sundry Debtors/Creditors
// ledger total` does NOT hold in this codebase, by construction. There
// are five sources of legitimate drift:
//
//   1. Receipts/Payments credit/debit the party ledger but never
//      decrement the source bill's balance_amount (no FIFO allocation
//      yet — see "Receipt → Bill allocation" in known foundation gaps).
//   2. Opening JVs (Opening Balance Equity ↔ party) post to the party
//      ledger but create no SalesBill / PurchaseBill row.
//   3. Paid-in-full / partially-paid bills: `paid_amount` reduces
//      balance_amount, AND the receipt that paid it is also captured
//      in (1). Without correction this is double-subtracted.
//   4. Sales/Purchase returns Cr/Dr the party ledger but exist as
//      their own bill type (sales_return_bill/purchase_return_bill).
//   5. Cash-sale bills (customer_id=NULL) with balance > 0 inflate
//      bill_outstanding without touching Sundry Debtors at all.
//
// The corrected invariant — sums every per-source contribution to the
// party ledger, expressed in terms the user can read on the banner:
//   bill_outstanding            (Σ balance_amount of credit-sale bills)
//   + paid_in_bills             (Σ paid_amount of those bills, closes #3)
//   − unallocated_receipts      (Cr legs from payment_receipt sources)
//   − returns_offset            (Cr legs from sales_return_bill source)
//   + opening_dr − opening_cr   (Dr/Cr legs from party_opening source)
//   == Σ Sundry Debtors / Creditors ledger
//
// All six breakdown numbers are surfaced on the response so the UI
// banner shows the formula and any genuine future drift remains
// diagnosable from the screen.
async function _agingReconciliation(partyType, asOf) {
  const isCustomer = partyType === 'Customer';
  const subGroup = isCustomer ? 'Sundry Debtors' : 'Sundry Creditors';
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

  // Bill side — restrict to bills whose party leg actually posts to
  // Sundry Debtors / Creditors. Cash sales / cash purchases settle at
  // point-of-sale and post to the Cash ledger, NOT Sundry Debtors/
  // Creditors. We exclude them by joining to parties and filtering on
  // is_system_cash. The previous filter (customer_id IS NOT NULL alone)
  // missed cash sales whose customer_id was set to the system Cash
  // party — those bills' balance_amounts inflated bill_outstanding
  // by an amount that never appeared on the party-ledger side,
  // surfacing as a drift on the reconciliation banner (the long-
  // standing -₹85 in the seed data was a single ₹85 cash sale).
  // bill term = gross billed not yet open = SUM(total_amount - balance_amount),
  // i.e. all money applied to the bill (at-billing + reconciled receipts).
  // We do NOT subtract return_amount here: the sale posts the FULL total to
  // the party ledger (sales_bill Dr = total), and returns are reflected
  // separately by the sales_return_bill ledger credits captured in
  // `returns_offset` below. Subtracting return_amount in BOTH places
  // double-counted returns and left a drift exactly equal to
  // SUM(return_amount) (purchase already used total - balance, so this
  // brings the two sides into agreement).
  const [billRow] = await sequelize.query(
    isCustomer
      ? `SELECT COALESCE(SUM(b.balance_amount), 0)::float outstanding,
                COALESCE(SUM(b.total_amount - b.balance_amount), 0)::float paid_in_bills
           FROM sales_bills b
           JOIN parties p ON p.party_id = b.customer_id
          WHERE b.is_cancelled = false
            AND b.customer_id IS NOT NULL
            AND b.bill_date <= :as_of
            AND (p.is_system_cash IS NULL OR p.is_system_cash = false)`
      : `SELECT COALESCE(SUM(b.balance_amount), 0)::float outstanding,
                COALESCE(SUM(b.total_amount - b.balance_amount), 0)::float paid_in_bills
           FROM purchase_bills b
           JOIN parties p ON p.party_id = b.supplier_id
           JOIN ledger_accounts la ON la.ledger_id = p.ledger_account_id
          WHERE b.is_cancelled = false
            AND b.supplier_id IS NOT NULL
            AND la.sub_group = 'Sundry Creditors'
            AND b.bill_date <= :as_of
            AND (p.is_system_cash IS NULL OR p.is_system_cash = false)`,
    { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );
  const billOutstanding = r2(billRow.outstanding);
  const paidInBills     = r2(billRow.paid_in_bills);

  // Returns offset — sales returns Cr the customer ledger; purchase
  // returns Dr the supplier ledger.
  const [returnsRow] = await sequelize.query(
    isCustomer
      ? `SELECT COALESCE(SUM(le.credit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Debtors'
            AND le.source_type = 'sales_return_bill'
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`
      : `SELECT COALESCE(SUM(le.debit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Creditors'
            AND le.source_type = 'purchase_return_bill'
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`,
    { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );
  const returnsOffset = r2(returnsRow.v);

  // Refund offset — a cash refund against a sales/purchase return posts a
  // SECOND voucher that touches the party sub_group again
  // (sales_return_refund Dr Sundry Debtors / purchase_return_refund Cr
  // Sundry Creditors). returns_offset above only captures the credit-note
  // leg, so without this term the refund leg is unmatched and surfaces as
  // drift. Signed onto the outstanding axis: customer refunds are Dr (raise
  // receivable), supplier refunds are Cr (raise payable).
  const [refundsRow] = await sequelize.query(
    isCustomer
      ? `SELECT COALESCE(SUM(le.debit_amount - le.credit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Debtors'
            AND le.source_type = 'sales_return_refund'
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`
      : `SELECT COALESCE(SUM(le.credit_amount - le.debit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Creditors'
            AND le.source_type = 'purchase_return_refund'
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`,
    { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );
  const refunds = r2(refundsRow.v);

  // Ledger side — Σ Sundry Debtors/Creditors net.
  const [ledgerRow] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount - le.credit_amount), 0)::float net
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
      WHERE la.sub_group = :sg
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
        AND le.entry_date <= :as_of`,
    { replacements: { sg: subGroup, as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );
  // Receivables: ledger is Dr-positive. Payables: flip so "outstanding
  // to suppliers" reads as a positive number on the banner.
  const ledgerOutstanding = r2(isCustomer ? ledgerRow.net : -ledgerRow.net);

  // Unallocated receipts/payments — every Cr (sales) / Dr (purchase)
  // leg posted from a receipt/payment source onto the party sub_group.
  // Includes both standalone payment_receipt vouchers and the at-
  // creation sales_bill_receipt / purchase_bill_payment legs that
  // close out a paid bill.
  const [unallocRow] = await sequelize.query(
    isCustomer
      ? `SELECT COALESCE(SUM(le.credit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Debtors'
            AND le.source_type IN ('payment_receipt', 'sales_bill_receipt')
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`
      : `SELECT COALESCE(SUM(le.debit_amount), 0)::float v
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.sub_group = 'Sundry Creditors'
            AND le.source_type IN ('payment_receipt', 'purchase_bill_payment')
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
            AND le.entry_date <= :as_of`,
    { replacements: { as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );
  const unallocated = r2(unallocRow.v);

  // Opening JVs — Dr/Cr from party_opening source. For receivables:
  // opening_dr = "they owed us at FY start", opening_cr = "we owed them
  // (advances)". Reversed for payables.
  const [openingRow] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount), 0)::float opening_dr,
            COALESCE(SUM(le.credit_amount), 0)::float opening_cr
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
      WHERE la.sub_group = :sg
        AND le.source_type = 'party_opening'
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
        AND le.entry_date <= :as_of`,
    { replacements: { sg: subGroup, as_of: asOf }, type: sequelize.QueryTypes.SELECT },
  );
  // For payables, swap opening_dr / opening_cr semantics — what we owe
  // them at FY start is THEIR Cr leg in the ledger, but we want to read
  // it as a positive on the "outstanding" axis.
  const openingDr = r2(isCustomer ? openingRow.opening_dr : openingRow.opening_cr);
  const openingCr = r2(isCustomer ? openingRow.opening_cr : openingRow.opening_dr);

  const expectedLedger = r2(
    billOutstanding + paidInBills - unallocated - returnsOffset + openingDr - openingCr + refunds
  );
  const difference = r2(ledgerOutstanding - expectedLedger);

  return {
    sub_group: subGroup,
    bill_outstanding:    billOutstanding,
    paid_in_bills:       paidInBills,
    unallocated_receipts: unallocated,
    returns_offset:      returnsOffset,
    refunds,
    opening_dr:          openingDr,
    opening_cr:          openingCr,
    expected_ledger_outstanding: expectedLedger,
    ledger_outstanding:  ledgerOutstanding,
    difference,
    balanced: Math.abs(difference) < 0.01,
  };
}

exports.agingReport = async (req, res) => {
  try {
    const partyType = req.query.party_type === 'Supplier' ? 'Supplier' : 'Customer';
    const settings = await SystemSettings.findOne();
    const bounds = _agingBounds(settings);
    // Honour the operator's date picker — defaults to today when the
    // query param is absent / blank. The previous version hard-coded
    // localDateString() and silently ignored ?as_of=YYYY-MM-DD, making
    // the picker a no-op (audit C7).
    const asOf = (req.query.as_of && /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of))
      ? req.query.as_of
      : localDateString();

    const bills = await _loadAgingBills(partyType, asOf, settings && settings.financial_year_start);
    const result = aggregateAging(bills, asOf, bounds);
    const reconciliation = await _agingReconciliation(partyType, asOf);

    res.json({ party_type: partyType, ...result, reconciliation });
  } catch (err) {
    console.error('Aging report error:', err);
    respondWithError(res, err);
  }
};

exports.exportAgingReport = async (req, res) => {
  try {
    const partyType = req.query.party_type === 'Supplier' ? 'Supplier' : 'Customer';
    const settings = await SystemSettings.findOne();
    const bounds = _agingBounds(settings);
    // Same as_of handling as agingReport above — honour ?as_of=YYYY-MM-DD.
    const asOf = (req.query.as_of && /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of))
      ? req.query.as_of
      : localDateString();

    const bills = await _loadAgingBills(partyType, asOf, settings && settings.financial_year_start);
    const { rows, grand, bucket_labels } = aggregateAging(bills, asOf, bounds);

    const wb = new ExcelJS.Workbook();
    // ── Sheet 1: Party-level summary ─────────────────────────────────────
    const ws = wb.addWorksheet('Summary');
    ws.columns = [
      { header: 'Party',                    key: 'party_name',    width: 30 },
      { header: 'Mobile',                   key: 'mobile_1',      width: 14 },
      { header: 'City',                     key: 'city',          width: 16 },
      { header: 'Credit Days',              key: 'credit_days',   width: 11 },
      { header: 'Bills',                    key: 'bill_count',    width: 7  },
      { header: 'Oldest (days)',            key: 'oldest_days',   width: 12 },
      { header: bucket_labels.current,      key: 'current',       width: 12 },
      { header: bucket_labels.b1,           key: 'b1',            width: 12 },
      { header: bucket_labels.b2,           key: 'b2',            width: 12 },
      { header: bucket_labels.b3,           key: 'b3',            width: 12 },
      { header: bucket_labels.b4,           key: 'b4',            width: 12 },
      { header: bucket_labels.on_account || 'On A/c', key: 'on_account', width: 12 },
      { header: 'Total',                    key: 'total',         width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach(r => ws.addRow(r));
    // Grand-total footer row
    const totalRow = ws.addRow({
      party_name: 'TOTAL',
      mobile_1: '', city: '', credit_days: '', bill_count: '', oldest_days: '',
      current: grand.current, b1: grand.b1, b2: grand.b2, b3: grand.b3,
      b4: grand.b4, on_account: grand.on_account, total: grand.total,
    });
    totalRow.font = { bold: true };
    totalRow.border = { top: { style: 'medium' } };

    // ── Sheet 2: Bill-level drill-down ───────────────────────────────────
    const ws2 = wb.addWorksheet('Bills');
    ws2.columns = [
      { header: 'Party',          key: 'party_name',     width: 30 },
      { header: 'Bill Number',    key: 'bill_number',    width: 18 },
      { header: 'Bill Date',      key: 'bill_date',      width: 12 },
      { header: 'Due Date',       key: 'due_date',       width: 12 },
      { header: 'Overdue (days)', key: 'overdue_days',   width: 13 },
      { header: 'Bucket',         key: 'bucket_label',   width: 11 },
      { header: 'Total',          key: 'total_amount',   width: 14 },
      { header: 'Paid',           key: 'paid_amount',    width: 14 },
      { header: 'Balance',        key: 'balance_amount', width: 14 },
    ];
    ws2.getRow(1).font = { bold: true };
    rows.forEach(r => r.bills.forEach(b => ws2.addRow({
      party_name: r.party_name,
      bill_number: b.bill_number,
      bill_date: b.bill_date,
      due_date: b.due_date || '',
      overdue_days: b.overdue_days,
      bucket_label: bucket_labels[b.bucket],
      total_amount: b.total_amount,
      paid_amount: b.paid_amount,
      balance_amount: b.balance_amount,
    })));

    const fname = `aging_${partyType.toLowerCase()}_${asOf}.xlsx`;
    return _sendWorkbook(res, wb, fname);
  } catch (err) {
    console.error('Aging export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

// =========================================================================
// GSTR-1 — monthly outward-supply summary (statutory).
// Math lives in utils/gstr1.js (pure, 29 unit-tests passing). This
// controller just loads bills+items+customer for a period and hands the
// normalized shape off to buildGstr1.
// =========================================================================

const { buildGstr1, stateCodeFromGstin } = require('../utils/gstr1');

// Loads ALL bills for the period (cancelled and active) and splits them.
// Cancelled bills are needed by Table 13 (Documents Issued); the other
// tables only see active bills, exactly as the portal expects.
async function _loadGstr1Bills(from, to) {
  const rows = await SalesBill.findAll({
    where: {
      // Note: no is_cancelled filter — both go into the result, split below.
      bill_date: { [Op.between]: [from, to] },
    },
    attributes: ['sales_bill_id', 'bill_number', 'bill_date',
                 'sub_total', 'cgst_amount', 'sgst_amount', 'igst_amount',
                 'cess_amount', 'total_amount', 'remarks', 'is_cancelled'],
    include: [
      { model: Party, as: 'customer',
        attributes: ['party_name', 'gstin', 'state', 'mobile_1'] },
      { model: SalesBillItem, as: 'items',
        attributes: ['hsn_code', 'gst_rate', 'quantity', 'unit_type',
                     'taxable_amount', 'cgst_amount', 'sgst_amount',
                     'igst_amount', 'cess_amount'] },
    ],
    order: [['bill_date', 'ASC'], ['sales_bill_id', 'ASC']],
  });

  const mapped = rows.map(r => ({
    bill_id:      r.sales_bill_id,
    bill_number:  r.bill_number,
    bill_date:    r.bill_date,
    is_cancelled: !!r.is_cancelled,
    sub_total:    Number(r.sub_total)   || 0,
    cgst_amount:  Number(r.cgst_amount) || 0,
    sgst_amount:  Number(r.sgst_amount) || 0,
    igst_amount:  Number(r.igst_amount) || 0,
    cess_amount:  Number(r.cess_amount) || 0,
    total_amount: Number(r.total_amount) || 0,
    remarks:      r.remarks || '',
    customer: r.customer ? {
      party_name: r.customer.party_name,
      gstin:      r.customer.gstin,
      state:      r.customer.state,
      mobile_1:   r.customer.mobile_1,
    } : null,
    items: (r.items || []).map(it => ({
      hsn_code:       it.hsn_code,
      gst_rate:       Number(it.gst_rate)       || 0,
      quantity:       Number(it.quantity)       || 0,
      unit_type:      it.unit_type,
      taxable_amount: Number(it.taxable_amount) || 0,
      cgst_amount:    Number(it.cgst_amount)    || 0,
      sgst_amount:    Number(it.sgst_amount)    || 0,
      igst_amount:    Number(it.igst_amount)    || 0,
      cess_amount:    Number(it.cess_amount)    || 0,
    })),
  }));

  return {
    active:    mapped.filter(b => !b.is_cancelled),
    cancelled: mapped.filter(b =>  b.is_cancelled),
  };
}

/**
 * Load all sales returns (credit notes) in the period for GSTR-1
 * Tables 9A (CDNR) and 9B (CDNUR). Mirrors `_loadGstr1Bills` shape:
 * returns `{ active, cancelled }`. The original-invoice date isn't on the
 * SalesReturnBill row directly, so we left-join SalesBill via
 * `reference_bill_id` to pick it up — needed for the portal's
 * "Original Invoice Date" column.
 */
async function _loadGstr1Returns(from, to) {
  const rows = await SalesReturnBill.findAll({
    where: { return_date: { [Op.between]: [from, to] } },
    attributes: ['sales_return_id', 'return_number', 'return_date',
                 'reference_bill_id', 'reference_bill_number',
                 'sub_total', 'cgst_amount', 'sgst_amount', 'igst_amount',
                 'cess_amount', 'total_amount', 'remarks', 'is_cancelled'],
    include: [
      { model: Party, as: 'customer',
        attributes: ['party_name', 'gstin', 'state', 'mobile_1'] },
      { model: SalesReturnBillItem, as: 'items',
        attributes: ['hsn_code', 'gst_rate', 'quantity', 'unit_type',
                     'taxable_amount', 'cgst_amount', 'sgst_amount',
                     'igst_amount', 'cess_amount'] },
    ],
    order: [['return_date', 'ASC'], ['sales_return_id', 'ASC']],
  });

  // Look up reference bill dates separately (lighter than a JOIN we may not
  // need on every row). Build a `bill_id → bill_date` map for the unique
  // ids referenced.
  const refIds = [...new Set(rows.map(r => r.reference_bill_id).filter(Boolean))];
  const refBillRows = refIds.length
    ? await SalesBill.findAll({
        where: { sales_bill_id: { [Op.in]: refIds } },
        attributes: ['sales_bill_id', 'bill_date'],
      })
    : [];
  const refDateMap = new Map(refBillRows.map(b => [b.sales_bill_id, b.bill_date]));

  const mapped = rows.map(r => ({
    return_id:      r.sales_return_id,
    return_number:  r.return_number,
    return_date:    r.return_date,
    is_cancelled:   !!r.is_cancelled,
    reference_bill_id:     r.reference_bill_id,
    reference_bill_number: r.reference_bill_number,
    reference_bill_date:   r.reference_bill_id ? (refDateMap.get(r.reference_bill_id) || null) : null,
    sub_total:    Number(r.sub_total)   || 0,
    cgst_amount:  Number(r.cgst_amount) || 0,
    sgst_amount:  Number(r.sgst_amount) || 0,
    igst_amount:  Number(r.igst_amount) || 0,
    cess_amount:  Number(r.cess_amount) || 0,
    total_amount: Number(r.total_amount) || 0,
    remarks:      r.remarks || '',
    customer: r.customer ? {
      party_name: r.customer.party_name,
      gstin:      r.customer.gstin,
      state:      r.customer.state,
      mobile_1:   r.customer.mobile_1,
    } : null,
    items: (r.items || []).map(it => ({
      hsn_code:       it.hsn_code,
      gst_rate:       Number(it.gst_rate)       || 0,
      quantity:       Number(it.quantity)       || 0,
      unit_type:      it.unit_type,
      taxable_amount: Number(it.taxable_amount) || 0,
      cgst_amount:    Number(it.cgst_amount)    || 0,
      sgst_amount:    Number(it.sgst_amount)    || 0,
      igst_amount:    Number(it.igst_amount)    || 0,
      cess_amount:    Number(it.cess_amount)    || 0,
    })),
  }));

  return {
    active:    mapped.filter(r => !r.is_cancelled),
    cancelled: mapped.filter(r =>  r.is_cancelled),
  };
}

// Period helpers — accept `period=YYYY-MM` or explicit `from_date`/`to_date`.
function _gstr1Period(q) {
  if (q.from_date && q.to_date) {
    return { from: q.from_date, to: q.to_date, label: q.from_date + ' to ' + q.to_date };
  }
  const period = q.period && /^\d{4}-\d{2}$/.test(q.period)
    ? q.period
    : (() => {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      })();
  const [yyyy, mm] = period.split('-').map(Number);
  const lastDay = new Date(yyyy, mm, 0).getDate();
  const from = period + '-01';
  const to   = period + '-' + String(lastDay).padStart(2, '0');
  return { from, to, label: period };
}

exports.gstr1Report = async (req, res) => {
  try {
    const period = _gstr1Period(req.query);
    const settings = await SystemSettings.findOne();
    const companyStateCode = stateCodeFromGstin(settings?.gstin) || null;

    const [{ active, cancelled }, returnsRes] = await Promise.all([
      _loadGstr1Bills(period.from, period.to),
      _loadGstr1Returns(period.from, period.to),
    ]);
    const report = buildGstr1(active, {
      companyStateCode,
      cancelledBills:   cancelled,
      activeReturns:    returnsRes.active,
      cancelledReturns: returnsRes.cancelled,
    });

    res.json({
      period,
      company: {
        gstin: settings?.gstin || null,
        state_code: companyStateCode,
        name: settings?.company_name || '',
      },
      ...report,
    });
  } catch (err) {
    console.error('GSTR-1 error:', err);
    respondWithError(res, err);
  }
};

exports.exportGstr1Report = async (req, res) => {
  try {
    const period = _gstr1Period(req.query);
    const settings = await SystemSettings.findOne();
    const companyStateCode = stateCodeFromGstin(settings?.gstin) || null;
    const [{ active, cancelled }, returnsRes] = await Promise.all([
      _loadGstr1Bills(period.from, period.to),
      _loadGstr1Returns(period.from, period.to),
    ]);
    const { b2b, b2cl, b2cs, nil, cdnr, cdnur, hsn, docs } = buildGstr1(active, {
      companyStateCode,
      cancelledBills:   cancelled,
      activeReturns:    returnsRes.active,
      cancelledReturns: returnsRes.cancelled,
    });

    const wb = new ExcelJS.Workbook();

    /* ── Sheet: B2B (one row per rate within each invoice) ── */
    const b2bSheet = wb.addWorksheet('4A - B2B');
    b2bSheet.columns = [
      { header: 'GSTIN/UIN',        key: 'gstin',         width: 18 },
      { header: 'Receiver Name',    key: 'receiver',      width: 28 },
      { header: 'Invoice No',       key: 'inv',           width: 16 },
      { header: 'Invoice Date',     key: 'inv_date',      width: 12 },
      { header: 'Invoice Value',    key: 'inv_value',     width: 14 },
      { header: 'Place of Supply',  key: 'pos',           width: 12 },
      { header: 'Reverse Charge',   key: 'reverse',       width: 10 },
      { header: 'Invoice Type',     key: 'inv_type',      width: 14 },
      { header: 'Rate (%)',         key: 'rate',          width: 8  },
      { header: 'Taxable Value',    key: 'taxable',       width: 14 },
      { header: 'IGST',             key: 'igst',          width: 12 },
      { header: 'CGST',             key: 'cgst',          width: 12 },
      { header: 'SGST',             key: 'sgst',          width: 12 },
      { header: 'Cess',             key: 'cess',          width: 10 },
    ];
    b2bSheet.getRow(1).font = { bold: true };
    for (const grp of b2b.rows) {
      for (const inv of grp.invoices) {
        for (const rr of inv.rate_rows) {
          b2bSheet.addRow({
            gstin: grp.gstin, receiver: grp.party_name,
            inv: inv.bill_number, inv_date: inv.bill_date,
            inv_value: inv.invoice_value, pos: inv.place_of_supply,
            reverse: inv.reverse_charge ? 'Y' : 'N', inv_type: inv.invoice_type,
            rate: rr.rate, taxable: rr.taxable, igst: rr.igst,
            cgst: rr.cgst, sgst: rr.sgst, cess: rr.cess,
          });
        }
      }
    }

    /* ── Sheet: B2CL (Table 5A) — large unregistered inter-state ──
     *
     * Each invoice > ₹2.5L to an unregistered customer in another state
     * gets its own row per rate bucket. Closes the silent-drop hole that
     * existed when only B2CS was implemented (B2CS skipped these but
     * nothing caught them).
     */
    const b2clSheet = wb.addWorksheet('5A - B2CL');
    b2clSheet.columns = [
      { header: 'Invoice No',      key: 'inv',           width: 16 },
      { header: 'Invoice Date',    key: 'inv_date',      width: 12 },
      { header: 'Receiver',        key: 'receiver',      width: 28 },
      { header: 'Mobile',          key: 'mobile',        width: 14 },
      { header: 'Invoice Value',   key: 'inv_value',     width: 14 },
      { header: 'Place of Supply', key: 'pos',           width: 12 },
      { header: 'Rate (%)',        key: 'rate',          width: 8 },
      { header: 'Taxable Value',   key: 'taxable',       width: 14 },
      { header: 'IGST',            key: 'igst',          width: 12 },
      { header: 'Cess',            key: 'cess',          width: 10 },
    ];
    b2clSheet.getRow(1).font = { bold: true };
    b2cl.rows.forEach(r => b2clSheet.addRow({
      inv: r.bill_number, inv_date: r.bill_date,
      receiver: r.customer_name, mobile: r.mobile || '',
      inv_value: r.invoice_value, pos: r.place_of_supply,
      rate: r.rate, taxable: r.taxable, igst: r.igst, cess: r.cess,
    }));
    if (b2cl.rows.length > 0) {
      const tot = b2clSheet.addRow({
        inv: 'TOTAL', inv_date: '', receiver: '', mobile: '',
        inv_value: '', pos: '', rate: '',
        taxable: b2cl.grand.taxable, igst: b2cl.grand.igst, cess: b2cl.grand.cess,
      });
      tot.font = { bold: true };
      tot.border = { top: { style: 'medium' } };
    }

    /* ── Sheet: B2CS ──
     *
     * Top block: the (POS × Rate × Type) aggregation the portal wants.
     * Bottom block: per-invoice drill-down with customer names. The portal
     * upload only consumes the aggregated block, but operators want to see
     * which bills rolled up into each row (mirrors the expandable rows on
     * the GSTR-1 page).
     */
    const b2csSheet = wb.addWorksheet('7 - B2CS');
    b2csSheet.columns = [
      { header: 'Place of Supply', key: 'pos',           width: 14 },
      { header: 'Supply Type',     key: 'type',          width: 12 },
      { header: 'Rate (%)',        key: 'rate',          width: 9 },
      { header: 'Invoices',        key: 'invoice_count', width: 10 },
      { header: 'Taxable Value',   key: 'taxable',       width: 14 },
      { header: 'IGST',            key: 'igst',          width: 12 },
      { header: 'CGST',            key: 'cgst',          width: 12 },
      { header: 'SGST',            key: 'sgst',          width: 12 },
      { header: 'Cess',            key: 'cess',          width: 10 },
    ];
    b2csSheet.getRow(1).font = { bold: true };
    b2cs.rows.forEach(r => b2csSheet.addRow({
      pos: r.place_of_supply, type: r.type, rate: r.rate,
      invoice_count: r.invoice_count ?? (r.invoices || []).length,
      taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess,
    }));
    // Per-invoice details block — flatten every (group → invoice) pair
    const b2csInvRows = [];
    for (const grp of b2cs.rows) {
      for (const inv of (grp.invoices || [])) {
        b2csInvRows.push({ grp, inv });
      }
    }
    if (b2csInvRows.length > 0) {
      b2csSheet.addRow([]);
      const hdr = b2csSheet.addRow(['Details']);
      hdr.font = { bold: true };
      b2csSheet.addRow([
        'Invoice No', 'Date', 'Customer', 'Mobile',
        'POS', 'Rate', 'Type',
        'Taxable', 'IGST', 'CGST', 'SGST', 'Cess', 'Total',
      ]).font = { bold: true };
      for (const { grp, inv } of b2csInvRows) {
        b2csSheet.addRow([
          inv.bill_number, inv.bill_date, inv.customer_name, inv.mobile || '',
          grp.place_of_supply, grp.rate, grp.type,
          inv.taxable, inv.igst, inv.cgst, inv.sgst, inv.cess, inv.total,
        ]);
      }
    }

    /* ── Sheet: Nil/Exempt/Non-GST (Table 8) ──
     *
     * Two blocks: the 4-way summary (registered/unregistered × intra/inter)
     * that the portal actually wants, and a "Details" block listing every
     * invoice that landed here — useful so the taxpayer can spot bills that
     * fell in by accident (e.g. bill-wise invoice saved with tax % blank).
     */
    const nilSheet = wb.addWorksheet('8 - Nil & Exempt');
    nilSheet.columns = [
      { header: 'Supply Type',     key: 'supply_type',   width: 14 },
      { header: 'Type',            key: 'state_type',    width: 14 },
      { header: 'Invoices',        key: 'invoice_count', width: 10 },
      { header: 'Taxable Value',   key: 'taxable',       width: 16 },
    ];
    nilSheet.getRow(1).font = { bold: true };
    nil.rows.forEach(r => nilSheet.addRow(r));
    if (nil.invoices.length > 0) {
      nilSheet.addRow([]);
      const hdr = nilSheet.addRow(['Details', '', '', '', '', '']);
      hdr.font = { bold: true };
      nilSheet.addRow(['Invoice No', 'Date', 'Receiver', 'Reason', 'Remarks', 'Taxable']).font = { bold: true };
      nil.invoices.forEach(inv => {
        nilSheet.addRow([
          inv.bill_number,
          inv.bill_date,
          inv.party_name + (inv.gstin ? ` (${inv.gstin})` : ''),
          inv.reason_detail || inv.reason || '',
          inv.remarks || '',
          inv.taxable,
        ]);
      });
    }

    /* ── Sheet: 9A — CDNR (Credit/Debit Notes — Registered) ── */
    const cdnrSheet = wb.addWorksheet('9A - CDNR');
    cdnrSheet.columns = [
      { header: 'GSTIN/UIN',                 key: 'gstin',         width: 18 },
      { header: 'Receiver Name',             key: 'receiver',      width: 28 },
      { header: 'Note Number',               key: 'note',          width: 16 },
      { header: 'Note Date',                 key: 'note_date',     width: 12 },
      { header: 'Note Type',                 key: 'note_type',     width: 10 },
      { header: 'Place of Supply',           key: 'pos',           width: 12 },
      { header: 'Reverse Charge',            key: 'reverse',       width: 10 },
      { header: 'Note Value',                key: 'note_value',    width: 14 },
      { header: 'Rate (%)',                  key: 'rate',          width: 8 },
      { header: 'Taxable Value',             key: 'taxable',       width: 14 },
      { header: 'IGST',                      key: 'igst',          width: 12 },
      { header: 'CGST',                      key: 'cgst',          width: 12 },
      { header: 'SGST',                      key: 'sgst',          width: 12 },
      { header: 'Cess',                      key: 'cess',          width: 10 },
      { header: 'Original Invoice No',       key: 'orig_inv',      width: 16 },
      { header: 'Original Invoice Date',     key: 'orig_date',     width: 14 },
    ];
    cdnrSheet.getRow(1).font = { bold: true };
    cdnr.rows.forEach(r => cdnrSheet.addRow({
      gstin: r.gstin, receiver: r.customer_name,
      note: r.note_number, note_date: r.note_date,
      note_type: r.note_type, pos: r.place_of_supply,
      reverse: r.reverse_charge ? 'Y' : 'N',
      note_value: r.note_value, rate: r.rate,
      taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess,
      orig_inv: r.original_invoice_number, orig_date: r.original_invoice_date,
    }));
    if (cdnr.rows.length > 0) {
      const tot = cdnrSheet.addRow({
        gstin: '', receiver: '', note: 'TOTAL', note_date: '', note_type: '',
        pos: '', reverse: '', note_value: '', rate: '',
        taxable: cdnr.grand.taxable, igst: cdnr.grand.igst,
        cgst: cdnr.grand.cgst, sgst: cdnr.grand.sgst, cess: cdnr.grand.cess,
      });
      tot.font = { bold: true };
      tot.border = { top: { style: 'medium' } };
    }

    /* ── Sheet: 9B — CDNUR (Credit/Debit Notes — Unregistered) ── */
    const cdnurSheet = wb.addWorksheet('9B - CDNUR');
    cdnurSheet.columns = [
      { header: 'UR Type',                   key: 'ur_type',       width: 10 },
      { header: 'Receiver Name',             key: 'receiver',      width: 24 },
      { header: 'Mobile',                    key: 'mobile',        width: 14 },
      { header: 'Note Number',               key: 'note',          width: 16 },
      { header: 'Note Date',                 key: 'note_date',     width: 12 },
      { header: 'Note Type',                 key: 'note_type',     width: 10 },
      { header: 'Place of Supply',           key: 'pos',           width: 12 },
      { header: 'Note Value',                key: 'note_value',    width: 14 },
      { header: 'Rate (%)',                  key: 'rate',          width: 8 },
      { header: 'Taxable Value',             key: 'taxable',       width: 14 },
      { header: 'IGST',                      key: 'igst',          width: 12 },
      { header: 'Cess',                      key: 'cess',          width: 10 },
      { header: 'Original Invoice No',       key: 'orig_inv',      width: 16 },
      { header: 'Original Invoice Date',     key: 'orig_date',     width: 14 },
    ];
    cdnurSheet.getRow(1).font = { bold: true };
    cdnur.rows.forEach(r => cdnurSheet.addRow({
      ur_type: r.ur_type, receiver: r.customer_name, mobile: r.mobile || '',
      note: r.note_number, note_date: r.note_date, note_type: r.note_type,
      pos: r.place_of_supply, note_value: r.note_value, rate: r.rate,
      taxable: r.taxable, igst: r.igst, cess: r.cess,
      orig_inv: r.original_invoice_number, orig_date: r.original_invoice_date,
    }));
    if (cdnur.rows.length > 0) {
      const tot = cdnurSheet.addRow({
        ur_type: '', receiver: '', mobile: '',
        note: 'TOTAL', note_date: '', note_type: '',
        pos: '', note_value: '', rate: '',
        taxable: cdnur.grand.taxable, igst: cdnur.grand.igst, cess: cdnur.grand.cess,
      });
      tot.font = { bold: true };
      tot.border = { top: { style: 'medium' } };
    }

    /* ── Sheet: HSN ── */
    const hsnSheet = wb.addWorksheet('12 - HSN');
    hsnSheet.columns = [
      { header: 'HSN/SAC',         key: 'hsn_code',    width: 12 },
      { header: 'Rate (%)',        key: 'rate',        width: 9 },
      { header: 'UQC',             key: 'unit',        width: 8 },
      { header: 'Quantity',        key: 'quantity',    width: 12 },
      { header: 'Taxable Value',   key: 'taxable',     width: 14 },
      { header: 'IGST',            key: 'igst',        width: 12 },
      { header: 'CGST',            key: 'cgst',        width: 12 },
      { header: 'SGST',            key: 'sgst',        width: 12 },
      { header: 'Cess',            key: 'cess',        width: 10 },
      { header: 'Total',           key: 'total',       width: 14 },
    ];
    hsnSheet.getRow(1).font = { bold: true };
    hsn.rows.forEach(r => hsnSheet.addRow(r));
    const hsnTot = hsnSheet.addRow({
      hsn_code: 'TOTAL', rate: '', unit: '',
      quantity: hsn.grand.quantity, taxable: hsn.grand.taxable,
      igst: hsn.grand.igst, cgst: hsn.grand.cgst, sgst: hsn.grand.sgst,
      cess: hsn.grand.cess, total: hsn.grand.total,
    });
    hsnTot.font = { bold: true };
    hsnTot.border = { top: { style: 'medium' } };

    /* ── Sheet: Docs Issued (Table 13) ──
     *
     * Auditor-facing summary: for each bill-number series, how many were
     * raised, how many cancelled, and the from-no/to-no range. Catches
     * missing sequence numbers and proves no parallel book exists.
     */
    const docsSheet = wb.addWorksheet('13 - Docs Issued');
    docsSheet.columns = [
      { header: 'Nature of Document', key: 'nature',    width: 28 },
      { header: 'Series',             key: 'prefix',    width: 18 },
      { header: 'From No',            key: 'from_no',   width: 10 },
      { header: 'To No',              key: 'to_no',     width: 10 },
      { header: 'Total',              key: 'total',     width: 8 },
      { header: 'Cancelled',          key: 'cancelled', width: 10 },
      { header: 'Net',                key: 'net',       width: 8 },
    ];
    docsSheet.getRow(1).font = { bold: true };
    docs.rows.forEach(r => docsSheet.addRow(r));
    if (docs.rows.length > 0) {
      const dt = docsSheet.addRow({
        nature: 'TOTAL', prefix: '', from_no: '', to_no: '',
        total: docs.grand.total, cancelled: docs.grand.cancelled, net: docs.grand.net,
      });
      dt.font = { bold: true };
      dt.border = { top: { style: 'medium' } };
    }

    // Open the workbook to whichever tab the user was viewing in the UI.
    // Sheet order: 0=B2B, 1=B2CL, 2=B2CS, 3=Nil, 4=CDNR (9A), 5=CDNUR (9B),
    // 6=HSN, 7=Docs Issued.
    // Falls back to B2B (sheet 0) if the section query param is missing or
    // unrecognised. ExcelJS surfaces this via wb.views[0].activeTab.
    const SECTION_TO_TAB = {
      b2b: 0, b2cl: 1, b2cs: 2, nil: 3,
      cdnr: 4, cdnur: 5, hsn: 6, docs: 7,
    };
    const activeTab = SECTION_TO_TAB[String(req.query.section || '').toLowerCase()] ?? 0;
    wb.views = [{ activeTab }];
    // Suffix the filename with the section so the user can tell at a glance
    // (and a re-export from another tab doesn't overwrite the previous file).
    const sectionTag = req.query.section && SECTION_TO_TAB[String(req.query.section).toLowerCase()] !== undefined
      ? '_' + String(req.query.section).toLowerCase()
      : '';
    return _sendWorkbook(res, wb, 'gstr1_' + period.label.replace(/\//g, '-') + sectionTag + '.xlsx');
  } catch (err) {
    console.error('GSTR-1 export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};

/* ════════════════════════════════════════════════════════════════════════
 *  GSTR-3B  — monthly summary return
 *
 *  Pulls outward + credit-note data from the existing GSTR-1 loaders and
 *  ITC data from PurchaseBill rows in the period. The buildGstr3b helper
 *  in utils/gstr3b.js does the math (pure, fully unit-tested).
 * ══════════════════════════════════════════════════════════════════════ */

const { buildGstr3b } = require('../utils/gstr3b');
const { detectBillDataIssues } = require('../utils/gstr1');

async function _loadGstr3bPurchases(from, to) {
  const rows = await PurchaseBill.findAll({
    where: { bill_date: { [Op.between]: [from, to] } },
    attributes: ['purchase_bill_id', 'bill_number', 'bill_date',
                 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount',
                 'total_amount', 'is_cancelled'],
    include: [
      { model: Party, as: 'supplier',
        attributes: ['party_name', 'gstin', 'state'] },
      { model: PurchaseBillItem, as: 'items',
        attributes: ['hsn_code', 'gst_rate', 'taxable_amount',
                     'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount'] },
    ],
    order: [['bill_date', 'ASC']],
  });
  return rows.map(r => ({
    purchase_bill_id: r.purchase_bill_id,
    bill_number:      r.bill_number,
    bill_date:        r.bill_date,
    is_cancelled:     !!r.is_cancelled,
    cgst_amount:      Number(r.cgst_amount) || 0,
    sgst_amount:      Number(r.sgst_amount) || 0,
    igst_amount:      Number(r.igst_amount) || 0,
    cess_amount:      Number(r.cess_amount) || 0,
    total_amount:     Number(r.total_amount) || 0,
    supplier: r.supplier ? {
      party_name: r.supplier.party_name,
      gstin:      r.supplier.gstin,
      state:      r.supplier.state,
    } : null,
    items: (r.items || []).map(it => ({
      hsn_code:       it.hsn_code,
      gst_rate:       Number(it.gst_rate) || 0,
      taxable_amount: Number(it.taxable_amount) || 0,
      cgst_amount:    Number(it.cgst_amount) || 0,
      sgst_amount:    Number(it.sgst_amount) || 0,
      igst_amount:    Number(it.igst_amount) || 0,
      cess_amount:    Number(it.cess_amount) || 0,
    })),
  }));
}

// Load purchase returns (debit notes) in the period — these reverse part
// of the earlier ITC claim. Without this loader, `summarizeITC` overstated
// 4(A)(5) by the full return tax. (Audit C8.)
async function _loadGstr3bPurchaseReturns(from, to) {
  const rows = await PurchaseReturnBill.findAll({
    where: { return_date: { [Op.between]: [from, to] } },
    attributes: ['purchase_return_id', 'return_number', 'return_date',
                 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount',
                 'total_amount', 'is_cancelled'],
    include: [
      { model: Party, as: 'supplier',
        attributes: ['party_name', 'gstin', 'state'] },
      { model: PurchaseReturnBillItem, as: 'items',
        attributes: ['hsn_code', 'gst_rate', 'taxable_amount',
                     'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount'] },
    ],
    order: [['return_date', 'ASC']],
  });
  return rows.map(r => ({
    purchase_return_id: r.purchase_return_id,
    return_number:      r.return_number,
    return_date:        r.return_date,
    is_cancelled:       !!r.is_cancelled,
    cgst_amount:        Number(r.cgst_amount) || 0,
    sgst_amount:        Number(r.sgst_amount) || 0,
    igst_amount:        Number(r.igst_amount) || 0,
    cess_amount:        Number(r.cess_amount) || 0,
    total_amount:       Number(r.total_amount) || 0,
    supplier: r.supplier ? {
      party_name: r.supplier.party_name,
      gstin:      r.supplier.gstin,
      state:      r.supplier.state,
    } : null,
    items: (r.items || []).map(it => ({
      hsn_code:       it.hsn_code,
      gst_rate:       Number(it.gst_rate) || 0,
      taxable_amount: Number(it.taxable_amount) || 0,
      cgst_amount:    Number(it.cgst_amount) || 0,
      sgst_amount:    Number(it.sgst_amount) || 0,
      igst_amount:    Number(it.igst_amount) || 0,
      cess_amount:    Number(it.cess_amount) || 0,
    })),
  }));
}

exports.gstr3bReport = async (req, res) => {
  try {
    const period = _gstr1Period(req.query);
    const settings = await SystemSettings.findOne();
    const companyStateCode = stateCodeFromGstin(settings?.gstin) || null;

    const [{ active }, returnsRes, purchases, purchaseReturns] = await Promise.all([
      _loadGstr1Bills(period.from, period.to),
      _loadGstr1Returns(period.from, period.to),
      _loadGstr3bPurchases(period.from, period.to),
      _loadGstr3bPurchaseReturns(period.from, period.to),
    ]);

    const report = buildGstr3b({
      activeBills:     active,
      activeReturns:   returnsRes.active,
      purchases:       purchases.filter(p => !p.is_cancelled),
      purchaseReturns: purchaseReturns.filter(p => !p.is_cancelled),
      companyStateCode,
    });

    // Inherit the same data-quality warnings GSTR-1 surfaces. Filing 3B
    // with dirty source bills propagates the over-statement to the portal.
    const billWarnings = detectBillDataIssues(active);

    res.json({
      period,
      company: {
        gstin: settings?.gstin || null,
        state_code: companyStateCode,
        name: settings?.company_name || '',
      },
      data_quality: {
        bill_warnings: billWarnings,
        bill_warning_count: billWarnings.length,
      },
      ...report,
    });
  } catch (err) {
    console.error('GSTR-3B error:', err);
    res.status(500).json({ error: 'Failed to load GSTR-3B' });
  }
};

exports.exportGstr3bReport = async (req, res) => {
  try {
    const period = _gstr1Period(req.query);
    const settings = await SystemSettings.findOne();
    const companyStateCode = stateCodeFromGstin(settings?.gstin) || null;

    const [{ active }, returnsRes, purchases, purchaseReturns] = await Promise.all([
      _loadGstr1Bills(period.from, period.to),
      _loadGstr1Returns(period.from, period.to),
      _loadGstr3bPurchases(period.from, period.to),
      _loadGstr3bPurchaseReturns(period.from, period.to),
    ]);

    const r = buildGstr3b({
      activeBills:     active,
      activeReturns:   returnsRes.active,
      purchases:       purchases.filter(p => !p.is_cancelled),
      purchaseReturns: purchaseReturns.filter(p => !p.is_cancelled),
      companyStateCode,
    });

    const wb = new ExcelJS.Workbook();

    /* ── Sheet 3.1 — Outward + Inward (RCM) supplies ── */
    const s31 = wb.addWorksheet('3.1 Outward Supplies');
    s31.columns = [
      { header: 'Nature of Supplies', key: 'label',   width: 50 },
      { header: 'Total Taxable Value', key: 'taxable', width: 18 },
      { header: 'IGST',  key: 'igst', width: 14 },
      { header: 'CGST',  key: 'cgst', width: 14 },
      { header: 'SGST',  key: 'sgst', width: 14 },
      { header: 'Cess',  key: 'cess', width: 12 },
    ];
    s31.getRow(1).font = { bold: true };
    for (const key of ['taxable_outward', 'zero_rated', 'nil_exempt', 'inward_rcm', 'non_gst_outward']) {
      s31.addRow(r.section_3_1[key]);
    }

    /* ── Sheet 3.2 — Inter-state to unregistered (per POS) ── */
    const s32 = wb.addWorksheet('3.2 Inter-state Unreg');
    s32.columns = [
      { header: 'Place of Supply', key: 'place_of_supply', width: 14 },
      { header: 'Total Taxable Value', key: 'taxable', width: 18 },
      { header: 'IGST', key: 'igst', width: 14 },
    ];
    s32.getRow(1).font = { bold: true };
    r.section_3_2.unregistered.forEach(row => s32.addRow(row));
    if (r.section_3_2.unregistered.length === 0) {
      s32.addRow(['(No inter-state supplies to unregistered persons in period)', '', '']);
    }

    /* ── Sheet 4 — Eligible ITC ── */
    const s4 = wb.addWorksheet('4 ITC');
    s4.columns = [
      { header: 'Details', key: 'label', width: 60 },
      { header: 'IGST', key: 'igst', width: 14 },
      { header: 'CGST', key: 'cgst', width: 14 },
      { header: 'SGST', key: 'sgst', width: 14 },
      { header: 'Cess', key: 'cess', width: 12 },
    ];
    s4.getRow(1).font = { bold: true };
    s4.addRow(['(A) ITC Available', '', '', '', '']).font = { bold: true };
    for (const key of ['import_goods', 'import_services', 'inward_rcm', 'isd', 'all_other']) {
      s4.addRow(r.section_4_itc.A[key]);
    }
    const at = s4.addRow({ label: '    Total (A)', ...r.section_4_itc.A_total });
    at.font = { bold: true }; at.border = { top: { style: 'thin' } };

    s4.addRow([]);
    s4.addRow(['(B) ITC Reversed', '', '', '', '']).font = { bold: true };
    for (const key of ['rules_38_42_43', 'others']) {
      s4.addRow(r.section_4_itc.B[key]);
    }
    const bt = s4.addRow({ label: '    Total (B)', ...r.section_4_itc.B_total });
    bt.font = { bold: true }; bt.border = { top: { style: 'thin' } };

    s4.addRow([]);
    const ct = s4.addRow({ label: '(C) Net ITC Available (A − B)', ...r.section_4_itc.C_net_available });
    ct.font = { bold: true }; ct.border = { top: { style: 'medium' } };

    s4.addRow([]);
    s4.addRow(['(D) Other Details', '', '', '', '']).font = { bold: true };
    for (const key of ['reclaimed', 'ineligible']) {
      s4.addRow(r.section_4_itc.D[key]);
    }

    /* ── Sheet 5 — Exempt/Nil/Non-GST inward ── */
    const s5 = wb.addWorksheet('5 Exempt Inward');
    s5.columns = [
      { header: 'Nature of Supplies', key: 'label',       width: 50 },
      { header: 'Inter-state',        key: 'inter_state', width: 14 },
      { header: 'Intra-state',        key: 'intra_state', width: 14 },
    ];
    s5.getRow(1).font = { bold: true };
    s5.addRow({ label: 'From a supplier under composition / Exempt / Nil rated supply',
      inter_state: r.section_5_exempt.inter_state.composition_or_exempt_or_nil,
      intra_state: r.section_5_exempt.intra_state.composition_or_exempt_or_nil });
    s5.addRow({ label: 'Non-GST supply',
      inter_state: r.section_5_exempt.inter_state.non_gst_supply,
      intra_state: r.section_5_exempt.intra_state.non_gst_supply });

    /* ── Sheet 6.1 — Payment of tax ── */
    const s61 = wb.addWorksheet('6.1 Payment');
    s61.columns = [
      { header: 'Tax', key: 'tax', width: 10 },
      { header: 'Tax Payable',     key: 'tax_payable',   width: 16 },
      { header: 'Paid via ITC',    key: 'paid_via_itc',  width: 16 },
      { header: 'Paid via Cash',   key: 'paid_via_cash', width: 16 },
    ];
    s61.getRow(1).font = { bold: true };
    for (const k of ['igst', 'cgst', 'sgst', 'cess']) {
      s61.addRow({ tax: k.toUpperCase(), ...r.section_6_1_payment[k] });
    }
    const totals = ['igst', 'cgst', 'sgst', 'cess'].reduce((a, k) => {
      a.tax_payable   += r.section_6_1_payment[k].tax_payable;
      a.paid_via_itc  += r.section_6_1_payment[k].paid_via_itc;
      a.paid_via_cash += r.section_6_1_payment[k].paid_via_cash;
      return a;
    }, { tax_payable: 0, paid_via_itc: 0, paid_via_cash: 0 });
    const ttt = s61.addRow({ tax: 'TOTAL', ...totals });
    ttt.font = { bold: true }; ttt.border = { top: { style: 'medium' } };

    const SECTION_TO_TAB = { '3.1': 0, '3.2': 1, '4': 2, '5': 3, '6.1': 4 };
    const activeTab = SECTION_TO_TAB[String(req.query.section || '').toLowerCase()] ?? 0;
    wb.views = [{ activeTab }];

    return _sendWorkbook(res, wb, 'gstr3b_' + period.label.replace(/\//g, '-') + '.xlsx');
  } catch (err) {
    console.error('GSTR-3B export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
};
