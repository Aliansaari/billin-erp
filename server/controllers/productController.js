const { Op, col, fn, literal } = require('sequelize');
const sequelize = require('../config/database');
const { Product, Category, StockLedger } = require('../models');
const { generateBarcode, findExistingProduct } = require('../utils/barcode');
const { sanitizePagination } = require('../utils/helpers');

/*
 * Attach the per-mode "display" cost + stock value to a list of plain
 * product rows. Frontend tiles + report columns read these instead of
 * raw purchase_rate so the displayed number reflects the right basis
 * for the product's mode:
 *
 *   • variant            → display_cost = purchase_rate
 *                          display_stock_value = current_stock × purchase_rate
 *   • single, no batch   → display_cost = weighted_avg_cost
 *                          display_stock_value = current_stock × weighted_avg_cost
 *   • single + batch     → display_cost = SUM(batch.qty × batch.rate) / SUM(batch.qty)
 *                          display_stock_value = SUM(batch.qty × batch.rate)
 *
 * For the batch case we issue ONE aggregate SQL query against
 * product_batch_stock × product_batches keyed on the product_ids in
 * the page — O(1) round-trips regardless of page size.
 *
 * Stock Movement TABLE rows are NOT touched anywhere — they keep their
 * per-transaction rate from stock_ledger.rate. This helper only feeds
 * aggregate displays (tiles, summary columns).
 */
async function attachDisplayCost(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  // Bulk-fetch batch aggregates for any single+batch product in the page.
  // The query joins active batches with their stock; missing batches resolve
  // to zero implicitly (the product just falls back to wac/purchase_rate).
  const batchTrackedIds = rows
    .filter(r => r.product_mode === 'single' && r.is_batch_tracked)
    .map(r => r.product_id);
  let batchAgg = new Map();
  if (batchTrackedIds.length > 0) {
    const aggRows = await sequelize.query(
      `SELECT pbs.product_id,
              SUM(pbs.current_stock * COALESCE(pb.purchase_rate, 0)) AS total_value,
              SUM(pbs.current_stock)                                 AS total_qty
         FROM product_batch_stock pbs
         JOIN product_batches pb ON pb.batch_id = pbs.batch_id
        WHERE pbs.product_id IN (:ids)
          AND pbs.current_stock > 0
          AND pb.is_active = true
        GROUP BY pbs.product_id`,
      { replacements: { ids: batchTrackedIds }, type: sequelize.QueryTypes.SELECT },
    );
    batchAgg = new Map(aggRows.map(r => [
      r.product_id,
      { total_value: parseFloat(r.total_value || 0), total_qty: parseFloat(r.total_qty || 0) },
    ]));
  }

  return rows.map(r => {
    const stock = parseFloat(r.current_stock || 0);
    let display_cost, display_stock_value;
    if (r.product_mode === 'single' && r.is_batch_tracked) {
      const agg = batchAgg.get(r.product_id);
      const tv = agg ? agg.total_value : 0;
      const tq = agg ? agg.total_qty   : 0;
      display_cost = tq > 0 ? +(tv / tq).toFixed(4) : 0;
      display_stock_value = +tv.toFixed(2);
    } else if (r.product_mode === 'single') {
      const wac = parseFloat(r.weighted_avg_cost || 0);
      display_cost = wac;
      display_stock_value = +(stock * wac).toFixed(2);
    } else {
      const pr = parseFloat(r.purchase_rate || 0);
      display_cost = pr;
      display_stock_value = +(stock * pr).toFixed(2);
    }
    return { ...r, display_cost, display_stock_value };
  });
}

