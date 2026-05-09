const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Expense voucher header. The Dr/Cr legs live in `ledger_entries` linked
// via source_type='expense_voucher'. Posting/reversal goes through
// ledgerPostingService — same atomicity, idempotency, and reversal rules
// as JV / Sales / Purchase. Item-level breakdown (one row per expense
// head + GST split) lives in `expense_voucher_items` joined by
// expense_id, but those are descriptive only — every leg in the books
// is on ledger_entries.
//
// Posting model:
//   Dr  Expense Ledger (one leg per item)        sum(taxable_amount)
//   Dr  CGST Input    (if any cgst on items)
//   Dr  SGST Input    (if any sgst on items)
//   Dr  IGST Input    (if any igst on items)
//   Dr  Round Off     (if round_off < 0; expense side)
//   Cr  Cash / Bank   (paid_amount > 0)
//   Cr  Vendor Party  (total_amount - paid_amount)   ← if on credit
//   Cr  Round Off     (if round_off > 0)
//
// Either / both of cash-bank / vendor-party legs may appear; the sum
// of (paid + payable) always equals total_amount.
//
// payment_mode is 'Cash' | 'Bank' | 'Credit'. 'Credit' means the
// expense is owed to the vendor (party_id required). 'Bank' uses the
// per-bank `bank_ledger_id`. 'Cash' posts against the system 'Cash'
// ledger.
module.exports = (sequelize) => {
  const ExpenseVoucher = sequelize.define('ExpenseVoucher', {
    expense_id: {
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
    // 'Cash' (Cr Cash), 'Bank' (Cr bank ledger via bank_ledger_id),
    // 'Credit' (Cr vendor party ledger via party_id). Mixed mode is not
    // supported here — record the same expense as two vouchers if the
    // operator literally split the payment two ways.
    payment_mode: {
      type: DataTypes.ENUM('Cash', 'Bank', 'Credit'),
      allowNull: false,
      defaultValue: 'Cash',
    },
    // Bank ledger when payment_mode='Bank'. NULL otherwise.
    bank_ledger_id: {
      type: DataTypes.INTEGER,
    },
    // Vendor party (electricity board, landlord, courier, etc.). Required
    // when payment_mode='Credit'; optional metadata otherwise (so an
    // operator can tag a cash expense with "paid to Reliance Energy" for
    // reporting without creating a credit balance).
    party_id: {
      type: DataTypes.INTEGER,
    },
    // Vendor's reference for the bill / receipt the operator is recording
    // against. Free text.
    reference_number: {
      type: DataTypes.STRING(60),
    },
    // Cheque number / UTR / card last-4 — when payment_mode='Bank'.
    payment_ref: {
      type: DataTypes.STRING(60),
    },
    // Notes / narration carried onto every Dr/Cr leg.
    narration: {
      type: DataTypes.TEXT,
    },
    // Money fields — always 2dp DECIMAL.
    sub_total: {
      type: DataTypes.DECIMAL(15, 2),
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
    round_off: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    total_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    // For credit vouchers, this is the part already paid at entry time
    // (e.g. ₹500 paid in cash + ₹500 owed). 0 when payment_mode='Credit'
    // and the expense is fully on credit; equals total_amount when
    // payment_mode is Cash/Bank.
    paid_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    // Soft delete marker. Cancelled vouchers stay in the table for audit
    // and the reversal mirror lives in ledger_entries; the list UI hides
    // them by default.
    is_cancelled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    cancelled_at: {
      type: DataTypes.DATE,
    },
    cancelled_by: {
      type: DataTypes.INTEGER,
    },
    cancel_reason: {
      type: DataTypes.STRING(255),
    },
    created_by: {
      type: DataTypes.INTEGER,
      references: { model: 'users', key: 'user_id' },
    },
  }, {
    tableName: 'expense_vouchers',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { fields: ['voucher_date'] },
      { fields: ['party_id'] },
      { fields: ['is_cancelled'] },
    ],
  });
  return ExpenseVoucher;
};
