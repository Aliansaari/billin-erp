// ── Ledger Statement Service ────────────────────────────────────────────
//
// Single source of truth for "show me the voucher-level statement of one
// ledger account over a date range". Backs:
//
//   • /reports/customer-statement   (party-backed ledger, customer side)
//   • /reports/supplier-statement   (party-backed ledger, supplier side)
//   • /reports/ledger               (any chart-of-accounts ledger)
//
// All three pages render through one React component (LedgerStatement.jsx)
// — keeping the data shape consistent here means a column tweak in the UI
// works for every page.
//
// ── Data source: ledger_entries ─────────────────────────────────────────
// We query ledger_entries (the financial source of truth, append-only)
// rather than the bill tables. The earlier party-ledger code in
// partyController.getLedger() pre-dated the ledger_entries posting
// service and hand-rolled its own period-opening calculation from
// SalesBill / PurchaseBill / PaymentReceipt totals; that worked but
// duplicated logic and only handled party-backed ledgers.
//
// Reading from ledger_entries gives us:
//   1. Same engine for COA accounts (Office Rent, Bank, Sales A/c, etc.)
//      and parties — both already post here.
//   2. Correct handling of journal vouchers, contras, and reversals
//      without per-source-type code paths.
//   3. Pre-period entries can be aggregated with one indexed sum.
//
// ── Reversal handling ──────────────────────────────────────────────────
// ledger_entries is append-only; an "edit" or "cancel" inserts a mirror
// entry with reversal_of_id pointing back. The "active" view (what an
// accountant actually wants to see) excludes both halves of any
// reversed pair — same predicate as ledgerController.integrity:
//   reversal_of_id IS NULL                    -- not a reversal row
//   AND NOT EXISTS (mirror with reversal_of_id = self.entry_id)
//
// Without this filter, statements double-count cancelled vouchers.

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { LedgerAccount, LedgerEntry, Party } = require('../models');

// Active-entries SQL fragment shared between the opening sum and the
// in-period fetch. Kept as a raw string because Sequelize's NOT EXISTS
// support requires `literal()` boilerplate that obscures intent here.
const ACTIVE_PREDICATE = `
  reversal_of_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM ledger_entries m
     WHERE m.reversal_of_id = ledger_entries.entry_id
  )
`;

/**
 * Build a ledger statement.
 *
 * @param {number}  ledgerId       LedgerAccount.ledger_id
 * @param {object}  opts
 * @param {string?} opts.fromDate  YYYY-MM-DD (inclusive). Omit → all-time
 *                                 statement starting from account opening.
 * @param {string?} opts.toDate    YYYY-MM-DD (inclusive).
 *
 * Returns:
 *   {
 *     account: { ledger_id, ledger_name, ledger_group, sub_group,
 *                is_party_ledger, is_system_ledger, party_id },
 *     party:   Party | null   // populated when account is party-backed
 *     period:  { from, to },
 *     opening_balance:  number  // signed: +Dr, −Cr
 *     entries: [{
 *       entry_id, date, voucher_type, voucher_no (= reference_number),
 *       narration, source_type, reference_id,
 *       debit, credit, balance,    // running, signed
 *     }],
 *     total_debit:    number,
 *     total_credit:   number,
 *     closing_balance: number,
 *   }
 */
