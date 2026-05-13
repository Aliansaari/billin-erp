const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * StockTransferItem — one line per product in a stock transfer.
 *
 * `rate` is for valuation only (so the Godown-wise Stock Valuation report
 * can show the moved-in stock at the rate it was transferred at, instead of
 * defaulting to the global products.purchase_rate). A transfer doesn't
 * change a product's catalog rate; it just records what value crossed
 * between godowns at this point in time.
 *
 * `barcode` is denormalized at write-time to pin to the SKU's barcode at
 * the moment of the transfer — the same convention SalesBillItem and
 * PurchaseBillItem follow, so the four item tables present a uniform
 * shape to reports.
 *
 * No GST on transfers (same legal entity moving its own goods), so no
 * tax columns are present. If/when branches across states are introduced
 * with separate GSTINs, transfers between them will need to become real
 * outward/inward supplies with full GST treatment — that's a follow-up
 * design, not this commit.
 */
module.exports = (sequelize) => {
  const StockTransferItem = sequelize.define('StockTransferItem', {
    item_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    transfer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'stock_transfers', key: 'transfer_id' },
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'products', key: 'product_id' },
    },
    barcode: {
      type: DataTypes.STRING(20),
    },
    quantity: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    rate: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    amount: {
      // quantity * rate, denormalized for the list view. Set on create.
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    remarks: {
      type: DataTypes.TEXT,
    },
    // Batch identity preserved across the transfer — the same batch_id
    // moves from the from_godown to the to_godown. NULL for non-batch-
    // tracked products.
    batch_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'product_batches', key: 'batch_id' },
    },
    // Audit H6 L2 — FIFO cost-layer continuity across godowns.
    // When stock leaves the source godown we consume FIFO and snapshot
    // the consumed (qty, rate) pairs here. On RECEIVE at destination
    // we create matching layers at destination so the cost trail
    // survives the transfer instead of falling back to weighted-avg.
    // Empty / null when cogs_method != 'fifo' or when the transfer
    // pre-dated this feature. Schema:
    //   [{ "qty": "5.000", "rate": "100.0000" }, ...]
    cost_layers_consumed: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  }, {
    tableName: 'stock_transfer_items',
    timestamps: false,
    indexes: [
      { fields: ['transfer_id'] },
      { fields: ['product_id'] },
    ],
  });
  return StockTransferItem;
};
