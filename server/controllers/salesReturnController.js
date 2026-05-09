const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  SalesReturnBill, SalesReturnBillItem,
  SalesBill, SalesBillItem,
  Party, Product, StockLedger, SystemSettings, Godown, ProductBatch,
} = require('../models');
const { generateBillNumber, roundOff, calculateGST, roundTo, sanitizePagination } = require('../utils/helpers');
const { recalculatePartyBalance } = require('../utils/balanceHelper');
const { resolveInterState } = require('../utils/interStateResolver');
const { applyColorStockDelta } = require('../services/productColorStockService');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildSalesReturnVouchers } = require('../services/voucherBuilders');
const { applyGodownStockDelta, getGodownStock, resolveGodownForWrite, getDefaultGodownId } = require('../utils/godownStock');
const { applyBatchStockDelta } = require('../utils/batchStock');
const { denyIfGodownInaccessible } = require('../middleware/godownScope');

/**
 * Fields the client is NEVER allowed to set directly on a return bill.
 *
 *   return_number   — generated server-side under a row lock for race safety.
 *   created_by      — audit field, derived from req.user.
 *   is_cancelled,
 *   cancelled_*     — only mutable through the explicit /cancel endpoint so
 *                     stock / ledger / party balance all get reversed atomically.
 *                     Letting a create/update silently flip is_cancelled:true
 *                     would leave the books orphaned from the physical effects.
 *   created_date,
 *   modified_date   — timestamps, owned by Sequelize.
 *
 * Kept here (not inlined) so create() and update() stay identical and so a
 * future reviewer can see the whole deny-list at a glance.
 */
const UNSAFE_BILL_FIELDS = [
  'return_number', 'created_by',
  'is_cancelled', 'cancelled_by', 'cancelled_date', 'cancellation_reason',
  'created_date', 'modified_date',
];
function stripUnsafe(billData) {
  const clean = { ...billData };
  for (const f of UNSAFE_BILL_FIELDS) delete clean[f];
  return clean;
}

/**
 * Validate the referenced sales bill when reference_bill_id is supplied:
 *   1. The bill must exist.
 *   2. It must not be cancelled (cancelled bills have no real total/items
 *      to credit against, and letting this through would corrupt the P&L).
 *   3. The return's customer MUST match the referenced bill's customer —
 *      returning Customer A's goods and crediting it to Customer B is how
 *      refund fraud happens, and this guard prevents it even on a crafted
 *      API call bypassing the UI picker.
 *
 * Throws a string error message; caller catches and rolls back + 400s.
 */
async function validateReferenceBill({ reference_bill_id, customer_id }, t) {
  if (!reference_bill_id) return null;
  const ref = await SalesBill.findByPk(reference_bill_id, { transaction: t });
  if (!ref) throw new Error(`Referenced sales bill #${reference_bill_id} does not exist.`);
  if (ref.is_cancelled) throw new Error(`Referenced sales bill ${ref.bill_number} is cancelled — you cannot return against a cancelled invoice.`);
  if (customer_id && Number(customer_id) !== Number(ref.customer_id)) {
    throw new Error(`Customer on return does not match the customer on referenced bill ${ref.bill_number}. Returns must credit the same customer who was invoiced.`);
  }
  return ref;
}

/**
 * Over-return guard.
 *
 * Prevents crediting a customer for MORE units (or more rupees, in Amount
 * mode) than they ever bought on the referenced bill — the classic "issue
 * ₹1000 credit on a ₹500 invoice" fraud/mistake.
 *
 *   Items mode:   for each return line with original_item_id, the sum of
 *                 qty across all non-cancelled returns linked to that
 *                 original_item_id (including this one) must not exceed
 *                 the original sales_bill_item.quantity.
 *   Amount mode:  the sum of total_amount across all non-cancelled returns
 *                 with the same reference_bill_id must not exceed the
 *                 referenced bill's total_amount.
 *
 * When updating a return, we exclude the return-being-edited from the
 * "other returns" sum via `excludeId` — otherwise every edit would be
 * counted against itself and legitimate edits would fail.
 *
 * Lines without original_item_id (e.g. user scanned a barcode) are NOT
 * capped — we don't know which original line they correspond to, and the
 * customer may legitimately be returning something purchased on a different
 * bill. Same for returns with no reference_bill_id at all.
 */
