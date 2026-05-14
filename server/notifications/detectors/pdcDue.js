/*
 * pdc-due detector — the "throw away the diary" feature.
 *
 * Fires for cheques whose cheque_date matures TODAY (red) or
 * TOMORROW (amber) and that are still PENDING. Covers both
 * directions:
 *
 *   INWARD  PDC: a customer gave us a postdated cheque. The cheque_date
 *               is the deposit-on-or-after date. On that day, we walk
 *               to the bank to deposit. Operator action: "Mark deposited".
 *
 *   OUTWARD PDC: we issued a postdated cheque to a supplier. The
 *               cheque_date is when the supplier can present it.
 *               Operator action: ensure bank balance is sufficient.
 *
 * Trust caveats (because PDC reminders are the highest-value-highest-
 * risk type — a missed PDC destroys trust in the bell):
 *
 *   - Weekend/holiday rollover: PDCs maturing on Sat/Sun stay flagged
 *     until cleared. We do NOT silently roll the date forward to
 *     Monday — banks honour it on the actual date if presented, and
 *     the operator's call. We just keep the row in red until the
 *     status changes from PENDING.
 *
 *   - Replacement cheques after a bounce: when the operator marks one
 *     PDC bounced and books a new replacement, the OLD cheque has
 *     status=BOUNCED (skipped here) and the NEW cheque is its own row
 *     in cheques table with a fresh cheque_id. Stable key uses
 *     cheque_id, so the replacement notifies independently of the
 *     bounced original.
 *
 *   - Maturing rows older than 14 days that still show PENDING are
 *     stale data (operator never deposited, never bounced — likely
 *     forgot to update). We still surface them but as red with
 *     "still pending after N days" copy. That nudges a clean-up
 *     without silently dropping the row.
 *
 * Stable key includes cheque_id AND cheque_date so the same cheque
 * doesn't fire twice if the date is somehow edited.
 */

const { Op } = require('sequelize');
const { Cheque, Party, LedgerAccount } = require('../../models');

const STALE_AFTER_DAYS = 14;

module.exports = async function detect(ctx) {
  const today    = ctx.today;
  // ctx.dateStr is local-time-safe (the toISOString trip flips dates
  // back one day in IST and other east-of-UTC zones).
  const tomorrow   = ctx.dateStr(ctx.addDays(new Date(today + 'T00:00:00'), 1));
  // Look at cheques maturing within (today - 14) … tomorrow inclusive
  const lowerBound = ctx.dateStr(ctx.addDays(new Date(today + 'T00:00:00'), -STALE_AFTER_DAYS));

  const rows = await Cheque.findAll({
    where: {
      status:      'PENDING',
      is_pdc:      true,
      cheque_date: { [Op.between]: [lowerBound, tomorrow] },
    },
    include: [
      { model: Party,         as: 'party', attributes: ['party_name'] },
      { model: LedgerAccount, as: 'bank',  attributes: ['ledger_name'] },
    ],
    order: [['cheque_date', 'ASC']],
    limit: 25,
  });

  return rows.map((c) => {
    const partyName = c.party?.party_name || 'unknown party';
    const bankName  = c.bank?.ledger_name || null;
    const amount    = Number(c.amount || 0);
    const fmt = `₹${Math.round(amount).toLocaleString('en-IN')}`;
    const isInward = c.direction === 'INWARD';

    // Days-from-today: negative = stale (matured but still pending),
    // 0 = today, 1 = tomorrow.
    const days = ctx.daysFromToday(c.cheque_date);

    let severity = 'amber';
    let labelDate;
    if (days === 0) {
      severity = 'red';
      labelDate = 'matures today';
    } else if (days === 1) {
      severity = 'amber';
      labelDate = 'matures tomorrow';
    } else if (days < 0) {
      severity = 'red';
      const past = Math.abs(days);
      labelDate = `was due ${past} day${past === 1 ? '' : 's'} ago`;
    } else {
      // shouldn't happen given our Op.between, but fail safe.
      return null;
    }

    const verb = isInward
      ? `Deposit — ${partyName}`
      : `Bank balance ready — ${partyName}`;
    return {
      key:         `pdc-due:${c.cheque_id}:${c.cheque_date}`,
      type:        'pdc-due',
      section:     'today',
      severity,
      label:       `PDC ${labelDate} · ${fmt} · ${verb}`,
      sub:         [
        `#${c.cheque_number}`,
        bankName,
        isInward ? 'Take cheque to the bank' : 'Honour at presentation',
      ].filter(Boolean).join(' · ').slice(0, 140),
      occurredAt:  new Date(c.cheque_date + 'T00:00:00'),
      actionRoute: '/banks/cheques',
      actionLabel: 'Open cheques',
    };
  }).filter(Boolean);
};
