const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = (sequelize) => {
  const StockLedger = sequelize.define('StockLedger', {
    ledger_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'products', key: 'product_id' },
    },
    // Godown the movement happened at. Nullable in the model to keep the
    // sync alive on a populated table (NOT NULL is enforced by the migration
    // block in server/index.js after a backfill flips legacy rows to the
    // Main godown). Every stock_ledger row written by application code is
    // expected to carry godown_id — see server/utils/godownStock.js
    // applyGodownStockDelta which is the central writer.
    godown_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'godowns', key: 'godown_id' },
    },
    // Batch dimension. NULL for non-batch-tracked products (the common case);
    // required at the application layer for batch-tracked products (no DB
    // CHECK because the constraint is per-product, not table-wide). Indexed
    // jointly with product_id for batch-stock rebuild queries.
    batch_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'product_batches', key: 'batch_id' },
    },
    barcode: {
      type: DataTypes.STRING(20),
    },
    transaction_type: {
      type: DataTypes.ENUM('Purchase', 'Sales', 'Purchase Return', 'Sales Return', 'Stock Adjustment', 'Stock Transfer', 'Opening Stock'),
      allowNull: false,
    },
    transaction_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    reference_id: {
      type: DataTypes.INTEGER,
    },
    reference_number: {
      type: DataTypes.STRING(30),
    },
    quantity_in: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    quantity_out: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    rate: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    balance_quantity: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    remarks: {
      type: DataTypes.TEXT,
    },
    created_by: {
      type: DataTypes.INTEGER,
      references: { model: 'users', key: 'user_id' },
    },
  }, {
    tableName: 'stock_ledger',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: false,
    indexes: [
      { fields: ['product_id'] },
      { fields: ['barcode'] },
      { fields: ['transaction_date'] },
      // Composite (product_id, batch_id, transaction_date) index is created by
      // the batch-tracking migration block in server/index.js (CREATE INDEX IF
      // NOT EXISTS) — declaring it here would have Sequelize sync attempt the
      // index before the migration adds the batch_id column on existing DBs.
    ],
  });
  return StockLedger;
};
