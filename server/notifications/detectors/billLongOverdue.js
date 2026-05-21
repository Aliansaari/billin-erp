/*
 * bill-long-overdue detector.
 *
 * Surfaces sales bills (receivables) that crossed the 60-day overdue
 * threshold. One notification per bill. We anchor on `bill_date`
 * (rather than `due_date`) because due_date is operator-set and
 * sometimes blank; bill_date is always present.
 *
 * Threshold mechanics:
 *   - bill is >60 days old (relative to today)
 *   - balance_amount > 0  (still unpaid in whole or part)
 *   - not cancelled
 *
 * We don't fire for the 100th overdue bill of the same party — but
 * we DO emit them as individual rows so the operator can act on each.
 * The bell display caps at 8 per section anyway; beyond that the
 * existing aging report is the right tool.
 *
 * Stable key = sales bill id, so the row persists until paid /
 * dismissed. We don't re-fire the same bill on day 61 vs day 90 —
 * one alert per bill is enough.
 */

const { Op, literal } = require('sequelize');
const { SalesBill, Party } = require('../../models');

const THRESHOLD_DAYS = 60;

module.exports = async function detect(/* ctx */) {
  const cutoff = new Date(Date.now() - THRESHOLD_DAYS * 86400000);
  const rows = await SalesBill.findAll({
    where: {
      bill_date:       { [Op.lt]: cutoff },
      balance_amount:  { [Op.gt]: 0 },
      is_cancelled:    { [Op.or]: [false, null] },
      // Exclude Cash-party bills — cash sales are paid at the counter
      // and shouldn't appear in the overdue list. Any Cash bill with
      // balance > 0 is a data anomaly (import artefact), not a real
      // receivable the operator needs to chase.
      '$customer.is_system_cash$': { [Op.or]: [false, null] },
    },
    include: [{ model: Party, as: 'customer', attributes: ['party_name', 'is_system_cash'] }],
    order: [['bill_date', 'ASC']],   // oldest first
    limit: 25,
  });

  return rows.map((b) => {
    const ageDays = Math.floor((Date.now() - new Date(b.bill_date).getTime()) / 86400000);
    const balance = Number(b.balance_amount || 0);
    const partyName = b.customer?.party_name || 'unknown customer';
    return {
      key:         `bill-long-overdue:${b.sales_bill_id}`,
      type:        'bill-long-overdue',
      section:     'risk',
      severity:    ageDays >= 120 ? 'red' : 'amber',
      label:       `${partyName} · #${b.bill_number} overdue ${ageDays} days`,
      sub:         `Balance ₹${Math.round(balance).toLocaleString('en-IN')} — bill dated ${new Date(b.bill_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}.`,
      occurredAt:  new Date(b.bill_date),
      actionRoute: `/sale/edit/${b.sales_bill_id}`,
      actionLabel: 'Open bill',
    };
  });
};
