const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Role = sequelize.define('Role', {
  role_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  role_name: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
  },
  permissions_json: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
  can_view_reports: { type: DataTypes.BOOLEAN, defaultValue: false },
  can_delete_bills: { type: DataTypes.BOOLEAN, defaultValue: false },
  can_edit_rates: { type: DataTypes.BOOLEAN, defaultValue: false },
  can_access_accounts: { type: DataTypes.BOOLEAN, defaultValue: false },
  can_manage_users: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  tableName: 'roles',
  timestamps: false,
});

module.exports = Role;
