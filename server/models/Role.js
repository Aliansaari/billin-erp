const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
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
    // When FALSE, members of this role cannot enter bills / payments /
    // vouchers with a date before today. Enforced server-side in the
    // create + update controllers via utils/backdatedGuard.js. The
    // system-wide SystemSettings.allow_backdated_entries flag must
    // ALSO be TRUE for back-dating to work — this role-level switch
    // only narrows the company-wide policy, never widens it.
    can_enter_backdated: { type: DataTypes.BOOLEAN, defaultValue: true },
  }, {
    tableName: 'roles',
    timestamps: false,
  });
  return Role;
};
