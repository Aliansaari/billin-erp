const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { SalesBill, SalesBillItem, SalesBillDraft, SalesReturnBill, SalesReturnBillItem, Party, Product, StockLedger, SystemSettings, Godown } = require('../models');
const { generateBillNumber, roundOff, calculateGST, roundTo, sanitizePagination } = require('../utils/helpers');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');
const { resolveInterState } = require('../utils/interStateResolver');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers } = require('../services/voucherBuilders');
const { syncAutoReceiptForBill, reverseAutoReceiptForBill } = require('../services/autoReceiptService');
const { applyGodownStockDelta, getGodownStock, resolveGodownForWrite } = require('../utils/godownStock');
const {
  validateBillColorRequirements,
  applyColorStockDelta,
  reverseBillColorStock,
} = require('../services/productColorStockService');
const { applyBatchStockDelta, getBatchStock } = require('../utils/batchStock');
const { ProductBatch, ProductColor } = require('../models');
const { denyIfGodownInaccessible } = require('../middleware/godownScope');
const { checkPartyForBillSave } = require('../utils/partyGuards');
const { computeCostRateForSale } = require('../utils/displayCost');

// Per-line batch validation for sales / sales-return / sales edits.
// Centralised so the stock-out (sale) and stock-in (sales return) paths
// apply the same expiry / availability rules. Returns null when the line
// is fine, or an error string for the controller to surface as a 400.
//
// Inputs:
//   product            — Sequelize Product instance (must already be loaded)
//   item               — line being saved; reads .batch_id, .quantity
//   godownId           — bill's godown
//   t                  — transaction
//   blockExpired       — bool (system_settings.block_expired_sales)
//   isReturn           — return paths skip the per-batch stock guard,
//                        because returns ADD stock back to the batch
//                        rather than draw it down.
async function validateBatchLine({ product, item, godownId, t, blockExpired, isReturn }) {
  if (!product) return null;
  if (!product.is_batch_tracked) return null;
  if (!item.batch_id) return null;  // Form may have skipped picker; caller handles separately.

  const batch = await ProductBatch.findByPk(item.batch_id, { transaction: t });
  if (!batch) return `Batch not found (id=${item.batch_id}) for "${product.product_name}".`;
  if (parseInt(batch.product_id, 10) !== parseInt(product.product_id, 10)) {
    return `Batch ${batch.batch_number} does not belong to "${product.product_name}".`;
  }
  if (batch.is_active === false) {
    return `Batch ${batch.batch_number} for "${product.product_name}" is inactive.`;
  }

  // Expiry guard — only on sale path. Returns can flow back into an
  // expired batch; the operator may legitimately be returning stock that
  // was sold before it expired.
  if (!isReturn && blockExpired && batch.expiry_date) {
    const expiry = new Date(batch.expiry_date);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (expiry < today) {
      return `Batch ${batch.batch_number} for "${product.product_name}" expired on ${batch.expiry_date} and "Block sales of expired batches" is enabled in Settings.`;
    }
  }

  if (!isReturn) {
    const onHand = await getBatchStock({
      product_id: product.product_id, batch_id: item.batch_id, godown_id: godownId, t,
    });
    if (parseFloat(item.quantity) > onHand + 0.001) {
      return `Batch ${batch.batch_number} for "${product.product_name}" has only ${onHand} available at the selected godown. Reduce qty or pick another batch.`;
    }
  }

  return null;
}

/**
 * Determine intra-state vs inter-state for a sales bill.
 *
 * Returns true (inter-state) only when both the company's state code and
 * the customer's place-of-supply state code are known AND differ. In any
 * ambiguous case (no customer, walk-in, missing state, missing settings)
 * defaults to false (intra-state) so legacy intra-state behaviour is
 * preserved — the safer default for cash-counter sales.
 *
 * Mirrors the same logic GSTR-1's classifier (utils/gstr1.js
 * `isInterState`/`placeOfSupply`) uses on the read side, so what we
 * STORE here is what the report will then SEE.
 */
// Backwards-compatible thin wrapper. The actual logic lives in
// utils/interStateResolver so salesReturnController + purchaseReturnController
// can share it (audit H1).
async function _resolveInterState(billData, t) {
  return resolveInterState({ partyId: billData.customer_id, transaction: t });
}

