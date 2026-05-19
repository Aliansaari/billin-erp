// ── Journal Voucher Controller ──────────────────────────────────────────
//
// Manual Dr/Cr entry. Each voucher has a header row in journal_vouchers
// and N legs in ledger_entries linked via source_type='journal_voucher'.
// All posting / reversal goes through ledgerPostingService — same
// atomicity, idempotency, and reversal rules as bills.
//
// CRUD endpoints:
//   GET    /api/journal-vouchers           — list (paginated)
//   GET    /api/journal-vouchers/:id       — detail with legs
//   POST   /api/journal-vouchers           — create
//   PUT    /api/journal-vouchers/:id       — edit (reverse + repost)
//   DELETE /api/journal-vouchers/:id       — soft delete (mark reversed,
//                                            insert mirror entries)
//
// Each line in the request body: { ledger_id, debit, credit, party_id?, narration? }

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { JournalVoucher, LedgerEntry, LedgerAccount } = require('../models');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { sanitizePagination, roundTo, respondWithError } = require('../utils/helpers');
const { applyFiscalLockGuard, logComplianceEvent, earlierDate } = require('../utils/compliance');

function nextVoucherNumberPrefix(date) {
  const d = new Date(date);
  return `JV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function nextVoucherNumber(date, transaction) {
  const prefix = nextVoucherNumberPrefix(date);
  const last = await JournalVoucher.findOne({
    where: { voucher_number: { [Op.like]: `${prefix}-%` } },
    order: [['id', 'DESC']],
    transaction,
  });
  let seq = 1;
  if (last && last.voucher_number) {
    const m = last.voucher_number.match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

exports.getAll = async (req, res) => {
  try {
    const { page, limit, offset } = sanitizePagination(req.query);
    const { from_date, to_date, q } = req.query || {};
    const where = {};
    if (from_date && to_date) where.voucher_date = { [Op.between]: [from_date, to_date] };
    if (q) where.narration = { [Op.iLike]: `%${q}%` };

    const { count, rows } = await JournalVoucher.findAndCountAll({
      where,
      order: [['voucher_date', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
    });
    res.json({ total: count, page, limit, data: rows });
  } catch (err) {
    console.error('JV getAll error:', err);
    respondWithError(res, err);
  }
};

exports.getById = async (req, res) => {
  try {
    const jv = await JournalVoucher.findByPk(req.params.id);
    if (!jv) return res.status(404).json({ error: 'Voucher not found' });
    const legs = await LedgerEntry.findAll({
      where: { source_type: 'journal_voucher', reference_id: jv.id },
      include: [{ model: LedgerAccount, attributes: ['ledger_id', 'ledger_name', 'ledger_group', 'sub_group'] }],
      order: [['entry_id', 'ASC']],
    });
    res.json({ ...jv.toJSON(), lines: legs });
  } catch (err) {
    console.error('JV getById error:', err);
    respondWithError(res, err);
  }
};

function normalizeLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length < 2) {
    throw new Error('At least 2 lines required.');
  }
  const lines = rawLines.map((ln, i) => {
    // LED-H4 — apply `roundTo` (round-half-away-from-zero, Indian GST-standard)
    // BEFORE the unbalanced check. Pre-fix, raw float inputs like
    // 100.005 + 100.005 from a JSON client could pass the sum check
    // (identical floats) but then `Math.round` in postVoucher's toAmount
    // rounded one half-paisa banker's-style and the other away-from-zero,
    // landing the legs unbalanced server-side.
    const debit  = roundTo(Number(ln.debit  || 0), 2);
    const credit = roundTo(Number(ln.credit || 0), 2);
    if (!ln.ledger_id) throw new Error(`Line ${i + 1}: ledger is required.`);
    if (debit < 0 || credit < 0) throw new Error(`Line ${i + 1}: amounts must be non-negative.`);
    if (debit > 0 && credit > 0) throw new Error(`Line ${i + 1}: debit and credit can't both be > 0.`);
    if (debit === 0 && credit === 0) throw new Error(`Line ${i + 1}: amount required.`);
    return { ledgerAccountId: Number(ln.ledger_id), debit, credit, partyId: ln.party_id || null };
  });
  // SER-9: early balance check so we return 400 before opening a transaction.
  const dr = lines.reduce((s, l) => s + l.debit,  0);
  const cr = lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(dr - cr) > 0.005) {
    throw new Error(`Journal is unbalanced — debits ${dr.toFixed(2)} ≠ credits ${cr.toFixed(2)}.`);
  }
  return lines;
}

