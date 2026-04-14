const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PaymentReceipt = sequelize.define('PaymentReceipt', {
  transaction_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  transaction_number: {
    type: DataTypes.STRING(30),
    unique: true,
    allowNull: false,
  },
  transaction_type: {
    type: DataTypes.ENUM('Payment', 'Receipt'),
    allowNull: false,
  },
  transaction_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  party_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'parties', key: 'party_id' },
  },
  reference_bill_id: {
    type: DataTypes.INTEGER,
  },
  reference_bill_type: {
    type: DataTypes.ENUM('Sales', 'Purchase'),
  },
  reference_bill_number: {
    type: DataTypes.STRING(30),
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  remarks: {
    type: DataTypes.TEXT,
  },
  created_by: {
    type: DataTypes.INTEGER,
    references: { model: 'users', key: 'user_id' },
  },
  is_cancelled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  tableName: 'payments_receipts',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { fields: ['transaction_date'] },
    { fields: ['party_id'] },
    { fields: ['transaction_type'] },
  ],
});

module.exports = PaymentReceipt;
