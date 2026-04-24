const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PurchaseBill = sequelize.define('PurchaseBill', {
  purchase_bill_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  bill_number: {
    type: DataTypes.STRING(30),
    unique: true,
    allowNull: false,
  },
  supplier_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'parties', key: 'party_id' },
  },
  supplier_bill_number: {
    type: DataTypes.STRING(50),
  },
  bill_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  due_date: {
    type: DataTypes.DATEONLY,
  },
  transport_name: {
    type: DataTypes.STRING(100),
  },
  vehicle_number: {
    type: DataTypes.STRING(20),
  },
  lr_number: {
    type: DataTypes.STRING(50),
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
    // See SalesBill for the DECIMAL(9, 4) rationale.
    type: DataTypes.DECIMAL(9, 4),
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
  paid_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  balance_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  payment_status: {
    type: DataTypes.ENUM('Paid', 'Partial', 'Unpaid'),
    defaultValue: 'Unpaid',
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
  tableName: 'purchase_bills',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { unique: true, fields: ['bill_number'] },
    { fields: ['bill_date'] },
    { fields: ['supplier_id'] },
  ],
});

module.exports = PurchaseBill;