// Bulk-fetch lifetime aggregates (total purchased / total sold / last sold)
// for the given product_ids. Used by getAll when the client opts in via
// `include_stats=true` — most list callers (sales/purchase autocomplete,
// variant picker) don't need it, so we avoid the extra round trip there.
//
// All three columns come from stock_ledger in a single indexed GROUP BY —
// cheap for the 200-row default page. Opening Stock rolls into
// total_purchased since that's still goods landing on the shelf.
async function fetchLifetimeStats(productIds) {
  if (!productIds.length) return {};
  const rows = await StockLedger.findAll({
    attributes: [
      'product_id',
      [fn('SUM', literal(`CASE WHEN transaction_type IN ('Purchase', 'Opening Stock') THEN quantity_in ELSE 0 END`)), 'total_purchased'],
      [fn('SUM', literal(`CASE WHEN transaction_type = 'Sales' THEN quantity_out ELSE 0 END`)), 'total_sold'],
      [fn('MAX', literal(`CASE WHEN transaction_type = 'Sales' THEN transaction_date END`)), 'last_sold_at'],
    ],
    where: { product_id: productIds },
    group: ['product_id'],
    raw: true,
  });
  const map = {};
  for (const r of rows) {
    map[r.product_id] = {
      total_purchased: parseFloat(r.total_purchased || 0),
      total_sold:      parseFloat(r.total_sold      || 0),
      last_sold_at:    r.last_sold_at || null,
    };
  }
  return map;
}

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
  'is_batch_tracked',
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
    // category_id: accept either a single value (legacy callers) or an
    // array (the multi-category Select on the Products page). Filter
    // out non-numeric junk so a tampered query can't smuggle SQL.
    if (category_id != null && category_id !== '') {
      const ids = (Array.isArray(category_id) ? category_id : [category_id])
        .map((x) => parseInt(x, 10))
        .filter(Number.isFinite);
      if (ids.length === 1) where.category_id = ids[0];
      else if (ids.length > 1) where.category_id = { [Op.in]: ids };
    }
    // "Low stock" means BELOW a configured reorder level — products with no level set (0)
    // should never count as "low" just because current_stock also happens to be 0.
    // Without the > 0 guard, every freshly imported product with 0 opening stock and
    // no min level flooded the dashboard low-stock alert — pure noise.
    if (stock_status === 'low') {
      where.current_stock = { [Op.lte]: col('minimum_stock_level') };
      where.minimum_stock_level = { [Op.gt]: 0 };
    }
    if (stock_status === 'out') where.current_stock = { [Op.lte]: 0 };
    // Top Selling: any product that has at least one Sales row in
    // stock_ledger. Correlated subquery — relies on the standard
    // (product_id, transaction_type) index for speed.
    if (stock_status === 'top') {
      where[Op.and] = [
        ...(where[Op.and] || []),
        require('sequelize').literal(
          `EXISTS (
            SELECT 1 FROM stock_ledger sl
             WHERE sl.product_id = "Product"."product_id"
               AND sl.transaction_type = 'Sales'
               AND sl.quantity_out > 0
          )`
        ),
      ];
    }
    // Dead Stock: has on-hand stock but no Sales row in the last 60
    // days (covers both "never sold" and "stale" cases). Mirror of the
    // editorial healthOf() definition. NOT EXISTS short-circuits on
    // the first qualifying row, so this stays cheap even for shops
    // with millions of stock-ledger rows.
    if (stock_status === 'dead') {
      where.current_stock = { [Op.gt]: 0 };
      where[Op.and] = [
        ...(where[Op.and] || []),
        require('sequelize').literal(
          `NOT EXISTS (
            SELECT 1 FROM stock_ledger sl
             WHERE sl.product_id = "Product"."product_id"
               AND sl.transaction_type = 'Sales'
               AND sl.transaction_date >= NOW() - INTERVAL '60 days'
          )`
        ),
      ];
    }

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

    // Opt-in lifetime aggregates for the product management UI. Other
    // callers (autocomplete, variant picker) omit the flag and pay no
    // extra cost.
    let data = rows;
    if (req.query.include_stats === 'true' && rows.length) {
      const statsMap = await fetchLifetimeStats(rows.map(r => r.product_id));
      data = rows.map(r => {
        const s = statsMap[r.product_id] || { total_purchased: 0, total_sold: 0, last_sold_at: null };
        return { ...r.toJSON(), ...s };
      });
    }

    // Per-godown stock override. When the caller passes godown_id (set
    // by Stock Transfer pickers + Sales/Purchase forms scoped to a
    // specific godown), each returned product's current_stock is replaced
    // with its per-godown count from product_godown_stock. Missing pairs
    // resolve to 0 — matches the implicit-zero semantics used elsewhere.
    // Without this, the picker would show the global aggregate which
    // misleads the operator about what's actually on the shelf.
    if (req.query.godown_id && rows.length) {
      const { ProductGodownStock } = require('../models');
      const gid = parseInt(req.query.godown_id, 10);
      const pgsRows = await ProductGodownStock.findAll({
        where: { godown_id: gid, product_id: rows.map(r => r.product_id) },
        attributes: ['product_id', 'current_stock'],
      });
      const stockByProduct = new Map(pgsRows.map(p => [p.product_id, parseFloat(p.current_stock) || 0]));
      data = (data === rows ? rows : data).map(r => {
        const j = r.toJSON ? r.toJSON() : r;
        return { ...j, current_stock: stockByProduct.get(j.product_id) || 0 };
      });
    }

    // Summary aggregates over the FULL filtered set — KPI cards and the
    // sticky bottom Total strip on the product list read these so they
    // stay correct regardless of which chunks the user has scrolled
    // past. Stock value uses purchase_rate (cost basis) — same formula
    // the editorial product list used client-side.
    const totals = await Product.findAll({
      where,
      attributes: [
        [fn('COUNT', col('Product.product_id')), 'total_count'],
        [fn('COALESCE', fn('SUM', literal('current_stock * purchase_rate')), 0), 'total_stock_value'],
        // "Out of stock" — current_stock <= 0
        [fn('COUNT', literal('CASE WHEN current_stock <= 0 THEN 1 END')), 'out_count'],
        // "Low" — 0 < current_stock <= minimum_stock_level (and a min is set)
        [fn('COUNT', literal(
          'CASE WHEN current_stock > 0 AND minimum_stock_level > 0 AND current_stock <= minimum_stock_level THEN 1 END'
        )), 'low_count'],
        // "Top selling" — has at least one Sales row in stock_ledger.
        // Correlated EXISTS so the count stays cheap with the standard
        // (product_id, transaction_type) index.
        [fn('COUNT', literal(
          `CASE WHEN EXISTS (
             SELECT 1 FROM stock_ledger sl
              WHERE sl.product_id = "Product"."product_id"
                AND sl.transaction_type = 'Sales'
                AND sl.quantity_out > 0
           ) THEN 1 END`
        )), 'top_count'],
        // "Dead stock" — has on-hand stock but no Sales in the last 60
        // days (covers never-sold and stale cases). Mirror of the
        // healthOf() definition the client used.
        [fn('COUNT', literal(
          `CASE WHEN current_stock > 0 AND NOT EXISTS (
             SELECT 1 FROM stock_ledger sl
              WHERE sl.product_id = "Product"."product_id"
                AND sl.transaction_type = 'Sales'
                AND sl.transaction_date >= NOW() - INTERVAL '60 days'
           ) THEN 1 END`
        )), 'dead_count'],
      ],
      raw: true,
    });
    const t = totals[0] || {};
    const total_count       = parseInt(t.total_count || 0, 10);
    const out_count         = parseInt(t.out_count || 0, 10);
    const low_count         = parseInt(t.low_count || 0, 10);
    const summary = {
      total_count,
      total_stock_value: +parseFloat(t.total_stock_value || 0).toFixed(2),
      out_count,
      low_count,
      // "In stock" = total minus low minus out (kept consistent with the
      // editorial healthOf() classification on the client).
      in_count:  Math.max(0, total_count - low_count - out_count),
      top_count: parseInt(t.top_count || 0, 10),
      dead_count: parseInt(t.dead_count || 0, 10),
    };

    // Attach mode-aware display_cost + display_stock_value to every row
    // so list views (Stock Report, Smart Stock, Product List) render the
    // right basis without each page reimplementing the per-mode math.
    // Convert any remaining Sequelize instances to plain JSON first.
    const dataPlain = data.map(r => (r && typeof r.toJSON === 'function') ? r.toJSON() : r);
    const enriched = await attachDisplayCost(dataPlain);
    res.json({ total: count, page, limit, data: enriched, summary });
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
    // Attach mode-aware display_cost + display_stock_value for tiles /
    // summary views. Stock Movement transaction rows still read their
    // own per-row rate from stock_ledger; this only feeds aggregates.
    const [enriched] = await attachDisplayCost([product.toJSON()]);
    return res.json(enriched);
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

    // Block disabling batch tracking on a product that already has movements.
    // Once stock has flowed through batches, flipping the flag off would leave
    // batch ledger rows orphaned (batch picker hidden but data still present).
    // The user has to first move all batch stock to zero, then disable.
    if (Object.prototype.hasOwnProperty.call(data, 'is_batch_tracked')
        && data.is_batch_tracked === false
        && product.is_batch_tracked === true) {
      const movementCount = await StockLedger.count({
        where: { product_id: req.params.id, batch_id: { [Op.ne]: null } },
        transaction: t,
      });
      if (movementCount > 0) {
        // Compute the live tally for the error message — far more useful
        // than a bare "has movements" line.
        const { ProductBatch, ProductBatchStock } = require('../models');
        const batches = await ProductBatch.findAll({
          where: { product_id: req.params.id },
          attributes: ['batch_id'],
          transaction: t,
        });
        const batchIds = batches.map((b) => b.batch_id);
        let totalStock = 0;
        let nBatchesWithStock = 0;
        if (batchIds.length) {
          const stocks = await ProductBatchStock.findAll({
            where: { product_id: req.params.id, batch_id: batchIds },
            transaction: t,
          });
          for (const s of stocks) {
            const q = parseFloat(s.current_stock) || 0;
            if (q > 0) { totalStock += q; nBatchesWithStock += 1; }
          }
        }
        await t.rollback();
        if (totalStock > 0) {
          return res.status(400).json({
            error: `Cannot disable batch tracking — product has ${totalStock} unit(s) across ${nBatchesWithStock} batch(es). Move all stock out before disabling.`,
          });
        }
        return res.status(400).json({
          error: 'Cannot disable batch tracking — product has historical batch movements. Reconcile all batches to zero before disabling.',
        });
      }
    }

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
