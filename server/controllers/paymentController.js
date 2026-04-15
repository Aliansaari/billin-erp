const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { PaymentReceipt, PaymentSplit, Party, SalesBill, PurchaseBill } = require('../models');
const { generateTransactionNumber } = require('../utils/helpers');
const { recalculatePartyBalance, getPartyOutstanding, reconcileBillsForParty } = require('../utils/balanceHelper');

exports.getAll = async (req, res) => {
  try {
    const { transaction_type, from_date, to_date, party_id, search, page = 1, limit = 50 } = req.query;
    const where = { is_cancelled: false };

    if (transaction_type) where.transaction_type = transaction_type;
    if (from_date && to_date) where.transaction_date = { [Op.between]: [from_date, to_date] };
    if (party_id) where.party_id = party_id;
    if (search) {
      where[Op.or] = [{ transaction_number: { [Op.iLike]: `%${search}%` } }];
    }

    const offset = (page - 1) * limit;
    const { count, rows } = await PaymentReceipt.findAndCountAll({
      where,
      include: [
        { model: Party, as: 'party', attributes: ['party_name', 'mobile_1'] },
        { model: PaymentSplit, as: 'splits' },
      ],
      order: [['transaction_date', 'DESC'], ['transaction_id', 'DESC']],
      limit: parseInt(limit),
      offset,
    });

    res.json({ total: count, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const payment = await PaymentReceipt.findByPk(req.params.id, {
      include: [
        { model: Party, as: 'party' },
        { model: PaymentSplit, as: 'splits' },
      ],
    });
    if (!payment) return res.status(404).json({ error: 'Transaction not found' });
    res.json(payment);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { splits, ...data } = req.body;

    // Generate transaction number
    const prefix = data.transaction_type === 'Payment' ? 'PAY' : 'REC';
    const last = await PaymentReceipt.findOne({
      where: { transaction_type: data.transaction_type },
      order: [['transaction_id', 'DESC']],
    });
    const lastNum = last ? parseInt(last.transaction_number.split('-').pop()) : 0;
    data.transaction_number = generateTransactionNumber(prefix, lastNum);
    data.created_by = req.user.user_id;

    // ── Overpayment guard ─────────────────────────────────────────────────────
    // Reject if payment/receipt exceeds the party's actual outstanding balance.
    const outstanding = await getPartyOutstanding(data.party_id, data.transaction_type, t);
    const paymentAmt  = parseFloat(data.total_amount) || 0;
    if (paymentAmt > outstanding + 0.01) {          // 0.01 tolerance for rounding
      await t.rollback();
      const fmt = (n) => '₹' + parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      return res.status(400).json({
        error: `${data.transaction_type === 'Payment' ? 'Payment' : 'Receipt'} amount ${fmt(paymentAmt)} exceeds outstanding balance of ${fmt(outstanding)}. Please enter a correct amount.`,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const payment = await PaymentReceipt.create(data, { transaction: t });

    // Create payment splits
    if (splits && splits.length > 0) {
      for (const split of splits) {
        await PaymentSplit.create({
          transaction_id: payment.transaction_id,
          ...split,
        }, { transaction: t });
      }
    }

    // ── Update each bill the user allocated to (respects user's selection) ──
    const allocations = data.bill_allocations || [];
    for (const alloc of allocations) {
      if (!alloc.bill_id || !alloc.amount || parseFloat(alloc.amount) <= 0) continue;
      if (alloc.bill_type === 'Sales') {
        const bill = await SalesBill.findByPk(alloc.bill_id, { transaction: t });
        if (bill) {
          const maxBalance = +(Math.max(0, parseFloat(bill.total_amount) - parseFloat(bill.paid_amount || 0) - parseFloat(bill.return_amount || 0))).toFixed(2);
          const newBalance = +(Math.max(0, parseFloat(bill.balance_amount) - parseFloat(alloc.amount))).toFixed(2);
          const status     = newBalance <= 0 ? 'Paid' : newBalance < maxBalance ? 'Partial' : 'Unpaid';
          await bill.update({ balance_amount: newBalance, payment_status: status }, { transaction: t });
        }
      } else if (alloc.bill_type === 'Purchase') {
        const bill = await PurchaseBill.findByPk(alloc.bill_id, { transaction: t });
        if (bill) {
          const maxBalance = +(Math.max(0, parseFloat(bill.total_amount) - parseFloat(bill.paid_amount || 0))).toFixed(2);
          const newBalance = +(Math.max(0, parseFloat(bill.balance_amount) - parseFloat(alloc.amount))).toFixed(2);
          const status     = newBalance <= 0 ? 'Paid' : newBalance < maxBalance ? 'Partial' : 'Unpaid';
          await bill.update({ balance_amount: newBalance, payment_status: status }, { transaction: t });
        }
      }
    }

    // ── Recalculate party balance from scratch (independent of bill.balance_amount) ─
    await recalculatePartyBalance(data.party_id, t);

    await t.commit();

    const result = await PaymentReceipt.findByPk(payment.transaction_id, {
      include: [
        { model: Party, as: 'party' },
        { model: PaymentSplit, as: 'splits' },
      ],
    });

    res.status(201).json(result);
  } catch (error) {
    await t.rollback();
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.cancel = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const payment = await PaymentReceipt.findByPk(req.params.id, { transaction: t });
    if (!payment) { await t.rollback(); return res.status(404).json({ error: 'Transaction not found' }); }
    if (payment.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Already cancelled' }); }

    // Mark as cancelled first, then FIFO reconcile so totals are already correct
    await payment.update({ is_cancelled: true }, { transaction: t });

    // ── Rebuild all bill balances via FIFO, then recalculate party balance ───
    await reconcileBillsForParty(payment.party_id, t);
    await recalculatePartyBalance(payment.party_id, t);

    await t.commit();
    res.json({ message: 'Transaction cancelled successfully' });
  } catch (error) {
    await t.rollback();
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getUnpaidBills = async (req, res) => {
  try {
    const { party_id, type } = req.query;
    const baseWhere = { payment_status: { [Op.ne]: 'Paid' }, is_cancelled: false, balance_amount: { [Op.gt]: 0 } };

    if (type === 'Sales' || type === 'Receipt') {
      const bills = await SalesBill.findAll({
        where: { customer_id: party_id, ...baseWhere },
        attributes: ['sales_bill_id', 'bill_number', 'bill_date', 'total_amount', 'paid_amount', 'balance_amount', 'due_date'],
        order: [['bill_date', 'ASC']],
      });
      res.json(bills);
    } else {
      const bills = await PurchaseBill.findAll({
        where: { supplier_id: party_id, ...baseWhere },
        attributes: ['purchase_bill_id', 'bill_number', 'bill_date', 'total_amount', 'paid_amount', 'balance_amount', 'due_date'],
        order: [['bill_date', 'ASC']],
      });
      res.json(bills);
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};
