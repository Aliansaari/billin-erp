const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = (sequelize) => {
  const LedgerEntry = sequelize.define('LedgerEntry', {
    entry_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // entry_number is the *voucher* group key — multiple Dr/Cr legs of one
    // voucher share the same entry_number. NOT row-level unique.
    entry_number: {
      type: DataTypes.STRING(30),
      allowNull: false,
    },
    entry_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    ledger_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'ledger_accounts', key: 'ledger_id' },
    },
    debit_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    credit_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
    },
    narration: {
      type: DataTypes.TEXT,
    },
    voucher_type: {
      type: DataTypes.ENUM('Sales', 'Purchase', 'Payment', 'Receipt', 'Journal', 'Contra'),
      allowNull: false,
    },
    reference_id: {
      type: DataTypes.INTEGER,
    },
    reference_number: {
      type: DataTypes.STRING(30),
    },
    // Logical source-table tag: 'sales_bill', 'purchase_bill',
    // 'sales_return_bill', 'purchase_return_bill', 'payment_receipt',
    // 'journal_voucher'. Disambiguates rows that share a voucher_type
    // (e.g. sales_bill vs sales_return_bill both post under 'Sales').
    source_type: {
      type: DataTypes.STRING(40),
    },
    // For credit/debit-note style reversals — points to the original entry
    // this row negates. NULL on forward postings. FK at DB level only.
    reversal_of_id: {
      type: DataTypes.INTEGER,
    },
    // Optional party tag on a line — speeds up party-ledger reads without
    // requiring a join to ledger_accounts. FK at DB level only.
    party_id: {
      type: DataTypes.INTEGER,
    },
    created_by: {
      type: DataTypes.INTEGER,
      references: { model: 'users', key: 'user_id' },
    },
  }, {
    tableName: 'ledger_entries',
    timestamps: true,
    createdAt: 'created_date',
    updatedAt: false,
    indexes: [
      { fields: ['entry_date'] },
      { fields: ['ledger_id'] },
      // source_type, party_id indexes are added via raw SQL in the
      // server/index.js migration block (sync runs before migrations,
      // so we can't declare indexes on columns sync hasn't created yet).
    ],
  });
  
  // ── Append-only guard ──
  // ledger_entries is the financial source of truth. Direct UPDATE / DELETE
  // would silently break the audit trail. Reversing a posting must go
  // through ledgerPostingService.reverseVoucher(), which inserts a mirror
  // entry instead of mutating the original.
  //
  // This is a software-level guard via Sequelize hooks. A raw SQL UPDATE
  // that bypasses the ORM is NOT blocked. Future hardening: when migrations
  // are introduced, add a DB trigger that mirrors this check.
  //
  // Deliberate bypass: the data-wipe routine in settingsController passes
  // `{ hooks: false }` so admins can still reset the database.
  LedgerEntry.addHook('beforeUpdate', () => {
    throw new Error(
      'ledger_entries is append-only. Use ledgerPostingService.reverseVoucher() to undo a posting.',
    );
  });
  LedgerEntry.addHook('beforeDestroy', () => {
    throw new Error(
      'ledger_entries is append-only. Use ledgerPostingService.reverseVoucher() to undo a posting.',
    );
  });
  LedgerEntry.addHook('beforeBulkUpdate', () => {
    throw new Error('ledger_entries is append-only — bulk update blocked.');
  });
  LedgerEntry.addHook('beforeBulkDestroy', (options) => {
    // Allow explicit bypass via { individualHooks: false, hooks: false } —
    // settingsController wipe passes hooks:false on the destroy() call.
    if (options && options.hooks === false) return;
    throw new Error('ledger_entries is append-only — bulk destroy blocked.');
  });
  return LedgerEntry;
};
