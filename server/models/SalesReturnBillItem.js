const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SalesReturnBillItem = sequelize.define('SalesReturnBillItem', {
  item_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  sales_return_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'sales_return_bills', key: 'sales_return_id' },
  },
  // Optional link back to the original sales_bill_item — lets us report
  // "returned X of Y sold" per line if the user picked a reference bill.
  original_item_id: {
    type: DataTypes.INTEGER,
    references: { model: 'sales_bill_items', key: 'item_id' },
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
}, {
  tableName: 'sales_return_bill_items',
  timestamps: false,
  indexes: [
    { fields: ['barcode'] },
    { fields: ['sales_return_id'] },
    { fields: ['product_id'] },
  ],
});

module.exports = SalesReturnBillItem;
