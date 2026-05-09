const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// ── ProductColor ─────────────────────────────────────────────────
//
// One row per (product, color) pair. The product's barcode resolves
// to the parent SKU; the color is picked at sale time (dropdown) and
// allocated at purchase time (color-box popover). Per-color stock
// lives here so we can answer "how many Red Lyra-S do we have left."
//
// Lifecycle rules (enforced by the controller):
//   • Hard-delete only when current_stock = 0 AND no historical bill
//     items reference this color_id.
//   • Soft-delete (is_active=false) when there's history but stock=0.
//   • Block delete when current_stock > 0.
//
// The product master's parent `current_stock` is a denormalised mirror
// of SUM(product_colors.current_stock) for color_mode='multi' products.
// Maintained by the bill controllers — same pattern as
// products.current_stock = SUM(product_godown_stock.current_stock).
module.exports = (sequelize) => {
  const ProductColor = sequelize.define('ProductColor', {
    color_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'products', key: 'product_id' },
    },
    color_name: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    current_stock: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    opening_stock: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    // Per-color low-stock threshold. NULL = inherit the parent product's
    // minimum_stock_level / reorder_level. Allows pharma/fashion to alert
    // on a specific scarce color while leaving the others quiet.
    low_stock_alert: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    // Soft-delete flag. Once a color has billing history, deleting it
    // would orphan the FK on bill items, so we flip is_active=false
    // instead. Hidden from new pickers but remains in historical reports.
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  }, {
    tableName: 'product_colors',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { fields: ['product_id'] },
      // (product_id, color_name) is unique per product — prevents
      // accidental duplicates ("Red" added twice to Lyra-S). Enforced at
      // DB level via the migration block.
      { unique: true, fields: ['product_id', 'color_name'] },
    ],
  });
  return ProductColor;
};
