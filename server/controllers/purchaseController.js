const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { PurchaseBill, PurchaseBillItem, PurchaseBillDraft, Party, Product, ProductColor, StockLedger, Category, SystemSettings, Godown } = require('../models');
const { generateBillNumber, roundOff, calculateGST, roundTo, sanitizePagination } = require('../utils/helpers');
const { generateBarcode, findExistingProduct } = require('../utils/barcode');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildPurchaseBillVouchers } = require('../services/voucherBuilders');
const { syncAutoReceiptForBill, reverseAutoReceiptForBill } = require('../services/autoReceiptService');
const { applyGodownStockDelta, getGodownStock, resolveGodownForWrite, getDefaultGodownId } = require('../utils/godownStock');
const { resolveOrCreateBatch, applyBatchStockDelta } = require('../utils/batchStock');
const {
  validateBillColorRequirements,
  applyColorStockDelta,
  reverseBillColorStock,
} = require('../services/productColorStockService');
const { applyWeightedAvgIncrement, recomputeWeightedAvgFromLedger } = require('../utils/weightedAvgCost');
const { denyIfGodownInaccessible } = require('../middleware/godownScope');
const { checkPartyForBillSave } = require('../utils/partyGuards');

/**
 * Resolve or create a product for a purchase bill item.
 *
 * Rules:
 *  1. If product_id is explicitly set (user selected from dropdown) → use that product as-is.
 *  2. If barcode provided → look up by barcode.
 *  3. Otherwise → search by name + size + article + qty_per_box.
 *  4. If a match is found (step 2 or 3), compare ALL fields:
 *       size, article, qty_per_box, purchase_rate, sale_rate, margin, mrp, gst_rate
 *     → If ALL match → reuse existing product (update rates/stock later).
 *     → If ANY differ → generate NEW barcode + create NEW product.
 *  5. No match at all → generate NEW barcode + create NEW product.
 */
async function resolveOrCreateProduct(item, t, defaultProductMode = 'variant') {
  // ── Case 1: explicit product_id (selected from dropdown) ──────────────────
  if (item.product_id) {
    const p = await Product.findByPk(item.product_id, { transaction: t });
    if (p) return { product_id: p.product_id, barcode: p.barcode, isNew: false, product: p };
  }

  // ── Case 2: look up by barcode ─────────────────────────────────────────────
  let found = null;
  if (item.barcode) {
    found = await Product.findOne({ where: { barcode: item.barcode }, transaction: t });
  }

  // ── Case 3: look up by identity fields ────────────────────────────────────
  if (!found && item.product_name) {
    found = await findExistingProduct(Product, {
      product_name: item.product_name,
      size:          item.size,
      article_number:item.article_number,
      quantity_per_box: item.quantity_per_box || 1,
    }, t);
  }

  // ── Case 3.5: single-mode name-only resolver (early short-circuit) ────────
  //
  // In Single Product mode the operator's purchase line MUST bind to an
  // existing master product — auto-create-from-purchase is disabled
  // (Case 5 below short-circuits with a 400). The fingerprint cascade
  // (Case 3 + Case 4) is variant-mode UX: it requires name + size +
  // article + qpb match, then drops the match entirely if pricing
  // differs (the "spawn a new variant" path). Neither helps in single
  // mode — there's no per-rate / per-size sibling, just one canonical
  // product per name.
  //
  // Run BEFORE Case 4's variant comparison so a Case 3 hit on a
  // variant-mode legacy row doesn't get filtered out by the rate
  // mismatch check. Name iLike across ALL modes is the right
  // discriminator: catalog is heterogeneous (a firm that flipped to
  // single still has historical variant rows), and the purchase
  // should restock whatever matches the typed name regardless of how
  // it was originally created. The mode flag governs how NEW products
  // are created (Case 5), not how existing ones resolve.
  //
  // Variant mode keeps the strict fingerprint cascade unchanged —
  // variants legitimately spawn per (size, article, rate) tuple.
  if (item.product_name && defaultProductMode === 'single') {
    const { Op } = require('sequelize');
    const match = await Product.findOne({
      where: {
        product_name: { [Op.iLike]: String(item.product_name).trim() },
        is_active: true,
      },
      transaction: t,
    });
    if (match) {
      return { product_id: match.product_id, barcode: match.barcode, isNew: false, product: match };
    }
    // No name match → fall through to Case 5, which now hard-blocks
    // single-mode creation with a 400 explaining the constraint.
  }

  // ── Case 4: compare ALL fields if something was found ─────────────────────
  //
  // Mode-aware branching (audit-driven Phase 3):
  //   • SINGLE-mode found product → return it as-is, NO 9-field strict check.
  //     Single mode is "one product, many purchase prices over time" — a
  //     differing rate is the whole point, not a signal to spawn a variant.
  //   • VARIANT-mode found product → existing 9-field check. If any of
  //     name / size / article / qpb / purchase_rate / sale_rate / margin /
  //     mrp / gst_rate differs, fall through and create a new variant row.
  if (found) {
    if (found.product_mode === 'single') {
      return { product_id: found.product_id, barcode: found.barcode, isNew: false, product: found };
    }
    const n  = (v) => +(parseFloat(v) || 0).toFixed(2);
    const s  = (v) => (v || '').toString().trim().toLowerCase();
    const allMatch =
      s(found.product_name)    === s(item.product_name) &&
      s(found.size_value)      === s(item.size) &&
      s(found.article_number)  === s(item.article_number) &&
      // Compare with a small tolerance — quantity_per_box is DECIMAL(10,2),
      // parseInt would treat 2.5 and 2 as the same SKU.
      Math.abs(parseFloat(found.quantity_per_box || 1) - parseFloat(item.quantity_per_box || 1)) < 0.001 &&
      n(found.purchase_rate)   === n(item.purchase_rate) &&
      n(found.sale_rate)       === n(item.sale_rate) &&
      n(found.margin_percentage)=== n(item.margin_percentage) &&
      n(found.mrp)             === n(item.mrp) &&
      n(found.gst_rate)        === n(item.gst_rate);

    if (allMatch) {
      return { product_id: found.product_id, barcode: found.barcode, isNew: false, product: found };
    }
    // Any field differs → fall through to create new product below
  }

  // ── Case 5: create brand-new traceable product with new barcode ────────────
  if (!item.product_name) return { product_id: null, barcode: item.barcode || null, isNew: false, product: null };

  // Single-mode hard block: refuse to silently auto-create a product
  // from a purchase line. Single-mode is "one product per name" + the
  // master record holds the canonical sale_rate / margin / mrp /
  // is_batch_tracked — auto-creating from a purchase row would (a)
  // pick up sale_rate auto-filled from purchase_rate × margin (Bug 2),
  // (b) miss is_batch_tracked entirely (Bug 3 cause), and (c) bypass
  // the operator's explicit "what is this product" decision. Defense
  // in depth alongside the form's +Add auto-select fix: even if the
  // form regresses, the server still won't spawn a duplicate.
  // Variant-mode keeps existing auto-create behaviour (variants are
  // PER-row, the whole point is fast spawning of new SKUs).
  if (defaultProductMode === 'single') {
    return {
      product_id: null, barcode: null, isNew: false, product: null,
      _error: `"${item.product_name}" is not in your master list. In Single Product mode, products must be added via the "+ Add Product" button before billing — auto-create from purchase is disabled to prevent duplicates and ensure sale_rate / batch flag / GST are explicitly set.`,
    };
  }

  // If the frontend pre-reserved a barcode via /products/next-barcode, use it as-is
  // (counter was already incremented) — avoids a second generateBarcode() call and
  // lets the displayed barcode match what the product actually gets saved with.
  // Otherwise, generate one under the current transaction so the counter lock
  // is released atomically with the purchase bill commit/rollback.
  const newBarcode = item.barcode || await generateBarcode(t);

  // Family-level color inheritance — if any sibling under the same
  // product name carries color_mode='multi', the family is multi-color
  // and a brand-new variant born here should inherit that flag.
  // (Sizes can have different colors; the actual product_colors rows
  // get created lazily in resolveColorForProduct when a bill line
  // picks a color the new variant doesn't carry yet.)
  //
  // Compare with TRIM + LOWER on both sides — product_name in the DB
  // can have trailing whitespace from earlier UI bugs (e.g. "color
  // test ") that a plain iLike-without-wildcards won't match.
  let inheritedColorMode = 'none';
  const familyName = String(item.product_name || '').trim().toLowerCase();
  if (defaultProductMode !== 'single' && familyName) {
    const familySibling = await Product.findOne({
      where: {
        [Op.and]: [
          sequelize.where(
            sequelize.fn('LOWER', sequelize.fn('TRIM', sequelize.col('product_name'))),
            familyName,
          ),
          { color_mode: 'multi' },
          { is_active: true },
        ],
      },
      transaction: t,
    });
    if (familySibling) inheritedColorMode = 'multi';
  }

  // Newly created products inherit the current default mode. Mode is
  // permanent once a product exists (mirrors the is_batch_tracked lock
  // pattern). For single-mode new products, weighted_avg_cost gets set
  // below in the post-create wac update path; the catalog purchase_rate
  // becomes the FROZEN reference rate.
  const newProduct = await Product.create({
    barcode:          newBarcode,
    product_name:     item.product_name,
    category_id:      item.category_id  || null,
    size_value:       item.size         || null,
    article_number:   item.article_number || null,
    hsn_code:         item.hsn_code     || null,
    gst_rate:         item.gst_rate     || 0,
    purchase_rate:    item.purchase_rate,
    margin_percentage:item.margin_percentage || 0,
    sale_rate:        item.sale_rate    || 0,
    mrp:              item.mrp          || 0,
    quantity_per_box: item.quantity_per_box || 1,
    current_stock:    0,
    product_mode:     defaultProductMode,
    color_mode:       inheritedColorMode,
  }, { transaction: t });

  return { product_id: newProduct.product_id, barcode: newBarcode, isNew: true, product: newProduct };
}