async function getLedgerStatement(ledgerId, opts = {}) {
  const { fromDate, toDate } = opts;

  const account = await LedgerAccount.findByPk(ledgerId);
  if (!account) {
    const err = new Error('Ledger account not found');
    err.status = 404;
    throw err;
  }

  // Signed all-time opening from the account's seed value. opening_balance
  // is stored unsigned; the *_type column carries the sign convention.
  const seedSigned =
    (account.opening_balance_type === 'Credit' ? -1 : 1) *
    (parseFloat(account.opening_balance) || 0);

  // Sum of pre-period activity. Active rows only (excludes reversed).
  // ledger_entries is partitioned by ledger_id (well-indexed) so this
  // is a single index scan even on multi-million-row books.
  let preActivity = 0;
  if (fromDate) {
    const [row] = await sequelize.query(
      `SELECT COALESCE(SUM(debit_amount - credit_amount), 0)::float AS net
         FROM ledger_entries
        WHERE ledger_id = :ledgerId
          AND entry_date < :fromDate
          AND ${ACTIVE_PREDICATE}`,
      {
        replacements: { ledgerId, fromDate },
        type: sequelize.QueryTypes.SELECT,
      },
    );
    preActivity = parseFloat(row.net) || 0;
  }
  const periodOpening = +(seedSigned + preActivity).toFixed(2);

  // In-period entries. Same active predicate. Ordered by date then entry_id
  // so a same-day Sales→Receipt sequence renders in the order it was posted.
  const entries = await LedgerEntry.findAll({
    where: {
      ledger_id: ledgerId,
      ...(fromDate || toDate ? {
        entry_date: {
          ...(fromDate && { [Op.gte]: fromDate }),
          ...(toDate   && { [Op.lte]: toDate   }),
        },
      } : {}),
      reversal_of_id: { [Op.is]: null },
      [Op.and]: sequelize.literal(`NOT EXISTS (
        SELECT 1 FROM ledger_entries m
         WHERE m.reversal_of_id = "LedgerEntry".entry_id
      )`),
    },
    order: [['entry_date', 'ASC'], ['entry_id', 'ASC']],
    raw: true,
  });

  // Running balance + totals in one pass.
  let running = periodOpening;
  let totalDebit = 0;
  let totalCredit = 0;
  const formatted = entries.map(e => {
    const debit  = parseFloat(e.debit_amount)  || 0;
    const credit = parseFloat(e.credit_amount) || 0;
    running    += debit - credit;
    totalDebit  += debit;
    totalCredit += credit;
    return {
      entry_id:        e.entry_id,
      date:            e.entry_date,
      voucher_type:    e.voucher_type,
      voucher_no:      e.reference_number,
      narration:       e.narration,
      source_type:     e.source_type,
      reference_id:    e.reference_id,
      debit, credit,
      balance:         +running.toFixed(2),
    };
  });

  // Party enrichment — only when the account is party-backed. Customer /
  // Supplier Statement pages need the full party record (mobile, address,
  // gstin, credit_limit, status) for the letterhead + WhatsApp + status
  // pill. COA Ledger callers can ignore this field.
  let party = null;
  if (account.is_party_ledger && account.party_id) {
    party = await Party.findByPk(account.party_id);
  }

  return {
    account: {
      ledger_id:        account.ledger_id,
      ledger_name:      account.ledger_name,
      ledger_group:     account.ledger_group,
      sub_group:        account.sub_group,
      is_party_ledger:  account.is_party_ledger,
      is_system_ledger: account.is_system_ledger,
      party_id:         account.party_id,
    },
    party,
    period:           { from: fromDate || null, to: toDate || null },
    opening_balance:  periodOpening,
    entries:          formatted,
    total_debit:      +totalDebit.toFixed(2),
    total_credit:     +totalCredit.toFixed(2),
    closing_balance:  +running.toFixed(2),
  };
}

/**
 * Resolve a Party.party_id to its backing LedgerAccount.ledger_id.
 *
 * Customer/Supplier Statement pages take a party_id from the URL or
 * picker and need the matching ledger to pass to getLedgerStatement.
 * Returns null when no backing ledger exists (which is an integrity
 * issue — every party should have one once auto-creation is applied).
 */
async function resolveLedgerForParty(partyId) {
  const account = await LedgerAccount.findOne({
    where: { party_id: partyId, is_party_ledger: true, is_active: true },
    attributes: ['ledger_id'],
  });
  return account ? account.ledger_id : null;
}

module.exports = { getLedgerStatement, resolveLedgerForParty };
