/*
 * Membership loyalty-points service.
 *
 * Encapsulates every write to membership_points_ledger so the sales
 * controller stays thin. Two entry points are used by billing:
 *   · accrueForSale  — earn points when a sale is saved
 *   · reverseForSale — undo a bill's points when it is cancelled
 *
 * INVARIANTS (read before editing):
 *   · The ledger is the source of truth. `Membership.points_balance` is a
 *     cache recomputed as SUM(points) after every write — never incremented
 *     blindly.
 *   · `points` is a SIGNED delta (earn +, redeem −, reverse = opposite).
 *   · Both operations are IDEMPOTENT — safe to call twice for the same bill
 *     without double-granting or double-reversing.
 *   · NOTHING here posts to ledger_entries or changes a bill total/tax/party
 *     balance. Points are a loyalty balance only.
 *   · Callers wrap these in a SAVEPOINT (nested transaction) so a points
 *     failure rolls back ONLY the points changes and never blocks the sale or
 *     the cancellation. Keep every path here transactional via the passed-in
 *     transaction.
 */

const { Op } = require('sequelize');
const {
  MembershipPlan, Membership, MembershipPointsLedger, SystemSettings,
} = require('../models');

// Floor to whole points (loyalty convention — never grant fractional points).
// The tiny epsilon absorbs float noise like 4.999999999 → 5.
function floorPoints(n) {
  return Math.floor((Number(n) || 0) + 1e-9);
}

/**
 * Recompute a membership's cached points_balance from the ledger (the source
 * of truth). Always runs inside the caller's transaction.
 */
async function recomputeBalance(membershipId, transaction) {
  const rows = await MembershipPointsLedger.findAll({
    attributes: [
      [MembershipPointsLedger.sequelize.fn('COALESCE',
        MembershipPointsLedger.sequelize.fn('SUM', MembershipPointsLedger.sequelize.col('points')), 0), 'bal'],
    ],
    where: { membership_id: membershipId },
    raw: true,
    transaction,
  });
  const bal = Number(rows && rows[0] && rows[0].bal) || 0;
  await Membership.update(
    { points_balance: bal },
    { where: { membership_id: membershipId }, transaction },
  );
  return bal;
}

/**
 * Earn loyalty points for a saved sale. No-op (returns 0) unless points are
 * enabled, the customer is an Active member, and their plan has a positive
 * rate. Idempotent: skips if an 'earn' row already exists for this bill.
 *
 * @param {object} salesBill  the just-created SalesBill instance (needs
 *                            sales_bill_id, customer_id, total_amount, bill_number)
 * @param {number} userId     the operator (for the audit trail; nullable)
 * @param {object} opts.transaction  REQUIRED — the (savepoint) transaction
 * @returns {number} points earned (0 if none)
 */
async function accrueForSale({ salesBill, userId }, { transaction }) {
  if (!salesBill) return 0;
  const settings = await SystemSettings.findByPk(1, { transaction });
  if (!settings || !settings.membership_points_enabled) return 0;

  const customerId = salesBill.customer_id;
  if (!customerId) return 0;

  const membership = await Membership.findOne({
    where: { party_id: customerId }, transaction,
  });
  if (!membership || membership.status !== 'Active') return 0;

  const plan = await MembershipPlan.findByPk(membership.plan_id, { transaction });
  const rate = plan ? Number(plan.points_per_100) || 0 : 0;
  if (rate <= 0) return 0;

  // Idempotency — never double-grant for the same bill.
  const already = await MembershipPointsLedger.findOne({
    where: {
      membership_id: membership.membership_id,
      source_sales_bill_id: salesBill.sales_bill_id,
      type: 'earn',
    },
    transaction,
  });
  if (already) return 0;

  // Earn on the bill's net payable (what the customer spent). Floored to
  // whole points. Uses the value the bill itself already computed — this
  // service performs NO bill math of its own.
  const base = Number(salesBill.total_amount) || 0;
  if (base <= 0) return 0;
  const earned = floorPoints((base / 100) * rate);
  if (earned <= 0) return 0;

  await MembershipPointsLedger.create({
    membership_id: membership.membership_id,
    type: 'earn',
    points: earned,
    source_type: 'sales_bill',
    source_sales_bill_id: salesBill.sales_bill_id,
    note: `Earned on bill ${salesBill.bill_number || '#' + salesBill.sales_bill_id}`,
    created_by: userId || null,
  }, { transaction });

  await recomputeBalance(membership.membership_id, transaction);
  return earned;
}

/**
 * Current authoritative balance (SUM over the ledger) for a membership.
 */
async function currentBalance(membershipId, transaction) {
  const rows = await MembershipPointsLedger.findAll({
    attributes: [
      [MembershipPointsLedger.sequelize.fn('COALESCE',
        MembershipPointsLedger.sequelize.fn('SUM', MembershipPointsLedger.sequelize.col('points')), 0), 'bal'],
    ],
    where: { membership_id: membershipId },
    raw: true,
    transaction,
  });
  return Number(rows && rows[0] && rows[0].bal) || 0;
}

/**
 * Redeem points on a sale. UNLIKE earning, this is NOT best-effort — it runs
 * in the sale's MAIN transaction and THROWS on any problem (not a member,
 * insufficient balance) so the whole bill rolls back rather than granting a
 * money discount without deducting the points. The rupee value of the
 * redemption is applied by the caller through the EXISTING special_discount
 * field; this function only records the points side (a negative 'redeem' row).
 *
 * Locks the membership row FOR UPDATE so two concurrent tills can't double-spend
 * the same balance. Idempotent per bill.
 *
 * @returns {number} points redeemed (0 if nothing to do)
 */
