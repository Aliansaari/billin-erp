/*
 * refund-pending detector.
 *
 * Sales returns where the refund hasn't been paid in full and the
 * return is more than N days old. Treats `refund_status` IN
 * ('Pending', 'Partial') with a non-zero balance_amount as the
 * trigger.
 *
 * Threshold = 7 days. Some firms refund on the spot (refund_status =
 * 'Refunded' on the same day); we don't fire for those. The 7-day
 * window catches "credit note created, customer never refunded"
 * which is what the operator forgets about.
 *
 * One notification per return. Stable key = return id.
 */

const { Op } = require('sequelize');
const { SalesReturnBill, Party } = require('../../models');

const STALE_AFTER_DAYS  = 7;
const WINDOW_DAYS       = 120;   // cap how far back we'll surface

module.exports = async function detect(/* ctx */) {
  const olderThan = new Date(Date.now() - STALE_AFTER_DAYS * 86400000);
  const cutoff    = new Date(Date.now() - WINDOW_DAYS * 86400000);
  const rows = await SalesReturnBill.findAll({
    where: {
      refund_status:  { [Op.in]: ['Pending', 'Partial'] },
      balance_amount: { [Op.gt]: 0 },
      is_cancelled:   { [Op.or]: [false, null] },
      return_date:    { [Op.lt]: olderThan, [Op.gte]: cutoff },
    },
    include: [{ model: Party, as: 'customer', attributes: ['party_name'] }],
    order: [['return_date', 'ASC']],
    limit: 15,
  });

  return rows.map((r) => {
    const ageDays = Math.floor((Date.now() - new Date(r.return_date).getTime()) / 86400000);
    const balance = Number(r.balance_amount || 0);
    const customerName = r.customer?.party_name || 'unknown customer';
    return {
      key:         `refund-pending:${r.sales_return_id}`,
      type:        'refund-pending',
      section:     'risk',
      severity:    'amber',
      label:       `Refund pending — ${customerName}`,
      sub:         `Credit note #${r.return_number} from ${ageDays}d ago · ₹${Math.round(balance).toLocaleString('en-IN')} unpaid.`,
      occurredAt:  new Date(r.return_date),
      actionRoute: `/sales-return/edit/${r.sales_return_id}`,
      actionLabel: 'Open return',
    };
  });
};
