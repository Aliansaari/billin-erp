const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { PaymentReceipt, PaymentSplit, Party, SalesBill, PurchaseBill, Cheque } = require('../models');
const { generateTransactionNumber, sanitizePagination, safeTrailingNumber, escapeLike } = require('../utils/helpers');
const { recalculatePartyBalance, getPartyOutstanding, reconcileBillsForParty } = require('../utils/balanceHelper');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildPaymentReceiptVouchers } = require('../services/voucherBuilders');

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
    const { transaction_type, source, from_date, to_date, party_id, search } = req.query;
    // Clamp page/limit (see helpers.sanitizePagination).
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const where = { is_cancelled: false };

    if (transaction_type) where.transaction_type = transaction_type;
    // R8 Phase 2 — `source` filter lets the user see manual-entered
    // receipts/payments separately from auto-generated bill-side ones.
    // Whitelist values to avoid SQL injection via the enum cast.
    if (source && ['manual', 'auto_from_bill'].includes(source)) where.source = source;
    if (from_date && to_date) where.transaction_date = { [Op.between]: [from_date, to_date] };
    if (party_id) where.party_id = party_id;
    if (search) {
      // Audit P3-D — escape LIKE wildcards.
      where[Op.or] = [{ transaction_number: { [Op.iLike]: `%${escapeLike(search)}%` } }];
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
    //
    // Audit P2-B — advisory locks live in the Postgres CLUSTER (not the
    // database), so a single key would serialise Company A's saves against
    // Company B's saves on multi-tenant installs sharing one cluster. The
    // two-arg form pg_advisory_xact_lock(companyId, docKey) gives every
    // company its own lock space.
    const lockKey = prefix === 'PAY' ? 901 : 902;
    const companyKey = req.companyId || 0;
    await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
      replacements: { company: companyKey, key: lockKey }, transaction: t,
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

    // Audit P3-B — schema-validate bill_allocations before we trust them.
    // Pre-fix, a tampered client could POST garbage (wrong types, negative
    // amounts, unknown bill_types) and the downstream parseAllocs would
    // silently coerce / drop. Reject loudly so bugs surface during dev/QA.
    if (data.bill_allocations !== undefined && data.bill_allocations !== null) {
      if (!Array.isArray(data.bill_allocations)) {
        await t.rollback();
        return res.status(400).json({ error: 'bill_allocations must be an array.' });
      }
      for (let i = 0; i < data.bill_allocations.length; i++) {
        const a = data.bill_allocations[i];
        if (!a || typeof a !== 'object') {
          await t.rollback();
          return res.status(400).json({ error: `bill_allocations[${i}] must be an object.` });
        }
        if (!Number.isFinite(Number(a.bill_id)) || Number(a.bill_id) <= 0) {
          await t.rollback();
          return res.status(400).json({ error: `bill_allocations[${i}].bill_id must be a positive integer.` });
        }
        if (!['Sales', 'Purchase'].includes(a.bill_type)) {
          await t.rollback();
          return res.status(400).json({ error: `bill_allocations[${i}].bill_type must be 'Sales' or 'Purchase'.` });
        }
        const amt = parseFloat(a.amount);
        if (!Number.isFinite(amt) || amt < 0) {
          await t.rollback();
          return res.status(400).json({ error: `bill_allocations[${i}].amount must be a non-negative number.` });
        }
      }
    }

    // Pre-lock every bill the user is allocating against, so the remaining-balance
    // check and update below happen atomically against whatever the current row
    // state is (another cancel/receipt on the same bill can't slip in between).
    //
    // Cross-party ownership check (audit C5): each allocation's bill MUST belong
    // to the same party as the payment. Without this, a hostile client can POST
    // bill_allocations referencing a different customer's bill_id; reconcile
    // silently degrades to FIFO and the per-bill validator below leaks the
    // OTHER party's bill_number + balance in the error message.
    const allocations = data.bill_allocations || [];
    for (const alloc of allocations) {
      if (!alloc.bill_id || !alloc.amount || parseFloat(alloc.amount) <= 0) continue;
      if (alloc.bill_type === 'Sales') {
        const bill = await SalesBill.findByPk(alloc.bill_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (bill && bill.customer_id !== data.party_id) {
          await t.rollback();
          return res.status(400).json({ error: 'Bill allocation references a bill that does not belong to the selected party.' });
        }
      } else if (alloc.bill_type === 'Purchase') {
        const bill = await PurchaseBill.findByPk(alloc.bill_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (bill && bill.supplier_id !== data.party_id) {
          await t.rollback();
          return res.status(400).json({ error: 'Bill allocation references a bill that does not belong to the selected party.' });
        }
      }
    }

    // Generate transaction number — now safe because the advisory lock above
    // serializes all Payment creators (or all Receipt creators).
    const last = await PaymentReceipt.findOne({
      where: { transaction_type: data.transaction_type },
      order: [['transaction_id', 'DESC']],
      transaction: t,
    });
    const lastNum = safeTrailingNumber(last && last.transaction_number);
    data.transaction_number = generateTransactionNumber(prefix, lastNum);
    data.created_by = req.user.user_id;

    // Denormalised payment_method — drives the Mode chip in the
    // Receipts/Payments list. If the user supplied a single split,
    // that's the canonical mode; multiple distinct split modes leave
    // payment_method NULL so the UI can render "Mixed" for it.
    if (!data.payment_method && Array.isArray(splits) && splits.length > 0) {
      const distinctModes = [...new Set(splits.map((s) => s.payment_mode).filter(Boolean))];
      if (distinctModes.length === 1) data.payment_method = distinctModes[0];
    }

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

    // Audit P3-C — payment splits must sum to the receipt total. The
    // voucher builder already throws on mismatch and rolls the txn back,
    // but that error reads "split total X ≠ receipt total Y" — confusing
    // for a cashier. Catch it here with a clean message so the operator
    // can correct the split before re-saving.
    if (Array.isArray(splits) && splits.length > 0) {
      const splitSum = splits.reduce((s, sp) => s + (parseFloat(sp.amount) || 0), 0);
      if (Math.abs(splitSum - paymentAmt) > 0.01) {
        await t.rollback();
        return res.status(400).json({
          error: `Payment split total ₹${splitSum.toFixed(2)} does not match the receipt total ₹${paymentAmt.toFixed(2)}. Please adjust the split amounts.`,
          field: 'splits',
        });
      }
    }

    const payment = await PaymentReceipt.create(data, { transaction: t });

    // Create payment splits
    const createdSplits = [];
    if (splits && splits.length > 0) {
      for (const split of splits) {
        const ps = await PaymentSplit.create({
          transaction_id: payment.transaction_id,
          ...split,
        }, { transaction: t });
        createdSplits.push(ps);
      }
    }

    // ── Auto-sync to the Cheque register ─────────────────────────
    //
    // Every cheque-mode split with a cheque number becomes a Cheque
    // row so the operator has one register for every paper instrument
    // the business handles. We DO NOT post a cheque-module voucher
    // here — the payment voucher (built below by
    // buildPaymentReceiptVouchers) already moves the money. Posting
    // again would double-count.
    //
    // Status mapping mirrors the bank-reconciliation cleared_at flag:
    //   Receipt (INWARD) created → DEPOSITED  (in transit)
    //   Payment (OUTWARD) created → PENDING   (awaiting presentation)
    //
    // The Cheque row links back to the source payment + split via
    // source_payment_id / source_payment_split_id, so the register
    // can show a "from PMT-N" badge and the lifecycle UI can route
    // bounce / cancel back through the Payments page (where the
    // bill allocations and voucher reversal live).
    for (const ps of createdSplits) {
      if (ps.payment_mode !== 'Cheque' || !ps.cheque_number) continue;
      const isInward = data.transaction_type === 'Receipt';
      const chequeDate = ps.cheque_date || data.transaction_date;
      const isPdc = String(chequeDate) > String(data.transaction_date);
      // Audit C9: an INWARD PDC must NOT be auto-deposited on the
      // receipt date — its `cheque_date` is in the future, so the bank
      // ledger should not rise until the cheque physically clears.
      // Previously the auto-sync code force-set status=DEPOSITED and
      // deposit_date=transaction_date for every inward cheque, including
      // PDCs, which inflated the bank balance days/weeks before the
      // money could actually move. The cheque-controller's deposit()
      // endpoint already blocks future-dated deposits (line 532); this
      // path was bypassing that guard.
      //
      // New rule: inward non-PDC → DEPOSITED today (matches existing
      // behaviour); inward PDC → PENDING with no deposit_date (operator
      // hits Deposit on or after maturity); outward → PENDING (existing).
      const inwardImmediate = isInward && !isPdc;
      // Audit H12: previously this catch swallowed the error inside
      // the active transaction, which CAN abort the savepoint and
      // cause every subsequent statement to fail with "current
      // transaction is aborted". The user saw "saved" but the
      // cheque register was missing the row. We now ABORT the whole
      // payment transaction on cheque-sync failure — the operator
      // re-tries with a corrected cheque number rather than ending
      // up with a divergent payment-vs-cheque-register state.
      await Cheque.create({
        direction:               isInward ? 'INWARD' : 'OUTWARD',
        cheque_number:           ps.cheque_number,
        cheque_date:             chequeDate,
        amount:                  ps.amount,
        party_id:                payment.party_id,
        bank_ledger_id:          ps.bank_ledger_id,
        status:                  inwardImmediate ? 'DEPOSITED' : 'PENDING',
        is_pdc:                  isPdc,
        instrument_date:         data.transaction_date,
        deposit_date:            inwardImmediate ? data.transaction_date : null,
        source_payment_id:       payment.transaction_id,
        source_payment_split_id: ps.split_id,
        created_by:              req.user?.user_id || null,
      }, { transaction: t });
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

    // ── Double-entry posting ──
    {
      const refreshed = await PaymentReceipt.findByPk(payment.transaction_id, {
        include: [
          { model: Party, as: 'party' },
          { model: PaymentSplit, as: 'splits' },
        ],
        transaction: t,
      });
      const vouchers = await buildPaymentReceiptVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
    }

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
    // R8 Phase 2 — auto-receipts/payments are derivative of their
    // source bill. Cancelling them in isolation would break the
    // bill→receipt cascade invariant (the bill would still show
    // paid_amount > 0 but the corresponding receipt is gone). Force
    // the user to cancel/edit the source bill instead, where the
    // cascade is wired up.
    if (payment.source === 'auto_from_bill') {
      await t.rollback();
      return res.status(400).json({
        error: `This ${payment.transaction_type.toLowerCase()} was auto-generated from bill ${payment.reference_bill_number || '#' + payment.source_bill_id}. To remove it, edit or cancel the source bill (paid_amount → 0).`,
      });
    }

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

    await reverseVoucher({
      sourceType: 'payment_receipt', sourceId: payment.transaction_id,
      reason: reason || 'Payment cancelled',
      userId: req.user && req.user.user_id, transaction: t,
    });

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

// ── Update (edit) a payment / receipt ────────────────────────────────────
//
// Implemented as atomic cancel-then-recreate in a single transaction so the
// "fix the typo" workflow doesn't leave the books in a half-edited state if
// either step fails. The new payment gets a fresh transaction_number; we
// preserve the original date by default and capture the link to the original
// in `cancellation_reason` for the audit trail.
//
// Why not in-place mutation? Cheque rows, vouchers, and bill allocations
// are all derived from the original payment's data — reversing them and
// re-issuing matches the cancel + create code paths exactly, so we get the
// same correctness guarantees without a separate edit pipeline.
//
// (Audit C4 — "no edit endpoint" was rated CRITICAL because it forced
// cancel+recreate cycles through the non-idempotent reconcile bug. With
// reconcile now idempotent (audit C1/C2 fixes in balanceHelper.js), the
// cancel-and-recreate path is safe; this endpoint just makes it atomic
// and exposes a clean PUT verb to the frontend.)
exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const oldId = req.params.id;
    const original = await PaymentReceipt.findByPk(oldId, {
      transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!original) { await t.rollback(); return res.status(404).json({ error: 'Transaction not found' }); }
    if (original.is_cancelled) { await t.rollback(); return res.status(400).json({ error: 'Cannot edit a cancelled transaction; create a new one instead.' }); }
    if (original.source === 'auto_from_bill') {
      await t.rollback();
      return res.status(400).json({
        error: `This ${original.transaction_type.toLowerCase()} was auto-generated from bill ${original.reference_bill_number || '#' + original.source_bill_id}. Edit the source bill instead.`,
      });
    }

    // ── Step 1: cancel the original (mirrors exports.cancel body) ──
    await original.update({
      is_cancelled: true,
      cancelled_by: req.user?.user_id || null,
      cancelled_on: new Date(),
      cancellation_reason: `Edited (replaced by new ${original.transaction_type.toLowerCase()})`,
    }, { transaction: t });
    await reconcileBillsForParty(original.party_id, t);
    await recalculatePartyBalance(original.party_id, t);
    await reverseVoucher({
      sourceType: 'payment_receipt', sourceId: original.transaction_id,
      reason: 'Payment edited',
      userId: req.user && req.user.user_id, transaction: t,
    });

    // ── Step 2: create the replacement (mirrors exports.create body) ──
    const { splits, ...data } = req.body;
    data.transaction_type = data.transaction_type || original.transaction_type;
    data.party_id = data.party_id || original.party_id;
    const prefix = data.transaction_type === 'Payment' ? 'PAY' : 'REC';
    const lockKey = prefix === 'PAY' ? 901 : 902;
    // Audit P2-B — per-company advisory lock (see exports.create).
    const companyKey = req.companyId || 0;
    await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
      replacements: { company: companyKey, key: lockKey }, transaction: t,
    });

    const party = await Party.findByPk(data.party_id, {
      lock: t.LOCK.UPDATE, transaction: t,
    });
    if (!party) { await t.rollback(); return res.status(404).json({ error: 'Party not found' }); }

    // Cross-party ownership check (audit C5).
    const allocations = data.bill_allocations || [];
    for (const alloc of allocations) {
      if (!alloc.bill_id || !alloc.amount || parseFloat(alloc.amount) <= 0) continue;
      if (alloc.bill_type === 'Sales') {
        const bill = await SalesBill.findByPk(alloc.bill_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (bill && bill.customer_id !== data.party_id) {
          await t.rollback();
          return res.status(400).json({ error: 'Bill allocation references a bill that does not belong to the selected party.' });
        }
      } else if (alloc.bill_type === 'Purchase') {
        const bill = await PurchaseBill.findByPk(alloc.bill_id, { lock: t.LOCK.UPDATE, transaction: t });
        if (bill && bill.supplier_id !== data.party_id) {
          await t.rollback();
          return res.status(400).json({ error: 'Bill allocation references a bill that does not belong to the selected party.' });
        }
      }
    }

    const last = await PaymentReceipt.findOne({
      where: { transaction_type: data.transaction_type },
      order: [['transaction_id', 'DESC']],
      transaction: t,
    });
    const lastNum = safeTrailingNumber(last && last.transaction_number);
    data.transaction_number = generateTransactionNumber(prefix, lastNum);
    data.created_by = req.user.user_id;

    if (!data.payment_method && Array.isArray(splits) && splits.length > 0) {
      const distinctModes = [...new Set(splits.map((s) => s.payment_mode).filter(Boolean))];
      if (distinctModes.length === 1) data.payment_method = distinctModes[0];
    }

    const outstanding = await getPartyOutstanding(data.party_id, data.transaction_type, t);
    const paymentAmt  = parseFloat(data.total_amount) || 0;
    if (paymentAmt > outstanding + 0.01) {
      await t.rollback();
      const fmt = (n) => '₹' + parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      return res.status(400).json({
        error: `${data.transaction_type === 'Payment' ? 'Payment' : 'Receipt'} amount ${fmt(paymentAmt)} exceeds outstanding balance of ${fmt(outstanding)}.`,
      });
    }

    const payment = await PaymentReceipt.create(data, { transaction: t });

    const createdSplits = [];
    if (splits && splits.length > 0) {
      for (const split of splits) {
        const ps = await PaymentSplit.create({ transaction_id: payment.transaction_id, ...split }, { transaction: t });
        createdSplits.push(ps);
      }
    }

    for (const ps of createdSplits) {
      if (ps.payment_mode !== 'Cheque' || !ps.cheque_number) continue;
      const isInward = data.transaction_type === 'Receipt';
      const chequeDate = ps.cheque_date || data.transaction_date;
      const isPdc = String(chequeDate) > String(data.transaction_date);
      const inwardImmediate = isInward && !isPdc;
      await Cheque.create({
        direction: isInward ? 'INWARD' : 'OUTWARD',
        cheque_number: ps.cheque_number,
        cheque_date: chequeDate,
        amount: ps.amount,
        party_id: payment.party_id,
        bank_ledger_id: ps.bank_ledger_id,
        status: inwardImmediate ? 'DEPOSITED' : 'PENDING',
        is_pdc: isPdc,
        instrument_date: data.transaction_date,
        deposit_date: inwardImmediate ? data.transaction_date : null,
        source_payment_id: payment.transaction_id,
        source_payment_split_id: ps.split_id,
        created_by: req.user?.user_id || null,
      }, { transaction: t });
    }

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

    await reconcileBillsForParty(data.party_id, t);
    await recalculatePartyBalance(data.party_id, t);

    {
      const refreshed = await PaymentReceipt.findByPk(payment.transaction_id, {
        include: [{ model: Party, as: 'party' }, { model: PaymentSplit, as: 'splits' }],
        transaction: t,
      });
      const vouchers = await buildPaymentReceiptVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, userId: req.user && req.user.user_id, transaction: t });
      }
    }

    await t.commit();
    const result = await PaymentReceipt.findByPk(payment.transaction_id, {
      include: [{ model: Party, as: 'party' }, { model: PaymentSplit, as: 'splits' }],
    });
    res.json(result);
  } catch (error) {
    if (!t.finished) { try { await t.rollback(); } catch (_) {} }
    console.error('Update payment error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
};

exports.getUnpaidBills = async (req, res) => {
  try {
    const { party_id, type } = req.query;
    // W3: missing party_id would make Sequelize ignore the customer_id /
    // supplier_id clause and return ALL unpaid bills across all parties.
    if (!party_id) {
      return res.status(400).json({ error: 'party_id is required.' });
    }
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
