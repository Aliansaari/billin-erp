const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
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
    // separator joins prefix and number ('-', '_', '/', '.', or '' for none).
    // Empty prefix always produces no separator regardless of this value.
    separator: {
      type: DataTypes.STRING(2),
      defaultValue: '-',
    },
    // ── Durable label design ──
    // The Label Designer layout (sizes, code type, element positions) used to
    // live ONLY in the renderer's localStorage, which Chromium can drop across
    // an Electron upgrade — so the design kept "resetting". Persisting it here
    // makes it survive reinstalls/updates exactly like the rest of the company
    // data (embedded Postgres under ~/.zehen). JSON blob; the renderer
    // mirrors it to localStorage as a fast cache.
    label_layout: {
      type: DataTypes.TEXT,
    },
    // Company name printed on labels (was a separate localStorage key that also
    // reset to "My Company"). Blank → fall back to the company profile name.
    label_company_name: {
      type: DataTypes.STRING(120),
    },
  }, {
    tableName: 'barcode_settings',
    timestamps: false,
  });
  return BarcodeSettings;
};
