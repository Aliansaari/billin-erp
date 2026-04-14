const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Product = sequelize.define('Product', {
  product_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  barcode: {
    type: DataTypes.STRING(20),
    unique: true,
    allowNull: false,
  },
  category_id: {
    type: DataTypes.INTEGER,
    references: { model: 'categories', key: 'category_id' },
  },
  product_name: {
    type: DataTypes.STRING(200),
    allowNull: false,
  },
  product_description: {
    type: DataTypes.TEXT,
  },
  size_value: {
    type: DataTypes.STRING(100),
  },
  size_unit: {
    type: DataTypes.ENUM('S', 'M', 'L', 'XL', 'XXL', 'Numeric', 'Custom'),
  },
  article_number: {
    type: DataTypes.STRING(200),
  },
  hsn_code: {
    type: DataTypes.STRING(50),
  },
  gst_rate: {
    type: DataTypes.DECIMAL(8, 2),
    defaultValue: 0,
  },
  cess_rate: {
    type: DataTypes.DECIMAL(8, 2),
    defaultValue: 0,
  },
  unit_of_measurement: {
    type: DataTypes.ENUM('PCS', 'KG', 'METER', 'LITER', 'BOX', 'DOZEN'),
    defaultValue: 'PCS',
  },
  quantity_per_box: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
  },
  minimum_stock_level: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  maximum_stock_level: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  reorder_level: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  opening_stock: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  opening_stock_rate: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  opening_stock_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  current_stock: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  purchase_rate: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  margin_percentage: {
    type: DataTypes.DECIMAL(8, 2),
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
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'products',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { unique: true, fields: ['barcode'] },
    { fields: ['product_name'] },
    { fields: ['article_number'] },
    { fields: ['category_id'] },
  ],
});

module.exports = Product;
