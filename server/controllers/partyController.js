const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Party, SalesBill, PurchaseBill, PaymentReceipt } = require('../models');
const { recalculatePartyBalance } = require('../utils/balanceHelper');

exports.getAll = async (req, res) => {
  try {
    const { party_type, search, status, balance_status, sort_by, sort_order, page = 1, limit = 50 } = req.query;
    const where = {};

    if (party_type) where.party_type = party_type === 'Both' ? { [Op.in]: ['Customer', 'Both'] } : party_type;
    if (status) where.party_status = status;
    if (search) {
      where[Op.or] = [
        { party_name: { [Op.iLike]: `%${search}%` } },
        { mobile_1: { [Op.like]: `%${search}%` } },
        { mobile_2: { [Op.like]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (balance_status === 'Receivable') where.current_balance = { [Op.gt]: 0 };
    if (balance_status === 'Payable') where.current_balance = { [Op.lt]: 0 };
    if (balance_status === 'NoDues') where.current_balance = 0;

    const order = [];
    if (sort_by) {
      order.push([sort_by, sort_order || 'ASC']);
    } else {
      order.push(['party_name', 'ASC']);
    }

    const offset = (page - 1) * limit;
    const { count, rows } = await Party.findAndCountAll({
      where,
      order,
      limit: parseInt(limit),
      offset,
    });

    res.json({ total: count, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (error) {
    console.error('Get parties error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const party = await Party.findByPk(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });
    res.json(party);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const data = { ...req.body, created_by: req.user.user_id };
    if (data.opening_balance) {
      data.current_balance = data.opening_balance_type === 'Payable'
        ? -Math.abs(data.opening_balance)
        : Math.abs(data.opening_balance);
    }
    const party = await Party.create(data);
    res.status(201).json(party);
  } catch (error) {
    console.error('Create party error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Party with this information already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const party = await Party.findByPk(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    const openingChanged =
      req.body.opening_balance !== undefined ||
      req.body.opening_balance_type !== undefined;

    await party.update(req.body);

    // If opening balance was edited, recalculate current_balance from scratch
    if (openingChanged) {
      await recalculatePartyBalance(party.party_id);
      await party.reload();
    }

    res.json(party);
  } catch (error) {
    console.error('Update party error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.toggleActive = async (req, res) => {
  try {
    const party = await Party.findByPk(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });
    await party.update({ is_active: !party.is_active });
    res.json(party);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.delete = async (req, res) => {
  try {
    const party = await Party.findByPk(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    const salesCount    = await SalesBill.count({ where: { customer_id: party.party_id } });
    const purchaseCount = await PurchaseBill.count({ where: { supplier_id: party.party_id } });
    const paymentCount  = await PaymentReceipt.count({ where: { party_id: party.party_id } });
    const total = salesCount + purchaseCount + paymentCount;

    if (total > 0) {
      return res.status(400).json({
        error: `Cannot delete: this party has ${total} transaction(s) linked to them.`,
        canDeactivate: true,
        transactionCount: total,
      });
    }

    await party.destroy();
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete party error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getLedger = async (req, res) => {
  try {
    const { id } = req.params;
    const { from_date, to_date } = req.query;
    const party = await Party.findByPk(id);
    if (!party) return res.status(404).json({ error: 'Party not found' });

    // Recalculate balance to ensure it's accurate before returning
    await recalculatePartyBalance(id);
    await party.reload();

    const dateFilter = {};
    if (from_date) dateFilter[Op.gte] = from_date;
    if (to_date) dateFilter[Op.lte] = to_date;
    // NOTE: Op.gte/Op.lte are Symbols — Object.keys() skips them, so use (from_date || to_date) instead
    const dateWhere = (from_date || to_date) ? dateFilter : undefined;

    const sales = await SalesBill.findAll({
      where: { customer_id: id, is_cancelled: false, ...(dateWhere && { bill_date: dateWhere }) },
      order: [['bill_date', 'ASC'], ['sales_bill_id', 'ASC']],
    });

    const purchases = await PurchaseBill.findAll({
      where: { supplier_id: id, is_cancelled: false, ...(dateWhere && { bill_date: dateWhere }) },
      order: [['bill_date', 'ASC'], ['purchase_bill_id', 'ASC']],
    });

    const payments = await PaymentReceipt.findAll({
      where: { party_id: id, is_cancelled: false, ...(dateWhere && { transaction_date: dateWhere }) },
      order: [['transaction_date', 'ASC'], ['transaction_id', 'ASC']],
    });

    // No linked-payment map needed: paid_amount on the bill is the at-billing payment
    // (stored directly on the bill, never as a PaymentReceipt). Linked receipts are
    // separate transactions already shown as "Receipt"/"Payment" entries — no double-counting.

    // Build ledger entries
    const entries = [];

    // Opening balance entry
    const rawOpening = parseFloat(party.opening_balance) || 0;
    entries.push({
      date: party.created_date || new Date().toISOString().slice(0, 10),
      particulars: 'Opening Balance',
      ref_number: '-',
      debit: party.opening_balance_type === 'Receivable' ? rawOpening : 0,
      credit: party.opening_balance_type === 'Payable' ? rawOpening : 0,
      type: 'opening',
    });

    // Sales bills: full bill amount as debit; at-billing payment as credit if > 0
    sales.forEach(s => {
      entries.push({
        date: s.bill_date,
        particulars: 'Sales Bill',
        ref_number: s.bill_number,
        debit: parseFloat(s.total_amount),
        credit: 0,
        type: 'sales',
        id: s.sales_bill_id,
      });
      const atBillingPaid = parseFloat(s.paid_amount) || 0;
      if (atBillingPaid > 0) {
        entries.push({
          date: s.bill_date,
          particulars: 'Payment at Billing',
          ref_number: s.bill_number,
          debit: 0,
          credit: atBillingPaid,
          type: 'sales_initial_payment',
          id: s.sales_bill_id,
        });
      }
      // return amount — reduces outstanding balance
      const returnAmt = parseFloat(s.return_amount) || 0;
      if (returnAmt > 0) {
        entries.push({
          date: s.bill_date,
          particulars: 'Return Amount',
          ref_number: s.bill_number,
          debit: 0,
          credit: returnAmt,
          type: 'sales_return_amount',
          id: s.sales_bill_id,
        });
      }
    });

    // Purchase bills: full amount as credit; at-billing payment as debit if > 0
    purchases.forEach(p => {
      entries.push({
        date: p.bill_date,
        particulars: 'Purchase Bill',
        ref_number: p.bill_number,
        debit: 0,
        credit: parseFloat(p.total_amount),
        type: 'purchase',
        id: p.purchase_bill_id,
      });
      const atBillingPaid = parseFloat(p.paid_amount) || 0;
      if (atBillingPaid > 0) {
        entries.push({
          date: p.bill_date,
          particulars: 'Payment at Billing',
          ref_number: p.bill_number,
          debit: atBillingPaid,
          credit: 0,
          type: 'purchase_initial_payment',
          id: p.purchase_bill_id,
        });
      }
    });

    // Payment/Receipt records (both bill-linked and standalone)
    payments.forEach(p => {
      const isReceipt = p.transaction_type === 'Receipt';
      entries.push({
        date: p.transaction_date,
        particulars: isReceipt ? 'Receipt' : 'Payment',
        ref_number: p.transaction_number,
        debit: isReceipt ? 0 : parseFloat(p.total_amount),
        credit: isReceipt ? parseFloat(p.total_amount) : 0,
        type: 'payment',
        id: p.transaction_id,
        linked_bill: p.reference_bill_id || null,
      });
    });

    // Normalize any date to YYYY-MM-DD string to avoid timestamp vs date string comparison issues
    const toDateStr = (d) => {
      if (!d) return '0000-00-00';
      const s = typeof d === 'string' ? d : (d instanceof Date ? d.toISOString() : String(d));
      return s.slice(0, 10);
    };

    // Sort: opening always first, then chronological, then bill before payment on same day
    const typeOrder = { sales: 0, purchase: 0, sales_initial_payment: 1, purchase_initial_payment: 1, payment: 2 };
    entries.sort((a, b) => {
      if (a.type === 'opening') return -1;
      if (b.type === 'opening') return 1;
      const da = toDateStr(a.date);
      const db = toDateStr(b.date);
      if (da < db) return -1;
      if (da > db) return 1;
      return (typeOrder[a.type] || 0) - (typeOrder[b.type] || 0);
    });

    // Calculate running balance (positive = receivable, negative = payable)
    let balance = 0;
    entries.forEach(e => {
      balance = +(balance + e.debit - e.credit).toFixed(2);
      e.balance = balance;
    });

    res.json({
      party,
      entries,
      closing_balance: balance,
      total_debit: +entries.reduce((sum, e) => sum + e.debit, 0).toFixed(2),
      total_credit: +entries.reduce((sum, e) => sum + e.credit, 0).toFixed(2),
    });
  } catch (error) {
    console.error('Get ledger error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getCustomers = async (req, res) => {
  req.query.party_type = 'Customer';
  return exports.getAll(req, res);
};

exports.getSuppliers = async (req, res) => {
  req.query.party_type = 'Supplier';
  return exports.getAll(req, res);
};

/**
 * Bulk recalculate current_balance for ALL parties using a single SQL UPDATE.
 * This corrects any drift caused by manual edits, cancellations, or historical issues.
 */
exports.recalculateAll = async (req, res) => {
  try {
    await sequelize.query(`
      UPDATE parties SET current_balance = (
        CASE WHEN opening_balance_type = 'Payable'
          THEN -ABS(COALESCE(opening_balance, 0))
          ELSE ABS(COALESCE(opening_balance, 0))
        END
        + COALESCE((
            SELECT SUM(balance_amount) FROM sales_bills
            WHERE customer_id = parties.party_id AND is_cancelled = false
          ), 0)
        - COALESCE((
            SELECT SUM(total_amount) FROM payments_receipts
            WHERE party_id = parties.party_id
              AND transaction_type = 'Receipt'
              AND is_cancelled = false
              AND reference_bill_id IS NULL
          ), 0)
        - COALESCE((
            SELECT SUM(balance_amount) FROM purchase_bills
            WHERE supplier_id = parties.party_id AND is_cancelled = false
          ), 0)
        + COALESCE((
            SELECT SUM(total_amount) FROM payments_receipts
            WHERE party_id = parties.party_id
              AND transaction_type = 'Payment'
              AND is_cancelled = false
              AND reference_bill_id IS NULL
          ), 0)
      )
    `);
    res.json({ message: 'All party balances recalculated successfully' });
  } catch (error) {
    console.error('Recalculate all balances error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};