/**
 * Resolve (or create) the color row that a bill line's color_id +
 * color_name should map to on the resolved product.
 *
 * Two scenarios this exists for:
 *
 *  (a) Cross-variant remap — the bill form's family-color picker shows
 *      the union of colors across all siblings, so the picked color_id
 *      may belong to a SIBLING product, not the resolved variant. If
 *      we wrote it straight to purchase_bill_items, the FK would be
 *      valid but semantically wrong, and validateBillColorRequirements
 *      would reject it.
 *
 *  (b) Inline-created colors — the matrix popup's "+ Add color" path
 *      lets the operator type a brand-new color name on the line.
 *      It arrives here as color_name without color_id; we find-or-
 *      create on the resolved product.
 *
 * Idempotent on (product_id, color_name) — repeated saves with the
 * same name don't create duplicates. Returns null when the line has
 * no color info at all (validation will catch that for multi-color
 * products elsewhere).
 */
async function resolveColorForProduct(itemColorId, itemColorName, resolvedProductId, t) {
  if (!resolvedProductId) return null;

  // Path (a): color_id is set — remap if cross-variant, else passthrough.
  if (itemColorId) {
    const picked = await ProductColor.findByPk(itemColorId, { transaction: t });
    if (picked) {
      if (picked.product_id === resolvedProductId) return picked.color_id;
      const existing = await ProductColor.findOne({
        where: { product_id: resolvedProductId, color_name: picked.color_name, is_active: true },
        transaction: t,
      });
      if (existing) return existing.color_id;
      const created = await ProductColor.create({
        product_id: resolvedProductId,
        color_name: picked.color_name,
        is_active: true,
      }, { transaction: t });
      return created.color_id;
    }
    // Fall through to color_name path if the id is stale.
  }

  // Path (b): only a name (operator typed a new color in the matrix popup).
  const name = (itemColorName || '').trim();
  if (name) {
    const existing = await ProductColor.findOne({
      where: {
        product_id: resolvedProductId,
        color_name: { [Op.iLike]: name },
        is_active: true,
      },
      transaction: t,
    });
    if (existing) return existing.color_id;
    const created = await ProductColor.create({
      product_id: resolvedProductId,
      color_name: name,
      is_active: true,
    }, { transaction: t });
    return created.color_id;
  }

  return null;
}

