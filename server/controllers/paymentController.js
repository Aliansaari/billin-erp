const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { PaymentReceipt, PaymentSplit, Party, SalesBill, PurchaseBill } = require('../models');
const { generateTransactionNumber, sanitizePagination } = require('../utils/helpers');
const { recalculatePartyBalance, getPartyOutstanding, reconcileBillsForParty } = require('../utils/balanceHelper');

// Returns a best-guess preview of the next transaction number for the given
// type so the entry form can show `REC-000046` instead of "Auto-numbered"
// before Save is clicked. The real number is generated atomically inside
// the create() transaction — this endpoint does NOT claim the number, so a
// concurrent save could race past it. The UI treats this as a preview only.
//
// Filters by prefix (PAY-/REC-) so transactions imported from Tally or
// Excel (which may have non-standard numbering like "TALLY-REC-1776...")
// don't pollute the auto-increment seed.
exports.getNextNumber = async (req, res) => {
  try {
    const type = req.query.type === 'Payment' ? 'Payment' : 'Receipt';
    const prefix = type === 'Payment' ? 'PAY' : 'REC';
    const last = await PaymentReceipt.findOne({
      where: {
        transaction_type: type,
        transaction_number: { [Op.like]: `${prefix}-%` },
      },
      order: [['transaction_id', 'DESC']],
    });
    // Only take the trailing segment if it parses as an integer — avoids
    // a numeric suffix like "1776..." sneaking in from imports that happen
    // to have the same prefix.
    let lastNum = 0;
    if (last) {
      const tail = last.transaction_number.split('-').pop();
      const parsed = parseInt(tail, 10);
      if (Number.isFinite(parsed) && String(parsed) === tail) lastNum = parsed;
    }
    res.json({ next: generateTransactionNumber(prefix, lastNum) });
  } catch (error) {
    console.error('Get next transaction number error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAll = async (req, res) => {
  try {
    const { transaction_type, from_date, to_date, party_id, search } = req.query;
    // Clamp page/limit (see helpers.sanitizePagination).
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_cancelled: false };

    if (transaction_type) where.transaction_type = transaction_type;
    if (from_date && to_date) where.transaction_date = { [Op.between]: [from_date, to_date] };
    if (party_id) where.party_id = party_id;
    if (search) {
      where[Op.or] = [{ transaction_number: { [Op.iLike]: `%${search}%` } }];
    }

    const { count, rows } = await PaymentReceipt.findAndCountAll({
      where,
      include: [
        { model: Party, as: 'party', attributes: ['party_name', 'mobile_1'] },
        { model: PaymentSplit, as: 'splits' },
      ],
      order: [['transaction_date', 'DESC'], ['transaction_id', 'DESC']],
      limit,
      offset,
    });

    res.json({ total: count, page, limit, data: rows });
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
    const prefix = data.transaction_type === 'Payment' ? 'PAY' : 'REC';

    // ── Transaction number race (Fix #15) ─────────────────────────────────────
    // Two concurrent payment POSTs used to both read max(transaction_id)=N and
    // both compute N+1, producing duplicate transaction_numbers.
    // pg_advisory_xact_lock serializes concurrent writers sharing the same key;
    // the lock auto-releases on commit/rollback, so no cleanup is needed.
    // The key is stable per transaction_type (Payment ≠ Receipt) so Payment and
    // Receipt creations don't needlessly block each other.
    const lockKey = prefix === 'PAY' ? 901 : 902;
    await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
      replacements: { key: lockKey }, transaction: t,
    });

    // ── Lock the party row (Fix #16) ──────────────────────────────────────────
    // Without this, two concurrent receipts could both see outstanding=₹1000 and
    // both pass the overpayment guard — resulting in ₹2000 of receipts against
    // a ₹1000 balance. Locking the party row serializes the check.
    const party = await Party.findByPk(data.party_id, {
      lock: t.LOCK.UPDATE, transaction: t,
    });
    if (!party) {
      await t.rollback();
      return res.status(404).json({ error: 'Party not found' });
    }

    // Pre-lock every bill the user is allocating against, so the remaining-balance
    // check and update below happen atomically against whatever the current row
    // state is (another cancel/receipt on the same bill can't slip in between).
    const allocations = data.bill_allocations || [];
    for (const alloc of allocations) {
      if (!alloc.bill_id || !alloc.amount || parseFloat(alloc.amount) <= 0) continue;
      if (alloc.bill_type === 'Sales') {
        await SalesBill.findByPk(alloc.bill_id, { lock: t.LOCK.UPDATE, transaction: t });
      } else if (alloc.bill_type === 'Purchase') {
        await PurchaseBill.findByPk(alloc.bill_id, { lock: t.LOCK.UPDATE, transaction: t });
      }
    }

    // Generate transaction number — now safe because the advisory lock above
    // serializes all Payment creators (or all Receipt creators).
    const last = await PaymentReceipt.findOne({
      where: { transaction_type: data.transaction_type },
      order: [['transaction_id', 'DESC']],
      transaction: t,
    });
    const lastNum = last ? parseInt(last.transaction_number.split('-').pop()) : 0;
    data.transaction_number = generateTransactionNumber(prefix, lastNum);
    data.created_by = req.user.user_id;

    // ── Overpayment guard ─────────────────────────────────────────────────────
    // Safe to read outstanding now — party row is locked, so concurrent writers
    // are serialized behind us and can't cause a dirty read.
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

    // ── Per-bill sanity check (user's explicit allocations mustn't exceed that bill's current remaining) ──
    // We still validate each user-supplied allocation against the current bill
    // balance so the cashier gets an immediate error if they try to allocate
    // more to a single bill than it owes. The ACTUAL bill-balance updates are
    // done by reconcileBillsForParty below, which replays every non-cancelled
    // receipt/payment against the bills — that's what guarantees the "on
    // account" case (total_amount > sum(allocations)) doesn't silently drift.
    for (const alloc of allocations) {
      if (!alloc.bill_id || !alloc.amount || parseFloat(alloc.amount) <= 0) continue;
      const allocAmt = parseFloat(alloc.amount);
      const Model = alloc.bill_type === 'Sales' ? SalesBill
                  : alloc.bill_type === 'Purchase' ? PurchaseBill
                  : null;
      if (!Model) continue;
      const bill = await Model.findByPk(alloc.bill_id, { transaction: t });
      if (!bill) continue;
      const currentBalance = parseFloat(bill.balance_amount) || 0;
      if (allocAmt > currentBalance + 0.01) {
        await t.rollback();
        return res.status(400).json({
          error: `Allocation of ₹${allocAmt.toFixed(2)} for bill ${bill.bill_number} exceeds its remaining balance of ₹${currentBalance.toFixed(2)}`,
        });
      }
    }

    // ── Reconcile every bill for this party, then recompute party balance ────
    // reconcileBillsForParty honors each receipt's explicit bill_allocations
    // first, then FIFO-applies any unallocated remainder (on-account amounts)
    // to the oldest unpaid bills. This closes the bug where a cashier could
    // save a receipt whose total exceeded the sum of its allocations — the
    // party balance would drop by the full amount but only the explicitly
    // allocated bills would be reduced, leaving the bill balances stale.
    await reconcileBillsForParty(data.party_id, t);
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
    // Guard against double-rollback: early validation branches already rolled
    // back the transaction. If a subsequent `res.json(...)` call threw, a
    // second rollback would throw "Transaction cannot be rolled back because
    // it has been finished with state: rollback". The `t.finished` check —
    // which Sequelize sets to 'commit' | 'rollback' after either completes —
    // prevents that secondary error from masking the real one.
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.cancel = async (req, res) => {
  // Use SERIALIZABLE so concurrent cancels of receipts for the same party
  // can't see a half-cancelled state when they reconcile bill balances.
  const t = await sequelize.transaction();
  try {
    const payment = await PaymentReceipt.findByPk(req.params.id, {
      transaction: t,
      lock: t.LOCK.UPDATE,            // block concurrent cancels of same row
    });
    if (!payment) { await t.rollback(); return res.status(404).json({ error: 'Transaction not found' }); }
    if (payment.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Already cancelled' }); }

    const { reason } = req.body || {};

    // ── Mark as cancelled with full audit trail ───────────────────────────────
    // cancelled_by + cancelled_on let an auditor trace every reversal; the
    // reason is optional but strongly encouraged for high-value receipts.
    await payment.update({
      is_cancelled: true,
      cancelled_by: req.user?.user_id || null,
      cancelled_on: new Date(),
      cancellation_reason: reason || null,
    }, { transaction: t });

    // ── Rebuild all bill balances via FIFO, then recalculate party balance ───
    // Order matters: reconcile first so balance_amount on each bill is refreshed
    // from the now-reduced set of non-cancelled receipts, then recalc the party
    // total from total_amount (independent of balance_amount). Both functions
    // skip rows with is_cancelled=true, so the just-cancelled record is excluded.
    await reconcileBillsForParty(payment.party_id, t);
    await recalculatePartyBalance(payment.party_id, t);

    await t.commit();
    res.json({ message: 'Transaction cancelled successfully' });
  } catch (error) {
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Cancel payment error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
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
