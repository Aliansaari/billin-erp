const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BarcodeSettings = sequelize.define('BarcodeSettings', {
  setting_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  prefix: {
    type: DataTypes.STRING(10),
    defaultValue: 'PROD',
  },
  starting_number: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
  },
  current_number: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  total_digits: {
    type: DataTypes.INTEGER,
    defaultValue: 10,
  },
  format_pattern: {
    type: DataTypes.STRING(30),
    defaultValue: 'PREFIX-NNNNNN',
  },
}, {
  tableName: 'barcode_settings',
  timestamps: false,
});

module.exports = BarcodeSettings;
