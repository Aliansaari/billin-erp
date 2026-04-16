const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { SalesBill, SalesBillItem, Party, Product, StockLedger, SystemSettings } = require('../models');
const { generateBillNumber, roundOff, calculateGST } = require('../utils/helpers');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');

exports.getAll = async (req, res) => {
  try {
    const { from_date, to_date, customer_id, payment_status, search, page = 1, limit = 50 } = req.query;
    const where = { is_cancelled: false };

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (customer_id) where.customer_id = customer_id;
    if (payment_status) where.payment_status = payment_status;
    if (search) {
      where[Op.or] = [{ bill_number: { [Op.iLike]: `%${search}%` } }];
    }

    const offset = (page - 1) * limit;
    const { count, rows } = await SalesBill.findAndCountAll({
      where,
      include: [{ model: Party, as: 'customer', attributes: ['party_name', 'mobile_1'] }],
      order: [['bill_date', 'DESC'], ['sales_bill_id', 'DESC']],
      limit: parseInt(limit),
      offset,
    });

    res.json({ total: count, page: parseInt(page), limit: parseInt(limit), data: rows });
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
    const { items, paid_amount = 0, return_amount = 0, special_discount = 0, other_charges = 0, freight_charges = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, ...billData } = req.body;

    // Generate bill number using prefix from settings — inside transaction to prevent race condition
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const prefix = settings?.sales_bill_prefix?.trim() || '';
    const lastBill = await SalesBill.findOne({ order: [['sales_bill_id', 'DESC']], transaction: t });
    const lastNum = lastBill ? parseInt(lastBill.bill_number.split('-').pop()) : 0;
    billData.bill_number = generateBillNumber(prefix, lastNum);
    billData.created_by = req.user.user_id;
    billData.sales_person = billData.sales_person || req.user.user_id;

    const billWise = parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0;

    let subTotal = 0;
    let totalQty = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;

    const processedItems = [];
    for (const item of items) {
      const lineTotal = +(item.quantity * item.rate).toFixed(2);
      const discountAmt = +(lineTotal * (item.discount_percentage || 0) / 100).toFixed(2);
      const taxableAmt = +(lineTotal - discountAmt).toFixed(2);
      // In bill-wise mode item GST amounts are 0 (GST applied at bill level)
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(taxableAmt, item.gst_rate || 0);

      processedItems.push({
        ...item,
        taxable_amount: taxableAmt,
        discount_amount: discountAmt,
        cgst_amount: gst.cgst,
        sgst_amount: gst.sgst,
        igst_amount: gst.igst,
        total_amount: +(taxableAmt + gst.cgst + gst.sgst + gst.igst).toFixed(2),
      });

      subTotal += lineTotal;
      totalQty += parseFloat(item.quantity);
      if (!billWise) {
        totalCgst += gst.cgst;
        totalSgst += gst.sgst;
        totalIgst += gst.igst;
      }
    }

    // Fix: use != null so explicit 0 isn't ignored in favour of percentage
    const billDiscountAmt = billData.discount_amount != null
      ? parseFloat(billData.discount_amount)
      : +(subTotal * (billData.discount_percentage || 0) / 100).toFixed(2);
    // Fix: item-level discounts must also be subtracted from the taxable base
    const itemDiscountTotal = processedItems.reduce((s, it) => s + (parseFloat(it.discount_amount) || 0), 0);
    const taxableTotal = +(subTotal - itemDiscountTotal - billDiscountAmt).toFixed(2);

    // Bill-wise: override GST totals using the provided percentages
    if (billWise) {
      totalCgst = +(taxableTotal * parseFloat(cgst_pct) / 100).toFixed(2);
      totalSgst = +(taxableTotal * parseFloat(sgst_pct) / 100).toFixed(2);
      totalIgst = +(taxableTotal * parseFloat(igst_pct) / 100).toFixed(2);
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
    await t.rollback();
    console.error('Create sale error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { items: newItems, paid_amount = 0, return_amount = 0, special_discount = 0, other_charges = 0, freight_charges = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, ...billData } = req.body;

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

    const billWise = parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0;

    for (const item of newItems) {
      const lineTotal = +(item.quantity * item.rate).toFixed(2);
      const discountAmt = +(lineTotal * (item.discount_percentage || 0) / 100).toFixed(2);
      const taxableAmt = +(lineTotal - discountAmt).toFixed(2);
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(taxableAmt, item.gst_rate || 0);

      processedItems.push({
        ...item,
        taxable_amount: taxableAmt,
        discount_amount: discountAmt,
        cgst_amount: gst.cgst,
        sgst_amount: gst.sgst,
        igst_amount: gst.igst,
        total_amount: +(taxableAmt + gst.cgst + gst.sgst + gst.igst).toFixed(2),
      });

      subTotal += lineTotal;
      totalQty += parseFloat(item.quantity);
      if (!billWise) {
        totalCgst += gst.cgst;
        totalSgst += gst.sgst;
        totalIgst += gst.igst;
      }
    }

    const billDiscountAmt = billData.discount_amount != null
      ? parseFloat(billData.discount_amount)
      : +(subTotal * (billData.discount_percentage || 0) / 100).toFixed(2);
    const itemDiscountTotal2 = processedItems.reduce((s, it) => s + (parseFloat(it.discount_amount) || 0), 0);
    const taxableTotal = +(subTotal - itemDiscountTotal2 - billDiscountAmt).toFixed(2);

    if (billWise) {
      totalCgst = +(taxableTotal * parseFloat(cgst_pct) / 100).toFixed(2);
      totalSgst = +(taxableTotal * parseFloat(sgst_pct) / 100).toFixed(2);
      totalIgst = +(taxableTotal * parseFloat(igst_pct) / 100).toFixed(2);
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
    await t.rollback();
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

    // Fix: zero out monetary fields on the cancelled bill row so stale amounts don't pollute reports
    await bill.update({
      is_cancelled: true,
      cancelled_by: req.user.user_id,
      cancelled_date: new Date(),
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
    await t.rollback();
    console.error('Cancel sale error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
