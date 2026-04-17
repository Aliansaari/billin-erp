const { Op, col } = require('sequelize');
const { Product, Category, StockLedger } = require('../models');
const { generateBarcode, findExistingProduct } = require('../utils/barcode');
const { sanitizePagination } = require('../utils/helpers');

// Whitelist of fields clients may send via POST/PUT to Product.create/update.
// Excludes product_id (PK), created_date, modified_date — server-owned columns.
// current_stock IS included because /adjust and /update legitimately recompute
// it from opening-stock changes; the server clamps it to ≥ 0 in those paths.
const PRODUCT_UPDATABLE_FIELDS = [
  'barcode', 'category_id', 'product_name', 'product_description',
  'size_value', 'size_unit', 'article_number', 'hsn_code',
  'gst_rate', 'cess_rate', 'unit_of_measurement', 'quantity_per_box',
  'minimum_stock_level', 'maximum_stock_level', 'reorder_level',
  'opening_stock', 'opening_stock_rate', 'opening_stock_date',
  'current_stock',
  'purchase_rate', 'margin_percentage', 'sale_rate', 'mrp',
  'is_active',
];

exports.getAll = async (req, res) => {
  try {
    const { search, category_id, stock_status, name_only, name_exact } = req.query;
    // Clamp page/limit (see helpers.sanitizePagination).
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_active: true };

    if (search) {
      if (name_exact === 'true') {
        // Variant picker: exact product-name match — needed to escape the 200-row cap
        // when the substring `%PLAZO%` would pull in hundreds of unrelated rows.
        where.product_name = { [Op.iLike]: search };
      } else if (name_only === 'true') {
        // Sales/purchase form: search only by product name — no article/barcode noise
        where.product_name = { [Op.iLike]: `%${search}%` };
      } else {
        // Product management page: full search across name, barcode, article
        where[Op.or] = [
          { product_name: { [Op.iLike]: `%${search}%` } },
          { barcode: { [Op.iLike]: `%${search}%` } },
          { article_number: { [Op.iLike]: `%${search}%` } },
        ];
      }
    }
    if (category_id) where.category_id = category_id;
    // "Low stock" means BELOW a configured reorder level — products with no level set (0)
    // should never count as "low" just because current_stock also happens to be 0.
    // Without the > 0 guard, every freshly imported product with 0 opening stock and
    // no min level flooded the dashboard low-stock alert — pure noise.
    if (stock_status === 'low') {
      where.current_stock = { [Op.lte]: col('minimum_stock_level') };
      where.minimum_stock_level = { [Op.gt]: 0 };
    }
    if (stock_status === 'out') where.current_stock = { [Op.lte]: 0 };

    // When searching by name: prioritise "starts with" results over "contains" results
    const { literal } = require('sequelize');
    const orderClause = (search && name_only === 'true')
      ? [
          [literal(`CASE WHEN "product_name" ILIKE '${search.replace(/'/g, "''")}%' THEN 0 ELSE 1 END`), 'ASC'],
          ['product_name', 'ASC'],
        ]
      : [['product_name', 'ASC']];

    const { count, rows } = await Product.findAndCountAll({
      where,
      include: [{ model: Category, attributes: ['category_name'] }],
      order: orderClause,
      limit,
      offset,
    });

    res.json({ total: count, page, limit, data: rows });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Reserve the next barcode by incrementing the counter and returning the generated value.
// Used by purchase/sales forms so new items can display their barcode immediately,
// before the bill is saved. The reserved barcode is sent back with the item payload
// and used as-is by resolveOrCreateProduct when the product is actually created.
exports.getNextBarcode = async (req, res) => {
  try {
    const barcode = await generateBarcode();
    res.json({ barcode });
  } catch (error) {
    console.error('Next-barcode error:', error);
    res.status(500).json({ error: 'Failed to reserve barcode' });
  }
};

exports.getByBarcode = async (req, res) => {
  try {
    const product = await Product.findOne({
      where: { barcode: req.params.barcode },
      include: [{ model: Category, attributes: ['category_name'] }],
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id, {
      include: [{ model: Category, attributes: ['category_name'] }],
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    // Strip to whitelisted columns before unpacking the opening-stock trio.
    const safe = {};
    for (const k of PRODUCT_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    const { opening_stock, opening_stock_rate, opening_stock_date, ...data } = safe;

    // Check for existing product with same specs
    const existing = await findExistingProduct(Product, data);
    if (existing) {
      return res.json({ existing: true, product: existing });
    }

    // Generate barcode if not provided
    if (!data.barcode) {
      data.barcode = await generateBarcode();
    }

    // Calculate sale rate from margin if not set
    if (data.purchase_rate && data.margin_percentage && !data.sale_rate) {
      data.sale_rate = +(data.purchase_rate * (1 + data.margin_percentage / 100)).toFixed(2);
    }

    // Set opening stock as current_stock
    const openingQty = parseFloat(opening_stock || 0);
    if (openingQty > 0) data.current_stock = openingQty;

    const product = await Product.create(data);

    // Create Opening Stock ledger entry
    if (openingQty > 0) {
      await StockLedger.create({
        product_id: product.product_id,
        barcode: product.barcode,
        transaction_type: 'Opening Stock',
        transaction_date: opening_stock_date || new Date().toISOString().split('T')[0],
        reference_number: 'OPENING',
        quantity_in: openingQty,
        quantity_out: 0,
        rate: parseFloat(opening_stock_rate || data.purchase_rate || 0),
        balance_quantity: openingQty,
        remarks: 'Opening Stock',
        created_by: req.user?.user_id,
      });
    }

    const result = await Product.findByPk(product.product_id, {
      include: [{ model: Category, attributes: ['category_name'] }],
    });
    res.status(201).json(result);
  } catch (error) {
    console.error('Create product error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Barcode already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
};

exports.update = async (req, res) => {
  const sequelizeDb = require('../config/database');
  const t = await sequelizeDb.transaction();
  try {
    const safe = {};
    for (const k of PRODUCT_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    const { opening_stock, opening_stock_rate, opening_stock_date, ...data } = safe;
    const product = await Product.findByPk(req.params.id, { transaction: t });
    if (!product) { await t.rollback(); return res.status(404).json({ error: 'Product not found' }); }

    // Handle opening stock change
    const newOpeningQty = parseFloat(opening_stock ?? '');
    if (!isNaN(newOpeningQty) && opening_stock !== undefined && opening_stock !== null && opening_stock !== '') {
      // CRITICAL: Read the OLD opening-stock row BEFORE destroying it, otherwise
      // the recalculation uses oldQty=0 and current_stock drifts by the old opening.
      // Example before fix: opening 100, current 110 → set opening 50 → current = 110 - 0 + 50 = 160 (wrong)
      // After fix: current = 110 - 100 + 50 = 60 (correct)
      const oldOpeningRow = await StockLedger.findOne({
        where: { product_id: req.params.id, transaction_type: 'Opening Stock' },
        transaction: t,
      });
      const oldQty = parseFloat(oldOpeningRow?.quantity_in || 0);

      // Now safe to remove the old row
      await StockLedger.destroy({
        where: { product_id: req.params.id, transaction_type: 'Opening Stock' },
        transaction: t,
      });

      if (newOpeningQty > 0) {
        const newStock = +((parseFloat(product.current_stock) - oldQty + newOpeningQty)).toFixed(2);
        // Clamp at 0: going negative would mean we sold/consumed more than on hand,
        // which is a data-integrity issue that shouldn't be introduced by this edit.
        data.current_stock = Math.max(0, newStock);

        await StockLedger.create({
          product_id: req.params.id,
          barcode: product.barcode,
          transaction_type: 'Opening Stock',
          transaction_date: opening_stock_date || new Date().toISOString().split('T')[0],
          reference_number: 'OPENING',
          quantity_in: newOpeningQty,
          quantity_out: 0,
          rate: parseFloat(opening_stock_rate || data.purchase_rate || product.purchase_rate || 0),
          balance_quantity: newOpeningQty,
          remarks: 'Opening Stock',
          created_by: req.user?.user_id,
        }, { transaction: t });
      } else {
        // Opening stock set to 0 — subtract the previously-stored opening qty from current_stock
        const newStock = +((parseFloat(product.current_stock) - oldQty)).toFixed(2);
        data.current_stock = Math.max(0, newStock);
      }
    }

    await product.update(data, { transaction: t });
    await t.commit();

    const result = await Product.findByPk(product.product_id, {
      include: [{ model: Category, attributes: ['category_name'] }],
    });
    res.json(result);
  } catch (error) {
    // Guard against double-rollback: early validation branches already rolled
    // back the transaction. `t.finished` is set to 'commit' | 'rollback' by
    // Sequelize after either completes, so we can tell whether a rollback is
    // still needed without calling it twice.
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.delete = async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    // Block deletion if any transactions exist (excluding Opening Stock only)
    const txCount = await StockLedger.count({
      where: {
        product_id: req.params.id,
        transaction_type: { [Op.notIn]: ['Opening Stock'] },
      },
    });
    if (txCount > 0) {
      return res.status(400).json({
        error: `Cannot deactivate "${product.product_name}" — it has ${txCount} transaction(s) (sales/purchases). Archive it instead by removing from active lists, or adjust stock to zero.`,
      });
    }

    await product.update({ is_active: false });
    res.json({ message: 'Product deactivated' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.adjust = async (req, res) => {
  const sequelizeDb = require('../config/database');
  const t = await sequelizeDb.transaction();
  try {
    const { current_stock, purchase_rate, sale_rate, minimum_stock_level } = req.body;
    const product = await Product.findByPk(req.params.id, { transaction: t });
    if (!product) { await t.rollback(); return res.status(404).json({ error: 'Product not found' }); }

    const updateData = {};
    if (purchase_rate !== undefined && purchase_rate !== '') updateData.purchase_rate = parseFloat(purchase_rate);
    if (sale_rate !== undefined && sale_rate !== '') updateData.sale_rate = parseFloat(sale_rate);
    if (minimum_stock_level !== undefined && minimum_stock_level !== '') updateData.minimum_stock_level = parseFloat(minimum_stock_level);

    // If stock is being changed, compute diff against the LEDGER balance (source of truth)
    // so the ledger entry is always correct even if product.current_stock was previously out of sync.
    if (current_stock !== undefined && current_stock !== '') {
      const newStock = parseFloat(current_stock);
      updateData.current_stock = newStock;

      const oldStock = parseFloat(product.current_stock || 0);
      const stockDiff = +( newStock - oldStock ).toFixed(2);

      // Only create a ledger entry when the stock actually changes
      if (stockDiff !== 0) {
        const today = new Date().toISOString().split('T')[0];
        const dateLabel = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

        await StockLedger.create({
          product_id: product.product_id,
          barcode: product.barcode,
          transaction_type: 'Stock Adjustment',
          transaction_date: today,
          reference_number: 'ADJ',
          quantity_in:  stockDiff > 0 ? +stockDiff.toFixed(2) : 0,
          quantity_out: stockDiff < 0 ? +Math.abs(stockDiff).toFixed(2) : 0,
          rate: parseFloat(purchase_rate || product.purchase_rate || 0),
          balance_quantity: +newStock.toFixed(2),
          remarks: `Adjusted on ${dateLabel}`,
          created_by: req.user?.user_id,
        }, { transaction: t });
      }
    }

    await product.update(updateData, { transaction: t });
    await t.commit();

    const result = await Product.findByPk(product.product_id, {
      include: [{ model: Category, attributes: ['category_name'] }],
    });
    res.json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Adjust product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getLowStock = async (req, res) => {
  try {
    // Use Sequelize.col() to compare two columns (imported at top of file).
    // Without the import this endpoint previously threw ReferenceError.
    const products = await Product.findAll({
      where: {
        is_active: true,
        current_stock: { [Op.lte]: col('minimum_stock_level') },
        minimum_stock_level: { [Op.gt]: 0 },
      },
      include: [{ model: Category, attributes: ['category_name'] }],
      order: [['current_stock', 'ASC']],
    });
    res.json(products);
  } catch (error) {
    console.error('Get low stock error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getStockMovement = async (req, res) => {
  try {
    const { id } = req.params;
    const { from_date, to_date } = req.query;

    const sequelizeDb = require('../config/database');

    const where = { product_id: id };
    if (from_date && to_date) {
      where.transaction_date = { [Op.between]: [from_date, to_date] };
    }

    const movements = await StockLedger.findAll({
      where,
      order: [['transaction_date', 'ASC'], ['created_date', 'ASC']],
    });

    // Enrich with party names by looking up bills
    const purchaseIds = [];
    const salesIds = [];
    movements.forEach(m => {
      const type = m.transaction_type;
      if ((type === 'Purchase' || type === 'Purchase Return') && m.reference_id) purchaseIds.push(m.reference_id);
      if ((type === 'Sales' || type === 'Sales Return') && m.reference_id) salesIds.push(m.reference_id);
    });

    // Build party name maps by joining bills → parties directly via SQL
    const purchaseMap = {};
    const salesMap = {};

    if (purchaseIds.length) {
      const rows = await sequelizeDb.query(
        `SELECT pb.purchase_bill_id, p.party_name
         FROM purchase_bills pb
         JOIN parties p ON p.party_id = pb.supplier_id
         WHERE pb.purchase_bill_id IN (:ids)`,
        { replacements: { ids: purchaseIds }, type: sequelizeDb.QueryTypes.SELECT }
      );
      rows.forEach(r => { purchaseMap[r.purchase_bill_id] = r.party_name || ''; });
    }

    if (salesIds.length) {
      const rows = await sequelizeDb.query(
        `SELECT sb.sales_bill_id, p.party_name
         FROM sales_bills sb
         JOIN parties p ON p.party_id = sb.customer_id
         WHERE sb.sales_bill_id IN (:ids)`,
        { replacements: { ids: salesIds }, type: sequelizeDb.QueryTypes.SELECT }
      );
      rows.forEach(r => { salesMap[r.sales_bill_id] = r.party_name || ''; });
    }

    const enriched = movements.map(m => {
      const plain = m.toJSON();
      const type = plain.transaction_type;
      if ((type === 'Purchase' || type === 'Purchase Return') && plain.reference_id) {
        plain.party_name = purchaseMap[plain.reference_id] || plain.remarks || '';
      } else if ((type === 'Sales' || type === 'Sales Return') && plain.reference_id) {
        plain.party_name = salesMap[plain.reference_id] || 'Cash Sale';
      } else {
        plain.party_name = plain.remarks || '';
      }
      return plain;
    });

    res.json(enriched);
  } catch (error) {
    console.error('getStockMovement error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
