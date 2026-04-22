const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SystemSettings = sequelize.define('SystemSettings', {
  setting_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  company_name: {
    type: DataTypes.STRING(200),
    defaultValue: 'My Company',
  },
  company_address: {
    type: DataTypes.TEXT,
  },
  gstin: {
    type: DataTypes.STRING(15),
  },
  pan_number: {
    type: DataTypes.STRING(10),
  },
  logo_path: {
    type: DataTypes.STRING(255),
  },
  financial_year_start: {
    type: DataTypes.DATEONLY,
  },
  financial_year_end: {
    type: DataTypes.DATEONLY,
  },
  gst_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  multi_warehouse_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  batch_tracking_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  expiry_tracking_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  serial_tracking_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  audit_trail_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  interest_calculation_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  bank_reconciliation_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  manufacturing_module_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  low_stock_alert_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  allow_negative_stock: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  sales_bill_prefix: {
    type: DataTypes.STRING(20),
    defaultValue: '',
  },
  purchase_bill_prefix: {
    type: DataTypes.STRING(20),
    defaultValue: '',
  },
  sales_return_prefix: {
    type: DataTypes.STRING(20),
    defaultValue: 'SR',
  },
  purchase_return_prefix: {
    type: DataTypes.STRING(20),
    defaultValue: 'PR',
  },
  backup_frequency: {
    type: DataTypes.ENUM('Hourly', 'Daily', 'Weekly', 'Manual'),
    defaultValue: 'Daily',
  },
  last_backup_date: {
    type: DataTypes.DATE,
  },
  // Aging bucket boundaries (in days past due). Inside bucket 1 = "Not yet due",
  // between 1 and 2 = "Watchful", between 2 and 3 = "Chase", beyond 3 = "Critical".
  // Defaults mirror the classic 30/60/90 AR split.
  aging_bucket_1_days: {
    type: DataTypes.INTEGER,
    defaultValue: 30,
  },
  aging_bucket_2_days: {
    type: DataTypes.INTEGER,
    defaultValue: 60,
  },
  aging_bucket_3_days: {
    type: DataTypes.INTEGER,
    defaultValue: 90,
  },
  // TallyPrime integration — host/port for live XML sync, active company
  // (Tally only talks to the currently-loaded company), sync toggle, and
  // timestamp of the last successful sync (either direction). These are
  // optional; if not set the UI falls back to defaults (localhost:9000).
  tally_host: {
    type: DataTypes.STRING(100),
    defaultValue: 'localhost',
  },
  tally_port: {
    type: DataTypes.INTEGER,
    defaultValue: 9000,
  },
  tally_company: {
    type: DataTypes.STRING(200),
  },
  tally_sync_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  tally_last_sync: {
    type: DataTypes.DATE,
  },
}, {
  tableName: 'system_settings',
  timestamps: false,
});

module.exports = SystemSettings;
