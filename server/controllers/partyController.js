const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Party, SalesBill, PurchaseBill, PaymentReceipt } = require('../models');
const { recalculatePartyBalance } = require('../utils/balanceHelper');
const { sanitizePagination } = require('../utils/helpers');

// Whitelist of fields clients may send via POST/PUT. Deliberately excludes
// party_id (PK), current_balance (derived from bills + receipts), created_by,
// created_date, modified_date — columns owned by the server. Without this
// filter a malicious client could POST {"current_balance": 9999999} and
// silently rewrite their ledger.
const PARTY_UPDATABLE_FIELDS = [
  'party_type', 'party_name', 'display_name', 'mobile_1', 'mobile_2', 'email',
  'address_line_1', 'address_line_2', 'city', 'state', 'pincode', 'country',
  'gstin', 'pan_number', 'aadhar_number',
  'credit_allowed', 'credit_limit', 'credit_days',
  'opening_balance', 'opening_balance_type',
  'interest_rate', 'party_status', 'is_active',
];

exports.getAll = async (req, res) => {
  try {
    const { party_type, search, status, balance_status, sort_by, sort_order } = req.query;
    // Clamp page/limit — untrusted query params. See helpers.sanitizePagination.
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = {};

    // "Both" parties must appear when filtering by either Customer OR Supplier.
    // Prior code wrongly showed Customer+Both when filter was "Both", and hid Both parties
    // when filtering for "Customer" or "Supplier" — breaking legitimate dual-role vendors.
    if (party_type === 'Customer')      where.party_type = { [Op.in]: ['Customer', 'Both'] };
    else if (party_type === 'Supplier') where.party_type = { [Op.in]: ['Supplier', 'Both'] };
    else if (party_type === 'Both')     where.party_type = 'Both';
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

    const { count, rows } = await Party.findAndCountAll({
      where,
      order,
      limit,
      offset,
    });

    res.json({ total: count, page, limit, data: rows });
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
    // Whitelist input — don't let clients seed current_balance, party_id, or
    // tamper with created_by. Server sets created_by from the auth token, and
    // current_balance is derived from opening + transactions.
    const safe = {};
    for (const k of PARTY_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    const data = { ...safe, created_by: req.user.user_id };
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

    // Strip everything the client isn't allowed to touch — prevents attackers
    // from sending {"current_balance": 99999999} and silently rewriting ledgers.
    const safe = {};
    for (const k of PARTY_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }

    const openingChanged =
      safe.opening_balance !== undefined ||
      safe.opening_balance_type !== undefined;

    await party.update(safe);

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

    // All-time signed opening: positive = Receivable (Dr), negative = Payable (Cr)
    const signedOpening =
      (party.opening_balance_type === 'Payable' ? -1 : 1) * (parseFloat(party.opening_balance) || 0);

    // Compute the PERIOD opening balance = signed all-time opening + all transactions
    // that happened BEFORE from_date. Without this, the "Opening Balance" row at
    // the top of the ledger would show the party's original opening (from when
    // they were first added) rather than the balance that was carried into the
    // period — which is what accountants and Tally/Vyapar users expect.
    let periodOpening = signedOpening;
    if (from_date) {
      const [preSales, prePurch, prePay] = await Promise.all([
        SalesBill.sum('total_amount', {
          where: { customer_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
        }),
        PurchaseBill.sum('total_amount', {
          where: { supplier_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
        }),
        PaymentReceipt.findAll({
          where: { party_id: id, is_cancelled: false, transaction_date: { [Op.lt]: from_date } },
          attributes: ['transaction_type', 'total_amount'],
          raw: true,
        }),
      ]);
      // at-billing paid/returns for pre-period bills
      const preSalesPaid = await SalesBill.sum('paid_amount', {
        where: { customer_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
      }) || 0;
      const preSalesReturn = await SalesBill.sum('return_amount', {
        where: { customer_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
      }) || 0;
      const prePurchPaid = await PurchaseBill.sum('paid_amount', {
        where: { supplier_id: id, is_cancelled: false, bill_date: { [Op.lt]: from_date } },
      }) || 0;

      const receiptTotal = prePay.filter(p => p.transaction_type === 'Receipt')
        .reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);
      const paymentTotal = prePay.filter(p => p.transaction_type === 'Payment')
        .reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);

      periodOpening += (parseFloat(preSales  || 0) - preSalesPaid - preSalesReturn - receiptTotal);
      periodOpening -= (parseFloat(prePurch  || 0) - prePurchPaid - paymentTotal);
    }
    periodOpening = +periodOpening.toFixed(2);

    // Now build the in-period entries
    const dateFilter = {};
    if (from_date) dateFilter[Op.gte] = from_date;
    if (to_date)   dateFilter[Op.lte] = to_date;
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

    const entries = [];

    // Sales bills: full bill amount as debit; at-billing payment as credit if > 0
    sales.forEach(s => {
      entries.push({
        date: s.bill_date,
        particulars: 'Sales Bill',
        ref_number: s.bill_number,
        voucher_type: 'Sales',
        voucher_no: s.bill_number,
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
          voucher_type: 'Receipt',
          voucher_no: s.bill_number,
          debit: 0,
          credit: atBillingPaid,
          type: 'sales_initial_payment',
          id: s.sales_bill_id,
        });
      }
      const returnAmt = parseFloat(s.return_amount) || 0;
      if (returnAmt > 0) {
        entries.push({
          date: s.bill_date,
          particulars: 'Return Amount',
          ref_number: s.bill_number,
          voucher_type: 'Sales Return',
          voucher_no: s.bill_number,
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
        voucher_type: 'Purchase',
        voucher_no: p.bill_number,
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
          voucher_type: 'Payment',
          voucher_no: p.bill_number,
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
        voucher_type: isReceipt ? 'Receipt' : 'Payment',
        voucher_no: p.transaction_number,
        debit: isReceipt ? 0 : parseFloat(p.total_amount),
        credit: isReceipt ? parseFloat(p.total_amount) : 0,
        type: 'payment',
        id: p.transaction_id,
        linked_bill: p.reference_bill_id || null,
      });
    });

    const toDateStr = (d) => {
      if (!d) return '0000-00-00';
      const s = typeof d === 'string' ? d : (d instanceof Date ? d.toISOString() : String(d));
      return s.slice(0, 10);
    };

    // Strict chronological sort — dates ascending, then bill before payment on same day.
    // Guarantees a stable order independent of which query returned rows first, so the
    // running balance computed on the frontend always matches the backend's closing.
    const typeOrder = { sales: 0, purchase: 0, sales_return_amount: 1, sales_initial_payment: 2, purchase_initial_payment: 2, payment: 3 };
    entries.sort((a, b) => {
      const da = toDateStr(a.date);
      const db = toDateStr(b.date);
      if (da !== db) return da < db ? -1 : 1;
      const ta = typeOrder[a.type] ?? 9;
      const tb = typeOrder[b.type] ?? 9;
      if (ta !== tb) return ta - tb;
      // Final tie-breaker: id (stable within same type)
      return (a.id || 0) - (b.id || 0);
    });

    // Running balance starts from the period opening and reconciles to closing.
    let balance = periodOpening;
    entries.forEach(e => {
      balance = +(balance + e.debit - e.credit).toFixed(2);
      e.balance = balance;
    });

    // Return opening_balance as the signed period opening so the UI's
    // "Opening Balance" row + its client-side running-balance calc both work.
    res.json({
      party,
      opening_balance: periodOpening,
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
 * Bulk recalculate current_balance for ALL parties.
 *
 * This is the authoritative source-of-truth recalc. It mirrors
 * balanceHelper.recalculatePartyBalance exactly so single-party recalc and
 * bulk recalc never disagree.
 *
 *   balance = openingSigned
 *           + (salesTotal  - salesPaid  - salesReturn - receiptsTotal)   // receivable side
 *           - (purchTotal  - purchPaid  - paymentsTotal)                 // payable side
 *
 * Key rules:
 *  - Uses total_amount from bills, NOT balance_amount. balance_amount is a
 *    derived cache (maintained by reconcileBillsForParty) and can drift. If
 *    we summed balance_amount AND subtracted receipts, receipts would be
 *    counted twice once reconcile had run.
 *  - Counts ALL PaymentReceipts (bill-linked, split, and standalone). Every
 *    receipt reduces what the party owes, regardless of how it was allocated.
 *  - Excludes cancelled bills and cancelled receipts.
 */
exports.recalculateAll = async (req, res) => {
  try {
    await sequelize.query(`
      UPDATE parties p SET current_balance = ROUND((
        CASE WHEN p.opening_balance_type = 'Payable'
          THEN -ABS(COALESCE(p.opening_balance, 0))
          ELSE  ABS(COALESCE(p.opening_balance, 0))
        END
        + COALESCE((
            SELECT SUM(COALESCE(total_amount, 0)
                     - COALESCE(paid_amount, 0)
                     - COALESCE(return_amount, 0))
            FROM sales_bills
            WHERE customer_id = p.party_id AND is_cancelled = false
          ), 0)
        - COALESCE((
            SELECT SUM(COALESCE(total_amount, 0))
            FROM payments_receipts
            WHERE party_id = p.party_id
              AND transaction_type = 'Receipt'
              AND is_cancelled = false
          ), 0)
        - COALESCE((
            SELECT SUM(COALESCE(total_amount, 0)
                     - COALESCE(paid_amount, 0))
            FROM purchase_bills
            WHERE supplier_id = p.party_id AND is_cancelled = false
          ), 0)
        + COALESCE((
            SELECT SUM(COALESCE(total_amount, 0))
            FROM payments_receipts
            WHERE party_id = p.party_id
              AND transaction_type = 'Payment'
              AND is_cancelled = false
          ), 0)
      )::numeric, 2)
    `);
    res.json({ message: 'All party balances recalculated successfully' });
  } catch (error) {
    console.error('Recalculate all balances error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};
