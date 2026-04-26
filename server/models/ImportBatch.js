const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Per-row trail for an import_job. One row here for every parsed source row
// regardless of whether it was created/updated/skipped/rejected. Lets us
// answer questions like "show me everything that came from import #42"
// or "which row in the source XML produced this sales bill?"
const ImportBatch = sequelize.define('ImportBatch', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  import_job_id: { type: DataTypes.INTEGER, allowNull: false },
  entity_type: {
    type: DataTypes.STRING(40),
    allowNull: false,
  },
  entity_id:    { type: DataTypes.INTEGER },
  // External reference — Tally voucher GUID or bill number from the source.
  external_ref: { type: DataTypes.STRING(120) },
  action: {
    type: DataTypes.ENUM('created', 'updated', 'skipped', 'rejected'),
    allowNull: false,
  },
  reason: { type: DataTypes.TEXT },
}, {
  tableName: 'import_batches',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { fields: ['import_job_id'] },
    { fields: ['entity_type', 'entity_id'] },
    { fields: ['external_ref'] },
  ],
});

module.exports = ImportBatch;
