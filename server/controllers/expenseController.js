// ── Expense Voucher Controller ──────────────────────────────────────
//
// CRUD for expense vouchers. Posting / reversal goes through
// ledgerPostingService — same atomicity, idempotency and reversal
// rules as JV / Sales / Purchase.
//
// Endpoints:
//   GET  /api/expenses                — list (paginated + filters)
//   GET  /api/expenses/next-number    — preview next EXP-* number
//   GET  /api/expenses/summary        — by-head / by-month rollups
//   GET  /api/expenses/:id            — detail with items + legs
//   POST /api/expenses                — create
//   PUT  /api/expenses/:id            — edit (reverse + repost)
//   POST /api/expenses/:id/cancel     — cancel (mirror entries)

const { Op, fn, col, literal } = require('sequelize');
const sequelize = require('../config/database');
const {
  ExpenseVoucher, ExpenseVoucherItem, LedgerEntry, LedgerAccount, Party, User,
} = require('../models');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildExpenseVoucher } = require('../services/expenseVoucherService');
const { sanitizePagination, escapeLike, roundTo } = require('../utils/helpers');

// Audit MONEY-4 — use the canonical roundTo (Tally-compatible
// round-half-away-from-zero with floating-point fudge). Pre-fix this
// file declared its own r2 = Math.round((n||0)*100)/100 which rounds
// negatives the wrong way and misses .x05 edge cases.
const r2 = (n) => roundTo(Number(n) || 0, 2);

