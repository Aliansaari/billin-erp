const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = (sequelize) => {
  const PurchaseReturnBillItem = sequelize.define('PurchaseReturnBillItem', {
    item_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    purchase_return_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'purchase_return_bills', key: 'purchase_return_id' },
    },
    original_item_id: {
      type: DataTypes.INTEGER,
      references: { model: 'purchase_bill_items', key: 'item_id' },
      onDelete: 'SET NULL',
    },
    product_id: {
      type: DataTypes.INTEGER,
      references: { model: 'products', key: 'product_id' },
    },
    barcode: {
      type: DataTypes.STRING(20),
    },
    category_name: {
      type: DataTypes.STRING(100),
    },
    product_name: {
      type: DataTypes.STRING(200),
    },
    size: {
      type: DataTypes.STRING(20),
    },
    article_number: {
      type: DataTypes.STRING(50),
    },
    hsn_code: {
      type: DataTypes.STRING(20),
    },
    unit_type: {
      type: DataTypes.STRING(10),
      defaultValue: 'Pcs',
    },
    category_id: {
      type: DataTypes.INTEGER,
      references: { model: 'categories', key: 'category_id' },
    },
    quantity: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    rate: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
    },
    mrp: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    discount_percentage: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    discount_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    taxable_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    gst_rate: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    cgst_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    sgst_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    igst_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    cess_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    total_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    quantity_per_box: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 1,
    },
    return_condition: {
      type: DataTypes.STRING(80),
    },
    // Batch being returned to supplier. NULL when the parent product is not
    // batch-tracked; required when it is.
    batch_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'product_batches', key: 'batch_id' },
    },
    // Audit STOCK-2 (deep) — per-layer breakdown of qty consumed FROM
    // cost_layers when this purchase-return was created (FIFO mode).
    // Shape: [{ layer_id, qty, rate }, ...]. Read back on cancel to
    // restore qty to those exact layers (preserving original cost
    // basis on future sales). NULL for weighted-avg installs.
    cost_layers_consumed: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  }, {
    tableName: 'purchase_return_bill_items',
    timestamps: false,
    indexes: [
      { fields: ['barcode'] },
      { fields: ['purchase_return_id'] },
      { fields: ['product_id'] },
    ],
  });
  return PurchaseReturnBillItem;
};
