const { DataTypes } = require('sequelize');

/*
 * UserPreference — the operator's own UI settings, tied to their login.
 *
 * One row per (user, pref_key). The value is opaque JSON owned by the
 * frontend: the server stores and returns it, it never interprets it.
 * That keeps the client free to add a toggle without a matching server
 * release, which is the whole point — these are cosmetic choices
 * (appearance, which KPI cards show, which bill-grid columns are on),
 * not business data.
 *
 * Why the server at all, when localStorage already worked:
 *   - a shared counter PC used to hand the next person whatever the
 *     previous person had configured: their theme, their dashboard,
 *     their column layout. Preferences belong to a login, not a machine.
 *   - a user who moves to the back-office PC, a LAN client or a
 *     reinstalled app used to start from scratch every time.
 *
 * Keys currently written by the client (see src/store/userPreferences.js
 * for the registry): 'theme', 'home', 'dashboard', 'dashboardSections',
 * plus small scalar keys like 'gst_mode' and the '*_visible_cols' sets.
 * The server accepts any key matching /^[A-Za-z0-9_.:-]{1,64}$/ so that
 * list can grow client-side.
 *
 * Lives in the COMPANY database (like users), so user_id is unambiguous
 * and a CASCADE delete cleans up with the user.
 */
module.exports = (sequelize) => {
  const UserPreference = sequelize.define('UserPreference', {
    pref_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'user_id' },
      onDelete: 'CASCADE',
    },
    pref_key: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    // Whole value, replaced on every write. Deliberately not merged
    // server-side: the client holds the schema and knows which keys it
    // removed, so a blind deep-merge here would resurrect settings the
    // operator just turned off.
    value: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'user_preferences',
    timestamps: false,   // updated_at is maintained explicitly on upsert
    indexes: [
      { unique: true, fields: ['user_id', 'pref_key'] },
      { fields: ['user_id'] },
    ],
  });
  return UserPreference;
};
