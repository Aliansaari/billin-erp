const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * Godown — physical storage location for stock.
 *
 * Why this exists:
 *   A wholesale operation typically runs more than one warehouse: the city
 *   shop, a back-office godown, a branch in another state. Stock has to live
 *   in a specific place, bills have to be issued from a specific place, and
 *   GST routing depends on the issuing location's state code (Place of Supply
 *   for outward supplies). One company, multiple godowns, books still
 *   consolidated.
 *
 * Branch foundation:
 *   The Branch feature (later phase) layers on top — each branch will own one
 *   or more godowns. Keeping Godown as the primitive (rather than coupling it
 *   to Branch directly) means single-branch deployments stay simple, and the
 *   Branch feature is purely additive when it lands.
 *
 * Default godown:
 *   Exactly one row carries `is_default = true`, enforced by a partial unique
 *   index (CREATE UNIQUE INDEX ... WHERE is_default = true). The migration
 *   block in server/index.js seeds a "Main" godown with is_system=true so
 *   pre-multi-warehouse data has a home, and so the bill forms have a
 *   sensible default to pre-fill on first render.
 *
 * GSTIN field:
 *   Optional. When the same legal entity registers a separate GSTIN for a
 *   godown in a different state, that GSTIN goes here and overrides the
 *   company-level one in print + GSTR-1 + intra/inter-state computation. If
 *   left blank, the company-level GSTIN from SystemSettings is used — which
 *   is the right thing for single-state businesses.
 */
module.exports = (sequelize) => {
  const Godown = sequelize.define('Godown', {
    godown_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    code: {
      // Short identifier shown in bill-form Godown selectors and on print
      // headers (e.g., "MAIN", "MUM-01"). Kept short + unique so the operator
      // can pick a godown by typing 2-3 letters.
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true,
    },
    address: {
      type: DataTypes.TEXT,
    },
    city: {
      type: DataTypes.STRING(80),
    },
    state: {
      // Full state name (e.g. "Maharashtra"). The 2-digit GST state code is
      // derived via stateCodeFromName() at request time — duplicating both
      // would invite drift. Kept as STRING (not ENUM) because state spelling
      // varies in legacy imports and a hard ENUM would reject otherwise-valid
      // names.
      type: DataTypes.STRING(80),
    },
    pincode: {
      type: DataTypes.STRING(10),
    },
    gstin: {
      // Per-godown GSTIN override. NULL => fall back to SystemSettings.gstin.
      // Used by salesController._resolveInterState and the print template.
      type: DataTypes.STRING(15),
    },
    is_default: {
      // Exactly one row may have is_default=true (partial unique index in the
      // migration block). UI flips the flag transactionally — set to true on
      // the new default + false on everyone else, atomically.
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    is_active: {
      // Soft-delete. Inactive godowns are hidden from selectors but their
      // historical bills + stock_ledger rows continue to reference them.
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    is_system: {
      // True only on the auto-seeded "Main" godown. The deletion guard reads
      // this flag — system godowns cannot be hard-deleted (the soft-delete
      // toggle is also blocked by the controller for is_default=true).
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  }, {
    tableName: 'godowns',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { unique: true, fields: ['name'] },
      { unique: true, fields: ['code'] },
    ],
  });
  return Godown;
};
