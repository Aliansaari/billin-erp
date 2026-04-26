const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Party = sequelize.define('Party', {
  party_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  party_type: {
    type: DataTypes.ENUM('Customer', 'Supplier', 'Both'),
    allowNull: false,
  },
  party_name: {
    type: DataTypes.STRING(200),
    allowNull: false,
  },
  display_name: {
    type: DataTypes.STRING(200),
  },
  mobile_1: {
    type: DataTypes.STRING(15),
    allowNull: false,
  },
  mobile_2: {
    type: DataTypes.STRING(15),
  },
  email: {
    type: DataTypes.STRING(100),
  },
  address_line_1: {
    type: DataTypes.STRING(255),
  },
  address_line_2: {
    type: DataTypes.STRING(255),
  },
  city: {
    type: DataTypes.STRING(100),
  },
  state: {
    type: DataTypes.STRING(100),
  },
  pincode: {
    type: DataTypes.STRING(10),
  },
  country: {
    type: DataTypes.STRING(100),
    defaultValue: 'India',
  },
  gstin: {
    type: DataTypes.STRING(15),
  },
  pan_number: {
    type: DataTypes.STRING(10),
  },
  aadhar_number: {
    type: DataTypes.STRING(12),
  },
  credit_allowed: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  credit_limit: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  credit_days: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  opening_balance: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  opening_balance_type: {
    type: DataTypes.ENUM('Receivable', 'Payable'),
    defaultValue: 'Receivable',
  },
  current_balance: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  interest_rate: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
  },
  party_status: {
    type: DataTypes.ENUM('Regular', 'Priority', 'VIP', 'Blacklist'),
    defaultValue: 'Regular',
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  created_by: {
    type: DataTypes.INTEGER,
  },
  // Auto-linked at create time via the afterCreate hook (see below). One
  // ledger_accounts row per party — Customer → Sundry Debtors, Supplier →
  // Sundry Creditors, Both → Sundry Debtors (documented convention).
  // FK declared at the DB level via the migration block in server/index.js
  // (kept off the model to avoid cyclic-FK issues during sync).
  ledger_account_id: {
    type: DataTypes.INTEGER,
  },
}, {
  tableName: 'parties',
  timestamps: true,
  createdAt: 'created_date',
  updatedAt: 'modified_date',
  indexes: [
    { fields: ['party_name'] },
    { fields: ['mobile_1'] },
    { fields: ['party_type'] },
  ],
});

// ── afterCreate: auto-link a ledger_accounts row + post opening JV ─────
// One ledger per party. Customer → Sundry Debtors (Assets), Supplier →
// Sundry Creditors (Liabilities). Convention for 'Both': Sundry Debtors.
//
// If opening_balance is non-zero, a Journal Voucher is posted dated
// (financial_year_start - 1 day) so the opening shows up before any
// regular transactions in date-sorted views.
//
// Lazy-requires the models index + posting service to dodge the circular
// dependency (this file is required by models/index.js itself).
Party.addHook('afterCreate', async (party, options) => {
  // Defer requires to runtime — circular safety.
  /* eslint-disable global-require */
  const { LedgerAccount, SystemSettings } = require('./index');
  const { postVoucher } = require('../services/ledgerPostingService');
  /* eslint-enable global-require */

  const t = options && options.transaction;

  // Skip if a ledger is already linked (re-runs of afterCreate via update,
  // or rows that imported with their ledger pre-populated).
  if (party.ledger_account_id) return;

  const isSupplierOnly = party.party_type === 'Supplier';
  const ledgerGroup = isSupplierOnly ? 'Liabilities' : 'Assets';
  const subGroup    = isSupplierOnly ? 'Sundry Creditors' : 'Sundry Debtors';

  // Use party_name for the ledger; if a name collision exists, suffix the
  // party_id to keep the unique constraint satisfied.
  let ledgerName = party.party_name;
  const collision = await LedgerAccount.findOne({
    where: { ledger_name: ledgerName },
    transaction: t,
  });
  if (collision) ledgerName = `${ledgerName} (#${party.party_id})`;

  const ledger = await LedgerAccount.create({
    ledger_name: ledgerName,
    ledger_group: ledgerGroup,
    sub_group: subGroup,
    is_system_ledger: false,
    is_party_ledger: true,
    party_id: party.party_id,
    is_active: true,
  }, { transaction: t });

  // Update party with the ledger FK. Use raw UPDATE to skip our own
  // afterUpdate hook chain (none defined today, but defensive).
  await Party.update(
    { ledger_account_id: ledger.ledger_id },
    { where: { party_id: party.party_id }, transaction: t, hooks: false },
  );
  party.ledger_account_id = ledger.ledger_id;

  // Opening balance JV — only if non-zero
  const opening = Number(party.opening_balance) || 0;
  if (opening > 0.005) {
    const obe = await LedgerAccount.findOne({
      where: { ledger_name: 'Opening Balance Equity' },
      transaction: t,
    });
    if (!obe) {
      throw new Error('afterCreate: Opening Balance Equity ledger missing — seed not run?');
    }

    // Date = FY start - 1 day (so opening appears strictly before the
    // first regular transaction). Fall back to today - 1 if settings absent.
    const settings = await SystemSettings.findOne({ where: { setting_id: 1 }, transaction: t });
    let openingDate = new Date();
    if (settings && settings.financial_year_start) {
      const fy = new Date(settings.financial_year_start);
      fy.setDate(fy.getDate() - 1);
      openingDate = fy;
    } else {
      openingDate.setDate(openingDate.getDate() - 1);
    }

    // Receivable → party-ledger Dr, OBE Cr
    // Payable    → OBE Dr, party-ledger Cr
    const isReceivable = (party.opening_balance_type || 'Receivable') === 'Receivable';
    const lines = isReceivable
      ? [
          { ledgerAccountId: ledger.ledger_id, debit:  opening, credit: 0, partyId: party.party_id },
          { ledgerAccountId: obe.ledger_id,    debit:  0,       credit: opening },
        ]
      : [
          { ledgerAccountId: obe.ledger_id,    debit:  opening, credit: 0 },
          { ledgerAccountId: ledger.ledger_id, debit:  0,       credit: opening, partyId: party.party_id },
        ];

    await postVoucher({
      voucherType: 'Journal',
      sourceType: 'party_opening',
      sourceId: party.party_id,
      voucherDate: openingDate,
      referenceNumber: `OB-${party.party_id}`,
      narration: `Opening balance for ${party.party_name}`,
      lines,
      userId: party.created_by || null,
      transaction: t,
    });
  }
});

module.exports = Party;
