const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * ProductBatchStock — per-(product, batch, godown) current_stock.
 *
 * Mirrors the role product_godown_stock plays for non-batch products,
 * but adds the batch dimension. For a batch-tracked product, this is
 * the source of truth: products.current_stock and product_godown_stock
 * are denormalized rollups, maintained by applyBatchStockDelta().
 *
 * Composite PK on (product_id, batch_id, godown_id) — one row per
 * triple. Missing rows are implicitly zero (matches the convention
 * established by product_godown_stock).
 *
 * DECIMAL(14,3) widens past the (10,2) used elsewhere because pharma /
 * food batches are routinely tracked to milligrams or millilitres.
 */
module.exports = (sequelize) => {
  const ProductBatchStock = sequelize.define('ProductBatchStock', {
    product_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: 'products', key: 'product_id' },
    },
    batch_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: 'product_batches', key: 'batch_id' },
    },
    godown_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: 'godowns', key: 'godown_id' },
    },
    current_stock: {
      type: DataTypes.DECIMAL(14, 3),
      defaultValue: 0,
      allowNull: false,
    },
  }, {
    tableName: 'product_batch_stock',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { fields: ['batch_id'] },
      { fields: ['godown_id'] },
      { fields: ['product_id', 'godown_id'] },
    ],
  });
  return ProductBatchStock;
};
