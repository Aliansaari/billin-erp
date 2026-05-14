// ── Cheque Controller ─────────────────────────────────────────────────
//
// Endpoints (under /api/cheques):
//
//   GET    /                  — register: list with filters + KPIs
//   GET    /:cheque_id        — detail with posted ledger entries
//   POST   /                  — create (status PENDING; posts the
//                               receipt-or-issue voucher)
//   PUT    /:cheque_id        — edit (only while still PENDING). For
//                               financial fields we reverse + repost;
//                               for memo-only fields (notes etc.) we
//                               just save.
//   POST   /:cheque_id/deposit — INWARD only: PENDING → DEPOSITED.
//                                Posts the deposit voucher.
//   POST   /:cheque_id/clear   — INWARD: DEPOSITED → CLEARED (flag).
//                                OUTWARD: PENDING → CLEARED (flag for
//                                regular; posts PDC-clear voucher
//                                for post-dated).
//   POST   /:cheque_id/bounce  — Reverses every voucher posted for the
//                                cheque to date, optionally posts a
//                                bank-charges voucher.
//   POST   /:cheque_id/cancel  — Voids the cheque from any non-terminal
//                                state. Reverses every voucher posted.
//   POST   /:cheque_id/reopen  — Walks a CANCELLED cheque back to
//                                PENDING (re-posts the receipt/issue).
//                                For data-entry mistakes only.
//
// Posting and reversal go through ledgerPostingService so every event
// gets the same atomicity / append-only / paisa-balance guarantees as
// the rest of the books.
//
// Permissions: cheques.view / cheques.create / cheques.edit /
// cheques.delete — declared in routes/cheques.js, fed by rolePerms.js.

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  Cheque, Party, LedgerAccount, LedgerEntry, User, PaymentReceipt,
} = require('../models');
const {
  postInwardReceipt, postInwardDeposit,
  postOutwardIssue, postOutwardClear,
  postBounceCharges, reverseChequeVoucher,
} = require('../services/chequeService');
const { sanitizePagination } = require('../utils/helpers');
const { applyFiscalLockGuard } = require('../utils/compliance');

// All voucher source_types this module emits — the detail endpoint
// pulls live ledger entries scoped to these so the UI can show the
// posted journal alongside the cheque header.
const CHEQUE_SOURCE_TYPES = [
  'cheque_inward_receipt',
  'cheque_inward_deposit',
  'cheque_outward_issue',
  'cheque_outward_clear',
  'cheque_bounce',
];

function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

// Compute is_pdc from cheque_date vs instrument_date. A cheque dated
// later than the day it physically changed hands is post-dated.
function computeIsPdc(chequeDate, instrumentDate) {
  if (!chequeDate || !instrumentDate) return false;
  return new Date(chequeDate) > new Date(instrumentDate);
}

// Validate the body for POST/PUT. Throws a string with a user-facing
// message — caller catches and returns 400.
function validateBody(body, { isEdit = false, existing = null } = {}) {
  const out = {};
  const direction = String(body.direction || existing?.direction || '').toUpperCase();
  if (!['INWARD', 'OUTWARD'].includes(direction)) {
    throw new Error('direction must be INWARD or OUTWARD');
  }
  out.direction = direction;

  const num = String(body.cheque_number || existing?.cheque_number || '').trim();
  if (!num) throw new Error('Cheque number is required');
  if (num.length > 40) throw new Error('Cheque number is too long (max 40 chars)');
  out.cheque_number = num;

  const chequeDate = body.cheque_date || existing?.cheque_date;
  if (!chequeDate) throw new Error('Cheque date is required');
  out.cheque_date = chequeDate;

  const amount = body.amount !== undefined
    ? Number(body.amount)
    : Number(existing?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number');
  }
  out.amount = r2(amount);

  const partyId = body.party_id !== undefined ? body.party_id : existing?.party_id;
  if (!partyId) throw new Error('Party is required');
  out.party_id = parseInt(partyId, 10);

  // Bank ledger — required for OUTWARD always (we need to know which
  // of our banks the cheque was drawn on); optional for INWARD at
  // create time (we may not have decided yet which bank to deposit
  // into) but required to deposit.
  const bankId = body.bank_ledger_id !== undefined
    ? body.bank_ledger_id
    : existing?.bank_ledger_id;
  if (direction === 'OUTWARD' && !bankId) {
    throw new Error('Our bank account is required for an OUTWARD cheque');
  }
  out.bank_ledger_id = bankId ? parseInt(bankId, 10) : null;

  out.drawee_bank_name = body.drawee_bank_name !== undefined
    ? (body.drawee_bank_name ? String(body.drawee_bank_name).trim().slice(0, 120) : null)
    : (existing?.drawee_bank_name ?? null);

  out.instrument_date =
    body.instrument_date || existing?.instrument_date ||
    new Date().toISOString().slice(0, 10);

  out.notes = body.notes !== undefined
    ? (body.notes ? String(body.notes).trim() : null)
    : (existing?.notes ?? null);

  return out;
}

