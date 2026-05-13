const { Op, col, fn, literal } = require('sequelize');
const sequelize = require('../config/database');
const { Product, Category, StockLedger, ProductBatch, ProductColor, SystemSettings } = require('../models');
const { generateBarcode, findExistingProduct } = require('../utils/barcode');
const { sanitizePagination, escapeLike } = require('../utils/helpers');
const { attachDisplayCost, fetchBatchAggregate } = require('../utils/displayCost');
const { applyGodownStockDelta, getDefaultGodownId } = require('../utils/godownStock');

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
  // Color mode picker — 'none' / 'single' / 'multi'. The product form
  // is the source of truth; bill controllers branch on this value.
  // 'single' uses color_label (free text on this row); 'multi' uses
  // child rows in product_colors.
  'color_mode', 'color_label',
  // Audit H6 — per-product costing override. Validated below as one of
  // 'inherit' / 'weighted_avg' / 'fifo'.
  'costing_method',
];

// Allowed values for per-product costing override; mirrored from the
// ENUM type on the products table. Validated at the controller so a
// bad value returns a clean 400 instead of a Sequelize/Postgres error.
const COSTING_METHODS = new Set(['inherit', 'weighted_avg', 'fifo']);

function validateCostingMethod(data) {
  if (data.costing_method !== undefined && !COSTING_METHODS.has(data.costing_method)) {
    return `costing_method must be one of: ${[...COSTING_METHODS].join(', ')}`;
  }
  return null;
}

