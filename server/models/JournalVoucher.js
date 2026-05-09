const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Header for a manual Journal Voucher. The actual Dr/Cr lines live in
// ledger_entries linked via source_type='journal_voucher', source_id=id.
// Posting / reversal goes through ledgerPostingService — this row only
// holds the human-facing metadata (number, date, narration, status).
module.exports = (sequelize) => {
  const JournalVoucher = sequelize.define('JournalVoucher', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    voucher_number: {
      type: DataTypes.STRING(30),
      allowNull: false,
      unique: true,
    },
    voucher_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    narration: {
      type: DataTypes.TEXT,
    },
    total_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    is_reversed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    created_by: {
      type: DataTypes.INTEGER,
      references: { model: 'users', key: 'user_id' },
    },
  }, {
    tableName: 'journal_vouchers',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { fields: ['voucher_date'] },
    ],
  });
  return JournalVoucher;
};
