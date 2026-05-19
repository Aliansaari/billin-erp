const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  SalesReturnBill, SalesReturnBillItem,
  SalesBill, SalesBillItem,
  Party, Product, StockLedger, SystemSettings, Godown, ProductBatch,
} = require('../models');
const { generateBillNumber, roundOff, calculateGST, roundTo, sanitizePagination, escapeLike, splitBillWiseGst, safeTrailingNumber } = require('../utils/helpers');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');
const { resolveInterState } = require('../utils/interStateResolver');
const { writeStockLedgerReversal } = require('../utils/stockLedgerReversal');
const { applyColorStockDelta } = require('../services/productColorStockService');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildSalesReturnVouchers } = require('../services/voucherBuilders');
const { applyGodownStockDelta, getGodownStock, resolveGodownForWrite, getDefaultGodownId } = require('../utils/godownStock');
const { applyBatchStockDelta } = require('../utils/batchStock');
const { restoreConsumption, reverseConsumptionForBillPartial } = require('../utils/costLayers');
const { denyIfGodownInaccessible } = require('../middleware/godownScope');
const { applyFiscalLockGuard, logComplianceEvent, earlierDate } = require('../utils/compliance');

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
      // Audit P3-D — escape LIKE wildcards.
      const s = escapeLike(search);
      where[Op.or] = [
        { return_number: { [Op.iLike]: `%${s}%` } },
        { reference_bill_number: { [Op.iLike]: `%${s}%` } },
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
    console.error('salesReturn getById error:', error);
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
    if (!isFinite(qty) || qty <= 0) {
      throw new Error(`Quantity must be greater than zero (got "${item.quantity}" for "${item.product_name || 'item'}").`);
    }
    if (!isFinite(rate) || rate < 0) {
      throw new Error(`Rate must be a non-negative number (got "${item.rate}" for "${item.product_name || 'item'}").`);
    }
    if (!isFinite(itemDiscPct) || itemDiscPct < 0 || itemDiscPct > 100) {
      throw new Error(`Item discount % must be between 0 and 100 (got ${itemDiscPct}% for "${item.product_name || 'item'}").`);
    }
    const lineTotal = roundTo(qty * rate, 2);  // Audit MONEY-7: round-half-away-from-zero
    const discountAmt = roundTo(lineTotal * itemDiscPct / 100, 2);  // Audit MONEY-7
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
    // them as-is. Audit H2 — splitBillWiseGst rounds the combined tax once
    // and absorbs the paisa residual into SGST so CGST+SGST == combined.
    const _spl = splitBillWiseGst(taxableTotal, cgst_pct, sgst_pct, igst_pct);
    totalCgst = _spl.cgst;
    totalSgst = _spl.sgst;
    totalIgst = _spl.igst;

    // Distribute bill-level GST pro-rata across lines so GSTR-1 credit note
    // line-level data (cgst_amount / sgst_amount / igst_amount per item) is
    // non-zero and proportional to each line's taxable base. The last line
    // absorbs any penny rounding.
    const lineBaseTotal = processedItems.reduce((s, it) => s + it.taxable_amount, 0);
    let allocCgst = 0, allocSgst = 0, allocIgst = 0;
    for (let i = 0; i < processedItems.length; i++) {
      const it = processedItems[i];
      const isLast = i === processedItems.length - 1;
      const ratio = lineBaseTotal > 0 ? it.taxable_amount / lineBaseTotal : 1 / processedItems.length;
      const lc = isLast ? roundTo(totalCgst - allocCgst, 2) : roundTo(totalCgst * ratio, 2);
      const ls = isLast ? roundTo(totalSgst - allocSgst, 2) : roundTo(totalSgst * ratio, 2);
      const li = isLast ? roundTo(totalIgst - allocIgst, 2) : roundTo(totalIgst * ratio, 2);
      it.cgst_amount = lc;
      it.sgst_amount = ls;
      it.igst_amount = li;
      it.total_amount = +(it.taxable_amount + lc + ls + li).toFixed(2);
      allocCgst += lc; allocSgst += ls; allocIgst += li;
    }
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
  // ── Back-dated entry policy (always-on, hard reject) ───────────────
  {
    const bd = require('../utils/backdatedGuard');
    const check = await bd.checkBackdated({
      voucherDate: req.body && req.body.return_date,
      user: req.user,
    });
    if (!check.ok) {
      return res.status(403).json({ error: check.reason, code: check.code });
    }
  }

  // ── Fiscal-lock guard ──────────────────────────────────────────────
  // return_date is the probe. No-op when compliance mode is off.
  const guard = await applyFiscalLockGuard(req, res, req.body?.return_date);
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

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
    // Audit P2-B — per-company two-arg form so multi-tenant installs
    // don't serialise across companies on a shared cluster.
    {
      const companyKey = req.companyId || 0;
      await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
        replacements: { company: companyKey, key: 904 }, transaction: t,
      });
    }

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
    // Audit BILLS-5 — use safeTrailingNumber so legacy imports with a
    // non-numeric suffix (e.g. "SR/2024/A") don't poison the counter:
    // safeTrailingNumber returns 0 in that case, the advisory lock
    // serialises writers, and the unique constraint catches collisions.
    const lastNum = safeTrailingNumber(lastBill && lastBill.return_number);
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

    // ── Audit H6 — exact FIFO layer restore for the whole return ─────────
    // Pre-fix, each return line called the v1 best-effort restoreConsumption
    // which adds qty back to the MOST RECENT consumed layer (regardless of
    // which layer the original sale actually drew from). On a multi-batch
    // sale that consumed an older ₹80 layer, returning 5 units pushed those
    // units back into the newest layer at ₹120 — next FIFO sale then mis-
    // priced.
    //
    // When the return is linked to a reference bill, we now use the SLC
    // table to restore the SAME layer the original sale consumed, propor-
    // tional to the returned quantity. If the reference link is missing
    // (standalone return) or the SLC rows are absent (legacy data), we
    // fall back to v1.
    if (return_mode === 'Items' && totals.processedItems.length > 0) {
      const lines = totals.processedItems
        .filter((it) => it.product_id)
        .map((it) => ({ product_id: it.product_id, qty_returned: +parseFloat(it.quantity) }));
      const refBillId = billData.reference_bill_id || null;
      let skippedPids = [];
      let layersByProduct = {};
      if (refBillId) {
        const result = await reverseConsumptionForBillPartial({
          sales_bill_id: refBillId,
          returnLines: lines,
          t,
        });
        skippedPids = result.skipped || [];
        layersByProduct = result.layersByProduct || {};
      } else {
        skippedPids = lines.map((l) => l.product_id);
      }
      // v1 fallback for any product the exact path couldn't handle (no
      // SLC link or standalone return).
      for (const pid of skippedPids) {
        const line = lines.find((l) => l.product_id === pid);
        if (!line) continue;
        await restoreConsumption({
          product_id: pid,
          godown_id:  billData.godown_id,
          qty: line.qty_returned,
          t,
        });
      }

      // Audit STOCK-2 (deep) — persist the per-layer restoration on
      // each return-item row so cancel/update can invert exactly.
      // Stored as JSONB; NULL for products that fell back to v1 (no
      // SLC link). Reads the newly-created item rows by sales_return_id
      // and product_id and writes the matching layers array.
      for (const pid of Object.keys(layersByProduct)) {
        const layers = layersByProduct[pid];
        if (!layers || layers.length === 0) continue;
        await SalesReturnBillItem.update(
          { layers_restored: layers },
          {
            where: {
              sales_return_id: bill.sales_return_id,
              product_id: Number(pid),
            },
            transaction: t,
          },
        );
      }
    }

    // Audit P2-A — reconcile before recalc so the credit note flows
    // against any open bills for this customer.
    if (billData.customer_id) {
      await reconcileBillsForParty(billData.customer_id, t);
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

    if (guard.overrideUsed) {
      await logComplianceEvent({
        event_type:       lockResult.status === 'hard_override_granted' ? 'hard_override' : 'soft_override',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'sales_return',
        target_id:        bill.sales_return_id,
        target_label:     `Sales return ${bill.return_bill_number || `#${bill.sales_return_id}`} dated ${bill.return_date}`,
        target_date:      bill.return_date,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate },
      });
    }

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
  // ── Back-dated entry policy (always-on, hard reject) ───────────────
  {
    const bd = require('../utils/backdatedGuard');
    const check = await bd.checkBackdated({
      voucherDate: req.body && req.body.return_date,
      user: req.user,
    });
    if (!check.ok) {
      return res.status(403).json({ error: check.reason, code: check.code });
    }
  }

  // ── Fiscal-lock guard on edit (earlier of old/new return_date) ───
  const previewRet = await SalesReturnBill.findByPk(req.params.id, { attributes: ['sales_return_id', 'return_date', 'return_bill_number', 'is_cancelled'] });
  if (!previewRet) return res.status(404).json({ error: 'Sales return not found' });
  if (previewRet.is_cancelled) return res.status(400).json({ error: 'Cannot edit a cancelled return' });
  const oldDateStr = previewRet.return_date && String(previewRet.return_date).slice(0, 10);
  const newDateStr = req.body?.return_date && String(req.body.return_date).slice(0, 10);
  const guard = await applyFiscalLockGuard(req, res, earlierDate(oldDateStr, newDateStr));
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

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

    // Audit STOCK-2 (deep) — un-restore the OLD layer trail before
    // the new items get applied below. Without this, the create-path
    // call to reverseConsumptionForBillPartial would restore qty into
    // layers that already received qty from this same return — a
    // double-restore that future FIFO sales would draw against.
    const updSettings = await SystemSettings.findByPk(1, { transaction: t });
    const updCogsMode = updSettings?.cogs_method || 'weighted_avg';
    if (updCogsMode === 'fifo' && existing.return_mode === 'Items') {
      const { unRestoreLayers } = require('../utils/costLayers');
      for (const oldItem of existing.items) {
        if (Array.isArray(oldItem.layers_restored) && oldItem.layers_restored.length > 0) {
          try {
            await unRestoreLayers({ layersRestored: oldItem.layers_restored, t });
          } catch (e) {
            console.error('[salesReturn.update] un-restore warn:', e.message);
          }
        }
      }
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
    // Audit H5 — reversal pattern for edits.
    await writeStockLedgerReversal({
      referenceId: existing.sales_return_id,
      transactionType: 'Sales Return',
      reason: `Sales Return ${existing.bill_number || '#' + existing.sales_return_id} edited`,
      userId: req.user?.user_id,
      t,
      skipIdempotencyCheck: true,
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

    // Audit STOCK-2 (deep) — restore the layer trail for the NEW items.
    // The create path does this after items are inserted; mirror it
    // here so an edited return ends up with the same per-line
    // layers_restored JSONB as a freshly-created one.
    if (return_mode === 'Items' && totals.processedItems.length > 0) {
      const lines = totals.processedItems
        .filter((it) => it.product_id)
        .map((it) => ({ product_id: it.product_id, qty_returned: +parseFloat(it.quantity) }));
      const refBillId = billData.reference_bill_id || existing.reference_bill_id || null;
      if (refBillId) {
        const result = await reverseConsumptionForBillPartial({
          sales_bill_id: refBillId,
          returnLines: lines,
          t,
        });
        const layersByProduct = result.layersByProduct || {};
        for (const pid of Object.keys(layersByProduct)) {
          const layers = layersByProduct[pid];
          if (!layers || layers.length === 0) continue;
          await SalesReturnBillItem.update(
            { layers_restored: layers },
            {
              where: { sales_return_id: existing.sales_return_id, product_id: Number(pid) },
              transaction: t,
            },
          );
        }
      }
    }

    // Audit P2-A — reconcile + recalc for both old and new customer
    // when the return's customer is changed.
    const oldCustomer = existing.customer_id;
    const newCustomer = billData.customer_id || oldCustomer;
    if (oldCustomer) {
      await reconcileBillsForParty(oldCustomer, t);
      await recalculatePartyBalance(oldCustomer, t);
    }
    if (newCustomer && newCustomer !== oldCustomer) {
      await reconcileBillsForParty(newCustomer, t);
      await recalculatePartyBalance(newCustomer, t);
    }

    // ── Double-entry: reverse old, post new ──
    // SER-6: date reversal to the original return date so it cancels in the right period.
    await reverseVoucher({
      sourceType: 'sales_return_bill', sourceId: existing.sales_return_id,
      reason: 'Sales return edited', userId: req.user && req.user.user_id, transaction: t,
      reversalDate: existing.return_date,
    });
    // Audit MONEY-2 — also reverse the refund-cash voucher (if any).
    // buildSalesReturnVouchers re-emits a fresh one below when the
    // edited return still carries refund_amount > 0; without this
    // reverse, postVoucher would reject as "already posted".
    await reverseVoucher({
      sourceType: 'sales_return_refund', sourceId: existing.sales_return_id,
      reason: 'Sales return edited (refund leg)',
      userId: req.user && req.user.user_id, transaction: t,
      reversalDate: existing.return_date,
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

    if (guard.overrideUsed) {
      await logComplianceEvent({
        event_type:       'post_close_edit',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'sales_return',
        target_id:        existing.sales_return_id,
        target_label:     `Sales return ${existing.return_bill_number || `#${existing.sales_return_id}`} edited (date ${oldDateStr || '—'} → ${newDateStr || oldDateStr || '—'})`,
        target_date:      newDateStr || oldDateStr || null,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate, old_date: oldDateStr, new_date: newDateStr || oldDateStr },
      });
    }

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
  // Fiscal-lock guard on cancel — probe is the return's own date.
  const previewCancel = await SalesReturnBill.findByPk(req.params.id, { attributes: ['sales_return_id', 'return_date', 'return_bill_number', 'is_cancelled'] });
  if (!previewCancel) return res.status(404).json({ error: 'Sales return not found' });
  if (previewCancel.is_cancelled) return res.status(400).json({ error: 'Return already cancelled' });
  const cancelDateStr = previewCancel.return_date && String(previewCancel.return_date).slice(0, 10);
  const guard = await applyFiscalLockGuard(req, res, cancelDateStr);
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

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
      // Audit STOCK-6 — legacy returns from pre-godown installs have
      // bill.godown_id = NULL. The actual cancel-apply loop below
      // falls back to the default godown for such rows; the pre-check
      // must use the SAME fallback or it computes haveAtGodown=0,
      // always rejecting the cancel even when there's plenty of stock.
      const preCheckGodown = billGodown || await getDefaultGodownId({ t });
      for (const [pid, qty] of byProduct) {
        const product = await Product.findByPk(pid, { transaction: t });
        const haveAtGodown = preCheckGodown
          ? await getGodownStock({ product_id: pid, godown_id: preCheckGodown, t, lock: true })
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
    // Audit STOCK-2 (deep) — in FIFO mode the return CREATE captured a
    // per-layer restoration trail into sales_return_bill_items
    // .layers_restored. On cancel we deduct from those EXACT layers
    // (preserving original cost basis on future sales). For items
    // that fell back to v1 restoreConsumption (no SLC link), we
    // generic-FIFO-consume as a best-effort.
    const cogsModeForCancel = settings?.cogs_method || 'weighted_avg';
    const { consumeFIFO, unRestoreLayers } = require('../utils/costLayers');

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
          // Audit STOCK-2 (deep) — exact-layer un-restore if the row
          // captured one; fall back to FIFO consume otherwise.
          if (cogsModeForCancel === 'fifo') {
            try {
              if (Array.isArray(item.layers_restored) && item.layers_restored.length > 0) {
                await unRestoreLayers({ layersRestored: item.layers_restored, t });
              } else {
                await consumeFIFO({
                  product_id: item.product_id,
                  godown_id: cancelGodownId,
                  qty: parseFloat(item.quantity) || 0,
                  t,
                });
              }
            } catch (e) {
              // Log but don't fail the cancel — qty conservation is
              // best-effort here; the godown stock is authoritative.
              console.error('[salesReturn.cancel] FIFO un-restore warn:', e.message);
            }
          }
        }
      }
    }
    // Audit H5 — paired reversing entries instead of destroy.
    await writeStockLedgerReversal({
      referenceId: bill.sales_return_id,
      transactionType: 'Sales Return',
      reason: `Sales Return ${bill.bill_number || '#' + bill.sales_return_id} cancelled`,
      userId: req.user?.user_id,
      t,
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

    if (bill.customer_id) {
      await reconcileBillsForParty(bill.customer_id, t);
      await recalculatePartyBalance(bill.customer_id, t);
    }

    // LED-H2 — reversal stays in original return date.
    await reverseVoucher({
      sourceType: 'sales_return_bill', sourceId: bill.sales_return_id,
      reason: cancellationReason || 'Sales return cancelled',
      userId: req.user && req.user.user_id, transaction: t,
      reversalDate: bill.return_date,
    });

    // Audit MONEY-2 — also reverse the refund-cash voucher that
    // buildSalesReturnVouchers emits when refund_amount > 0 for a
    // non-cash customer. Pre-fix this voucher was orphaned on cancel,
    // leaving Cash CR and Customer DR posted forever — Trial Balance
    // off by the refund amount on every cancelled refunded return.
    // reverseVoucher is idempotent so the call is safe when no refund
    // voucher was ever posted (e.g. no refund_amount on the return).
    await reverseVoucher({
      sourceType: 'sales_return_refund', sourceId: bill.sales_return_id,
      reason: cancellationReason || 'Sales return cancelled (refund leg)',
      reversalDate: bill.return_date,
      userId: req.user && req.user.user_id, transaction: t,
    });

    await t.commit();

    if (guard.overrideUsed) {
      await logComplianceEvent({
        event_type:       lockResult.status === 'hard_override_granted' ? 'hard_override' : 'soft_override',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'sales_return',
        target_id:        bill.sales_return_id,
        target_label:     `Sales return ${bill.return_bill_number || `#${bill.sales_return_id}`} cancelled (was dated ${cancelDateStr})`,
        target_date:      cancelDateStr,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate, action: 'cancel' },
      });
    }

    res.json({ message: 'Sales return cancelled successfully' });
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Cancel sales return error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