exports.getAll = async (req, res) => {
  try {
    const { from_date, to_date, supplier_id, payment_status, search } = req.query;
    // Clamp page/limit — see salesController.getAll for rationale.
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_cancelled: false };

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (supplier_id) where.supplier_id = supplier_id;
    if (payment_status) where.payment_status = payment_status;
    if (search) {
      where[Op.or] = [
        { bill_number: { [Op.iLike]: `%${search}%` } },
        { supplier_bill_number: { [Op.iLike]: `%${search}%` } },
        { '$supplier.party_name$': { [Op.iLike]: `%${search}%` } },
        { '$supplier.mobile_1$':   { [Op.iLike]: `%${search}%` } },
      ];
    }

    // Mirror the sales list: per-row aggregates so the UI can render
    // "N items · P pcs" without fetching each bill's items. Correlated
    // subqueries keep the whole listing on a single round-trip.
    const { count, rows } = await PurchaseBill.findAndCountAll({
      where,
      attributes: {
        include: [
          [sequelize.literal(
            '(SELECT COUNT(*)::int FROM purchase_bill_items WHERE purchase_bill_items.purchase_bill_id = "PurchaseBill"."purchase_bill_id")'
          ), '_item_count'],
          [sequelize.literal(
            '(SELECT COALESCE(SUM(quantity), 0)::float FROM purchase_bill_items WHERE purchase_bill_items.purchase_bill_id = "PurchaseBill"."purchase_bill_id")'
          ), '_pcs_total'],
        ],
      },
      include: [
        { model: Party,  as: 'supplier', attributes: ['party_name', 'mobile_1'] },
        { model: Godown, as: 'godown',   attributes: ['godown_id', 'code', 'name'] },
      ],
      order: [['bill_date', 'DESC'], ['purchase_bill_id', 'DESC']],
      limit,
      offset,
      // See salesController for the subQuery:false + distinct:true rationale.
      subQuery: false,
      distinct: true,
    });

    // Summary aggregates over the FULL filtered set — KPIs and footer
    // totals on the purchase list use these so they stay correct
    // regardless of which chunks the user has scrolled past. Mirrors
    // the salesController.getAll summary block.
    const totals = await PurchaseBill.findAll({
      where,
      attributes: [
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total_amount')),    0), 'total_amount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('paid_amount')),     0), 'total_paid'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('balance_amount')),  0), 'total_balance'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('discount_amount')), 0), 'total_discount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('cgst_amount')),     0), 'total_cgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('sgst_amount')),     0), 'total_sgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('igst_amount')),     0), 'total_igst'],
        [sequelize.fn('COUNT', sequelize.col('purchase_bill_id')), 'count'],
        [sequelize.fn('COUNT', sequelize.literal('CASE WHEN balance_amount > 0.01 THEN 1 END')), 'open_count'],
      ],
      include: [{ model: Party, as: 'supplier', attributes: [] }],
      raw: true,
      subQuery: false,
    });
    const t = totals[0] || {};
    const total_gst = +(parseFloat(t.total_cgst || 0) + parseFloat(t.total_sgst || 0) + parseFloat(t.total_igst || 0)).toFixed(2);
    const summary = {
      total_amount:   +parseFloat(t.total_amount   || 0).toFixed(2),
      total_paid:     +parseFloat(t.total_paid     || 0).toFixed(2),
      total_balance:  +parseFloat(t.total_balance  || 0).toFixed(2),
      total_discount: +parseFloat(t.total_discount || 0).toFixed(2),
      total_gst,
      count:          parseInt(t.count || 0, 10),
      open_count:     parseInt(t.open_count || 0, 10),
    };

    res.json({ total: count, page, limit, data: rows, summary });
  } catch (error) {
    console.error('Get purchases error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const { ProductBatch, ProductColor } = require('../models');
    const bill = await PurchaseBill.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'supplier' },
        {
          model: PurchaseBillItem, as: 'items',
          include: [
            // Pull product so edit-mode can re-detect is_batch_tracked
            // without re-fetching products one-by-one. Lazy required so
            // restoring a recalled draft / opening an old bill renders
            // the batch column correctly on first paint. Active colors
            // come along too so the matrix popup can re-open with the
            // full per-product palette (existing pick + others) when
            // the operator clicks the Color cell on edit.
            { model: Product, as: 'product',
              attributes: ['product_id', 'is_batch_tracked', 'color_mode'],
              include: [{
                model: ProductColor, as: 'colors',
                where: { is_active: true },
                required: false,
                attributes: ['color_id', 'color_name', 'current_stock'],
              }],
            },
            { model: ProductBatch, as: 'batch', attributes: ['batch_id', 'batch_number', 'manufacture_date', 'expiry_date', 'notes'] },
            // Color row tied to this line — populated for multi-color
            // products. Edit-mode rehydrates the items table dropdown
            // using it.color.color_name and it.color_id.
            { model: ProductColor, as: 'color', attributes: ['color_id', 'color_name'] },
          ],
        },
      ],
    });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    res.json(bill);
  } catch (error) {
    console.error('PurchaseBill getById error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    let { items, paid_amount = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, other_charges = 0, freight_charges = 0, gst_mode, bill_mode, amount, gst_rate: amountGstRate, hsn_code: amountHsnCode, description: amountDescription, draft_id, ...billData } = req.body;

    // ── AMOUNT-ONLY MODE ─────────────────────────────────────────────
    // Mirror of salesController amount-mode: synthesise one line item so
    // the rest of the pipeline (PASS 1/2, GST routing, supplier balance)
    // runs unchanged. quantity=1, rate=amount, product_id=null (skips
    // stock loop). gst_mode forced to 'product' for per-rate routing.
    if (bill_mode === 'amount') {
      const amt = parseFloat(amount);
      const rate = parseFloat(amountGstRate || 0);
      if (!isFinite(amt) || amt <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'Amount must be greater than 0 for amount-only bills.' });
      }
      if (!isFinite(rate) || rate < 0 || rate > 100) {
        await t.rollback();
        return res.status(400).json({ error: 'GST rate must be between 0 and 100.' });
      }
      const hsn  = (amountHsnCode || '9999').toString().trim() || '9999';
      const desc = (amountDescription || 'Service / Misc').toString().trim() || 'Service / Misc';
      items = [{
        product_id:          null,
        barcode:             null,
        category_id:         null,
        category_name:       '',
        product_name:        desc,
        size:                '',
        article_number:      '',
        hsn_code:            hsn,
        unit_type:           'OTH',
        quantity:            1,
        purchase_rate:       amt,
        discount_percentage: 0,
        discount_amount:     0,
        margin_percentage:   0,
        sale_rate:           0,
        mrp:                 0,
        gst_rate:            rate,
        quantity_per_box:    1,
      }];
      gst_mode = 'product';
      cgst_pct = 0; sgst_pct = 0; igst_pct = 0;
      // Persist description on the bill header so prints/reports can show
      // it without reading the items list.
      billData.description = desc;
    }
    billData.bill_mode = bill_mode === 'amount' ? 'amount' : 'item';

    // ── Bill number race (Fix #17) ─────────────────────────────────────
    // See salesController for full rationale. Advisory key 905 = purchase
    // bills. Serialises concurrent purchase-bill creators long enough to
    // allocate a unique number; auto-released on commit/rollback.
    await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
      replacements: { key: 905 }, transaction: t,
    });
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const prefix = settings?.purchase_bill_prefix?.trim() || '';
    // Default mode applied to NEW products created by this bill. Existing
    // products keep their own product_mode (read off the row).
    const defaultProductMode = settings?.default_product_mode || 'variant';
    const batchTrackingEnabled = !!settings?.batch_tracking_enabled;
    const lastBill = await PurchaseBill.findOne({
      order: [['purchase_bill_id', 'DESC']],
      transaction: t,
    });
    const lastNum = lastBill ? parseInt(lastBill.bill_number.split('-').pop()) : 0;
    billData.bill_number = generateBillNumber(prefix, lastNum);
    billData.created_by = req.user.user_id;

    // Resolve receiving godown — body-supplied wins (subject to allowlist),
    // else user default, else system default. The bill row carries it so
    // every downstream operation (per-godown stock add, future Place-of-
    // Supply for inward GST) reads the same value.
    const godownResolved = await resolveGodownForWrite({
      req_godown_id: billData.godown_id, user: req.user, t,
    });
    if (godownResolved.error) {
      await t.rollback();
      return res.status(403).json({ error: godownResolved.error });
    }
    billData.godown_id = godownResolved.godown_id;

    // Prefer the explicit mode flag from the client so bill-wise mode with all
    // three % = 0 (exempt goods) stays bill-wise instead of silently flipping
    // to product-wise and losing the zero-rated declaration.
    const billWise = gst_mode === 'bill'
      ? true
      : gst_mode === 'product'
        ? false
        : (parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0);

    let subTotal = 0;
    let totalQty = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;

    const processedItems = [];

    // PASS 1: compute per-line base (line total − item discount). GST is
    // deferred until the bill-level discount can be allocated pro-rata so
    // the tax base matches GST-law "transaction value" for trade discounts.
    for (const item of items) {
      // Clamp rules: qty ≥ 0, rate ≥ 0, 0 ≤ disc% ≤ 100. A 150% discount would
      // flip the tax base negative; a negative qty/rate would invert the
      // ledger direction. Reject loudly instead of silently applying `|| 0`.
      const qty  = parseFloat(item.quantity);
      const rate = parseFloat(item.purchase_rate);
      const itemDiscPct = parseFloat(item.discount_percentage || 0);
      if (!isFinite(qty) || qty < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Quantity must be a non-negative number (got "${item.quantity}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(rate) || rate < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Purchase rate must be a non-negative number (got "${item.purchase_rate}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Item discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").` });
      }
      const lineTotal = +(qty * rate).toFixed(2);
      const discountAmt = +(lineTotal * itemDiscPct / 100).toFixed(2);
      const postItemTaxable = +(lineTotal - discountAmt).toFixed(2);

      const resolved = await resolveOrCreateProduct(item, t, defaultProductMode);
      if (resolved._error) { await t.rollback(); return res.status(400).json({ error: resolved._error }); }
      const product_id = resolved.product_id;
      const barcode    = resolved.barcode;

      // Remap color_id when the line's pick belongs to a sibling
      // (family-color picker case). For an existing variant where the
      // operator picked one of its own colors, this is a no-op.
      const finalColorId = await resolveColorForProduct(item.color_id, item.color_name, product_id, t);

      processedItems.push({
        ...item,
        product_id,
        barcode,
        color_id: finalColorId,
        _postItemTaxable: postItemTaxable,
        taxable_amount: postItemTaxable,
        discount_amount: discountAmt,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        total_amount: 0,
        // Pin the resolved product on the processed line so the persistence
        // pass can read is_batch_tracked / product_mode without refetching.
        // Stripped before insert.
        _product: resolved.product || null,
      });

      subTotal += lineTotal;
      totalQty += qty;
    }

    // ── Batch tracking validation ─────────────────────────────────────
    //
    // Only enforce when the global setting is ON. With it OFF, batch-
    // tracked products silently revert to non-batch (the prompt is
    // explicit about this — toggling global must not break existing
    // bills). When ON, every line whose resolved product has
    // is_batch_tracked=true must carry a batch_number.
    if (batchTrackingEnabled) {
      for (const it of processedItems) {
        if (it._product?.is_batch_tracked && !it.batch_number) {
          if (!t.finished) await t.rollback();
          return res.status(400).json({
            error: `"${it.product_name || it._product.product_name}" is batch-tracked. Provide a batch number for this line.`,
          });
        }
      }
    }

    // Bill totals — Fix: use != null so explicit 0 isn't ignored in favour of percentage
    const billDiscPct = parseFloat(billData.discount_percentage || 0);
    if (!isFinite(billDiscPct) || billDiscPct < 0 || billDiscPct > 100) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount % must be between 0 and 100 (got ${billDiscPct}%).` });
    }
    const billDiscountAmt = billData.discount_amount != null
      ? parseFloat(billData.discount_amount)
      : +(subTotal * billDiscPct / 100).toFixed(2);
    const itemDiscountTotal = processedItems.reduce((s, it) => s + (parseFloat(it.discount_amount) || 0), 0);
    // A bill discount that exceeds the post-item base would flip taxableTotal
    // negative and cascade through GST / round-off math. Reject before persist.
    const postItemBaseP = +(subTotal - itemDiscountTotal).toFixed(2);
    if (!isFinite(billDiscountAmt) || billDiscountAmt < 0) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount amount must be non-negative (got ${billDiscountAmt}).` });
    }
    if (billDiscountAmt > postItemBaseP + 0.01) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount (₹${billDiscountAmt.toFixed(2)}) cannot exceed post-item-discount total (₹${postItemBaseP.toFixed(2)}).` });
    }
    const taxableTotal = +(subTotal - itemDiscountTotal - billDiscountAmt).toFixed(2);

    // PASS 2: allocate bill-level trade discount across items pro-rata, then
    // compute GST on the post-discount line base.
    const postItemTotalP = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
    const billDiscRatioP = postItemTotalP > 0 ? billDiscountAmt / postItemTotalP : 0;

    for (const it of processedItems) {
      const lineBase = +(it._postItemTaxable * (1 - billDiscRatioP)).toFixed(2);
      it.taxable_amount = lineBase;
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(lineBase, it.gst_rate || 0);
      it.cgst_amount = gst.cgst;
      it.sgst_amount = gst.sgst;
      it.igst_amount = gst.igst;
      it.total_amount = +(lineBase + gst.cgst + gst.sgst + gst.igst).toFixed(2);
      if (!billWise) {
        totalCgst += gst.cgst;
        totalSgst += gst.sgst;
        totalIgst += gst.igst;
      }
      delete it._postItemTaxable;
    }

    if (billWise) {
      // Round-half-away-from-zero (Tally/GST convention), not toFixed's banker's.
      totalCgst = roundTo(taxableTotal * parseFloat(cgst_pct) / 100, 2);
      totalSgst = roundTo(taxableTotal * parseFloat(sgst_pct) / 100, 2);
      totalIgst = roundTo(taxableTotal * parseFloat(igst_pct) / 100, 2);
    }

    const { roundedAmount, roundOffValue } = roundOff(
      taxableTotal + totalCgst + totalSgst + totalIgst + totalCess
      + parseFloat(other_charges || 0)
      + parseFloat(freight_charges || 0)
    );

    const totalAmount = roundedAmount;
    const paidAmt = parseFloat(paid_amount) || 0;

    // Fix: reject if paid_amount exceeds bill total
    if (paidAmt > totalAmount + 0.01) {
      await t.rollback();
      return res.status(400).json({ error: `Paid amount (₹${paidAmt.toFixed(2)}) cannot exceed bill total (₹${totalAmount.toFixed(2)})` });
    }

    const balanceAmount = +(totalAmount - paidAmt).toFixed(2);
    let paymentStatus = 'Unpaid';
    if (paidAmt >= totalAmount) paymentStatus = 'Paid';
    else if (paidAmt > 0) paymentStatus = 'Partial';

    // Blacklist guard — suppliers flagged as Blacklist can't be transacted
    // with. Credit-limit enforcement is sales-side only (see partyGuards.js).
    if (billData.supplier_id) {
      const supplier = await Party.findByPk(billData.supplier_id, { transaction: t });
      const guard = checkPartyForBillSave({ party: supplier, newBillOutstanding: balanceAmount });
      if (guard) {
        await t.rollback();
        return res.status(guard.status).json({ error: guard.error });
      }
    }

    const bill = await PurchaseBill.create({
      ...billData,
      total_items: items.length,
      total_quantity: totalQty,
      sub_total: subTotal,
      discount_amount: billDiscountAmt,
      cgst_pct: parseFloat(cgst_pct) || 0,
      sgst_pct: parseFloat(sgst_pct) || 0,
      igst_pct: parseFloat(igst_pct) || 0,
      cgst_amount: totalCgst,
      sgst_amount: totalSgst,
      igst_amount: totalIgst,
      cess_amount: totalCess,
      round_off: roundOffValue,
      other_charges: parseFloat(other_charges) || 0,
      freight_charges: parseFloat(freight_charges) || 0,
      total_amount: totalAmount,
      paid_amount: paidAmt,
      balance_amount: balanceAmount,
      payment_status: paymentStatus,
    }, { transaction: t });

    // ── Pre-flight color validation ──────────────────────────────
    // Mirrors the sales controller. Direction = 'purchase' so the
    // helper validates (color belongs to product, multi-color products
    // require a color) but skips the stock-deplete check (purchase
    // increments stock, never depletes it).
    try {
      await validateBillColorRequirements({
        items: processedItems,
        direction: 'purchase',
        transaction: t,
      });
    } catch (err) {
      await t.rollback();
      return res.status(err.status || 400).json({ error: err.message });
    }

    for (const item of processedItems) {
      // Resolve / create the batch BEFORE inserting the bill item so the
      // line carries its batch_id. Same first-write-wins behaviour as the
      // helper: a re-purchase of an existing batch reuses the row, doesn't
      // overwrite mfg/exp/notes.
      let batchId = null;
      let batchRow = null;
      if (item.product_id && batchTrackingEnabled
          && item._product?.is_batch_tracked && item.batch_number) {
        batchRow = await resolveOrCreateBatch({
          product_id: item.product_id,
          batch_number: item.batch_number,
          manufacture_date: item.manufacture_date,
          expiry_date: item.expiry_date,
          notes: item.batch_notes,
          t,
        });
        batchId = batchRow.batch_id;
      }

      // Strip transient fields (_product, batch metadata) before insert —
      // PurchaseBillItem only stores batch_id, not the metadata. Sequelize
      // would silently drop unknown attributes on insert, but stripping
      // makes the payload obvious in the audit trail.
      const { _product, batch_number, manufacture_date, expiry_date, batch_notes, ...billItemData } = item;
      await PurchaseBillItem.create({
        purchase_bill_id: bill.purchase_bill_id,
        ...billItemData,
        batch_id: batchId,
      }, { transaction: t });

      // Update product stock at the receiving godown + refresh catalog
      // rates. The catalog rates (purchase_rate, margin, sale_rate, mrp)
      // remain a single global value — this commit doesn't introduce
      // per-godown pricing. Only inventory quantity is per-godown.
      if (item.product_id) {
        const product = item._product || await Product.findByPk(item.product_id, { transaction: t });
        const isSingleMode = product.product_mode === 'single';
        // ── Single-mode wac update runs BEFORE applyGodownStockDelta ───
        // The helper reads product.current_stock as the pre-purchase old
        // stock for the formula. If we ran it after the delta, current_stock
        // would already include this line's qty and the formula would
        // double-count. Order matters; do not flip without re-reading the
        // helper. For variant mode this branch is a no-op.
        if (isSingleMode && !product.is_batch_tracked) {
          await applyWeightedAvgIncrement({
            product_id: item.product_id,
            qty: +parseFloat(item.quantity),
            purchase_rate: item.purchase_rate,
            t,
          });
        }
        const newStock = await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: +parseFloat(item.quantity), t,
        });
        // Per-batch on-hand mirrors the godown-level delta. Both must move
        // in the same transaction so a rollback restores both consistently.
        if (batchId) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: batchId,
            godown_id: billData.godown_id,
            delta: +parseFloat(item.quantity), t,
          });
        }
        // Per-color stock increment for multi-color tracked products.
        // Validation has already passed (above the loop) so color_id
        // is known to belong to this product.
        if (item.color_id) {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: +parseFloat(item.quantity),
            transaction: t,
          });
        }
        // ── Catalog field updates: mode-aware (audit-driven Phase 3) ────
        //
        // VARIANT mode: existing behaviour — overwrite catalog rates so
        //   the master row reflects the latest landed cost. Differing
        //   rates already created a new variant row above, so this only
        //   ever rewrites a row whose rates already match the line.
        //
        // SINGLE mode without batch: catalog purchase_rate stays FROZEN
        //   (overwriting it would obliterate cost basis — audit item
        //   8.2). Cost moves to weighted_avg_cost via the helper above.
        //   sale_rate / mrp / margin are sales-side concepts — operator
        //   manages those from the Product form, not via purchases.
        //   last_purchase_rate / last_purchase_date are convenience
        //   snapshots so the operator sees latest landed price without
        //   opening the bill.
        //
        // SINGLE mode with batch: cost lives on the batch row
        //   (product_batches.purchase_rate, first-write-wins). wac is
        //   not maintained — sales-time cost_rate snapshot reads from
        //   the batch instead. Catalog purchase_rate also stays frozen.
        if (!isSingleMode) {
          await product.update({
            purchase_rate: item.purchase_rate,
            margin_percentage: item.margin_percentage || product.margin_percentage,
            sale_rate: item.sale_rate || product.sale_rate,
            mrp: item.mrp || product.mrp,
          }, { transaction: t });
        } else {
          await product.update({
            last_purchase_rate: item.purchase_rate,
            last_purchase_date: billData.bill_date,
          }, { transaction: t });
          if (product.is_batch_tracked && batchRow
              && (batchRow.purchase_rate == null || parseFloat(batchRow.purchase_rate) === 0)) {
            // First-write-wins: only set rate if the batch was just
            // created (or migrated in without a rate). A re-purchase of
            // an existing batch keeps the original cost so historical
            // attribution stays stable across restocks.
            await batchRow.update({ purchase_rate: item.purchase_rate }, { transaction: t });
          }
        }

        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: batchId,
          barcode: item.barcode,
          transaction_type: 'Purchase',
          transaction_date: billData.bill_date,
          reference_id: bill.purchase_bill_id,
          reference_number: bill.bill_number,
          quantity_in: item.quantity,
          quantity_out: 0,
          rate: item.purchase_rate,
          balance_quantity: newStock,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    // Recalculate supplier balance from scratch
    await recalculatePartyBalance(billData.supplier_id, t);

    // If this bill came from a recalled draft, delete the draft inside the
    // same transaction. Race-safe: rollback keeps the draft alive for retry;
    // a duplicate recall results in the second DELETE being a no-op.
    if (draft_id) {
      await PurchaseBillDraft.destroy({
        where: { draft_id },
        transaction: t,
      });
    }

    // ── Double-entry posting ──
    {
      const billForPosting = await PurchaseBill.findByPk(bill.purchase_bill_id, {
        include: [{ model: Party, as: 'supplier' }],
        transaction: t,
      });
      const vouchers = await buildPurchaseBillVouchers(billForPosting, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
      // Two-way ledger (R8 Phase 2) — mirror of Sales side. Inserts a
      // payments_receipts row + allocation when paid_amount > 0 for a
      // non-cash supplier so the Payments list + bill-detail Payments
      // section see the auto-payment.
      await syncAutoReceiptForBill({ kind: 'purchase', bill: billForPosting, t });
    }

    await t.commit();

    // Return full bill with items for barcode printing
    const result = await PurchaseBill.findByPk(bill.purchase_bill_id, {
      include: [
        { model: Party, as: 'supplier', attributes: ['party_name'] },
        {
          model: PurchaseBillItem,
          as: 'items',
          include: [{ model: Product, as: 'product', include: [{ model: Category, attributes: ['category_name'] }] }],
        },
      ],
    });

    res.status(201).json(result);
  } catch (error) {
    // Guard against double-rollback: early validation branches already rolled
    // back the transaction and returned. If a subsequent `res.json(...)` call
    // threw (e.g. client disconnected mid-response), Sequelize would reject
    // a second rollback. `t.finished` — set to 'commit' | 'rollback' after
    // either completes — prevents that secondary error from masking the real one.
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Create purchase error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    let { items: newItems, paid_amount = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, other_charges = 0, freight_charges = 0, gst_mode, bill_mode, amount, gst_rate: amountGstRate, hsn_code: amountHsnCode, description: amountDescription, ...billData } = req.body;

    // Same amount-only synthesis as create() — see comment block there.
    if (bill_mode === 'amount') {
      const amt = parseFloat(amount);
      const rate = parseFloat(amountGstRate || 0);
      if (!isFinite(amt) || amt <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'Amount must be greater than 0 for amount-only bills.' });
      }
      if (!isFinite(rate) || rate < 0 || rate > 100) {
        await t.rollback();
        return res.status(400).json({ error: 'GST rate must be between 0 and 100.' });
      }
      const hsn  = (amountHsnCode || '9999').toString().trim() || '9999';
      const desc = (amountDescription || 'Service / Misc').toString().trim() || 'Service / Misc';
      newItems = [{
        product_id:          null,
        barcode:             null,
        category_id:         null,
        category_name:       '',
        product_name:        desc,
        size:                '',
        article_number:      '',
        hsn_code:            hsn,
        unit_type:           'OTH',
        quantity:            1,
        purchase_rate:       amt,
        discount_percentage: 0,
        discount_amount:     0,
        margin_percentage:   0,
        sale_rate:           0,
        mrp:                 0,
        gst_rate:            rate,
        quantity_per_box:    1,
      }];
      gst_mode = 'product';
      cgst_pct = 0; sgst_pct = 0; igst_pct = 0;
      billData.description = desc;
    }
    billData.bill_mode = bill_mode === 'amount' ? 'amount' : 'item';

    const existingBill = await PurchaseBill.findByPk(id, {
      include: [{ model: PurchaseBillItem, as: 'items' }],
      transaction: t,
    });
    if (!existingBill) { await t.rollback(); return res.status(404).json({ error: 'Bill not found' }); }
    if (existingBill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Cannot edit a cancelled bill' }); }

    // Resolve target godown — body wins (validate); else retain existing.
    if (billData.godown_id != null) {
      const denied = denyIfGodownInaccessible(billData.godown_id, req.user);
      if (denied) { await t.rollback(); return res.status(403).json({ error: denied }); }
    } else {
      billData.godown_id = existingBill.godown_id;
    }

    // ── Step 1: Reverse old stock effects (no reversal ledger entries) ───────
    // A purchase-update is: reverse-old + add-new. The NET effect on each
    // product is (newQty - oldQty). If allow_negative_stock is off and the
    // net effect would push stock below zero (i.e., some of the old-purchase
    // stock has already been sold and the new bill no longer covers it), we
    // must BLOCK the update — silently clamping to 0 here would corrupt the
    // inventory record and hide a real shortage from the user.
    const settings2 = await SystemSettings.findByPk(1, { transaction: t });
    const allowNeg2 = settings2?.allow_negative_stock || false;
    const defaultProductMode2 = settings2?.default_product_mode || 'variant';
    const batchTrackingEnabled = !!settings2?.batch_tracking_enabled;

    if (!allowNeg2) {
      // Aggregate net delta per product across both old and new items.
      const deltaByProduct = new Map();
      for (const oldItem of existingBill.items) {
        if (!oldItem.product_id) continue;
        const cur = deltaByProduct.get(oldItem.product_id) || 0;
        deltaByProduct.set(oldItem.product_id, cur - parseFloat(oldItem.quantity || 0));
      }
      // For new items, we may not have product_ids yet (resolveOrCreateProduct
      // happens in PASS 1 below). For stock-pre-check purposes we match by
      // barcode/article — but realistically, a purchase update only reduces
      // stock net when newQty < oldQty for the same product. Match items
      // heuristically by product_name for the pre-check.
      for (const newItem of newItems) {
        const matchOld = existingBill.items.find(o =>
          o.product_name && newItem.product_name &&
          String(o.product_name).trim().toLowerCase() === String(newItem.product_name).trim().toLowerCase()
        );
        if (matchOld?.product_id) {
          const cur = deltaByProduct.get(matchOld.product_id) || 0;
          deltaByProduct.set(matchOld.product_id, cur + parseFloat(newItem.quantity || 0));
        }
      }
      // Pre-check uses per-godown stock at the EXISTING bill's godown
      // (where the old purchase landed). If the same product was bought at
      // a different godown elsewhere, those quantities don't help — we can
      // only undo what was deposited at this specific godown.
      const oldGodown = existingBill.godown_id;
      for (const [pid, delta] of deltaByProduct) {
        if (delta >= 0) continue;              // net addition → safe
        const product = await Product.findByPk(pid, { transaction: t });
        const haveAtGodown = oldGodown
          ? await getGodownStock({ product_id: pid, godown_id: oldGodown, t, lock: true })
          : 0;
        const finalStock = +(haveAtGodown + delta).toFixed(2);
        if (finalStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Cannot update purchase bill: "${product.product_name}" would go to ${finalStock} units at this godown (${Math.abs(finalStock)} already sold). Enable "Allow Negative Stock" in Module Settings, or issue a Purchase Return instead.`,
          });
        }
      }
    }

    // Reverse old quantities at the EXISTING bill's godown (the one the
    // original purchase actually landed in). Even if the operator is
    // editing the bill to point at a different godown, the reversal must
    // go to the original — that's where the stock was added.
    const oldGodownId = existingBill.godown_id;
    for (const oldItem of existingBill.items) {
      if (oldItem.product_id && oldGodownId) {
        await applyGodownStockDelta({
          product_id: oldItem.product_id, godown_id: oldGodownId,
          delta: -parseFloat(oldItem.quantity), t,
        });
        // Reverse the per-batch on-hand too. If the old line carried a
        // batch_id, that batch's stock at the old godown must give back
        // the qty it received — otherwise the rebuild double-counts.
        if (oldItem.batch_id) {
          await applyBatchStockDelta({
            product_id: oldItem.product_id, batch_id: oldItem.batch_id,
            godown_id: oldGodownId,
            delta: -parseFloat(oldItem.quantity), t,
          });
        }
      }
    }
    // Reverse per-color stock from the OLD lines. Re-apply happens
    // inside the new-items loop using the updated color_id.
    await reverseBillColorStock({
      items: existingBill.items,
      direction: 'purchase',
      transaction: t,
    });

    // ── Step 2: Delete old stock ledger rows for this bill (keeps statement clean) ──
    await StockLedger.destroy({
      where: { reference_id: existingBill.purchase_bill_id, transaction_type: 'Purchase' },
      transaction: t,
    });

    // ── Step 3: Delete old items ───────────────────────────────────────────
    await PurchaseBillItem.destroy({ where: { purchase_bill_id: id }, transaction: t });

    // ── Step 4: Process new items (same logic as create) ───────────────────
    let subTotal = 0, totalQty = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;
    const processedItems = [];

    // Same mode detection as create() — see there for rationale.
    const billWise = gst_mode === 'bill'
      ? true
      : gst_mode === 'product'
        ? false
        : (parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0);

    // PASS 1: compute per-line post-item-discount base. Defer GST until bill
    // discount can be allocated pro-rata (GST law: apply to transaction value).
    for (const item of newItems) {
      // Same clamps as create() — reject loudly.
      const qty  = parseFloat(item.quantity);
      const rate = parseFloat(item.purchase_rate);
      const itemDiscPct = parseFloat(item.discount_percentage || 0);
      if (!isFinite(qty) || qty < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Quantity must be a non-negative number (got "${item.quantity}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(rate) || rate < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Purchase rate must be a non-negative number (got "${item.purchase_rate}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Item discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").` });
      }
      const lineTotal = +(qty * rate).toFixed(2);
      const discountAmt = +(lineTotal * itemDiscPct / 100).toFixed(2);
      const postItemTaxable = +(lineTotal - discountAmt).toFixed(2);

      const resolved = await resolveOrCreateProduct(item, t, defaultProductMode2);
      if (resolved._error) { await t.rollback(); return res.status(400).json({ error: resolved._error }); }
      const product_id = resolved.product_id;
      const barcode    = resolved.barcode;

      // Same color remap as create() — see comment in resolveColorForProduct.
      const finalColorId = await resolveColorForProduct(item.color_id, item.color_name, product_id, t);

      processedItems.push({
        ...item, product_id, barcode,
        color_id: finalColorId,
        _postItemTaxable: postItemTaxable,
        taxable_amount: postItemTaxable,
        discount_amount: discountAmt,
        cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
        total_amount: 0,
        _product: resolved.product || null,
      });

      subTotal += lineTotal; totalQty += qty;
    }

    // Same batch-tracking validation as create(). See note there for the
    // rationale around the global toggle gating per-product enforcement.
    if (batchTrackingEnabled) {
      for (const it of processedItems) {
        if (it._product?.is_batch_tracked && !it.batch_number) {
          if (!t.finished) await t.rollback();
          return res.status(400).json({
            error: `"${it.product_name || it._product.product_name}" is batch-tracked. Provide a batch number for this line.`,
          });
        }
      }
    }

    const billDiscPct2 = parseFloat(billData.discount_percentage || 0);
    if (!isFinite(billDiscPct2) || billDiscPct2 < 0 || billDiscPct2 > 100) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount % must be between 0 and 100 (got ${billDiscPct2}%).` });
    }
    const billDiscountAmt = billData.discount_amount != null
      ? parseFloat(billData.discount_amount)
      : +(subTotal * billDiscPct2 / 100).toFixed(2);
    const itemDiscountTotal2 = processedItems.reduce((s, it) => s + (parseFloat(it.discount_amount) || 0), 0);
    const postItemBaseP2 = +(subTotal - itemDiscountTotal2).toFixed(2);
    if (!isFinite(billDiscountAmt) || billDiscountAmt < 0) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount amount must be non-negative (got ${billDiscountAmt}).` });
    }
    if (billDiscountAmt > postItemBaseP2 + 0.01) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount (₹${billDiscountAmt.toFixed(2)}) cannot exceed post-item-discount total (₹${postItemBaseP2.toFixed(2)}).` });
    }
    const taxableTotal = +(subTotal - itemDiscountTotal2 - billDiscountAmt).toFixed(2);

    // PASS 2: pro-rate bill discount and recompute per-line GST on the net base.
    const postItemTotalP2 = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
    const billDiscRatioP2 = postItemTotalP2 > 0 ? billDiscountAmt / postItemTotalP2 : 0;
    for (const it of processedItems) {
      const lineBase = +(it._postItemTaxable * (1 - billDiscRatioP2)).toFixed(2);
      it.taxable_amount = lineBase;
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(lineBase, it.gst_rate || 0);
      it.cgst_amount = gst.cgst;
      it.sgst_amount = gst.sgst;
      it.igst_amount = gst.igst;
      it.total_amount = +(lineBase + gst.cgst + gst.sgst + gst.igst).toFixed(2);
      if (!billWise) {
        totalCgst += gst.cgst; totalSgst += gst.sgst; totalIgst += gst.igst;
      }
      delete it._postItemTaxable;
    }

    if (billWise) {
      // Round-half-away-from-zero (Tally/GST convention), not toFixed's banker's.
      totalCgst = roundTo(taxableTotal * parseFloat(cgst_pct) / 100, 2);
      totalSgst = roundTo(taxableTotal * parseFloat(sgst_pct) / 100, 2);
      totalIgst = roundTo(taxableTotal * parseFloat(igst_pct) / 100, 2);
    }

    const { roundedAmount, roundOffValue } = roundOff(
      taxableTotal + totalCgst + totalSgst + totalIgst + totalCess
      + parseFloat(other_charges || 0)
      + parseFloat(freight_charges || 0)
    );
    const totalAmount = roundedAmount;

    // Preserve payments already applied via the Payment module.
    // payment controller only touches balance_amount (not paid_amount), so:
    //   linkedPayments = old_total - old_balance - old_paid_at_billing
    const oldPaidAtBilling  = parseFloat(existingBill.paid_amount)    || 0;
    const oldBalance        = parseFloat(existingBill.balance_amount)  || 0;
    const oldTotal          = parseFloat(existingBill.total_amount)    || 0;
    const linkedPayments    = Math.max(0, +(oldTotal - oldBalance - oldPaidAtBilling).toFixed(2));

    const newPaidAtBilling  = parseFloat(paid_amount) || 0;
    const totalEffectivePaid = +(newPaidAtBilling + linkedPayments).toFixed(2);
    const balanceAmount     = Math.max(0, +(totalAmount - totalEffectivePaid).toFixed(2));

    let paymentStatus = 'Unpaid';
    if (totalEffectivePaid >= totalAmount)  paymentStatus = 'Paid';
    else if (totalEffectivePaid > 0)        paymentStatus = 'Partial';

    // Blacklist guard on edit too — if a supplier was flagged Blacklist
    // after the bill was created, don't let further edits land.
    const editSupplierId = billData.supplier_id || existingBill.supplier_id;
    if (editSupplierId) {
      const supplier = await Party.findByPk(editSupplierId, { transaction: t });
      const guard = checkPartyForBillSave({ party: supplier, newBillOutstanding: balanceAmount });
      if (guard) {
        await t.rollback();
        return res.status(guard.status).json({ error: guard.error });
      }
    }

    // ── Step 5: Update bill record ─────────────────────────────────────────
    await existingBill.update({
      supplier_id: billData.supplier_id || existingBill.supplier_id,
      bill_date: billData.bill_date || existingBill.bill_date,
      due_date: billData.due_date || null,
      supplier_bill_number: billData.supplier_bill_number || null,
      transport_name: billData.transport_name || null,
      vehicle_number: billData.vehicle_number || null,
      lr_number: billData.lr_number || null,
      // remarks/notes — if the client sent the field (including empty string
      // to clear), respect it; otherwise keep whatever was on the bill.
      remarks: billData.remarks !== undefined ? billData.remarks : existingBill.remarks,
      total_items: newItems.length, total_quantity: totalQty,
      sub_total: subTotal, discount_amount: billDiscountAmt,
      cgst_pct: parseFloat(cgst_pct) || 0,
      sgst_pct: parseFloat(sgst_pct) || 0,
      igst_pct: parseFloat(igst_pct) || 0,
      cgst_amount: totalCgst, sgst_amount: totalSgst, igst_amount: totalIgst,
      cess_amount: totalCess, round_off: roundOffValue,
      other_charges: parseFloat(other_charges) || 0,
      freight_charges: parseFloat(freight_charges) || 0,
      total_amount: totalAmount,
      paid_amount: newPaidAtBilling,
      balance_amount: balanceAmount,
      payment_status: paymentStatus,
    }, { transaction: t });

    // ── Step 6: Create new items + update stock ────────────────────────────
    // Track every product touched by old/new lines so we can recompute
    // weighted_avg_cost from ledger after the rebuild settles. Update path
    // can't safely incrementally adjust wac (a line edit can swap batches,
    // change rates, change qty, all at once). Full recompute is the
    // simplest correctness guarantee — same approach as recalculatePartyBalance.
    const touchedProductIds = new Set();
    for (const oldItem of existingBill.items) {
      if (oldItem.product_id) touchedProductIds.add(oldItem.product_id);
    }

    // Pre-flight color validation for the update path. Direction =
    // 'purchase' so the helper validates structure but skips stock
    // depletion (purchase increments).
    try {
      await validateBillColorRequirements({
        items: processedItems,
        direction: 'purchase',
        transaction: t,
      });
    } catch (err) {
      await t.rollback();
      return res.status(err.status || 400).json({ error: err.message });
    }

    for (const item of processedItems) {
      // Resolve / create the batch first so the inserted line carries the
      // batch_id and the StockLedger row tracks it. Same first-write-wins
      // semantics as create().
      let batchId = null;
      let batchRow = null;
      if (item.product_id && batchTrackingEnabled
          && item._product?.is_batch_tracked && item.batch_number) {
        batchRow = await resolveOrCreateBatch({
          product_id: item.product_id,
          batch_number: item.batch_number,
          manufacture_date: item.manufacture_date,
          expiry_date: item.expiry_date,
          notes: item.batch_notes,
          t,
        });
        batchId = batchRow.batch_id;
      }

      const { _product, batch_number, manufacture_date, expiry_date, batch_notes, ...billItemData } = item;
      await PurchaseBillItem.create({
        purchase_bill_id: id,
        ...billItemData,
        batch_id: batchId,
      }, { transaction: t });

      if (item.product_id) {
        touchedProductIds.add(item.product_id);
        const product = item._product || await Product.findByPk(item.product_id, { transaction: t });
        const isSingleMode = product.product_mode === 'single';
        const newStock = await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: +parseFloat(item.quantity), t,
        });
        if (batchId) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: batchId,
            godown_id: billData.godown_id,
            delta: +parseFloat(item.quantity), t,
          });
        }
        // Re-apply per-color stock at the new color_id. Old colors were
        // already credited back above; this re-debits the (possibly
        // changed) new color choice.
        if (item.color_id) {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: +parseFloat(item.quantity),
            transaction: t,
          });
        }
        // Mode-aware catalog field updates — see the equivalent block in
        // create() for the rationale. Variant rewrites rates; single
        // freezes purchase_rate and just bumps last_purchase_*.
        if (!isSingleMode) {
          await product.update({
            purchase_rate: item.purchase_rate,
            margin_percentage: item.margin_percentage || product.margin_percentage,
            sale_rate: item.sale_rate || product.sale_rate,
            mrp: item.mrp || product.mrp,
          }, { transaction: t });
        } else {
          await product.update({
            last_purchase_rate: item.purchase_rate,
            last_purchase_date: billData.bill_date || existingBill.bill_date,
          }, { transaction: t });
          if (product.is_batch_tracked && batchRow
              && (batchRow.purchase_rate == null || parseFloat(batchRow.purchase_rate) === 0)) {
            await batchRow.update({ purchase_rate: item.purchase_rate }, { transaction: t });
          }
        }
        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: batchId,
          barcode: item.barcode,
          transaction_type: 'Purchase',
          transaction_date: billData.bill_date || existingBill.bill_date,
          reference_id: id, reference_number: existingBill.bill_number,
          quantity_in: item.quantity, quantity_out: 0,
          rate: item.purchase_rate, balance_quantity: newStock,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    // Recompute wac for every touched single-mode non-batch product.
    // The new ledger rows are now in place; recomputeWeightedAvgFromLedger
    // walks them in chronological order and produces the correct final
    // wac. No-ops for variant-mode and batch-tracked products.
    for (const pid of touchedProductIds) {
      await recomputeWeightedAvgFromLedger({ product_id: pid, t });
    }

    // ── Step 7: Recalculate supplier balance from scratch ──────────────────
    const newSupplierId = billData.supplier_id || existingBill.supplier_id;
    await recalculatePartyBalance(newSupplierId, t);
    // If supplier changed, also recalculate the old one
    if (billData.supplier_id && billData.supplier_id !== existingBill.supplier_id) {
      await recalculatePartyBalance(existingBill.supplier_id, t);
    }

    // ── Double-entry: reverse old, post new ──
    await reverseVoucher({
      sourceType: 'purchase_bill', sourceId: existingBill.purchase_bill_id,
      reason: 'Purchase bill edited', userId: req.user && req.user.user_id, transaction: t,
    });
    await reverseVoucher({
      sourceType: 'purchase_bill_payment', sourceId: existingBill.purchase_bill_id,
      reason: 'Purchase bill edited', userId: req.user && req.user.user_id, transaction: t,
    });
    {
      const refreshed = await PurchaseBill.findByPk(existingBill.purchase_bill_id, {
        include: [{ model: Party, as: 'supplier' }],
        transaction: t,
      });
      const vouchers = await buildPurchaseBillVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
      // Two-way ledger sync — mirror of sales side. Handles edit
      // cases A-D (amount/paid up/down/zero/account-change).
      await syncAutoReceiptForBill({ kind: 'purchase', bill: refreshed, t });
    }

    await t.commit();

    const result = await PurchaseBill.findByPk(id, {
      include: [
        { model: Party, as: 'supplier', attributes: ['party_name'] },
        {
          model: PurchaseBillItem, as: 'items',
          include: [{ model: Product, as: 'product', include: [{ model: Category, attributes: ['category_name'] }] }],
        },
      ],
    });
    res.json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Update purchase error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.cancel = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const bill = await PurchaseBill.findByPk(req.params.id, {
      include: [{ model: PurchaseBillItem, as: 'items' }],
      transaction: t,
    });
    if (!bill) { await t.rollback(); return res.status(404).json({ error: 'Bill not found' }); }
    if (bill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Bill already cancelled' }); }

    // Block cancellation if the stock reversal would push any product below
    // zero while allow_negative_stock is disabled. This replaces the older
    // "any sale exists" heuristic — a sale is fine as long as other purchases
    // of the same product cover it. We check the actual final stock here.
    const settingsCanc = await SystemSettings.findByPk(1, { transaction: t });
    const allowNegCanc = settingsCanc?.allow_negative_stock || false;

    if (!allowNegCanc) {
      // Aggregate quantity-to-reverse per product (an item of the same product
      // may appear multiple times if sold in different sizes/barcodes).
      const revByProduct = new Map();
      for (const item of bill.items) {
        if (!item.product_id) continue;
        const cur = revByProduct.get(item.product_id) || 0;
        revByProduct.set(item.product_id, cur + parseFloat(item.quantity || 0));
      }
      // Cancellation reverses qty at the bill's own godown — that's where
      // the original purchase was added. Pre-check guards against pulling
      // stock below zero AT THAT GODOWN (other godowns' stock is irrelevant).
      const billGodown = bill.godown_id;
      for (const [pid, qty] of revByProduct) {
        const product = await Product.findByPk(pid, { transaction: t });
        const haveAtGodown = billGodown
          ? await getGodownStock({ product_id: pid, godown_id: billGodown, t, lock: true })
          : 0;
        const finalStock = +(haveAtGodown - qty).toFixed(2);
        if (finalStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Cannot cancel this purchase bill: "${product.product_name}" would go to ${finalStock} units at this godown (${Math.abs(finalStock)} already sold from this stock). Enable "Allow Negative Stock" in Module Settings, or create a Purchase Return instead.`,
          });
        }
      }
    }

    // ── Block if any active Payment from the Payment tab covers this bill ────
    // Check both new bill_allocations JSONB and legacy reference_bill_id field.
    const billId = bill.purchase_bill_id;
    const [linkedPaymentRows] = await sequelize.query(
      `SELECT transaction_number FROM payments_receipts
       WHERE is_cancelled = false
         AND transaction_type = 'Payment'
         AND (
           (bill_allocations IS NOT NULL
            AND bill_allocations @> :jsonCheck::jsonb)
           OR (reference_bill_id = :billId AND reference_bill_type = 'Purchase')
         )`,
      {
        replacements: {
          jsonCheck: JSON.stringify([{ bill_id: billId, bill_type: 'Purchase' }]),
          billId,
        },
        transaction: t,
      }
    );
    if (linkedPaymentRows.length > 0) {
      await t.rollback();
      const nums = linkedPaymentRows.map(r => r.transaction_number).join(', ');
      return res.status(400).json({
        error: `Cannot cancel this bill — the following payment(s) have been recorded against it: ${nums}. Please cancel those payments first, then cancel the bill.`,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Reverse stock at the bill's godown. Pre-check above already
    // guaranteed we won't go negative when allow_negative_stock is
    // disabled. allowGodownStockDelta handles the row-locked update +
    // products.current_stock mirror in one shot.
    const cancelTouchedProductIds = new Set();
    // Audit C6: legacy bills (pre-godown) have bill.godown_id = NULL.
    // Without a fallback the loop guard `bill.godown_id` skipped the
    // entire reversal — current_stock stayed at the post-purchase value
    // even though the StockLedger row was destroyed below, leaving
    // conservation broken silently. Resolve to the default godown so
    // the reversal still happens.
    let cancelGodownId = bill.godown_id;
    if (!cancelGodownId && bill.items.some(i => i.product_id)) {
      cancelGodownId = await getDefaultGodownId({ t });
    }
    for (const item of bill.items) {
      if (item.product_id && cancelGodownId) {
        cancelTouchedProductIds.add(item.product_id);
        await applyGodownStockDelta({
          product_id: item.product_id, godown_id: cancelGodownId,
          delta: -parseFloat(item.quantity), t,
        });
        // Mirror the reversal at the batch level so product_batch_stock
        // doesn't drift. Cancelling a purchase bill must restore the
        // batch's prior on-hand exactly — otherwise a follow-up sale
        // dropdown would show phantom batch stock.
        if (item.batch_id) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: item.batch_id,
            godown_id: cancelGodownId,
            delta: -parseFloat(item.quantity), t,
          });
        }
      }
    }
    // Reverse the per-color stock that this purchase added. Walks the
    // saved items[] and subtracts each color_id by its received qty.
    await reverseBillColorStock({
      items: bill.items,
      direction: 'purchase',
      transaction: t,
    });

    // Remove stock ledger entries for this bill (bill is gone, so entries should be gone too)
    await StockLedger.destroy({
      where: { reference_id: bill.purchase_bill_id, transaction_type: 'Purchase' },
      transaction: t,
    });

    // Recompute weighted_avg_cost for every single-mode product whose
    // ledger we just touched. The cancel removed Purchase rows from the
    // ledger; the helper walks what's left and produces the correct
    // post-cancel wac. No-op for variant-mode and batch-tracked products.
    for (const pid of cancelTouchedProductIds) {
      await recomputeWeightedAvgFromLedger({ product_id: pid, t });
    }

    // Zero out monetary fields + record who/when/why for the audit trail.
    const { reason: cancellationReason } = req.body || {};
    await bill.update({
      is_cancelled: true,
      cancelled_by: req.user.user_id,
      cancelled_date: new Date(),
      cancellation_reason: cancellationReason || null,
      balance_amount: 0,
      payment_status: 'Unpaid',
    }, { transaction: t });

    // Redistribute any active payments across remaining bills (FIFO), then fix party balance
    await reconcileBillsForParty(bill.supplier_id, t);
    await recalculatePartyBalance(bill.supplier_id, t);

    // ── Double-entry: reverse the bill's vouchers ──
    await reverseVoucher({
      sourceType: 'purchase_bill', sourceId: bill.purchase_bill_id,
      reason: cancellationReason || 'Purchase bill cancelled',
      userId: req.user && req.user.user_id, transaction: t,
    });
    await reverseVoucher({
      sourceType: 'purchase_bill_payment', sourceId: bill.purchase_bill_id,
      reason: cancellationReason || 'Purchase bill cancelled',
      userId: req.user && req.user.user_id, transaction: t,
    });
    // Two-way ledger cancel cascade — soft-cancel the auto-payment
    // row + drop its allocation. Mirror of sales side.
    await reverseAutoReceiptForBill({
      kind: 'purchase',
      billId: bill.purchase_bill_id,
      reason: cancellationReason || 'Purchase bill cancelled',
      userId: req.user && req.user.user_id,
      t,
    });

    await t.commit();
    res.json({ message: 'Bill cancelled successfully' });
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Cancel purchase error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
