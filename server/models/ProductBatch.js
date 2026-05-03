const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * ProductBatch — a tracked lot of one product.
 *
 * One row per (product_id, batch_number) pair. The same batch_number is
 * allowed across different products (e.g. "Lot-2401" for both Bread and
 * Milk), enforced via the unique index on (product_id, batch_number) — not
 * batch_number alone.
 *
 * manufacture_date / expiry_date / notes are optional metadata; only the
 * batch_number is required. is_active is a soft-delete: a batch with stock
 * movements can never be hard-deleted (see B3 invariant), but an admin can
 * mark it inactive once it's empty so the dropdowns stop offering it.
 *
 * Per-godown stock is in product_batch_stock — this table is metadata only.
 */
const ProductBatch = sequelize.define('ProductBatch', {
  batch_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'products', key: 'product_id' },
  },
  batch_number: {
    type: DataTypes.STRING(60),
    allowNull: false,
  },
  manufacture_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  expiry_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // Per-batch landed cost. Set on batch creation from the purchase
  // line's purchase_rate; first-write-wins (a re-purchase of an
  // existing batch keeps the original rate so historical cost
  // attribution stays stable). Used by single-mode profit reports
  // when the parent product is_batch_tracked — cost_rate snapshot on
  // the sales line reads from this rather than products.weighted_avg_cost.
  // 4 decimals to match weighted_avg_cost precision.
  purchase_rate: {
    type: DataTypes.DECIMAL(14, 4),
    allowNull: true,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'product_batches',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { unique: true, fields: ['product_id', 'batch_number'] },
    { fields: ['product_id', 'expiry_date'] },
    { fields: ['expiry_date'] },
  ],
});

module.exports = ProductBatch;
