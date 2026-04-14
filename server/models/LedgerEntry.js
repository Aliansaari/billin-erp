const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const LedgerEntry = sequelize.define('LedgerEntry', {
  entry_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  entry_number: {
    type: DataTypes.STRING(30),
    unique: true,
    allowNull: false,
  },
  entry_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  ledger_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'ledger_accounts', key: 'ledger_id' },
  },
  debit_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  credit_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  narration: {
    type: DataTypes.TEXT,
  },
  voucher_type: {
    type: DataTypes.ENUM('Sales', 'Purchase', 'Payment', 'Receipt', 'Journal', 'Contra'),
    allowNull: false,
  },
  reference_id: {
    type: DataTypes.INTEGER,
  },
  reference_number: {
    type: DataTypes.STRING(30),
  },
  created_by: {
    type: DataTypes.INTEGER,
    references: { model: 'users', key: 'user_id' },
  },
}, {
  tableName: 'ledger_entries',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: false,
  indexes: [
    { fields: ['entry_date'] },
    { fields: ['ledger_id'] },
  ],
});

module.exports = LedgerEntry;
