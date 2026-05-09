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
  // ── Single-color label ─────────────────────────────────────────
  // Adds an optional `color_label` text field on the product master.
  // Pure metadata — no stock implications, just a tag for filtering
  // on lists/reports ("show me all Red products"). Mutually exclusive
  // per-product with multi-color tracked stock.
  single_color_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // ── Multi-color stock tracking ─────────────────────────────────
  // Per-product opt-in via the product form's "Track colors" checkbox.
  // When ON for a product, the purchase form gains a color box (qty
  // per color), the sales form gains a color dropdown (required, only
  // colors with stock>0), and per-color stock is tracked in the
  // product_colors table.
  multi_color_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // ── Merge repeat barcode scans on the sales form ───────────────
  // ON  — same SKU scanned N times merges into one line with qty=N.
  // OFF — N scans = N separate lines (default; matches the current
  //       behavior expected by users counting items off a stack).
  // FORCED OFF when multi_color_enabled is ON and the scanned product
  // is a multi-color tracked SKU — merging would conflate different
  // colors picked across scans into one line.
  merge_repeat_scans_enabled: {
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

  /* ── Developer-tier feature gates ─────────────────────────────────
   *
   * Each `dev_show_*` column controls whether the corresponding feature
   * is visible to NORMAL users (operators, cashiers, accountants).
   * Developer-mode unlocks see EVERY feature regardless of these flags.
   *
   * Defaults are conservative: power-tools that can corrupt accounting
   * data (Ledger Integrity, Cleanup, Restore, Tally live-sync) ship
   * hidden. Routine surfaces (Import / Export, Backup create) ship
   * visible — most shops need them daily.
   *
   * The flags persist in the DB so a developer's choice ("yes, my
   * accountant can use Tally Sync") is shared with every machine on
   * the LAN automatically — no per-PC reconfiguration needed.
   * ─────────────────────────────────────────────────────────────── */

  // Heavy DB-diagnostic page. Runs full-table integrity scans;
  // a non-developer running it on a busy office server creates lock
  // contention. Default OFF.
  dev_show_ledger_integrity: { type: DataTypes.BOOLEAN, defaultValue: false },

  // Bulk row-deletion under "Settings → Data Cleanup". Wipes tables
  // category-by-category. Default OFF.
  dev_show_data_cleanup:     { type: DataTypes.BOOLEAN, defaultValue: false },

  // Restore from backup file → overwrites every table. Default OFF.
  // (Backup CREATION and DOWNLOAD stay visible — those are read-only.)
  dev_show_backup_restore:   { type: DataTypes.BOOLEAN, defaultValue: false },

  // Tally live push/pull. The XML export/import is fine for normal
  // users; only the live HTTP sync is dev-gated because a wrong
  // company name corrupts the destination Tally book. Default OFF.
  dev_show_tally_sync:       { type: DataTypes.BOOLEAN, defaultValue: false },

  // Routine bulk import / export of masters and transactions. Most
  // shops use this every closing day. Default ON.
  dev_show_import_export:    { type: DataTypes.BOOLEAN, defaultValue: true  },

  // Visible Server-Setup screen (lets a user re-point the app at a
  // different LAN host). Default OFF — once configured, regular staff
  // shouldn't be able to break the connection.
  dev_show_server_settings:  { type: DataTypes.BOOLEAN, defaultValue: false },

  /* ── LAN deployment knobs (developer-controlled) ─────────────── */

  // Master switch for accepting LAN clients at all. Default ON. When
  // OFF, the server still runs but rejects any non-loopback origin in
  // the CORS layer.
  dev_lan_enabled:           { type: DataTypes.BOOLEAN, defaultValue: true },

  // Cap concurrent active LAN clients. 0 = unlimited (default). When
  // > 0, the server tracks unique JWTs that hit /api/* in the last
  // 10 minutes; the (n+1)th client gets a 503 with a "license cap
  // reached" message until an existing one goes idle.
  dev_lan_max_clients:       { type: DataTypes.INTEGER, defaultValue: 0 },
}, {
  tableName: 'system_settings',
  timestamps: false,
});

module.exports = SystemSettings;
