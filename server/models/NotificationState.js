// ── NotificationState ─────────────────────────────────────────────────
//
// Per-user-per-key tracking row for the smart-notifications bell.
//
// The notification system itself is stateless: each request to
// /api/notifications re-runs every detector against the live business
// data and emits "candidate" notifications. Those candidates carry a
// STABLE KEY (e.g. `cheque-bounced:1234`, `pdc-due:5678:2026-05-14`).
// This table stores per-user state for each key — has the operator
// seen it? dismissed it? snoozed it? — so the same fact doesn't fire
// over and over.
//
// Why keys instead of event rows:
//   • The truth lives in the underlying data (cheques, bills, etc.).
//     We don't need to mirror every detection as an event log — we
//     recompute on each request and only track per-user attitude.
//   • Database stays compact. A firm with 10 users and ~15 active
//     notifications each is 150 rows total. Dismissed/seen rows >90
//     days old are pruned periodically (cheap maintenance).
//
// status semantics:
//   • active     — fresh, never seen by the user. Drives the unread
//                  badge count on the bell.
//   • seen       — operator has opened the bell at least once with
//                  this row visible. Stays in the list but doesn't
//                  count toward the badge.
//   • dismissed  — operator explicitly dismissed; hidden forever
//                  unless the underlying signal resolves and re-fires
//                  (e.g. cheque dismissed → cleared → bounced again).
//
// snoozed_until is checked separately from status. When set in the
// future, the row is hidden until the time passes — regardless of
// status. Clearing the snooze brings the row back as active.

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const NotificationState = sequelize.define('NotificationState', {
    notification_state_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'user_id' },
      onDelete: 'CASCADE',
    },
    // Stable identifier for this notification instance. Format:
    // `<detector_type>:<entity_id>[:<dimension>]` — eg.
    //   cheque-bounced:1234
    //   pdc-due:5678:2026-05-14
    //   stock-negative:product:42
    //   backup-failed:2026-05-13
    // Detectors are responsible for keeping this stable across runs;
    // the same underlying fact must produce the same key every time.
    notif_key: {
      type: DataTypes.STRING(160),
      allowNull: false,
    },
    // Detector type (eg. 'cheque-bounced', 'pdc-due'). Stored
    // redundantly with the key so we can filter by type without
    // parsing the key string. Drives the user-settings toggle lookup.
    type: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('active', 'seen', 'dismissed'),
      allowNull: false,
      defaultValue: 'active',
    },
    snoozed_until: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    first_seen_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    last_seen_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'notification_states',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      // One row per user per key — the detector emits the same key
      // each run, we upsert against this unique index.
      { unique: true, fields: ['user_id', 'notif_key'] },
      // Filter by user for the bell payload query.
      { fields: ['user_id'] },
      // Filter by type when the operator toggles a setting off and
      // we want to mass-archive everything of that type.
      { fields: ['user_id', 'type'] },
    ],
  });
  return NotificationState;
};
