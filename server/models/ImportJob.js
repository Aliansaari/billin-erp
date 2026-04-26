const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// One row per import attempt. Holds the lifecycle from upload through commit
// and the JSON payloads the UI polls for (preview, mapping, result summary).
//
// Status machine:
//   queued → parsing → validating → awaiting_confirmation → committing → done
//                                                       ↘                ↓
//                                                       cancelled       failed
// `awaiting_confirmation` is hit twice for Tally imports (once for ledger
// mapping, once for the dry-run preview) and once for Excel imports.
const ImportJob = sequelize.define('ImportJob', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  source: {
    type: DataTypes.ENUM(
      'tally',
      'excel_customers', 'excel_suppliers', 'excel_products',
      'excel_sales', 'excel_purchases', 'excel_payments',
    ),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM(
      'queued', 'parsing', 'validating', 'awaiting_confirmation',
      'committing', 'done', 'failed', 'cancelled',
    ),
    defaultValue: 'queued',
    allowNull: false,
  },
  progress_pct:    { type: DataTypes.INTEGER, defaultValue: 0 },
  phase_message:   { type: DataTypes.STRING(255) },
  input_file_path: { type: DataTypes.STRING(500) },
  // Profile = caller-supplied metadata: gst_enabled, fy_start, fy_end, etc.
  profile_json:    { type: DataTypes.JSONB, defaultValue: {} },
  // Mapping payload (Tally only) when status is awaiting_confirmation.
  mapping_json:    { type: DataTypes.JSONB },
  // Dry-run preview payload (4 buckets: create / update / skip / reject).
  preview_json:    { type: DataTypes.JSONB },
  // Final summary returned to the result modal.
  result_summary_json: { type: DataTypes.JSONB },
  // Path to the rejected-rows Excel file generated at finalize.
  rejected_rows_path:  { type: DataTypes.STRING(500) },
  error_message:   { type: DataTypes.TEXT },
  created_by:      { type: DataTypes.INTEGER },
  started_at:      { type: DataTypes.DATE },
  completed_at:    { type: DataTypes.DATE },
}, {
  tableName: 'import_jobs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [{ fields: ['status'] }, { fields: ['created_at'] }],
});

module.exports = ImportJob;
