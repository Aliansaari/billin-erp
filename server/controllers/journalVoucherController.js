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
const { sanitizePagination } = require('../utils/helpers');

function nextVoucherNumberPrefix(date) {
  const d = new Date(date);
  return `JV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function nextVoucherNumber(date, transaction) {
  const prefix = nextVoucherNumberPrefix(date);
  const last = await JournalVoucher.findOne({
    where: { voucher_number: { [Op.like]: `${prefix}-%` } },
    order: [['voucher_number', 'DESC']],
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
    res.status(500).json({ error: 'Server error' });
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
    res.status(500).json({ error: 'Server error' });
  }
};

function normalizeLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length < 2) {
    throw new Error('At least 2 lines required.');
  }
  return rawLines.map((ln, i) => {
    const debit  = Number(ln.debit  || 0);
    const credit = Number(ln.credit || 0);
    if (!ln.ledger_id) throw new Error(`Line ${i + 1}: ledger is required.`);
    if (debit < 0 || credit < 0) throw new Error(`Line ${i + 1}: amounts must be non-negative.`);
    if (debit > 0 && credit > 0) throw new Error(`Line ${i + 1}: debit and credit can't both be > 0.`);
    if (debit === 0 && credit === 0) throw new Error(`Line ${i + 1}: amount required.`);
    return { ledgerAccountId: Number(ln.ledger_id), debit, credit, partyId: ln.party_id || null };
  });
}

exports.create = async (req, res) => {
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
    res.status(201).json(jv);
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('JV create error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

exports.update = async (req, res) => {
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
    await reverseVoucher({
      sourceType: 'journal_voucher', sourceId: jv.id,
      reason: 'JV edited', userId: req.user && req.user.user_id, transaction: t,
    });

    await jv.update({
      voucher_date: voucher_date || jv.voucher_date,
      narration:    narration   != null ? narration : jv.narration,
      total_amount: totalDr,
    }, { transaction: t });

    await postVoucher({
      voucherType: 'Journal',
      sourceType:  'journal_voucher',
      sourceId:    jv.id,
      voucherDate: voucher_date || jv.voucher_date,
      referenceNumber: jv.voucher_number,
      lines,
      narration: narration || jv.narration,
      userId: req.user && req.user.user_id,
      transaction: t,
    });

    await t.commit();
    res.json(jv);
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('JV update error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

exports.remove = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const jv = await JournalVoucher.findByPk(id, { transaction: t });
    if (!jv) { await t.rollback(); return res.status(404).json({ error: 'Voucher not found' }); }

    const { reason } = req.body || {};
    await reverseVoucher({
      sourceType: 'journal_voucher', sourceId: jv.id,
      reason: reason || 'JV deleted',
      userId: req.user && req.user.user_id, transaction: t,
    });

    await jv.update({ is_reversed: true }, { transaction: t });

    await t.commit();
    res.json({ message: 'Voucher reversed.' });
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('JV remove error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};
