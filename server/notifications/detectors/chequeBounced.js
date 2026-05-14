/*
 * cheque-bounced detector.
 *
 * Surfaces cheques whose status flipped to BOUNCED in the last 30 days.
 * One notification per bounced cheque. Stable key = cheque id.
 *
 * Why a 30-day window: a bounced cheque the operator dismissed weeks
 * ago shouldn't keep haunting them; if it's truly unresolved, follow-
 * up belongs in receivables aging, not the bell. Recent bounces are
 * the ones that need immediate action (contact customer, deposit a
 * replacement, write off).
 *
 * Direction matters for the verbs:
 *   INWARD  bounced → customer's cheque to us bounced → chase customer
 *   OUTWARD bounced → our cheque to supplier bounced  → fix bank balance
 */

const { Op } = require('sequelize');
const { Cheque, Party, LedgerAccount } = require('../../models');

const WINDOW_DAYS = 30;

module.exports = async function detect(/* ctx */) {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000);
  const rows = await Cheque.findAll({
    where: {
      status: 'BOUNCED',
      bounce_date: { [Op.gte]: since },
    },
    include: [
      { model: Party,         as: 'party', attributes: ['party_name'] },
      { model: LedgerAccount, as: 'bank',  attributes: ['ledger_name'] },
    ],
    order: [['bounce_date', 'DESC']],
    limit: 15,
  });

  return rows.map((c) => {
    const partyName = c.party?.party_name || 'unknown party';
    const bankName  = c.bank?.ledger_name || null;
    const amount    = Number(c.amount || 0);
    const formatted = `₹${Math.round(amount).toLocaleString('en-IN')}`;
    const isInward  = c.direction === 'INWARD';
    return {
      key:         `cheque-bounced:${c.cheque_id}`,
      type:        'cheque-bounced',
      section:     'risk',
      severity:    'red',
      label:       isInward
        ? `Cheque from ${partyName} bounced — ${formatted}`
        : `Our cheque to ${partyName} bounced — ${formatted}`,
      sub:         [
        `#${c.cheque_number}`,
        bankName,
        c.bounce_reason || (isInward ? 'Customer follow-up needed' : 'Bank balance issue'),
      ].filter(Boolean).join(' · ').slice(0, 140),
      occurredAt:  c.bounce_date || c.modified_date || new Date(),
      actionRoute: '/banks/cheques',
      actionLabel: 'Open cheques',
    };
  });
};
