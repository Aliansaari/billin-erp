const { Op, fn, col, literal } = require('sequelize');
const sequelize = require('../config/database');
const { SalesBill, SalesBillItem, PurchaseBill, PurchaseBillItem, Party, Product, Category, PaymentReceipt, StockLedger } = require('../models');
const { sanitizePagination } = require('../utils/helpers');

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
    const today = localDateString();
    const monthStart = today.substring(0, 8) + '01';

    // Today's sales
    const todaySales = await SalesBill.findAll({
      where: { bill_date: today, is_cancelled: false },
      attributes: [
        [fn('COUNT', col('sales_bill_id')), 'count'],
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
      ],
      raw: true,
    });

    // Today's purchases
    const todayPurchases = await PurchaseBill.findAll({
      where: { bill_date: today, is_cancelled: false },
      attributes: [
        [fn('COUNT', col('purchase_bill_id')), 'count'],
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
      ],
      raw: true,
    });

    // Monthly sales — pull gross and GST components so we can derive true revenue
    // (revenue excluding tax) for the profit metric. GST is collected on behalf of
    // the tax authority, NOT income — mixing it into profit overstates margin by
    // up to 18%. See also profitLoss() where the same split is applied.
    const monthlySales = await SalesBill.findAll({
      where: { bill_date: { [Op.gte]: monthStart }, is_cancelled: false },
      attributes: [
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
        [fn('COALESCE', fn('SUM', col('cgst_amount')), 0), 'cgst'],
        [fn('COALESCE', fn('SUM', col('sgst_amount')), 0), 'sgst'],
        [fn('COALESCE', fn('SUM', col('igst_amount')), 0), 'igst'],
        [fn('COALESCE', fn('SUM', col('cess_amount')), 0), 'cess'],
      ],
      raw: true,
    });

    // Monthly purchases
    const monthlyPurchases = await PurchaseBill.findAll({
      where: { bill_date: { [Op.gte]: monthStart }, is_cancelled: false },
      attributes: [
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
        [fn('COALESCE', fn('SUM', col('cgst_amount')), 0), 'cgst'],
        [fn('COALESCE', fn('SUM', col('sgst_amount')), 0), 'sgst'],
        [fn('COALESCE', fn('SUM', col('igst_amount')), 0), 'igst'],
        [fn('COALESCE', fn('SUM', col('cess_amount')), 0), 'cess'],
      ],
      raw: true,
    });

    // Receivables and payables — compute from the bills directly (not from
    // the cached Party.current_balance column). The cache can drift when bills
    // are edited, cancelled, or when payments are reversed, and a drifted
    // dashboard would mislead finance decisions. Source of truth: sum of
    // balance_amount across non-cancelled bills grouped by party, plus the
    // opening-balance on the party side (which has no bill to aggregate).
    const [recBillsRaw] = await sequelize.query(`
      SELECT COUNT(DISTINCT sb.customer_id)::int  AS count,
             COALESCE(SUM(sb.balance_amount), 0)::float AS total
      FROM sales_bills sb
      JOIN parties p ON p.party_id = sb.customer_id
      WHERE sb.is_cancelled = false
        AND sb.balance_amount > 0
        AND p.party_type IN ('Customer','Both')
    `);
    const [payBillsRaw] = await sequelize.query(`
      SELECT COUNT(DISTINCT pb.supplier_id)::int  AS count,
             COALESCE(SUM(pb.balance_amount), 0)::float AS total
      FROM purchase_bills pb
      JOIN parties p ON p.party_id = pb.supplier_id
      WHERE pb.is_cancelled = false
        AND pb.balance_amount > 0
        AND p.party_type IN ('Supplier','Both')
    `);

    // Opening balance contributions from parties that have no bills yet —
    // receivable opening for customers adds to receivables, payable opening for
    // suppliers adds to payables.
    const [openRecRaw] = await sequelize.query(`
      SELECT COALESCE(SUM(opening_balance), 0)::float AS total,
             COUNT(*)::int AS count
      FROM parties
      WHERE opening_balance_type = 'Receivable'
        AND opening_balance > 0
        AND party_type IN ('Customer','Both')
    `);
    const [openPayRaw] = await sequelize.query(`
      SELECT COALESCE(SUM(opening_balance), 0)::float AS total,
             COUNT(*)::int AS count
      FROM parties
      WHERE opening_balance_type = 'Payable'
        AND opening_balance > 0
        AND party_type IN ('Supplier','Both')
    `);

    // Net on-account receipts/payments (money received/paid with NO bill yet)
    // still reduces outstanding balances — subtract from the bill-based totals.
    // NOTE: payment_splits FK is `transaction_id` (NOT payment_id) — see PaymentSplit model.
    // Previous version used ps.payment_id which doesn't exist → dashboard crashed at runtime.
    const [onAccountReceiptsRaw] = await sequelize.query(`
      SELECT COALESCE(SUM(pr.total_amount), 0)::float AS total
      FROM payments_receipts pr
      WHERE pr.transaction_type = 'Receipt' AND pr.is_cancelled = false
        AND NOT EXISTS (
          SELECT 1 FROM payment_splits ps WHERE ps.transaction_id = pr.transaction_id
        )
    `);
    const [onAccountPaymentsRaw] = await sequelize.query(`
      SELECT COALESCE(SUM(pr.total_amount), 0)::float AS total
      FROM payments_receipts pr
      WHERE pr.transaction_type = 'Payment' AND pr.is_cancelled = false
        AND NOT EXISTS (
          SELECT 1 FROM payment_splits ps WHERE ps.transaction_id = pr.transaction_id
        )
    `);

    const receivables = [{
      count: (recBillsRaw[0]?.count || 0) + (openRecRaw[0]?.count || 0),
      total: Math.max(0, (recBillsRaw[0]?.total || 0) + (openRecRaw[0]?.total || 0) - (onAccountReceiptsRaw[0]?.total || 0)),
    }];
    const payables = [{
      count: (payBillsRaw[0]?.count || 0) + (openPayRaw[0]?.count || 0),
      // Stored as positive here; the response wraps with Math.abs for display.
      total: Math.max(0, (payBillsRaw[0]?.total || 0) + (openPayRaw[0]?.total || 0) - (onAccountPaymentsRaw[0]?.total || 0)),
    }];

    // Low stock count
    const lowStock = await Product.count({
      where: {
        is_active: true,
        minimum_stock_level: { [Op.gt]: 0 },
        current_stock: { [Op.lte]: col('minimum_stock_level') },
      },
    });

    // Stock value
    const stockValue = await Product.findAll({
      where: { is_active: true, current_stock: { [Op.gt]: 0 } },
      attributes: [
        [fn('COALESCE', fn('SUM', literal('"current_stock" * "purchase_rate"')), 0), 'purchase_value'],
        [fn('COALESCE', fn('SUM', literal('"current_stock" * "sale_rate"')), 0), 'sale_value'],
      ],
      raw: true,
    });

    // Recent bills
    const recentSales = await SalesBill.findAll({
      where: { is_cancelled: false },
      include: [{ model: Party, as: 'customer', attributes: ['party_name'] }],
      order: [['created_date', 'DESC']],
      limit: 10,
    });

    const recentPurchases = await PurchaseBill.findAll({
      where: { is_cancelled: false },
      include: [{ model: Party, as: 'supplier', attributes: ['party_name'] }],
      order: [['created_date', 'DESC']],
      limit: 10,
    });

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
    // Bill-level adjustments (special_discount, return_amount) are summed
    // separately from the bills table — joining with items would multiply
    // them by the line count.
    const [cogsRow] = await sequelize.query(
      `
      SELECT
        (
          SELECT COALESCE(SUM(sbi.quantity * sbi.cost_rate), 0)::float
          FROM sales_bill_items sbi
          JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
          WHERE sb.is_cancelled = false AND sb.bill_date >= :monthStart
        ) AS cogs,
        (
          SELECT COALESCE(SUM(special_discount + return_amount), 0)::float
          FROM sales_bills
          WHERE is_cancelled = false AND bill_date >= :monthStart
        ) AS adjustments
      `,
      { replacements: { monthStart }, type: sequelize.QueryTypes.SELECT }
    );
    const monthlyCOGS   = parseFloat(cogsRow.cogs) || 0;
    const monthlyAdj    = parseFloat(cogsRow.adjustments) || 0;
    const monthlyProfit = +(monthlySalesExGST - monthlyCOGS - monthlyAdj).toFixed(2);

    res.json({
      today_sales: { count: parseInt(todaySales[0].count), total: parseFloat(todaySales[0].total) },
      today_purchases: { count: parseInt(todayPurchases[0].count), total: parseFloat(todayPurchases[0].total) },
      // Monthly totals — both gross (invoice) and tax-excluded views are returned
      // so the UI can display either. monthly_profit is the CORRECT one (excl. GST).
      monthly_sales: monthlySalesGross,
      monthly_purchases: monthlyPurchGross,
      monthly_sales_excl_gst: monthlySalesExGST,
      monthly_purchases_excl_gst: monthlyPurchExGST,
      monthly_gst_collected: +monthlySalesGST.toFixed(2),
      monthly_gst_paid: +monthlyPurchGST.toFixed(2),
      monthly_gst_liability: monthlyGSTLiability,
      monthly_profit: monthlyProfit,
      receivables: { count: parseInt(receivables[0].count || 0), total: +parseFloat(receivables[0].total || 0).toFixed(2) },
      payables:    { count: parseInt(payables[0].count    || 0), total: +parseFloat(payables[0].total    || 0).toFixed(2) },
      low_stock_count: lowStock,
      stock_value: {
        purchase: parseFloat(stockValue[0].purchase_value),
        sale: parseFloat(stockValue[0].sale_value),
      },
      recent_sales: recentSales,
      recent_purchases: recentPurchases,
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.salesReport = async (req, res) => {
  try {
    const { from_date, to_date, customer_id, payment_status } = req.query;
    // Reports allow larger pages (maxLimit 1000) because exports fetch page=1&limit=10000 is common;
    // still capped so an attacker can't request limit=10^9 and hang the worker.
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit, { maxLimit: 1000 });
    const where = { is_cancelled: false };

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (payment_status) where.payment_status = payment_status;

    const { count, rows } = await SalesBill.findAndCountAll({
      where,
      include: [{ model: Party, as: 'customer', attributes: ['party_name', 'mobile_1'] }],
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
        [fn('COALESCE', fn('SUM', col('paid_amount')), 0), 'total_paid'],
        [fn('COALESCE', fn('SUM', col('balance_amount')), 0), 'total_pending'],
        [fn('COUNT', col('sales_bill_id')), 'total_bills'],
      ],
      raw: true,
    });

    const t0 = totals[0];
    const total_gst = +(parseFloat(t0.total_cgst) + parseFloat(t0.total_sgst) + parseFloat(t0.total_igst) + parseFloat(t0.total_cess)).toFixed(2);
    const summary = {
      total_bills:    parseInt(t0.total_bills),
      total_sales:    +parseFloat(t0.total_sales).toFixed(2),
      total_amount:   +parseFloat(t0.total_sales).toFixed(2),       // alias for UI code reading total_amount
      total_sub:      +parseFloat(t0.total_sub).toFixed(2),
      total_discount: +parseFloat(t0.total_discount).toFixed(2),
      total_gst,
      total_paid:     +parseFloat(t0.total_paid).toFixed(2),
      total_pending:  +parseFloat(t0.total_pending).toFixed(2),
      total_balance:  +parseFloat(t0.total_pending).toFixed(2),     // alias for UI code reading total_balance
    };

    res.json({ total: count, page, data: rows, summary });
  } catch (error) {
    console.error('Sales report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.purchaseReport = async (req, res) => {
  try {
    const { from_date, to_date, supplier_id, payment_status } = req.query;
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit, { maxLimit: 1000 });
    const where = { is_cancelled: false };

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (supplier_id) where.supplier_id = supplier_id;
    if (payment_status) where.payment_status = payment_status;

    const { count, rows } = await PurchaseBill.findAndCountAll({
      where,
      include: [{ model: Party, as: 'supplier', attributes: ['party_name', 'mobile_1'] }],
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
        [fn('COALESCE', fn('SUM', col('paid_amount')), 0), 'total_paid'],
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
      total_gst,
      total_paid:      +parseFloat(t0.total_paid).toFixed(2),
      total_pending:   +parseFloat(t0.total_pending).toFixed(2),
      total_balance:   +parseFloat(t0.total_pending).toFixed(2),   // alias for UI code reading total_balance
    };

    res.json({ total: count, page, data: rows, summary });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
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

    const where = { is_active: true };
    if (category_id) where.category_id = category_id;
    if (stock_status === 'low') {
      where.minimum_stock_level = { [Op.gt]: 0 };
      where.current_stock = { [Op.lte]: col('minimum_stock_level') };
    }
    if (stock_status === 'out') where.current_stock = { [Op.lte]: 0 };
    if (search) {
      where[Op.or] = [
        { product_name: { [Op.iLike]: `%${search}%` } },
        { barcode: { [Op.iLike]: `%${search}%` } },
        { article_number: { [Op.iLike]: `%${search}%` } },
      ];
    }

    // Dynamic sort order (whitelisted)
    const SORT_ORDERS = {
      product_name:  [['product_name', safeDir]],
      category_name: [[Category, 'category_name', safeDir], ['product_name', 'ASC']],
      current_stock: [['current_stock', safeDir], ['product_name', 'ASC']],
      purchase_rate: [['purchase_rate', safeDir], ['product_name', 'ASC']],
      sale_rate:     [['sale_rate', safeDir], ['product_name', 'ASC']],
      stock_value:   [[literal('"Product"."current_stock" * "Product"."purchase_rate"'), safeDir], ['product_name', 'ASC']],
    };
    const orderClause = SORT_ORDERS[sort_by] || SORT_ORDERS['product_name'];

    // Build parameterized WHERE for raw category-breakdown query
    const rawWhere = ['p.is_active = true'];
    const rawRepl  = {};
    if (category_id) { rawWhere.push('p.category_id = :category_id'); rawRepl.category_id = parseInt(category_id); }
    if (stock_status === 'out') rawWhere.push('p.current_stock <= 0');
    if (stock_status === 'low') rawWhere.push('p.minimum_stock_level > 0 AND p.current_stock <= p.minimum_stock_level');
    if (search) { rawWhere.push('(p.product_name ILIKE :search OR p.barcode ILIKE :search OR p.article_number ILIKE :search)'); rawRepl.search = `%${search}%`; }

    // Run all three queries in parallel
    const [products, [summaryRow], categoryBreakdown] = await Promise.all([
      Product.findAll({
        where,
        include: [{ model: Category, attributes: ['category_name'] }],
        order: orderClause,
        limit,
        offset,
      }),
      Product.findAll({
        where,
        attributes: [
          [fn('COUNT', col('product_id')), 'total_items'],
          [fn('COALESCE', fn('SUM', literal('"current_stock" * "purchase_rate"')), 0), 'total_purchase_value'],
          [fn('COALESCE', fn('SUM', literal('"current_stock" * "sale_rate"')), 0), 'total_sale_value'],
        ],
        raw: true,
      }),
      sequelize.query(`
        SELECT p.category_id, c.category_name,
          COUNT(p.product_id)::int            AS item_count,
          COALESCE(SUM(p.current_stock * p.purchase_rate), 0)::float AS stock_value
        FROM products p
        LEFT JOIN categories c ON c.category_id = p.category_id
        WHERE ${rawWhere.join(' AND ')}
        GROUP BY p.category_id, c.category_name
        ORDER BY c.category_name ASC NULLS LAST
      `, { replacements: rawRepl, type: sequelize.QueryTypes.SELECT }),
    ]);

    const totalPV = parseFloat(summaryRow.total_purchase_value || 0);
    const totalSV = parseFloat(summaryRow.total_sale_value || 0);

    res.json({
      data: products,
      total: parseInt(summaryRow.total_items || 0),
      summary: {
        total_items: parseInt(summaryRow.total_items || 0),
        total_purchase_value: +totalPV.toFixed(2),
        total_sale_value: +totalSV.toFixed(2),
        potential_profit: +(totalSV - totalPV).toFixed(2),
      },
      category_breakdown: categoryBreakdown,
    });
  } catch (error) {
    console.error('Stock report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.profitLoss = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const dateWhere = {};
    if (from_date && to_date) dateWhere.bill_date = { [Op.between]: [from_date, to_date] };

    // Pull gross totals AND GST components. GST is collected on behalf of the tax
    // authority and is NOT revenue; similarly input GST paid is a credit, not cost.
    // Gross profit must be computed from tax-EXCLUDED figures to be accounting-correct.
    const sales = await SalesBill.findAll({
      where: { ...dateWhere, is_cancelled: false },
      attributes: [
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
        [fn('COALESCE', fn('SUM', col('cgst_amount')), 0), 'cgst'],
        [fn('COALESCE', fn('SUM', col('sgst_amount')), 0), 'sgst'],
        [fn('COALESCE', fn('SUM', col('igst_amount')), 0), 'igst'],
        [fn('COALESCE', fn('SUM', col('cess_amount')), 0), 'cess'],
      ],
      raw: true,
    });

    const purchases = await PurchaseBill.findAll({
      where: { ...dateWhere, is_cancelled: false },
      attributes: [
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total'],
        [fn('COALESCE', fn('SUM', col('cgst_amount')), 0), 'cgst'],
        [fn('COALESCE', fn('SUM', col('sgst_amount')), 0), 'sgst'],
        [fn('COALESCE', fn('SUM', col('igst_amount')), 0), 'igst'],
        [fn('COALESCE', fn('SUM', col('cess_amount')), 0), 'cess'],
      ],
      raw: true,
    });

    const s = sales[0], p = purchases[0];
    const salesGross      = parseFloat(s.total);
    const purchGross      = parseFloat(p.total);
    const salesGST        = parseFloat(s.cgst) + parseFloat(s.sgst) + parseFloat(s.igst) + parseFloat(s.cess);
    const purchGST        = parseFloat(p.cgst) + parseFloat(p.sgst) + parseFloat(p.igst) + parseFloat(p.cess);
    const salesExGST      = +(salesGross - salesGST).toFixed(2);
    const purchExGST      = +(purchGross - purchGST).toFixed(2);

    const salesReturn     = 0; // TODO: implement returns when return module ships
    const purchaseReturn  = 0;
    const netSales        = +(salesExGST - salesReturn).toFixed(2);
    const netPurchases    = +(purchExGST - purchaseReturn).toFixed(2);

    // Real gross profit — use per-line COGS (sales_bill_items.cost_rate × qty)
    // instead of the cruder netSales − netPurchases. Prior math double-counted
    // inventory: stock bought in the period but not yet sold was treated as an
    // expense, understating margin. Using COGS on items actually sold matches
    // standard accounting and stays consistent with the per-party profit
    // endpoint used by the Customer page. Bill-level adjustments are summed
    // from the bills table directly — joining items would multiply them.
    const cogsItemsFilter = (from_date && to_date)
      ? `AND sb.bill_date BETWEEN :from_date AND :to_date`
      : '';
    const cogsBillsFilter = (from_date && to_date)
      ? `AND bill_date BETWEEN :from_date AND :to_date`
      : '';
    const [cogsRow] = await sequelize.query(
      `
      SELECT
        (
          SELECT COALESCE(SUM(sbi.quantity * sbi.cost_rate), 0)::float
          FROM sales_bill_items sbi
          JOIN sales_bills sb ON sb.sales_bill_id = sbi.sales_bill_id
          WHERE sb.is_cancelled = false ${cogsItemsFilter}
        ) AS cogs,
        (
          SELECT COALESCE(SUM(special_discount + return_amount), 0)::float
          FROM sales_bills
          WHERE is_cancelled = false ${cogsBillsFilter}
        ) AS adjustments
      `,
      { replacements: { from_date, to_date }, type: sequelize.QueryTypes.SELECT }
    );
    const cogs            = parseFloat(cogsRow.cogs) || 0;
    const billAdjustments = parseFloat(cogsRow.adjustments) || 0;
    const grossProfit     = +(netSales - cogs - billAdjustments).toFixed(2);
    const gstLiability    = +(salesGST - purchGST).toFixed(2); // output – input credit

    res.json({
      revenue: {
        sales_gross: salesGross,      // invoice total (incl. GST)
        sales: salesExGST,            // tax-excluded sales (the correct P&L revenue line)
        sales_return: salesReturn,
        net_sales: netSales,
      },
      cost_of_goods: {
        purchases_gross: purchGross,  // invoice total (incl. GST)
        purchases: purchExGST,        // tax-excluded purchases (the correct COGS input)
        purchase_return: purchaseReturn,
        net_purchases: netPurchases,
      },
      taxes: {
        gst_collected: +salesGST.toFixed(2), // output GST (owed to authority)
        gst_paid: +purchGST.toFixed(2),      // input GST credit
        gst_liability: gstLiability,         // net GST payable (if positive)
      },
      cogs: +cogs.toFixed(2),
      bill_adjustments: +billAdjustments.toFixed(2),
      gross_profit: grossProfit,
      gross_margin: netSales > 0 ? +((grossProfit / netSales) * 100).toFixed(1) : 0,
      net_profit: grossProfit,
    });
  } catch (error) {
    console.error('P&L error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.partyOutstanding = async (req, res) => {
  try {
    const { party_type } = req.query;

    // Compute live outstanding per party from bills + opening balance - on-account
    // payments. Avoids relying on Party.current_balance cache which can drift
    // and mislead finance teams chasing receivables.
    const buildQuery = (mode) => {
      if (mode === 'Customer') {
        return `
          SELECT p.party_id, p.party_name, p.party_type, p.mobile_1,
                 p.credit_limit, p.credit_days,
                 (
                   COALESCE((
                     SELECT SUM(sb.balance_amount) FROM sales_bills sb
                     WHERE sb.customer_id = p.party_id AND sb.is_cancelled = false
                   ), 0)
                   + CASE WHEN p.opening_balance_type = 'Receivable' THEN COALESCE(p.opening_balance, 0) ELSE 0 END
                   - CASE WHEN p.opening_balance_type = 'Payable'    THEN COALESCE(p.opening_balance, 0) ELSE 0 END
                   - COALESCE((
                     SELECT SUM(pr.total_amount) FROM payments_receipts pr
                     WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Receipt'
                       AND pr.is_cancelled = false
                       AND NOT EXISTS (SELECT 1 FROM payment_splits ps WHERE ps.transaction_id = pr.transaction_id)
                   ), 0)
                 )::float AS current_balance
          FROM parties p
          WHERE p.is_active = true AND p.party_type IN ('Customer','Both')
        `;
      }
      return `
        SELECT p.party_id, p.party_name, p.party_type, p.mobile_1,
               p.credit_limit, p.credit_days,
               (
                 -- Supplier side: stored as NEGATIVE for "we owe them"
                 -COALESCE((
                   SELECT SUM(pb.balance_amount) FROM purchase_bills pb
                   WHERE pb.supplier_id = p.party_id AND pb.is_cancelled = false
                 ), 0)
                 + CASE WHEN p.opening_balance_type = 'Receivable' THEN COALESCE(p.opening_balance, 0) ELSE 0 END
                 - CASE WHEN p.opening_balance_type = 'Payable'    THEN COALESCE(p.opening_balance, 0) ELSE 0 END
                 + COALESCE((
                   SELECT SUM(pr.total_amount) FROM payments_receipts pr
                   WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Payment'
                     AND pr.is_cancelled = false
                     AND NOT EXISTS (SELECT 1 FROM payment_splits ps WHERE ps.transaction_id = pr.transaction_id)
                 ), 0)
               )::float AS current_balance
        FROM parties p
        WHERE p.is_active = true AND p.party_type IN ('Supplier','Both')
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
    res.status(500).json({ error: 'Server error' });
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
    const { from_date, to_date, customer_id, payment_status } = req.query;
    const where = { is_cancelled: false };
    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (payment_status) where.payment_status = payment_status;

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

    // Totals row
    if (rows.length) {
      const totalRow = ws.addRow({
        bill_number: `TOTAL (${rows.length})`,
        sub_total:       rows.reduce((s, r) => s + toMoney(r.sub_total), 0),
        discount_amount: rows.reduce((s, r) => s + toMoney(r.discount_amount), 0),
        cgst_amount:     rows.reduce((s, r) => s + toMoney(r.cgst_amount), 0),
        sgst_amount:     rows.reduce((s, r) => s + toMoney(r.sgst_amount), 0),
        igst_amount:     rows.reduce((s, r) => s + toMoney(r.igst_amount), 0),
        cess_amount:     rows.reduce((s, r) => s + toMoney(r.cess_amount), 0),
        total_amount:    rows.reduce((s, r) => s + toMoney(r.total_amount), 0),
        paid_amount:     rows.reduce((s, r) => s + toMoney(r.paid_amount), 0),
        balance_amount:  rows.reduce((s, r) => s + toMoney(r.balance_amount), 0),
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
    const { from_date, to_date, supplier_id, payment_status } = req.query;
    const where = { is_cancelled: false };
    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (supplier_id) where.supplier_id = supplier_id;
    if (payment_status) where.payment_status = payment_status;

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
      const totalRow = ws.addRow({
        bill_number: `TOTAL (${rows.length})`,
        sub_total:       rows.reduce((s, r) => s + toMoney(r.sub_total), 0),
        discount_amount: rows.reduce((s, r) => s + toMoney(r.discount_amount), 0),
        cgst_amount:     rows.reduce((s, r) => s + toMoney(r.cgst_amount), 0),
        sgst_amount:     rows.reduce((s, r) => s + toMoney(r.sgst_amount), 0),
        igst_amount:     rows.reduce((s, r) => s + toMoney(r.igst_amount), 0),
        cess_amount:     rows.reduce((s, r) => s + toMoney(r.cess_amount), 0),
        total_amount:    rows.reduce((s, r) => s + toMoney(r.total_amount), 0),
        paid_amount:     rows.reduce((s, r) => s + toMoney(r.paid_amount), 0),
        balance_amount:  rows.reduce((s, r) => s + toMoney(r.balance_amount), 0),
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
    const where = { is_active: true };
    if (category_id) where.category_id = category_id;
    if (stock_status === 'low') {
      where.minimum_stock_level = { [Op.gt]: 0 };
      where.current_stock = { [Op.lte]: col('minimum_stock_level') };
    }
    if (stock_status === 'out') where.current_stock = { [Op.lte]: 0 };
    if (search) {
      where[Op.or] = [
        { product_name: { [Op.iLike]: `%${search}%` } },
        { barcode: { [Op.iLike]: `%${search}%` } },
        { article_number: { [Op.iLike]: `%${search}%` } },
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

    let totalPV = 0, totalSV = 0;
    products.forEach(p => {
      const cs = toMoney(p.current_stock);
      const pr = toMoney(p.purchase_rate);
      const sr = toMoney(p.sale_rate);
      const pv = cs * pr;
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
        purchase_rate: pr,
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

    // Re-use the same buildQuery logic as partyOutstanding by duplicating it here
    // (keeping exports self-contained so filter changes don't break by accident).
    const buildQuery = (type) => `
      SELECT p.party_id, p.party_name, p.mobile_1, p.party_type, p.gstin,
        (CASE WHEN p.opening_balance_type = 'Payable'
              THEN -COALESCE(p.opening_balance, 0) ELSE COALESCE(p.opening_balance, 0) END
          + COALESCE((SELECT SUM(balance_amount) FROM sales_bills
                      WHERE customer_id = p.party_id AND is_cancelled = false), 0)
          - COALESCE((SELECT SUM(balance_amount) FROM purchase_bills
                      WHERE supplier_id = p.party_id AND is_cancelled = false), 0)
        )::float AS current_balance
      FROM parties p
      WHERE p.party_type IN ('${type}', 'Both') AND p.party_status = 'Active'
    `;

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
