// ── Loans Controller ───────────────────────────────────────────────────
//
// Loans piggy-back on the regular ledger_accounts table — every loan is
// a real ledger so it appears in the trial balance, ledger statement,
// journal posting, etc. The loan-specific metadata (principal, rate,
// tenure, EMI dates) lives in `loan_accounts` linked 1:1 by ledger_id.
//
// Sub-groups:
//   • taken → 'Loans (Liability)'        (Cr-natured, principal owed to lender)
//   • given → 'Loans & Advances (Asset)' (Dr-natured, principal owed by borrower)
//
// Endpoints:
//   GET    /api/loans                       list all loans + metrics
//   GET    /api/loans/upcoming              cross-loan upcoming EMIs (LoanSchedule page)
//   GET    /api/loans/:id/statement         loan-flavoured ledger statement
//   GET    /api/loans/:id/schedule          amortization schedule (paid/unpaid markers)
//   POST   /api/loans                       create new loan
//   PATCH  /api/loans/:id                   edit / activate / deactivate
//   DELETE /api/loans/:id                   delete (with txn-count guard)
//   POST   /api/loans/:id/emi               record an EMI payment

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  LedgerAccount, LedgerEntry, LoanAccount, Party,
} = require('../models');
const { getLedgerStatement } = require('../services/ledgerStatementService');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');

const LOAN_SUBGROUPS = {
  taken: 'Loans (Liability)',
  given: 'Loans & Advances (Asset)',
};
const LOAN_SUBGROUP_VALUES = Object.values(LOAN_SUBGROUPS);
const SUBGROUP_TO_GROUP = {
  'Loans (Liability)':         'Liabilities',
  'Loans & Advances (Asset)':  'Assets',
};

