const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * MembershipPlan — a loyalty tier the shop offers to its customers
 * (e.g. Silver / Gold / Platinum).
 *
 * Why this exists:
 *   A retail counter wants to reward repeat customers. A plan is the
 *   reusable definition of a tier: the discount it grants at billing and
 *   the rate at which it earns loyalty points. Customers are attached to a
 *   plan via the `memberships` sidecar (one membership per party).
 *
 * READ THIS BEFORE TOUCHING ANYTHING FINANCIAL:
 *   A plan only stores *configuration numbers*. Nothing in this table posts
 *   to a ledger, changes a bill total, or moves money on its own. The
 *   `discount_percent` and `points_per_100` here are read by the billing
 *   layer in a LATER phase; in Phase 1 they are inert config the operator
 *   maintains. This model must never import a financial helper.
 *
 * Uniqueness:
 *   Plan-name uniqueness (case-insensitive) is enforced in the controller,
 *   NOT by a DB constraint — mirroring the Salesman master. This keeps the
 *   model shape byte-for-byte aligned with the explicit CREATE TABLE in the
 *   schema-migration helpers and avoids sync() adding indexes to existing
 *   per-company databases.
 *
 * Soft delete:
 *   `is_active = false` hides a plan from the enrollment picker but leaves
 *   every customer already on that plan untouched. A plan that has members
 *   is never hard-deleted (the controller guards this).
 */
module.exports = (sequelize) => {
  const MembershipPlan = sequelize.define('MembershipPlan', {
    plan_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    plan_name: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    // Percentage discount auto-suggested at billing for members on this
    // plan. Stored 0–100 with 2dp. CONFIG ONLY — never auto-applied in
    // Phase 1; the billing layer reads it in a later phase and routes it
    // through the EXISTING discount input so the money pipeline is unchanged.
    discount_percent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // Loyalty points earned per ₹100 of qualifying spend. CONFIG ONLY in
    // Phase 1 (points earning lands in Phase 3). Two decimals so a shop can
    // set fractional rates (e.g. 1.5 points per ₹100).
    points_per_100: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // Membership validity in months from the enrolment date. NULL = the
    // membership never expires. Used to compute a membership's expiry_date
    // at enrolment time; changing it here does NOT retro-actively move the
    // expiry of members already enrolled.
    validity_months: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Informational threshold for a future auto-upgrade helper (Phase 4).
    // Not enforced anywhere in Phase 1.
    min_spend_to_upgrade: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // Display ordering so tiers list Silver → Gold → Platinum rather than
    // by insertion order. Lower sorts first.
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    notes: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'membership_plans',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
  });
  return MembershipPlan;
};
