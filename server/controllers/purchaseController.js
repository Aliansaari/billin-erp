const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { PurchaseBill, PurchaseBillItem, Party, Product, StockLedger, Category, SystemSettings } = require('../models');
const { generateBillNumber, roundOff, calculateGST } = require('../utils/helpers');
const { generateBarcode, findExistingProduct } = require('../utils/barcode');
const { recalculatePartyBalance } = require('../utils/balanceHelper');

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
async function resolveOrCreateProduct(item, t) {
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

  // ── Case 4: compare ALL fields if something was found ─────────────────────
  if (found) {
    const n  = (v) => +(parseFloat(v) || 0).toFixed(2);
    const s  = (v) => (v || '').toString().trim().toLowerCase();
    const allMatch =
      s(found.product_name)    === s(item.product_name) &&
      s(found.size_value)      === s(item.size) &&
      s(found.article_number)  === s(item.article_number) &&
      parseInt(found.quantity_per_box || 1) === parseInt(item.quantity_per_box || 1) &&
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

  const newBarcode = await generateBarcode();
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
  }, { transaction: t });

  return { product_id: newProduct.product_id, barcode: newBarcode, isNew: true, product: newProduct };
}

exports.getAll = async (req, res) => {
  try {
    const { from_date, to_date, supplier_id, payment_status, search, page = 1, limit = 50 } = req.query;
    const where = { is_cancelled: false };

    if (from_date && to_date) where.bill_date = { [Op.between]: [from_date, to_date] };
    if (supplier_id) where.supplier_id = supplier_id;
    if (payment_status) where.payment_status = payment_status;
    if (search) {
      where[Op.or] = [
        { bill_number: { [Op.iLike]: `%${search}%` } },
        { supplier_bill_number: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const offset = (page - 1) * limit;
    const { count, rows } = await PurchaseBill.findAndCountAll({
      where,
      include: [{ model: Party, as: 'supplier', attributes: ['party_name', 'mobile_1'] }],
      order: [['bill_date', 'DESC'], ['purchase_bill_id', 'DESC']],
      limit: parseInt(limit),
      offset,
    });

    res.json({ total: count, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (error) {
    console.error('Get purchases error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const bill = await PurchaseBill.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'supplier' },
        { model: PurchaseBillItem, as: 'items' },
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
    const { items, paid_amount = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, other_charges = 0, freight_charges = 0, ...billData } = req.body;

    // Generate bill number using prefix from settings
    const settings = await SystemSettings.findByPk(1);
    const prefix = settings?.purchase_bill_prefix?.trim() || '';
    const lastBill = await PurchaseBill.findOne({ order: [['purchase_bill_id', 'DESC']] });
    const lastNum = lastBill ? parseInt(lastBill.bill_number.split('-').pop()) : 0;
    billData.bill_number = generateBillNumber(prefix, lastNum);
    billData.created_by = req.user.user_id;

    const billWise = parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0;

    let subTotal = 0;
    let totalQty = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalCess = 0;

    const processedItems = [];

    for (const item of items) {
      const lineTotal = +(item.quantity * item.purchase_rate).toFixed(2);
      const discountAmt = +(lineTotal * (item.discount_percentage || 0) / 100).toFixed(2);
      const taxableAmt = +(lineTotal - discountAmt).toFixed(2);
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(taxableAmt, item.gst_rate || 0);

      const resolved = await resolveOrCreateProduct(item, t);
      const product_id = resolved.product_id;
      const barcode    = resolved.barcode;

      processedItems.push({
        ...item,
        product_id,
        barcode,
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

    // Bill totals
    const billDiscountAmt = billData.discount_amount || +(subTotal * (billData.discount_percentage || 0) / 100).toFixed(2);
    const taxableTotal = +(subTotal - billDiscountAmt).toFixed(2);

    if (billWise) {
      totalCgst = +(taxableTotal * parseFloat(cgst_pct) / 100).toFixed(2);
      totalSgst = +(taxableTotal * parseFloat(sgst_pct) / 100).toFixed(2);
      totalIgst = +(taxableTotal * parseFloat(igst_pct) / 100).toFixed(2);
    }

    const { roundedAmount, roundOffValue } = roundOff(
      taxableTotal + totalCgst + totalSgst + totalIgst + totalCess
      + parseFloat(other_charges || 0)
      + parseFloat(freight_charges || 0)
    );

    const totalAmount = roundedAmount;
    const balanceAmount = +(totalAmount - paid_amount).toFixed(2);
    let paymentStatus = 'Unpaid';
    if (paid_amount >= totalAmount) paymentStatus = 'Paid';
    else if (paid_amount > 0) paymentStatus = 'Partial';

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
      paid_amount,
      balance_amount: balanceAmount,
      payment_status: paymentStatus,
    }, { transaction: t });

    for (const item of processedItems) {
      await PurchaseBillItem.create({
        purchase_bill_id: bill.purchase_bill_id,
        ...item,
      }, { transaction: t });

      // Update product stock and latest rates
      if (item.product_id) {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        const newStock = +((parseFloat(product.current_stock) || 0) + parseFloat(item.quantity)).toFixed(2);
        await product.update({
          current_stock: newStock,
          purchase_rate: item.purchase_rate,
          margin_percentage: item.margin_percentage || product.margin_percentage,
          sale_rate: item.sale_rate || product.sale_rate,
          mrp: item.mrp || product.mrp,
        }, { transaction: t });

        await StockLedger.create({
          product_id: item.product_id,
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
    await t.rollback();
    console.error('Create purchase error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { items: newItems, paid_amount = 0, cgst_pct = 0, sgst_pct = 0, igst_pct = 0, other_charges = 0, freight_charges = 0, ...billData } = req.body;

    const existingBill = await PurchaseBill.findByPk(id, {
      include: [{ model: PurchaseBillItem, as: 'items' }],
      transaction: t,
    });
    if (!existingBill) { await t.rollback(); return res.status(404).json({ error: 'Bill not found' }); }
    if (existingBill.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Cannot edit a cancelled bill' }); }

    // ── Step 1: Reverse old stock effects (no reversal ledger entries) ───────
    const settings2 = await SystemSettings.findByPk(1, { transaction: t });
    const allowNeg2 = settings2?.allow_negative_stock || false;

    for (const oldItem of existingBill.items) {
      if (oldItem.product_id) {
        const product = await Product.findByPk(oldItem.product_id, { transaction: t });
        if (product) {
          const revStock = +(parseFloat(product.current_stock) - parseFloat(oldItem.quantity)).toFixed(2);
          await product.update({ current_stock: allowNeg2 ? revStock : Math.max(0, revStock) }, { transaction: t });
        }
      }
    }

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

    const billWise = parseFloat(cgst_pct) > 0 || parseFloat(sgst_pct) > 0 || parseFloat(igst_pct) > 0;

    for (const item of newItems) {
      const lineTotal = +(item.quantity * item.purchase_rate).toFixed(2);
      const discountAmt = +(lineTotal * (item.discount_percentage || 0) / 100).toFixed(2);
      const taxableAmt = +(lineTotal - discountAmt).toFixed(2);
      const gst = billWise ? { cgst: 0, sgst: 0, igst: 0, cess: 0 } : calculateGST(taxableAmt, item.gst_rate || 0);

      const resolved = await resolveOrCreateProduct(item, t);
      const product_id = resolved.product_id;
      const barcode    = resolved.barcode;

      processedItems.push({
        ...item, product_id, barcode, taxable_amount: taxableAmt, discount_amount: discountAmt,
        cgst_amount: gst.cgst, sgst_amount: gst.sgst, igst_amount: gst.igst,
        total_amount: +(taxableAmt + gst.cgst + gst.sgst + gst.igst).toFixed(2),
      });

      subTotal += lineTotal; totalQty += parseFloat(item.quantity);
      if (!billWise) {
        totalCgst += gst.cgst; totalSgst += gst.sgst; totalIgst += gst.igst;
      }
    }

    const billDiscountAmt = billData.discount_amount || +(subTotal * (billData.discount_percentage || 0) / 100).toFixed(2);
    const taxableTotal = +(subTotal - billDiscountAmt).toFixed(2);

    if (billWise) {
      totalCgst = +(taxableTotal * parseFloat(cgst_pct) / 100).toFixed(2);
      totalSgst = +(taxableTotal * parseFloat(sgst_pct) / 100).toFixed(2);
      totalIgst = +(taxableTotal * parseFloat(igst_pct) / 100).toFixed(2);
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

    // ── Step 5: Update bill record ─────────────────────────────────────────
    await existingBill.update({
      supplier_id: billData.supplier_id || existingBill.supplier_id,
      bill_date: billData.bill_date || existingBill.bill_date,
      due_date: billData.due_date || null,
      supplier_bill_number: billData.supplier_bill_number || null,
      transport_name: billData.transport_name || null,
      vehicle_number: billData.vehicle_number || null,
      lr_number: billData.lr_number || null,
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
    for (const item of processedItems) {
      await PurchaseBillItem.create({ purchase_bill_id: id, ...item }, { transaction: t });
      if (item.product_id) {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        const newStock = +((parseFloat(product.current_stock) || 0) + parseFloat(item.quantity)).toFixed(2);
        await product.update({
          current_stock: newStock, purchase_rate: item.purchase_rate,
          margin_percentage: item.margin_percentage || product.margin_percentage,
          sale_rate: item.sale_rate || product.sale_rate,
          mrp: item.mrp || product.mrp,
        }, { transaction: t });
        await StockLedger.create({
          product_id: item.product_id, barcode: item.barcode,
          transaction_type: 'Purchase',
          transaction_date: billData.bill_date || existingBill.bill_date,
          reference_id: id, reference_number: existingBill.bill_number,
          quantity_in: item.quantity, quantity_out: 0,
          rate: item.purchase_rate, balance_quantity: newStock,
          created_by: req.user.user_id,
        }, { transaction: t });
      }
    }

    // ── Step 7: Recalculate supplier balance from scratch ──────────────────
    const newSupplierId = billData.supplier_id || existingBill.supplier_id;
    await recalculatePartyBalance(newSupplierId, t);
    // If supplier changed, also recalculate the old one
    if (billData.supplier_id && billData.supplier_id !== existingBill.supplier_id) {
      await recalculatePartyBalance(existingBill.supplier_id, t);
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
    await t.rollback();
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

    // Block cancellation if any product in this bill has been sold
    for (const item of bill.items) {
      if (item.product_id) {
        const salesCount = await StockLedger.count({
          where: { product_id: item.product_id, transaction_type: 'Sales' },
          transaction: t,
        });
        if (salesCount > 0) {
          const prod = await Product.findByPk(item.product_id, { transaction: t });
          await t.rollback();
          return res.status(400).json({
            error: `Cannot cancel this purchase bill — "${prod.product_name}" has ${salesCount} sales transaction(s). Cancelling would create invalid negative stock. Create a Purchase Return instead.`,
          });
        }
      }
    }

    // Get negative stock setting
    const settings = await SystemSettings.findByPk(1, { transaction: t });
    const allowNegativeStock = settings?.allow_negative_stock || false;

    for (const item of bill.items) {
      if (item.product_id) {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        const newStock = +((parseFloat(product.current_stock) || 0) - parseFloat(item.quantity)).toFixed(2);
        await product.update({
          current_stock: allowNegativeStock ? newStock : Math.max(0, newStock),
        }, { transaction: t });
      }
    }

    // Remove stock ledger entries for this bill (bill is gone, so entries should be gone too)
    await StockLedger.destroy({
      where: { reference_id: bill.purchase_bill_id, transaction_type: 'Purchase' },
      transaction: t,
    });

    await bill.update({
      is_cancelled: true,
      cancelled_by: req.user.user_id,
      cancelled_date: new Date(),
    }, { transaction: t });

    // Recalculate supplier balance after cancel
    await recalculatePartyBalance(bill.supplier_id, t);

    await t.commit();
    res.json({ message: 'Bill cancelled successfully' });
  } catch (error) {
    await t.rollback();
    console.error('Cancel purchase error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
