// ── LoanAccount ───────────────────────────────────────────────────
//
// Sidecar to ledger_accounts that holds loan-specific metadata
// (principal, interest, tenure, EMI dates). 1:1 with the underlying
// ledger via ledger_id; deleting the loan ledger CASCADEs here.
//
// The actual money — outstanding balance, interest paid, principal
// paid — lives in ledger_entries against the linked ledger, NOT here.
// loan_accounts only stores the fixed terms agreed at loan time.

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = (sequelize) => {
  const LoanAccount = sequelize.define('LoanAccount', {
    loan_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    ledger_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      references: { model: 'ledger_accounts', key: 'ledger_id' },
    },
    loan_type: {
      type: DataTypes.ENUM('taken', 'given'),
      allowNull: false,
    },
    // Lender (for loans taken) or Borrower (for loans given). Optional —
    // not every loan has a party in our parties table (e.g. a bank
    // hasn't been added as a supplier).
    party_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'parties', key: 'party_id' },
    },
    // Original loan amount. The current outstanding is computed from
    // ledger entries — don't read this column to display "remaining".
    principal: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // Annual %, e.g. 9.25 for 9.25%. Used to compute monthly EMI and the
    // amortization schedule. We store the rate as agreed at loan time;
    // floating-rate loans aren't modelled here.
    interest_rate: {
      type: DataTypes.DECIMAL(6, 3),
      allowNull: false,
      defaultValue: 0,
    },
    tenure_months: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    disbursement_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    first_emi_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    // Manual override. NULL = compute from principal/rate/tenure using
    // the standard EMI formula. Operators set this if the bank quoted a
    // round number that doesn't match formula output to the paisa.
    emi_amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: true,
    },
    emi_day: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: { min: 1, max: 31 },
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  }, {
    tableName: 'loan_accounts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return LoanAccount;
};
