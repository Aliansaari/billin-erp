const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Per-line breakdown of an Expense Voucher: which expense head, how
// much, and the GST split if any. The header sits on `expense_vouchers`;
// the actual debits/credits in `ledger_entries` are SUM-rolled from
// these rows by the controller before calling postVoucher.
//
// Keeping items as a separate table (instead of a single line per
// voucher) lets one expense capture multiple heads in one keystroke —
// e.g. an Amazon bill that's part Office Supplies, part Stationery,
// part GST input, all on one paper bill.
module.exports = (sequelize) => {
  const ExpenseVoucherItem = sequelize.define('ExpenseVoucherItem', {
    item_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    expense_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'expense_vouchers', key: 'expense_id' },
    },
    // Indirect Expense ledger this line books against. Source of the
    // P&L hit. Restricted server-side to ledger_group='Expenses' so the
    // user can't accidentally route a line to an asset / liability.
    expense_ledger_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'ledger_accounts', key: 'ledger_id' },
    },
    // Free-text — "May electricity bill", "Cab from station", etc.
    description: {
      type: DataTypes.STRING(255),
    },
    // Pre-tax line amount. Always >= 0.
    taxable_amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // GST percent on this line — 0 / 5 / 12 / 18 / 28 typically. Stored
    // separately for cgst+sgst (intra-state) and igst (inter-state) so
    // the same expense voucher can mix lines if the operator pasted in
    // a multi-state vendor invoice. The amount columns are derived from
    // the rate × taxable_amount inside the controller.
    cgst_rate: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    sgst_rate: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    igst_rate: {
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
    // Convenience — taxable + cgst + sgst + igst. Persisted so reports
    // don't have to re-sum on every read.
    line_total: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
  }, {
    tableName: 'expense_voucher_items',
    timestamps: false,
    indexes: [
      { fields: ['expense_id'] },
      { fields: ['expense_ledger_id'] },
    ],
  });
  return ExpenseVoucherItem;
};
