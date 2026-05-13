/*
 * CostLayer — per-product, per-godown FIFO cost layer (audit H6).
 *
 * Each purchase that increases stock inserts one CostLayer row. When the
 * customer setting `cogs_method='fifo'` is active, every sale CONSUMES
 * from the oldest available layer first (FIFO order), and the sale line's
 * snapshot cost_rate is the weighted-average rate of the consumed layers.
 *
 * With `cogs_method='weighted_avg'` (default), this table is still
 * populated by purchases (cheap insurance), but sales don't consume from
 * it — they use products.weighted_avg_cost as today.
 *
 * Lifecycle:
 *   - Purchase line                 → INSERT a layer with qty = bought qty
 *   - Sale line (FIFO mode)         → UPDATE qty_remaining DESC layers, ASC date
 *   - Sales return (FIFO mode)      → restore the most-recent consumed layer's
 *                                     qty_remaining (best-effort; v1 may drift)
 *   - Purchase return (FIFO mode)   → reduce the layer's qty_remaining
 *   - Opening stock                 → INSERT a synthetic layer at the operator's
 *                                     declared cost
 *   - Stock adjustment +ve          → INSERT a synthetic layer at the operator's
 *                                     declared cost (or last known wac)
 *   - Stock adjustment -ve          → consume FIFO same as a sale
 *
 * Indexing: (product_id, godown_id, acquired_at) for fast oldest-first
 * lookup. qty_remaining > 0 partial-index for consumption queries.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const CostLayer = sequelize.define('CostLayer', {
    layer_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'products', key: 'product_id' },
    },
    godown_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'godowns', key: 'godown_id' },
    },
    // Original quantity at acquisition (the layer's "size"). Static after
    // INSERT; the running balance lives in qty_remaining.
    qty_original: {
      type: DataTypes.DECIMAL(12, 3),
      allowNull: false,
    },
    qty_remaining: {
      type: DataTypes.DECIMAL(12, 3),
      allowNull: false,
    },
    // Cost per unit when this layer was acquired. 4dp so tiny rates
    // (sub-paise) don't truncate over multi-unit consumption.
    rate: {
      type: DataTypes.DECIMAL(15, 4),
      allowNull: false,
    },
    // For FIFO ordering. Default NOW(); historic backfill rows get the
    // bill_date of the source purchase so chronological order is honest.
    acquired_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    // Where this layer came from. Useful for diagnostics + future
    // "undo" features. ENUM kept small; new sources only when needed.
    source_type: {
      type: DataTypes.ENUM('Purchase', 'Opening', 'Adjustment', 'Backfill'),
      allowNull: false,
    },
    // FK to the source row (purchase_bill_id, etc.). Polymorphic — kept
    // as INTEGER without an FK since the referenced table varies by
    // source_type.
    source_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  }, {
    tableName: 'cost_layers',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['product_id', 'godown_id', 'acquired_at'] },
    ],
  });
  return CostLayer;
};
