const { DataTypes } = require('sequelize');

/**
 * ComplianceAuditLog — immutable record of every event that matters for
 * a financial-year audit trail.
 *
 * Written by:
 *   · The Financial Year settings controller (when compliance mode flips
 *     on/off, when a lock date is set or cleared, when require-password
 *     is toggled).
 *   · Voucher controllers (Sale, Purchase, Receipt, Payment, Expense,
 *     Journal) when a user overrides a soft or hard fiscal lock.
 *
 * Never updated, never deleted — the table is append-only and retained
 * forever (Indian compliance norms suggest at least 8 years). A future
 * `archive_before` column could move old rows to cold storage if the
 * table ever grows large enough to matter, but for typical SMB volumes
 * (a few dozen overrides per FY) it'll stay tiny.
 *
 * Reads by:
 *   · The audit-log viewer in Settings → Financial Year
 *   · External CA tools that pull /api/compliance/audit-log
 *
 * Why the snapshot fields (user_name, user_role): the User row could
 * be deactivated or renamed after the event; a CA reading the log a
 * year later needs to see "what Riya saw" not "what Riya is now".
 * Same reasoning for from_value / to_value JSON snapshots.
 */
module.exports = (sequelize) => {
  const ComplianceAuditLog = sequelize.define('ComplianceAuditLog', {
    audit_log_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    // ── Event identity ───────────────────────────────────────────────
    event_type: {
      // Categorical so the viewer can filter and the API can stats.
      //   compliance_toggled   — fy_compliance_mode flipped (on/off)
      //   soft_lock_set        — fy_soft_lock_date changed (incl. clear)
      //   hard_lock_set        — fy_hard_lock_date changed
      //   require_password_set — fy_require_override_password flipped
      //   soft_override        — backdated voucher save with soft override
      //   hard_override        — backdated voucher save with hard override
      //   post_close_edit      — edit of a voucher dated before the lock
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    event_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },

    // ── Who ───────────────────────────────────────────────────────────
    // user_id is the FK; user_name + user_role are snapshots taken at
    // event time so the log stays readable even if the User row is
    // later renamed / deactivated.
    user_id:   { type: DataTypes.INTEGER },
    user_name: { type: DataTypes.STRING(150) },
    user_role: { type: DataTypes.STRING(60) },

    // ── What ──────────────────────────────────────────────────────────
    // For settings changes: target_type='settings', target_id=null,
    //   target_label='Compliance mode toggled on'.
    // For voucher overrides: target_type='sales_bill' etc., target_id=
    //   the row's PK, target_label='Sale INV-2025-007 dated 30 Mar 2026'.
    target_type:  { type: DataTypes.STRING(40) },
    target_id:    { type: DataTypes.INTEGER },
    target_label: { type: DataTypes.STRING(255) },

    // The voucher's date that triggered the lock check. NULL for
    // settings-change events. Lets the auditor sort/filter by the
    // disputed transaction's period independently of when the override
    // was logged.
    target_date:  { type: DataTypes.DATEONLY },

    // ── Why ───────────────────────────────────────────────────────────
    // Free-text reason the operator typed in the override modal.
    // Required for soft/hard overrides; null for system-driven events.
    reason: { type: DataTypes.TEXT },

    // ── Before / after snapshots ─────────────────────────────────────
    // JSON snapshots for settings changes (e.g.
    //   from_value: { fy_soft_lock_date: '2025-12-31' },
    //   to_value:   { fy_soft_lock_date: '2026-03-31' }
    // ). NULL for override events (the voucher itself is the artifact).
    from_value: { type: DataTypes.JSONB },
    to_value:   { type: DataTypes.JSONB },

    // ── Flags ────────────────────────────────────────────────────────
    // is_hard_override:true marks the highest-severity event class so
    // dashboards / external audits can group those specifically.
    is_hard_override: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    // Free-form extras (IP, user-agent, route, anything else the caller
    // wants to record). Kept as JSONB so we never need a schema change
    // to attach new context to an event.
    metadata: { type: DataTypes.JSONB },
  }, {
    tableName: 'compliance_audit_logs',
    timestamps: false,                 // event_at + created-by-side state are explicit
    indexes: [
      { fields: ['event_type'] },
      { fields: ['event_at'] },
      { fields: ['user_id'] },
      { fields: ['target_type', 'target_id'] },
    ],
  });

  return ComplianceAuditLog;
};