async function enforceOverReturnCap({
  reference_bill_id, return_mode, items, computedTotal, excludeId,
}, t) {
  if (!reference_bill_id) return;

  const ref = await SalesBill.findByPk(reference_bill_id, {
    include: [{ model: SalesBillItem, as: 'items' }],
    transaction: t,
  });
  if (!ref) return; // validateReferenceBill already guarded this — belt and suspenders.

  if (return_mode === 'Amount') {
    // Cumulative cap across all non-cancelled returns on this bill.
    const where = { reference_bill_id, is_cancelled: false };
    if (excludeId) where.sales_return_id = { [Op.ne]: excludeId };
    const priorRaw = await SalesReturnBill.sum('total_amount', { where, transaction: t });
    const prior = parseFloat(priorRaw) || 0;
    const refTotal = parseFloat(ref.total_amount) || 0;
    if (prior + computedTotal > refTotal + 0.01) {
      throw new Error(`Amount-only return would take total credits to ₹${(prior + computedTotal).toFixed(2)}, but original bill ${ref.bill_number} is only ₹${refTotal.toFixed(2)}.`);
    }
    return;
  }

  // Items mode — build qty-by-original-item across other returns.
  const linked = items.filter((it) => it.original_item_id);
  if (linked.length === 0) return;
  const where = { reference_bill_id, is_cancelled: false };
  if (excludeId) where.sales_return_id = { [Op.ne]: excludeId };
  const otherReturns = await SalesReturnBill.findAll({
    where,
    include: [{ model: SalesReturnBillItem, as: 'items' }],
    transaction: t,
  });
  const priorByOrig = new Map();
  for (const r of otherReturns) {
    for (const it of r.items || []) {
      if (!it.original_item_id) continue;
      priorByOrig.set(it.original_item_id,
        (priorByOrig.get(it.original_item_id) || 0) + parseFloat(it.quantity || 0));
    }
  }
  for (const it of linked) {
    const original = (ref.items || []).find((x) => x.item_id === it.original_item_id);
    if (!original) continue;                          // link dropped (item deleted?) — skip cap
    const origQty = parseFloat(original.quantity) || 0;
    const already = priorByOrig.get(it.original_item_id) || 0;
    const thisQty = parseFloat(it.quantity) || 0;
    if (already + thisQty > origQty + 0.001) {
      throw new Error(`"${original.product_name || 'Item'}" — returning ${thisQty} would take total returned to ${(already + thisQty).toFixed(2)} out of ${origQty} sold on bill ${ref.bill_number}.`);
    }
  }
}

/* ============================================================================
 *  Sales Return Controller
 *
 *  A Sales Return is a CREDIT NOTE — a reverse sales invoice. It:
 *    · decreases customer receivable (they owe us less, or we owe them)
 *    · pushes stock BACK INTO inventory (StockLedger.transaction_type = 'Sales Return')
 *    · optionally links to a reference sales bill (for audit trail / reports)
 *
 *  Two modes are supported via return_mode:
 *    · 'Items'  — line-by-line return with full GST + discount recomputation.
 *                 Stock is restored for every product_id.
 *    · 'Amount' — credit note without any stock movement (e.g. goodwill refund,
 *                 price adjustment). One synthetic non-product line carries the
 *                 total so reports can iterate items uniformly.
 *
 *  The math mirrors salesController.create()/update() exactly — same
 *  `roundTo`/`calculateGST` helpers, same bill-wise vs product-wise GST
 *  branch, same pro-rata bill-discount allocation, same round-off rule. That
 *  symmetry is intentional: a customer looking at invoice + credit-note
 *  side-by-side should see the two totals reconcile paisa-for-paisa.
 * ========================================================================= */

