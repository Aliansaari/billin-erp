const { Op, fn, col, literal } = require('sequelize');
const sequelize = require('../config/database');
const { SalesBill, SalesBillItem, PurchaseBill, PurchaseBillItem, Party, Product, Category, PaymentReceipt, StockLedger } = require('../models');

exports.dashboardStats = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
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

    // Monthly sales
    const monthlySales = await SalesBill.findAll({
      where: { bill_date: { [Op.gte]: monthStart }, is_cancelled: false },
      attributes: [[fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total']],
      raw: true,
    });

    // Monthly purchases
    const monthlyPurchases = await PurchaseBill.findAll({
      where: { bill_date: { [Op.gte]: monthStart }, is_cancelled: false },
      attributes: [[fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total']],
      raw: true,
    });

    // Total receivables
    const receivables = await Party.findAll({
      where: { current_balance: { [Op.gt]: 0 }, party_type: { [Op.in]: ['Customer', 'Both'] } },
      attributes: [
        [fn('COUNT', col('party_id')), 'count'],
        [fn('COALESCE', fn('SUM', col('current_balance')), 0), 'total'],
      ],
      raw: true,
    });

    // Total payables
    const payables = await Party.findAll({
      where: { current_balance: { [Op.lt]: 0 }, party_type: { [Op.in]: ['Supplier', 'Both'] } },
      attributes: [
        [fn('COUNT', col('party_id')), 'count'],
        [fn('COALESCE', fn('SUM', col('current_balance')), 0), 'total'],
      ],
      raw: true,
    });

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

    res.json({
      today_sales: { count: parseInt(todaySales[0].count), total: parseFloat(todaySales[0].total) },
      today_purchases: { count: parseInt(todayPurchases[0].count), total: parseFloat(todayPurchases[0].total) },
      monthly_sales: parseFloat(monthlySales[0].total),
      monthly_purchases: parseFloat(monthlyPurchases[0].total),
      monthly_profit: parseFloat(monthlySales[0].total) - parseFloat(monthlyPurchases[0].total),
      receivables: { count: parseInt(receivables[0].count), total: parseFloat(receivables[0].total) },
      payables: { count: parseInt(payables[0].count), total: Math.abs(parseFloat(payables[0].total)) },
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
    const { from_date, to_date, customer_id, payment_status, page = 1, limit = 50 } = req.query;
    const where = { is_cancelled: false };

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (payment_status) where.payment_status = payment_status;

    const offset = (page - 1) * limit;
    const { count, rows } = await SalesBill.findAndCountAll({
      where,
      include: [{ model: Party, as: 'customer', attributes: ['party_name', 'mobile_1'] }],
      order: [['bill_date', 'DESC']],
      limit: parseInt(limit),
      offset,
    });

    // Totals
    const totals = await SalesBill.findAll({
      where,
      attributes: [
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total_sales'],
        [fn('COALESCE', fn('SUM', col('paid_amount')), 0), 'total_paid'],
        [fn('COALESCE', fn('SUM', col('balance_amount')), 0), 'total_pending'],
        [fn('COUNT', col('sales_bill_id')), 'total_bills'],
      ],
      raw: true,
    });

    res.json({ total: count, page: parseInt(page), data: rows, summary: totals[0] });
  } catch (error) {
    console.error('Sales report error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.purchaseReport = async (req, res) => {
  try {
    const { from_date, to_date, supplier_id, payment_status, page = 1, limit = 50 } = req.query;
    const where = { is_cancelled: false };

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (supplier_id) where.supplier_id = supplier_id;
    if (payment_status) where.payment_status = payment_status;

    const offset = (page - 1) * limit;
    const { count, rows } = await PurchaseBill.findAndCountAll({
      where,
      include: [{ model: Party, as: 'supplier', attributes: ['party_name', 'mobile_1'] }],
      order: [['bill_date', 'DESC']],
      limit: parseInt(limit),
      offset,
    });

    const totals = await PurchaseBill.findAll({
      where,
      attributes: [
        [fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total_purchases'],
        [fn('COALESCE', fn('SUM', col('paid_amount')), 0), 'total_paid'],
        [fn('COALESCE', fn('SUM', col('balance_amount')), 0), 'total_pending'],
        [fn('COUNT', col('purchase_bill_id')), 'total_bills'],
      ],
      raw: true,
    });

    res.json({ total: count, page: parseInt(page), data: rows, summary: totals[0] });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.stockReport = async (req, res) => {
  try {
    const { category_id, stock_status, search, page = 1, limit = 100,
            sort_by = 'product_name', sort_dir = 'ASC' } = req.query;

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

    const offset = (parseInt(page) - 1) * parseInt(limit);

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
        limit: parseInt(limit),
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

    const sales = await SalesBill.findAll({
      where: { ...dateWhere, is_cancelled: false },
      attributes: [[fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total']],
      raw: true,
    });

    const purchases = await PurchaseBill.findAll({
      where: { ...dateWhere, is_cancelled: false },
      attributes: [[fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total']],
      raw: true,
    });

    const salesReturn = 0; // TODO: implement returns
    const purchaseReturn = 0;

    const netSales = parseFloat(sales[0].total) - salesReturn;
    const netPurchases = parseFloat(purchases[0].total) - purchaseReturn;
    const grossProfit = netSales - netPurchases;

    res.json({
      revenue: {
        sales: parseFloat(sales[0].total),
        sales_return: salesReturn,
        net_sales: netSales,
      },
      cost_of_goods: {
        purchases: parseFloat(purchases[0].total),
        purchase_return: purchaseReturn,
        net_purchases: netPurchases,
      },
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
    const where = { is_active: true };
    if (party_type === 'Customer') {
      where.party_type = { [Op.in]: ['Customer', 'Both'] };
      where.current_balance = { [Op.gt]: 0 };
    } else if (party_type === 'Supplier') {
      where.party_type = { [Op.in]: ['Supplier', 'Both'] };
      where.current_balance = { [Op.lt]: 0 };
    }

    const parties = await Party.findAll({
      where,
      attributes: ['party_id', 'party_name', 'party_type', 'mobile_1', 'current_balance', 'credit_limit', 'credit_days'],
      order: [[fn('ABS', col('current_balance')), 'DESC']],
    });

    const total = parties.reduce((sum, p) => sum + Math.abs(parseFloat(p.current_balance)), 0);

    res.json({ data: parties, total: +total.toFixed(2) });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};
