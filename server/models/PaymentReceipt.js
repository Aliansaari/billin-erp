const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = (sequelize) => {
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
    // Audit trail for cancellations — legally required for GST-registered entities
    // that need to justify reversals during a tax audit.
    cancelled_by: {
      type: DataTypes.INTEGER,
      references: { model: 'users', key: 'user_id' },
    },
    cancelled_on: {
      type: DataTypes.DATE,
    },
    cancellation_reason: {
      type: DataTypes.TEXT,
    },
    bill_allocations: {
      type: DataTypes.JSONB,
      defaultValue: null,
    },
    // Two-way ledger (R8): distinguishes operator-entered receipts/
    // payments from rows auto-generated when a bill is saved with
    // paid_amount > 0. Auto rows are read-only in the Receipts/Payments
    // UI — the source bill is the editable surface.
    source: {
      type: DataTypes.ENUM('manual', 'auto_from_bill'),
      defaultValue: 'manual',
    },
    source_bill_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Denormalised mode shown as a coloured chip in the Receipts/Payments
    // list. Sourced from the bill's payment_method on auto-receipts and
    // from the first PaymentSplit on manual single-split entries.
    // Multi-split manual rows leave this NULL and the UI renders 'Mixed'.
    payment_method: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    // Bank reconciliation (Tier 2). NULL = uncleared / in transit;
    // a timestamp = the operator marked this row as cleared on the
    // Bank Statement view. cleared_by tracks who, for the audit trail.
    cleared_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    cleared_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'user_id' },
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
  return PaymentReceipt;
};
