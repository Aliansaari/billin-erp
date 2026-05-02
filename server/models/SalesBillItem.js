const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SalesBillItem = sequelize.define('SalesBillItem', {
  item_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  sales_bill_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'sales_bills', key: 'sales_bill_id' },
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
  // Cost-of-goods-sold snapshot: the product's purchase_rate at the moment
  // this line was billed. Frozen on create so historic gross-profit stays
  // stable even if product.purchase_rate is later edited. Defaulting to 0
  // is intentional — pre-migration rows get backfilled at startup from the
  // current purchase_rate (see safe-migrations in server/index.js).
  cost_rate: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
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
  // Batch the line drew from. NULL when the parent product is not
  // batch-tracked; required (validated at the controller) when it is.
  batch_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'product_batches', key: 'batch_id' },
  },
}, {
  tableName: 'sales_bill_items',
  timestamps: false,
  indexes: [
    { fields: ['barcode'] },
    { fields: ['sales_bill_id'] },
  ],
});

module.exports = SalesBillItem;
