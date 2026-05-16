// ── Banks Controller ──────────────────────────────────────────────────
//
// Banks aren't a separate entity in this ERP — they're ledger accounts
// under sub_group 'Bank Accounts' or 'Bank OD A/c'. This controller is
// the bank-flavoured surface over those ledgers:
//
//   GET  /api/banks                    list all bank ledgers + metrics
//   GET  /api/banks/:id/statement     bank-style statement for one bank
//   POST /api/banks/clear/:txn        mark a payment_receipt as cleared
//   POST /api/banks/unclear/:txn      undo clearance
//
// "Statement" is shaped for bank reconciliation:
//   • Withdrawal / Deposit columns instead of generic Debit / Credit
//   • Per-row Cheque/UTR ref pulled from payment_splits
//   • Per-row Cleared status (cleared_at on payment_receipts)
//   • Reconciliation summary: book balance, cleared total, uncleared
//     total, expected bank balance = book balance − Σ uncleared
//
// Built on top of the existing ledgerStatementService.getLedgerStatement
// — same source-of-truth (ledger_entries with the active-predicate),
// just enriched with bank-specific fields.

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  LedgerAccount, LedgerEntry, PaymentReceipt, PaymentSplit, Party,
} = require('../models');
const { getLedgerStatement } = require('../services/ledgerStatementService');

const BANK_SUB_GROUPS = ['Bank Accounts', 'Bank OD A/c'];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v)  { return Math.round(num(v) * 100) / 100; }

// ── Sub-group → ledger_group mapping ────────────────────────────────
//
// New bank ledgers need an upstream ledger_group string (we don't FK
// into a separate groups table — the schema stores it as a denormalised
// label, see the diagnostic query in this controller's docstring).
//
//   Bank Accounts → Assets       (asset, Dr-natured: positive = our money)
//   Bank OD A/c   → Liabilities  (liability, Cr-natured: positive = owed to bank)
//
// Reject anything else; the rest of the bank pipeline only handles
// these two sub_groups.
const SUBGROUP_TO_GROUP = {
  'Bank Accounts': 'Assets',
  'Bank OD A/c':   'Liabilities',
};

