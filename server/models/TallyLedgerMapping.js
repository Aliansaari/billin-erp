const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Persisted mapping from Tally ledger names → our chart-of-accounts ledger.
// Reused on every Tally re-import so the user only confirms each unfamiliar
// ledger name once. The auto-mapper writes 'high'/'medium' rows; user
// overrides stamp the row with 'manual'.
module.exports = (sequelize) => {
  const TallyLedgerMapping = sequelize.define('TallyLedgerMapping', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tally_ledger_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    // FK to ledger_accounts.ledger_id — kept loose (no DB-level FK) since the
    // user might delete a target ledger; we'd rather surface that as a
    // mapping-needs-review state than a constraint violation at import time.
    mapped_ledger_account_id: { type: DataTypes.INTEGER },
    confidence: {
      type: DataTypes.ENUM('high', 'medium', 'low', 'manual', 'unmapped'),
      defaultValue: 'low',
      allowNull: false,
    },
  }, {
    tableName: 'tally_ledger_mappings',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return TallyLedgerMapping;
};
