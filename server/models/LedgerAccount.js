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
  // True when this ledger row was auto-created for a Party (customer/supplier).
  // Lets the chart-of-accounts UI separate party ledgers from the seeded
  // 19 system ledgers, and lets backfill scripts skip them safely.
  is_party_ledger: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // Back-link to the party this ledger belongs to. NULL for system ledgers.
  // FK at DB level via the migration block (kept off the model to avoid
  // cyclic-FK issues with Party.ledger_account_id during sync).
  party_id: {
    type: DataTypes.INTEGER,
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
