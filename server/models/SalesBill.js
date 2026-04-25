const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SalesBill = sequelize.define('SalesBill', {
  sales_bill_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  bill_number: {
    type: DataTypes.STRING(30),
    unique: true,
    allowNull: false,
  },
  customer_id: {
    type: DataTypes.INTEGER,
    references: { model: 'parties', key: 'party_id' },
  },
  bill_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  due_date: {
    type: DataTypes.DATEONLY,
  },
  sales_person: {
    type: DataTypes.INTEGER,
    references: { model: 'users', key: 'user_id' },
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
    // 4-decimal precision so amount→pct→amount round-trips exactly (a
    // 2-decimal column truncates 4.7619% to 4.76% and drifts every
    // imported bill by ~₹1). The DB column is ALTERed to DECIMAL(9, 4)
    // in the startup migrations; keep this in sync.
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
  sale_type: {
    type: DataTypes.STRING(20),
    defaultValue: 'Retail',
  },
  salesman_name: {
    type: DataTypes.STRING(100),
  },
  special_discount: {
    type: DataTypes.DECIMAL(15, 2),
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
  return_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  payment_method: {
    type: DataTypes.STRING(30),
    defaultValue: 'Cash',
  },
  remarks: {
    type: DataTypes.TEXT,
  },
  // 'item' (default — itemised invoice with line items) or 'amount' (a
  // single synthetic line for amount-only / on-account / service bills).
  // Amount-mode bills behave identically downstream — same GSTR-1
  // routing, same balance, same payment, same reports — except they
  // don't decrement stock (synthetic line has product_id=null).
  bill_mode: {
    type: DataTypes.STRING(10),
    defaultValue: 'item',
  },
  // Free-text description of the service/charge for amount-mode bills.
  // Becomes the synthetic line's product_name in the items table and is
  // rendered as the line text on the printed invoice. Distinct from
  // `remarks` (which is a footer note).
  description: {
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
  tableName: 'sales_bills',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { unique: true, fields: ['bill_number'] },
    { fields: ['bill_date'] },
    { fields: ['customer_id'] },
  ],
});

module.exports = SalesBill;