async function redeemForSale({ salesBill, pointsRedeemed, valuePerPoint, userId }, { transaction }) {
  const pts = floorPoints(pointsRedeemed);
  if (pts <= 0) return 0;
  if (!salesBill || !salesBill.customer_id) {
    const e = new Error('Points can only be redeemed for a member customer'); e.status = 400; throw e;
  }

  const membership = await Membership.findOne({
    where: { party_id: salesBill.customer_id },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!membership || membership.status !== 'Active') {
    const e = new Error('Points can only be redeemed by an active member'); e.status = 400; throw e;
  }

  // Idempotency — don't double-deduct for the same bill (e.g. a retried save).
  const already = await MembershipPointsLedger.findOne({
    where: { membership_id: membership.membership_id, source_sales_bill_id: salesBill.sales_bill_id, type: 'redeem' },
    transaction,
  });
  if (already) return 0;

  const bal = await currentBalance(membership.membership_id, transaction);
  if (pts > bal) {
    const e = new Error(`Not enough points to redeem: balance ${bal}, requested ${pts}`); e.status = 400; throw e;
  }

  const value = Number(valuePerPoint) || 0;
  await MembershipPointsLedger.create({
    membership_id: membership.membership_id,
    type: 'redeem',
    points: -pts,
    source_type: 'sales_bill',
    source_sales_bill_id: salesBill.sales_bill_id,
    note: `Redeemed ${pts} pts (₹${(pts * value).toFixed(2)}) on bill ${salesBill.bill_number || '#' + salesBill.sales_bill_id}`,
    created_by: userId || null,
  }, { transaction });

  await recomputeBalance(membership.membership_id, transaction);
  return pts;
}

/**
 * Reverse every points movement tied to a cancelled sale (earn and redeem).
 * Inserts an opposite-sign 'reverse' row for each, then recomputes the
 * affected balances. Idempotent: skips if this bill was already reversed.
 *
 * @param {number} salesBillId
 * @param {object} opts.transaction  REQUIRED
 * @returns {number} number of movements reversed
 */
async function reverseForSale({ salesBillId, userId }, { transaction }) {
  if (!salesBillId) return 0;

  // Already reversed? (guards against a double-cancel path.)
  const already = await MembershipPointsLedger.findOne({
    where: { source_sales_bill_id: salesBillId, type: 'reverse' },
    transaction,
  });
  if (already) return 0;

  const rows = await MembershipPointsLedger.findAll({
    where: {
      source_sales_bill_id: salesBillId,
      type: { [Op.in]: ['earn', 'redeem'] },
    },
    transaction,
  });
  if (!rows.length) return 0;

  const touched = new Set();
  for (const r of rows) {
    await MembershipPointsLedger.create({
      membership_id: r.membership_id,
      type: 'reverse',
      points: -Number(r.points),      // opposite delta
      source_type: 'reversal',
      source_sales_bill_id: salesBillId,
      note: `Reversed on cancellation of bill #${salesBillId}`,
      created_by: userId || null,
    }, { transaction });
    touched.add(r.membership_id);
  }

  for (const mid of touched) {
    await recomputeBalance(mid, transaction);
  }
  return rows.length;
}

/**
 * Expire loyalty points after a period of INACTIVITY.
 *
 * Rule (kept deliberately simple + safe): if `membership_points_expiry_months`
 * is > 0, any member whose LAST points activity (earn/redeem/adjust/reverse)
 * is older than that many months has their whole remaining balance expired —
 * recorded as an auditable 'expire' row (never silently zeroed). Any activity
 * resets the clock. 0 months = points never expire (lifetime).
 *
 * Idempotent: once expired, the balance is 0 so the member is skipped until
 * they earn again. Each member is processed in its own transaction so one bad
 * row can't abort the sweep. Safe to run repeatedly (boot + daily).
 *
 * @returns {{members:number, points:number}} how much was expired
 */
async function sweepExpiredPoints() {
  const settings = await SystemSettings.findByPk(1);
  const months = parseInt(settings && settings.membership_points_expiry_months, 10) || 0;
  if (months <= 0) return { members: 0, points: 0 };   // lifetime — nothing to do

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  // Only members who actually hold points can lose any.
  const candidates = await Membership.findAll({ where: { points_balance: { [Op.gt]: 0 } } });
  const QT = Membership.sequelize.QueryTypes.SELECT;

  let members = 0, points = 0;
  for (const m of candidates) {
    const t = await Membership.sequelize.transaction();
    try {
      const [row] = await Membership.sequelize.query(
        'SELECT MAX(created_at) AS last FROM membership_points_ledger WHERE membership_id = :mid',
        { replacements: { mid: m.membership_id }, type: QT, transaction: t },
      );
      const last = row && row.last ? new Date(row.last) : null;
      if (last && last < cutoff) {
        const bal = await currentBalance(m.membership_id, t);
        if (bal > 0) {
          await MembershipPointsLedger.create({
            membership_id: m.membership_id, type: 'expire', points: -bal,
            source_type: 'expiry',
            note: `Expired ${bal} pts after ${months} month(s) of inactivity`,
          }, { transaction: t });
          await recomputeBalance(m.membership_id, t);
          members++; points += bal;
        }
      }
      await t.commit();
    } catch (e) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
  }
  return { members, points };
}

module.exports = { accrueForSale, redeemForSale, reverseForSale, recomputeBalance, currentBalance, floorPoints, sweepExpiredPoints };
