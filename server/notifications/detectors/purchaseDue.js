/*
 * purchase-due detector.
 *
 * Surfaces purchase bills whose payment due_date falls today (red)
 * or tomorrow (amber). Filters:
 *   - balance_amount > 0  (still owed in whole or part)
 *   - not cancelled
 *
 * Stable key includes the due_date so a single bill that gets paid
 * partially today (balance still > 0 tomorrow) doesn't re-fire under
 * a different key — same bill, same key.
 *
 * Cap of 20 — beyond that the firm has a cash-flow situation that
 * needs a dedicated cash-flow report, not a notification list.
 */

const { Op } = require('sequelize');
const { PurchaseBill, Party } = require('../../models');

module.exports = async function detect(ctx) {
  const today    = ctx.today;
  // ctx.dateStr is local-time-safe; toISOString().slice(0,10) flips
  // east-of-UTC dates back one day.
  const tomorrow = ctx.dateStr(ctx.addDays(new Date(today + 'T00:00:00'), 1));

  const rows = await PurchaseBill.findAll({
    where: {
      due_date:       { [Op.in]: [today, tomorrow] },
      balance_amount: { [Op.gt]: 0 },
      is_cancelled:   { [Op.or]: [false, null] },
    },
    include: [{ model: Party, as: 'supplier', attributes: ['party_name'] }],
    order: [['due_date', 'ASC']],
    limit: 20,
  });

  return rows.map((b) => {
    const isToday = b.due_date === today;
    const supplierName = b.supplier?.party_name || 'supplier';
    const balance = Number(b.balance_amount || 0);
    return {
      key:         `purchase-due:${b.purchase_bill_id}:${b.due_date}`,
      type:        'purchase-due',
      section:     'today',
      severity:    isToday ? 'red' : 'amber',
      label:       `Payment ${isToday ? 'due today' : 'due tomorrow'} — ${supplierName}`,
      sub:         `Bill #${b.bill_number} · ₹${Math.round(balance).toLocaleString('en-IN')} pending.`,
      occurredAt:  new Date(),
      actionRoute: `/purchase/edit/${b.purchase_bill_id}`,
      actionLabel: 'Open bill',
    };
  });
};