exports.getAll = async (req, res) => {
  try {
    const { from_date, to_date, customer_id, refund_status, search } = req.query;
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_cancelled: false };

    if (from_date && to_date) where.return_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (refund_status) where.refund_status = refund_status;
    if (search) {
      where[Op.or] = [
        { return_number: { [Op.iLike]: `%${search}%` } },
        { reference_bill_number: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await SalesReturnBill.findAndCountAll({
      where,
      include: [
        { model: Party,  as: 'customer', attributes: ['party_name', 'mobile_1'] },
        { model: Godown, as: 'godown',   attributes: ['godown_id', 'code', 'name'] },
      ],
      order: [['return_date', 'DESC'], ['sales_return_id', 'DESC']],
      limit,
      offset,
    });

    // Summary aggregates over the FULL filtered set — KPI cards and the
    // sticky bottom Total strip read these so they stay correct
    // regardless of which chunks the user has scrolled past.
    const totals = await SalesReturnBill.findAll({
      where,
      attributes: [
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total_amount')),    0), 'total_amount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('refund_amount')),   0), 'total_refund'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('balance_amount')),  0), 'total_pending'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('discount_amount')), 0), 'total_discount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('cgst_amount')),     0), 'total_cgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('sgst_amount')),     0), 'total_sgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('igst_amount')),     0), 'total_igst'],
        [sequelize.fn('COUNT', sequelize.col('sales_return_id')), 'count'],
        [sequelize.fn('COUNT', sequelize.literal('CASE WHEN balance_amount > 0.01 THEN 1 END')), 'open_count'],
      ],
      raw: true,
    });
    const t = totals[0] || {};
    const total_gst = +(parseFloat(t.total_cgst || 0) + parseFloat(t.total_sgst || 0) + parseFloat(t.total_igst || 0)).toFixed(2);
    const summary = {
      total_amount:   +parseFloat(t.total_amount   || 0).toFixed(2),
      total_refund:   +parseFloat(t.total_refund   || 0).toFixed(2),
      total_pending:  +parseFloat(t.total_pending  || 0).toFixed(2),
      total_discount: +parseFloat(t.total_discount || 0).toFixed(2),
      total_gst,
      count:          parseInt(t.count || 0, 10),
      open_count:     parseInt(t.open_count || 0, 10),
    };

    res.json({ total: count, page, limit, data: rows, summary });
  } catch (error) {
    console.error('Get sales returns error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const bill = await SalesReturnBill.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'customer' },
        // Include the batch row on each line so the print template can
        // emit the "Lot · Mfd · Exp" sub-line under the product name
        // (Commit 5). Same shape salesController.getById uses.
        {
          model: SalesReturnBillItem, as: 'items',
          include: [{ model: ProductBatch, as: 'batch', attributes: ['batch_id', 'batch_number', 'manufacture_date', 'expiry_date'] }],
        },
        { model: SalesBill, as: 'referenceBill', attributes: ['sales_bill_id', 'bill_number', 'bill_date', 'total_amount'] },
      ],
    });
    if (!bill) return res.status(404).json({ error: 'Return not found' });
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

// Fetch the ORIGINAL sales bill so the form can pre-fill items when the user
// selects it as the reference for this return.
exports.getReferenceBill = async (req, res) => {
  try {
    const bill = await SalesBill.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'customer', attributes: ['party_id', 'party_name', 'mobile_1'] },
        { model: SalesBillItem, as: 'items' },
      ],
    });
    if (!bill) return res.status(404).json({ error: 'Sales bill not found' });
    if (bill.is_cancelled) return res.status(400).json({ error: 'Cannot return a cancelled bill' });
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