// Verify the party exists and matches the cheque direction. INWARD
// cheques pair with customers (or 'Both'); OUTWARD with suppliers (or
// 'Both'). The system Cash party is rejected outright — cash
// counter-sales don't use cheques.
async function loadPartyForDirection(partyId, direction, transaction) {
  const party = await Party.findByPk(partyId, { transaction });
  if (!party) throw new Error('Party not found');
  if (party.is_system_cash) throw new Error('Cheques cannot be linked to the System Cash party');
  if (direction === 'INWARD' && party.party_type === 'Supplier') {
    throw new Error('INWARD cheques must be linked to a customer (or a Both-typed party)');
  }
  if (direction === 'OUTWARD' && party.party_type === 'Customer') {
    throw new Error('OUTWARD cheques must be linked to a supplier (or a Both-typed party)');
  }
  return party;
}

// ── List / Register ────────────────────────────────────────────────
exports.list = async (req, res) => {
  try {
    const { page, limit, offset } = sanitizePagination(req.query?.page, req.query?.limit);
    const where = {};

    const direction = String(req.query.direction || '').toUpperCase();
    if (['INWARD', 'OUTWARD'].includes(direction)) where.direction = direction;

    if (req.query.status) {
      const statuses = String(req.query.status)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => ['PENDING', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'].includes(s));
      if (statuses.length > 0) where.status = { [Op.in]: statuses };
    }

    if (req.query.party_id) where.party_id = parseInt(req.query.party_id, 10);
    if (req.query.bank_id)  where.bank_ledger_id = parseInt(req.query.bank_id, 10);

    if (req.query.is_pdc !== undefined) {
      const v = String(req.query.is_pdc).toLowerCase();
      if (['true', '1', 'yes'].includes(v)) where.is_pdc = true;
      else if (['false', '0', 'no'].includes(v)) where.is_pdc = false;
    }

    if (req.query.from_date && req.query.to_date) {
      where.cheque_date = { [Op.between]: [req.query.from_date, req.query.to_date] };
    } else if (req.query.from_date) {
      where.cheque_date = { [Op.gte]: req.query.from_date };
    } else if (req.query.to_date) {
      where.cheque_date = { [Op.lte]: req.query.to_date };
    }

    if (req.query.search) {
      const s = String(req.query.search).trim();
      if (s) where.cheque_number = { [Op.iLike]: `%${s}%` };
    }

    const { count, rows } = await Cheque.findAndCountAll({
      where,
      include: [
        { model: Party, as: 'party', attributes: ['party_id', 'party_name', 'party_type'] },
        { model: LedgerAccount, as: 'bank',
          attributes: ['ledger_id', 'ledger_name', 'sub_group'] },
        // sourcePayment carries the visible PMT-N / REC-N number so
        // the register can render a "from payment" badge without a
        // second round-trip per row.
        { model: PaymentReceipt, as: 'sourcePayment',
          attributes: ['transaction_id', 'transaction_number', 'transaction_type'] },
      ],
      order: [
        // PENDING first so the operator's "to-do" pile lands at the top,
        // then DEPOSITED (in-transit) before terminal states.
        [sequelize.literal(`CASE status
          WHEN 'PENDING' THEN 1
          WHEN 'DEPOSITED' THEN 2
          WHEN 'CLEARED' THEN 3
          WHEN 'BOUNCED' THEN 4
          WHEN 'CANCELLED' THEN 5
        END`), 'ASC'],
        ['cheque_date', 'DESC'],
        ['cheque_id', 'DESC'],
      ],
      limit,
      offset,
    });

    // KPI rollup over the WHOLE matching set (not just this page) —
    // the register's KPI strip needs population-level numbers to make
    // sense. We run a second cheap aggregate query for that.
    const allWhereSql = await Cheque.findAll({
      where,
      attributes: ['direction', 'status', 'is_pdc', 'amount'],
      raw: true,
    });
    const k = {
      // Pending Inward = cheques in our drawer awaiting deposit. The
      // bookkeeper's reminder: "I have ₹X of cheques to walk to the
      // bank today." Count + ₹ value.
      pending_inward:    { count: 0, value: 0 },
      // In transit = deposited but not cleared. The reconciliation
      // funnel — bank should clear these soon.
      deposited_inward:  { count: 0, value: 0 },
      // Outward awaiting clearance: post-dated future obligations
      // (Cheques Issued PDC) + ordinary outward cheques the supplier
      // hasn't presented yet. Both are "money committed but not gone".
      outstanding_outward: { count: 0, value: 0 },
      pdc:               { count: 0, value: 0 },
      bounced:           { count: 0, value: 0 },
      total:             { count: 0, value: 0 },
    };
    for (const c of allWhereSql) {
      const amt = r2(c.amount);
      k.total.count += 1;
      k.total.value += amt;
      if (c.is_pdc && c.status !== 'CANCELLED' && c.status !== 'BOUNCED') {
        k.pdc.count += 1; k.pdc.value += amt;
      }
      if (c.status === 'BOUNCED') {
        k.bounced.count += 1; k.bounced.value += amt;
      }
      if (c.direction === 'INWARD') {
        if (c.status === 'PENDING')   { k.pending_inward.count   += 1; k.pending_inward.value   += amt; }
        if (c.status === 'DEPOSITED') { k.deposited_inward.count += 1; k.deposited_inward.value += amt; }
      } else if (c.direction === 'OUTWARD') {
        if (c.status === 'PENDING')   { k.outstanding_outward.count += 1; k.outstanding_outward.value += amt; }
      }
    }
    for (const key of Object.keys(k)) k[key].value = r2(k[key].value);

    res.json({
      total: count,
      page, limit,
      data: rows.map((row) => row.toJSON()),
      kpis: k,
    });
  } catch (err) {
    console.error('Cheque list error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Get one with posted ledger entries ─────────────────────────────
exports.getById = async (req, res) => {
  try {
    const cheque = await Cheque.findByPk(req.params.cheque_id, {
      include: [
        { model: Party, as: 'party', attributes: ['party_id', 'party_name', 'party_type'] },
        { model: LedgerAccount, as: 'bank', attributes: ['ledger_id', 'ledger_name', 'sub_group'] },
        { model: User, as: 'creator', attributes: ['user_id', 'username', 'full_name'] },
        { model: User, as: 'closer',  attributes: ['user_id', 'username', 'full_name'] },
        { model: PaymentReceipt, as: 'sourcePayment',
          attributes: ['transaction_id', 'transaction_number', 'transaction_type', 'transaction_date'] },
      ],
    });
    if (!cheque) return res.status(404).json({ error: 'Cheque not found' });

    const entries = await LedgerEntry.findAll({
      where: {
        source_type: { [Op.in]: CHEQUE_SOURCE_TYPES },
        reference_id: cheque.cheque_id,
      },
      include: [{ model: LedgerAccount, attributes: ['ledger_id', 'ledger_name', 'ledger_group', 'sub_group'] }],
      order: [['entry_id', 'ASC']],
    });

    res.json({ ...cheque.toJSON(), ledger_entries: entries });
  } catch (err) {
    console.error('Cheque getById error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Create ────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    let v;
    try { v = validateBody(req.body || {}); }
    catch (e) { await t.rollback(); return res.status(400).json({ error: e.message }); }

    const party = await loadPartyForDirection(v.party_id, v.direction, t);

    // Per-bank cheque-number duplicate guard. Soft check — same
    // cheque_number against the same bank in the same direction is
    // probably a double-entry. Other combinations are allowed (a
    // customer reusing #1001 against a different bank is fine).
    const dupWhere = {
      cheque_number: v.cheque_number,
      direction:     v.direction,
      status:        { [Op.ne]: 'CANCELLED' },
    };
    if (v.bank_ledger_id) dupWhere.bank_ledger_id = v.bank_ledger_id;
    const dup = await Cheque.findOne({ where: dupWhere, transaction: t });
    if (dup) {
      await t.rollback();
      return res.status(409).json({
        error:
          `A ${v.direction.toLowerCase()} cheque with number "${v.cheque_number}" ` +
          `already exists${v.bank_ledger_id ? ' for this bank' : ''}.`,
      });
    }

    const isPdc = computeIsPdc(v.cheque_date, v.instrument_date);
    const cheque = await Cheque.create({
      direction:        v.direction,
      cheque_number:    v.cheque_number,
      cheque_date:      v.cheque_date,
      amount:           v.amount,
      party_id:         v.party_id,
      bank_ledger_id:   v.bank_ledger_id,
      drawee_bank_name: v.drawee_bank_name,
      status:           'PENDING',
      is_pdc:           isPdc,
      instrument_date:  v.instrument_date,
      notes:            v.notes,
      created_by:       req.user?.user_id || null,
    }, { transaction: t });

    // Post the receipt-or-issue voucher.  INWARD always posts (Cheques
    // in Hand Dr / Customer Cr).  OUTWARD also posts at create — see
    // the comment in chequeService.buildOutwardIssue for the regular-
    // vs-PDC routing rationale.
    if (v.direction === 'INWARD') {
      await postInwardReceipt({ cheque, party, userId: req.user?.user_id, transaction: t });
    } else {
      await postOutwardIssue({ cheque, party, userId: req.user?.user_id, transaction: t });
    }

    await t.commit();

    const full = await Cheque.findByPk(cheque.cheque_id, {
      include: [
        { model: Party, as: 'party', attributes: ['party_id', 'party_name', 'party_type'] },
        { model: LedgerAccount, as: 'bank', attributes: ['ledger_id', 'ledger_name', 'sub_group'] },
      ],
    });
    res.status(201).json(full);
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('Cheque create error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

// ── Update ────────────────────────────────────────────────────────
//
// Edits to financial fields are only legal while PENDING; once a
// cheque has hit any later state the underlying voucher already has
// downstream entries (deposit, clearance) that depend on it. Outside
// of PENDING we accept memo-only edits (notes).
exports.update = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const cheque = await Cheque.findByPk(req.params.cheque_id, { transaction: t });
    if (!cheque) { await t.rollback(); return res.status(404).json({ error: 'Cheque not found' }); }

    const body = req.body || {};
    const isPending = cheque.status === 'PENDING';
    // Synced-from-payment cheques are owned by the Payment entry —
    // financial edits would either double-post or silently drift the
    // payment-side numbers. Always force memo-only here regardless of
    // status, and direct the operator to the Payment page for any
    // real change.
    const memoOnlyForced = !!cheque.source_payment_id;

    // Memo-only edits — allowed in any non-terminal state.
    if (!isPending || memoOnlyForced) {
      const memoUpdates = {};
      if (body.notes !== undefined) {
        memoUpdates.notes = body.notes ? String(body.notes).trim() : null;
      }
      if (body.drawee_bank_name !== undefined && cheque.direction === 'INWARD') {
        memoUpdates.drawee_bank_name = body.drawee_bank_name
          ? String(body.drawee_bank_name).trim().slice(0, 120)
          : null;
      }
      if (Object.keys(memoUpdates).length === 0) {
        await t.rollback();
        return res.status(400).json({
          error: memoOnlyForced
            ? 'This cheque was recorded from a payment — only notes can change here. Edit the source payment to alter financial details.'
            : `Cannot edit financial fields once the cheque is ${cheque.status} — only notes can change.`,
        });
      }
      await cheque.update(memoUpdates, { transaction: t });
      await t.commit();
      return res.json(await Cheque.findByPk(cheque.cheque_id));
    }

    // Full edit while PENDING — re-validate, reverse the receipt/issue
    // voucher, mutate the row, and post the fresh voucher in the same
    // transaction.
    let v;
    try { v = validateBody(body, { isEdit: true, existing: cheque.toJSON() }); }
    catch (e) { await t.rollback(); return res.status(400).json({ error: e.message }); }

    // Direction can't be flipped after creation. Allowing it would let
    // an INWARD receipt voucher silently rewrite as an OUTWARD issue
    // and put the books in a strange state. Force a delete + recreate
    // if the operator really wanted the other side.
    if (v.direction !== cheque.direction) {
      await t.rollback();
      return res.status(400).json({
        error: `Direction can't be changed (${cheque.direction} → ${v.direction}). Cancel and recreate.`,
      });
    }

    const party = await loadPartyForDirection(v.party_id, v.direction, t);

    // Same dup guard as create, but excluding self.
    if (v.cheque_number !== cheque.cheque_number || v.bank_ledger_id !== cheque.bank_ledger_id) {
      const dupWhere = {
        cheque_number: v.cheque_number,
        direction:     v.direction,
        status:        { [Op.ne]: 'CANCELLED' },
        cheque_id:     { [Op.ne]: cheque.cheque_id },
      };
      if (v.bank_ledger_id) dupWhere.bank_ledger_id = v.bank_ledger_id;
      const dup = await Cheque.findOne({ where: dupWhere, transaction: t });
      if (dup) {
        await t.rollback();
        return res.status(409).json({
          error:
            `A ${v.direction.toLowerCase()} cheque with number "${v.cheque_number}" already exists.`,
        });
      }
    }

    // Reverse the existing receipt/issue voucher.
    const issueSourceType = v.direction === 'INWARD'
      ? 'cheque_inward_receipt' : 'cheque_outward_issue';
    await reverseChequeVoucher({
      sourceType: issueSourceType, chequeId: cheque.cheque_id,
      reason: 'Cheque edited', userId: req.user?.user_id, transaction: t,
    });

    const isPdc = computeIsPdc(v.cheque_date, v.instrument_date);
    await cheque.update({
      cheque_number:    v.cheque_number,
      cheque_date:      v.cheque_date,
      amount:           v.amount,
      party_id:         v.party_id,
      bank_ledger_id:   v.bank_ledger_id,
      drawee_bank_name: v.drawee_bank_name,
      instrument_date:  v.instrument_date,
      is_pdc:           isPdc,
      notes:            v.notes,
    }, { transaction: t });
    await cheque.reload({ transaction: t });

    if (v.direction === 'INWARD') {
      await postInwardReceipt({ cheque, party, userId: req.user?.user_id, transaction: t });
    } else {
      await postOutwardIssue({ cheque, party, userId: req.user?.user_id, transaction: t });
    }

    await t.commit();
    res.json(await Cheque.findByPk(cheque.cheque_id, {
      include: [
        { model: Party, as: 'party', attributes: ['party_id', 'party_name', 'party_type'] },
        { model: LedgerAccount, as: 'bank', attributes: ['ledger_id', 'ledger_name', 'sub_group'] },
      ],
    }));
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('Cheque update error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

// ── Lifecycle: deposit (INWARD only, PENDING → DEPOSITED) ────────
exports.deposit = async (req, res) => {
  // PAY-H3 — apply fiscal-lock guard against the deposit date so a closed
  // FY can't be perturbed by a stray deposit voucher.
  const probeDate = req.body?.deposit_date || new Date().toISOString().slice(0, 10);
  const lockGuard = await applyFiscalLockGuard(req, res, probeDate);
  if (!lockGuard.ok) return;

  const t = await sequelize.transaction();
  try {
    const cheque = await Cheque.findByPk(req.params.cheque_id, { transaction: t });
    if (!cheque) { await t.rollback(); return res.status(404).json({ error: 'Cheque not found' }); }
    if (cheque.direction !== 'INWARD') {
      await t.rollback();
      return res.status(400).json({ error: 'Only INWARD cheques can be deposited' });
    }
    if (cheque.status !== 'PENDING') {
      await t.rollback();
      return res.status(400).json({ error: `Cannot deposit a ${cheque.status} cheque` });
    }
    if (cheque.source_payment_id) {
      // Synced cheque — the originating payment already posted to
      // bank, so a "deposit" here would double-count.
      await t.rollback();
      return res.status(409).json({
        error: 'Cheques recorded from a payment are already deposited; no separate deposit step is needed.',
      });
    }

    const bankId = req.body?.bank_ledger_id
      ? parseInt(req.body.bank_ledger_id, 10)
      : cheque.bank_ledger_id;
    if (!bankId) {
      await t.rollback();
      return res.status(400).json({ error: 'Bank ledger is required to deposit' });
    }
    const depositDate = req.body?.deposit_date
      || new Date().toISOString().slice(0, 10);
    // PAY-H4 — deposit_date must not predate cheque_date.
    if (cheque.cheque_date && String(depositDate) < String(cheque.cheque_date).slice(0, 10)) {
      await t.rollback();
      return res.status(400).json({
        error: `Deposit date (${depositDate}) cannot be earlier than the cheque date (${cheque.cheque_date}).`,
      });
    }

    // Block deposit of a still-post-dated cheque — the bank wouldn't
    // accept it. The operator can change the cheque_date / instrument
    // date if they need to override, but a flagged PDC shouldn't sneak
    // through into the bank ledger early.
    const today = new Date().toISOString().slice(0, 10);
    if (cheque.cheque_date > today) {
      await t.rollback();
      return res.status(400).json({
        error:
          `Cheque is post-dated (${cheque.cheque_date}). The bank won't accept it ` +
          `until then. Wait for the maturity date or edit the cheque date first.`,
      });
    }

    await cheque.update({
      bank_ledger_id: bankId,
      deposit_date:   depositDate,
      status:         'DEPOSITED',
    }, { transaction: t });
    await cheque.reload({ transaction: t });

    await postInwardDeposit({ cheque, userId: req.user?.user_id, transaction: t });

    await t.commit();
    res.json(await Cheque.findByPk(cheque.cheque_id, {
      include: [
        { model: Party, as: 'party', attributes: ['party_id', 'party_name'] },
        { model: LedgerAccount, as: 'bank', attributes: ['ledger_id', 'ledger_name'] },
      ],
    }));
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('Cheque deposit error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

// ── Lifecycle: clear ───────────────────────────────────────────────
//
//   INWARD: DEPOSITED → CLEARED. No voucher; just records the
//           bookkeeper's confirmation that the bank credited us.
//
//   OUTWARD regular: PENDING → CLEARED. No voucher; the bank already
//           debited us at issue time.
//
//   OUTWARD PDC: PENDING → CLEARED. POSTS a clearance voucher
//           (PDC liability Dr / Bank Cr) to move the obligation
//           from the holding ledger onto the bank.
exports.clear = async (req, res) => {
  // PAY-H3 — fiscal-lock guard against clearance date.
  const probeDate = req.body?.clearance_date || new Date().toISOString().slice(0, 10);
  const lockGuard = await applyFiscalLockGuard(req, res, probeDate);
  if (!lockGuard.ok) return;

  const t = await sequelize.transaction();
  try {
    const cheque = await Cheque.findByPk(req.params.cheque_id, { transaction: t });
    if (!cheque) { await t.rollback(); return res.status(404).json({ error: 'Cheque not found' }); }
    if (['CLEARED', 'BOUNCED', 'CANCELLED'].includes(cheque.status)) {
      await t.rollback();
      return res.status(400).json({ error: `Cheque is already ${cheque.status}` });
    }

    if (cheque.direction === 'INWARD' && cheque.status !== 'DEPOSITED') {
      await t.rollback();
      return res.status(400).json({
        error: 'INWARD cheques must be deposited before they can be cleared',
      });
    }

    const clearanceDate = req.body?.clearance_date
      || new Date().toISOString().slice(0, 10);

    await cheque.update({
      clearance_date: clearanceDate,
      status:         'CLEARED',
      cleared_by:     req.user?.user_id || null,
    }, { transaction: t });
    await cheque.reload({ transaction: t });

    // Synced-from-payment cheques: PDC vs regular routing doesn't
    // apply (the payment voucher already moved the money to the
    // bank, no PDC liability to discharge). Instead, propagate the
    // clearance flag to the underlying PaymentReceipt so the bank
    // statement / reconciliation screens stop showing the row as
    // uncleared.
    if (cheque.source_payment_id) {
      await PaymentReceipt.update(
        { cleared_at: new Date(clearanceDate), cleared_by: req.user?.user_id || null },
        { where: { transaction_id: cheque.source_payment_id }, transaction: t },
      );
    } else if (cheque.direction === 'OUTWARD' && cheque.is_pdc) {
      // Standalone outward PDC — post the maturity voucher
      // (PDC liability Dr / Bank Cr).
      await postOutwardClear({ cheque, userId: req.user?.user_id, transaction: t });
    }

    await t.commit();
    res.json(await Cheque.findByPk(cheque.cheque_id));
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('Cheque clear error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

// ── Lifecycle: bounce ─────────────────────────────────────────────
//
// Walks the lifecycle backwards: every voucher posted on the cheque
// to date is reversed, then (if a fee was specified) a separate
// bank-charges voucher is posted.
exports.bounce = async (req, res) => {
  // PAY-H3 — fiscal-lock guard against bounce date.
  const probeDate = req.body?.bounce_date || new Date().toISOString().slice(0, 10);
  const lockGuard = await applyFiscalLockGuard(req, res, probeDate);
  if (!lockGuard.ok) return;

  const t = await sequelize.transaction();
  try {
    const cheque = await Cheque.findByPk(req.params.cheque_id, { transaction: t });
    if (!cheque) { await t.rollback(); return res.status(404).json({ error: 'Cheque not found' }); }
    // Audit H13: previously bounce blocked status=CLEARED, leaving a
    // cleared-then-actually-bounced cheque with no programmatic
    // recovery path. Now we allow CLEARED → BOUNCED — any clearance
    // voucher (e.g. cheque_outward_clear for OUTWARD PDCs) is reversed
    // alongside the issue/receipt vouchers when bounce runs, so all
    // posted vouchers for this cheque return to zero. Terminal states
    // (BOUNCED, CANCELLED) still block.
    if (['BOUNCED', 'CANCELLED'].includes(cheque.status)) {
      await t.rollback();
      return res.status(400).json({ error: `Cheque is already ${cheque.status}` });
    }
    if (cheque.source_payment_id) {
      // Synced cheque — bouncing means voiding the payment, which has
      // bill-allocation side effects we don't want to duplicate here.
      // Send the operator to the source payment's cancel flow instead;
      // re-recording a bounce charge then becomes a regular journal
      // voucher or a fresh manual cheque.
      await t.rollback();
      return res.status(409).json({
        error:
          'This cheque was recorded from a payment. To bounce it, cancel the source payment ' +
          '(Payments page) — that reverses the bill allocations cleanly. Then post the bounce ' +
          'fee as a journal voucher if your bank charged you.',
        source_payment_id: cheque.source_payment_id,
      });
    }

    const bounceDate = req.body?.bounce_date
      || new Date().toISOString().slice(0, 10);
    const bounceReason = req.body?.bounce_reason
      ? String(req.body.bounce_reason).trim().slice(0, 255)
      : null;
    const bounceCharges = r2(req.body?.bounce_charges || 0);
    if (bounceCharges < 0) {
      await t.rollback();
      return res.status(400).json({ error: 'Bounce charges cannot be negative' });
    }
    if (bounceCharges > 0 && !cheque.bank_ledger_id) {
      await t.rollback();
      return res.status(400).json({
        error: 'Bank ledger is required to post bounce charges',
      });
    }

    // Walk back the vouchers in reverse-chronological order.
    if (cheque.direction === 'INWARD') {
      if (cheque.status === 'CLEARED' || cheque.status === 'DEPOSITED') {
        await reverseChequeVoucher({
          sourceType: 'cheque_inward_deposit', chequeId: cheque.cheque_id,
          reason: 'Cheque bounced', userId: req.user?.user_id, transaction: t,
        });
      }
      await reverseChequeVoucher({
        sourceType: 'cheque_inward_receipt', chequeId: cheque.cheque_id,
        reason: 'Cheque bounced', userId: req.user?.user_id, transaction: t,
      });
    } else {
      // Audit H13: a CLEARED outward PDC has BOTH issue + clear
      // vouchers posted. Reverse the clearance first (it sits on top),
      // then the issue voucher. Non-CLEARED outwards just need the
      // issue reversal.
      if (cheque.status === 'CLEARED') {
        await reverseChequeVoucher({
          sourceType: 'cheque_outward_clear', chequeId: cheque.cheque_id,
          reason: 'Cheque bounced after clearance', userId: req.user?.user_id, transaction: t,
        });
      }
      await reverseChequeVoucher({
        sourceType: 'cheque_outward_issue', chequeId: cheque.cheque_id,
        reason: 'Cheque bounced', userId: req.user?.user_id, transaction: t,
      });
    }

    await cheque.update({
      status:         'BOUNCED',
      bounce_date:    bounceDate,
      bounce_reason:  bounceReason,
      bounce_charges: bounceCharges,
      cleared_by:     req.user?.user_id || null,
    }, { transaction: t });
    await cheque.reload({ transaction: t });

    if (bounceCharges > 0) {
      await postBounceCharges({ cheque, userId: req.user?.user_id, transaction: t });
    }

    await t.commit();
    res.json(await Cheque.findByPk(cheque.cheque_id, {
      include: [
        { model: Party, as: 'party', attributes: ['party_id', 'party_name'] },
        { model: LedgerAccount, as: 'bank', attributes: ['ledger_id', 'ledger_name'] },
      ],
    }));
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('Cheque bounce error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

// ── Lifecycle: cancel (any non-terminal state) ────────────────────
//
// Reverses every live voucher posted on the cheque so the books snap
// back to their pre-cheque state. Used for "I entered this by
// mistake" or "the customer asked for the cheque back without it
// bouncing".
exports.cancel = async (req, res) => {
  // PAY-H3 — fiscal-lock guard against today (cancel reverses past vouchers
  // into today's date; probe today and let compliance gate trigger if today
  // falls in a locked period).
  const lockGuard = await applyFiscalLockGuard(req, res, new Date().toISOString().slice(0, 10));
  if (!lockGuard.ok) return;

  const t = await sequelize.transaction();
  try {
    const cheque = await Cheque.findByPk(req.params.cheque_id, { transaction: t });
    if (!cheque) { await t.rollback(); return res.status(404).json({ error: 'Cheque not found' }); }
    if (['CANCELLED', 'BOUNCED'].includes(cheque.status)) {
      await t.rollback();
      return res.status(400).json({ error: `Cheque is already ${cheque.status}` });
    }
    if (cheque.source_payment_id) {
      await t.rollback();
      return res.status(409).json({
        error:
          'This cheque was recorded from a payment — cancel the source payment ' +
          '(Payments page) to void it. That keeps the bill allocations consistent.',
        source_payment_id: cheque.source_payment_id,
      });
    }
    if (cheque.status === 'CLEARED') {
      // Cleared cheques are settled bookkeeping. Cancelling one would
      // re-open a paid bill. Force the operator to take the more
      // visible "BOUNCED" path or post a manual JV; cancel is reserved
      // for non-cleared mistakes.
      await t.rollback();
      return res.status(400).json({
        error: 'Cleared cheques can\'t be cancelled. Use a bounce action or post a journal voucher to reverse.',
      });
    }

    const reason = req.body?.reason
      ? String(req.body.reason).trim().slice(0, 255)
      : 'Cheque cancelled';

    // Walk back live vouchers — same order as bounce. Reversal is
    // idempotent so calling it on a stage that never posted is a
    // no-op.
    if (cheque.direction === 'INWARD') {
      if (cheque.status === 'DEPOSITED') {
        await reverseChequeVoucher({
          sourceType: 'cheque_inward_deposit', chequeId: cheque.cheque_id,
          reason, userId: req.user?.user_id, transaction: t,
        });
      }
      await reverseChequeVoucher({
        sourceType: 'cheque_inward_receipt', chequeId: cheque.cheque_id,
        reason, userId: req.user?.user_id, transaction: t,
      });
    } else {
      await reverseChequeVoucher({
        sourceType: 'cheque_outward_issue', chequeId: cheque.cheque_id,
        reason, userId: req.user?.user_id, transaction: t,
      });
    }

    await cheque.update({
      status:        'CANCELLED',
      bounce_reason: reason,
      cleared_by:    req.user?.user_id || null,
    }, { transaction: t });

    await t.commit();
    res.json(await Cheque.findByPk(cheque.cheque_id));
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('Cheque cancel error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

// ── Reopen — undo a CANCELLED cheque ─────────────────────────────
//
// Steps the cheque back to PENDING and re-posts the receipt/issue
// voucher.  Useful when the operator hit Cancel by accident; not
// available for BOUNCED (bounce is a real-world event, not a mistake)
// or CLEARED (already terminal-happy).
exports.reopen = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const cheque = await Cheque.findByPk(req.params.cheque_id, { transaction: t });
    if (!cheque) { await t.rollback(); return res.status(404).json({ error: 'Cheque not found' }); }
    if (cheque.status !== 'CANCELLED') {
      await t.rollback();
      return res.status(400).json({ error: `Only CANCELLED cheques can be reopened (current: ${cheque.status})` });
    }
    const party = await loadPartyForDirection(cheque.party_id, cheque.direction, t);

    await cheque.update({
      status: 'PENDING',
      bounce_reason: null,
      cleared_by: null,
    }, { transaction: t });
    await cheque.reload({ transaction: t });

    if (cheque.direction === 'INWARD') {
      await postInwardReceipt({ cheque, party, userId: req.user?.user_id, transaction: t });
    } else {
      await postOutwardIssue({ cheque, party, userId: req.user?.user_id, transaction: t });
    }

    await t.commit();
    res.json(await Cheque.findByPk(cheque.cheque_id));
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('Cheque reopen error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};
