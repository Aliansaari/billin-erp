/*
 * SaleLineLayerConsumption — records which cost_layers a sale line
 * consumed and in what quantities (audit H6 v2).
 *
 * Why: when a FIFO sale fires, we draw from possibly multiple layers
 * (the oldest one runs out, then we move to the next). To CANCEL or
 * EDIT that sale exactly — restoring layers to their pre-sale state —
 * we need to know which layers contributed what. v1 used a best-effort
 * "restore the most recent layer" heuristic that drifted under
 * multi-edit. v2 (this table) gives exact reversal.
 *
 * Schema:
 *   - sales_bill_item_id → the line item that did the consuming
 *   - layer_id           → the cost_layers row that was drawn from
 *   - qty_consumed       → how much was taken
 *   - rate_at_consumption → snapshot of layer.rate at that moment
 *                          (kept for audit even if the layer is later
 *                           rate-adjusted, which we don't currently do
 *                           but defensively store).
 *
 * Lifecycle:
 *   sale create        → INSERT one row per layer touched
 *   sale cancel        → for each row: UPDATE cost_layers.qty_remaining += qty_consumed;
 *                        then DELETE the consumption row.
 *   sale edit          → "cancel" the prior consumption (restore), then
 *                        re-consume with new quantities, INSERT new rows.
 *   layer deletion     → CASCADE: if a cost layer is somehow removed,
 *                        the consumption rows die with it (prevents
 *                        orphans). Currently nothing deletes layers,
 *                        but defensive.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SaleLineLayerConsumption = sequelize.define('SaleLineLayerConsumption', {
    consumption_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    sales_bill_item_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'sales_bill_items', key: 'item_id' },
      onDelete: 'CASCADE',
    },
    layer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'cost_layers', key: 'layer_id' },
      onDelete: 'CASCADE',
    },
    qty_consumed: {
      type: DataTypes.DECIMAL(12, 3),
      allowNull: false,
    },
    rate_at_consumption: {
      type: DataTypes.DECIMAL(15, 4),
      allowNull: false,
    },
  }, {
    tableName: 'sale_line_layer_consumptions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,    // append-only; no edits ever
    indexes: [
      { fields: ['sales_bill_item_id'] },
      { fields: ['layer_id'] },
    ],
  });
  return SaleLineLayerConsumption;
};
