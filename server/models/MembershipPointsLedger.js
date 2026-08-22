const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * MembershipPointsLedger — append-only log of every loyalty-point movement.
 *
 * SOURCE OF TRUTH: a membership's points_balance is a denormalised cache;
 * the real balance is SUM(points) over this table for that membership. Rows
 * are NEVER updated or deleted — a correction is a new row (a 'reverse' or
 * 'adjust'). This mirrors the discipline of stock_ledger / ledger_entries.
 *
 * Signed deltas: `points` is a SIGNED number.
 *   · earn    → positive (points granted on a sale)
 *   · redeem  → negative (points spent as a discount)   [Phase 3b]
 *   · reverse → the opposite sign of the row it undoes (bill cancellation)
 *   · adjust  → manual correction (either sign)          [future]
 *   · expire  → negative (points lapsed)                 [future]
 * So the balance is always exactly SUM(points); no separate direction flag
 * to keep in sync.
 *
 * NOT double-entry accounting: points are a loyalty liability the shop tracks
 * for its own program. This table never posts to ledger_entries and never
 * touches a bill total, tax, or party balance. The money impact of a
 * *redemption* (Phase 3b) rides the bill's existing discount field, not this
 * table — this table only records the points side.
 *
 * Idempotency: earning keys off (membership_id, source_sales_bill_id, type)
 * so re-running a save can't double-grant; reversal checks for an existing
 * 'reverse' row for the bill before undoing.
 */
module.exports = (sequelize) => {
  const MembershipPointsLedger = sequelize.define('MembershipPointsLedger', {
    entry_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    membership_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'memberships', key: 'membership_id' },
    },
    type: {
      type: DataTypes.ENUM('earn', 'redeem', 'adjust', 'expire', 'reverse'),
      allowNull: false,
    },
    // Signed delta — see header. DECIMAL so fractional-rate programs are
    // representable, though earning floors to whole points by policy.
    points: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // Where the movement came from: 'sales_bill', 'reversal', 'manual', …
    source_type: {
      type: DataTypes.STRING(20),
    },
    // The sales bill that earned/redeemed these points (nullable). Plain
    // INTEGER, no DB FK — a cancelled/deleted bill must not cascade-wipe the
    // audit trail, mirroring how ledger_entries tags stay put.
    source_sales_bill_id: {
      type: DataTypes.INTEGER,
    },
    note: {
      type: DataTypes.TEXT,
    },
    created_by: {
      type: DataTypes.INTEGER,
    },
  }, {
    tableName: 'membership_points_ledger',
    timestamps: true,
    createdAt: 'created_at',
    // Append-only — rows are never updated, so there is no updatedAt column.
    updatedAt: false,
  });
  return MembershipPointsLedger;
};