// Shared math for create + update — keep in one place so the two paths can
// never drift. Returns computed totals and a list of items ready to persist.
//
// `interState` decides which GST head the per-line tax goes into (CGST+SGST
// for intra-state, IGST for inter-state). Caller resolves this from the
// customer's place-of-supply via resolveInterState() — passing it explicitly
// keeps computeTotals free of DB calls. (Audit H1: returns must classify
// identically to the original sale or GSTR-1's Credit Note section reports
// the wrong head.)
async function computeTotals(req, items, billData, returnMode, t, interState = false) {
  const { cgst_pct = 0, sgst_pct = 0, igst_pct = 0, gst_mode } = req.body;
  const billWise = gst_mode === 'bill'
    ? true
    : gst_mode === 'product'
      ? false
      : (parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0);

  let subTotal = 0;
  let totalQty = 0;
  let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;

  const processedItems = [];

  // PASS 1 — line totals + item discounts. GST is deferred until after the
  // bill discount is allocated pro-rata, so each line's taxable base matches
  // GST law's "transaction value" (post-trade-discount).
  for (const item of items) {
    const qty  = parseFloat(item.quantity);
    const rate = parseFloat(item.rate);
    const itemDiscPct = parseFloat(item.discount_percentage || 0);
    if (!isFinite(qty) || qty < 0) {
      throw new Error(`Quantity must be a non-negative number (got "${item.quantity}" for "${item.product_name || 'item'}").`);
    }
    if (!isFinite(rate) || rate < 0) {
      throw new Error(`Rate must be a non-negative number (got "${item.rate}" for "${item.product_name || 'item'}").`);
    }
    if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
      throw new Error(`Item discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").`);
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

  const billDiscPct = parseFloat(billData.discount_percentage || 0);
  if (!isFinite(billDiscPct) || billDiscPct < 0 || billDiscPct > 100) {
    throw new Error(`Bill discount % must be between 0 and 100 (got ${billDiscPct}%).`);
  }
  const billDiscountAmt = billData.discount_amount != null
    ? parseFloat(billData.discount_amount)
    : +(subTotal * billDiscPct / 100).toFixed(2);
  const itemDiscountTotal = processedItems.reduce((s, it) => s + (parseFloat(it.discount_amount) || 0), 0);
  const postItemBase = +(subTotal - itemDiscountTotal).toFixed(2);
  if (!isFinite(billDiscountAmt) || billDiscountAmt < 0) {
    throw new Error(`Bill discount amount must be non-negative (got ${billDiscountAmt}).`);
  }
  if (billDiscountAmt > postItemBase + 0.01) {
    throw new Error(`Bill discount (₹${billDiscountAmt.toFixed(2)}) cannot exceed post-item-discount total (₹${postItemBase.toFixed(2)}).`);
  }
  const taxableTotal = +(subTotal - itemDiscountTotal - billDiscountAmt).toFixed(2);

  // PASS 2 — allocate bill-level discount pro-rata and recompute per-line GST.
  const postItemTotal = processedItems.reduce((s, it) => s + it._postItemTaxable, 0);
  const billDiscRatio = postItemTotal > 0 ? billDiscountAmt / postItemTotal : 0;

  for (const it of processedItems) {
    const lineBase = +(it._postItemTaxable * (1 - billDiscRatio)).toFixed(2);
    it.taxable_amount = lineBase;
    const gst = billWise
      ? { cgst: 0, sgst: 0, igst: 0, cess: 0 }
      : calculateGST(lineBase, it.gst_rate || 0, !!interState);
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
    // Bill-wise mode: operator picked specific cgst/sgst/igst pcts; honour
    // them as-is. The interState flag governs only the per-line product mode.
    totalCgst = roundTo(taxableTotal * parseFloat(cgst_pct) / 100, 2);
    totalSgst = roundTo(taxableTotal * parseFloat(sgst_pct) / 100, 2);
    totalIgst = roundTo(taxableTotal * parseFloat(igst_pct) / 100, 2);
  }

  const other   = parseFloat(billData.other_charges || 0);
  const freight = parseFloat(billData.freight_charges || 0);
  const { roundedAmount, roundOffValue } = roundOff(
    taxableTotal + totalCgst + totalSgst + totalIgst + totalCess + other + freight
  );

  return {
    processedItems,
    subTotal,
    totalQty,
    taxableTotal,
    billDiscountAmt,
    totalCgst,
    totalSgst,
    totalIgst,
    totalCess,
    roundOffValue,
    totalAmount: roundedAmount,
  };
}

// Build the single synthetic line for 'Amount'-mode credit notes so the items
// table still has at least one row. product_id is null → stock untouched.
function synthAmountLine(amount, remarks) {
  const a = +(parseFloat(amount) || 0).toFixed(2);
  return [{
    product_id: null,
    barcode: null,
    product_name: 'Credit Note',
    size: null,
    article_number: null,
    hsn_code: null,
    category_id: null,
    category_name: null,
    unit_type: 'Lot',
    quantity: 1,
    rate: a,
    mrp: 0,
    discount_percentage: 0,
    gst_rate: 0,
    quantity_per_box: 1,
    return_condition: remarks || null,
  }];
}

exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const {
      items,
      return_mode = 'Items',
      refund_amount = 0,
      other_charges = 0, freight_charges = 0,
      cgst_pct = 0, sgst_pct = 0, igst_pct = 0,
      amount_only_total = 0,
      ...rawBillData
    } = req.body;

    // Strip server-owned fields so a crafted payload can't inject is_cancelled,
    // override the generated return_number, or spoof created_by.
    const billData = stripUnsafe(rawBillData);

    if (!billData.customer_id) {
      await t.rollback();
      return res.status(400).json({ error: 'Customer is required on a sales return' });
    }

    // Explicit shape checks that computeTotals can't do (it only sees items).
    const refundIn = parseFloat(refund_amount);
    if (!isFinite(refundIn) || refundIn < 0) {
      await t.rollback();
      return res.status(400).json({ error: `Refund amount must be a non-negative number (got ${refund_amount}).` });
    }
    if (return_mode === 'Amount') {
      const amt = parseFloat(amount_only_total);
      if (!isFinite(amt) || amt <= 0) {
        await t.rollback();
        return res.status(400).json({ error: `Amount-only return total must be a positive number (got ${amount_only_total}).` });
      }
    }
    if (!['Items', 'Amount'].includes(return_mode)) {
      await t.rollback();
      return res.status(400).json({ error: `Invalid return_mode "${return_mode}" — must be 'Items' or 'Amount'.` });
    }

    // Reference bill existence + party match.
    try {
      await validateReferenceBill({
        reference_bill_id: billData.reference_bill_id,
        customer_id: billData.customer_id,
      }, t);
    } catch (refErr) {
      await t.rollback();
      return res.status(400).json({ error: refErr.message });
    }

    // Audit M2: take a Postgres advisory lock on the sales-return key
    // (904, same numeric ID the inline-return helper uses) BEFORE
    // looking up the latest row. Without this, two concurrent
    // standalone POSTs both row-lock different rows (or no row, on a
    // fresh table) and emit duplicate return_numbers — the inline-
    // return path was hardened earlier; this path was not.
    await sequelize.query('SELECT pg_advisory_xact_lock(904)', { transaction: t });

    // Lock the latest return row for race-free number generation (same pattern
    // as salesController.create — concurrent POSTs can otherwise both read
    // the same lastBill and issue duplicate numbers).
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const prefix = settings?.sales_return_prefix?.trim() || 'SR';
    const lastBill = await SalesReturnBill.findOne({
      order: [['sales_return_id', 'DESC']],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    // Return numbers may be 'SR-0001' or plain '0001'; take the trailing numeric segment.
    const lastNum = lastBill ? parseInt((lastBill.return_number.split('-').pop() || '0')) : 0;
    billData.return_number = generateBillNumber(prefix, lastNum);
    billData.created_by = req.user.user_id;

    // Resolve godown — explicit body wins, else default. If the return
    // references a sales bill, prefer THAT bill's godown over the user
    // default (returning to the same warehouse the goods came from is
    // the intuitive behaviour).
    if (billData.godown_id == null && billData.reference_bill_id) {
      const ref = await SalesBill.findByPk(billData.reference_bill_id, { transaction: t });
      if (ref && ref.godown_id) billData.godown_id = ref.godown_id;
    }
    const godownResolved = await resolveGodownForWrite({
      req_godown_id: billData.godown_id, user: req.user, t,
    });
    if (godownResolved.error) {
      await t.rollback();
      return res.status(403).json({ error: godownResolved.error });
    }
    billData.godown_id = godownResolved.godown_id;

    // Pick the item set we'll compute totals on — either the real ones, or
    // a single synthetic line representing the amount-only credit note.
    const effectiveItems = return_mode === 'Amount'
      ? synthAmountLine(amount_only_total, billData.remarks)
      : items;

    if (!Array.isArray(effectiveItems) || effectiveItems.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // Resolve inter-state from the customer's place-of-supply BEFORE
    // computing totals — calculateGST routes to CGST+SGST vs IGST based
    // on this flag. Audit H1: returns must classify identically to the
    // original sale or GSTR-1's Credit Note section reports the wrong
    // place-of-supply head.
    const interState = await resolveInterState({
      partyId: billData.customer_id, transaction: t,
    });

    let totals;
    try {
      totals = await computeTotals(req, effectiveItems, billData, return_mode, t, interState);
    } catch (mathErr) {
      await t.rollback();
      return res.status(400).json({ error: mathErr.message });
    }

    // Over-return cap: reject if cumulative returned qty (per item) or total
    // (in Amount mode) would exceed what the referenced bill can absorb.
    try {
      await enforceOverReturnCap({
        reference_bill_id: billData.reference_bill_id,
        return_mode,
        items: totals.processedItems,
        computedTotal: totals.totalAmount,
        excludeId: null,
      }, t);
    } catch (capErr) {
      await t.rollback();
      return res.status(400).json({ error: capErr.message });
    }

    // refund_amount cannot exceed the return's total (otherwise we'd give the
    // customer more money than the goods they returned are worth).
    const refund = parseFloat(refund_amount) || 0;
    if (refund > totals.totalAmount + 0.01) {
      await t.rollback();
      return res.status(400).json({
        error: `Refund amount (₹${refund.toFixed(2)}) cannot exceed return total (₹${totals.totalAmount.toFixed(2)})`,
      });
    }
    const balance = +(totals.totalAmount - refund).toFixed(2);
    const refundStatus = refund >= totals.totalAmount - 0.01
      ? 'Refunded'
      : refund > 0
        ? 'Partial'
        : 'Pending';

    const bill = await SalesReturnBill.create({
      ...billData,
      return_mode,
      total_items: effectiveItems.length,
      total_quantity: totals.totalQty,
      sub_total: totals.subTotal,
      discount_amount: totals.billDiscountAmt,
      cgst_pct: parseFloat(cgst_pct) || 0,
      sgst_pct: parseFloat(sgst_pct) || 0,
      igst_pct: parseFloat(igst_pct) || 0,
      cgst_amount: totals.totalCgst,
      sgst_amount: totals.totalSgst,
      igst_amount: totals.totalIgst,
      cess_amount: totals.totalCess,
      round_off: totals.roundOffValue,
      other_charges: parseFloat(other_charges) || 0,
      freight_charges: parseFloat(freight_charges) || 0,
      total_amount: totals.totalAmount,
      refund_amount: refund,
      balance_amount: balance,
      refund_status: refundStatus,
    }, { transaction: t });

    // Persist each line item + restore stock for products (Amount-mode lines
    // have product_id = null and skip the stock path entirely).
    for (const item of totals.processedItems) {
      await SalesReturnBillItem.create({
        sales_return_id: bill.sales_return_id,
        ...item,
        batch_id: item.batch_id || null,
      }, { transaction: t });

      if (item.product_id && return_mode === 'Items') {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        if (!product) continue;
        const newStock = await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: +parseFloat(item.quantity), t,
        });
        // For batched lines, restore stock at the originating batch so
        // returns flow back into the same lot (matching how purchases
        // increment the batch on the receiving side). Without this, the
        // batch-level on-hand drifts under products.current_stock.
        if (item.batch_id && product.is_batch_tracked) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: item.batch_id,
            godown_id: billData.godown_id,
            delta: +parseFloat(item.quantity), t,
          });
        }

        // Audit C5: a sales return RECEIVES goods from the customer, so
        // the per-color stock must increment for the picked color. Without
        // this, parent stock (products.current_stock) restores correctly
        // but per-color stock stays at the post-sale value, breaking the
        // sum-of-colors = parent invariant and blocking future sales of
        // the returned color.
        if (item.color_id && product.color_mode === 'multi') {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: +parseFloat(item.quantity),
            transaction: t,
          });
        }

        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: item.batch_id || null,
          barcode: item.barcode,
          transaction_type: 'Sales Return',
          transaction_date: billData.return_date,
          reference_id: bill.sales_return_id,
          reference_number: bill.return_number,
          quantity_in: item.quantity,
          quantity_out: 0,
          rate: item.rate,
          balance_quantity: newStock,
          remarks: billData.reason || null,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    await recalculatePartyBalance(billData.customer_id, t);

    // ── Double-entry posting ──
    {
      const refreshed = await SalesReturnBill.findByPk(bill.sales_return_id, {
        include: [{ model: Party, as: 'customer' }],
        transaction: t,
      });
      const vouchers = await buildSalesReturnVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
    }

    await t.commit();

    const result = await SalesReturnBill.findByPk(bill.sales_return_id, {
      include: [
        { model: Party, as: 'customer' },
        { model: SalesReturnBillItem, as: 'items' },
      ],
    });
    res.status(201).json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Create sales return error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const {
      items: newItems,
      return_mode = 'Items',
      refund_amount = 0,
      other_charges = 0, freight_charges = 0,
      cgst_pct = 0, sgst_pct = 0, igst_pct = 0,
      amount_only_total = 0,
      ...rawBillData
    } = req.body;

    const billData = stripUnsafe(rawBillData);

    // Shape checks — same rules as create().
    const refundIn = parseFloat(refund_amount);
    if (!isFinite(refundIn) || refundIn < 0) {
      await t.rollback();
      return res.status(400).json({ error: `Refund amount must be a non-negative number (got ${refund_amount}).` });
    }
    if (return_mode === 'Amount') {
      const amt = parseFloat(amount_only_total);
      if (!isFinite(amt) || amt <= 0) {
        await t.rollback();
        return res.status(400).json({ error: `Amount-only return total must be a positive number (got ${amount_only_total}).` });
      }
    }
    if (!['Items', 'Amount'].includes(return_mode)) {
      await t.rollback();
      return res.status(400).json({ error: `Invalid return_mode "${return_mode}" — must be 'Items' or 'Amount'.` });
    }

    const existing = await SalesReturnBill.findByPk(id, {
      include: [{ model: SalesReturnBillItem, as: 'items' }],
      transaction: t,
    });
    if (!existing) { await t.rollback(); return res.status(404).json({ error: 'Return not found' }); }
    if (existing.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Cannot edit a cancelled return' }); }

    // Resolve godown — body wins (validate); else retain existing.
    if (billData.godown_id != null) {
      const denied = denyIfGodownInaccessible(billData.godown_id, req.user);
      if (denied) { await t.rollback(); return res.status(403).json({ error: denied }); }
    } else {
      billData.godown_id = existing.godown_id;
    }

    // Reference bill: may be newly set, changed, or cleared. Validate the
    // effective values the update will end up with.
    try {
      await validateReferenceBill({
        reference_bill_id: billData.reference_bill_id,
        customer_id: billData.customer_id || existing.customer_id,
      }, t);
    } catch (refErr) {
      await t.rollback();
      return res.status(400).json({ error: refErr.message });
    }

    // Reverse old stock restorations at the EXISTING return's godown
    // (where the returned goods originally landed).
    const oldGodownId = existing.godown_id;
    for (const oldItem of existing.items) {
      if (oldItem.product_id && existing.return_mode === 'Items' && oldGodownId) {
        await applyGodownStockDelta({
          product_id: oldItem.product_id, godown_id: oldGodownId,
          delta: -parseFloat(oldItem.quantity), t,
        });
        if (oldItem.batch_id) {
          await applyBatchStockDelta({
            product_id: oldItem.product_id, batch_id: oldItem.batch_id,
            godown_id: oldGodownId,
            delta: -parseFloat(oldItem.quantity), t,
          });
        }
        // Audit C5: reverse the per-color stock that was added at the
        // ORIGINAL return create time. We re-apply the new items below.
        if (oldItem.color_id) {
          await applyColorStockDelta({
            color_id: oldItem.color_id,
            delta: -parseFloat(oldItem.quantity),
            transaction: t,
          });
        }
      }
    }
    await StockLedger.destroy({
      where: { reference_id: existing.sales_return_id, transaction_type: 'Sales Return' },
      transaction: t,
    });
    await SalesReturnBillItem.destroy({ where: { sales_return_id: id }, transaction: t });

    const effectiveItems = return_mode === 'Amount'
      ? synthAmountLine(amount_only_total, billData.remarks)
      : newItems;
    if (!Array.isArray(effectiveItems) || effectiveItems.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // Resolve inter-state from the customer's place-of-supply (audit H1).
    const customerForInterState = billData.customer_id || existing.customer_id;
    const interState = await resolveInterState({
      partyId: customerForInterState, transaction: t,
    });

    let totals;
    try {
      totals = await computeTotals(req, effectiveItems, billData, return_mode, t, interState);
    } catch (mathErr) {
      await t.rollback();
      return res.status(400).json({ error: mathErr.message });
    }

    // Over-return cap — exclude THIS return from the prior-sum so legitimate
    // edits to its own quantities don't double-count.
    try {
      await enforceOverReturnCap({
        reference_bill_id: billData.reference_bill_id || existing.reference_bill_id,
        return_mode,
        items: totals.processedItems,
        computedTotal: totals.totalAmount,
        excludeId: existing.sales_return_id,
      }, t);
    } catch (capErr) {
      await t.rollback();
      return res.status(400).json({ error: capErr.message });
    }

    const refund = parseFloat(refund_amount) || 0;
    if (refund > totals.totalAmount + 0.01) {
      await t.rollback();
      return res.status(400).json({
        error: `Refund amount (₹${refund.toFixed(2)}) cannot exceed return total (₹${totals.totalAmount.toFixed(2)})`,
      });
    }
    const balance = +(totals.totalAmount - refund).toFixed(2);
    const refundStatus = refund >= totals.totalAmount - 0.01
      ? 'Refunded'
      : refund > 0
        ? 'Partial'
        : 'Pending';

    await existing.update({
      ...billData,
      return_mode,
      total_items: effectiveItems.length,
      total_quantity: totals.totalQty,
      sub_total: totals.subTotal,
      discount_amount: totals.billDiscountAmt,
      cgst_pct: parseFloat(cgst_pct) || 0,
      sgst_pct: parseFloat(sgst_pct) || 0,
      igst_pct: parseFloat(igst_pct) || 0,
      cgst_amount: totals.totalCgst,
      sgst_amount: totals.totalSgst,
      igst_amount: totals.totalIgst,
      cess_amount: totals.totalCess,
      round_off: totals.roundOffValue,
      other_charges: parseFloat(other_charges) || 0,
      freight_charges: parseFloat(freight_charges) || 0,
      total_amount: totals.totalAmount,
      refund_amount: refund,
      balance_amount: balance,
      refund_status: refundStatus,
    }, { transaction: t });

    for (const item of totals.processedItems) {
      await SalesReturnBillItem.create({
        sales_return_id: id,
        ...item,
        batch_id: item.batch_id || null,
      }, { transaction: t });
      if (item.product_id && return_mode === 'Items') {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        if (!product) continue;
        const newStock = await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: +parseFloat(item.quantity), t,
        });
        if (item.batch_id && product.is_batch_tracked) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: item.batch_id,
            godown_id: billData.godown_id,
            delta: +parseFloat(item.quantity), t,
          });
        }
        // Audit C5: re-apply per-color stock for the (possibly edited)
        // return lines. The old items' color stock was already reversed
        // above.
        if (item.color_id && product.color_mode === 'multi') {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: +parseFloat(item.quantity),
            transaction: t,
          });
        }
        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: item.batch_id || null,
          barcode: item.barcode,
          transaction_type: 'Sales Return',
          transaction_date: billData.return_date || existing.return_date,
          reference_id: existing.sales_return_id,
          reference_number: existing.return_number,
          quantity_in: item.quantity, quantity_out: 0,
          rate: item.rate, balance_quantity: newStock,
          remarks: billData.reason || null,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    const oldCustomer = existing.customer_id;
    const newCustomer = billData.customer_id || oldCustomer;
    if (oldCustomer) await recalculatePartyBalance(oldCustomer, t);
    if (newCustomer && newCustomer !== oldCustomer) await recalculatePartyBalance(newCustomer, t);

    // ── Double-entry: reverse old, post new ──
    await reverseVoucher({
      sourceType: 'sales_return_bill', sourceId: existing.sales_return_id,
      reason: 'Sales return edited', userId: req.user && req.user.user_id, transaction: t,
    });
    {
      const refreshed = await SalesReturnBill.findByPk(existing.sales_return_id, {
        include: [{ model: Party, as: 'customer' }],
        transaction: t,
      });
      const vouchers = await buildSalesReturnVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
    }

    await t.commit();
    const result = await SalesReturnBill.findByPk(existing.sales_return_id, {
      include: [
        { model: Party, as: 'customer' },
        { model: SalesReturnBillItem, as: 'items' },
      ],
    });
    res.json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Update sales return error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.cancel = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const bill = await SalesReturnBill.findByPk(req.params.id, {
      include: [{ model: SalesReturnBillItem, as: 'items' }],
      transaction: t,
    });
    if (!bill) { await t.rollback(); return res.status(404).json({ error: 'Return not found' }); }
    if (bill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Return already cancelled' }); }

    // Pre-check: if stock was restored by this return and is now lower than
    // the quantity we need to pull back out, and allow_negative_stock is off,
    // we must block the cancellation — otherwise inventory goes silently negative.
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const allowNeg = settings?.allow_negative_stock || false;

    if (!allowNeg && bill.return_mode === 'Items') {
      const byProduct = new Map();
      for (const item of bill.items) {
        if (!item.product_id) continue;
        const cur = byProduct.get(item.product_id) || 0;
        byProduct.set(item.product_id, cur + parseFloat(item.quantity || 0));
      }
      // Cancellation pulls the restored stock back out at the return's
      // own godown. A different godown's headroom is irrelevant.
      const billGodown = bill.godown_id;
      for (const [pid, qty] of byProduct) {
        const product = await Product.findByPk(pid, { transaction: t });
        const haveAtGodown = billGodown
          ? await getGodownStock({ product_id: pid, godown_id: billGodown, t, lock: true })
          : 0;
        const finalStock = +(haveAtGodown - qty).toFixed(2);
        if (finalStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Cannot cancel this sales return: "${product.product_name}" would drop to ${finalStock} units at this godown (${Math.abs(finalStock)} already sold from the restored stock). Enable "Allow Negative Stock" in Module Settings to proceed.`,
          });
        }
      }
    }

    // Reverse stock at the return's godown.
    // Audit C6: legacy returns (pre-godown) had godown_id = NULL,
    // and the previous guard skipped reversal. Falls back to default.
    let cancelGodownId = bill.godown_id;
    if (!cancelGodownId && bill.return_mode === 'Items'
        && bill.items.some(i => i.product_id)) {
      cancelGodownId = await getDefaultGodownId({ t });
    }
    if (bill.return_mode === 'Items') {
      for (const item of bill.items) {
        if (item.product_id && cancelGodownId) {
          await applyGodownStockDelta({
            product_id: item.product_id, godown_id: cancelGodownId,
            delta: -parseFloat(item.quantity), t,
          });
          if (item.batch_id) {
            await applyBatchStockDelta({
              product_id: item.product_id, batch_id: item.batch_id,
              godown_id: cancelGodownId,
              delta: -parseFloat(item.quantity), t,
            });
          }
          // Audit C5: cancelling a sales return reverses the per-color
          // stock that was added when the return was created.
          if (item.color_id) {
            await applyColorStockDelta({
              color_id: item.color_id,
              delta: -parseFloat(item.quantity),
              transaction: t,
            });
          }
        }
      }
    }
    await StockLedger.destroy({
      where: { reference_id: bill.sales_return_id, transaction_type: 'Sales Return' },
      transaction: t,
    });

    const { reason: cancellationReason } = req.body || {};
    await bill.update({
      is_cancelled: true,
      cancelled_by: req.user.user_id,
      cancelled_date: new Date(),
      cancellation_reason: cancellationReason || null,
      balance_amount: 0,
      refund_status: 'Pending',
    }, { transaction: t });

    if (bill.customer_id) await recalculatePartyBalance(bill.customer_id, t);

    await reverseVoucher({
      sourceType: 'sales_return_bill', sourceId: bill.sales_return_id,
      reason: cancellationReason || 'Sales return cancelled',
      userId: req.user && req.user.user_id, transaction: t,
    });

    await t.commit();
    res.json({ message: 'Sales return cancelled successfully' });
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Cancel sales return error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
