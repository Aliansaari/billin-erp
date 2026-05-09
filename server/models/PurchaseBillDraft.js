const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * PurchaseBillDraft — held / in-progress purchase bills.
 *
 * Mirrors SalesBillDraft. Drafts are a separate table from `purchase_bills`
 * for the same reasons:
 *
 *   - No `bill_number` is consumed at hold time (the FOR-UPDATE lock on
 *     the last purchase_bills row only fires at commit time).
 *   - Existing GSTR-2 / aging / supplier-ledger queries read `purchase_bills`
 *     and are unaffected — drafts are invisible to all aggregators.
 *   - Stock is never touched; the StockLedger never sees a draft.
 *   - Supplier balance is unaffected; balanceHelper never sees a draft.
 *   - Discard = clean DELETE with no foreign-key fan-out.
 *
 * The `payload` column holds the entire form state as JSONB.
 */
module.exports = (sequelize) => {
  const PurchaseBillDraft = sequelize.define('PurchaseBillDraft', {
    draft_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // Auto-allocated "PDRAFT-001" inside the create transaction with a
    // FOR-UPDATE lock on the last row, mirroring the bill_number race fix
    // in purchaseController.create.
    draft_number: {
      type: DataTypes.STRING(20),
      unique: true,
      allowNull: false,
    },
    // Nullable — operator may hold a draft before picking a supplier.
    // ON DELETE SET NULL: deleting a party converts any held drafts into
    // supplier-less drafts rather than blocking the delete. Drafts have no
    // business invariants tied to supplier_id (no GST math, no balance, no
    // stock), so this is a safe, lossless transition.
    supplier_id: {
      type: DataTypes.INTEGER,
      references: { model: 'parties', key: 'party_id' },
      onDelete: 'SET NULL',
    },
    draft_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    // Entire form state. Includes: items[], gst_mode, cgst_pct/sgst_pct/
    // igst_pct (bill-wise), discount, freight, other, payment_method,
    // bill_mode, amount fields, supplier_bill_number, transport, remarks, etc.
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
    tableName: 'purchase_bill_drafts',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
    indexes: [
      { unique: true, fields: ['draft_number'] },
      { fields: ['created_date'] },
    ],
  });
  return PurchaseBillDraft;
};
