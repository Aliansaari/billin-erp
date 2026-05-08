const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Product = sequelize.define('Product', {
  product_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  barcode: {
    type: DataTypes.STRING(20),
    unique: true,
    allowNull: false,
  },
  category_id: {
    type: DataTypes.INTEGER,
    references: { model: 'categories', key: 'category_id' },
  },
  product_name: {
    type: DataTypes.STRING(200),
    allowNull: false,
  },
  product_description: {
    type: DataTypes.TEXT,
  },
  size_value: {
    type: DataTypes.STRING(100),
  },
  size_unit: {
    type: DataTypes.ENUM('S', 'M', 'L', 'XL', 'XXL', 'Numeric', 'Custom'),
  },
  article_number: {
    type: DataTypes.STRING(200),
  },
  hsn_code: {
    type: DataTypes.STRING(50),
  },
  gst_rate: {
    type: DataTypes.DECIMAL(8, 2),
    defaultValue: 0,
  },
  cess_rate: {
    type: DataTypes.DECIMAL(8, 2),
    defaultValue: 0,
  },
  unit_of_measurement: {
    type: DataTypes.ENUM('PCS', 'KG', 'METER', 'LITER', 'BOX', 'DOZEN'),
    defaultValue: 'PCS',
  },
  // DECIMAL so partial boxes are representable (e.g. 0.5 m fabric, 2.5 kg).
  // Must match PurchaseBillItem.quantity_per_box and SalesBillItem.quantity_per_box
  // — they are DECIMAL(10,2) and a type mismatch caused silent truncation of
  // fractional pack sizes whenever a new product was auto-created from a purchase.
  quantity_per_box: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 1,
  },
  minimum_stock_level: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  maximum_stock_level: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  reorder_level: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  opening_stock: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  opening_stock_rate: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  opening_stock_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  current_stock: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  purchase_rate: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  margin_percentage: {
    type: DataTypes.DECIMAL(8, 2),
    defaultValue: 0,
  },
  sale_rate: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  mrp: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  // Per-product opt-in for batch tracking. Only meaningful when
  // system_settings.batch_tracking_enabled is also ON — when the global
  // toggle is OFF the column stays in the schema but is ignored everywhere
  // (bill forms hide the picker, reports hide the section). Once a
  // batch-tracked product has any stock movement, the controller refuses
  // to flip this back to false (would orphan the batch ledger).
  //
  // Constraint (enforced at the controller in Commit 5): batch tracking
  // requires product_mode='single'. Variant-mode products silently lose
  // batch info on save because lookupProduct can resolve to a non-batched
  // sibling. The migration in server/index.js clears is_batch_tracked on
  // any variant rows that had it set, eliminating that defect.
  is_batch_tracked: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // ── Single-product mode (Tally-style) ────────────────────────────
  //
  // 'variant' = current behavior: a purchase line at a different MRP /
  //   rate / size creates a new product row with a new barcode. Each
  //   variant has its own purchase_rate, sale_rate, current_stock.
  //   purchase_rate is overwritten on every purchase (was harmless under
  //   variant mode because the differing rate creates a new variant).
  //
  // 'single' = one product, many purchase prices over time. Cost is
  //   tracked as weighted_avg_cost (recomputed each purchase). The
  //   catalog purchase_rate stays frozen at first-purchase rate — this
  //   is the audit-flagged change (item 8.2): destructive overwrite of
  //   purchase_rate would obliterate cost basis, so single mode reads
  //   cost from weighted_avg_cost (or per-batch rate, when batched).
  //
  // Mode is permanent once a product exists. New products inherit the
  // current system_settings.default_product_mode at creation time.
  product_mode: {
    type: DataTypes.ENUM('variant', 'single'),
    defaultValue: 'variant',
    allowNull: false,
  },
  // Running weighted-average cost for single-mode products without
  // batch tracking. Recomputed on every purchase / purchase-return /
  // adjustment via the Phase-4 helper. NULL for variant-mode products
  // and for single+batch products (cost lives on the batch row instead).
  // 4 decimals to absorb compounding drift across many small purchases.
  weighted_avg_cost: {
    type: DataTypes.DECIMAL(14, 4),
    allowNull: true,
  },
  // Convenience snapshot of the most recent purchase line's rate and
  // date. Not used for cost calculations (weighted_avg_cost is the
  // basis); shown on Product detail / movement views so the operator
  // sees the latest landed price without opening the bill.
  last_purchase_rate: {
    type: DataTypes.DECIMAL(14, 4),
    allowNull: true,
  },
  last_purchase_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  // ── Color mode (mutually exclusive) ────────────────────────────
  //
  //   'none'   — no color tracking. Default for every existing product.
  //   'single' — gated on system_settings.single_color_enabled. Free-text
  //              `color_label` field on this row, pure metadata for
  //              filtering. No stock implications.
  //   'multi'  — gated on system_settings.multi_color_enabled. Per-color
  //              stock tracked in product_colors table (joined by
  //              product_id). Bill items carry color_id FK. Sales form
  //              shows a required color dropdown; purchase form shows
  //              the color-box popover.
  //
  // Mutually exclusive — a product is in EXACTLY one mode at a time.
  // The product form picks; the controller validates that flipping
  // away from 'multi' is only allowed when sum of color stocks is 0.
  color_mode: {
    type: DataTypes.ENUM('none', 'single', 'multi'),
    defaultValue: 'none',
    allowNull: false,
  },
  // Free-text label for color_mode='single'. NULL otherwise. Indexed
  // separately via the migration block so list filters ("all Red
  // products") read fast.
  color_label: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
}, {
  tableName: 'products',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { unique: true, fields: ['barcode'] },
    { fields: ['product_name'] },
    { fields: ['article_number'] },
    { fields: ['category_id'] },
  ],
});

module.exports = Product;
