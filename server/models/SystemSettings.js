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
  // Default mode for NEW products. Existing products keep their mode
  // permanently — flipping this only affects the next product created
  // (via any path: manual form, auto-from-purchase, Excel import,
  // Tally import). 'variant' = current behavior (one product per
  // unique MRP/rate/size combo). 'single' = Tally-style (one product,
  // many purchase prices over time, cost as weighted average).
  default_product_mode: {
    type: DataTypes.ENUM('variant', 'single'),
    defaultValue: 'variant',
    allowNull: false,
  },
  // Days-before-expiry threshold for the "Expiring soon" amber chip on the
  // batch picker + Expiry Report dashboard widget. Configurable because
  // pharma needs ~90 days lead time while a fast-moving food shop wants 7.
  batch_expiry_alert_days: {
    type: DataTypes.INTEGER,
    defaultValue: 30,
  },
  // Hard block on selling expired batches. Default OFF because wholesale
  // textile/food often deliberately sells aged stock at a discount; pharma
  // would flip this ON.
  block_expired_sales: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // Allow creating a batch row before any stock arrives (e.g. registering
  // an upcoming shipment so the purchase form has it in the dropdown).
  // Default ON — the alternative is forcing every batch creation through
  // a purchase, which is fine until a user wants to pre-register.
  allow_zero_stock_batches: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
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
  // When false, the Sales Bill form hides the Itemised/Amount-only mode
  // toggle and only itemised bills are creatable. Default ON because the
  // feature is non-disruptive (toggle defaults to Itemised).
  enable_amount_only_billing: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
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
