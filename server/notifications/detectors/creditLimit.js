/*
 * credit-limit detector.
 *
 * Surfaces customers whose current_balance has crossed their
 * credit_limit. The detector treats Party.current_balance as the
 * receivable amount (Dr balance from customer's perspective);
 * positive values are what the customer owes us.
 *
 * The credit_limit field is operator-set on the Customer master.
 * Zero or null = no limit set, no notification fires regardless of
 * outstanding. We only flag customers — supplier credit limits are
 * conceptually their problem, not ours.
 *
 * Stable key = party id, so a customer who crosses, gets paid, then
 * crosses again will re-fire only because the state row is
 * resolved-then-dismissed in between (the diff layer in service.js
 * handles that).
 *
 * Cap of 25 parties — beyond that the firm has a portfolio-wide
 * collection problem, not a notification issue.
 */

const { Op, literal } = require('sequelize');
const { Party } = require('../../models');

module.exports = async function detect(/* ctx */) {
  const rows = await Party.findAll({
    where: {
      credit_limit:    { [Op.gt]: 0 },
      current_balance: { [Op.gt]: 0 },
      is_active:       true,
      [Op.and]: [literal('current_balance > credit_limit')],
    },
    attributes: ['party_id', 'party_name', 'credit_limit', 'current_balance'],
    order: [[literal('(current_balance - credit_limit)'), 'DESC']],
    limit: 25,
  });

  return rows.map((p) => {
    const limit   = Number(p.credit_limit || 0);
    const balance = Number(p.current_balance || 0);
    const over    = balance - limit;
    const fmt = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
    return {
      key:         `credit-limit:${p.party_id}`,
      type:        'credit-limit',
      section:     'risk',
      severity:    'red',
      label:       `${p.party_name} crossed credit limit`,
      sub:         `Outstanding ${fmt(balance)} · limit ${fmt(limit)} · over by ${fmt(over)}`,
      occurredAt:  new Date(),
      actionRoute: `/reports/customer-statement?id=${p.party_id}`,
      actionLabel: 'View statement',
    };
  });
};