exports.getAll = async (req, res) => {
  try {
    const { search, category_id, stock_status, name_only, name_exact } = req.query;
    // Clamp page/limit (see helpers.sanitizePagination).
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_active: true };

    if (search) {
      // Audit P3-D — escape % / _ wildcards so a search like "%" doesn't
      // turn the indexed iLike into a full-table scan.
      const s = escapeLike(search);
      if (name_exact === 'true') {
        // Variant picker: exact product-name match — needed to escape the 200-row cap
        // when the substring `%PLAZO%` would pull in hundreds of unrelated rows.
        where.product_name = { [Op.iLike]: s };
      } else if (name_only === 'true') {
        // Sales/purchase form: search only by product name — no article/barcode noise
        where.product_name = { [Op.iLike]: `%${s}%` };
      } else {
        // Product management page: full search across name, barcode, article
        where[Op.or] = [
          { product_name: { [Op.iLike]: `%${s}%` } },
          { barcode: { [Op.iLike]: `%${s}%` } },
          { article_number: { [Op.iLike]: `%${s}%` } },
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

    // ── Family mode (variant-mode browsing) ─────────────────────────────────
    //
    // When `families=true`, return one row per `product_name` within the
    // current where-clause filters (category + optional search). Each row
    // carries a variant_count so the dropdown can render "BABLA SUIT · 4
    // sizes"-style hints. Used by the Sales entry row's Product picker
    // when SystemSettings.default_product_mode === 'variant' — the
    // operator picks a name first, then disambiguates via the Size
    // dropdown which lists every sibling row sharing the name.
    //
    // This branch sidesteps the 50-row pagination cap on the flat-list
    // path: if a category has 200 variants of "BABLA SUIT" they collapse
    // to one family row, so newly-created variants are never hidden
    // behind page boundaries.
    if (req.query.families === 'true') {
      const familyOrder = (search && name_only === 'true')
        ? [
            [literal(`CASE WHEN "product_name" ILIKE '${search.replace(/'/g, "''")}%' THEN 0 ELSE 1 END`), 'ASC'],
            ['product_name', 'ASC'],
          ]
        : [['product_name', 'ASC']];
      const familyRows = await Product.findAll({
        where,
        attributes: [
          'product_name',
          [fn('COUNT', col('Product.product_id')), 'variant_count'],
          // Sum current_stock across every variant under this family —
          // the dropdown surfaces this as "Stock: 50" so the operator
          // sees on-hand quantity at the family level before drilling
          // into the size picker.
          [fn('COALESCE', fn('SUM', col('current_stock')), 0), 'total_stock'],
          [fn('MIN', col('Product.product_id')), 'sample_product_id'],
        ],
        group: ['product_name'],
        order: familyOrder,
        limit,
        offset,
        raw: true,
      });
      return res.json({
        success: true,
        data: familyRows.map((r) => ({
          product_name:      r.product_name,
          variant_count:     parseInt(r.variant_count, 10),
          total_stock:       parseFloat(r.total_stock || 0),
          sample_product_id: parseInt(r.sample_product_id, 10),
        })),
      });
    }

    const { count, rows } = await Product.findAndCountAll({
      where,
      // Include active colors alongside Category. Sales / purchase
      // pickers (handleProdSel / handleProductSelect) read p.colors so
      // when the operator picks a multi-color product from the dropdown
      // — instead of scanning the barcode — the line still gets its
      // colors list. Empty for non-multi products; required:false keeps
      // them in the result either way.
      include: [
        { model: Category, attributes: ['category_name'] },
        {
          model: ProductColor,
          as: 'colors',
          where: { is_active: true },
          required: false,
          attributes: ['color_id', 'color_name', 'current_stock', 'low_stock_alert'],
        },
      ],
      order: orderClause,
      limit,
      offset,
      // Sequelize collapses the LEFT JOIN into a single row per Product
      // (one row per join would duplicate Products by N colors).
      distinct: true,
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
    // past.
    //
    // Mode-aware stock_value (audit-driven, Commit 3c):
    //   • variant            → current_stock × purchase_rate
    //   • single, no batch   → current_stock × COALESCE(weighted_avg_cost,
    //                                                  purchase_rate, 0)
    //   • single + batch     → SUM(batch.qty × batch.rate) — fetched
    //                          separately because the rate lives on
    //                          product_batches, not the product master.
    //
    // The CASE WHEN below handles the first two modes in a single SUM
    // (zero JS-side cost). Single+batch products contribute via a
    // separate fetchBatchAggregate over the filtered product_ids set
    // (small extra round-trip; one row per single+batch product, then
    // reduced to a number in JS).
    const totals = await Product.findAll({
      where,
      attributes: [
        [fn('COUNT', col('Product.product_id')), 'total_count'],
        [fn('COALESCE', fn('SUM', literal(`
          current_stock * (CASE
            WHEN product_mode = 'single' AND is_batch_tracked = false
              THEN COALESCE(weighted_avg_cost, purchase_rate, 0)
            WHEN product_mode = 'single' AND is_batch_tracked = true
              THEN 0
            ELSE purchase_rate
          END)
        `)), 0), 'partial_stock_value'],
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

    // Single+batch contribution to total_stock_value. Pre-fetch the
    // filtered product_ids that are batch-tracked, then sum their
    // batch-aggregate total_value. Empty result → adds 0.
    const filteredBatchIds = await Product.findAll({
      where: { ...where, product_mode: 'single', is_batch_tracked: true },
      attributes: ['product_id'],
      raw: true,
    });
    const batchAgg = await fetchBatchAggregate(filteredBatchIds.map(r => r.product_id));
    const batchStockValue = Array.from(batchAgg.values())
      .reduce((s, a) => s + (a.total_value || 0), 0);

    const summary = {
      total_count,
      total_stock_value: +(parseFloat(t.partial_stock_value || 0) + batchStockValue).toFixed(2),
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
      // Include the active color list when the product is multi-color
      // tracked. The sales / purchase forms read this to populate the
      // line's Color dropdown without a second round-trip per scan.
      // Always include the assoc — it's empty for non-multi products
      // and the form gates its column visibility on color_mode anyway.
      include: [
        { model: Category, attributes: ['category_name'] },
        {
          model: ProductColor,
          as: 'colors',
          where: { is_active: true },
          required: false,
          attributes: ['color_id', 'color_name', 'current_stock', 'low_stock_alert'],
        },
      ],
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    // Mirror getById — attach display_cost so callers like
    // StockTransferForm's barcode-scan path get the mode-aware rate
    // for pre-fill instead of the raw purchase_rate (which is wrong
    // for single-mode and single+batch products).
    const [enriched] = await attachDisplayCost([product.toJSON()]);
    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /api/products/:id/batches?godown_id=X&include_zero=false ──────
//
// Returns the active batches for a batch-tracked product at a specific
// godown, sorted FEFO when any batch has an expiry date, FIFO otherwise.
// Powers the sales-form / sales-return-form / purchase-return-form
// batch dropdowns. Default scope drops batches with zero stock at this
// godown (the picker can't sell from an empty batch); pass
// include_zero=true to include them — useful for diagnostics and the
// integrity-screen view.
//
// Sort rules (matching the brief):
//   · If ANY batch has expiry_date set → FEFO
//       (earliest expiry first; null expiries sort last; tiebreak on
//        batch_id ascending for stability)
//   · Else → FIFO
//       (earliest manufacture_date first; null mfg sorts last;
//        tiebreak on batch_id ascending)
//
// Each row: { batch_id, batch_number, manufacture_date, expiry_date,
//             purchase_rate, current_stock, notes }. The form decides
//             how to chip-render expiry status against the
//             batch_expiry_alert_days setting.
exports.getBatches = async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!productId) return res.status(400).json({ error: 'product_id required' });
    const godownId = req.query.godown_id ? parseInt(req.query.godown_id, 10) : null;
    if (!godownId) return res.status(400).json({ error: 'godown_id required' });
    const includeZero = req.query.include_zero === 'true';

    const rows = await sequelize.query(
      `SELECT pb.batch_id,
              pb.batch_number,
              pb.manufacture_date,
              pb.expiry_date,
              pb.purchase_rate::float AS purchase_rate,
              pb.notes,
              COALESCE(pbs.current_stock, 0)::float AS current_stock
         FROM product_batches pb
         LEFT JOIN product_batch_stock pbs
               ON pbs.batch_id   = pb.batch_id
              AND pbs.product_id = pb.product_id
              AND pbs.godown_id  = :godown_id
        WHERE pb.product_id = :product_id
          AND pb.is_active  = true
          ${includeZero ? '' : 'AND COALESCE(pbs.current_stock, 0) > 0'}
        ORDER BY (pb.expiry_date IS NULL) ASC,
                 pb.expiry_date ASC,
                 (pb.manufacture_date IS NULL) ASC,
                 pb.manufacture_date ASC,
                 pb.batch_id ASC`,
      {
        replacements: { product_id: productId, godown_id: godownId },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    return res.json({ data: rows });
  } catch (err) {
    console.error('getBatches error:', err);
    return res.status(500).json({ error: 'Server error' });
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
  // Wrap in a transaction so the product, ledger entry, AND
  // product_godown_stock row are atomic — partial commits would leave
  // stock visible at the product level but invisible at the godown
  // level, which is exactly the bug that blocked sales on Company 2.
  const sequelizeDb = require('../config/database');
  const { applyGodownStockDelta, getDefaultGodownId } = require('../utils/godownStock');
  const t = await sequelizeDb.transaction();
  try {
    // Strip to whitelisted columns before unpacking the opening-stock trio.
    const safe = {};
    for (const k of PRODUCT_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    const cmErr = validateCostingMethod(safe);
    if (cmErr) { await t.rollback(); return res.status(400).json({ error: cmErr }); }
    const { opening_stock, opening_stock_rate, opening_stock_date, ...data } = safe;

    // Check for existing product with same specs
    const existing = await findExistingProduct(Product, data);
    if (existing) {
      await t.rollback();
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

    // Determine opening stock — accept either `opening_stock` (form
    // field) or `current_stock` (legacy import / API direct create).
    // Both paths fund the godown stock row so the sales controller
    // can find inventory.
    const openingQty = parseFloat(
      opening_stock || data.current_stock || 0,
    );
    if (openingQty > 0) data.current_stock = openingQty;

    const product = await Product.create(data, { transaction: t });

    // Create Opening Stock ledger entry + the per-godown stock row.
    // Both are required for the sales controller's stock check to find
    // inventory — without the godown row, "Available: 0" even when
    // products.current_stock is 1000.
    if (openingQty > 0) {
      const defaultGodownId = await getDefaultGodownId({ t });
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
        godown_id: defaultGodownId,
      }, { transaction: t });

      // Seed per-godown stock at the system's default godown so the
      // sales controller's "Available at this godown" check finds the
      // inventory. Without this row, Available reads as 0 and bills
      // are blocked by the negative-stock guard.
      if (defaultGodownId) {
        await applyGodownStockDelta({
          product_id: product.product_id,
          godown_id: defaultGodownId,
          delta: openingQty,
          t,
        });
      }
    }

    await t.commit();

    const result = await Product.findByPk(product.product_id, {
      include: [{ model: Category, attributes: ['category_name'] }],
    });
    res.status(201).json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
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
    const cmErr = validateCostingMethod(safe);
    if (cmErr) { await t.rollback(); return res.status(400).json({ error: cmErr }); }
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

    // Handle opening stock change.
    //
    // Audit H5: previously this path mutated `products.current_stock`
    // directly while leaving `product_godown_stock` untouched. The next
    // live sale ran applyGodownStockDelta() which rewrites
    // products.current_stock = SUM(PGS) — silently erasing the
    // opening-stock edit. Now we route the delta through
    // applyGodownStockDelta against the system default godown so the
    // PGS row stays in sync (and the Sequelize-cached
    // `product.current_stock` becomes stale; the helper updates the
    // canonical value in the DB).
    const newOpeningQty = parseFloat(opening_stock ?? '');
    if (!isNaN(newOpeningQty) && opening_stock !== undefined && opening_stock !== null && opening_stock !== '') {
      const oldOpeningRow = await StockLedger.findOne({
        where: { product_id: req.params.id, transaction_type: 'Opening Stock' },
        transaction: t,
      });
      const oldQty = parseFloat(oldOpeningRow?.quantity_in || 0);
      const editGodownId = oldOpeningRow?.godown_id || await getDefaultGodownId({ t });

      // Now safe to remove the old row
      await StockLedger.destroy({
        where: { product_id: req.params.id, transaction_type: 'Opening Stock' },
        transaction: t,
      });

      // Net delta the opening edit applies to PGS.
      const netDelta = +(newOpeningQty - oldQty).toFixed(2);
      // Audit H1 — same negative-stock guard as Stock Adjustment. Decreasing
      // opening on a product that has already been sold against would push
      // the per-godown stock negative; gate behind allow_negative_stock so
      // the global setting is respected here too.
      if (netDelta < 0) {
        const sysSettings = await SystemSettings.findByPk(1, { transaction: t });
        const allowNegative = sysSettings?.allow_negative_stock || false;
        if (!allowNegative) {
          const currentGodownStock = parseFloat(product.current_stock || 0);
          const projected = +(currentGodownStock + netDelta).toFixed(2);
          if (projected < 0) {
            await t.rollback();
            return res.status(400).json({
              error: `Reducing opening stock by ${Math.abs(netDelta)} would take current stock below zero (projected: ${projected}). Enable "Allow negative stock" in Settings or sell back / restock first.`,
            });
          }
        }
      }
      if (Math.abs(netDelta) > 0.0049) {
        await applyGodownStockDelta({
          product_id: req.params.id,
          godown_id:  editGodownId,
          delta:      netDelta,
          t,
        });
      }
      // Don't override data.current_stock here — applyGodownStockDelta
      // already updated products.current_stock = SUM(PGS) in DB.
      // Strip the field from `data` so product.update doesn't clobber
      // the helper's value.
      delete data.current_stock;

      if (newOpeningQty > 0) {
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
          godown_id: editGodownId,
          remarks: 'Opening Stock',
          created_by: req.user?.user_id,
        }, { transaction: t });
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
  const { applyGodownStockDelta, getDefaultGodownId } = require('../utils/godownStock');
  const t = await sequelizeDb.transaction();
  try {
    const { current_stock, purchase_rate, sale_rate, minimum_stock_level } = req.body;
    const product = await Product.findByPk(req.params.id, { transaction: t });
    if (!product) { await t.rollback(); return res.status(404).json({ error: 'Product not found' }); }

    const updateData = {};
    if (purchase_rate !== undefined && purchase_rate !== '') updateData.purchase_rate = parseFloat(purchase_rate);
    if (sale_rate !== undefined && sale_rate !== '') updateData.sale_rate = parseFloat(sale_rate);
    if (minimum_stock_level !== undefined && minimum_stock_level !== '') updateData.minimum_stock_level = parseFloat(minimum_stock_level);

    // If stock is being changed, route the diff through applyGodownStockDelta
    // so product_godown_stock stays in sync. Audit H6: previously this path
    // wrote `current_stock` directly without touching PGS — the next live
    // sale's applyGodownStockDelta() recomputes
    // products.current_stock = SUM(PGS) and erases the adjustment.
    if (current_stock !== undefined && current_stock !== '') {
      const newStock = parseFloat(current_stock);
      const oldStock = parseFloat(product.current_stock || 0);
      const stockDiff = +(newStock - oldStock).toFixed(2);

      // Audit C2 — negative-stock guard. The Adjust path previously bypassed
      // the global allow_negative_stock setting that sales/purchase honor.
      // Operator could "fix" a count from 30 → -10 even with the setting OFF.
      if (stockDiff !== 0) {
        const sysSettings = await SystemSettings.findByPk(1, { transaction: t });
        const allowNegative = sysSettings?.allow_negative_stock || false;
        if (!allowNegative && newStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Adjusted stock (${newStock}) would go negative. Enable "Allow negative stock" in Settings to permit this.`,
          });
        }
      }

      // Only create a ledger entry + delta when the stock actually changes.
      // Audit C1 — the previous code applied the delta TWICE: once via
      // adjustGodownId at line 775-780 and again via the same defaultGodownId
      // (both came from getDefaultGodownId — same row) at the orphaned
      // applyGodownStockDelta call below. The StockLedger.create literal also
      // had a duplicate `godown_id` key (silently kept the second value).
      // Result: every Stock Adjustment doubled. Now: single helper call,
      // single ledger row, no orphan defaultGodownId.
      if (stockDiff !== 0) {
        const adjustGodownId = await getDefaultGodownId({ t });
        await applyGodownStockDelta({
          product_id: product.product_id,
          godown_id:  adjustGodownId,
          delta:      stockDiff,
          t,
        });
        // applyGodownStockDelta already updated products.current_stock
        // — strip from updateData so product.update doesn't overwrite.
        delete updateData.current_stock;

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
          godown_id: adjustGodownId,
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
    const { from_date, to_date, include_reversals } = req.query;

    const sequelizeDb = require('../config/database');

    const where = { product_id: id };
    if (from_date && to_date) {
      where.transaction_date = { [Op.between]: [from_date, to_date] };
    }
    // Audit L3 — by default, hide reversal pairs. A bill that's been
    // edited 3 times would otherwise show 9 stock_ledger rows (3 sets
    // of original+reversal+new) for one product, drowning the
    // operator in noise. The pair contributes ₹0 to stock totals, so
    // hiding it loses no math — just visual clutter.
    // `?include_reversals=1` shows everything for auditors.
    if (include_reversals !== '1') {
      // Hide both reversal rows (those with is_reversal_of_ledger_id set)
      // AND the originals they reverse (those with a child row pointing
      // back at them). Net effect: only currently-active rows remain.
      where[Op.and] = sequelizeDb.literal(
        `("StockLedger"."is_reversal_of_ledger_id" IS NULL ` +
        `  AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.is_reversal_of_ledger_id = "StockLedger".ledger_id))`,
      );
    }

    const movements = await StockLedger.findAll({
      where,
      // Include the batch row so the Stock Movement page can render
      // batch_number per movement (Commit 5 — Part E adds a Batch
      // filter dropdown that reads this field).
      include: [{ model: ProductBatch, as: 'batch', attributes: ['batch_id', 'batch_number', 'manufacture_date', 'expiry_date'], required: false }],
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
