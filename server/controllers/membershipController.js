/*
 * Membership (loyalty) controller.
 *
 * Two resources:
 *   1. Plans      — the reusable loyalty tiers (Silver/Gold/Platinum).
 *   2. Memberships — a customer's enrolment into one plan (1 per party).
 *
 * READ THIS BEFORE TOUCHING ANYTHING FINANCIAL:
 *   Nothing in this controller participates in any bill total, tax, discount,
 *   ledger voucher, party balance, return, or stock figure. A plan stores
 *   config numbers; a membership stores enrolment metadata. The billing layer
 *   READS a plan's discount/points config in a LATER phase and routes any
 *   effect through the EXISTING sales pipeline unchanged. This file must never
 *   import a money helper or write to ledger_entries. `points_balance` is a
 *   display cache; it is forced to 0 here in Phase 1 and only ever moved by the
 *   append-only points ledger from Phase 3 onward — never hand-set by a client.
 *
 * Uniqueness (controller-enforced, case-insensitive):
 *   · plan_name across plans.
 *   · membership_no across memberships (also a DB UNIQUE — the check here
 *     yields a friendly message before the constraint fires).
 *   · one membership per party (also a DB UNIQUE on party_id).
 *
 * Permissions (wired in routes/membership.js):
 *   · Reads: any authenticated user.
 *   · Writes (plans + memberships): settings.manage_company. Kept admin-gated
 *     for Phase 1; can be relaxed to counter staff later without schema change.
 */

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { MembershipPlan, Membership, MembershipPointsLedger, Party, SystemSettings } = require('../models');

/* ────────────────────────── helpers ────────────────────────── */

// Case-insensitive exact match on a column, tolerant of LIKE wildcards in
// the value (compares lower(col) = lower(value) rather than ILIKE). Mirrors
// the salesman controller's nameMatchWhere.
function ciWhere(col, value) {
  return sequelize.where(
    sequelize.fn('lower', sequelize.col(col)),
    String(value).trim().toLowerCase(),
  );
}

