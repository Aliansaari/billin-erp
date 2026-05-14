const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  PurchaseReturnBill, PurchaseReturnBillItem,
  PurchaseBill, PurchaseBillItem,
  Party, Product, StockLedger, SystemSettings, Godown, ProductBatch,
} = require('../models');
const { generateBillNumber, roundOff, calculateGST, roundTo, sanitizePagination, escapeLike, splitBillWiseGst } = require('../utils/helpers');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');
const { resolveInterState } = require('../utils/interStateResolver');
const { writeStockLedgerReversal } = require('../utils/stockLedgerReversal');
const { applyColorStockDelta } = require('../services/productColorStockService');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildPurchaseReturnVouchers } = require('../services/voucherBuilders');
const { applyGodownStockDelta, getGodownStock, resolveGodownForWrite } = require('../utils/godownStock');
const { applyBatchStockDelta } = require('../utils/batchStock');
const { recomputeWeightedAvgFromLedger } = require('../utils/weightedAvgCost');
const { consumeFIFO } = require('../utils/costLayers');
const { denyIfGodownInaccessible } = require('../middleware/godownScope');

// See salesReturnController.UNSAFE_BILL_FIELDS for rationale.
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
 * Reference purchase bill validation — supplier-side mirror of the sales
 * variant. See salesReturnController.validateReferenceBill for full rationale.
 */
async function validateReferenceBill({ reference_bill_id, supplier_id }, t) {
  if (!reference_bill_id) return null;
  const ref = await PurchaseBill.findByPk(reference_bill_id, { transaction: t });
  if (!ref) throw new Error(`Referenced purchase bill #${reference_bill_id} does not exist.`);
  if (ref.is_cancelled) throw new Error(`Referenced purchase bill ${ref.bill_number} is cancelled — you cannot return against a cancelled bill.`);
  if (supplier_id && Number(supplier_id) !== Number(ref.supplier_id)) {
    throw new Error(`Supplier on return does not match the supplier on referenced bill ${ref.bill_number}. Returns must debit the same supplier we bought from.`);
  }
  return ref;
}

/**
 * Over-return cap — supplier-side mirror. Prevents debiting a supplier for
 * more goods than we actually purchased from them on the referenced bill.
 * See salesReturnController.enforceOverReturnCap for the full write-up.
 */
