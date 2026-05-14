/*
 * emi-due detector.
 *
 * Loans store `emi_day` (1..31 = day of month) and `emi_amount`
 * (optional override; if null we'd need to compute via the standard
 * formula — for this notification we just skip those rows to avoid
 * promising a number we'd have to recompute).
 *
 * Fires when today's day-of-month matches the loan's emi_day. Also
 * fires one day BEFORE (amber) for planning. Loans without an
 * emi_day are skipped.
 *
 * Months with fewer than emi_day days (e.g. emi_day=31, Feb) get the
 * EMI rolled to the last day of the short month — banks do this in
 * practice. We mirror by checking "today is the last day of month AND
 * emi_day > today's day-of-month."
 *
 * Stable key includes today's date so the same loan re-fires next
 * month with a different key. No state machine — paid or not, the
 * notification appears on the due date.
 */

const { LoanAccount, LedgerAccount, Party } = require('../../models');

function isLastDayOfMonth(d) {
  const next = new Date(d);
  next.setDate(next.getDate() + 1);
  return next.getMonth() !== d.getMonth();
}

module.exports = async function detect(ctx) {
  const today = new Date(ctx.today + 'T00:00:00');
  const dom   = today.getDate();
  const lastOfMonth = isLastDayOfMonth(today);

  // Tomorrow's day-of-month — used for the heads-up notification.
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomDom = tomorrow.getDate();

  const loans = await LoanAccount.findAll({
    where: { emi_day: { [require('sequelize').Op.ne]: null } },
    include: [
      { model: LedgerAccount, as: 'ledger', attributes: ['ledger_id', 'ledger_name'] },
      { model: Party,         as: 'party',  attributes: ['party_name'] },
    ],
  });

  const out = [];
  for (const loan of loans) {
    const day = Number(loan.emi_day);
    if (!day) continue;
    const emi = loan.emi_amount != null ? Number(loan.emi_amount) : null;

    // Match logic:
    //   - exact: today's day-of-month equals emi_day, OR
    //   - rollover: today is the last day of month AND emi_day is bigger
    const isToday    = day === dom || (lastOfMonth && day > dom);
    const isTomorrow = day === tomDom; // simpler: ignore rollover for tomorrow
    if (!isToday && !isTomorrow) continue;

    const partyName = loan.party?.party_name || loan.ledger?.ledger_name || 'Bank';
    const dueLabel  = isToday ? 'today' : 'tomorrow';
    const severity  = isToday ? 'red' : 'amber';
    const amountText = emi ? ` · ₹${Math.round(emi).toLocaleString('en-IN')}` : '';
    out.push({
      key:         `emi-due:${loan.loan_id}:${ctx.today}:${dueLabel}`,
      type:        'emi-due',
      section:     'today',
      severity,
      label:       `Loan EMI ${dueLabel} — ${partyName}`,
      sub:         `EMI day ${day}${amountText}. ${loan.loan_type === 'taken' ? 'Outflow' : 'Inflow'} expected ${dueLabel}.`,
      occurredAt:  new Date(),
      actionRoute: '/loans/schedule',
      actionLabel: 'Schedule',
    });
  }
  return out;
};