// Clamp a percentage to [0,100] with 2dp; 0 for blank/invalid. Config only —
// never applied to any money calculation here.
function clampPct(v) {
  const n = parseFloat(v);
  if (!isFinite(n) || n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

// Non-negative decimal with the given dp; 0 for blank/invalid.
function nonNegNumber(v, dp = 2) {
  const n = parseFloat(v);
  if (!isFinite(n) || n < 0) return 0;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// Positive integer or null (for validity_months). Blank/invalid → null.
function posIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  if (!isFinite(n) || n <= 0) return null;
  return n;
}

// Plain integer (sort_order); 0 for blank/invalid.
function intOr0(v) {
  const n = parseInt(v, 10);
  return isFinite(n) ? n : 0;
}

// Add whole months to a 'YYYY-MM-DD' string, returning 'YYYY-MM-DD'. Used to
// derive expiry_date from a plan's validity_months at enrolment. Month
// overflow rolls forward per JS Date semantics (adequate for a validity
// window). Returns null when months is null (never-expires plan).
function addMonths(dateStr, months) {
  if (months == null) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ────────────────────────── PLANS ────────────────────────── */

exports.getAllPlans = async (req, res) => {
  try {
    const { include_inactive } = req.query;
    const where = include_inactive === 'true' ? {} : { is_active: true };
    const rows = await MembershipPlan.findAll({
      where,
      order: [['is_active', 'DESC'], ['sort_order', 'ASC'], ['plan_name', 'ASC']],
    });
    res.json(rows);
  } catch (err) {
    console.error('[membership.getAllPlans]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getPlanById = async (req, res) => {
  try {
    const row = await MembershipPlan.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Plan not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createPlan = async (req, res) => {
  try {
    const { plan_name } = req.body;
    if (!plan_name || !String(plan_name).trim()) {
      return res.status(400).json({ error: 'Plan name is required' });
    }
    const name = String(plan_name).trim();
    if (name.length > 80) return res.status(400).json({ error: 'Plan name: max 80 characters' });

    const dup = await MembershipPlan.findOne({ where: ciWhere('plan_name', name) });
    if (dup) return res.status(400).json({ error: 'A plan with that name already exists' });

    const row = await MembershipPlan.create({
      plan_name: name,
      discount_percent: clampPct(req.body.discount_percent),
      points_per_100: nonNegNumber(req.body.points_per_100, 2),
      validity_months: posIntOrNull(req.body.validity_months),
      min_spend_to_upgrade: nonNegNumber(req.body.min_spend_to_upgrade, 2),
      sort_order: intOr0(req.body.sort_order),
      notes: req.body.notes ? String(req.body.notes).trim() : null,
      is_active: true,
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('[membership.createPlan]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const row = await MembershipPlan.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Plan not found' });

    const updates = {};

    if (req.body.plan_name !== undefined) {
      const name = String(req.body.plan_name).trim();
      if (!name) return res.status(400).json({ error: 'Plan name is required' });
      if (name.length > 80) return res.status(400).json({ error: 'Plan name: max 80 characters' });
      const dup = await MembershipPlan.findOne({
        where: { [Op.and]: [ciWhere('plan_name', name), { plan_id: { [Op.ne]: row.plan_id } }] },
      });
      if (dup) return res.status(400).json({ error: 'A plan with that name already exists' });
      updates.plan_name = name;
    }

    if (req.body.discount_percent !== undefined) updates.discount_percent = clampPct(req.body.discount_percent);
    if (req.body.points_per_100 !== undefined) updates.points_per_100 = nonNegNumber(req.body.points_per_100, 2);
    if (req.body.validity_months !== undefined) updates.validity_months = posIntOrNull(req.body.validity_months);
    if (req.body.min_spend_to_upgrade !== undefined) updates.min_spend_to_upgrade = nonNegNumber(req.body.min_spend_to_upgrade, 2);
    if (req.body.sort_order !== undefined) updates.sort_order = intOr0(req.body.sort_order);
    if (req.body.notes !== undefined) updates.notes = req.body.notes ? String(req.body.notes).trim() : null;
    if (req.body.is_active !== undefined) updates.is_active = !!req.body.is_active;

    await row.update(updates);
    res.json(row);
  } catch (err) {
    console.error('[membership.updatePlan]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Hard-delete a plan. Refused when any membership references it — the
 * supported path once a plan has members is soft-delete (PUT is_active=false),
 * which hides it from the enrolment picker without touching enrolled members.
 */
exports.deletePlan = async (req, res) => {
  try {
    const row = await MembershipPlan.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Plan not found' });

    const refCount = await Membership.count({ where: { plan_id: row.plan_id } });
    if (refCount > 0) {
      return res.status(400).json({
        error: `Plan has ${refCount} enrolled member(s). Deactivate it instead of deleting to preserve their membership.`,
      });
    }

    await row.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error('[membership.deletePlan]', err);
    res.status(500).json({ error: err.message });
  }
};

/* ────────────────────────── MEMBERSHIPS ────────────────────────── */

// Full include shape reused by list + single reads.
const MEMBERSHIP_INCLUDE = [
  { model: MembershipPlan, as: 'plan' },
  { model: Party, as: 'party', attributes: ['party_id', 'party_name', 'display_name', 'mobile_1', 'party_type'] },
];

exports.getAllMemberships = async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status && ['Active', 'Suspended', 'Expired'].includes(status)) where.status = status;
    const rows = await Membership.findAll({
      where,
      include: MEMBERSHIP_INCLUDE,
      order: [['created_date', 'DESC']],
    });
    res.json(rows);
  } catch (err) {
    console.error('[membership.getAllMemberships]', err);
    res.status(500).json({ error: err.message });
  }
};

// Single membership for a party — powers the enrolment card on the customer
// detail popup. Returns { membership: null } (200) when the party isn't a
// member, so the client can branch without treating it as an error.
exports.getMembershipByParty = async (req, res) => {
  try {
    const partyId = parseInt(req.params.partyId, 10);
    if (!isFinite(partyId)) return res.status(400).json({ error: 'Invalid party id' });
    const row = await Membership.findOne({
      where: { party_id: partyId },
      include: MEMBERSHIP_INCLUDE,
    });
    res.json({ membership: row || null });
  } catch (err) {
    console.error('[membership.getMembershipByParty]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Derive the default membership number from the shop's configured source,
 * when the client didn't supply one. 'mobile' → the party's mobile_1;
 * 'auto' → a deterministic, collision-free code from the party id; 'manual'
 * → none (the operator must type it). The result is still validated for
 * uniqueness by the caller.
 */
function defaultMembershipNo(source, party) {
  if (source === 'auto') return `M${String(party.party_id).padStart(6, '0')}`;
  if (source === 'mobile') return party.mobile_1 ? String(party.mobile_1).trim() : null;
  return null; // 'manual'
}

exports.enroll = async (req, res) => {
  try {
    const partyId = parseInt(req.body.party_id, 10);
    const planId = parseInt(req.body.plan_id, 10);
    if (!isFinite(partyId)) return res.status(400).json({ error: 'party_id is required' });
    if (!isFinite(planId)) return res.status(400).json({ error: 'plan_id is required' });

    const party = await Party.findByPk(partyId);
    if (!party) return res.status(404).json({ error: 'Customer not found' });
    // Loyalty membership is a customer concept — a supplier-only party can't
    // be enrolled. Customer and Both qualify.
    if (party.party_type === 'Supplier') {
      return res.status(400).json({ error: 'Only customers can be enrolled in a membership' });
    }

    const plan = await MembershipPlan.findByPk(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!plan.is_active) return res.status(400).json({ error: 'That plan is inactive — pick an active plan' });

    // One membership per party.
    const existing = await Membership.findOne({ where: { party_id: partyId } });
    if (existing) return res.status(400).json({ error: 'This customer is already a member' });

    // Resolve the card number: explicit value wins, else derive from the
    // shop's configured source.
    let membershipNo = req.body.membership_no != null ? String(req.body.membership_no).trim() : '';
    if (!membershipNo) {
      const settings = await SystemSettings.findByPk(1);
      const source = (settings && settings.membership_no_source) || 'mobile';
      membershipNo = defaultMembershipNo(source, party) || '';
    }
    if (!membershipNo) {
      return res.status(400).json({ error: 'Membership number is required (the customer has no mobile on file to use as the number)' });
    }
    if (membershipNo.length > 40) return res.status(400).json({ error: 'Membership number: max 40 characters' });

    // Uniqueness (friendly message ahead of the DB UNIQUE constraint).
    const dupNo = await Membership.findOne({ where: ciWhere('membership_no', membershipNo) });
    if (dupNo) {
      return res.status(400).json({ error: 'That membership number is already used by another member — choose a different one' });
    }

    // Validity: explicit expiry wins; else derive from the plan.
    const enrolledDate = req.body.enrolled_date ? String(req.body.enrolled_date) : todayStr();
    let expiryDate = req.body.expiry_date ? String(req.body.expiry_date) : null;
    if (!expiryDate) expiryDate = addMonths(enrolledDate, plan.validity_months);

    const row = await Membership.create({
      party_id: partyId,
      plan_id: planId,
      membership_no: membershipNo,
      status: 'Active',
      enrolled_date: enrolledDate,
      expiry_date: expiryDate,
      date_of_birth: req.body.date_of_birth ? String(req.body.date_of_birth) : null,
      // Never client-set. Points only move via the ledger from Phase 3.
      points_balance: 0,
      notes: req.body.notes ? String(req.body.notes).trim() : null,
    });

    const full = await Membership.findByPk(row.membership_id, { include: MEMBERSHIP_INCLUDE });
    res.status(201).json(full);
  } catch (err) {
    console.error('[membership.enroll]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Bulk-enrol existing customers into a plan — an OPT-IN, owner-triggered
 * migration tool (never automatic). Enrols every active, non-system-cash
 * Customer/Both party that isn't already a member, and (optionally) seeds each
 * one's starting points from their past purchase value at the plan's rate.
 *
 * Safe to re-run: already-enrolled customers are skipped (the party_id UNIQUE
 * constraint + an explicit skip), so a second run only picks up newly-added
 * customers and never double-seeds. Each customer is enrolled in its own
 * transaction, so one bad row (e.g. a card-number clash) can't abort the batch.
 *
 * Seeding writes an 'adjust' points-ledger row (source_type 'seed') — it does
 * NOT touch any bill, tax, or ledger; it's a loyalty starting balance only.
 */
exports.bulkEnroll = async (req, res) => {
  try {
    const planId = parseInt(req.body.plan_id, 10);
    const seedPoints = !!req.body.seed_points;
    if (!isFinite(planId)) return res.status(400).json({ error: 'plan_id is required' });

    const plan = await MembershipPlan.findByPk(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!plan.is_active) return res.status(400).json({ error: 'That plan is inactive — pick an active plan' });

    const settings = await SystemSettings.findByPk(1);
    const source = (settings && settings.membership_no_source) || 'mobile';
    const pointsRate = Number(plan.points_per_100) || 0;
    const QT = sequelize.QueryTypes.SELECT;

    // Already-enrolled party ids (skip them).
    const enrolledIds = (await Membership.findAll({ attributes: ['party_id'], raw: true })).map((r) => r.party_id);

    // Eligible customers: Customer/Both, active, not the system Cash party,
    // not already enrolled. Optional explicit party_id subset via scope.
    const where = {
      party_type: { [Op.in]: ['Customer', 'Both'] },
      is_active: true,
      is_system_cash: false,
      party_id: { [Op.notIn]: enrolledIds.length ? enrolledIds : [0] },
    };
    if (Array.isArray(req.body.party_ids) && req.body.party_ids.length) {
      const subset = req.body.party_ids.map((x) => parseInt(x, 10)).filter(Number.isFinite);
      where.party_id = { [Op.and]: [{ [Op.notIn]: enrolledIds.length ? enrolledIds : [0] }, { [Op.in]: subset.length ? subset : [0] }] };
    }

    const parties = await Party.findAll({ where });

    // In-memory set of used membership numbers so we don't clash within the batch.
    const usedNos = new Set(
      (await Membership.findAll({ attributes: ['membership_no'], raw: true }))
        .map((r) => String(r.membership_no).toLowerCase()),
    );

    const today = todayStr();
    let enrolled = 0, skipped = 0, seededMembers = 0, seededPoints = 0;

    for (const p of parties) {
      // Card number: mobile when the shop uses that source and it's free;
      // otherwise a deterministic, collision-free code from the party id.
      let no = (source === 'mobile' && p.mobile_1) ? String(p.mobile_1).trim() : '';
      if (!no || usedNos.has(no.toLowerCase())) no = `M${String(p.party_id).padStart(6, '0')}`;
      if (usedNos.has(no.toLowerCase())) { skipped++; continue; }

      const expiry = addMonths(today, plan.validity_months);
      const t = await sequelize.transaction();
      try {
        const mem = await Membership.create({
          party_id: p.party_id, plan_id: planId, membership_no: no,
          status: 'Active', enrolled_date: today, expiry_date: expiry, points_balance: 0,
        }, { transaction: t });
        usedNos.add(no.toLowerCase());

        if (seedPoints && pointsRate > 0) {
          const [row] = await sequelize.query(
            "SELECT COALESCE(SUM(total_amount),0)::float AS tot FROM sales_bills WHERE customer_id = :pid AND is_cancelled = false",
            { replacements: { pid: p.party_id }, type: QT, transaction: t },
          );
          const tot = Number(row && row.tot) || 0;
          const pts = Math.floor((tot / 100) * pointsRate);
          if (pts > 0) {
            await MembershipPointsLedger.create({
              membership_id: mem.membership_id, type: 'adjust', points: pts,
              source_type: 'seed',
              note: `Seeded ${pts} pts from past purchases (₹${tot.toFixed(2)})`,
              created_by: (req.user && req.user.user_id) || null,
            }, { transaction: t });
            await Membership.update({ points_balance: pts }, { where: { membership_id: mem.membership_id }, transaction: t });
            seededMembers++; seededPoints += pts;
          }
        }
        await t.commit();
        enrolled++;
      } catch (e) {
        try { await t.rollback(); } catch (_) { /* already finished */ }
        skipped++;
      }
    }

    res.json({ enrolled, skipped, seededMembers, seededPoints, plan: plan.plan_name });
  } catch (err) {
    console.error('[membership.bulkEnroll]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.updateMembership = async (req, res) => {
  try {
    const row = await Membership.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Membership not found' });

    const updates = {};

    // Change plan (must exist + be active).
    if (req.body.plan_id !== undefined) {
      const planId = parseInt(req.body.plan_id, 10);
      if (!isFinite(planId)) return res.status(400).json({ error: 'Invalid plan_id' });
      const plan = await MembershipPlan.findByPk(planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (!plan.is_active) return res.status(400).json({ error: 'That plan is inactive — pick an active plan' });
      updates.plan_id = planId;
    }

    // Change card number (unique, case-insensitive, excluding self).
    if (req.body.membership_no !== undefined) {
      const no = String(req.body.membership_no).trim();
      if (!no) return res.status(400).json({ error: 'Membership number is required' });
      if (no.length > 40) return res.status(400).json({ error: 'Membership number: max 40 characters' });
      const dup = await Membership.findOne({
        where: { [Op.and]: [ciWhere('membership_no', no), { membership_id: { [Op.ne]: row.membership_id } }] },
      });
      if (dup) return res.status(400).json({ error: 'That membership number is already used by another member' });
      updates.membership_no = no;
    }

    if (req.body.status !== undefined) {
      if (!['Active', 'Suspended', 'Expired'].includes(req.body.status)) {
        return res.status(400).json({ error: 'status must be Active, Suspended, or Expired' });
      }
      updates.status = req.body.status;
    }

    if (req.body.expiry_date !== undefined) {
      updates.expiry_date = req.body.expiry_date ? String(req.body.expiry_date) : null;
    }
    if (req.body.enrolled_date !== undefined && req.body.enrolled_date) {
      updates.enrolled_date = String(req.body.enrolled_date);
    }
    if (req.body.date_of_birth !== undefined) {
      updates.date_of_birth = req.body.date_of_birth ? String(req.body.date_of_birth) : null;
    }
    if (req.body.notes !== undefined) updates.notes = req.body.notes ? String(req.body.notes).trim() : null;

    // points_balance / party_id are never editable through this endpoint.
    await row.update(updates);
    const full = await Membership.findByPk(row.membership_id, { include: MEMBERSHIP_INCLUDE });
    res.json(full);
  } catch (err) {
    console.error('[membership.updateMembership]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Membership report — KPIs + actionable lists for the report page.
 *   · statusCounts   — members by status (Active/Suspended/Expired)
 *   · totalPoints    — outstanding points across Active members (the loyalty
 *                      liability) + its rupee value at the current redeem rate
 *   · planBreakdown  — active member count per plan
 *   · expiring       — Active members whose membership expires within `days`
 *   · birthdays      — Active members whose birthday is today
 * Read-only; nothing here sends anything (reminders are operator-initiated on
 * the client via wa.me links).
 */
exports.getReport = async (req, res) => {
  try {
    const settings = await SystemSettings.findByPk(1);
    const days = parseInt(req.query.days, 10) > 0
      ? parseInt(req.query.days, 10)
      : (Number(settings && settings.membership_expiry_reminder_days) || 7);
    const valuePerPoint = Number(settings && settings.membership_redeem_value_per_point) || 0;

    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const end = new Date(now); end.setDate(end.getDate() + days);
    const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
    const mm = now.getMonth() + 1;
    const dd = now.getDate();

    const QT = sequelize.QueryTypes.SELECT;

    const statusRows = await sequelize.query(
      "SELECT status, COUNT(*)::int AS c FROM memberships GROUP BY status", { type: QT });
    const statusCounts = { Active: 0, Suspended: 0, Expired: 0 };
    statusRows.forEach((r) => { statusCounts[r.status] = r.c; });

    const [ptsRow] = await sequelize.query(
      "SELECT COALESCE(SUM(points_balance),0)::float AS total FROM memberships WHERE status='Active'", { type: QT });
    const totalPoints = Number(ptsRow && ptsRow.total) || 0;

    const planBreakdown = await sequelize.query(
      `SELECT p.plan_id, p.plan_name, p.discount_percent, p.points_per_100,
              COUNT(m.membership_id)::int AS members
         FROM membership_plans p
         LEFT JOIN memberships m ON m.plan_id = p.plan_id AND m.status = 'Active'
        GROUP BY p.plan_id, p.plan_name, p.discount_percent, p.points_per_100, p.sort_order
        ORDER BY p.sort_order ASC, p.plan_name ASC`, { type: QT });

    const expiring = await Membership.findAll({
      where: { status: 'Active', expiry_date: { [Op.between]: [today, endStr] } },
      include: [
        { model: MembershipPlan, as: 'plan', attributes: ['plan_name'] },
        { model: Party, as: 'party', attributes: ['party_id', 'party_name', 'mobile_1'] },
      ],
      order: [['expiry_date', 'ASC']],
    });

    const birthdays = await sequelize.query(
      `SELECT m.membership_id, m.membership_no, m.date_of_birth, m.points_balance,
              pa.party_id, pa.party_name, pa.mobile_1, pl.plan_name
         FROM memberships m
         JOIN parties pa ON pa.party_id = m.party_id
         LEFT JOIN membership_plans pl ON pl.plan_id = m.plan_id
        WHERE m.status = 'Active' AND m.date_of_birth IS NOT NULL
          AND EXTRACT(MONTH FROM m.date_of_birth) = :mm
          AND EXTRACT(DAY   FROM m.date_of_birth) = :dd
        ORDER BY pa.party_name ASC`,
      { replacements: { mm, dd }, type: QT });

    res.json({
      days,
      valuePerPoint,
      statusCounts,
      totalPoints,
      pointsValue: +(totalPoints * valuePerPoint).toFixed(2),
      planBreakdown,
      expiring,
      birthdays,
    });
  } catch (err) {
    console.error('[membership.getReport]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Points history for one membership — the append-only ledger, newest first.
 * Read-only; the balance shown elsewhere is SUM(points) over these rows.
 */
exports.getPointsLedger = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Invalid membership id' });
    const rows = await MembershipPointsLedger.findAll({
      where: { membership_id: id },
      order: [['created_at', 'DESC'], ['entry_id', 'DESC']],
      limit: 200,
    });
    res.json(rows);
  } catch (err) {
    console.error('[membership.getPointsLedger]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Un-enroll (hard-delete) a membership. Safe in Phase 1 — a membership carries
 * no financial history yet. When the points ledger lands (Phase 3), this will
 * be revisited to preserve or archive point history.
 */
exports.deleteMembership = async (req, res) => {
  try {
    const row = await Membership.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Membership not found' });
    await row.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error('[membership.deleteMembership]', err);
    res.status(500).json({ error: err.message });
  }
};
