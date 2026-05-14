// ── NotificationSettings ──────────────────────────────────────────────
//
// Per-user preferences for the smart-notifications bell.
//
// Two layers of control:
//
//   1. master_enabled — kill switch. When false, the bell icon hides
//      entirely in the UI, no detectors run, no polling fires. The
//      operator's slate stays clean (existing rows in
//      notification_states aren't deleted; they just aren't read).
//      Equivalent to "I don't want notifications at all."
//
//   2. type_toggles  — fine-grained per-detector opt-out. JSONB shape:
//        { "cheque-bounced": true, "stock-negative": false, ... }
//      Missing keys default to true (opt-out, not opt-in), so adding
//      a new detector in a future release surfaces it to existing
//      users without forcing a settings update.
//
// Why a dedicated table over a JSONB column on `users`:
//   • Future-proofing — channels (email / sms / in-app) and quiet
//     hours would live here cleanly without bloating the user row.
//   • Cascade on user delete is automatic.
//   • Querying "who has type X enabled?" stays a simple JSONB op
//     without going through the user join.
//
// First-time defaults are inserted by the controller on first read
// (no migration backfill needed). All settings reset to defaults
// the moment the row is deleted, so a user "reset to defaults"
// action is a single DELETE.

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const NotificationSettings = sequelize.define('NotificationSettings', {
    notification_setting_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: 'users', key: 'user_id' },
      onDelete: 'CASCADE',
    },
    master_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    type_toggles: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
  }, {
    tableName: 'notification_settings',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
  });
  return NotificationSettings;
};
