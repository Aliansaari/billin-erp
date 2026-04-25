const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * SalesBillDraft — held / in-progress sales bills.
 *
 * Drafts are deliberately a *separate* table from `sales_bills`. This is
 * the single most important architectural decision for this feature:
 *
 *   - No `bill_number` is consumed at hold time (the FOR-UPDATE lock on
 *     the last sales_bills row only fires at commit time).
 *   - Every existing GSTR-1 / GSTR-3B / report query reads `sales_bills`
 *     and is unaffected — drafts are invisible to all aggregators
 *     without a single WHERE-clause change.
 *   - Stock is never touched; the StockLedger never sees a draft.
 *   - Party balance is unaffected; balanceHelper never sees a draft.
 *   - Discard = clean DELETE with no foreign-key fan-out.
 *
 * The `payload` column holds the entire form state as JSONB. Drafts have
 * no business invariants (no GST math, no stock, no balance) so a flat
 * blob is the right shape — mirroring the schema would cost ~20 columns
 * + a child table + write fan-out per save and buy nothing. We freeze
 * the blob shape with `payload._schema_version` for forward-migration.
 */
const SalesBillDraft = sequelize.define('SalesBillDraft', {
  draft_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  // Auto-allocated "DRAFT-001" inside the create transaction with a
  // FOR-UPDATE lock on the last row, mirroring the bill_number race fix
  // in salesController.create. Ensures no two drafts share a number.
  draft_number: {
    type: DataTypes.STRING(20),
    unique: true,
    allowNull: false,
  },
  // Nullable — a walk-in customer may have no party_id at hold time.
  customer_id: {
    type: DataTypes.INTEGER,
    references: { model: 'parties', key: 'party_id' },
  },
  draft_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  // Entire form state. Includes: items[], gst_mode, cgst_pct/sgst_pct/
  // igst_pct (bill-wise), discount, special_discount, freight, other,
  // round_off, payment_method, return_amount, remarks, sale_type, etc.
  payload: {
    type: DataTypes.JSONB,
    allowNull: false,
  },
  // Denormalised for the list-view UI (so we don't parse payload to
  // render the table). Updated by the controller on create/update.
  item_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  total_preview: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  created_by: {
    type: DataTypes.INTEGER,
    references: { model: 'users', key: 'user_id' },
  },
}, {
  tableName: 'sales_bill_drafts',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { unique: true, fields: ['draft_number'] },
    { fields: ['created_date'] },
  ],
});

module.exports = SalesBillDraft;
