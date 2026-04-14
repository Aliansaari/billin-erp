const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Party = sequelize.define('Party', {
  party_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  party_type: {
    type: DataTypes.ENUM('Customer', 'Supplier', 'Both'),
    allowNull: false,
  },
  party_name: {
    type: DataTypes.STRING(200),
    allowNull: false,
  },
  display_name: {
    type: DataTypes.STRING(200),
  },
  mobile_1: {
    type: DataTypes.STRING(15),
    allowNull: false,
  },
  mobile_2: {
    type: DataTypes.STRING(15),
  },
  email: {
    type: DataTypes.STRING(100),
  },
  address_line_1: {
    type: DataTypes.STRING(255),
  },
  address_line_2: {
    type: DataTypes.STRING(255),
  },
  city: {
    type: DataTypes.STRING(100),
  },
  state: {
    type: DataTypes.STRING(100),
  },
  pincode: {
    type: DataTypes.STRING(10),
  },
  country: {
    type: DataTypes.STRING(100),
    defaultValue: 'India',
  },
  gstin: {
    type: DataTypes.STRING(15),
  },
  pan_number: {
    type: DataTypes.STRING(10),
  },
  aadhar_number: {
    type: DataTypes.STRING(12),
  },
  credit_allowed: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  credit_limit: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  credit_days: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  opening_balance: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  opening_balance_type: {
    type: DataTypes.ENUM('Receivable', 'Payable'),
    defaultValue: 'Receivable',
  },
  current_balance: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  interest_rate: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
  },
  party_status: {
    type: DataTypes.ENUM('Regular', 'Priority', 'VIP', 'Blacklist'),
    defaultValue: 'Regular',
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  created_by: {
    type: DataTypes.INTEGER,
  },
}, {
  tableName: 'parties',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { fields: ['party_name'] },
    { fields: ['mobile_1'] },
    { fields: ['party_type'] },
  ],
});

module.exports = Party;
