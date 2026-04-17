const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { SalesBill, SalesBillItem, Party, Product, StockLedger, SystemSettings } = require('../models');
const { generateBillNumber, roundOff, calculateGST, roundTo, sanitizePagination } = require('../utils/helpers');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');

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
      where[Op.or] = [{ bill_number: { [Op.iLike]: `%${search}%` } }];
    }

    const { count, rows } = await SalesBill.findAndCountAll({
      where,
      include: [{ model: Party, as: 'customer', attributes: ['party_name', 'mobile_1'] }],
      order: [['bill_date', 'DESC'], ['sales_bill_id', 'DESC']],
      limit,
      offset,
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

exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { items, paid_amount = 0, return_amount = 0, special_discount = 0, other_charges = 0, freight_charges = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, gst_mode, ...billData } = req.body;

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

    for (const it of processedItems) {
      const lineBase = +(it._postItemTaxable * (1 - billDiscRatio)).toFixed(2);
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
      await SalesBillItem.create({
        sales_bill_id: bill.sales_bill_id,
        ...item,
      }, { transaction: t });

      // Deduct stock
      if (item.product_id) {
        const product = await Product.findByPk(item.product_id, { transaction: t });
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

    // Recalculate customer balance from scratch
    if (billData.customer_id) {
      await recalculatePartyBalance(billData.customer_id, t);
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
    const { items: newItems, paid_amount = 0, return_amount = 0, special_discount = 0, other_charges = 0, freight_charges = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, gst_mode, ...billData } = req.body;

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

    for (const it of processedItems) {
      const lineBase = +(it._postItemTaxable * (1 - billDiscRatio2)).toFixed(2);
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
      await SalesBillItem.create({ sales_bill_id: id, ...item }, { transaction: t });

      if (item.product_id) {
        const product = await Product.findByPk(item.product_id, { transaction: t });
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
    }

    const oldCustomerId = existingBill.customer_id;
    const newCustomerId = billData.customer_id;
    if (oldCustomerId) await recalculatePartyBalance(oldCustomerId, t);
    if (newCustomerId && newCustomerId !== oldCustomerId) await recalculatePartyBalance(newCustomerId, t);

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
