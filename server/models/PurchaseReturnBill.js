const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = (sequelize) => {
  const PurchaseReturnBill = sequelize.define('PurchaseReturnBill', {
    purchase_return_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    return_number: {
      type: DataTypes.STRING(30),
      unique: true,
      allowNull: false,
    },
    // Godown the returned items leave from. Defaults to the referenced
    // purchase bill's godown.
    godown_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'godowns', key: 'godown_id' },
    },
    supplier_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'parties', key: 'party_id' },
    },
    return_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    reference_bill_id: {
      type: DataTypes.INTEGER,
      references: { model: 'purchase_bills', key: 'purchase_bill_id' },
    },
    reference_bill_number: {
      type: DataTypes.STRING(30),
    },
    return_mode: {
      type: DataTypes.ENUM('Items', 'Amount'),
      allowNull: false,
      defaultValue: 'Items',
    },
    reason: {
      type: DataTypes.TEXT,
    },
    total_items: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    total_quantity: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    sub_total: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    discount_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    discount_percentage: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    cgst_pct: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    sgst_pct: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    igst_pct: {
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
    cess_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    round_off: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    other_charges: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    freight_charges: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    total_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    // refund_amount: cash received from supplier at the time of return.
    // balance_amount: outstanding credit the supplier still owes us.
    refund_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    balance_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    refund_status: {
      type: DataTypes.ENUM('Refunded', 'Partial', 'Pending'),
      defaultValue: 'Pending',
    },
    refund_method: {
      type: DataTypes.STRING(30),
      defaultValue: 'Cash',
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
    cancelled_by: {
      type: DataTypes.INTEGER,
      references: { model: 'users', key: 'user_id' },
    },
    cancelled_date: {
      type: DataTypes.DATE,
    },
    cancellation_reason: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'purchase_return_bills',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { unique: true, fields: ['return_number'] },
      { fields: ['return_date'] },
      { fields: ['supplier_id'] },
      { fields: ['reference_bill_id'] },
    ],
  });
  return PurchaseReturnBill;
};
