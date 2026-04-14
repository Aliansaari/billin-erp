const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PurchaseBillItem = sequelize.define('PurchaseBillItem', {
  item_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  purchase_bill_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'purchase_bills', key: 'purchase_bill_id' },
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
  quantity: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  quantity_per_box: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
  },
  free_quantity: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  purchase_rate: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  margin_percentage: {
    type: DataTypes.DECIMAL(5, 2),
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
}, {
  tableName: 'purchase_bill_items',
  timestamps: false,
  indexes: [
    { fields: ['barcode'] },
    { fields: ['purchase_bill_id'] },
  ],
});

module.exports = PurchaseBillItem;
