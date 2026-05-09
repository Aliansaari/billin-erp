const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * ProductGodownStock — per-godown current_stock for each product.
 *
 * Why a separate table (vs. extending products):
 *   `products.current_stock` was a single denormalized number representing
 *   "the stock of this product, anywhere". With multiple godowns the same
 *   product can sit in two warehouses with different counts, so the column
 *   has to break out by godown. A composite-PK join table is the cleanest
 *   model — every (product_id, godown_id) pair has at most one row, and
 *   missing rows are implicitly zero.
 *
 *   We deliberately KEEP `products.current_stock` for now (see comment in
 *   server/utils/godownStock.js applyGodownStockDelta) as a denormalized
 *   mirror = SUM across godowns. There are ~104 references to it across
 *   reports, the importer, the product list, the bill form's product
 *   dropdown, and dropping it in the same commit that introduces godowns
 *   would force 104 simultaneous edits with no incremental verifiability.
 *   A follow-up commit can remove it once all callers move to per-godown.
 *
 * Why opening_stock per (product, godown):
 *   The Stock Summary report computes opening balance for a period from
 *   stock_ledger sums; before a product's first ledger row in the period it
 *   falls back to opening_stock. Splitting opening_stock per-godown lets a
 *   product be "opened" with 100 units in Main and 50 in Branch-1
 *   independently — the previous single number couldn't express that.
 *
 *   Backfill: the migration block populates every existing product with one
 *   row at the Main godown carrying `opening_stock = products.opening_stock`
 *   and `current_stock = products.current_stock`. New godowns start every
 *   product at zero and let the operator do an explicit Stock Adjustment
 *   or Stock Transfer to seed quantities.
 *
 * Concurrency:
 *   `applyGodownStockDelta` selects the row FOR UPDATE inside the bill
 *   transaction — concurrent sales of the same product at the same godown
 *   serialise correctly. Without the row lock, two concurrent bills could
 *   read the same `current_stock`, both decrement, and lose one bill's
 *   write.
 */
module.exports = (sequelize) => {
  const ProductGodownStock = sequelize.define('ProductGodownStock', {
    product_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: 'products', key: 'product_id' },
    },
    godown_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: { model: 'godowns', key: 'godown_id' },
    },
    current_stock: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
      allowNull: false,
    },
    opening_stock: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
      allowNull: false,
    },
  }, {
    tableName: 'product_godown_stock',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { fields: ['godown_id'] },
      { fields: ['product_id'] },
    ],
  });
  return ProductGodownStock;
};
