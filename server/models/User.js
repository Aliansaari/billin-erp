const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  user_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  username: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
  },
  password_hash: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  full_name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING(100),
  },
  mobile_number: {
    type: DataTypes.STRING(15),
  },
  role_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'roles', key: 'role_id' },
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  // Per-user permission override. NULL means "inherit from role" — the
  // default for freshly-created users. When populated (via the user-management
  // form's "customize" tick-grid), this object follows the same shape as
  // Role.permissions_json and takes precedence over the role at
  // authorisation time. Clearing a customisation is done by setting this
  // back to NULL, not an empty object — an empty object is a valid
  // "no permissions" override and used to lock a user out of everything.
  custom_permissions: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null,
  },
  // Per-user godown access list. Three states:
  //   NULL   → unrestricted (this user can see and write to every godown).
  //            Default for freshly-created users; matches today's behaviour.
  //   []     → no godown access. Empty array, NOT NULL — used to lock a
  //            user out without changing their role. (Distinct from NULL.)
  //   [1, 3] → explicit allowlist of godown_ids.
  // Super Admin and Admin role-name short-circuit to "all" regardless of
  // this field — see effectiveGodownIds() in server/middleware/godownScope.js.
  // The bill-form godown dropdown filters to this list; controllers refuse
  // create/edit when the requested godown_id is outside the allowlist.
  allowed_godowns: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null,
  },
  last_login: {
    type: DataTypes.DATE,
  },
  created_by: {
    type: DataTypes.INTEGER,
  },
}, {
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
});

module.exports = User;
