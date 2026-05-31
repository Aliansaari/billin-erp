const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/*
 * Salesman — the person credited with a sale.
 *
 * Why this exists:
 *   A wholesale counter usually runs several sales staff. The owner wants to
 *   know who booked which bill, run a per-salesman sales report, and optionally
 *   track a commission rate. Historically the Sales Bill form carried a free
 *   text `salesman_name` field — easy to mistype, impossible to aggregate
 *   reliably. This master turns that free text into a managed list the operator
 *   picks from.
 *
 * PURE ATTRIBUTION — read this before touching anything financial:
 *   A salesman is a *tag* on a bill and nothing more. It NEVER participates in
 *   any total, tax, discount, ledger voucher, balance, return, or stock
 *   calculation. The Sales Bill keeps both `salesman_id` (FK into this table)
 *   and the existing `salesman_name` text snapshot, so deactivating or renaming
 *   a salesman later never rewrites historical bills. salesController is left
 *   completely untouched — `salesman_id` rides along through its generic
 *   `...billData` spread on create/update. Do not wire this into any money math.
 *
 * Uniqueness:
 *   Name/code uniqueness is enforced in the controller (case-insensitive),
 *   NOT by DB constraints. This keeps the model definition byte-for-byte
 *   aligned with the explicit CREATE TABLE in the schema-migration helpers and
 *   avoids sync() trying to add indexes to existing per-company databases.
 *
 * Soft delete:
 *   `is_active = false` hides a salesman from the bill-form dropdown but leaves
 *   every historical bill's attribution intact. We never hard-delete a salesman
 *   who is referenced by a bill (the controller guards this).
 */
module.exports = (sequelize) => {
  const Salesman = sequelize.define('Salesman', {
    salesman_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    code: {
      // Optional short identifier shown alongside the name in the bill-form
      // selector (e.g. "RAVI", "S-01"). Uniqueness is controller-enforced.
      type: DataTypes.STRING(20),
    },
    phone: {
      type: DataTypes.STRING(20),
    },
    email: {
      type: DataTypes.STRING(120),
    },
    commission_percentage: {
      // Informational only. Surfaced in the Sales-by-Salesman report so the
      // owner can eyeball an indicative commission figure. It is NOT applied
      // to any invoice, ledger, or payout automatically — purely a reporting
      // convenience the operator can use or ignore.
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    is_active: {
      // Soft-delete. Inactive salesmen drop out of the bill-form dropdown but
      // their historical attribution on past bills is preserved.
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    notes: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'salesmen',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: 'modified_date',
  });
  return Salesman;
};
