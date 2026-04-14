const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const LedgerAccount = sequelize.define('LedgerAccount', {
  ledger_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  ledger_name: {
    type: DataTypes.STRING(100),
    unique: true,
    allowNull: false,
  },
  ledger_group: {
    type: DataTypes.ENUM('Assets', 'Liabilities', 'Income', 'Expenses', 'Capital'),
    allowNull: false,
  },
  sub_group: {
    type: DataTypes.STRING(100),
  },
  opening_balance: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  opening_balance_type: {
    type: DataTypes.ENUM('Debit', 'Credit'),
    defaultValue: 'Debit',
  },
  current_balance: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  is_system_ledger: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'ledger_accounts',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: false,
});

module.exports = LedgerAccount;