// Voucher number prefix — EXP-YYYYMMDD-NNNN. Matches the JV style so
// the Day Book / Tally export tooling that already understands those
// prefixes treats expense vouchers consistently.
function nextVoucherNumberPrefix(date) {
  const d = new Date(date);
  return `EXP-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function nextVoucherNumber(date, transaction) {
  const prefix = nextVoucherNumberPrefix(date);
  const last = await ExpenseVoucher.findOne({
    where: { voucher_number: { [Op.like]: `${prefix}-%` } },
    order: [['expense_id', 'DESC']],
    transaction,
  });
  let seq = 1;
  if (last && last.voucher_number) {
    const m = last.voucher_number.match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

// ── Validation / normalisation ────────────────────────────────────
//
// Pull (potentially-stringy / potentially-missing) fields off the
// request body and re-shape them into a normalised payload + line
// array we can hand to ExpenseVoucher.create + buildExpenseVoucher.
//
// Recomputes every total from the lines so a hand-tampered payload
// can't slip through with mismatched header-vs-line numbers.
async function normalisePayload(body, transaction) {
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid payload.');
  }
  const voucher_date = body.voucher_date || null;
  if (!voucher_date) throw new Error('voucher_date is required.');

  const payment_mode = body.payment_mode || 'Cash';
  if (!['Cash', 'Bank', 'Credit'].includes(payment_mode)) {
    throw new Error(`Invalid payment_mode: ${payment_mode}`);
  }

  let bank_ledger_id = body.bank_ledger_id ? Number(body.bank_ledger_id) : null;
  if (payment_mode === 'Bank') {
    if (!bank_ledger_id) throw new Error('Bank ledger is required for Bank mode.');
    const bank = await LedgerAccount.findByPk(bank_ledger_id, { transaction });
    if (!bank) throw new Error('Bank ledger not found.');
    if (bank.sub_group !== 'Bank Accounts' && bank.sub_group !== 'Bank OD A/c') {
      throw new Error(`Selected ledger "${bank.ledger_name}" is not a bank account.`);
    }
  } else {
    bank_ledger_id = null;
  }

  let party_id = body.party_id ? Number(body.party_id) : null;
  if (payment_mode === 'Credit' && !party_id) {
    throw new Error('A vendor party is required for Credit mode.');
  }
  let party = null;
  if (party_id) {
    party = await Party.findByPk(party_id, { transaction });
    if (!party) throw new Error('Vendor party not found.');
    if (party.is_system_cash) {
      // The system Cash party is the customer/supplier for cash sales/
      // purchases — never a vendor for an expense.
      throw new Error('Cannot tag the system Cash party as the expense vendor.');
    }
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    throw new Error('Add at least one expense line.');
  }

  // Validate each line + recompute its GST + line_total deterministically.
  const items = [];
  // Restrict expense_ledger_id to ledger_group='Expenses'. Cache lookups
  // so a 10-line voucher doesn't fire 10 SELECTs.
  const ledgerCache = new Map();
  for (let i = 0; i < rawItems.length; i++) {
    const ln = rawItems[i];
    const expense_ledger_id = Number(ln.expense_ledger_id);
    if (!Number.isFinite(expense_ledger_id)) {
      throw new Error(`Line ${i + 1}: expense ledger is required.`);
    }
    let lg = ledgerCache.get(expense_ledger_id);
    if (!lg) {
      lg = await LedgerAccount.findByPk(expense_ledger_id, { transaction });
      if (!lg) throw new Error(`Line ${i + 1}: expense ledger not found.`);
      if (lg.ledger_group !== 'Expenses') {
        throw new Error(
          `Line ${i + 1}: ledger "${lg.ledger_name}" is in group "${lg.ledger_group}". Only Expenses group ledgers can be used.`,
        );
      }
      ledgerCache.set(expense_ledger_id, lg);
    }
    const taxable = r2(ln.taxable_amount);
    if (taxable < 0) throw new Error(`Line ${i + 1}: amount cannot be negative.`);
    if (taxable === 0) throw new Error(`Line ${i + 1}: amount required.`);

    const cgst_rate = r2(ln.cgst_rate);
    const sgst_rate = r2(ln.sgst_rate);
    const igst_rate = r2(ln.igst_rate);
    if (igst_rate > 0 && (cgst_rate > 0 || sgst_rate > 0)) {
      throw new Error(`Line ${i + 1}: pick CGST+SGST (intra-state) OR IGST (inter-state), not both.`);
    }
    // Audit MONEY-8 — use splitBillWiseGst so the CGST + SGST halves
    // reconcile to the combined tax exactly. Pre-fix, each half was
    // rounded independently:
    //   cgst = r2(taxable * cgst_rate / 100)
    //   sgst = r2(taxable * sgst_rate / 100)
    // which drifts ±₹0.01 from the true combined tax on .x05 inputs.
    // splitBillWiseGst rounds the combined tax first and gives the
    // residual to the second half so Σ matches exactly.
    const { splitBillWiseGst } = require('../utils/helpers');
    const split = splitBillWiseGst(taxable, cgst_rate, sgst_rate, igst_rate);
    const cgst_amount = split.cgst;
    const sgst_amount = split.sgst;
    const igst_amount = split.igst;
    const line_total  = r2(taxable + cgst_amount + sgst_amount + igst_amount);

    items.push({
      expense_ledger_id,
      description: (ln.description || '').toString().slice(0, 255) || null,
      taxable_amount: taxable,
      cgst_rate, sgst_rate, igst_rate,
      cgst_amount, sgst_amount, igst_amount,
      line_total,
    });
  }

  // Header totals are SUM of lines + (operator-supplied) round_off.
  const sub_total   = r2(items.reduce((s, x) => s + x.taxable_amount, 0));
  const cgst_amount = r2(items.reduce((s, x) => s + x.cgst_amount,    0));
  const sgst_amount = r2(items.reduce((s, x) => s + x.sgst_amount,    0));
  const igst_amount = r2(items.reduce((s, x) => s + x.igst_amount,    0));
  const round_off   = r2(body.round_off);
  const total_amount = r2(sub_total + cgst_amount + sgst_amount + igst_amount + round_off);

  // paid_amount: defaults to total for Cash/Bank, 0 for Credit.
  // Operator can override (e.g. credit voucher with a part-cash advance)
  // but it must be 0 ≤ paid ≤ total.
  let paid_amount;
  if (body.paid_amount != null && body.paid_amount !== '') {
    paid_amount = r2(body.paid_amount);
  } else {
    paid_amount = payment_mode === 'Credit' ? 0 : total_amount;
  }
  if (paid_amount < 0) throw new Error('paid_amount cannot be negative.');
  if (paid_amount > total_amount + 0.005) {
    throw new Error(`paid_amount (${paid_amount}) exceeds total (${total_amount}).`);
  }
  if (payment_mode === 'Credit' && paid_amount > 0 && !party_id) {
    throw new Error('Partial-payment credit voucher requires a vendor party.');
  }
  // For pure Cash/Bank with no vendor, paid must equal total — there's
  // nowhere to credit the unpaid balance otherwise.
  if (!party_id && r2(total_amount - paid_amount) > 0) {
    throw new Error('Unpaid balance requires a vendor party.');
  }

  return {
    header: {
      voucher_date,
      payment_mode,
      bank_ledger_id,
      party_id,
      reference_number: (body.reference_number || '').toString().slice(0, 60) || null,
      payment_ref:      (body.payment_ref      || '').toString().slice(0, 60) || null,
      narration:        (body.narration        || '').toString() || null,
      sub_total, cgst_amount, sgst_amount, igst_amount,
      round_off, total_amount, paid_amount,
    },
    items,
    party,
  };
}

// ── Endpoints ────────────────────────────────────────────────────────

exports.getNextNumber = async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const next = await nextVoucherNumber(date);
    res.json({ next });
  } catch (err) {
    console.error('expense getNextNumber error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAll = async (req, res) => {
  try {
    const { page, limit, offset } = sanitizePagination(req.query.page, req.query.limit);
    const { from_date, to_date, party_id, expense_ledger_id, payment_mode, search, include_cancelled } = req.query || {};

    const where = {};
    if (!include_cancelled || include_cancelled === 'false') where.is_cancelled = false;
    if (from_date && to_date) where.voucher_date = { [Op.between]: [from_date, to_date] };
    if (party_id) where.party_id = party_id;
    if (payment_mode) where.payment_mode = payment_mode;
    if (search) {
      // Audit P3-D — escape LIKE wildcards.
      const s = escapeLike(search);
      where[Op.or] = [
        { voucher_number:   { [Op.iLike]: `%${s}%` } },
        { reference_number: { [Op.iLike]: `%${s}%` } },
        { narration:        { [Op.iLike]: `%${s}%` } },
      ];
    }

    // expense_ledger_id is a join filter — return the voucher only if
    // any of its items book against the chosen ledger.
    const include = [
      { model: Party,         as: 'party', attributes: ['party_id', 'party_name'] },
      { model: LedgerAccount, as: 'bank',  attributes: ['ledger_id', 'ledger_name'] },
      {
        model: ExpenseVoucherItem, as: 'items',
        ...(expense_ledger_id ? { where: { expense_ledger_id }, required: true } : {}),
        include: [{ model: LedgerAccount, as: 'expenseLedger', attributes: ['ledger_id', 'ledger_name'] }],
      },
    ];

    const { count, rows } = await ExpenseVoucher.findAndCountAll({
      where, include,
      order: [['voucher_date', 'DESC'], ['expense_id', 'DESC']],
      limit, offset, distinct: true,
    });
    // SUM of totals across ALL filtered rows (not just the page) so the
    // list footer can show "₹X across N vouchers". Cheap on the indexed
    // columns. Subquery so Sequelize doesn't try to apply the items
    // join filter to a SUM directly (that would double-count items).
    let sumTotal = 0;
    if (count > 0) {
      if (expense_ledger_id) {
        // Reapply the items filter as an EXISTS clause so SUM only
        // counts each voucher once even though Sequelize is using a
        // JOIN above for the row fetch.
        const rep = {
          fd:   from_date    || null,
          td:   to_date      || null,
          pid:  party_id ? Number(party_id) : null,
          pm:   payment_mode || null,
          elid: Number(expense_ledger_id),
          inc:  (include_cancelled === 'true' || include_cancelled === true),
        };
        const sumRows = await sequelize.query(
          `SELECT COALESCE(SUM(ev.total_amount), 0) AS s
             FROM expense_vouchers ev
            WHERE (:inc OR ev.is_cancelled = false)
              AND (:fd  IS NULL OR ev.voucher_date >= CAST(:fd AS DATE))
              AND (:td  IS NULL OR ev.voucher_date <= CAST(:td AS DATE))
              AND (:pid IS NULL OR ev.party_id = :pid)
              AND (:pm  IS NULL OR ev.payment_mode::text = :pm)
              AND EXISTS (
                SELECT 1 FROM expense_voucher_items i
                 WHERE i.expense_id = ev.expense_id
                   AND i.expense_ledger_id = :elid
              )`,
          { type: sequelize.QueryTypes.SELECT, replacements: rep },
        );
        sumTotal = Number((sumRows && sumRows[0] && sumRows[0].s) || 0);
      } else {
        const agg = await ExpenseVoucher.sum('total_amount', { where });
        sumTotal = Number(agg || 0);
      }
    }

    res.json({ total: count, page, limit, sum_total: r2(sumTotal), data: rows });
  } catch (err) {
    console.error('expense getAll error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const ev = await ExpenseVoucher.findByPk(req.params.id, {
      include: [
        { model: Party,         as: 'party' },
        { model: LedgerAccount, as: 'bank',  attributes: ['ledger_id', 'ledger_name', 'sub_group'] },
        { model: User,          as: 'creator',  attributes: ['user_id', 'username', 'full_name'] },
        { model: User,          as: 'canceller', attributes: ['user_id', 'username', 'full_name'] },
        {
          model: ExpenseVoucherItem, as: 'items',
          include: [{
            model: LedgerAccount, as: 'expenseLedger',
            attributes: ['ledger_id', 'ledger_name', 'ledger_group', 'sub_group'],
          }],
        },
      ],
      order: [[{ model: ExpenseVoucherItem, as: 'items' }, 'item_id', 'ASC']],
    });
    if (!ev) return res.status(404).json({ error: 'Expense voucher not found' });
    // Pull the live ledger entries so the detail UI can show the actual
    // posted Dr/Cr legs (audit trail).
    const legs = await LedgerEntry.findAll({
      where: { source_type: 'expense_voucher', reference_id: ev.expense_id },
      include: [{ model: LedgerAccount, attributes: ['ledger_id', 'ledger_name', 'ledger_group'] }],
      order: [['entry_id', 'ASC']],
    });
    res.json({ ...ev.toJSON(), legs });
  } catch (err) {
    console.error('expense getById error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  // Audit BACKDATED-1 — block back-dating before opening the transaction.
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
  const t = await sequelize.transaction();
  try {
    const { header, items, party } = await normalisePayload(req.body, t);

    const voucher_number = await nextVoucherNumber(header.voucher_date, t);

    const ev = await ExpenseVoucher.create({
      voucher_number,
      ...header,
      created_by: req.user && req.user.user_id,
    }, { transaction: t });

    // Attach lines.
    for (const it of items) {
      await ExpenseVoucherItem.create({ expense_id: ev.expense_id, ...it }, { transaction: t });
    }

    // Build + post the voucher legs.
    const built = await buildExpenseVoucher(
      { ...ev.toJSON(), items, party },
      { transaction: t },
    );
    await postVoucher({
      ...built,
      userId: req.user && req.user.user_id,
      transaction: t,
    });

    await t.commit();

    // Return the created voucher with relations so the UI can navigate
    // straight to the detail view without an extra round-trip.
    const out = await ExpenseVoucher.findByPk(ev.expense_id, {
      include: [
        { model: Party,         as: 'party' },
        { model: LedgerAccount, as: 'bank',  attributes: ['ledger_id', 'ledger_name'] },
        { model: ExpenseVoucherItem, as: 'items',
          include: [{ model: LedgerAccount, as: 'expenseLedger', attributes: ['ledger_id', 'ledger_name'] }] },
      ],
    });
    res.status(201).json(out);
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('expense create error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

exports.update = async (req, res) => {
  // Audit BACKDATED-1 — block back-dating before opening the transaction.
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
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const ev = await ExpenseVoucher.findByPk(id, { transaction: t });
    if (!ev) { await t.rollback(); return res.status(404).json({ error: 'Expense voucher not found' }); }
    if (ev.is_cancelled) {
      await t.rollback();
      return res.status(400).json({ error: 'Cannot edit a cancelled voucher.' });
    }

    const { header, items, party } = await normalisePayload(req.body, t);

    // Reverse the existing posting first so postVoucher's idempotency
    // guard accepts the new write — same dance as JV update.
    await reverseVoucher({
      sourceType: 'expense_voucher', sourceId: ev.expense_id,
      reason: 'Expense voucher edited',
      userId: req.user && req.user.user_id,
      transaction: t,
    });

    // Replace the line breakdown.
    await ExpenseVoucherItem.destroy({ where: { expense_id: ev.expense_id }, transaction: t });
    for (const it of items) {
      await ExpenseVoucherItem.create({ expense_id: ev.expense_id, ...it }, { transaction: t });
    }

    await ev.update(header, { transaction: t });

    const built = await buildExpenseVoucher(
      { ...ev.toJSON(), items, party },
      { transaction: t },
    );
    await postVoucher({
      ...built,
      userId: req.user && req.user.user_id,
      transaction: t,
    });

    await t.commit();

    const out = await ExpenseVoucher.findByPk(ev.expense_id, {
      include: [
        { model: Party,         as: 'party' },
        { model: LedgerAccount, as: 'bank',  attributes: ['ledger_id', 'ledger_name'] },
        { model: ExpenseVoucherItem, as: 'items',
          include: [{ model: LedgerAccount, as: 'expenseLedger', attributes: ['ledger_id', 'ledger_name'] }] },
      ],
    });
    res.json(out);
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('expense update error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

exports.cancel = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const ev = await ExpenseVoucher.findByPk(id, { transaction: t });
    if (!ev) { await t.rollback(); return res.status(404).json({ error: 'Expense voucher not found' }); }
    if (ev.is_cancelled) {
      await t.rollback();
      return res.status(400).json({ error: 'Voucher is already cancelled.' });
    }

    const reason = (req.body && req.body.reason) || null;
    await reverseVoucher({
      sourceType: 'expense_voucher', sourceId: ev.expense_id,
      reason: reason || 'Expense voucher cancelled',
      userId: req.user && req.user.user_id,
      transaction: t,
    });

    await ev.update({
      is_cancelled: true,
      cancelled_at: new Date(),
      cancelled_by: req.user && req.user.user_id,
      cancel_reason: reason ? String(reason).slice(0, 255) : null,
    }, { transaction: t });

    await t.commit();
    res.json({ message: 'Voucher cancelled.', expense_id: ev.expense_id });
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('expense cancel error:', err);
    res.status(400).json({ error: err.message || 'Server error' });
  }
};

// ── Summary endpoint ────────────────────────────────────────────────
//
// Powers the Expense Report page. Returns:
//   • by_head    — total taxable + GST + line_total grouped by expense
//                  ledger (the P&L head).
//   • by_month   — total spend grouped by YYYY-MM voucher_date.
//   • by_party   — total spend grouped by vendor party (top 20).
//   • totals     — grand totals across the same filter set.
//
// Filters: from_date, to_date, party_id, payment_mode, expense_ledger_id.
// Cancelled vouchers are excluded.
exports.getSummary = async (req, res) => {
  try {
    const { from_date, to_date, party_id, payment_mode, expense_ledger_id } = req.query || {};

    const replacements = {
      from_date:    from_date    || null,
      to_date:      to_date      || null,
      party_id:     party_id ? Number(party_id) : null,
      payment_mode: payment_mode || null,
      ledger_id:    expense_ledger_id ? Number(expense_ledger_id) : null,
    };

    // Header-level WHERE — evaluated against ev (expense_vouchers).
    // payment_mode comparison casts text→text (the enum's value is just
    // the string in PG), so no type wrangling needed.
    const headerWhere = `
      ev.is_cancelled = false
        AND (:from_date IS NULL OR ev.voucher_date >= CAST(:from_date AS DATE))
        AND (:to_date   IS NULL OR ev.voucher_date <= CAST(:to_date   AS DATE))
        AND (:party_id  IS NULL OR ev.party_id = :party_id)
        AND (:payment_mode IS NULL OR ev.payment_mode::text = :payment_mode)
    `;
    // EXISTS(...) clause — applied when filtering by expense_ledger_id
    // so vouchers that include the chosen head appear once each.
    const ledgerExists = `
      AND (:ledger_id IS NULL OR EXISTS (
        SELECT 1 FROM expense_voucher_items i2
         WHERE i2.expense_id = ev.expense_id
           AND i2.expense_ledger_id = :ledger_id
      ))
    `;

    const byHead = await sequelize.query(
      `SELECT i.expense_ledger_id AS ledger_id,
              la.ledger_name      AS ledger_name,
              la.sub_group        AS sub_group,
              COUNT(DISTINCT ev.expense_id) AS voucher_count,
              COALESCE(SUM(i.taxable_amount), 0) AS taxable_total,
              COALESCE(SUM(i.cgst_amount + i.sgst_amount + i.igst_amount), 0) AS gst_total,
              COALESCE(SUM(i.line_total), 0) AS line_total
         FROM expense_voucher_items i
         JOIN expense_vouchers ev ON ev.expense_id = i.expense_id
         JOIN ledger_accounts  la ON la.ledger_id  = i.expense_ledger_id
        WHERE ${headerWhere}
          AND (:ledger_id IS NULL OR i.expense_ledger_id = :ledger_id)
        GROUP BY i.expense_ledger_id, la.ledger_name, la.sub_group
        ORDER BY line_total DESC NULLS LAST`,
      { type: sequelize.QueryTypes.SELECT, replacements },
    );

    const byMonth = await sequelize.query(
      `SELECT TO_CHAR(ev.voucher_date, 'YYYY-MM') AS month,
              COUNT(*)                            AS voucher_count,
              COALESCE(SUM(ev.sub_total), 0)      AS taxable_total,
              COALESCE(SUM(ev.cgst_amount + ev.sgst_amount + ev.igst_amount), 0) AS gst_total,
              COALESCE(SUM(ev.total_amount), 0)   AS line_total
         FROM expense_vouchers ev
        WHERE ${headerWhere} ${ledgerExists}
        GROUP BY 1
        ORDER BY 1 ASC`,
      { type: sequelize.QueryTypes.SELECT, replacements },
    );

    const byParty = await sequelize.query(
      `SELECT ev.party_id  AS party_id,
              p.party_name AS party_name,
              COUNT(*)     AS voucher_count,
              COALESCE(SUM(ev.total_amount), 0) AS line_total
         FROM expense_vouchers ev
         LEFT JOIN parties p ON p.party_id = ev.party_id
        WHERE ${headerWhere} ${ledgerExists}
        GROUP BY ev.party_id, p.party_name
        ORDER BY line_total DESC NULLS LAST
        LIMIT 50`,
      { type: sequelize.QueryTypes.SELECT, replacements },
    );

    const totalsRow = await sequelize.query(
      `SELECT COUNT(*) AS voucher_count,
              COALESCE(SUM(ev.sub_total), 0) AS taxable_total,
              COALESCE(SUM(ev.cgst_amount + ev.sgst_amount + ev.igst_amount), 0) AS gst_total,
              COALESCE(SUM(ev.total_amount), 0) AS line_total,
              COALESCE(SUM(ev.paid_amount), 0)  AS paid_total,
              COALESCE(SUM(ev.total_amount - ev.paid_amount), 0) AS unpaid_total
         FROM expense_vouchers ev
        WHERE ${headerWhere} ${ledgerExists}`,
      { type: sequelize.QueryTypes.SELECT, replacements },
    );
    const totals = totalsRow[0] || {};

    res.json({
      filters: { from_date, to_date, party_id, payment_mode, expense_ledger_id },
      totals: {
        voucher_count: Number(totals.voucher_count || 0),
        taxable_total: Number(totals.taxable_total || 0),
        gst_total:     Number(totals.gst_total     || 0),
        line_total:    Number(totals.line_total    || 0),
        paid_total:    Number(totals.paid_total    || 0),
        unpaid_total:  Number(totals.unpaid_total  || 0),
      },
      by_head:  byHead .map((r) => ({ ...r, voucher_count: Number(r.voucher_count), taxable_total: Number(r.taxable_total), gst_total: Number(r.gst_total), line_total: Number(r.line_total) })),
      by_month: byMonth.map((r) => ({ ...r, voucher_count: Number(r.voucher_count), taxable_total: Number(r.taxable_total), gst_total: Number(r.gst_total), line_total: Number(r.line_total) })),
      by_party: byParty.map((r) => ({ ...r, voucher_count: Number(r.voucher_count), line_total: Number(r.line_total) })),
    });
  } catch (err) {
    console.error('expense getSummary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
