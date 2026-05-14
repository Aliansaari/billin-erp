/*
 * complianceController — read endpoints for the audit log + the
 * settings-side write hooks that produce log rows when compliance
 * config changes.
 *
 * Write hooks for voucher overrides live inside each voucher controller
 * (Sales, Purchase, Receipt, Payment, Expense, Journal) so the audit
 * row is committed inside the same transaction that creates the
 * voucher. Keeping override-logging next to the save is the cleanest
 * way to guarantee the log + the artifact stay in sync.
 */

const { ComplianceAuditLog, SystemSettings } = require('../models');
const { logComplianceEvent } = require('../utils/compliance');

// ── List events ──────────────────────────────────────────────────────
// Filters: event_type, target_type, user_id, from_date, to_date.
// Pagination: page + page_size. Default: most-recent first.
exports.list = async (req, res) => {
  try {
    const where = {};
    if (req.query.event_type)  where.event_type  = req.query.event_type;
    if (req.query.target_type) where.target_type = req.query.target_type;
    if (req.query.user_id)     where.user_id     = Number(req.query.user_id);
    if (req.query.hard_only === '1') where.is_hard_override = true;

    const { Op } = require('sequelize');
    if (req.query.from_date || req.query.to_date) {
      where.event_at = {};
      if (req.query.from_date) where.event_at[Op.gte] = new Date(req.query.from_date + 'T00:00:00');
      if (req.query.to_date)   where.event_at[Op.lte] = new Date(req.query.to_date   + 'T23:59:59');
    }

    const page     = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(req.query.page_size) || 50));

    const { rows, count } = await ComplianceAuditLog.findAndCountAll({
      where,
      order:  [['event_at', 'DESC']],
      limit:  pageSize,
      offset: (page - 1) * pageSize,
    });
    return res.json({
      data:        rows,
      total:       count,
      page,
      page_size:   pageSize,
      total_pages: Math.ceil(count / pageSize),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load audit log', detail: e?.message });
  }
};

// ── Settings-side write hook ─────────────────────────────────────────
// Called by settingsController when compliance config changes — diffs
// the old + new SystemSettings rows and emits one audit event per
// changed compliance field. Exposed here so other settings paths can
// also call it if they grow compliance-aware fields later.
exports.logSettingsDiff = async ({ before, after, user }) => {
  const changes = [];
  const fields = [
    { key: 'fy_compliance_mode',           type: 'compliance_toggled' },
    { key: 'fy_soft_lock_date',            type: 'soft_lock_set' },
    { key: 'fy_hard_lock_date',            type: 'hard_lock_set' },
    { key: 'fy_require_override_password', type: 'require_password_set' },
  ];

  for (const { key, type } of fields) {
    const oldV = before?.[key] ?? null;
    const newV = after?.[key]  ?? null;
    if (String(oldV) === String(newV)) continue;
    // Build a human label so the log reads cleanly without a tool
    // needing to know each event's specific schema.
    let label;
    if (type === 'compliance_toggled')      label = `Compliance mode ${newV ? 'enabled' : 'disabled'}`;
    else if (type === 'soft_lock_set')      label = newV ? `Soft lock set to ${newV}` : 'Soft lock cleared';
    else if (type === 'hard_lock_set')      label = newV ? `Hard lock set to ${newV}` : 'Hard lock cleared';
    else if (type === 'require_password_set') label = `Override password requirement ${newV ? 'enabled' : 'disabled'}`;
    changes.push({
      event_type:   type,
      target_type:  'settings',
      target_label: label,
      from_value:   { [key]: oldV },
      to_value:     { [key]: newV },
    });
  }

  for (const change of changes) {
    await logComplianceEvent({ ...change, user });
  }
};

module.exports.logComplianceEvent = logComplianceEvent;
