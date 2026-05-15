const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { PaymentReceipt, PaymentSplit, Party, SalesBill, PurchaseBill, Cheque } = require('../models');
const { generateTransactionNumber, sanitizePagination, safeTrailingNumber, escapeLike, respondWithError } = require('../utils/helpers');
const { recalculatePartyBalance, getPartyOutstanding, reconcileBillsForParty } = require('../utils/balanceHelper');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildPaymentReceiptVouchers } = require('../services/voucherBuilders');
const { allocateForReceipt } = require('../services/billAllocationService');
const { applyFiscalLockGuard, logComplianceEvent, earlierDate } = require('../utils/compliance');

// Returns a best-guess preview of the next transaction number for the given
// type so the entry form can show `REC-000046` instead of "Auto-numbered"
// before Save is clicked. The real number is generated atomically inside
// the create() transaction — this endpoint does NOT claim the number, so a
// concurrent save could race past it. The UI treats this as a preview only.
//
// Filters by prefix (PAY-/REC-) so transactions imported from Tally or
// Excel (which may have non-standard numbering like "TALLY-REC-1776...")
// don't pollute the auto-increment seed.
// PAY-C2 — shared cheque-sync helper used by both create() and update().
// Pre-fix, create() had four hardening guards (duplicate-cheque, deactivated-
// bank, inwardImmediate-needs-bank, PENDING-without-bank) that update()
// silently dropped. Extracted here so both paths apply the same guards.
// Returns { ok: true } or { ok: false, status, body } so callers can short-
// circuit with the appropriate HTTP response.
async function syncChequesFromSplits({ splits, payment, transactionType, transactionDate, userId, t }) {
  const { LedgerAccount } = require('../models');
  for (const ps of splits) {
    if (ps.payment_mode !== 'Cheque' || !ps.cheque_number) continue;
    const isInward    = transactionType === 'Receipt';
    const chequeDate  = ps.cheque_date || transactionDate;
    const isPdc       = String(chequeDate) > String(transactionDate);
    const inwardImmediate = isInward && !isPdc && !!ps.bank_ledger_id;

    // BANK-3 — duplicate-cheque-number guard.
    if (ps.bank_ledger_id) {
      const dupCheque = await Cheque.findOne({
        where: {
          cheque_number:  ps.cheque_number,
          direction:      isInward ? 'INWARD' : 'OUTWARD',
          bank_ledger_id: ps.bank_ledger_id,
          status:         { [Op.notIn]: ['CANCELLED', 'BOUNCED'] },
        },
        transaction: t,
      });
      if (dupCheque) {
        return { ok: false, status: 400, body: {
          error: `Cheque #${ps.cheque_number} is already in the register against this bank for ${isInward ? 'inward' : 'outward'} direction. Cancel or bounce the existing row before re-using the number.`,
          code: 'DUPLICATE_CHEQUE_NUMBER',
        }};
      }
    }

    // BANK-5 — deactivated-bank guard.
    if (ps.bank_ledger_id) {
      const bank = await LedgerAccount.findByPk(ps.bank_ledger_id, { transaction: t });
      if (bank && bank.is_active === false) {
        return { ok: false, status: 400, body: {
          error: `Bank "${bank.ledger_name}" is deactivated and cannot accept new cheques. Pick an active bank.`,
          code: 'BANK_DEACTIVATED',
        }};
      }
    }

    await Cheque.create({
      direction:               isInward ? 'INWARD' : 'OUTWARD',
      cheque_number:           ps.cheque_number,
      cheque_date:             chequeDate,
      amount:                  ps.amount,
      party_id:                payment.party_id,
      bank_ledger_id:          ps.bank_ledger_id,
      status:                  inwardImmediate ? 'DEPOSITED' : 'PENDING',
      is_pdc:                  isPdc,
      instrument_date:         transactionDate,
      deposit_date:            inwardImmediate ? transactionDate : null,
      source_payment_id:       payment.transaction_id,
      source_payment_split_id: ps.split_id,
      created_by:              userId || null,
    }, { transaction: t });
  }
  return { ok: true };
}

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

    // Server-aggregated totals for the KPI strip — covers the FULL
    // filtered set (not just the current page), so the cards stay
    // accurate as the user scrolls / pages through 99k+ rows. Split by
    // transaction_type so the page can render Receipts / Payments /
    // Net independently without a second round-trip.
    const aggregates = await PaymentReceipt.findAll({
      where,
      attributes: [
        'transaction_type',
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total_amount')), 0), 'sum_amount'],
        [sequelize.fn('COUNT', sequelize.col('transaction_id')), 'count'],
      ],
      group: ['transaction_type'],
      raw: true,
    });
    const summary = {
      total_received:   0,
      total_paid:       0,
      count_received:   0,
      count_paid:       0,
    };
    for (const r of aggregates) {
      if (r.transaction_type === 'Receipt') {
        summary.total_received = parseFloat(r.sum_amount) || 0;
        summary.count_received = Number(r.count) || 0;
      } else if (r.transaction_type === 'Payment') {
        summary.total_paid     = parseFloat(r.sum_amount) || 0;
        summary.count_paid     = Number(r.count) || 0;
      }
    }
    summary.net_flow    = summary.total_received - summary.total_paid;
    summary.total_count = summary.count_received + summary.count_paid;

    res.json({ total: count, page, limit, data: rows, summary });
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
  // ── Back-dated entry policy (always-on, hard reject) ───────────────
  {
    const bd = require('../utils/backdatedGuard');
    const check = await bd.checkBackdated({
      voucherDate: req.body && req.body.transaction_date,
      user: req.user,
    });
    if (!check.ok) {
      return res.status(403).json({ error: check.reason, code: check.code });
    }
  }

  // ── Fiscal-lock guard ──────────────────────────────────────────────
  // Backdated payments / receipts touch the same ledger lines a sale
  // or purchase does, so they're held to the same compliance policy.
  // The transaction_date field is the probe. No-op when compliance off.
  const guard = await applyFiscalLockGuard(req, res, req.body?.transaction_date);
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

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
    //
    // Audit BANK-4 — must also filter by `transaction_number LIKE 'PAY-%'`
    // (or `REC-%`) for the same reason getNextNumber() already does:
    // auto-receipts from credit sales/purchases live in this table with
    // transaction_type='Receipt' but a non-numbered transaction_number
    // shaped like "1042-AR-1778779073052-04b0". Without the prefix
    // filter, that string becomes the "latest" row, safeTrailingNumber
    // (which only accepts purely-digit tails) returns 0, and the next
    // manual receipt is minted as REC-000001 — colliding with the very
    // first manual receipt ever created and trickling a duplicate-
    // number UNIQUE violation downstream.
    const last = await PaymentReceipt.findOne({
      where: {
        transaction_type: data.transaction_type,
        transaction_number: { [Op.like]: `${prefix}-%` },
      },
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
    // PAY-C2 — share the cheque-sync logic via the module helper.
    {
      const chk = await syncChequesFromSplits({
        splits: createdSplits, payment,
        transactionType: data.transaction_type,
        transactionDate: data.transaction_date,
        userId: req.user?.user_id, t,
      });
      if (!chk.ok) {
        await t.rollback();
        return res.status(chk.status).json(chk.body);
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

    // ── Persist bill_payment_allocations rows (audit B2) ─────────────────────
    // Prior to this fix, manual receipts/payments stored allocations ONLY in
    // PaymentReceipt.bill_allocations JSONB. The Bills-Outstanding report
    // (billsOutstandingController._billsList) computes effective_outstanding
    // by LEFT-LATERAL-JOINing the `bill_payment_allocations` table; if no rows
    // existed there for a manual receipt, the report would show the bill as
    // still owing despite the receipt having been recorded. Manual receipts
    // therefore overstated AR/AP by the entire post-billing receipt amount.
    //
    // We now go through allocateForReceipt with:
    //   - references = the user's explicit per-bill picks (mapped from
    //     allocations[] into bill_number form via a lookup, since
    //     allocateForReceipt is bill_number-keyed).
    //   - allowFifoFallback = false here, because reconcileBillsForParty
    //     below already handles the FIFO redistribution of any unallocated
    //     remainder against the party's open bills. Letting the allocation
    //     service also FIFO would double-apply.
    //
    // The service is idempotent on `transaction_id` so the row exists
    // exactly once; subsequent edit/cancel paths handle removal explicitly.
    if (Array.isArray(allocations) && allocations.length > 0) {
      const sidesBillType = data.transaction_type === 'Receipt' ? 'Sales' : 'Purchase';
      // Build {bill_number, amount} references by loading bill_number for
      // each allocated bill id, since allocateForReceipt is keyed by number.
      const Model = sidesBillType === 'Sales' ? SalesBill : PurchaseBill;
      const billIds = allocations
        .filter((a) => a && a.bill_id && a.bill_type === sidesBillType && parseFloat(a.amount) > 0)
        .map((a) => a.bill_id);
      const billRows = billIds.length > 0
        ? await Model.findAll({
            where: { [Model.primaryKeyAttribute]: billIds },
            attributes: [Model.primaryKeyAttribute, 'bill_number'],
            transaction: t,
          })
        : [];
      const numByPk = new Map(billRows.map((b) => [b[Model.primaryKeyAttribute], b.bill_number]));
      const references = allocations
        .filter((a) => a && a.bill_id && a.bill_type === sidesBillType && parseFloat(a.amount) > 0)
        .map((a) => ({
          bill_number: numByPk.get(a.bill_id),
          amount: parseFloat(a.amount) || 0,
        }))
        .filter((r) => r.bill_number);
      if (references.length > 0) {
        try {
          await allocateForReceipt({
            receiptId: payment.transaction_id,
            partyId: data.party_id,
            transactionType: data.transaction_type,
            asOfDate: data.transaction_date,
            totalAmount: parseFloat(data.total_amount) || 0,
            references,
            method: 'manual',
            t,
            allowFifoFallback: false,
          });
        } catch (e) {
          // Resolution failure (e.g., bill number changed mid-flight). Roll
          // back with a clear error rather than silently dropping rows.
          await t.rollback();
          return res.status(409).json({
            error: `Bill allocation failed: ${e.message}`,
            code: e.code || 'ALLOCATION_FAILED',
          });
        }
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

    // Compliance audit log — best-effort, post-commit. The voucher
    // itself is the artifact; this row tells the auditor WHO broke
    // the lock, WHEN, and WHY.
    if (guard.overrideUsed) {
      const ttype = payment.transaction_type === 'Payment' ? 'Payment' : 'Receipt';
      await logComplianceEvent({
        event_type:       lockResult.status === 'hard_override_granted' ? 'hard_override' : 'soft_override',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      ttype === 'Payment' ? 'payment' : 'receipt',
        target_id:        payment.transaction_id,
        target_label:     `${ttype} ${payment.transaction_number || `#${payment.transaction_id}`} dated ${payment.transaction_date}`,
        target_date:      payment.transaction_date,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate },
      });
    }

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
    // Audit NEW-LO-1 — route Sequelize validation / notNull / enum / FK /
    // length errors through respondWithError so the client gets an
    // actionable 400 with the offending field name, not a generic 500.
    // Pre-fix, a request missing `splits[].payment_mode` returned
    // `500 "notNull Violation: PaymentSplit.payment_mode cannot be null"`.
    return respondWithError(res, error);
  }
};

exports.cancel = async (req, res) => {
  // Pre-transaction fiscal-lock probe — same guard the create + edit
  // paths use, against the transaction's own date.
  const preview = await PaymentReceipt.findByPk(req.params.id, {
    attributes: ['transaction_id', 'transaction_date', 'transaction_number', 'transaction_type', 'is_cancelled'],
  });
  if (!preview) return res.status(404).json({ error: 'Transaction not found' });
  if (preview.is_cancelled) return res.status(400).json({ error: 'Already cancelled' });
  const cancelDate = preview.transaction_date && String(preview.transaction_date).slice(0, 10);
  const guard = await applyFiscalLockGuard(req, res, cancelDate);
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

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

    // ── Audit B2: remove bill_payment_allocations rows so the Bills-Outstanding
    // report's LATERAL alloc_total no longer counts this cancelled receipt.
    // The bill's balance_amount is restored a few lines below by
    // reconcileBillsForParty, which re-derives capacity from total - paid -
    // return on every pass.
    await sequelize.query(
      `DELETE FROM bill_payment_allocations WHERE transaction_id = :id`,
      { replacements: { id: payment.transaction_id }, transaction: t },
    );

    // Audit BANK-2 — cascade the cancellation to any Cheque row that
    // was auto-created from this payment. Pre-fix the cheque sat
    // forever in the register as DEPOSITED / PENDING even though the
    // source payment was cancelled, inflating the "In Transit" KPI
    // and blocking re-use of the cheque-number.
    try {
      await Cheque.update(
        {
          status: 'CANCELLED',
          cleared_at: new Date(),
          cleared_by: req.user?.user_id || null,
          remarks: 'Source payment cancelled',
        },
        {
          where: {
            source_payment_id: payment.transaction_id,
            status: { [Op.notIn]: ['CANCELLED', 'BOUNCED'] },
          },
          transaction: t,
        },
      );
    } catch (e) {
      console.error('[payment.cancel] Cheque cascade warn:', e.message);
    }

    // ── Audit H7: take party row lock BEFORE reconcile so concurrent cancels
    // of different receipts for the same party serialise instead of racing on
    // the bills.balance_amount snapshot. The advisory lock used in create()
    // is per-(company, voucher-type-key) — not per-party — so two cancels can
    // run side-by-side without this explicit row lock.
    await Party.findByPk(payment.party_id, { lock: t.LOCK.UPDATE, transaction: t });

    // ── Rebuild all bill balances via FIFO, then recalculate party balance ───
    // Order matters: reconcile first so balance_amount on each bill is refreshed
    // from the now-reduced set of non-cancelled receipts, then recalc the party
    // total from total_amount (independent of balance_amount). Both functions
    // skip rows with is_cancelled=true, so the just-cancelled record is excluded.
    await reconcileBillsForParty(payment.party_id, t);
    await recalculatePartyBalance(payment.party_id, t);

    // LED-H2 — reversal lands in the same period as the original payment.
    await reverseVoucher({
      sourceType: 'payment_receipt', sourceId: payment.transaction_id,
      reason: reason || 'Payment cancelled',
      userId: req.user && req.user.user_id, transaction: t,
      reversalDate: payment.transaction_date,
    });

    await t.commit();

    if (guard.overrideUsed) {
      const ttype = payment.transaction_type === 'Payment' ? 'Payment' : 'Receipt';
      await logComplianceEvent({
        event_type:       lockResult.status === 'hard_override_granted' ? 'hard_override' : 'soft_override',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      ttype === 'Payment' ? 'payment' : 'receipt',
        target_id:        payment.transaction_id,
        target_label:     `${ttype} ${payment.transaction_number || `#${payment.transaction_id}`} cancelled (was dated ${cancelDate})`,
        target_date:      cancelDate,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate, action: 'cancel' },
      });
    }

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
  // ── Back-dated entry policy (always-on, hard reject) ───────────────
  {
    const bd = require('../utils/backdatedGuard');
    const check = await bd.checkBackdated({
      voucherDate: req.body && req.body.transaction_date,
      user: req.user,
    });
    if (!check.ok) {
      return res.status(403).json({ error: check.reason, code: check.code });
    }
  }

  // ── Fiscal-lock guard on edit ──────────────────────────────────────
  // Probes the earlier of old/new transaction_date — moves out of a
  // closed period are auditable too.
  const preview = await PaymentReceipt.findByPk(req.params.id, {
    attributes: ['transaction_id', 'transaction_date', 'transaction_number', 'transaction_type', 'is_cancelled'],
  });
  if (!preview) return res.status(404).json({ error: 'Transaction not found' });
  if (preview.is_cancelled) return res.status(400).json({ error: 'Cannot edit a cancelled transaction; create a new one instead.' });
  const oldDate = preview.transaction_date && String(preview.transaction_date).slice(0, 10);
  const newDate = req.body?.transaction_date && String(req.body.transaction_date).slice(0, 10);
  const guard   = await applyFiscalLockGuard(req, res, earlierDate(oldDate, newDate));
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

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
    // Audit B2 — remove the original's allocation rows so the LATERAL alloc
    // sum on bills-outstanding doesn't credit the same money twice once the
    // replacement receipt below re-allocates.
    await sequelize.query(
      `DELETE FROM bill_payment_allocations WHERE transaction_id = :id`,
      { replacements: { id: original.transaction_id }, transaction: t },
    );
    // Audit BANK-2 — cascade-cancel the linked Cheque rows from the
    // original payment. The replacement payment will create its own
    // fresh Cheque rows below; without this cleanup, the register
    // would carry both the now-stale ones AND the new ones.
    try {
      await Cheque.update(
        {
          status: 'CANCELLED',
          cleared_at: new Date(),
          cleared_by: req.user?.user_id || null,
          remarks: 'Source payment edited',
        },
        {
          where: {
            source_payment_id: original.transaction_id,
            status: { [Op.notIn]: ['CANCELLED', 'BOUNCED'] },
          },
          transaction: t,
        },
      );
    } catch (e) {
      console.error('[payment.update] Cheque cascade warn:', e.message);
    }
    // Audit H7 — lock party row before reconcile (see exports.cancel comment).
    await Party.findByPk(original.party_id, { lock: t.LOCK.UPDATE, transaction: t });
    await reconcileBillsForParty(original.party_id, t);
    await recalculatePartyBalance(original.party_id, t);
    await reverseVoucher({
      sourceType: 'payment_receipt', sourceId: original.transaction_id,
      reason: 'Payment edited',
      userId: req.user && req.user.user_id, transaction: t,
      reversalDate: original.transaction_date,    // LED-H2
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

    // PAY-C1 — mirror the create-path's prefix filter (BANK-4). Without it,
    // an auto-receipt with a non-PAY/REC prefix (e.g. INV-0001-AR-...) that
    // happens to be the latest row makes safeTrailingNumber return 0,
    // and the new number collides with an existing REC-000001 or PAY-000001
    // → 500 UNIQUE-violation. Same bug the recent commit fixed in create;
    // the update path was missed.
    const last = await PaymentReceipt.findOne({
      where: {
        transaction_type: data.transaction_type,
        transaction_number: { [Op.like]: `${prefix}-%` },
      },
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

    // PAY-C2 — same hardened helper as create() (was previously a stripped
    // copy that bypassed the BANK-3 / BANK-5 / BANK-6 guards on edit).
    {
      const chk = await syncChequesFromSplits({
        splits: createdSplits, payment,
        transactionType: data.transaction_type,
        transactionDate: data.transaction_date,
        userId: req.user?.user_id, t,
      });
      if (!chk.ok) {
        await t.rollback();
        return res.status(chk.status).json(chk.body);
      }
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

    // ── Persist bill_payment_allocations rows (audit B2) — same as create() ──
    if (Array.isArray(allocations) && allocations.length > 0) {
      const sidesBillType = data.transaction_type === 'Receipt' ? 'Sales' : 'Purchase';
      const Model = sidesBillType === 'Sales' ? SalesBill : PurchaseBill;
      const billIds = allocations
        .filter((a) => a && a.bill_id && a.bill_type === sidesBillType && parseFloat(a.amount) > 0)
        .map((a) => a.bill_id);
      const billRows = billIds.length > 0
        ? await Model.findAll({
            where: { [Model.primaryKeyAttribute]: billIds },
            attributes: [Model.primaryKeyAttribute, 'bill_number'],
            transaction: t,
          })
        : [];
      const numByPk = new Map(billRows.map((b) => [b[Model.primaryKeyAttribute], b.bill_number]));
      const references = allocations
        .filter((a) => a && a.bill_id && a.bill_type === sidesBillType && parseFloat(a.amount) > 0)
        .map((a) => ({
          bill_number: numByPk.get(a.bill_id),
          amount: parseFloat(a.amount) || 0,
        }))
        .filter((r) => r.bill_number);
      if (references.length > 0) {
        try {
          await allocateForReceipt({
            receiptId: payment.transaction_id,
            partyId: data.party_id,
            transactionType: data.transaction_type,
            asOfDate: data.transaction_date,
            totalAmount: parseFloat(data.total_amount) || 0,
            references,
            method: 'manual',
            t,
            allowFifoFallback: false,
          });
        } catch (e) {
          await t.rollback();
          return res.status(409).json({
            error: `Bill allocation failed: ${e.message}`,
            code: e.code || 'ALLOCATION_FAILED',
          });
        }
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

    if (guard.overrideUsed) {
      const ttype = payment.transaction_type === 'Payment' ? 'Payment' : 'Receipt';
      await logComplianceEvent({
        event_type:       'post_close_edit',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      ttype === 'Payment' ? 'payment' : 'receipt',
        target_id:        payment.transaction_id,
        target_label:     `${ttype} ${payment.transaction_number || `#${payment.transaction_id}`} edited (date ${oldDate || '—'} → ${newDate || oldDate || '—'})`,
        target_date:      newDate || oldDate || null,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate, old_date: oldDate, new_date: newDate || oldDate, action: 'edit' },
      });
    }

    const result = await PaymentReceipt.findByPk(payment.transaction_id, {
      include: [{ model: Party, as: 'party' }, { model: PaymentSplit, as: 'splits' }],
    });
    res.json(result);
  } catch (error) {
    if (!t.finished) { try { await t.rollback(); } catch (_) {} }
    console.error('Update payment error:', error);
    // Audit NEW-LO-1 — mirror create-path: route through respondWithError.
    return respondWithError(res, error);
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