exports.create = async (req, res) => {
  // ── Back-dated entry policy (always-on, hard reject) ───────────────
  {
    const bd = require('../utils/backdatedGuard');
    const check = await bd.checkBackdated({
      voucherDate: req.body && req.body.voucher_date,
      user: req.user,
    });
    if (!check.ok) {
      return res.status(403).json({ error: check.reason, code: check.code });
    }
  }

  // ── Fiscal-lock guard ──────────────────────────────────────────────
  // voucher_date is the probe (mirror of bill_date elsewhere).
  const guard = await applyFiscalLockGuard(req, res, req.body?.voucher_date);
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

  const t = await sequelize.transaction();
  try {
    const { voucher_date, narration, lines: rawLines } = req.body || {};
    if (!voucher_date) {
      await t.rollback();
      return res.status(400).json({ error: 'voucher_date is required.' });
    }
    let lines;
    try { lines = normalizeLines(rawLines); }
    catch (e) { await t.rollback(); return res.status(400).json({ error: e.message }); }

    const totalDr = lines.reduce((s, l) => s + l.debit, 0);
    const totalCr = lines.reduce((s, l) => s + l.credit, 0);

    // W2: advisory lock key 907 = journal vouchers. Serialises concurrent
    // creates so two requests on the same date don't both read seq N and
    // both try to insert JV-YYYYMMDD-N+1. Auto-released on commit/rollback.
    const companyKey = req.companyId || 0;
    await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
      replacements: { company: companyKey, key: 907 }, transaction: t,
    });
    const voucherNumber = await nextVoucherNumber(voucher_date, t);
    const jv = await JournalVoucher.create({
      voucher_number: voucherNumber,
      voucher_date,
      narration: narration || null,
      total_amount: totalDr,
      is_reversed: false,
      created_by: req.user && req.user.user_id,
    }, { transaction: t });

    await postVoucher({
      voucherType: 'Journal',
      sourceType:  'journal_voucher',
      sourceId:    jv.id,
      voucherDate: voucher_date,
      referenceNumber: voucherNumber,
      lines,
      narration: narration || null,
      userId: req.user && req.user.user_id,
      transaction: t,
    });

    await t.commit();

    if (guard.overrideUsed) {
      await logComplianceEvent({
        event_type:       lockResult.status === 'hard_override_granted' ? 'hard_override' : 'soft_override',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'journal_voucher',
        target_id:        jv.id,
        target_label:     `JV ${jv.voucher_number || `#${jv.id}`} dated ${jv.voucher_date}`,
        target_date:      jv.voucher_date,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate },
      });
    }

    res.status(201).json(jv);
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('JV create error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

exports.update = async (req, res) => {
  // ── Back-dated entry policy (always-on, hard reject) ───────────────
  {
    const bd = require('../utils/backdatedGuard');
    const check = await bd.checkBackdated({
      voucherDate: req.body && req.body.voucher_date,
      user: req.user,
    });
    if (!check.ok) {
      return res.status(403).json({ error: check.reason, code: check.code });
    }
  }

  // ── Fiscal-lock guard on edit ──────────────────────────────────────
  // Probe the earlier of old/new voucher_date.
  const preview = await JournalVoucher.findByPk(req.params.id, { attributes: ['id', 'voucher_date', 'voucher_number', 'is_reversed'] });
  if (!preview) return res.status(404).json({ error: 'Voucher not found' });
  if (preview.is_reversed) return res.status(400).json({ error: 'Cannot edit a reversed voucher.' });
  const oldDateStr = preview.voucher_date && String(preview.voucher_date).slice(0, 10);
  const newDateStr = req.body?.voucher_date && String(req.body.voucher_date).slice(0, 10);
  const guard = await applyFiscalLockGuard(req, res, earlierDate(oldDateStr, newDateStr));
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const jv = await JournalVoucher.findByPk(id, { transaction: t });
    if (!jv) { await t.rollback(); return res.status(404).json({ error: 'Voucher not found' }); }
    if (jv.is_reversed) { await t.rollback(); return res.status(400).json({ error: 'Cannot edit a reversed voucher.' }); }

    const { voucher_date, narration, lines: rawLines } = req.body || {};
    let lines;
    try { lines = normalizeLines(rawLines); }
    catch (e) { await t.rollback(); return res.status(400).json({ error: e.message }); }

    const totalDr = lines.reduce((s, l) => s + l.debit, 0);

    // Reverse the original posting, then post the new one. Posting Service
    // is idempotent per (source_type, source_id, reversal=null), so a
    // reversal first guarantees the new post passes the duplicate check.
    // SER-6: use the ORIGINAL voucher date so the reversal cancels within
    // the same accounting period as the original entry.
    await reverseVoucher({
      sourceType: 'journal_voucher', sourceId: jv.id,
      reason: 'JV edited', userId: req.user && req.user.user_id, transaction: t,
      reversalDate: jv.voucher_date,
    });

    // Audit M4: when the voucher_date changes, the existing voucher_number
    // becomes stale (its prefix encodes the OLD date). Reports that group
    // entries by reference_number — and accounting exports that key on this
    // string — would fan one voucher across two date-prefixed buckets.
    // Regenerate the number using the new date's prefix so the
    // reference_number always aligns with entry_date.
    // W2: take the same advisory lock as create so a concurrent edit that
    // changes the voucher_date doesn't collide with a concurrent create on
    // the new date.
    const companyKeyU = req.companyId || 0;
    await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
      replacements: { company: companyKeyU, key: 907 }, transaction: t,
    });
    let nextNumber = jv.voucher_number;
    const datesDiffer = voucher_date && String(voucher_date) !== String(jv.voucher_date).slice(0, 10);
    if (datesDiffer) {
      // Audit CR-4 — always re-mint when voucher_date changes (drop the
      // earlier same-prefix optimisation). Reason: the prefix helper relies
      // on `new Date(date)` which is TZ-sensitive (ISO timestamps shift
      // a day west of UTC) and is fragile against any future prefix-format
      // change (e.g. monthly). Re-minting on every date change makes the
      // header `voucher_number` canonical with the new `voucher_date` so
      // ledger_entries.entry_number and journal_vouchers.voucher_number
      // always share the same date-prefix in lock-step.
      nextNumber = await nextVoucherNumber(voucher_date, t);
    }

    await jv.update({
      voucher_date:   voucher_date || jv.voucher_date,
      voucher_number: nextNumber,
      narration:      narration   != null ? narration : jv.narration,
      total_amount:   totalDr,
    }, { transaction: t });

    await postVoucher({
      voucherType: 'Journal',
      sourceType:  'journal_voucher',
      sourceId:    jv.id,
      voucherDate: voucher_date || jv.voucher_date,
      referenceNumber: nextNumber,
      lines,
      narration: narration || jv.narration,
      userId: req.user && req.user.user_id,
      transaction: t,
    });

    await t.commit();

    if (guard.overrideUsed) {
      await logComplianceEvent({
        event_type:       'post_close_edit',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'journal_voucher',
        target_id:        jv.id,
        target_label:     `JV ${jv.voucher_number || `#${jv.id}`} edited (date ${oldDateStr || '—'} → ${newDateStr || oldDateStr || '—'})`,
        target_date:      newDateStr || oldDateStr || null,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate, old_date: oldDateStr, new_date: newDateStr || oldDateStr },
      });
    }

    res.json(jv);
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('JV update error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

exports.remove = async (req, res) => {
  // Lock guard on delete (reverse). Probe the JV's own date.
  const preview = await JournalVoucher.findByPk(req.params.id, { attributes: ['id', 'voucher_date', 'voucher_number', 'is_reversed'] });
  if (!preview) return res.status(404).json({ error: 'Voucher not found' });
  const cancelDateStr = preview.voucher_date && String(preview.voucher_date).slice(0, 10);
  const guard = await applyFiscalLockGuard(req, res, cancelDateStr);
  if (!guard.ok) return;
  const lockResult = guard.lockResult;

  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const jv = await JournalVoucher.findByPk(id, { transaction: t });
    if (!jv) { await t.rollback(); return res.status(404).json({ error: 'Voucher not found' }); }

    const { reason } = req.body || {};
    // LED-H2 — keep reversal in the original FY.
    await reverseVoucher({
      sourceType: 'journal_voucher', sourceId: jv.id,
      reason: reason || 'JV deleted',
      userId: req.user && req.user.user_id, transaction: t,
      reversalDate: jv.voucher_date,
    });

    await jv.update({ is_reversed: true }, { transaction: t });

    await t.commit();

    if (guard.overrideUsed) {
      await logComplianceEvent({
        event_type:       lockResult.status === 'hard_override_granted' ? 'hard_override' : 'soft_override',
        is_hard_override: lockResult.status === 'hard_override_granted',
        user:             req.user,
        target_type:      'journal_voucher',
        target_id:        jv.id,
        target_label:     `JV ${jv.voucher_number || `#${jv.id}`} reversed (was dated ${cancelDateStr})`,
        target_date:      cancelDateStr,
        reason:           guard.reason,
        metadata:         { lock_date: lockResult.lockDate, action: 'delete' },
      });
    }

    res.json({ message: 'Voucher reversed.' });
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('JV remove error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};