exports.getAll = async (req, res) => {
  try {
    const { from_date, to_date, customer_id, payment_status, search } = req.query;
    // Clamp page/limit — untrusted query params. "abc" → NaN; "-5" → negative
    // offset; "99999999" is a DoS vector. sanitizePagination caps at 500 rows.
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_cancelled: false };

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (payment_status) where.payment_status = payment_status;
    if (search) {
      // Search across bill number AND the joined customer's name / mobile
      // so "ansari" or "98765" in the search box matches the bills the user
      // expects. The $customer.field$ syntax tells Sequelize to reference
      // the included Party association rather than the SalesBill column.
      where[Op.or] = [
        { bill_number: { [Op.iLike]: `%${search}%` } },
        { '$customer.party_name$': { [Op.iLike]: `%${search}%` } },
        { '$customer.mobile_1$':  { [Op.iLike]: `%${search}%` } },
      ];
    }

    // Per-row aggregates so the list UI can show "3 items · 15 pcs" without
    // forcing the frontend to fetch each bill's items. Correlated subqueries
    // keep this to a single DB round-trip. COALESCE on the SUM — when a bill
    // has zero rows the subquery would otherwise return NULL.
    const { count, rows } = await SalesBill.findAndCountAll({
      where,
      attributes: {
        include: [
          [sequelize.literal(
            '(SELECT COUNT(*)::int FROM sales_bill_items WHERE sales_bill_items.sales_bill_id = "SalesBill"."sales_bill_id")'
          ), '_item_count'],
          [sequelize.literal(
            '(SELECT COALESCE(SUM(quantity), 0)::float FROM sales_bill_items WHERE sales_bill_items.sales_bill_id = "SalesBill"."sales_bill_id")'
          ), '_pcs_total'],
        ],
      },
      include: [
        { model: Party,  as: 'customer', attributes: ['party_name', 'mobile_1'] },
        { model: Godown, as: 'godown',   attributes: ['godown_id', 'code', 'name'] },
      ],
      order: [['bill_date', 'DESC'], ['sales_bill_id', 'DESC']],
      limit,
      offset,
      // subQuery:false is required because the WHERE clause can reference
      // the joined customer via $customer.*$ (when search is non-empty).
      // Keeping it unconditional also sidesteps a Sequelize bug where
      // findAndCountAll generates a malformed count(...) + ungrouped
      // column query when the attributes list contains correlated
      // sequelize.literal subqueries (the _item_count / _pcs_total ones
      // above). distinct:true is needed alongside so the count uses
      // DISTINCT sales_bill_id rather than counting joined rows.
      subQuery: false,
      distinct: true,
    });

    // Summary aggregates over the ENTIRE filtered set — used by the
    // KPI cards and the bottom totals strip. Without this, KPIs would
    // sum only the chunks the user has scrolled past, drifting from
    // what the page count claims. Only `is_cancelled = false` bills
    // contribute to financial totals (cancelled bills are kept for
    // audit trail but shouldn't inflate "total sales").
    const totals = await SalesBill.findAll({
      where,
      attributes: [
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total_amount')),    0), 'total_amount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('paid_amount')),     0), 'total_paid'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('balance_amount')),  0), 'total_balance'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('discount_amount')), 0), 'total_discount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('cgst_amount')),     0), 'total_cgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('sgst_amount')),     0), 'total_sgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('igst_amount')),     0), 'total_igst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('return_amount')),   0), 'total_return'],
        [sequelize.fn('COUNT', sequelize.col('sales_bill_id')), 'count'],
        [sequelize.fn('COUNT', sequelize.literal('CASE WHEN balance_amount > 0.01 THEN 1 END')), 'open_count'],
      ],
      // Same join (with subQuery:false + distinct from the count call
      // above) so $customer.party_name$ in the search WHERE clause
      // resolves correctly.
      include: [{ model: Party, as: 'customer', attributes: [] }],
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
      total_return:   +parseFloat(t.total_return   || 0).toFixed(2),
      count:          parseInt(t.count || 0, 10),
      open_count:     parseInt(t.open_count || 0, 10),
    };

    res.json({ total: count, page, limit, data: rows, summary });
  } catch (error) {
    console.error('Get sales error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const bill = await SalesBill.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'customer' },
        {
          model: SalesBillItem, as: 'items',
          include: [
            // Pull product so edit-mode can re-detect is_batch_tracked
            // (the picker's gating condition) without round-tripping for
            // each line. Pull the batch row so the form can prefill
            // batch_number / manufacture_date / expiry_date when a saved
            // line already has a batch_id, mirroring the purchase form.
            { model: Product, as: 'product', attributes: ['product_id', 'is_batch_tracked', 'product_mode', 'color_mode'] },
            { model: ProductBatch, as: 'batch', attributes: ['batch_id', 'batch_number', 'manufacture_date', 'expiry_date'] },
            // Color row tied to this line — populated for multi-color
            // products. Edit-mode rehydrates the items table using
            // it.color.color_name and it.color_id so the dropdown
            // shows the saved pick.
            { model: ProductColor, as: 'color', attributes: ['color_id', 'color_name'] },
          ],
        },
      ],
    });
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Create a paired SalesReturnBill inside the SAME transaction as a sales-bill
 * insert. Used by the "Return" button inside the SalesBillForm — when a
 * customer brings goods back AT the moment of buying new ones, the operator
 * adds them in the inline return modal and the backend creates a real
 * SalesReturnBill alongside the new sale (so it shows in the returns list,
 * restocks inventory, and reconciles the party balance correctly).
 *
 * Constraints (kept simple — the inline path doesn't expose the full SR form):
 *   - Always 'Items' mode (Amount-only inline returns aren't supported).
 *   - No reference_bill_id (standalone return paired with the new sale).
 *   - GST is per-item product rate — no bill-wise mode, no bill discount,
 *     no other/freight charges. The inline modal also doesn't expose those.
 *   - Customer is always the same as the new sales bill.
 *   - Refund is recorded as 0 (the customer's refund is netted against the
 *     new sale via SalesBill.return_amount, not paid out separately).
 *
 * Returns the created SalesReturnBill row (or null if items[] is empty).
 */
async function createInlineReturn({ customer_id, billDate, items, reason, isInterState, godown_id, req, t }) {
  if (!Array.isArray(items) || items.length === 0) return null;

  // Allocate next return number with a Postgres advisory lock so concurrent
  // creators serialise. The row-level FOR UPDATE on the latest row is NOT
  // enough — two transactions can both lock row N, both compute number N+1,
  // and the second INSERT then fails the unique index. The advisory lock
  // (key 904 = sales_returns) blocks any other sales-return creator until
  // this transaction commits, so the lookup below always sees the freshly
  // inserted row from a competitor. Auto-released on commit/rollback.
  await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
    replacements: { key: 904 }, transaction: t,
  });
  const settings = await SystemSettings.findByPk(1, { transaction: t });
  const prefix = settings?.sales_return_prefix?.trim() || 'SR';
  const lastReturn = await SalesReturnBill.findOne({
    order: [['sales_return_id', 'DESC']],
    transaction: t,
  });
  const lastNum = lastReturn ? parseInt((lastReturn.return_number.split('-').pop() || '0')) || 0 : 0;
  const returnNumber = generateBillNumber(prefix, lastNum);

  // Per-line totals + GST. Since gst_mode is always 'product' for inline
  // returns, GST is computed per item from its own gst_rate.
  let subTotal = 0, totalQty = 0;
  let totalCgst = 0, totalSgst = 0, totalIgst = 0;
  let totalItemDiscount = 0;
  const processedItems = [];
  for (const item of items) {
    const qty  = parseFloat(item.quantity);
    const rate = parseFloat(item.rate);
    const itemDiscPct = parseFloat(item.discount_percentage || 0);
    if (!isFinite(qty) || qty <= 0) throw new Error(`Return quantity must be > 0 (got "${item.quantity}" for "${item.product_name || 'item'}").`);
    if (!isFinite(rate) || rate < 0) throw new Error(`Return rate must be ≥ 0 (got "${item.rate}" for "${item.product_name || 'item'}").`);
    if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
      throw new Error(`Discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").`);
    }
    const lineTotal = +(qty * rate).toFixed(2);
    // GST applies to the POST-DISCOUNT taxable amount (transaction value),
    // matching the sales-bill formula and what the modal displays.
    const discountAmt   = +(lineTotal * itemDiscPct / 100).toFixed(2);
    const taxableAmount = +(lineTotal - discountAmt).toFixed(2);
    const gstRate = parseFloat(item.gst_rate || 0);
    // calculateGST already handles inter-state routing (IGST only) vs
    // intra-state (CGST+SGST half-half) so we just unpack the result.
    const gst = calculateGST(taxableAmount, gstRate, !!isInterState);
    const cgst_amount = gst.cgst;
    const sgst_amount = gst.sgst;
    const igst_amount = gst.igst;
    processedItems.push({
      product_id:          item.product_id || null,
      barcode:             item.barcode || null,
      category_id:         item.category_id || null,
      category_name:       item.category_name || '',
      product_name:        item.product_name || '',
      size:                item.size || '',
      article_number:      item.article_number || '',
      hsn_code:            item.hsn_code || '',
      unit_type:           item.unit_type || 'Pcs',
      quantity:            qty,
      rate,
      discount_percentage: itemDiscPct,
      discount_amount:     discountAmt,
      taxable_amount:      taxableAmount,
      cgst_amount, sgst_amount, igst_amount,
      total_amount:        +(taxableAmount + cgst_amount + sgst_amount + igst_amount).toFixed(2),
      mrp:                 parseFloat(item.mrp || 0),
      gst_rate:            gstRate,
    });
    subTotal += lineTotal;
    totalItemDiscount += discountAmt;
    totalQty += qty;
    totalCgst += cgst_amount;
    totalSgst += sgst_amount;
    totalIgst += igst_amount;
  }
  const { roundedAmount, roundOffValue } = roundOff(
    subTotal + totalCgst + totalSgst + totalIgst
  );

  const returnBill = await SalesReturnBill.create({
    return_number: returnNumber,
    customer_id,
    godown_id,
    return_date: billDate,
    reference_bill_id: null,    // standalone — inline return isn't tied to a single past bill
    return_mode: 'Items',
    reason: reason || 'Return at counter (paired with sale)',
    total_items: processedItems.length,
    total_quantity: totalQty,
    sub_total: subTotal,
    // discount_amount on the header = sum of per-line item discounts so
    // the returns list / edit-form show the correct discount total.
    discount_amount: +totalItemDiscount.toFixed(2),
    cgst_pct: 0, sgst_pct: 0, igst_pct: 0,
    cgst_amount: totalCgst,
    sgst_amount: totalSgst,
    igst_amount: totalIgst,
    cess_amount: 0,
    round_off: roundOffValue,
    other_charges: 0,
    freight_charges: 0,
    total_amount: roundedAmount,
    refund_amount: 0,
    balance_amount: roundedAmount,
    refund_status: 'Pending',
    created_by: req.user.user_id,
  }, { transaction: t });

  // Persist line items + restock products in the same txn.
  for (const it of processedItems) {
    await SalesReturnBillItem.create({
      sales_return_id: returnBill.sales_return_id,
      ...it,
    }, { transaction: t });

    if (it.product_id) {
      const product = await Product.findByPk(it.product_id, { transaction: t });
      if (product) {
        // Restock at the SAME godown the parent sale issued from. Inline
        // returns piggy-back on the sales bill, so godown_id flows through
        // the call site (paired sale uses billData.godown_id).
        const newStock = await applyGodownStockDelta({
          product_id: it.product_id, godown_id, delta: +parseFloat(it.quantity), t,
        });
        await StockLedger.create({
          product_id: it.product_id,
          godown_id,
          barcode: it.barcode,
          transaction_type: 'Sales Return',
          transaction_date: billDate,
          reference_id: returnBill.sales_return_id,
          reference_number: returnBill.return_number,
          quantity_in: it.quantity,
          quantity_out: 0,
          rate: it.rate,
          balance_quantity: newStock,
          remarks: 'Inline return at sale',
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }
  }

  return returnBill;
}

exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    let { items, paid_amount = 0, return_amount = 0, special_discount = 0, other_charges = 0, freight_charges = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, gst_mode, bill_mode, amount, gst_rate: amountGstRate, hsn_code: amountHsnCode, description: amountDescription, draft_id, inline_return, ...billData } = req.body;

    // ── AMOUNT-ONLY MODE ─────────────────────────────────────────────
    // For service / on-account / quick-charge bills the operator enters
    // just (amount, gst_rate, hsn_code, description) — no item list. We
    // synthesise exactly one line item here so the rest of the pipeline
    // (PASS 1, PASS 2, ledger, balance, GSTR-1 routing) runs unchanged.
    //
    // Critical invariants:
    //   - quantity = 1 (SalesBillItem.quantity is allowNull:false)
    //   - rate     = amount         → line_total  = amount
    //   - taxable_amount = amount   (no item or bill discount in this mode)
    //   - product_id = null         → stock loop skips this line (line ~313)
    //   - gst_mode forced to 'product' so per-rate routing works correctly
    //   - cgst/sgst/igst computed by the same calculateGST() helper using
    //     the resolved inter-state flag → GSTR-1 sees the right amounts
    //     and classifies the bill identically to an itemised equivalent.
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
        rate:                amt,
        discount_percentage: 0,
        discount_amount:     0,
        mrp:                 0,
        gst_rate:            rate,
        quantity_per_box:    1,
      }];
      gst_mode = 'product';   // force per-line GST math
      cgst_pct = 0;
      sgst_pct = 0;
      igst_pct = 0;
      // Persist the description on the bill header too so the print
      // template / reports can show it without reading the items list.
      billData.description = desc;
    }
    billData.bill_mode = bill_mode === 'amount' ? 'amount' : 'item';

    if (!items || !Array.isArray(items) || items.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: 'At least one item is required.' });
    }

    // ── Bill number race (Fix #17) ─────────────────────────────────────
    // The earlier row-level FOR UPDATE lock on the latest sales_bills row
    // was not enough: two concurrent inserts could both lock row N, both
    // compute N+1, and the second INSERT then fails the unique index — a
    // 75% failure rate under 20-client concurrency. Switching to a
    // Postgres advisory lock keyed per doc-type (903 = sales bills)
    // serialises ALL sales-bill creators for the brief number-allocation
    // window. Sales-return / purchase / payment creators use different
    // keys so they don't needlessly block each other. Auto-released on
    // commit/rollback.
    await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
      replacements: { key: 903 }, transaction: t,
    });
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const prefix = settings?.sales_bill_prefix?.trim() || '';
    const lastBill = await SalesBill.findOne({
      order: [['sales_bill_id', 'DESC']],
      transaction: t,
    });
    const lastNum = lastBill ? parseInt(lastBill.bill_number.split('-').pop()) : 0;
    billData.bill_number = generateBillNumber(prefix, lastNum);
    billData.created_by = req.user.user_id;
    billData.sales_person = billData.sales_person || req.user.user_id;

    // ── Resolve issuing godown ──
    // Explicit body.godown_id wins (subject to allowed_godowns). When
    // missing (legacy clients, scripts, imports), fall back to the user's
    // first allowed godown or the system default. The bill row carries
    // the resolved id so every downstream operation (stock writes, GST
    // routing, print Place-of-Supply) reads the same value.
    const godownResolved = await resolveGodownForWrite({
      req_godown_id: billData.godown_id, user: req.user, t,
    });
    if (godownResolved.error) {
      await t.rollback();
      return res.status(403).json({ error: godownResolved.error });
    }
    billData.godown_id = godownResolved.godown_id;

    // Prefer the explicit mode flag from the client. Fall back to the legacy
    // "any non-zero %" heuristic only when the flag is missing, so older
    // cached frontends keep working. A firm selling GST-exempt goods in
    // bill-wise mode (all three % = 0) now correctly stays in bill-wise mode.
    const billWise = gst_mode === 'bill'
      ? true
      : gst_mode === 'product'
        ? false
        : (parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0);

    let subTotal = 0;
    let totalQty = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;

    // PASS 1: compute per-line base (line total − item discount). We can't
    // calculate GST yet because the bill-level trade discount must be
    // allocated across lines first — GST applies to the post-trade-discount
    // "transaction value" under GST law.
    const processedItems = [];
    for (const item of items) {
      // Clamp inputs: quantity ≥ 0, rate ≥ 0, 0 ≤ discount% ≤ 100. A negative
      // qty or rate would invert the ledger sign; a discount > 100% would
      // produce a negative taxable base that GST/round-off math silently
      // propagates, and a negative discount would inflate the bill. Reject
      // loudly — silently clamping would hide data-entry mistakes from the
      // operator (e.g. typing "25" for a ₹25 discount in the % column).
      const qty  = parseFloat(item.quantity);
      const rate = parseFloat(item.rate);
      const itemDiscPct = parseFloat(item.discount_percentage || 0);
      if (!isFinite(qty) || qty < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Quantity must be a non-negative number (got "${item.quantity}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(rate) || rate < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Rate must be a non-negative number (got "${item.rate}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Item discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").` });
      }
      const lineTotal = +(qty * rate).toFixed(2);
      const discountAmt = +(lineTotal * itemDiscPct / 100).toFixed(2);
      const taxableAmt = +(lineTotal - discountAmt).toFixed(2);

      processedItems.push({
        ...item,
        _lineTotal: lineTotal,
        _postItemTaxable: taxableAmt,     // line total after item-level discount
        taxable_amount: taxableAmt,        // will be overwritten with post-bill-disc value below
        discount_amount: discountAmt,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        total_amount: 0,
      });

      subTotal += lineTotal;
      totalQty += qty;
    }

    // Resolve bill-level (trade) discount.
    // Use != null so an explicit 0 isn't ignored in favour of a percentage.
    const billDiscPct = parseFloat(billData.discount_percentage || 0);
    if (!isFinite(billDiscPct) || billDiscPct < 0 || billDiscPct > 100) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount % must be between 0 and 100 (got ${billDiscPct}%).` });
    }
    const billDiscountAmt = billData.discount_amount != null
      ? parseFloat(billData.discount_amount)
      : +(subTotal * billDiscPct / 100).toFixed(2);
    const itemDiscountTotal = processedItems.reduce((s, it) => s + (parseFloat(it.discount_amount) || 0), 0);
    // Guard: bill-level discount cannot be negative, and cannot exceed
    // the post-item-discount base (otherwise taxableTotal turns negative
    // and every downstream GST/round-off figure is wrong).
    const postItemBase = +(subTotal - itemDiscountTotal).toFixed(2);
    if (!isFinite(billDiscountAmt) || billDiscountAmt < 0) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount amount must be non-negative (got ${billDiscountAmt}).` });
    }
    if (billDiscountAmt > postItemBase + 0.01) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount (₹${billDiscountAmt.toFixed(2)}) cannot exceed post-item-discount total (₹${postItemBase.toFixed(2)}).` });
    }
    const taxableTotal = +(subTotal - itemDiscountTotal - billDiscountAmt).toFixed(2);

    // PASS 2: allocate the bill-level discount pro-rata to each line based
    // on its post-item-discount taxable amount, then compute GST on that
    // reduced base. Pro-rata allocation preserves item-level reporting
    // fidelity — every item row carries its own correct taxable & GST.
    const postItemTotal = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
    const billDiscRatio = postItemTotal > 0 ? billDiscountAmt / postItemTotal : 0;

    // Resolve intra/inter once for the whole bill — every line uses it.
    // Without this, product-mode bills to out-of-state customers stored
    // CGST+SGST instead of IGST (the legacy default for calculateGST is
    // intra-state). This is a correctness fix that benefits BOTH the new
    // amount-only mode AND existing product-mode inter-state bills.
    // Bill-wise mode is unaffected — its rates come from the operator.
    const interState = billWise ? false : await _resolveInterState(billData, t);

    for (const it of processedItems) {
      const lineBase = +(it._postItemTaxable * (1 - billDiscRatio)).toFixed(2);
      it.taxable_amount = lineBase;
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(lineBase, it.gst_rate || 0, interState);
      it.cgst_amount = gst.cgst;
      it.sgst_amount = gst.sgst;
      it.igst_amount = gst.igst;
      it.total_amount = +(lineBase + gst.cgst + gst.sgst + gst.igst).toFixed(2);
      if (!billWise) {
        totalCgst += gst.cgst;
        totalSgst += gst.sgst;
        totalIgst += gst.igst;
      }
      // strip private bookkeeping fields before persisting
      delete it._lineTotal;
      delete it._postItemTaxable;
    }

    // Bill-wise: override GST totals using the provided percentages on the
    // single consolidated taxable base.
    // Use roundTo (round-half-away-from-zero) to match Tally's GST convention
    // and keep the two rounding paths (item-wise via calculateGST, bill-wise
    // here) consistent — previously toFixed(2) used banker's rounding in V8
    // and drifted by 1 paisa vs. Tally on exact .xxx5 amounts.
    if (billWise) {
      totalCgst = roundTo(taxableTotal * parseFloat(cgst_pct) / 100, 2);
      totalSgst = roundTo(taxableTotal * parseFloat(sgst_pct) / 100, 2);
      totalIgst = roundTo(taxableTotal * parseFloat(igst_pct) / 100, 2);
    }

    const { roundedAmount, roundOffValue } = roundOff(
      taxableTotal + totalCgst + totalSgst + totalIgst + totalCess
      - parseFloat(special_discount || 0)
      + parseFloat(other_charges || 0)
      + parseFloat(freight_charges || 0)
    );

    const totalAmount = roundedAmount;

    // Fix: validate return_amount doesn't exceed total
    const rawReturn = parseFloat(return_amount || 0);
    if (rawReturn > totalAmount + 0.01) {
      await t.rollback();
      return res.status(400).json({ error: `Return amount (₹${rawReturn.toFixed(2)}) cannot exceed bill total (₹${totalAmount.toFixed(2)})` });
    }

    // Enforce full payment if customer has credit_not_allowed
    let finalPaidAmount = parseFloat(paid_amount);
    let customer = null;
    if (billData.customer_id) {
      customer = await Party.findByPk(billData.customer_id, { transaction: t });
      if (customer && !customer.credit_allowed) {
        finalPaidAmount = totalAmount;
      }
    }

    // Fix: reject if paid_amount exceeds bill total
    if (finalPaidAmount > totalAmount + 0.01) {
      await t.rollback();
      return res.status(400).json({ error: `Paid amount (₹${finalPaidAmount.toFixed(2)}) cannot exceed bill total (₹${totalAmount.toFixed(2)})` });
    }

    const effectivePaid = +(finalPaidAmount + rawReturn).toFixed(2);
    const balanceAmount = +(totalAmount - effectivePaid).toFixed(2);

    // Blacklist + credit-limit hard block. Runs AFTER we know the bill's
    // final balance (totalAmount − effectivePaid) so the guard can reject
    // with an accurate "would take outstanding to ₹X" message. Guard
    // returns null when the save is allowed.
    const guard = checkPartyForBillSave({
      party: customer,
      newBillOutstanding: balanceAmount,
      enforceCreditLimit: true,
    });
    if (guard) {
      await t.rollback();
      return res.status(guard.status).json({ error: guard.error });
    }
    let paymentStatus = 'Unpaid';
    if (effectivePaid >= totalAmount) paymentStatus = 'Paid';
    else if (effectivePaid > 0) paymentStatus = 'Partial';

    const bill = await SalesBill.create({
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
      total_amount: totalAmount,
      paid_amount: finalPaidAmount,
      return_amount: parseFloat(return_amount) || 0,
      balance_amount: balanceAmount,
      payment_status: paymentStatus,
      special_discount: parseFloat(special_discount) || 0,
      other_charges: parseFloat(other_charges) || 0,
      freight_charges: parseFloat(freight_charges) || 0,
    }, { transaction: t });

    // Check negative stock setting once for all items
    const sysSettings = await SystemSettings.findByPk(1, { transaction: t });
    const allowNegativeStock = sysSettings?.allow_negative_stock || false;
    const blockExpiredSales  = !!sysSettings?.block_expired_sales;
    const batchTrackingOn    = !!sysSettings?.batch_tracking_enabled;

    // ── Pre-flight color validation ──────────────────────────────
    // Walks every line whose product is multi-color tracked, ensures
    // a valid color_id is present, and that aggregated qty across
    // lines doesn't exceed the color's current stock. Throws 400-
    // shaped errors loudly rather than rolling back mid-create.
    try {
      await validateBillColorRequirements({
        items: processedItems,
        direction: 'sale',
        allowNegativeStock,
        transaction: t,
      });
    } catch (err) {
      await t.rollback();
      return res.status(err.status || 400).json({ error: err.message });
    }

    for (const item of processedItems) {
      // Fetch the product once to (a) snapshot per-mode COGS for this
      // line via the shared helper, and (b) reuse for the stock
      // deduction below. Doing both off the same read avoids a second
      // roundtrip and keeps the cost snapshot in the same transaction
      // as the bill itself.
      //
      // computeCostRateForSale picks the right basis per mode:
      //   variant            → product.purchase_rate
      //   single, no batch   → product.weighted_avg_cost
      //   single + batch     → product_batches.purchase_rate for the
      //                        line's batch_id (per-batch frozen rate)
      // See server/utils/displayCost.js for the full fallback cascade.
      let product = null;
      if (item.product_id) {
        product = await Product.findByPk(item.product_id, { transaction: t });
      }

      // Batch dimension: for batch-tracked products with the global
      // setting ON, every line MUST carry batch_id (form picker
      // enforces it; this guard catches direct API callers that bypass
      // the UI). With the global setting OFF, batch-tracked products
      // silently fall back to godown-only — same regression contract
      // the purchase form follows.
      const batchId = (batchTrackingOn && product && product.is_batch_tracked)
        ? (item.batch_id || null)
        : null;
      if (batchTrackingOn && product && product.is_batch_tracked && !batchId) {
        await t.rollback();
        return res.status(400).json({
          error: `"${item.product_name || product.product_name}" is batch-tracked. Pick a batch for this line.`,
        });
      }

      // Expiry / per-batch availability guard. Returns null when fine,
      // or a user-readable error string we surface as a 400.
      if (batchId) {
        const err = await validateBatchLine({
          product, item: { ...item, batch_id: batchId },
          godownId: billData.godown_id, t,
          blockExpired: blockExpiredSales, isReturn: false,
        });
        if (err) { await t.rollback(); return res.status(400).json({ error: err }); }
      }

      const costRate = await computeCostRateForSale({
        product, batch_id: batchId || null, t,
      });

      // Defensive log: a batch-tracked single-mode product saving with
      // no batch_id means computeCostRateForSale fell back to wac. The
      // guard above should prevent this in practice — leaving the log
      // so any bypass surfaces in dev.
      if (product && product.is_batch_tracked && !batchId) {
        console.warn(`[salesController.create] batch-tracked product ${product.product_id} saved without batch_id on bill ${bill.sales_bill_id}; cost_rate fell back to wac.`);
      }

      await SalesBillItem.create({
        sales_bill_id: bill.sales_bill_id,
        ...item,
        batch_id: batchId,
        // Server-computed; overrides anything the client might have sent so
        // profit reports can't be manipulated by a tampered API call.
        cost_rate: costRate,
      }, { transaction: t });

      // Deduct stock at the BILL'S godown (not the global aggregate). The
      // pre-check uses getGodownStock so the per-godown current_stock
      // governs the negative-stock guard — a product that has 5 units
      // total but 0 at this godown can't be sold from this godown.
      if (product) {
        const currentStock = await getGodownStock({
          product_id: item.product_id, godown_id: billData.godown_id, t,
        });
        const newStock = +(currentStock - parseFloat(item.quantity)).toFixed(2);

        if (!allowNegativeStock && newStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for "${item.product_name || product.product_name}" at this godown. Available: ${currentStock}, Requested: ${item.quantity}. Enable "Allow Negative Stock" in Module Settings to proceed.`,
          });
        }

        await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: -parseFloat(item.quantity), t,
        });

        // Per-batch on-hand mirrors the godown-level delta (same
        // pattern as purchaseController). Both must move in the same
        // transaction so a rollback restores both consistently.
        if (batchId) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: batchId,
            godown_id: billData.godown_id,
            delta: -parseFloat(item.quantity), t,
          });
        }

        // Per-color stock decrement for multi-color products. Rides
        // alongside the godown / batch deltas in the same transaction
        // so a rollback restores everything together. validation
        // already passed above.
        if (item.color_id) {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: -parseFloat(item.quantity),
            transaction: t,
          });
        }

        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: batchId,
          barcode: item.barcode,
          transaction_type: 'Sales',
          transaction_date: billData.bill_date,
          reference_id: bill.sales_bill_id,
          reference_number: bill.bill_number,
          quantity_in: 0,
          quantity_out: item.quantity,
          rate: item.rate,
          balance_quantity: newStock,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    // ── INLINE RETURN ────────────────────────────────────────────────
    // If the operator added items in the "Return" modal on the sales-bill
    // form, create a paired SalesReturnBill inside the same transaction.
    // The customer must exist on the sale (a walk-in cash sale with
    // customer_id=null can't have a paired return — there's no party
    // ledger to credit). Stock restock + balance recalc happen below.
    let inlineReturnBill = null;
    if (inline_return && Array.isArray(inline_return.items) && inline_return.items.length > 0) {
      if (!billData.customer_id) {
        await t.rollback();
        return res.status(400).json({ error: 'Inline returns require a customer (walk-in cash sales cannot have a paired return).' });
      }
      try {
        inlineReturnBill = await createInlineReturn({
          customer_id: billData.customer_id,
          billDate:    billData.bill_date,
          items:       inline_return.items,
          reason:      inline_return.reason,
          // Reuse the same intra/inter-state resolution the sale used so
          // the return's GST routing matches the sale.
          isInterState: interState,
          // The paired return restocks at the same godown the sale shipped
          // from — goods physically came back to the same warehouse.
          godown_id: billData.godown_id,
          req, t,
        });
        // CRITICAL: zero out the SalesBill's `return_amount` field. Without
        // this, balanceHelper subtracts the return value TWICE — once via
        // the SalesBill.return_amount column (`salesWalkInReturn`) and
        // again via the SalesReturnBill.balance_amount we just created.
        // For inline returns the SalesReturnBill is the source of truth;
        // the SalesBill column is reserved for the legacy "type-the-amount"
        // flow that doesn't create a separate return record.
        await bill.update({ return_amount: 0 }, { transaction: t });
      } catch (rerr) {
        await t.rollback();
        return res.status(400).json({ error: 'Inline return: ' + rerr.message });
      }
    }

    // Recalculate customer balance from scratch — runs AFTER inline return
    // so the recompute sees both the new sale and the new return rows.
    if (billData.customer_id) {
      await recalculatePartyBalance(billData.customer_id, t);
    }

    // If this bill came from a recalled draft, delete the draft inside
    // the same transaction. Race-safe: if the create rolls back, the
    // draft survives so the operator can retry. If two operators
    // recalled the same draft and both saved, the second DELETE is a
    // no-op (destroy returns 0 rows) — both bills get created from the
    // same draft, but there's no orphaned draft.
    if (draft_id) {
      await SalesBillDraft.destroy({
        where: { draft_id },
        transaction: t,
      });
    }

    // ── Double-entry posting ─────────────────────────────────────────
    // Inside the same transaction so the sale and its ledger entries
    // commit (or roll back) together. If posting throws, the bill insert
    // and stock movements above also roll back.
    {
      const billForPosting = await SalesBill.findByPk(bill.sales_bill_id, {
        include: [{ model: Party, as: 'customer' }],
        transaction: t,
      });
      const vouchers = await buildSalesBillVouchers(billForPosting, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
      // Two-way ledger (R8 Phase 2): if the bill carries paid_amount > 0
      // for a non-cash customer, the voucher builder above emitted a
      // separate Receipt voucher to the journal. Mirror that with a
      // payments_receipts row + allocation so the Receipts list +
      // bill-detail Payments section see the auto-receipt. Idempotent
      // — sync is a no-op when paid_amount=0 or party=cash.
      await syncAutoReceiptForBill({ kind: 'sales', bill: billForPosting, t });
    }

    await t.commit();

    const result = await SalesBill.findByPk(bill.sales_bill_id, {
      include: [
        { model: Party, as: 'customer' },
        { model: SalesBillItem, as: 'items' },
      ],
    });

    res.status(201).json(result);
  } catch (error) {
    // Guard against double-rollback: early validation branches already rolled
    // back the transaction and returned. If a subsequent `res.json(...)` call
    // threw (e.g. client disconnected mid-response), Sequelize would reject
    // a second rollback with "Transaction cannot be rolled back because it
    // has been finished with state: rollback". The `t.finished` check —
    // which Sequelize sets to 'commit' | 'rollback' after either completes —
    // prevents that secondary error from masking the real one.
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Create sale error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    let { items: newItems, paid_amount = 0, return_amount = 0, special_discount = 0, other_charges = 0, freight_charges = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, gst_mode, bill_mode, amount, gst_rate: amountGstRate, hsn_code: amountHsnCode, description: amountDescription, ...billData } = req.body;

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
        hsn_code:             hsn,
        unit_type:           'OTH',
        quantity:            1,
        rate:                amt,
        discount_percentage: 0,
        discount_amount:     0,
        mrp:                 0,
        gst_rate:            rate,
        quantity_per_box:    1,
      }];
      gst_mode = 'product';
      cgst_pct = 0; sgst_pct = 0; igst_pct = 0;
      billData.description = desc;
    }
    billData.bill_mode = bill_mode === 'amount' ? 'amount' : 'item';

    const existingBill = await SalesBill.findByPk(id, {
      include: [{ model: SalesBillItem, as: 'items' }],
      transaction: t,
    });
    if (!existingBill) { await t.rollback(); return res.status(404).json({ error: 'Bill not found' }); }
    if (existingBill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Cannot edit a cancelled bill' }); }

    // Resolve target godown for this edit. If the body specifies one,
    // validate it; if not, retain the existing bill's godown. Same
    // permission gate as create — the user must have access to the
    // chosen godown.
    if (billData.godown_id != null) {
      const denied = denyIfGodownInaccessible(billData.godown_id, req.user);
      if (denied) { await t.rollback(); return res.status(403).json({ error: denied }); }
    } else {
      billData.godown_id = existingBill.godown_id;
    }

    // Step 1: Reverse old stock effects at the EXISTING bill's godown.
    // Edits don't migrate inventory between godowns — that's what stock
    // transfers are for. Even if the operator changes godown_id on edit,
    // the reversal goes back to the original godown (where the stock was
    // taken from); the apply-new step below pushes the deduction at the
    // updated godown.
    const oldGodownId = existingBill.godown_id;
    for (const oldItem of existingBill.items) {
      if (oldItem.product_id && oldGodownId) {
        await applyGodownStockDelta({
          product_id: oldItem.product_id, godown_id: oldGodownId,
          delta: +parseFloat(oldItem.quantity), t,
        });
        // Restore per-batch on-hand for the OLD batch the line had been
        // attached to. Mirror of the godown-level reverse — both must
        // move together so a rollback restores both consistently. The
        // new batch (which may differ if the operator changed it) gets
        // its decrement in the apply-new pass below.
        if (oldItem.batch_id) {
          await applyBatchStockDelta({
            product_id: oldItem.product_id, batch_id: oldItem.batch_id,
            godown_id: oldGodownId,
            delta: +parseFloat(oldItem.quantity), t,
          });
        }
      }
    }
    // Reverse the per-color stock from the OLD lines. Re-apply happens
    // inside the new-items loop below using the updated color_id, so
    // an edit that changes color X→Y correctly restores X and depletes Y.
    await reverseBillColorStock({
      items: existingBill.items,
      direction: 'sale',
      transaction: t,
    });

    // Step 2: Delete old stock ledger rows for this bill (keeps statement clean)
    await StockLedger.destroy({
      where: { reference_id: existingBill.sales_bill_id, transaction_type: 'Sales' },
      transaction: t,
    });

    // Step 3: Delete old items
    await SalesBillItem.destroy({ where: { sales_bill_id: id }, transaction: t });

    // Step 3: Process new items
    let subTotal = 0, totalQty = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;
    const processedItems = [];

    // Same mode detection as create() — see there for rationale.
    const billWise = gst_mode === 'bill'
      ? true
      : gst_mode === 'product'
        ? false
        : (parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0);

    // PASS 1: compute per-line post-item-discount base. GST must be deferred
    // until we know the bill-level discount to allocate pro-rata.
    for (const item of newItems) {
      // Same clamp rules as create() — reject invalid inputs loudly rather than
      // silently masking them with `|| 0`, which could let a 150% discount
      // flip taxable to negative or a negative qty invert the ledger sign.
      const qty  = parseFloat(item.quantity);
      const rate = parseFloat(item.rate);
      const itemDiscPct = parseFloat(item.discount_percentage || 0);
      if (!isFinite(qty) || qty < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Quantity must be a non-negative number (got "${item.quantity}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(rate) || rate < 0) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Rate must be a non-negative number (got "${item.rate}" for "${item.product_name || 'item'}").` });
      }
      if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
        if (!t.finished) await t.rollback();
        return res.status(400).json({ error: `Item discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").` });
      }
      const lineTotal = +(qty * rate).toFixed(2);
      const discountAmt = +(lineTotal * itemDiscPct / 100).toFixed(2);
      const postItemTaxable = +(lineTotal - discountAmt).toFixed(2);

      processedItems.push({
        ...item,
        _postItemTaxable: postItemTaxable,
        taxable_amount: postItemTaxable,
        discount_amount: discountAmt,
        cgst_amount: 0,
        sgst_amount: 0,
        igst_amount: 0,
        total_amount: 0,
      });

      subTotal += lineTotal;
      totalQty += qty;
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
    const postItemBase2 = +(subTotal - itemDiscountTotal2).toFixed(2);
    if (!isFinite(billDiscountAmt) || billDiscountAmt < 0) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount amount must be non-negative (got ${billDiscountAmt}).` });
    }
    if (billDiscountAmt > postItemBase2 + 0.01) {
      if (!t.finished) await t.rollback();
      return res.status(400).json({ error: `Bill discount (₹${billDiscountAmt.toFixed(2)}) cannot exceed post-item-discount total (₹${postItemBase2.toFixed(2)}).` });
    }
    const taxableTotal = +(subTotal - itemDiscountTotal2 - billDiscountAmt).toFixed(2);

    // PASS 2: allocate bill-level discount pro-rata so GST is on the post-
    // discount (GST-law-compliant) base for every line.
    const postItemTotal2 = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
    const billDiscRatio2 = postItemTotal2 > 0 ? billDiscountAmt / postItemTotal2 : 0;

    // Same inter-state resolution as create() — see comment there.
    const interState2 = billWise ? false : await _resolveInterState(billData, t);

    for (const it of processedItems) {
      const lineBase = +(it._postItemTaxable * (1 - billDiscRatio2)).toFixed(2);
      it.taxable_amount = lineBase;
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(lineBase, it.gst_rate || 0, interState2);
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
      // Round-half-away-from-zero to stay consistent with Tally's GST rules.
      totalCgst = roundTo(taxableTotal * parseFloat(cgst_pct) / 100, 2);
      totalSgst = roundTo(taxableTotal * parseFloat(sgst_pct) / 100, 2);
      totalIgst = roundTo(taxableTotal * parseFloat(igst_pct) / 100, 2);
    }

    const { roundedAmount, roundOffValue } = roundOff(
      taxableTotal + totalCgst + totalSgst + totalIgst + totalCess
      - parseFloat(special_discount || 0)
      + parseFloat(other_charges || 0)
      + parseFloat(freight_charges || 0)
    );
    const totalAmount = roundedAmount;

    // Enforce full payment if customer has credit not allowed
    let finalPaidAmount2 = parseFloat(paid_amount);
    let customer2 = null;
    if (billData.customer_id) {
      customer2 = await Party.findByPk(billData.customer_id, { transaction: t });
      if (customer2 && !customer2.credit_allowed) {
        finalPaidAmount2 = totalAmount;
      }
    }

    // Preserve payments already applied via the Receipt module.
    // balance_amount was set as: total - paid_at_billing - return_amount - linkedReceipts
    // So: linkedReceipts = total - balance - paid_at_billing - return_amount
    const oldPaidAtBilling2  = parseFloat(existingBill.paid_amount)    || 0;
    const oldBalance2        = parseFloat(existingBill.balance_amount)  || 0;
    const oldTotal2          = parseFloat(existingBill.total_amount)    || 0;
    const oldReturnAmount2   = parseFloat(existingBill.return_amount)   || 0;
    const linkedReceipts     = Math.max(0, +(oldTotal2 - oldBalance2 - oldPaidAtBilling2 - oldReturnAmount2).toFixed(2));

    const returnAmt          = parseFloat(return_amount || 0);
    const totalEffectivePaid2 = +(finalPaidAmount2 + returnAmt + linkedReceipts).toFixed(2);
    const balanceAmount      = Math.max(0, +(totalAmount - totalEffectivePaid2).toFixed(2));

    let paymentStatus = 'Unpaid';
    if (totalEffectivePaid2 >= totalAmount) paymentStatus = 'Paid';
    else if (totalEffectivePaid2 > 0)       paymentStatus = 'Partial';

    // Blacklist + credit-limit block on edit. The customer's current_balance
    // already reflects the OLD bill's balance, so we pass it through as
    // oldBillOutstanding — otherwise an edit that just keeps the same total
    // would falsely trip the limit. Skipping the limit check when the bill's
    // customer changes isn't safe either, so for cross-customer edits the
    // guard conservatively enforces against the new customer as if this
    // were a fresh bill.
    const isSameCustomer = existingBill.customer_id === billData.customer_id;
    const guard2 = checkPartyForBillSave({
      party: customer2,
      newBillOutstanding: balanceAmount,
      oldBillOutstanding: isSameCustomer ? oldBalance2 : 0,
      enforceCreditLimit: true,
    });
    if (guard2) {
      await t.rollback();
      return res.status(guard2.status).json({ error: guard2.error });
    }

    await existingBill.update({
      ...billData,
      total_items: newItems.length,
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
      total_amount: totalAmount,
      paid_amount: finalPaidAmount2,
      return_amount: parseFloat(return_amount) || 0,
      balance_amount: balanceAmount,
      payment_status: paymentStatus,
      special_discount: parseFloat(special_discount) || 0,
      other_charges: parseFloat(other_charges) || 0,
      freight_charges: parseFloat(freight_charges) || 0,
    }, { transaction: t });

    // Check negative stock setting for update
    const sysSettingsU = await SystemSettings.findByPk(1, { transaction: t });
    const allowNegStockU = sysSettingsU?.allow_negative_stock || false;
    const blockExpiredU  = !!sysSettingsU?.block_expired_sales;
    const batchTrackingOnU = !!sysSettingsU?.batch_tracking_enabled;

    // Pre-flight color validation for the update path. Same rules as
    // create — required color_id for multi-color products, color must
    // belong to product, stock check (which now reads the post-reverse
    // current_stock since we just credited it back).
    try {
      await validateBillColorRequirements({
        items: processedItems,
        direction: 'sale',
        allowNegativeStock: allowNegStockU,
        transaction: t,
      });
    } catch (err) {
      await t.rollback();
      return res.status(err.status || 400).json({ error: err.message });
    }

    for (const item of processedItems) {
      // Same pattern as create(): fetch the product once, snapshot its
      // per-mode cost via the shared helper, reuse for stock update.
      // Cost is re-snapshotted on edit so if the user corrects the line
      // (e.g. fixes a wrong product on a bill) the COGS follows the new
      // product's cost — matches the user's mental model of "this edit
      // supersedes the original". For single-mode products the
      // snapshot uses CURRENT wac, which means an edit after later
      // purchases shifts cost_rate to reflect the new average. That's
      // by-design — edits are point-in-time corrections.
      let product = null;
      if (item.product_id) {
        product = await Product.findByPk(item.product_id, { transaction: t });
      }
      const batchIdU = (batchTrackingOnU && product && product.is_batch_tracked)
        ? (item.batch_id || null) : null;
      if (batchTrackingOnU && product && product.is_batch_tracked && !batchIdU) {
        await t.rollback();
        return res.status(400).json({
          error: `"${item.product_name || product.product_name}" is batch-tracked. Pick a batch for this line.`,
        });
      }
      if (batchIdU) {
        const err = await validateBatchLine({
          product, item: { ...item, batch_id: batchIdU },
          godownId: billData.godown_id, t,
          blockExpired: blockExpiredU, isReturn: false,
        });
        if (err) { await t.rollback(); return res.status(400).json({ error: err }); }
      }
      const costRate = await computeCostRateForSale({
        product, batch_id: batchIdU || null, t,
      });

      await SalesBillItem.create({
        sales_bill_id: id,
        ...item,
        batch_id: batchIdU,
        cost_rate: costRate,
      }, { transaction: t });

      if (product) {
        const currentStock = await getGodownStock({
          product_id: item.product_id, godown_id: billData.godown_id, t,
        });
        const newStock = +(currentStock - parseFloat(item.quantity)).toFixed(2);

        if (!allowNegStockU && newStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for "${item.product_name || product.product_name}" at this godown. Available: ${currentStock}, Requested: ${item.quantity}. Enable "Allow Negative Stock" in Module Settings to proceed.`,
          });
        }

        await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: -parseFloat(item.quantity), t,
        });
        if (batchIdU) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: batchIdU,
            godown_id: billData.godown_id,
            delta: -parseFloat(item.quantity), t,
          });
        }
        // Re-apply per-color decrement at the new color_id (the OLD
        // colors were already restored above; this is the new pick).
        if (item.color_id) {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: -parseFloat(item.quantity),
            transaction: t,
          });
        }
        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: batchIdU,
          barcode: item.barcode,
          transaction_type: 'Sales',
          transaction_date: billData.bill_date,
          reference_id: existingBill.sales_bill_id,
          reference_number: existingBill.bill_number,
          quantity_in: 0, quantity_out: item.quantity,
          rate: item.rate, balance_quantity: newStock,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    const oldCustomerId = existingBill.customer_id;
    const newCustomerId = billData.customer_id;
    if (oldCustomerId) await recalculatePartyBalance(oldCustomerId, t);
    if (newCustomerId && newCustomerId !== oldCustomerId) await recalculatePartyBalance(newCustomerId, t);

    // ── Double-entry: reverse old, post new ──
    // Both source types (sales_bill + the optional sales_bill_receipt for
    // paid_amount) need reversing so a re-post is idempotent.
    await reverseVoucher({
      sourceType: 'sales_bill', sourceId: existingBill.sales_bill_id,
      reason: 'Sales bill edited', userId: req.user && req.user.user_id, transaction: t,
    });
    await reverseVoucher({
      sourceType: 'sales_bill_receipt', sourceId: existingBill.sales_bill_id,
      reason: 'Sales bill edited', userId: req.user && req.user.user_id, transaction: t,
    });
    {
      const refreshed = await SalesBill.findByPk(existingBill.sales_bill_id, {
        include: [{ model: Party, as: 'customer' }],
        transaction: t,
      });
      const vouchers = await buildSalesBillVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
      // Two-way ledger sync — handles edit cases A-D from the brief:
      // amount up/down, paid_amount up/down, paid_amount → 0, account
      // changed. The service inspects the refreshed bill and inserts /
      // updates / deletes the auto-receipt row + allocation to match.
      await syncAutoReceiptForBill({ kind: 'sales', bill: refreshed, t });
    }

    await t.commit();

    const result = await SalesBill.findByPk(existingBill.sales_bill_id, {
      include: [
        { model: Party, as: 'customer' },
        { model: SalesBillItem, as: 'items' },
      ],
    });

    res.json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Update sale error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.cancel = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const bill = await SalesBill.findByPk(req.params.id, {
      include: [{ model: SalesBillItem, as: 'items' }],
      transaction: t,
    });
    if (!bill) { await t.rollback(); return res.status(404).json({ error: 'Bill not found' }); }
    if (bill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Bill already cancelled' }); }

    // ── Block if any active Receipt from the Payment tab covers this bill ────
    // Check both new bill_allocations JSONB and legacy reference_bill_id field.
    const billId = bill.sales_bill_id;
    const [linkedReceiptRows] = await sequelize.query(
      `SELECT transaction_number FROM payments_receipts
       WHERE is_cancelled = false
         AND transaction_type = 'Receipt'
         AND (
           (bill_allocations IS NOT NULL
            AND bill_allocations @> :jsonCheck::jsonb)
           OR (reference_bill_id = :billId AND reference_bill_type = 'Sales')
         )`,
      {
        replacements: {
          jsonCheck: JSON.stringify([{ bill_id: billId, bill_type: 'Sales' }]),
          billId,
        },
        transaction: t,
      }
    );
    if (linkedReceiptRows.length > 0) {
      await t.rollback();
      const nums = linkedReceiptRows.map(r => r.transaction_number).join(', ');
      return res.status(400).json({
        error: `Cannot cancel this bill — the following receipt(s) have been recorded against it: ${nums}. Please cancel those receipts first, then cancel the bill.`,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Reverse the deduction at the bill's own godown (the one the sale
    // shipped from). Cancellation never re-routes stock.
    for (const item of bill.items) {
      if (item.product_id && bill.godown_id) {
        await applyGodownStockDelta({
          product_id: item.product_id, godown_id: bill.godown_id,
          delta: +parseFloat(item.quantity), t,
        });
        // Restore the per-batch on-hand for batched lines. Both the
        // godown-level and batch-level deltas must move together so a
        // rollback restores both consistently.
        if (item.batch_id) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: item.batch_id,
            godown_id: bill.godown_id,
            delta: +parseFloat(item.quantity), t,
          });
        }
      }
    }
    // Restore the per-color stock for multi-color lines. Walks the
    // saved items[] and re-credits each color_id by its sale qty.
    await reverseBillColorStock({
      items: bill.items,
      direction: 'sale',
      transaction: t,
    });

    // Remove stock ledger entries for this bill (bill is cancelled, so entries should be gone too)
    await StockLedger.destroy({
      where: { reference_id: bill.sales_bill_id, transaction_type: 'Sales' },
      transaction: t,
    });

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

    // Redistribute any active receipts across remaining bills (FIFO), then fix party balance
    if (bill.customer_id) {
      await reconcileBillsForParty(bill.customer_id, t);
      await recalculatePartyBalance(bill.customer_id, t);
    }

    // ── Double-entry: reverse the bill's vouchers ──
    await reverseVoucher({
      sourceType: 'sales_bill', sourceId: bill.sales_bill_id,
      reason: cancellationReason || 'Sales bill cancelled',
      userId: req.user && req.user.user_id, transaction: t,
    });
    await reverseVoucher({
      sourceType: 'sales_bill_receipt', sourceId: bill.sales_bill_id,
      reason: cancellationReason || 'Sales bill cancelled',
      userId: req.user && req.user.user_id, transaction: t,
    });
    // Two-way ledger cancel cascade — soft-cancel the auto-receipt
    // row + drop its allocation. Preserves the Receipts list audit
    // trail (the row still appears with a "Cancelled" badge) but
    // zeros out the bill-level allocation so I1-I6 still hold.
    await reverseAutoReceiptForBill({
      kind: 'sales',
      billId: bill.sales_bill_id,
      reason: cancellationReason || 'Sales bill cancelled',
      userId: req.user && req.user.user_id,
      t,
    });

    await t.commit();
    res.json({ message: 'Bill cancelled successfully' });
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Cancel sale error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
