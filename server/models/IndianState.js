/*
 * IndianState — reference table for the 36 Indian states and union
 * territories. Backs the State dropdown on Company Profile + the
 * onboarding wizard.
 *
 * Why a table instead of a hardcoded const:
 *   - List of states is unlikely to change often (last reshuffle was
 *     Ladakh in 2019), but when it does, dropping it into a table means
 *     a customer can fix it themselves with a SQL UPDATE — no app rebuild.
 *   - GST state code (the leading 2 digits of GSTIN) is canonical
 *     state metadata; storing it next to the name lets future GSTR
 *     summaries map "27" → "Maharashtra" without bringing along yet
 *     another lookup file.
 *   - The frontend can fall back to its built-in INDIAN_STATES const
 *     when the API call fails (offline / brand-new server), so the
 *     dropdown never goes blank — the table is an upgrade, not a
 *     requirement.
 *
 * gst_code is the 2-digit prefix that appears in GSTIN. Stored as a
 * string (not a number) so leading zeros stay intact ('01' for J&K).
 */
module.exports = (sequelize) => {
  const { DataTypes } = require('sequelize');
  return sequelize.define('IndianState', {
    state_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    state_name: {
      type: DataTypes.STRING(80),
      allowNull: false,
      unique: true,
    },
    gst_code: {
      type: DataTypes.STRING(2),
      allowNull: true,
    },
    is_union_territory: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 100,
    },
  }, {
    tableName: 'indian_states',
    timestamps: false, // reference table — no created/updated tracking needed
  });
};