function num(v)  { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function r2(v)   { return Math.round(num(v) * 100) / 100; }
function todayIso() { return new Date().toISOString().slice(0, 10); }

// ── EMI maths ──────────────────────────────────────────────────────
//
// Standard amortization formula:
//   EMI = P × r × (1+r)^n / ((1+r)^n − 1)
// where r is the monthly interest rate (annual ÷ 12 ÷ 100) and n is
// the number of months. Edge case: r = 0 → straight division.
//
// Returns the EMI rounded to 2dp. Operators may override with their
// bank's quoted EMI; this is the formula default.
function computeEmi(principal, annualRatePct, tenureMonths) {
  const P = num(principal);
  const n = parseInt(tenureMonths, 10);
  const annual = num(annualRatePct);
  if (P <= 0 || n <= 0) return 0;
  if (annual === 0) return r2(P / n);
  const r = annual / 12 / 100;
  const factor = Math.pow(1 + r, n);
  return r2(P * r * factor / (factor - 1));
}

// Compute the full amortization table from loan terms. Each row:
// { emi_no, due_date (YYYY-MM-DD), opening, interest, principal, closing, emi }.
//
// Operates purely on the agreed terms — does NOT consult ledger_entries.
// The "actual paid vs scheduled" merge happens in loanSchedule().
function buildSchedule(loan) {
  const P = num(loan.principal);
  const n = parseInt(loan.tenure_months, 10);
  const annual = num(loan.interest_rate);
  const emi = num(loan.emi_amount) || computeEmi(P, annual, n);
  const r = annual / 12 / 100;
  if (P <= 0 || n <= 0 || !loan.first_emi_date || emi <= 0) return [];

  const rows = [];
  let outstanding = P;
  // Iterate by month from first_emi_date.
  const baseDate = new Date(loan.first_emi_date);
  // Audit H10: emit ALL n rows so Σ principal across the schedule
  // equals the original principal exactly. Previously the
  // `if (outstanding <= 0.005) break` could exit BEFORE i=n in a
  // high-rate / short-tenure loan when rounding pushed `outstanding`
  // to ~0 early — the "i === n absorbs drift" branch never ran and
  // Σprincipal undershot principal. Now we always run the loop to n
  // and let the i===n branch top up any sub-paisa drift.
  for (let i = 1; i <= n; i++) {
    const due = new Date(baseDate);
    due.setMonth(due.getMonth() + (i - 1));
    const dueIso = due.toISOString().slice(0, 10);

    const interestPart = r2(Math.max(0, outstanding) * r);
    let principalPart = r2(emi - interestPart);
    // Last EMI absorbs any rounding drift so Σprincipal == P.
    if (i === n) principalPart = r2(Math.max(0, outstanding));
    const closing = r2(outstanding - principalPart);
    rows.push({
      emi_no:     i,
      due_date:   dueIso,
      opening:    r2(Math.max(0, outstanding)),
      interest:   interestPart,
      principal:  principalPart,
      closing:    Math.max(0, closing),
      // EMI recomputed from the actual principal+interest split for
      // this row — the last row may differ from `loan.emi_amount` by
      // a few paise due to rounding absorption, and the schedule
      // should report what *will* post, not the bank-quoted EMI.
      emi:        r2(principalPart + interestPart),
    });
    outstanding = closing;
    // Don't early-break — see comment above. If outstanding hits 0
    // before i=n, subsequent rows will simply have zero
    // principal/interest, which is harmless.
  }
  return rows;
}

// ── List all loans with action-relevant metrics ────────────────────
//
// One row per loan ledger. Computes:
//   • outstanding (book balance, signed by loan_type)
//   • principal_paid / interest_paid (sums of source='loan_emi' lines
//     touching this loan vs interest ledgers)
//   • emi_count (how many EMIs have been recorded)
//   • next_emi_date (computed from schedule, first unpaid)
//
// Default returns active loans only; ?include_inactive=true returns
// retired ones too (for the management page).
exports.listLoans = async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || '').toLowerCase() === 'true';
    const activeClause = includeInactive ? '' : 'AND la.is_active = true';

    const rows = await sequelize.query(
      `SELECT la.ledger_id,
              la.ledger_name,
              la.sub_group,
              la.is_active,
              la.is_system_ledger,
              la.opening_balance,
              la.opening_balance_type,
              ln.loan_id,
              ln.loan_type,
              ln.party_id,
              ln.principal,
              ln.interest_rate,
              ln.tenure_months,
              ln.disbursement_date::text  AS disbursement_date,
              ln.first_emi_date::text     AS first_emi_date,
              ln.emi_amount,
              ln.emi_day,
              p.party_name,

              -- Live signed net (Dr − Cr).  Sign convention same as
              -- ledger_accounts: + = Dr, − = Cr.
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

              -- Count of EMI entries posted against this loan ledger.
              -- We use source_type='loan_emi' as the canonical marker
              -- (postVoucher tags entries with this type when called
              -- from recordEMI).
              COALESCE((
                SELECT COUNT(DISTINCT le.reference_id)::int
                  FROM ledger_entries le
                 WHERE le.ledger_id = la.ledger_id
                   AND le.source_type = 'loan_emi'
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ), 0)::int AS emi_count,

              -- Sum of interest leg over all EMIs for this loan. We
              -- find sibling lines on each EMI voucher that touch the
              -- Interest Expense / Interest Income ledger.
              COALESCE((
                SELECT SUM(CASE WHEN le.debit_amount > 0 THEN le.debit_amount ELSE le.credit_amount END)
                  FROM ledger_entries le
                  JOIN ledger_accounts ila ON ila.ledger_id = le.ledger_id
                                           AND ila.ledger_name IN ('Interest Expense','Interest Income')
                 WHERE le.source_type = 'loan_emi'
                   AND le.reference_id IN (
                     SELECT DISTINCT le2.reference_id FROM ledger_entries le2
                      WHERE le2.ledger_id = la.ledger_id
                        AND le2.source_type = 'loan_emi'
                   )
                   AND le.reversal_of_id IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM ledger_entries m
                      WHERE m.reversal_of_id = le.entry_id
                   )
              ), 0)::float AS interest_paid,

              -- Last EMI entry date, useful for "last activity".
              (
                SELECT MAX(le.entry_date)::text
                  FROM ledger_entries le
                 WHERE le.ledger_id = la.ledger_id
                   AND le.source_type = 'loan_emi'
                   AND le.reversal_of_id IS NULL
              ) AS last_emi_date
         FROM ledger_accounts la
         JOIN loan_accounts   ln ON ln.ledger_id = la.ledger_id
         LEFT JOIN parties     p ON p.party_id   = ln.party_id
        WHERE la.sub_group IN (:subs)
          ${activeClause}
        ORDER BY la.is_active DESC, la.ledger_name ASC`,
      {
        replacements: { subs: LOAN_SUBGROUP_VALUES },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Per-row shaping: compute outstanding (signed by loan type),
    // enrich with EMI count + next due, and the entry count gate.
    const banks = rows.map((r) => {
      const seedSigned =
        (r.opening_balance_type === 'Credit' ? -1 : 1) *
        (parseFloat(r.opening_balance) || 0);
      // For loan TAKEN (liability): ledger sits at Cr balance.
      //   ledger_net is negative (Σ(Dr-Cr) < 0). Outstanding = |signed total|
      //   = |seed + net|.
      // For loan GIVEN (asset): ledger sits at Dr balance.
      //   Outstanding = signed total (positive).
      const signed = seedSigned + num(r.ledger_net);
      const outstanding = r.loan_type === 'taken' ? r2(-signed) : r2(signed);

      const principal       = parseFloat(r.principal) || 0;
      const principalPaid   = r2(principal - outstanding);
      const interestPaid    = r2(r.interest_paid);
      const totalPaid       = r2(principalPaid + interestPaid);

      // Build a lightweight schedule just to extract next-due info; the
      // full schedule is computed on demand by /api/loans/:id/schedule.
      const schedule = buildSchedule({
        principal,
        interest_rate:  parseFloat(r.interest_rate) || 0,
        tenure_months:  r.tenure_months,
        first_emi_date: r.first_emi_date,
        emi_amount:     parseFloat(r.emi_amount) || null,
      });
      const nextEmi = schedule[r.emi_count] || null;
      const today = new Date(todayIso());
      const overdue = nextEmi ? (new Date(nextEmi.due_date) < today) : false;

      return {
        ledger_id:        r.ledger_id,
        loan_id:          r.loan_id,
        name:             r.ledger_name,
        loan_type:        r.loan_type,
        sub_group:        r.sub_group,
        is_active:        r.is_active,
        is_system_ledger: r.is_system_ledger,
        party_id:         r.party_id,
        party_name:       r.party_name,
        principal:        r2(principal),
        interest_rate:    parseFloat(r.interest_rate) || 0,
        tenure_months:    r.tenure_months,
        emi_amount:       parseFloat(r.emi_amount) || computeEmi(principal, r.interest_rate, r.tenure_months),
        emi_day:          r.emi_day,
        disbursement_date: r.disbursement_date,
        first_emi_date:   r.first_emi_date,
        outstanding,
        principal_paid:   Math.max(0, principalPaid),
        interest_paid:    Math.max(0, interestPaid),
        total_paid:       Math.max(0, totalPaid),
        emi_count:        r.emi_count,
        emi_total:        r.tenure_months,
        emi_remaining:    Math.max(0, r.tenure_months - r.emi_count),
        next_emi_date:    nextEmi?.due_date || null,
        next_emi_amount:  nextEmi?.emi || null,
        overdue,
        last_emi_date:    r.last_emi_date,
        // Closed = principal fully paid down, regardless of any
        // residual rounding paisas. Helps the UI grey out finished
        // loans without retiring them outright.
        is_closed:        outstanding < 1 && r.emi_count >= r.tenure_months,
        // Entries on the loan ledger (any source). Drives the
        // delete-vs-deactivate gate.
        txn_count:        r.emi_count,
      };
    });

    const activeBanks = banks.filter((b) => b.is_active);
    const totals = {
      loan_count:           activeBanks.length,
      inactive_count:       banks.length - activeBanks.length,
      total_outstanding:    r2(activeBanks.reduce((s, b) => s + b.outstanding, 0)),
      total_principal:      r2(activeBanks.reduce((s, b) => s + b.principal, 0)),
      total_interest_paid:  r2(activeBanks.reduce((s, b) => s + b.interest_paid, 0)),
      total_principal_paid: r2(activeBanks.reduce((s, b) => s + b.principal_paid, 0)),
      taken_count:          activeBanks.filter((b) => b.loan_type === 'taken').length,
      given_count:          activeBanks.filter((b) => b.loan_type === 'given').length,
      overdue_count:        activeBanks.filter((b) => b.overdue && !b.is_closed).length,
    };

    res.json({ as_of: todayIso(), loans: banks, totals });
  } catch (err) {
    console.error('listLoans error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Loan statement (loan-flavoured ledger statement) ───────────────
//
// Each statement row gets its EMI broken out into:
//   • principal_part — the leg that hit this loan ledger
//   • interest_part  — the SIBLING leg on Interest Expense / Income
//                      that belonged to the same EMI voucher
//   • emi_total      — principal_part + interest_part
//
// The frontend renders these in dedicated columns instead of burying
// "interest ₹833" in the narration. Disbursement rows (the initial
// loan in / out) have interest_part=0 and emi_total=principal_part.
exports.loanStatement = async (req, res) => {
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) return res.status(400).json({ error: 'Invalid ledger_id' });

    const account = await LedgerAccount.findByPk(ledgerId);
    if (!account) return res.status(404).json({ error: 'Loan ledger not found' });
    if (!LOAN_SUBGROUP_VALUES.includes(account.sub_group)) {
      return res.status(400).json({
        error: `Ledger "${account.ledger_name}" is not a loan account.`,
      });
    }
    const loan = await LoanAccount.findOne({
      where: { ledger_id: ledgerId },
      include: [{ model: Party, as: 'party', attributes: ['party_id', 'party_name'] }],
    });

    const { from_date, to_date } = req.query || {};
    const stmt = await getLedgerStatement(ledgerId, {
      fromDate: from_date || null,
      toDate:   to_date   || null,
    });

    // Sign convention: for taken loans (liability) the operator wants
    // the running balance read as "outstanding" (positive). For given
    // loans (asset) it's already positive Dr.
    const isTaken = loan?.loan_type === 'taken';
    const closingForLoan = isTaken ? -stmt.closing_balance : stmt.closing_balance;
    const openingForLoan = isTaken ? -stmt.opening_balance : stmt.opening_balance;

    // Pull the interest-leg amount per EMI voucher. Interest sits on
    // 'Interest Expense' (taken) or 'Interest Income' (given). We
    // batch this into one round trip — far cheaper than a per-row
    // sub-query, even on a 60-month loan.
    const emiSourceIds = stmt.entries
      .filter((e) => e.source_type === 'loan_emi')
      .map((e) => e.reference_id)
      .filter((id) => id != null);

    const interestByRef = new Map();
    if (emiSourceIds.length > 0) {
      const interestLedgerName = isTaken ? 'Interest Expense' : 'Interest Income';
      const intRows = await sequelize.query(
        `SELECT le.reference_id, le.debit_amount, le.credit_amount
           FROM ledger_entries le
           JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
          WHERE la.ledger_name = :name
            AND le.source_type = 'loan_emi'
            AND le.reference_id IN (:ids)
            AND le.reversal_of_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id
            )`,
        {
          replacements: { name: interestLedgerName, ids: emiSourceIds },
          type: sequelize.QueryTypes.SELECT,
        },
      );
      for (const r of intRows) {
        const amt = isTaken ? num(r.debit_amount) : num(r.credit_amount);
        interestByRef.set(r.reference_id, (interestByRef.get(r.reference_id) || 0) + amt);
      }
    }

    let totalInterestPaid = 0;
    let totalPrincipalPaid = 0;
    const enriched = stmt.entries.map((e) => {
      // Principal part on this loan ledger.
      // For TAKEN: Dr line on the loan = principal repaid. Cr = disbursed (or top-up).
      // For GIVEN: Cr line = principal recovered. Dr = disbursed out.
      const dr = num(e.debit);
      const cr = num(e.credit);
      const principalPart = isTaken ? dr : cr;
      // The "other side" — disbursement or further extension.
      const disbursementPart = isTaken ? cr : dr;

      const interestPart = e.source_type === 'loan_emi'
        ? r2(interestByRef.get(e.reference_id) || 0)
        : 0;

      if (e.source_type === 'loan_emi') {
        totalInterestPaid  += interestPart;
        totalPrincipalPaid += principalPart;
      }

      return {
        ...e,
        balance:           r2(isTaken ? -e.balance : e.balance),
        principal_part:    r2(principalPart),
        interest_part:     interestPart,
        emi_total:         r2(principalPart + interestPart),
        disbursement_part: r2(disbursementPart),
        is_emi:            e.source_type === 'loan_emi',
      };
    });

    res.json({
      account: { ...stmt.account },
      loan:    loan ? {
        loan_id:          loan.loan_id,
        loan_type:        loan.loan_type,
        principal:        parseFloat(loan.principal) || 0,
        interest_rate:    parseFloat(loan.interest_rate) || 0,
        tenure_months:    loan.tenure_months,
        emi_amount:       parseFloat(loan.emi_amount) || computeEmi(loan.principal, loan.interest_rate, loan.tenure_months),
        emi_day:          loan.emi_day,
        disbursement_date: loan.disbursement_date,
        first_emi_date:   loan.first_emi_date,
        party:            loan.party ? { id: loan.party.party_id, name: loan.party.party_name } : null,
        notes:            loan.notes,
      } : null,
      period:           stmt.period,
      opening_balance:  r2(openingForLoan),
      entries:          enriched,
      totals: {
        total_debit:        r2(stmt.totals?.debit_total || 0),
        total_credit:       r2(stmt.totals?.credit_total || 0),
        closing_balance:    r2(closingForLoan),
        balance_side:       closingForLoan >= 0 ? (isTaken ? 'Cr' : 'Dr') : (isTaken ? 'Dr' : 'Cr'),
        // Direct fields for the banner — no more wonky derivation in
        // the frontend.
        principal_paid:     r2(totalPrincipalPaid),
        interest_paid:      r2(totalInterestPaid),
        total_paid:         r2(totalPrincipalPaid + totalInterestPaid),
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('loanStatement error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Amortization schedule with paid/unpaid markers ─────────────────
//
// Returns the full computed schedule for the loan PLUS paid status per
// row.  Paid status is computed by counting EMI entries on the loan
// ledger and marking the first N rows of the schedule as "paid",
// where N = emi_count.  This is the simplest, robust mapping; it
// assumes EMIs are recorded in order which is the realistic case.
exports.loanSchedule = async (req, res) => {
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) return res.status(400).json({ error: 'Invalid ledger_id' });

    const loan = await LoanAccount.findOne({ where: { ledger_id: ledgerId } });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });

    const schedule = buildSchedule(loan);

    // Count actual EMI entries posted.
    const [{ paid_count }] = await sequelize.query(
      `SELECT COUNT(DISTINCT reference_id)::int AS paid_count
         FROM ledger_entries
        WHERE ledger_id = :id
          AND source_type = 'loan_emi'
          AND reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = ledger_entries.entry_id
          )`,
      { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT },
    );

    const today = new Date(todayIso());
    const enriched = schedule.map((row, i) => {
      const isPaid = i < paid_count;
      const isOverdue = !isPaid && new Date(row.due_date) < today;
      return { ...row, paid: isPaid, overdue: isOverdue };
    });

    res.json({
      loan_id:        loan.loan_id,
      ledger_id:      loan.ledger_id,
      loan_type:      loan.loan_type,
      principal:      parseFloat(loan.principal) || 0,
      interest_rate:  parseFloat(loan.interest_rate) || 0,
      tenure_months:  loan.tenure_months,
      emi_amount:     parseFloat(loan.emi_amount) || computeEmi(loan.principal, loan.interest_rate, loan.tenure_months),
      schedule:       enriched,
      paid_count,
      total_count:    schedule.length,
    });
  } catch (err) {
    console.error('loanSchedule error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Cross-loan upcoming EMIs (for the LoanSchedule menu page) ──────
//
// Returns next-due EMIs across every active loan, with overdue flag
// + days-until-due. Used to drive the cross-loan dashboard, similar
// to bank Reconciliation but for EMI calendars.
exports.upcomingEmis = async (req, res) => {
  try {
    const horizonDays = parseInt(req.query.days || '90', 10);
    const today = new Date(todayIso());
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + horizonDays);

    const loans = await sequelize.query(
      `SELECT la.ledger_id, la.ledger_name, la.is_active,
              ln.loan_type, ln.principal, ln.interest_rate, ln.tenure_months,
              ln.first_emi_date::text AS first_emi_date, ln.emi_amount,
              p.party_name,
              COALESCE((SELECT COUNT(DISTINCT reference_id) FROM ledger_entries
                         WHERE ledger_id = la.ledger_id
                           AND source_type = 'loan_emi'
                           AND reversal_of_id IS NULL
                           AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = ledger_entries.entry_id)
              ), 0)::int AS paid_count
         FROM ledger_accounts la
         JOIN loan_accounts ln ON ln.ledger_id = la.ledger_id
         LEFT JOIN parties p ON p.party_id = ln.party_id
        WHERE la.is_active = true
          AND la.sub_group IN (:subs)
        ORDER BY la.ledger_name`,
      { replacements: { subs: LOAN_SUBGROUP_VALUES }, type: sequelize.QueryTypes.SELECT },
    );

    const upcoming = [];
    let totalOverdue = 0;
    let totalDueValue = 0;
    let overdueCount = 0;

    for (const l of loans) {
      const sched = buildSchedule(l);
      // Next unpaid EMI, then everything within horizon. We surface
      // multiple unpaid EMIs per loan if the operator's behind.
      for (let i = l.paid_count; i < sched.length; i++) {
        const row = sched[i];
        const due = new Date(row.due_date);
        if (due > horizon && !overduePast(due, today)) break;
        const isOverdue = due < today;
        const daysUntil = Math.round((due - today) / 86400000);
        upcoming.push({
          ledger_id:    l.ledger_id,
          loan_name:    l.ledger_name,
          party_name:   l.party_name,
          loan_type:    l.loan_type,
          emi_no:       row.emi_no,
          due_date:     row.due_date,
          principal:    row.principal,
          interest:     row.interest,
          emi:          row.emi,
          opening:      row.opening,
          closing:      row.closing,
          overdue:      isOverdue,
          days_until:   daysUntil,
          paid_count:   l.paid_count,
          total_count:  sched.length,
        });
        if (isOverdue) {
          overdueCount += 1;
          totalOverdue += row.emi;
        }
        totalDueValue += row.emi;
      }
    }

    // Sort: overdue first (by date asc), then upcoming (by date asc).
    upcoming.sort((a, b) => {
      if (a.overdue && !b.overdue) return -1;
      if (!a.overdue && b.overdue) return 1;
      return new Date(a.due_date) - new Date(b.due_date);
    });

    res.json({
      as_of:          todayIso(),
      horizon_days:   horizonDays,
      upcoming,
      totals: {
        upcoming_count: upcoming.length,
        overdue_count:  overdueCount,
        overdue_value:  r2(totalOverdue),
        due_value:      r2(totalDueValue),
      },
    });
  } catch (err) {
    console.error('upcomingEmis error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
function overduePast(due, today) { return due < today; }

// ── Create a new loan ──────────────────────────────────────────────
exports.createLoan = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const {
      name,
      loan_type,
      party_id,
      principal,
      interest_rate = 0,
      tenure_months,
      disbursement_date,
      first_emi_date,
      emi_amount,
      emi_day,
      notes,
    } = req.body || {};

    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Loan name is required' });
    if (!['taken', 'given'].includes(loan_type)) {
      return res.status(400).json({ error: 'loan_type must be "taken" or "given"' });
    }
    const P = parseFloat(principal) || 0;
    if (P <= 0) return res.status(400).json({ error: 'Principal must be > 0' });
    const N = parseInt(tenure_months, 10);
    if (!N || N <= 0) return res.status(400).json({ error: 'Tenure (months) must be > 0' });

    // Uniqueness — same rule as banks. Friendly error vs raw FK fail.
    const existing = await sequelize.query(
      `SELECT ledger_id FROM ledger_accounts WHERE LOWER(ledger_name) = LOWER(:n) LIMIT 1`,
      { replacements: { n: cleanName }, type: sequelize.QueryTypes.SELECT, transaction: t },
    );
    if (existing.length > 0) {
      await t.rollback();
      return res.status(409).json({ error: `A ledger named "${cleanName}" already exists` });
    }

    const subGroup    = LOAN_SUBGROUPS[loan_type];
    const ledgerGroup = SUBGROUP_TO_GROUP[subGroup];
    // Opening: principal goes in as the seed. For TAKEN: Cr-natured
    // (we owe the lender). For GIVEN: Dr-natured (the borrower owes
    // us). This makes the trial balance correct from disbursement day.
    const obType = loan_type === 'taken' ? 'Credit' : 'Debit';
    const signedOpening = loan_type === 'taken' ? -P : P;

    const ledger = await LedgerAccount.create({
      ledger_name:           cleanName,
      ledger_group:          ledgerGroup,
      sub_group:             subGroup,
      opening_balance:       P,
      opening_balance_type:  obType,
      current_balance:       signedOpening,
      is_active:             true,
      is_system_ledger:      false,
    }, { transaction: t });

    const loan = await LoanAccount.create({
      ledger_id:         ledger.ledger_id,
      loan_type,
      party_id:          party_id || null,
      principal:         P,
      interest_rate:     parseFloat(interest_rate) || 0,
      tenure_months:     N,
      disbursement_date: disbursement_date || null,
      first_emi_date:    first_emi_date    || null,
      emi_amount:        emi_amount ? (parseFloat(emi_amount) || null) : null,
      emi_day:           emi_day ? parseInt(emi_day, 10) : null,
      notes:             notes ? String(notes).trim() || null : null,
    }, { transaction: t });

    await t.commit();
    res.status(201).json({
      ledger_id:        ledger.ledger_id,
      loan_id:          loan.loan_id,
      name:             ledger.ledger_name,
      loan_type:        loan.loan_type,
      principal:        P,
      interest_rate:    loan.interest_rate,
      tenure_months:    loan.tenure_months,
      first_emi_date:   loan.first_emi_date,
      emi_amount:       parseFloat(loan.emi_amount) || computeEmi(P, loan.interest_rate, N),
      outstanding:      P,
    });
  } catch (err) {
    await t.rollback();
    console.error('createLoan error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Update a loan ──────────────────────────────────────────────────
//
// Editable fields:
//   name, party_id, interest_rate, tenure_months, first_emi_date,
//   emi_amount, emi_day, notes, is_active
//
// NOT editable after disbursement (i.e. once any EMI has been posted):
//   loan_type — would silently flip Liability ↔ Asset on the trial bal
//   principal — the opening balance is the agreed loan; changing it
//               would corrupt all running-balance reads
exports.updateLoan = async (req, res) => {
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) return res.status(400).json({ error: 'Invalid ledger_id' });

    const acc  = await LedgerAccount.findByPk(ledgerId);
    if (!acc) return res.status(404).json({ error: 'Loan not found' });
    const loan = await LoanAccount.findOne({ where: { ledger_id: ledgerId } });
    if (!loan) return res.status(404).json({ error: 'Loan metadata missing' });

    const body = req.body || {};
    const ledgerUpd = {};
    const loanUpd   = {};

    if (body.name !== undefined) {
      const newName = String(body.name).trim();
      if (!newName) return res.status(400).json({ error: 'Name cannot be empty' });
      if (newName.toLowerCase() !== acc.ledger_name.toLowerCase()) {
        const dup = await sequelize.query(
          `SELECT ledger_id FROM ledger_accounts WHERE LOWER(ledger_name) = LOWER(:n) AND ledger_id <> :id LIMIT 1`,
          { replacements: { n: newName, id: ledgerId }, type: sequelize.QueryTypes.SELECT },
        );
        if (dup.length > 0) return res.status(409).json({ error: `A ledger named "${newName}" already exists` });
      }
      ledgerUpd.ledger_name = newName;
    }

    if (body.is_active !== undefined) ledgerUpd.is_active = !!body.is_active;

    // Loan-side updates.
    const loanFields = ['party_id', 'interest_rate', 'tenure_months',
                        'first_emi_date', 'emi_amount', 'emi_day', 'notes'];
    for (const f of loanFields) {
      if (body[f] !== undefined) {
        if (f === 'tenure_months')   loanUpd[f] = parseInt(body[f], 10) || 0;
        else if (f === 'interest_rate' || f === 'emi_amount') loanUpd[f] = body[f] === null ? null : (parseFloat(body[f]) || 0);
        else if (f === 'emi_day')    loanUpd[f] = body[f] ? parseInt(body[f], 10) : null;
        else                         loanUpd[f] = body[f];
      }
    }

    // Loan_type / principal change after EMI = forbidden.
    if (body.loan_type !== undefined && body.loan_type !== loan.loan_type) {
      const [{ cnt }] = await sequelize.query(
        `SELECT COUNT(*)::int AS cnt FROM ledger_entries WHERE ledger_id = :id`,
        { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT },
      );
      if (cnt > 0) {
        return res.status(409).json({
          error: `Cannot change loan type — ${cnt} entries already posted. ` +
                 `Switching Taken ↔ Given would silently flip Liability ↔ Asset on the Trial Balance.`,
        });
      }
      loanUpd.loan_type = body.loan_type;
      const newSubGroup = LOAN_SUBGROUPS[body.loan_type];
      ledgerUpd.sub_group   = newSubGroup;
      ledgerUpd.ledger_group = SUBGROUP_TO_GROUP[newSubGroup];
      ledgerUpd.opening_balance_type = body.loan_type === 'taken' ? 'Credit' : 'Debit';
    }

    if (Object.keys(ledgerUpd).length > 0) await acc.update(ledgerUpd);
    if (Object.keys(loanUpd).length   > 0) await loan.update(loanUpd);

    res.json({ ok: true, ledger_id: ledgerId });
  } catch (err) {
    console.error('updateLoan error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Delete a loan ──────────────────────────────────────────────────
exports.deleteLoan = async (req, res) => {
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) return res.status(400).json({ error: 'Invalid ledger_id' });

    const acc = await LedgerAccount.findByPk(ledgerId);
    if (!acc) return res.status(404).json({ error: 'Loan not found' });
    if (!LOAN_SUBGROUP_VALUES.includes(acc.sub_group)) {
      return res.status(400).json({ error: `Ledger "${acc.ledger_name}" is not a loan account` });
    }

    const [{ entry_cnt }] = await sequelize.query(
      `SELECT COUNT(*)::int AS entry_cnt FROM ledger_entries WHERE ledger_id = :id`,
      { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT },
    );
    if (entry_cnt > 0) {
      return res.status(409).json({
        error: `Cannot delete "${acc.ledger_name}" — ${entry_cnt} ledger entries reference it. ` +
               `Deactivate instead to retire it without losing history.`,
        txn_count:          entry_cnt,
        suggest_deactivate: true,
      });
    }

    // CASCADE on loan_accounts.ledger_id removes the sidecar.
    await acc.destroy();
    res.json({ ok: true, ledger_id: ledgerId, name: acc.ledger_name });
  } catch (err) {
    console.error('deleteLoan error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// ── Record an EMI payment ──────────────────────────────────────────
//
// Posts a journal voucher with the proper double-entry split. For loan
// TAKEN:
//
//   Loan A/c            Dr   principal_part     (reduces Cr balance)
//   Interest Expense    Dr   interest_part      (recognises expense)
//     Bank/Cash A/c     Cr   total_emi          (cash out)
//
// For loan GIVEN (mirrored):
//
//   Bank/Cash A/c       Dr   total_emi          (cash in)
//     Loan A/c          Cr   principal_part     (reduces Dr balance)
//     Interest Income   Cr   interest_part      (recognises income)
//
// Body:
//   { date?, principal, interest, bank_ledger_id?, narration? }
//   If principal/interest aren't passed, the next scheduled EMI's
//   split is used.  bank_ledger_id picks WHICH bank pays (or is paid);
//   if absent, falls back to the legacy 'Bank Account' ledger.
exports.recordEMI = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) {
      await t.rollback();
      return res.status(400).json({ error: 'Invalid ledger_id' });
    }
    const loan = await LoanAccount.findOne({ where: { ledger_id: ledgerId }, transaction: t });
    if (!loan) {
      await t.rollback();
      return res.status(404).json({ error: 'Loan not found' });
    }

    const body = req.body || {};
    const date = body.date || todayIso();

    // Always count posted EMIs — needed both for the ref-sequence and
    // (when principal/interest aren't passed) to look up the next-due
    // schedule row.
    const [{ paid_count }] = await sequelize.query(
      `SELECT COUNT(DISTINCT reference_id)::int AS paid_count
         FROM ledger_entries WHERE ledger_id = :id
           AND source_type = 'loan_emi' AND reversal_of_id IS NULL`,
      { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT, transaction: t },
    );

    // Resolve principal / interest split. If not provided, use the
    // scheduled next-due EMI from the amortization table.
    let principalPart = parseFloat(body.principal);
    let interestPart  = parseFloat(body.interest);
    if (!Number.isFinite(principalPart) || !Number.isFinite(interestPart)) {
      const sched = buildSchedule(loan);
      const next = sched[paid_count];
      if (!next) {
        await t.rollback();
        return res.status(400).json({ error: 'No further EMIs scheduled for this loan' });
      }
      principalPart = next.principal;
      interestPart  = next.interest;
    }
    principalPart = r2(principalPart);
    interestPart  = r2(interestPart);
    const totalEmi = r2(principalPart + interestPart);
    if (totalEmi <= 0) {
      await t.rollback();
      return res.status(400).json({ error: 'EMI amount must be > 0' });
    }

    // Resolve the cash leg. Three cases, in priority order:
    //
    //   1. payment_mode === 'Cash' (or use_cash flag) — post against
    //      the system Cash ledger. Used when the operator pays the
    //      EMI in physical cash, or receives a cash repayment.
    //   2. bank_ledger_id present — post against that specific bank.
    //   3. neither — fall back to the legacy 'Bank Account' system
    //      ledger so legacy clients without a bank picker still post.
    let cashLedger;
    const isCash = body.use_cash === true || String(body.payment_mode || '').toLowerCase() === 'cash';
    if (isCash) {
      cashLedger = await LedgerAccount.findOne({
        where: { ledger_name: 'Cash' }, transaction: t,
      });
      if (!cashLedger) {
        await t.rollback();
        return res.status(500).json({ error: 'Cash ledger missing — re-run server to seed' });
      }
    } else if (body.bank_ledger_id) {
      cashLedger = await LedgerAccount.findByPk(body.bank_ledger_id, { transaction: t });
      if (!cashLedger) {
        await t.rollback();
        return res.status(400).json({ error: 'Selected bank ledger not found' });
      }
    } else {
      cashLedger = await LedgerAccount.findOne({
        where: { ledger_name: 'Bank Account' }, transaction: t,
      });
      if (!cashLedger) {
        await t.rollback();
        return res.status(400).json({ error: 'No bank ledger available — pick Cash or a specific bank' });
      }
    }

    // Resolve the interest leg.
    const interestLedgerName = loan.loan_type === 'taken' ? 'Interest Expense' : 'Interest Income';
    const interestLedger = await LedgerAccount.findOne({
      where: { ledger_name: interestLedgerName }, transaction: t,
    });
    if (!interestLedger) {
      await t.rollback();
      return res.status(500).json({ error: `${interestLedgerName} ledger missing — re-run server to seed` });
    }

    // Build the lines. Same convention used elsewhere in voucher
    // builders — Dr lines first, then Cr.
    const lines = [];
    if (loan.loan_type === 'taken') {
      lines.push({ ledgerAccountId: ledgerId,                  debit: principalPart, credit: 0 });
      if (interestPart > 0) lines.push({ ledgerAccountId: interestLedger.ledger_id, debit: interestPart, credit: 0 });
      lines.push({ ledgerAccountId: cashLedger.ledger_id,      debit: 0, credit: totalEmi });
    } else {
      lines.push({ ledgerAccountId: cashLedger.ledger_id,      debit: totalEmi, credit: 0 });
      lines.push({ ledgerAccountId: ledgerId,                  debit: 0, credit: principalPart });
      if (interestPart > 0) lines.push({ ledgerAccountId: interestLedger.ledger_id, debit: 0, credit: interestPart });
    }

    // Synthesize a unique referenceNumber + sourceId per EMI.
    //
    // postVoucher dedupes on (source_type, sourceId) so we can't reuse
    // loan.loan_id for every EMI — the second post would be rejected
    // as a duplicate. Encode the EMI sequence into the numeric sourceId
    // by combining loan.loan_id × 100000 + emiSeq. Bounds:
    //   loan_id × 100000 fits in int4 for any sane loan count
    //   emiSeq up to 100,000 (way more than any realistic tenure)
    // The reverse mapping is `sourceId mod 100000` = emi #, `÷ 100000`
    // = loan id, but we don't actually need to reverse it — listLoans
    // and the schedule queries find EMI entries by joining on
    // ledger_id + source_type, not by parsing sourceId.
    const emiSeq = paid_count + 1;
    const sourceId = (loan.loan_id * 100000) + emiSeq;
    const refNum = `EMI-L${loan.loan_id}-${String(emiSeq).padStart(3, '0')}-${date.replace(/-/g, '')}`;
    await postVoucher({
      voucherType:     loan.loan_type === 'taken' ? 'Payment' : 'Receipt',
      sourceType:      'loan_emi',
      sourceId,
      voucherDate:     date,
      referenceNumber: refNum,
      lines,
      narration:       body.narration ||
                       `EMI ${loan.loan_type === 'taken' ? 'paid' : 'received'} — ` +
                       `principal ₹${principalPart}, interest ₹${interestPart}`,
      userId:          req.user?.user_id || null,
      transaction:     t,
    });

    await t.commit();
    res.status(201).json({
      ok: true,
      loan_id:    loan.loan_id,
      ledger_id:  ledgerId,
      date,
      principal:  principalPart,
      interest:   interestPart,
      emi:        totalEmi,
      reference:  refNum,
    });
  } catch (err) {
    await t.rollback();
    console.error('recordEMI error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// Reverse the most-recently-recorded EMI for a loan. Audit H10:
// previously the only way to undo a wrong-amount EMI was a manual JV,
// which left the original `loan_emi` voucher live and `paid_count` stale
// (the integrity report's loan checks then drifted). This endpoint
// reverses the highest-emiSeq voucher cleanly, dropping paid_count by
// one in lockstep.
exports.reverseEMI = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const ledgerId = parseInt(req.params.ledger_id, 10);
    if (!Number.isFinite(ledgerId)) {
      await t.rollback();
      return res.status(400).json({ error: 'Invalid ledger_id' });
    }
    const loan = await LoanAccount.findOne({ where: { ledger_id: ledgerId }, transaction: t });
    if (!loan) {
      await t.rollback();
      return res.status(404).json({ error: 'Loan not found' });
    }

    // Find the highest-numbered live EMI voucher for this loan.
    // sourceId encoding: loan.loan_id * 100000 + emiSeq, so MAX(sourceId)
    // in the live (reversal_of_id IS NULL) entries gives us the latest.
    const [latest] = await sequelize.query(
      `SELECT MAX(reference_id)::int AS source_id
         FROM ledger_entries
        WHERE ledger_id = :id
          AND source_type = 'loan_emi'
          AND reversal_of_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = ledger_entries.entry_id
          )`,
      { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT, transaction: t },
    );
    if (!latest || !latest.source_id) {
      await t.rollback();
      return res.status(400).json({ error: 'No EMI to reverse' });
    }

    await reverseVoucher({
      sourceType: 'loan_emi',
      sourceId:   latest.source_id,
      reason:     req.body?.reason || 'EMI reversed',
      userId:     req.user?.user_id || null,
      transaction: t,
    });

    await t.commit();
    res.json({ ok: true, reversed_source_id: latest.source_id });
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('reverseEMI error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

// Helper EMI calculator endpoint — for the modal's live preview.
exports.calculateEmi = (req, res) => {
  const principal = parseFloat(req.query.principal) || 0;
  const rate      = parseFloat(req.query.interest_rate) || 0;
  const tenure    = parseInt(req.query.tenure_months, 10) || 0;
  const emi = computeEmi(principal, rate, tenure);
  const totalPayable = r2(emi * tenure);
  const totalInterest = r2(totalPayable - principal);
  res.json({ emi, total_payable: totalPayable, total_interest: totalInterest });
};