// ── List all banks with action-relevant metrics ─────────────────────
//
// One row per bank ledger. Computes the things the operator wants to
// see at a glance on the Banks landing page:
//
//   • current_balance — book balance = signed Σ(debit − credit) on the
//     ledger over all live entries (matches the Trial Balance figure).
//   • last_txn_date — most recent ledger entry, helps spot dormant
//     accounts.
//   • monthly_inflow / monthly_outflow — last 30 days of Dr / Cr
//     activity. Surfaces "this is the busy account, this is the dead
//     one" without the operator opening each statement.
//   • uncleared_count / uncleared_value — how many cheques are in
//     transit, how much money that represents. The reconciliation
//     impact at a glance.
exports.listBanks = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    // include_inactive=true → return inactive banks too (used by the
    // Bank → Accounts management page so the operator can re-activate
    // or delete deactivated banks). Default false → picker dropdowns
    // and other transaction surfaces only see active banks.
    const includeInactive = String(req.query.include_inactive || '').toLowerCase() === 'true';
    const activeClause = includeInactive ? '' : 'AND la.is_active = true';

    // Pull every active bank ledger and compute the full metric set
    // in one query — much faster than per-bank fan-out for ~5–20 banks.
    const rows = await sequelize.query(
      `SELECT la.ledger_id,
              la.ledger_name,
              la.sub_group,
              la.is_active,
              la.is_system_ledger,
              la.opening_balance,
              la.opening_balance_type,
              -- Book balance: all-time signed net.  Sign convention:
              -- + = Dr (asset; positive bank balance).
              -- − = Cr (overdraft, money owed to bank).
              COALESCE((
                SELECT SUM(le.debit_amount - le.credit_amount)
                  FROM ledger_entries le
                 WHERE le.ledger_id = la.ledger_id
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ), 0)::float AS ledger_net,

              -- Last txn date.
              (
                SELECT MAX(le.entry_date)::text
                  FROM ledger_entries le
                 WHERE le.ledger_id = la.ledger_id
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ) AS last_txn_date,

              -- 30-day Dr / Cr.
              COALESCE((
                SELECT SUM(le.debit_amount)
                  FROM ledger_entries le
                 WHERE le.ledger_id = la.ledger_id
                   AND le.entry_date >= :d30
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ), 0)::float AS monthly_inflow,
              COALESCE((
                SELECT SUM(le.credit_amount)
                  FROM ledger_entries le
                 WHERE le.ledger_id = la.ledger_id
                   AND le.entry_date >= :d30
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ), 0)::float AS monthly_outflow,

              -- Uncleared count / value. We tie payment_receipts to
              -- bank ledgers via ledger_entries.source_type +
              -- reference_id (the standard posting trail). A row is
              -- "uncleared" if cleared_at IS NULL.
              COALESCE((
                SELECT COUNT(DISTINCT pr.transaction_id)::int
                  FROM payments_receipts pr
                  JOIN ledger_entries  le ON le.source_type = 'payment_receipt'
                                          AND le.reference_id = pr.transaction_id
                                          AND le.ledger_id = la.ledger_id
                 WHERE pr.is_cancelled = false
                   AND pr.cleared_at IS NULL
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ), 0)::int AS uncleared_count,
              COALESCE((
                SELECT SUM(ABS(le.debit_amount - le.credit_amount))
                  FROM payments_receipts pr
                  JOIN ledger_entries  le ON le.source_type = 'payment_receipt'
                                          AND le.reference_id = pr.transaction_id
                                          AND le.ledger_id = la.ledger_id
                 WHERE pr.is_cancelled = false
                   AND pr.cleared_at IS NULL
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ), 0)::float AS uncleared_value,

              -- All-time live entry count on this ledger. Drives the
              -- "can we hard-delete?" gate on the management page —
              -- if this is > 0, the API rejects DELETE and the UI
              -- offers Deactivate instead.
              COALESCE((
                SELECT COUNT(*)::int
                  FROM ledger_entries le
                 WHERE le.ledger_id = la.ledger_id
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ), 0)::int AS txn_count
         FROM ledger_accounts la
        WHERE la.sub_group IN (:subs)
          ${activeClause}
        ORDER BY la.is_active DESC, la.ledger_name ASC`,
      {
        replacements: { subs: BANK_SUB_GROUPS, d30 },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const banks = rows.map((r) => {
      const seedSigned =
        (r.opening_balance_type === 'Credit' ? -1 : 1) *
        (parseFloat(r.opening_balance) || 0);
      const balance = r2(seedSigned + num(r.ledger_net));
      return {
        ledger_id:       r.ledger_id,
        name:            r.ledger_name,
        sub_group:       r.sub_group,
        is_overdraft:    r.sub_group === 'Bank OD A/c',
        is_active:       r.is_active,
        is_system_ledger: r.is_system_ledger,
        opening_balance:      parseFloat(r.opening_balance) || 0,
        opening_balance_type: r.opening_balance_type,
        balance,
        balance_side:    balance >= 0 ? 'Dr' : 'Cr',
        last_txn_date:   r.last_txn_date,
        monthly_inflow:  r2(r.monthly_inflow),
        monthly_outflow: r2(r.monthly_outflow),
        uncleared_count: r.uncleared_count,
        uncleared_value: r2(r.uncleared_value),
        // Drives whether the management page can offer hard-delete:
        // 0 = clean ledger, deletion is safe; >0 = entries posted,
        // operator must deactivate.
        txn_count:       r.txn_count,
      };
    });

    // Totals only roll up active banks — the dashboard tile
    // ("Total Bank Balance") shouldn't include retired accounts.
    const activeBanks = banks.filter((b) => b.is_active);
    const totals = {
      bank_count:     activeBanks.length,
      inactive_count: banks.length - activeBanks.length,
      total_balance:  r2(activeBanks.reduce((s, b) => s + b.balance, 0)),
      total_inflow:   r2(activeBanks.reduce((s, b) => s + b.monthly_inflow, 0)),
      total_outflow:  r2(activeBanks.reduce((s, b) => s + b.monthly_outflow, 0)),
      total_uncleared: r2(activeBanks.reduce((s, b) => s + b.uncleared_value, 0)),
    };

    res.json({ as_of: today, banks, totals });
  } catch (err) {
    console.error('listBanks error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Bank statement — bank-flavoured ledger statement ────────────────
//
// Wraps getLedgerStatement and adds:
//   • Cheque/UTR + payment_mode per row (joined from payment_splits)
//   • cleared_at + party_name when entry source is a payment_receipt
//   • Reconciliation summary: book bal, cleared total, uncleared
//     total, expected bank balance (= book − uncleared)
exports.bankStatement = async (req, res) => {
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) {
      return res.status(400).json({ error: 'Invalid ledger_id' });
    }
    const account = await LedgerAccount.findByPk(ledgerId);
    if (!account) return res.status(404).json({ error: 'Bank ledger not found' });
    if (!BANK_SUB_GROUPS.includes(account.sub_group)) {
      return res.status(400).json({
        error: `Ledger "${account.ledger_name}" is not a bank account ` +
               `(sub_group=${account.sub_group}). Use the regular Ledger ` +
               `Statement for non-bank ledgers.`,
      });
    }

    const { from_date, to_date } = req.query || {};
    const stmt = await getLedgerStatement(ledgerId, {
      fromDate: from_date || null,
      toDate:   to_date   || null,
    });

    // Bulk-load the receipt rows referenced by the statement entries
    // so we can attach cleared_at / cheque / party / mode per row.
    const txnIds = [...new Set(stmt.entries
      .filter((e) => e.source_type === 'payment_receipt' && e.reference_id)
      .map((e) => e.reference_id))];

    let receipts = [];
    if (txnIds.length > 0) {
      receipts = await PaymentReceipt.findAll({
        where: { transaction_id: { [Op.in]: txnIds } },
        include: [
          { model: Party, as: 'party', attributes: ['party_id', 'party_name'] },
          { model: PaymentSplit, as: 'splits',
            attributes: ['payment_mode', 'cheque_number', 'cheque_date', 'upi_transaction_id'] },
        ],
      });
    }
    const byTxn = new Map(receipts.map((r) => [r.transaction_id, r]));

    // Enrich the statement entries with bank-specific fields. Map the
    // generic Dr/Cr to bank-friendly Withdrawal/Deposit semantics:
    //   For an asset bank ledger (Dr-natured), Dr = Deposit (money in),
    //   Cr = Withdrawal (money out).  The reverse for an OD account.
    const isOd = account.sub_group === 'Bank OD A/c';
    const enriched = stmt.entries.map((e) => {
      const r = byTxn.get(e.reference_id);
      const split = r?.splits?.[0];
      const cheque = split?.cheque_number || split?.upi_transaction_id || null;
      const mode   = split?.payment_mode  || null;
      const party  = r?.party?.party_name || null;
      const cleared_at = r?.cleared_at || null;

      // Asset bank: Dr (entry has +debit) is money INTO the account.
      // OD bank:    Cr (entry has +credit) is money INTO the account.
      const deposit    = isOd ? e.credit : e.debit;
      const withdrawal = isOd ? e.debit  : e.credit;

      return {
        ...e,
        deposit:     r2(deposit),
        withdrawal:  r2(withdrawal),
        // Only payment-receipt rows are clearable in this MVP. JV /
        // contra rows are listed but show "—" for cleared status.
        clearable:   e.source_type === 'payment_receipt',
        cleared_at,
        cheque, mode, party,
        transaction_id: r?.transaction_id || null,
      };
    });

    // Reconciliation summary. "Uncleared" is the sum of payment_receipts
    // touching this bank ledger that don't yet have cleared_at set.
    let totalDeposit = 0, totalWithdrawal = 0;
    let unclearedDeposit = 0, unclearedWithdrawal = 0;
    let unclearedCount = 0;
    for (const e of enriched) {
      totalDeposit    += e.deposit;
      totalWithdrawal += e.withdrawal;
      if (e.clearable && !e.cleared_at) {
        unclearedDeposit    += e.deposit;
        unclearedWithdrawal += e.withdrawal;
        if (e.deposit > 0 || e.withdrawal > 0) unclearedCount += 1;
      }
    }
    // Net uncleared impact on the bank balance: deposits not yet
    // credited - withdrawals not yet debited. "Expected bank balance" is
    // the book balance adjusted for those in-transit movements:
    //   bank stmt balance = book balance − net uncleared
    const netUncleared = r2(unclearedDeposit - unclearedWithdrawal);
    const closingForSide = isOd ? -stmt.closing_balance : stmt.closing_balance;
    const expectedBank = r2(closingForSide - netUncleared);

    res.json({
      account: {
        ...stmt.account,
        is_overdraft: isOd,
      },
      period: stmt.period,
      opening_balance: r2(isOd ? -stmt.opening_balance : stmt.opening_balance),
      entries: enriched,
      totals: {
        total_deposit:    r2(totalDeposit),
        total_withdrawal: r2(totalWithdrawal),
        closing_balance:  r2(closingForSide),
        balance_side:     closingForSide >= 0 ? 'Dr' : 'Cr',
      },
      reconciliation: {
        book_balance:        r2(closingForSide),
        uncleared_count:     unclearedCount,
        uncleared_deposit:   r2(unclearedDeposit),
        uncleared_withdrawal: r2(unclearedWithdrawal),
        net_uncleared:       netUncleared,
        expected_bank_bal:   expectedBank,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('bankStatement error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Cross-bank reconciliation view ──────────────────────────────────
//
// Single page that shows every uncleared (or cleared) entry across
// every bank ledger in the company. Powers the "Bank → Reconciliation"
// menu entry — the bookkeeper's one-stop view for chasing cheques in
// transit at month-end.
//
// Why this isn't just a filter on the per-bank statement page:
//   • A 5-bank business has uncleared cheques scattered across all
//     5 banks. Switching between 5 statement views to chase them is
//     friction; one consolidated table is the natural shape.
//   • Aging buckets (0-7 / 8-30 / 31-90 / 90+ days) are only useful
//     when you can see the full population at once.
//   • Group/sort by bank, party, or age makes triage faster.
//
// Returns:
//   entries        — array of uncleared payment-receipt rows with
//                    bank info, cheque, party, withdrawal/deposit,
//                    and days_outstanding
//   per_bank       — map of bank_id → { count, value }, for the
//                    "Banks affected" breakdown card
//   aging          — { '0-7': {count, value}, '8-30': ..., ...}
//   totals         — { count, value, oldest_days }
//
// Query params:
//   status         — 'uncleared' (default) | 'cleared' | 'all'
//   bank_id        — optional, restrict to one bank
//   from_date / to_date — optional date window (filters by entry_date)
exports.reconciliation = async (req, res) => {
  try {
    const status   = (req.query.status || 'uncleared').toLowerCase();
    const bankId   = req.query.bank_id ? parseInt(req.query.bank_id, 10) : null;
    const fromDate = req.query.from_date || null;
    const toDate   = req.query.to_date   || null;

    if (!['uncleared', 'cleared', 'all'].includes(status)) {
      return res.status(400).json({ error: 'status must be uncleared|cleared|all' });
    }

    // Build the cleared-status filter as raw SQL fragments. We can't
    // pass a JS expression as a Sequelize replacement here.
    const clearedClause =
      status === 'uncleared' ? 'pr.cleared_at IS NULL'  :
      status === 'cleared'   ? 'pr.cleared_at IS NOT NULL' :
      /* all */                'TRUE';

    const dateClause = (fromDate && toDate)
      ? 'AND le.entry_date BETWEEN :fromDate AND :toDate'
      : '';

    const bankClause = bankId
      ? 'AND la.ledger_id = :bankId'
      : 'AND la.sub_group IN (:subs)';

    // One trip. We join payments_receipts → ledger_entries (the bank
    // posting) → ledger_accounts (the bank ledger), pull splits + party,
    // and compute days_outstanding inline (today − entry_date).
    const rows = await sequelize.query(
      `SELECT pr.transaction_id,
              pr.cleared_at,
              pr.transaction_type,
              le.entry_id,
              le.entry_date::text  AS entry_date,
              le.debit_amount      AS debit,
              le.credit_amount     AS credit,
              le.narration,
              la.ledger_id         AS bank_id,
              la.ledger_name       AS bank_name,
              la.sub_group         AS bank_sub_group,
              p.party_id,
              p.party_name,
              ps.payment_mode,
              ps.cheque_number,
              ps.cheque_date::text AS cheque_date,
              ps.upi_transaction_id,
              (CURRENT_DATE - le.entry_date)::int AS days_outstanding
         FROM payments_receipts pr
         JOIN ledger_entries     le ON le.source_type = 'payment_receipt'
                                    AND le.reference_id = pr.transaction_id
         JOIN ledger_accounts    la ON la.ledger_id    = le.ledger_id
         LEFT JOIN parties        p ON p.party_id      = pr.party_id
         LEFT JOIN payment_splits ps ON ps.transaction_id = pr.transaction_id
        WHERE pr.is_cancelled = false
          AND le.reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries m
             WHERE m.reversal_of_id = le.entry_id
          )
          AND ${clearedClause}
          ${bankClause}
          ${dateClause}
        ORDER BY le.entry_date ASC, le.entry_id ASC`,
      {
        replacements: {
          subs:     BANK_SUB_GROUPS,
          ...(bankId   ? { bankId } : {}),
          ...(fromDate ? { fromDate } : {}),
          ...(toDate   ? { toDate } : {}),
        },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Pull the bank set so we can attach is_overdraft + emit a
    // per-bank summary even for banks that have zero uncleared rows
    // (they show as "all clear" tiles in the UI).
    const bankRows = await sequelize.query(
      `SELECT ledger_id, ledger_name, sub_group
         FROM ledger_accounts
        WHERE is_active = true
          AND sub_group IN (:subs)
        ORDER BY ledger_name ASC`,
      {
        replacements: { subs: BANK_SUB_GROUPS },
        type: sequelize.QueryTypes.SELECT,
      },
    );
    const bankMeta = new Map(bankRows.map((b) => [b.ledger_id, b]));

    // Map raw rows into UI-friendly entries with deposit / withdrawal
    // semantics flipped per OD bank. Same convention as the per-bank
    // statement so the operator's mental model carries over.
    const entries = rows.map((r) => {
      const isOd = r.bank_sub_group === 'Bank OD A/c';
      const debit  = num(r.debit);
      const credit = num(r.credit);
      const deposit    = isOd ? credit : debit;
      const withdrawal = isOd ? debit  : credit;
      const cheque = r.cheque_number || r.upi_transaction_id || null;
      return {
        transaction_id:    r.transaction_id,
        entry_id:          r.entry_id,
        entry_date:        r.entry_date,
        bank_id:           r.bank_id,
        bank_name:         r.bank_name,
        is_overdraft:      isOd,
        party:             r.party_name || null,
        narration:         r.narration  || null,
        cheque,
        mode:              r.payment_mode  || null,
        cheque_date:       r.cheque_date   || null,
        deposit:           r2(deposit),
        withdrawal:        r2(withdrawal),
        net:               r2(deposit - withdrawal),
        amount:            r2(Math.abs(deposit - withdrawal)),
        days_outstanding:  r.days_outstanding,
        cleared_at:        r.cleared_at,
        transaction_type:  r.transaction_type,
      };
    });

    // ── Per-bank summary. Every bank in the company appears here so
    // the UI can tile them all (count = 0 for clean banks → "all clear"
    // green tile; count > 0 → warning tile with the badge).
    const perBank = bankRows.map((b) => {
      const bankEntries = entries.filter((e) => e.bank_id === b.ledger_id);
      return {
        bank_id:    b.ledger_id,
        bank_name:  b.ledger_name,
        sub_group:  b.sub_group,
        is_overdraft: b.sub_group === 'Bank OD A/c',
        count:      bankEntries.length,
        value:      r2(bankEntries.reduce((s, e) => s + e.amount, 0)),
        // Net signed exposure: + means deposits-in-transit > withdrawals,
        // − means withdrawals-in-transit > deposits.  Useful for the
        // "expected bank balance" math.
        net_exposure: r2(bankEntries.reduce((s, e) => s + e.net, 0)),
      };
    });

    // ── Aging buckets. Classic accounting-style buckets keyed on days outstanding
    // since the entry was posted (proxy for "since the cheque was
    // issued"). 0-7 = fresh, this week. 90+ = chase these now.
    const buckets = {
      '0-7':   { count: 0, value: 0 },
      '8-30':  { count: 0, value: 0 },
      '31-90': { count: 0, value: 0 },
      '90+':   { count: 0, value: 0 },
    };
    for (const e of entries) {
      const d = e.days_outstanding;
      const bucket =
        d <= 7  ? '0-7' :
        d <= 30 ? '8-30' :
        d <= 90 ? '31-90' :
                  '90+';
      buckets[bucket].count += 1;
      buckets[bucket].value += e.amount;
    }
    for (const k of Object.keys(buckets)) buckets[k].value = r2(buckets[k].value);

    const totals = {
      count:        entries.length,
      value:        r2(entries.reduce((s, e) => s + e.amount, 0)),
      banks_affected: perBank.filter((b) => b.count > 0).length,
      oldest_days:  entries.reduce((m, e) => Math.max(m, e.days_outstanding || 0), 0),
      net_exposure: r2(entries.reduce((s, e) => s + e.net, 0)),
    };

    res.json({
      as_of:    new Date().toISOString().slice(0, 10),
      filters:  { status, bank_id: bankId, from_date: fromDate, to_date: toDate },
      entries,
      per_bank: perBank,
      aging:    buckets,
      totals,
    });
  } catch (err) {
    console.error('reconciliation error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Mark a payment_receipt as cleared / uncleared ───────────────────
//
// Audit M3: previously these handlers ran without an explicit
// transaction. Two concurrent calls — one markCleared, one
// markUncleared — could race: both load the row, both write back,
// last-writer wins. Now both endpoints take a transaction and a
// SELECT … FOR UPDATE on the row so the second call serialises
// behind the first.
exports.markCleared = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const txnId = parseInt(req.params.transaction_id, 10);
    if (!Number.isFinite(txnId)) {
      await t.rollback();
      return res.status(400).json({ error: 'Invalid transaction_id' });
    }

    // PAY-H6 — coerce cleared_at to a local-tz YYYY-MM-DD string so the
    // DATEONLY column doesn't shift a day on TZ-unaware servers. Same
    // pattern as backdatedGuard.dateKey().
    const rawClearedAt = req.body?.cleared_at;
    let clearedAtIso;
    if (!rawClearedAt) {
      const d = new Date();
      clearedAtIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } else if (typeof rawClearedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawClearedAt)) {
      clearedAtIso = rawClearedAt.slice(0, 10);
    } else {
      const d = new Date(rawClearedAt);
      if (Number.isNaN(d.getTime())) {
        await t.rollback();
        return res.status(400).json({ error: 'Invalid cleared_at date' });
      }
      clearedAtIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const r = await PaymentReceipt.findByPk(txnId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!r) {
      await t.rollback();
      return res.status(404).json({ error: 'Receipt/Payment not found' });
    }
    if (r.is_cancelled) {
      await t.rollback();
      return res.status(400).json({ error: 'Cannot clear a cancelled receipt' });
    }
    // PAY-H4 — cleared_at must not predate the transaction_date.
    const txnDateStr = r.transaction_date && String(r.transaction_date).slice(0, 10);
    if (txnDateStr && clearedAtIso < txnDateStr) {
      await t.rollback();
      return res.status(400).json({
        error: `Cleared date (${clearedAtIso}) cannot be before the transaction date (${txnDateStr}).`,
      });
    }
    // PAY-H4 — fiscal-lock guard so a closed FY can't be perturbed.
    const { applyFiscalLockGuard } = require('../utils/compliance');
    const lockGuard = await applyFiscalLockGuard(req, res, clearedAtIso);
    if (!lockGuard.ok) { await t.rollback(); return; }

    r.cleared_at = clearedAtIso;
    r.cleared_by = req.user?.user_id || null;
    await r.save({ transaction: t });

    // Audit BANK-4 — cascade the cleared flag to any linked Cheque row.
    // Pre-fix the receipt flipped to cleared but the Cheque Register
    // still showed DEPOSITED, so the "In Transit" KPI lied and the
    // bank-statement view drifted from the cheque-register view.
    try {
      const { Cheque } = require('../models');
      await Cheque.update(
        {
          status: 'CLEARED',
          clearance_date: clearedAtIso,  // PAY-H6: TZ-safe string, not new Date()
          cleared_by: req.user?.user_id || null,
        },
        {
          where: {
            source_payment_id: txnId,
            status: { [Op.notIn]: ['CANCELLED', 'BOUNCED', 'CLEARED'] },
          },
          transaction: t,
        },
      );
    } catch (e) {
      console.error('[bank.markCleared] Cheque cascade warn:', e.message);
    }

    await t.commit();

    res.json({
      ok: true,
      transaction_id: txnId,
      cleared_at: r.cleared_at,
      cleared_by: r.cleared_by,
    });
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('markCleared error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

exports.markUncleared = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const txnId = parseInt(req.params.transaction_id, 10);
    if (!Number.isFinite(txnId)) {
      await t.rollback();
      return res.status(400).json({ error: 'Invalid transaction_id' });
    }

    const r = await PaymentReceipt.findByPk(txnId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!r) {
      await t.rollback();
      return res.status(404).json({ error: 'Receipt/Payment not found' });
    }

    r.cleared_at = null;
    r.cleared_by = null;
    await r.save({ transaction: t });

    // Audit BANK-4 — reverse the cascade. Roll the linked Cheque back
    // to DEPOSITED so the register matches the un-cleared receipt.
    try {
      const { Cheque } = require('../models');
      await Cheque.update(
        { status: 'DEPOSITED', clearance_date: null, cleared_by: null },
        {
          where: { source_payment_id: txnId, status: 'CLEARED' },
          transaction: t,
        },
      );
    } catch (e) {
      console.error('[bank.markUncleared] Cheque cascade warn:', e.message);
    }

    await t.commit();

    res.json({ ok: true, transaction_id: txnId });
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('markUncleared error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Create a new bank ledger ────────────────────────────────────────
//
// Thin wrapper over LedgerAccount.create that enforces bank-specific
// invariants:
//
//   • sub_group must be 'Bank Accounts' or 'Bank OD A/c'
//   • ledger_group is derived (Assets / Liabilities) — not user input
//   • ledger_name is unique (case-insensitive); ledger_accounts has no
//     unique index, so we check explicitly to give a friendly error
//     instead of letting a duplicate sneak in
//   • is_system_ledger always false (only seeders set true)
//
// The opening balance is stored on the row itself; all subsequent
// balance reads reconstruct from opening + entries. So the moment the
// bank is created, its current_balance equals the opening — and the
// list endpoint will show it that way.
exports.createBank = async (req, res) => {
  try {
    const {
      name,
      sub_group,
      opening_balance = 0,
      opening_balance_type = 'Debit',
    } = req.body || {};

    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Bank name is required' });
    if (cleanName.length > 100) return res.status(400).json({ error: 'Bank name is too long (max 100 chars)' });

    if (!BANK_SUB_GROUPS.includes(sub_group)) {
      return res.status(400).json({
        error: `Invalid sub_group "${sub_group}". Must be one of: ${BANK_SUB_GROUPS.join(', ')}`,
      });
    }
    const ledgerGroup = SUBGROUP_TO_GROUP[sub_group];

    if (!['Debit', 'Credit'].includes(opening_balance_type)) {
      return res.status(400).json({ error: 'opening_balance_type must be Debit or Credit' });
    }
    const opening = parseFloat(opening_balance) || 0;
    if (opening < 0) return res.status(400).json({ error: 'Opening balance cannot be negative — flip the type instead' });

    // Case-insensitive uniqueness — operators expect 'HDFC' and 'hdfc'
    // to collide.  Postgres's ILIKE handles the locale folding.
    const existing = await sequelize.query(
      `SELECT ledger_id FROM ledger_accounts WHERE LOWER(ledger_name) = LOWER(:name) LIMIT 1`,
      { replacements: { name: cleanName }, type: sequelize.QueryTypes.SELECT },
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: `A ledger named "${cleanName}" already exists` });
    }

    const created = await LedgerAccount.create({
      ledger_name:           cleanName,
      ledger_group:          ledgerGroup,
      sub_group,
      opening_balance:       opening,
      opening_balance_type,
      current_balance:       opening_balance_type === 'Credit' ? -opening : opening,
      is_active:             true,
      is_system_ledger:      false,
    });

    res.status(201).json({
      ledger_id:            created.ledger_id,
      name:                 created.ledger_name,
      sub_group:            created.sub_group,
      is_overdraft:         created.sub_group === 'Bank OD A/c',
      is_active:            created.is_active,
      is_system_ledger:     created.is_system_ledger,
      opening_balance:      parseFloat(created.opening_balance) || 0,
      opening_balance_type: created.opening_balance_type,
      balance:              parseFloat(created.current_balance) || 0,
      balance_side:         (parseFloat(created.current_balance) || 0) >= 0 ? 'Dr' : 'Cr',
      last_txn_date:        null,
      monthly_inflow:       0,
      monthly_outflow:      0,
      uncleared_count:      0,
      uncleared_value:      0,
      txn_count:            0,
    });
  } catch (err) {
    console.error('createBank error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Update a bank ledger ────────────────────────────────────────────
//
// Patch semantics — only fields present in the body are applied.
// Allowed fields:
//
//   name           — rename. Same uniqueness rule as create.
//   sub_group      — switch between 'Bank Accounts' and 'Bank OD A/c'.
//                    Allowed only when txn_count = 0 (changing the
//                    classification of an account that already has
//                    history would silently shuffle entries between
//                    Assets and Liabilities on the trial balance).
//   opening_balance / opening_balance_type — adjust the seed.
//   is_active      — true/false toggle. The same endpoint covers
//                    Activate (is_active=true) and Deactivate (false),
//                    so the UI can use a single PATCH.
exports.updateBank = async (req, res) => {
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) return res.status(400).json({ error: 'Invalid ledger_id' });

    const acc = await LedgerAccount.findByPk(ledgerId);
    if (!acc) return res.status(404).json({ error: 'Bank not found' });
    if (!BANK_SUB_GROUPS.includes(acc.sub_group)) {
      return res.status(400).json({ error: `Ledger "${acc.ledger_name}" is not a bank account` });
    }

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
      const newName = String(body.name).trim();
      if (!newName) return res.status(400).json({ error: 'Bank name cannot be empty' });
      if (newName.length > 100) return res.status(400).json({ error: 'Bank name is too long' });
      // Audit LOAN-5 — refuse to rename a SYSTEM ledger. Downstream
      // code (loanController.recordEMI, voucherBuilders system-ledger
      // lookups) resolves these by ledger_name; allowing a rename
      // would silently break EMI posting and break voucher posting
      // for the 'Bank Account' fallback path.
      if (acc.is_system_ledger && newName.toLowerCase() !== acc.ledger_name.toLowerCase()) {
        return res.status(400).json({
          error: `"${acc.ledger_name}" is a system ledger and cannot be renamed. Renaming would break automated postings (EMIs, expense vouchers) that look it up by name.`,
          code: 'SYSTEM_LEDGER_RENAME_BLOCKED',
        });
      }
      if (newName.toLowerCase() !== acc.ledger_name.toLowerCase()) {
        const dup = await sequelize.query(
          `SELECT ledger_id FROM ledger_accounts
            WHERE LOWER(ledger_name) = LOWER(:n) AND ledger_id <> :id LIMIT 1`,
          { replacements: { n: newName, id: ledgerId }, type: sequelize.QueryTypes.SELECT },
        );
        if (dup.length > 0) return res.status(409).json({ error: `A ledger named "${newName}" already exists` });
      }
      updates.ledger_name = newName;
    }

    if (body.sub_group !== undefined) {
      if (!BANK_SUB_GROUPS.includes(body.sub_group)) {
        return res.status(400).json({ error: `Invalid sub_group "${body.sub_group}"` });
      }
      if (body.sub_group !== acc.sub_group) {
        // Only allow re-classification if no entries have been posted.
        const [{ cnt }] = await sequelize.query(
          `SELECT COUNT(*)::int AS cnt FROM ledger_entries WHERE ledger_id = :id`,
          { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT },
        );
        if (cnt > 0) {
          return res.status(409).json({
            error: `Cannot change account type — ${cnt} entries already posted to this bank. ` +
                   `Re-classifying would silently flip Asset↔Liability on the Trial Balance.`,
          });
        }
        updates.sub_group    = body.sub_group;
        updates.ledger_group = SUBGROUP_TO_GROUP[body.sub_group];
      }
    }

    if (body.opening_balance !== undefined || body.opening_balance_type !== undefined) {
      const opening = body.opening_balance !== undefined
        ? (parseFloat(body.opening_balance) || 0)
        : parseFloat(acc.opening_balance) || 0;
      const obType = body.opening_balance_type !== undefined
        ? body.opening_balance_type : acc.opening_balance_type;
      if (!['Debit', 'Credit'].includes(obType)) {
        return res.status(400).json({ error: 'opening_balance_type must be Debit or Credit' });
      }
      if (opening < 0) return res.status(400).json({ error: 'Opening balance cannot be negative' });
      updates.opening_balance      = opening;
      updates.opening_balance_type = obType;
    }

    if (body.is_active !== undefined) {
      // System ledgers can't be deactivated — they're referenced by
      // hardcoded fallback paths in voucherBuilders. Allow renaming /
      // opening edits but not lifecycle.
      if (acc.is_system_ledger && body.is_active === false) {
        return res.status(400).json({
          error: `Cannot deactivate "${acc.ledger_name}" — it's a system ledger used by fallback voucher posting.`,
        });
      }
      updates.is_active = !!body.is_active;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await acc.update(updates);

    res.json({
      ok:                   true,
      ledger_id:            acc.ledger_id,
      name:                 acc.ledger_name,
      sub_group:            acc.sub_group,
      is_active:            acc.is_active,
      opening_balance:      parseFloat(acc.opening_balance) || 0,
      opening_balance_type: acc.opening_balance_type,
    });
  } catch (err) {
    console.error('updateBank error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Delete a bank ledger ────────────────────────────────────────────
//
// Hard-delete only when no live entries reference the ledger. The
// txn_count check covers the common path; we also guard against:
//
//   • System ledgers — never deletable; voucher fallback depends on them
//   • payment_splits.bank_ledger_id  → would orphan FKs
//   • sales_bills.bank_ledger_id     → same
//
// On conflict we return 409 with a `txn_count` so the UI can switch its
// modal copy to "Cannot delete — N transactions exist. Deactivate
// instead?"
exports.deleteBank = async (req, res) => {
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) return res.status(400).json({ error: 'Invalid ledger_id' });

    const acc = await LedgerAccount.findByPk(ledgerId);
    if (!acc) return res.status(404).json({ error: 'Bank not found' });
    if (!BANK_SUB_GROUPS.includes(acc.sub_group)) {
      return res.status(400).json({ error: `Ledger "${acc.ledger_name}" is not a bank account` });
    }
    if (acc.is_system_ledger) {
      return res.status(400).json({
        error: `Cannot delete "${acc.ledger_name}" — it's the system fallback bank ledger.`,
      });
    }

    // Check live entries on the ledger.
    const [{ entry_cnt }] = await sequelize.query(
      `SELECT COUNT(*)::int AS entry_cnt FROM ledger_entries WHERE ledger_id = :id`,
      { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT },
    );
    // Check FK references from payment_splits and sales_bills (these
    // could exist even if no ledger_entry was posted yet — defensive).
    const [{ split_cnt }] = await sequelize.query(
      `SELECT COUNT(*)::int AS split_cnt FROM payment_splits WHERE bank_ledger_id = :id`,
      { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT },
    );
    const [{ bill_cnt }] = await sequelize.query(
      `SELECT COUNT(*)::int AS bill_cnt FROM sales_bills WHERE bank_ledger_id = :id`,
      { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT },
    );
    // Audit (banking M1) — also check cheques.bank_ledger_id. A PENDING
    // INWARD cheque doesn't yet have a posted ledger_entry on the bank
    // (the receipt voucher hit "Cheques in Hand"), so the entry_cnt guard
    // doesn't catch it. Pre-fix, deleting the bank silently SET NULL'd the
    // cheque's bank reference, breaking the cheque register audit trail.
    const [{ cheque_cnt }] = await sequelize.query(
      `SELECT COUNT(*)::int AS cheque_cnt FROM cheques
        WHERE bank_ledger_id = :id AND status <> 'CANCELLED'`,
      { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT },
    );
    const totalRefs = entry_cnt + split_cnt + bill_cnt + cheque_cnt;

    if (totalRefs > 0) {
      return res.status(409).json({
        error: `Cannot delete "${acc.ledger_name}" — it has ${entry_cnt} ledger entries, ` +
               `${split_cnt} payment splits, ${bill_cnt} sales bills, and ${cheque_cnt} cheques referencing it. ` +
               `Deactivate instead to hide it from new transactions while preserving history.`,
        txn_count:    entry_cnt,
        split_count:  split_cnt,
        bill_count:   bill_cnt,
        cheque_count: cheque_cnt,
        suggest_deactivate: true,
      });
    }

    await acc.destroy();
    res.json({ ok: true, ledger_id: ledgerId, name: acc.ledger_name });
  } catch (err) {
    console.error('deleteBank error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
