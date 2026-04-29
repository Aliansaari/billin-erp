const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * StockTransfer — godown-to-godown movement.
 *
 * Stock transfers move inventory between two godowns owned by the same
 * company. They have no financial impact: no ledger_entries posting, no
 * party balance, no GST. Only stock_ledger rows (one Out + one In per
 * item) and updates to product_godown_stock.current_stock at both godowns.
 * Trial Balance and P&L are unchanged after a transfer; only Balance Sheet
 * stock-in-hand is unchanged in TOTAL (per-godown valuation reports
 * obviously change).
 *
 * Status lifecycle:
 *   Draft       — created, not committed, no stock movement yet (operator
 *                 can edit lines or cancel without book impact).
 *   In-Transit  — stock has been deducted from the source godown but not
 *                 yet added to the destination. Models physical reality —
 *                 goods on a truck between branches. The Out-leg
 *                 stock_ledger rows exist; In-legs do not. Cancel from
 *                 here reverses the Out-legs.
 *   Received    — destination has confirmed receipt. In-leg stock_ledger
 *                 rows are written; product_godown_stock at the destination
 *                 increments. Terminal state — cannot be cancelled (issue a
 *                 reverse transfer if a mistake was made).
 *   Cancelled   — terminal. All stock movements that had happened are
 *                 reversed via destroyed stock_ledger rows; nothing remains
 *                 to clean up.
 *
 * Numbering:
 *   transfer_number follows the same pattern as bill_number (ST-YYYY-NNNN by
 *   default). The prefix is stored in SystemSettings.stock_transfer_prefix
 *   so multi-tenant deploys can rebrand to e.g. "TRF-".
 *
 * Constraints:
 *   from_godown_id <> to_godown_id is enforced by a CHECK constraint added
 *   in the migration block. The frontend ALSO disables submit when both are
 *   the same, but the DB-level guard is the authoritative one.
 */
const StockTransfer = sequelize.define('StockTransfer', {
  transfer_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  transfer_number: {
    type: DataTypes.STRING(30),
    allowNull: false,
    unique: true,
  },
  transfer_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  from_godown_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'godowns', key: 'godown_id' },
  },
  to_godown_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'godowns', key: 'godown_id' },
  },
  status: {
    type: DataTypes.ENUM('Draft', 'In-Transit', 'Received', 'Cancelled'),
    allowNull: false,
    defaultValue: 'Draft',
  },
  notes: {
    type: DataTypes.TEXT,
  },
  // Header-level rollups — duplicates of SUM(items.quantity)/SUM(items.amount)
  // for the list view, so the transfer list can render totals without joining
  // and aggregating thousands of rows. Kept in sync by the controller on
  // create/update; never trusted for ledger math.
  total_quantity: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  total_value: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  received_date: {
    type: DataTypes.DATEONLY,
  },
  received_by: {
    type: DataTypes.INTEGER,
    references: { model: 'users', key: 'user_id' },
  },
  cancelled_date: {
    type: DataTypes.DATE,
  },
  cancelled_by: {
    type: DataTypes.INTEGER,
    references: { model: 'users', key: 'user_id' },
  },
  cancellation_reason: {
    type: DataTypes.TEXT,
  },
  created_by: {
    type: DataTypes.INTEGER,
    references: { model: 'users', key: 'user_id' },
  },
}, {
  tableName: 'stock_transfers',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { unique: true, fields: ['transfer_number'] },
    { fields: ['transfer_date'] },
    { fields: ['from_godown_id'] },
    { fields: ['to_godown_id'] },
    { fields: ['status'] },
  ],
});

module.exports = StockTransfer;
