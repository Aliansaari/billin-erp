const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

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
  ],
});

module.exports = StockLedger;
