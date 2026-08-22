const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * Membership — a single customer's enrolment into a loyalty plan.
 *
 * Sidecar to `parties`: exactly one membership row per party (enforced by a
 * UNIQUE index on party_id). It holds the enrolment metadata — which plan,
 * the human-facing membership number, status, and validity window.
 *
 * STABLE KEY vs LOOKUP HANDLE — the design decision that keeps this safe:
 *   The membership's true identity is `party_id` (immutable, stable). The
 *   `membership_no` is a *lookup handle* the cashier types/scans at the
 *   counter. It defaults to the customer's mobile number at enrolment (per
 *   the shop's `membership_no_source` setting) but is editable, so a customer
 *   changing their phone number never orphans their membership. Points
 *   history in a later phase keys off party_id / membership_id, NEVER off
 *   the phone number.
 *
 * NO MONEY LIVES HERE:
 *   `points_balance` is a denormalised CACHE for fast display, mirroring the
 *   Party.current_balance convention. In Phase 1 it is always 0. From Phase 3
 *   the append-only membership_points_ledger is the source of truth and this
 *   column is recomputed from it — never hand-edited. This model must never
 *   import a financial helper or post to a ledger.
 *
 * Lifecycle:
 *   status ∈ {Active, Suspended, Expired}. Suspended/Expired members are
 *   hidden from the billing auto-discount but their row (and future points)
 *   are preserved. Removing a party cascades this row away (a membership is
 *   not, by itself, financial history in Phase 1).
 */
module.exports = (sequelize) => {
  const Membership = sequelize.define('Membership', {
    membership_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // One membership per party. UNIQUE at the DB level (see CREATE TABLE in
    // the migration helpers) — a real integrity rule, so we declare it here
    // too and the shapes must stay in lock-step.
    party_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: 'parties', key: 'party_id' },
    },
    plan_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'membership_plans', key: 'plan_id' },
    },
    // Human-facing card number. Defaults to the party's mobile at enrolment
    // but is editable and independent thereafter. UNIQUE so a scan resolves
    // to exactly one member. Widened to 40 chars to comfortably hold a phone,
    // a manual code, or an auto-generated string.
    membership_no: {
      type: DataTypes.STRING(40),
      allowNull: false,
      unique: true,
    },
    status: {
      type: DataTypes.ENUM('Active', 'Suspended', 'Expired'),
      allowNull: false,
      defaultValue: 'Active',
    },
    enrolled_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    // NULL = never expires (plan.validity_months was null at enrolment).
    expiry_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    // Optional birth date — powers birthday reminders (opt-in). Only the
    // month/day are used for the reminder match; the year is stored as given.
    date_of_birth: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    // Denormalised cache — see the header. Source of truth from Phase 3 is
    // the points ledger. Always 0 in Phase 1.
    points_balance: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    notes: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'memberships',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
  });
  return Membership;
};