async function enforceOverReturnCap({
  reference_bill_id, return_mode, items, computedTotal, excludeId,
}, t) {
  if (!reference_bill_id) return;

  const ref = await PurchaseBill.findByPk(reference_bill_id, {
    include: [{ model: PurchaseBillItem, as: 'items' }],
    transaction: t,
  });
  if (!ref) return;

  if (return_mode === 'Amount') {
    const where = { reference_bill_id, is_cancelled: false };
    if (excludeId) where.purchase_return_id = { [Op.ne]: excludeId };
    const priorRaw = await PurchaseReturnBill.sum('total_amount', { where, transaction: t });
    const prior = parseFloat(priorRaw) || 0;
    const refTotal = parseFloat(ref.total_amount) || 0;
    if (prior + computedTotal > refTotal + 0.01) {
      throw new Error(`Amount-only return would take total debits to ₹${(prior + computedTotal).toFixed(2)}, but original bill ${ref.bill_number} is only ₹${refTotal.toFixed(2)}.`);
    }
    return;
  }

  const linked = items.filter((it) => it.original_item_id);
  if (linked.length === 0) return;
  const where = { reference_bill_id, is_cancelled: false };
  if (excludeId) where.purchase_return_id = { [Op.ne]: excludeId };
  const otherReturns = await PurchaseReturnBill.findAll({
    where,
    include: [{ model: PurchaseReturnBillItem, as: 'items' }],
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
    if (!original) continue;
    const origQty = parseFloat(original.quantity) || 0;
    const already = priorByOrig.get(it.original_item_id) || 0;
    const thisQty = parseFloat(it.quantity) || 0;
    if (already + thisQty > origQty + 0.001) {
      throw new Error(`"${original.product_name || 'Item'}" — returning ${thisQty} would take total returned to ${(already + thisQty).toFixed(2)} out of ${origQty} purchased on bill ${ref.bill_number}.`);
    }
  }
}

/* ============================================================================
 *  Purchase Return Controller — DEBIT NOTE (goods returned to supplier).
 *
 *  A Purchase Return:
 *    · decreases payable to supplier (we owe them less, or they owe us)
 *    · REMOVES stock from inventory (StockLedger.transaction_type = 'Purchase Return')
 *    · optionally links to a reference purchase bill for audit trail
 *
 *  Two modes via return_mode:
 *    · 'Items'  — line-by-line return with full GST + discount recomputation.
 *                 Stock is deducted for every product_id. Pre-check refuses a
 *                 return that would push stock below zero when allow_negative
 *                 _stock is disabled.
 *    · 'Amount' — debit note without any stock movement (e.g. rate adjustment,
 *                 shortage claim). Non-product synthetic line carries the total.
 *
 *  Math mirrors purchaseController exactly — same helpers, same rounding,
 *  same GST allocation — so debit note + invoice reconcile paisa-for-paisa.
 * ========================================================================= */

exports.getAll = async (req, res) => {
  try {
    const { from_date, to_date, supplier_id, refund_status, search } = req.query;
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_cancelled: false };

    if (from_date && to_date) where.return_date = { [Op.between]: [from_date, to_date] };
    if (supplier_id) where.supplier_id = supplier_id;
    if (refund_status) where.refund_status = refund_status;
    if (search) {
      // Audit P3-D — escape LIKE wildcards.
      const s = escapeLike(search);
      where[Op.or] = [
        { return_number: { [Op.iLike]: `%${s}%` } },
        { reference_bill_number: { [Op.iLike]: `%${s}%` } },
      ];
    }

    const { count, rows } = await PurchaseReturnBill.findAndCountAll({
      where,
      include: [
        { model: Party,  as: 'supplier', attributes: ['party_name', 'mobile_1'] },
        { model: Godown, as: 'godown',   attributes: ['godown_id', 'code', 'name'] },
      ],
      order: [['return_date', 'DESC'], ['purchase_return_id', 'DESC']],
      limit,
      offset,
    });

    // Summary aggregates over the FULL filtered set.
    const totals = await PurchaseReturnBill.findAll({
      where,
      attributes: [
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total_amount')),    0), 'total_amount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('refund_amount')),   0), 'total_refund'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('balance_amount')),  0), 'total_pending'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('discount_amount')), 0), 'total_discount'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('cgst_amount')),     0), 'total_cgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('sgst_amount')),     0), 'total_sgst'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('igst_amount')),     0), 'total_igst'],
        [sequelize.fn('COUNT', sequelize.col('purchase_return_id')), 'count'],
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
    console.error('Get purchase returns error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const bill = await PurchaseReturnBill.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'supplier' },
        // Include the batch row on each line so the print template can
        // emit the "Lot · Mfd · Exp" sub-line under the product name
        // (Commit 5).
        {
          model: PurchaseReturnBillItem, as: 'items',
          include: [{ model: ProductBatch, as: 'batch', attributes: ['batch_id', 'batch_number', 'manufacture_date', 'expiry_date'] }],
        },
        { model: PurchaseBill, as: 'referenceBill', attributes: ['purchase_bill_id', 'bill_number', 'bill_date', 'total_amount'] },
      ],
    });
    if (!bill) return res.status(404).json({ error: 'Return not found' });
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getReferenceBill = async (req, res) => {
  try {
    const bill = await PurchaseBill.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'supplier', attributes: ['party_id', 'party_name', 'mobile_1'] },
        { model: PurchaseBillItem, as: 'items' },
      ],
    });
    if (!bill) return res.status(404).json({ error: 'Purchase bill not found' });
    if (bill.is_cancelled) return res.status(400).json({ error: 'Cannot return a cancelled bill' });
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

