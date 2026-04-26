const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { SalesBill, SalesBillItem, SalesBillDraft, SalesReturnBill, SalesReturnBillItem, Party, Product, StockLedger, SystemSettings } = require('../models');
const { generateBillNumber, roundOff, calculateGST, roundTo, sanitizePagination } = require('../utils/helpers');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');
const { stateCodeFromGstin, stateCodeFromName } = require('../utils/gstr1');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers } = require('../services/voucherBuilders');

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
async function _resolveInterState(billData, t) {
  if (!billData.customer_id) return false;
  const [cust, settings] = await Promise.all([
    Party.findByPk(billData.customer_id, { transaction: t }),
    SystemSettings.findByPk(1, { transaction: t }),
  ]);
  if (!cust) return false;
  const companyCode = settings ? stateCodeFromGstin(settings.gstin) : null;
  if (!companyCode) return false;
  // Customer place-of-supply: GSTIN prefix wins, fall back to state name.
  const custCode = stateCodeFromGstin(cust.gstin) || stateCodeFromName(cust.state);
  if (!custCode) return false;
  return custCode !== companyCode;
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
      include: [{ model: Party, as: 'customer', attributes: ['party_name', 'mobile_1'] }],
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

    res.json({ total: count, page, limit, data: rows });
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
        { model: SalesBillItem, as: 'items' },
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
async function createInlineReturn({ customer_id, billDate, items, reason, isInterState, req, t }) {
  if (!Array.isArray(items) || items.length === 0) return null;

  // Allocate next return number under a row lock (mirrors salesController
  // pattern). Uses sales_return_prefix from settings, default 'SR'.
  const settings = await SystemSettings.findByPk(1, { transaction: t });
  const prefix = settings?.sales_return_prefix?.trim() || 'SR';
  const lastReturn = await SalesReturnBill.findOne({
    order: [['sales_return_id', 'DESC']],
    lock: t.LOCK.UPDATE,
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
        const newStock = +((parseFloat(product.current_stock) || 0) + parseFloat(it.quantity)).toFixed(2);
        await product.update({ current_stock: newStock }, { transaction: t });
        await StockLedger.create({
          product_id: it.product_id,
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

    // Generate bill number using prefix from settings — inside transaction to prevent race condition
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const prefix = settings?.sales_bill_prefix?.trim() || '';
    // Bill number race fix: lock by primary key so concurrent creates serialise.
    // Without the lock two requests could both read the same lastBill and issue
    // duplicate bill numbers, which the unique index would then reject.
    const lastBill = await SalesBill.findOne({
      order: [['sales_bill_id', 'DESC']],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    const lastNum = lastBill ? parseInt(lastBill.bill_number.split('-').pop()) : 0;
    billData.bill_number = generateBillNumber(prefix, lastNum);
    billData.created_by = req.user.user_id;
    billData.sales_person = billData.sales_person || req.user.user_id;

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
    if (billData.customer_id) {
      const customer = await Party.findByPk(billData.customer_id, { transaction: t });
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

    for (const item of processedItems) {
      // Fetch the product once to (a) snapshot its purchase_rate as COGS
      // for this line, and (b) reuse for the stock deduction below. Doing
      // both off the same read avoids a second roundtrip and keeps the cost
      // snapshot in the same transaction as the bill itself.
      let product = null;
      if (item.product_id) {
        product = await Product.findByPk(item.product_id, { transaction: t });
      }
      const costRate = product ? parseFloat(product.purchase_rate || 0) : 0;

      await SalesBillItem.create({
        sales_bill_id: bill.sales_bill_id,
        ...item,
        // Server-computed; overrides anything the client might have sent so
        // profit reports can't be manipulated by a tampered API call.
        cost_rate: costRate,
      }, { transaction: t });

      // Deduct stock
      if (product) {
        const currentStock = parseFloat(product.current_stock) || 0;
        const newStock = +(currentStock - parseFloat(item.quantity)).toFixed(2);

        // Block sale if it would cause negative stock and negative stock is disabled
        if (!allowNegativeStock && newStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for "${item.product_name || product.product_name}". Available: ${currentStock}, Requested: ${item.quantity}. Enable "Allow Negative Stock" in Module Settings to proceed.`,
          });
        }

        await product.update({ current_stock: newStock }, { transaction: t });

        await StockLedger.create({
          product_id: item.product_id,
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

    // Step 1: Reverse old stock effects (no reversal ledger entries)
    for (const oldItem of existingBill.items) {
      if (oldItem.product_id) {
        const product = await Product.findByPk(oldItem.product_id, { transaction: t });
        if (product) {
          const revStock = +((parseFloat(product.current_stock) || 0) + parseFloat(oldItem.quantity)).toFixed(2);
          await product.update({ current_stock: revStock }, { transaction: t });
        }
      }
    }

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
    if (billData.customer_id) {
      const customer = await Party.findByPk(billData.customer_id, { transaction: t });
      if (customer && !customer.credit_allowed) {
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

    for (const item of processedItems) {
      // Same pattern as create(): fetch the product once, snapshot its cost
      // onto the line, reuse for stock update. Cost is re-snapshotted on edit
      // so if the user corrects the line (e.g. fixes a wrong product on a
      // bill) the COGS follows the new product's cost — matches the user's
      // mental model of "this edit supersedes the original".
      let product = null;
      if (item.product_id) {
        product = await Product.findByPk(item.product_id, { transaction: t });
      }
      const costRate = product ? parseFloat(product.purchase_rate || 0) : 0;

      await SalesBillItem.create({
        sales_bill_id: id,
        ...item,
        cost_rate: costRate,
      }, { transaction: t });

      if (product) {
        const currentStock = parseFloat(product.current_stock) || 0;
        const newStock = +(currentStock - parseFloat(item.quantity)).toFixed(2);

        if (!allowNegStockU && newStock < 0) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for "${item.product_name || product.product_name}". Available: ${currentStock}, Requested: ${item.quantity}. Enable "Allow Negative Stock" in Module Settings to proceed.`,
          });
        }

        await product.update({ current_stock: newStock }, { transaction: t });
        await StockLedger.create({
          product_id: item.product_id, barcode: item.barcode,
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

    for (const item of bill.items) {
      if (item.product_id) {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        const newStock = +((parseFloat(product.current_stock) || 0) + parseFloat(item.quantity)).toFixed(2);
        await product.update({ current_stock: newStock }, { transaction: t });
      }
    }

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
