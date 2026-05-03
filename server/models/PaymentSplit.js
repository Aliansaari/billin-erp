const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PaymentSplit = sequelize.define('PaymentSplit', {
  split_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  transaction_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'payments_receipts', key: 'transaction_id' },
  },
  payment_mode: {
    type: DataTypes.ENUM('Cash', 'Card', 'UPI', 'Cheque', 'Bank Transfer', 'Credit'),
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  // FK to the specific bank ledger this split was paid into / out of.
  // NULL = cash (or a pre-migration row that hasn't been backfilled).
  // The voucher builder prefers this when present and only falls back to
  // the legacy 'Bank Account' system ledger when this is NULL on a
  // non-cash row. See server/services/voucherBuilders.js.
  bank_ledger_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'ledger_accounts', key: 'ledger_id' },
  },
  bank_name: {
    type: DataTypes.STRING(100),
  },
  cheque_number: {
    type: DataTypes.STRING(20),
  },
  cheque_date: {
    type: DataTypes.DATEONLY,
  },
  upi_transaction_id: {
    type: DataTypes.STRING(50),
  },
  card_last_4_digits: {
    type: DataTypes.STRING(4),
  },
}, {
  tableName: 'payment_splits',
  timestamps: false,
});

module.exports = PaymentSplit;