// `interState` decides CGST+SGST vs IGST routing for per-line GST. Mirrors
// the sales-return convention. (Audit H1: returns must classify identically
// to the original purchase or GSTR-1's Debit Note section reports the wrong
// place-of-supply head.)
async function computeTotals(req, items, billData, interState = false) {
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
    const lineTotal = +(qty * rate).toFixed(2);
    const discountAmt = +(lineTotal * itemDiscPct / 100).toFixed(2);
    const postItemTaxable = +(lineTotal - discountAmt).toFixed(2);
    processedItems.push({
      ...item,
      _postItemTaxable: postItemTaxable,
      taxable_amount: postItemTaxable,
      discount_amount: discountAmt,
      cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
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
      totalCgst += gst.cgst; totalSgst += gst.sgst; totalIgst += gst.igst;
    }
    delete it._postItemTaxable;
  }
  if (billWise) {
    // Audit H2 — paisa-perfect bill-wise split (see salesController).
    const _spl = splitBillWiseGst(taxableTotal, cgst_pct, sgst_pct, igst_pct);
    totalCgst = _spl.cgst;
    totalSgst = _spl.sgst;
    totalIgst = _spl.igst;

    // Distribute bill-level GST pro-rata across lines so GSTR-2 debit note
    // line-level data is non-zero and proportional to each line's taxable base.
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
    processedItems, subTotal, totalQty, taxableTotal, billDiscountAmt,
    totalCgst, totalSgst, totalIgst, totalCess,
    roundOffValue, totalAmount: roundedAmount,
  };
}

function synthAmountLine(amount, remarks) {
  const a = +(parseFloat(amount) || 0).toFixed(2);
  return [{
    product_id: null, barcode: null,
    product_name: 'Debit Note',
    size: null, article_number: null, hsn_code: null,
    category_id: null, category_name: null,
    unit_type: 'Lot',
    quantity: 1, rate: a, mrp: 0,
    discount_percentage: 0, gst_rate: 0,
    quantity_per_box: 1,
    return_condition: remarks || null,
  }];
}

exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const {
      items, return_mode = 'Items',
      refund_amount = 0,
      other_charges = 0, freight_charges = 0,
      cgst_pct = 0, sgst_pct = 0, igst_pct = 0,
      amount_only_total = 0,
      ...rawBillData
    } = req.body;

    const billData = stripUnsafe(rawBillData);

    if (!billData.supplier_id) {
      await t.rollback();
      return res.status(400).json({ error: 'Supplier is required on a purchase return' });
    }

    // Shape checks.
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

    // Reference bill existence + supplier match.
    try {
      await validateReferenceBill({
        reference_bill_id: billData.reference_bill_id,
        supplier_id: billData.supplier_id,
      }, t);
    } catch (refErr) {
      await t.rollback();
      return res.status(400).json({ error: refErr.message });
    }

    // ── Return number race (Fix #17) ───────────────────────────────────
    // Advisory key 906 = purchase returns. Same rationale as the other
    // bill-number allocations — row-level FOR UPDATE didn't serialise
    // concurrent INSERTs so two clients could mint the same return_number.
    // Audit P2-B — per-company two-arg form.
    {
      const companyKey = req.companyId || 0;
      await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
        replacements: { company: companyKey, key: 906 }, transaction: t,
      });
    }
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const prefix = settings?.purchase_return_prefix?.trim() || 'PR';
    const allowNeg = settings?.allow_negative_stock || false;

    const lastBill = await PurchaseReturnBill.findOne({
      order: [['purchase_return_id', 'DESC']],
      transaction: t,
    });
    const lastNum = lastBill ? parseInt((lastBill.return_number.split('-').pop() || '0')) : 0;
    billData.return_number = generateBillNumber(prefix, lastNum);
    billData.created_by = req.user.user_id;

    // Resolve godown — explicit body, else referenced bill's godown,
    // else default. (Returning to the supplier from the same warehouse
    // the goods came from is the intuitive default.)
    if (billData.godown_id == null && billData.reference_bill_id) {
      const ref = await PurchaseBill.findByPk(billData.reference_bill_id, { transaction: t });
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

    const effectiveItems = return_mode === 'Amount'
      ? synthAmountLine(amount_only_total, billData.remarks)
      : items;
    if (!Array.isArray(effectiveItems) || effectiveItems.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // Pre-check: aggregated stock impact per product. Reject if any would
    // go below zero (unless negative stock is explicitly allowed).
    if (!allowNeg && return_mode === 'Items') {
      const delta = new Map();
      for (const it of effectiveItems) {
        if (!it.product_id) continue;
        delta.set(it.product_id, (delta.get(it.product_id) || 0) + parseFloat(it.quantity || 0));
      }
      // Pre-check: a purchase-return removes stock at the bill's godown.
      // Per-godown availability governs the negative-stock guard — other
      // godowns' headroom doesn't help.
      for (const [pid, qty] of delta) {
        const product = await Product.findByPk(pid, { transaction: t });
        const haveAtGodown = await getGodownStock({
          product_id: pid, godown_id: billData.godown_id, t,
          lock: true,  // audit H7
        });
        const finalStock = +(haveAtGodown - qty).toFixed(2);
        if (finalStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for "${product.product_name}" at this godown — would drop to ${finalStock} units. Enable "Allow Negative Stock" in Module Settings or reduce the return quantity.`,
          });
        }
      }
    }

    // Resolve inter-state from the supplier's place-of-supply (audit H1).
    const interState = await resolveInterState({
      partyId: billData.supplier_id, transaction: t,
    });

    let totals;
    try {
      totals = await computeTotals(req, effectiveItems, billData, interState);
    } catch (mathErr) {
      await t.rollback();
      return res.status(400).json({ error: mathErr.message });
    }

    // Over-return cap — cumulative across all non-cancelled returns on the ref bill.
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
      : refund > 0 ? 'Partial' : 'Pending';

    const bill = await PurchaseReturnBill.create({
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

    const returnTouchedProductIds = new Set();
    for (const item of totals.processedItems) {
      await PurchaseReturnBillItem.create({
        purchase_return_id: bill.purchase_return_id,
        ...item,
        batch_id: item.batch_id || null,
      }, { transaction: t });

      if (item.product_id && return_mode === 'Items') {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        if (!product) continue;
        returnTouchedProductIds.add(item.product_id);
        const newStock = await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: -parseFloat(item.quantity), t,
        });
        // Batch dimension: a purchase return REMOVES stock from the
        // originating batch (we're shipping the lot back to the
        // supplier). Mirror of the sales-side decrement; both must move
        // in the same transaction so a rollback restores both
        // consistently. Only applies to batched lines.
        if (item.batch_id && product.is_batch_tracked) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: item.batch_id,
            godown_id: billData.godown_id,
            delta: -parseFloat(item.quantity), t,
          });
        }
        // Audit C5: a purchase return SHIPS goods back to the supplier,
        // so per-color stock decrements for the picked color. Without
        // this, parent stock falls but per-color stock is left high,
        // breaking the sum-of-colors = parent invariant.
        if (item.color_id && product.color_mode === 'multi') {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: -parseFloat(item.quantity),
            transaction: t,
          });
        }

        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: item.batch_id || null,
          barcode: item.barcode,
          transaction_type: 'Purchase Return',
          transaction_date: billData.return_date,
          reference_id: bill.purchase_return_id,
          reference_number: bill.return_number,
          quantity_in: 0,
          quantity_out: item.quantity,
          rate: item.rate,
          balance_quantity: newStock,
          remarks: billData.reason || null,
          created_by: req.user.user_id,
        }, { transaction: t });
        // CRIT-5 fix: consume from the FIFO cost layer queue when returning
        // goods to the supplier. Stock goes out so the oldest available layer
        // qty must decrease by the returned quantity. Without this, the layer
        // queue stays inflated and the next FIFO sale would double-consume.
        await consumeFIFO({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          qty: +parseFloat(item.quantity),
          t,
        });
      }
    }

    // Audit P2-A — reconcile before recalc so the debit note flows
    // against any open bills for this supplier.
    if (billData.supplier_id) {
      await reconcileBillsForParty(billData.supplier_id, t);
    }
    await recalculatePartyBalance(billData.supplier_id, t);

    // Recompute weighted_avg_cost for every single-mode product whose
    // stock just rolled back from this return. The new Purchase Return
    // ledger row(s) are in place; the helper walks the full history and
    // produces the correct post-return wac. No-op for variant + batch
    // products. If the return takes stock to zero, the helper resets
    // wac to 0 so the next purchase starts a fresh basis.
    for (const pid of returnTouchedProductIds) {
      await recomputeWeightedAvgFromLedger({ product_id: pid, t });
    }

    // ── Double-entry posting ──
    {
      const refreshed = await PurchaseReturnBill.findByPk(bill.purchase_return_id, {
        include: [{ model: Party, as: 'supplier' }],
        transaction: t,
      });
      const vouchers = await buildPurchaseReturnVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
    }

    await t.commit();

    const result = await PurchaseReturnBill.findByPk(bill.purchase_return_id, {
      include: [
        { model: Party, as: 'supplier' },
        { model: PurchaseReturnBillItem, as: 'items' },
      ],
    });
    res.status(201).json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Create purchase return error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const {
      items: newItems, return_mode = 'Items',
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

    const existing = await PurchaseReturnBill.findByPk(id, {
      include: [{ model: PurchaseReturnBillItem, as: 'items' }],
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

    // Reference bill validation (post-update effective values).
    try {
      await validateReferenceBill({
        reference_bill_id: billData.reference_bill_id,
        supplier_id: billData.supplier_id || existing.supplier_id,
      }, t);
    } catch (refErr) {
      await t.rollback();
      return res.status(400).json({ error: refErr.message });
    }

    // Pre-check net delta for allow_negative_stock — same mental model as
    // purchaseController.update: revert-old + apply-new.
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const allowNeg = settings?.allow_negative_stock || false;

    // Reverse old stock outflows (+quantity back) at the EXISTING return's
    // godown — that's where the stock was originally pulled from.
    const oldGodownId = existing.godown_id;
    const updateTouchedProductIds = new Set();
    if (existing.return_mode === 'Items') {
      for (const oldItem of existing.items) {
        if (oldItem.product_id && oldGodownId) {
          updateTouchedProductIds.add(oldItem.product_id);
          await applyGodownStockDelta({
            product_id: oldItem.product_id, godown_id: oldGodownId,
            delta: +parseFloat(oldItem.quantity), t,
          });
          if (oldItem.batch_id) {
            await applyBatchStockDelta({
              product_id: oldItem.product_id, batch_id: oldItem.batch_id,
              godown_id: oldGodownId,
              delta: +parseFloat(oldItem.quantity), t,
            });
          }
          // Audit C5: reverse the per-color stock decrement that the
          // original return create posted. The new items' colors are
          // re-applied below.
          if (oldItem.color_id) {
            await applyColorStockDelta({
              color_id: oldItem.color_id,
              delta: +parseFloat(oldItem.quantity),
              transaction: t,
            });
          }
        }
      }
    }
    // Audit H5 — reversal pattern for edits.
    await writeStockLedgerReversal({
      referenceId: existing.purchase_return_id,
      transactionType: 'Purchase Return',
      reason: `Purchase Return ${existing.bill_number || '#' + existing.purchase_return_id} edited`,
      userId: req.user?.user_id,
      t,
      skipIdempotencyCheck: true,
    });
    await PurchaseReturnBillItem.destroy({ where: { purchase_return_id: id }, transaction: t });

    const effectiveItems = return_mode === 'Amount'
      ? synthAmountLine(amount_only_total, billData.remarks)
      : newItems;
    if (!Array.isArray(effectiveItems) || effectiveItems.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // Re-check at the new bill's godown: with old stock reversed as the
    // baseline, do the new outflows fit?
    if (!allowNeg && return_mode === 'Items') {
      const delta = new Map();
      for (const it of effectiveItems) {
        if (!it.product_id) continue;
        delta.set(it.product_id, (delta.get(it.product_id) || 0) + parseFloat(it.quantity || 0));
      }
      for (const [pid, qty] of delta) {
        const product = await Product.findByPk(pid, { transaction: t });
        const haveAtGodown = await getGodownStock({
          product_id: pid, godown_id: billData.godown_id, t,
          lock: true,  // audit H7
        });
        const finalStock = +(haveAtGodown - qty).toFixed(2);
        if (finalStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for "${product.product_name}" at this godown — would drop to ${finalStock} units. Enable "Allow Negative Stock" or reduce the return quantity.`,
          });
        }
      }
    }

    // Resolve inter-state from the supplier's place-of-supply (audit H1).
    const interStateUpd = await resolveInterState({
      partyId: billData.supplier_id || existing.supplier_id, transaction: t,
    });

    let totals;
    try {
      totals = await computeTotals(req, effectiveItems, billData, interStateUpd);
    } catch (mathErr) {
      await t.rollback();
      return res.status(400).json({ error: mathErr.message });
    }

    try {
      await enforceOverReturnCap({
        reference_bill_id: billData.reference_bill_id || existing.reference_bill_id,
        return_mode,
        items: totals.processedItems,
        computedTotal: totals.totalAmount,
        excludeId: existing.purchase_return_id,
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
      : refund > 0 ? 'Partial' : 'Pending';

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
      await PurchaseReturnBillItem.create({
        purchase_return_id: id,
        ...item,
        batch_id: item.batch_id || null,
      }, { transaction: t });
      if (item.product_id && return_mode === 'Items') {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        if (!product) continue;
        updateTouchedProductIds.add(item.product_id);
        const newStock = await applyGodownStockDelta({
          product_id: item.product_id, godown_id: billData.godown_id,
          delta: -parseFloat(item.quantity), t,
        });
        if (item.batch_id && product.is_batch_tracked) {
          await applyBatchStockDelta({
            product_id: item.product_id, batch_id: item.batch_id,
            godown_id: billData.godown_id,
            delta: -parseFloat(item.quantity), t,
          });
        }
        // Audit C5: re-apply per-color stock for the (possibly edited)
        // return lines. Old items' color stock was reversed above.
        if (item.color_id && product.color_mode === 'multi') {
          await applyColorStockDelta({
            color_id: item.color_id,
            delta: -parseFloat(item.quantity),
            transaction: t,
          });
        }
        await StockLedger.create({
          product_id: item.product_id,
          godown_id: billData.godown_id,
          batch_id: item.batch_id || null,
          barcode: item.barcode,
          transaction_type: 'Purchase Return',
          transaction_date: billData.return_date || existing.return_date,
          reference_id: existing.purchase_return_id,
          reference_number: existing.return_number,
          quantity_in: 0, quantity_out: item.quantity,
          rate: item.rate, balance_quantity: newStock,
          remarks: billData.reason || null,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    // Recompute wac for every touched single-mode product. Same pattern
    // as create: walk the post-edit ledger and produce the correct wac.
    for (const pid of updateTouchedProductIds) {
      await recomputeWeightedAvgFromLedger({ product_id: pid, t });
    }

    // Audit P2-A — reconcile + recalc for both old and new supplier.
    const oldSupplier = existing.supplier_id;
    const newSupplier = billData.supplier_id || oldSupplier;
    if (newSupplier) {
      await reconcileBillsForParty(newSupplier, t);
      await recalculatePartyBalance(newSupplier, t);
    }
    if (newSupplier !== oldSupplier && oldSupplier) {
      await reconcileBillsForParty(oldSupplier, t);
      await recalculatePartyBalance(oldSupplier, t);
    }

    // ── Double-entry: reverse old, post new ──
    // SER-6: date reversal to the original return date so it cancels in the right period.
    await reverseVoucher({
      sourceType: 'purchase_return_bill', sourceId: existing.purchase_return_id,
      reason: 'Purchase return edited', userId: req.user && req.user.user_id, transaction: t,
      reversalDate: existing.return_date,
    });
    {
      const refreshed = await PurchaseReturnBill.findByPk(existing.purchase_return_id, {
        include: [{ model: Party, as: 'supplier' }],
        transaction: t,
      });
      const vouchers = await buildPurchaseReturnVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
    }

    await t.commit();
    const result = await PurchaseReturnBill.findByPk(existing.purchase_return_id, {
      include: [
        { model: Party, as: 'supplier' },
        { model: PurchaseReturnBillItem, as: 'items' },
      ],
    });
    res.json(result);
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Update purchase return error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.cancel = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const bill = await PurchaseReturnBill.findByPk(req.params.id, {
      include: [{ model: PurchaseReturnBillItem, as: 'items' }],
      transaction: t,
    });
    if (!bill) { await t.rollback(); return res.status(404).json({ error: 'Return not found' }); }
    if (bill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Return already cancelled' }); }

    // Cancellation restocks at the bill's own godown. Pure addition,
    // no pre-check needed.
    const returnCancelTouchedProductIds = new Set();
    if (bill.return_mode === 'Items') {
      for (const item of bill.items) {
        if (item.product_id && bill.godown_id) {
          returnCancelTouchedProductIds.add(item.product_id);
          await applyGodownStockDelta({
            product_id: item.product_id, godown_id: bill.godown_id,
            delta: +parseFloat(item.quantity), t,
          });
          if (item.batch_id) {
            await applyBatchStockDelta({
              product_id: item.product_id, batch_id: item.batch_id,
              godown_id: bill.godown_id,
              delta: +parseFloat(item.quantity), t,
            });
          }
          // Audit C5: cancelling a purchase return reverses the per-color
          // decrement that was posted at create time.
          if (item.color_id) {
            await applyColorStockDelta({
              color_id: item.color_id,
              delta: +parseFloat(item.quantity),
              transaction: t,
            });
          }
        }
      }
    }
    // Audit H5 — paired reversing entries instead of destroy. The wac
    // recompute below replays Purchase Return rows; the original out-leg
    // and the reversal in-leg cancel out, restoring wac to pre-return state.
    await writeStockLedgerReversal({
      referenceId: bill.purchase_return_id,
      transactionType: 'Purchase Return',
      reason: `Purchase Return ${bill.bill_number || '#' + bill.purchase_return_id} cancelled`,
      userId: req.user?.user_id,
      t,
    });

    // Recompute wac for every touched single-mode product. The original
    // Purchase Return rows + paired reversals net to zero contribution;
    // the helper produces the correct wac as if the return had never happened.
    for (const pid of returnCancelTouchedProductIds) {
      await recomputeWeightedAvgFromLedger({ product_id: pid, t });
    }

    const { reason: cancellationReason } = req.body || {};
    await bill.update({
      is_cancelled: true,
      cancelled_by: req.user.user_id,
      cancelled_date: new Date(),
      cancellation_reason: cancellationReason || null,
      balance_amount: 0,
      refund_status: 'Pending',
    }, { transaction: t });

    if (bill.supplier_id) {
      await reconcileBillsForParty(bill.supplier_id, t);
      await recalculatePartyBalance(bill.supplier_id, t);
    }

    await reverseVoucher({
      sourceType: 'purchase_return_bill', sourceId: bill.purchase_return_id,
      reason: cancellationReason || 'Purchase return cancelled',
      userId: req.user && req.user.user_id, transaction: t,
    });

    await t.commit();
    res.json({ message: 'Purchase return cancelled successfully' });
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Cancel purchase return error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
