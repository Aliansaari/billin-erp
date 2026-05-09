const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
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
    // System "Cash" party flag. There is exactly ONE row in `parties` with
    // is_system_cash=true (enforced by a partial unique index in
    // server/index.js). It's seeded on first boot with party_name='Cash',
    // party_type='Both', and ledger_account_id pointing at the Cash-in-Hand
    // system ledger directly — not its own auto-created Sundry Debtors row.
    // Every cash sale/purchase posts its party leg against that Cash ledger,
    // so cash transactions never pollute Sundry Debtors/Creditors aging or
    // the Trial Balance debtor/creditor buckets.
    //
    // The Party form blocks creation of any user-typed name matching
    // /^cash/i (the operator must use the system party). The dropdown
    // sorts is_system_cash DESC so "Cash" pins to the top.
    is_system_cash: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
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

  // ── Static helper: normalise opening_balance_type ─────────────────────
  //
  // The Party model column accepts only the enum {'Receivable','Payable'},
  // but human input arrives in many forms — accounting shorthand (Dr/Cr),
  // long form (Debit/Credit), or our own enum spelling. A naïve
  // `startsWith('p')` test silently mis-routes "Cr" to 'Receivable',
  // which inverts the opening JV on the supplier's own ledger.
  //
  // Mapping:
  //   ''                    → 'Receivable'   (default — no input)
  //   'cr' / 'credit'       → 'Payable'
  //   'pay' / 'payable'     → 'Payable'
  //   'dr' / 'debit'        → 'Receivable'
  //   'rec' / 'receivable'  → 'Receivable'
  //   anything else         → 'Receivable'   (safe default; over-credit is
  //                                          worse than under-credit since
  //                                          a wrong-direction opening
  //                                          corrupts the audit trail)
  //
  // Every caller that builds a Party row from external input (Excel / Tally
  // orchestrators, future imports) must run the user-supplied value through
  // this helper before Party.create. The afterCreate hook below keeps its
  // trust in the column value — the normalizer is the single point of
  // translation.
  Party.normalizeBalanceType = function normalizeBalanceType(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return 'Receivable';
    if (s === 'cr' || s.startsWith('cred') || s.startsWith('pay')) return 'Payable';
    return 'Receivable';
  };

  /**
   * Post the party_opening JV using the party's current opening_balance
   * + opening_balance_type. Called from afterCreate AND from
   * partyController.update when those fields change (audit H2).
   *
   * Caller is responsible for FIRST reversing any existing party_opening
   * voucher when this is being called as part of an edit.
   *
   * Skips silently when opening is effectively zero — no voucher needed.
   *
   * Lazy-requires models/index + ledgerPostingService at call time so the
   * cyclic-import is resolved AFTER all models have been registered.
   */
  async function postPartyOpeningJV(party, ledgerId, transaction) {
    /* eslint-disable global-require */
    const { LedgerAccount, SystemSettings } = require('./index');
    const { postVoucher } = require('../services/ledgerPostingService');
    /* eslint-enable global-require */

    const opening = Number(party.opening_balance) || 0;
    if (opening <= 0.005) return;

    const obe = await LedgerAccount.findOne({
      where: { ledger_name: 'Opening Balance Equity' },
      transaction,
    });
    if (!obe) {
      throw new Error('postPartyOpeningJV: Opening Balance Equity ledger missing — seed not run?');
    }

    // Date = FY start - 1 day (so opening appears strictly before the
    // first regular transaction). Fall back to today - 1 if settings absent.
    const settings = await SystemSettings.findOne({ where: { setting_id: 1 }, transaction });
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
          { ledgerAccountId: ledgerId,      debit:  opening, credit: 0, partyId: party.party_id },
          { ledgerAccountId: obe.ledger_id, debit:  0,       credit: opening },
        ]
      : [
          { ledgerAccountId: obe.ledger_id, debit:  opening, credit: 0 },
          { ledgerAccountId: ledgerId,      debit:  0,       credit: opening, partyId: party.party_id },
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
      transaction,
    });
  }
  // Expose the helper so partyController.update / delete can re-post on
  // opening_balance changes. Called as Party.postPartyOpeningJV(...).
  Party.postPartyOpeningJV = postPartyOpeningJV;

  // ── afterCreate: auto-link a ledger_accounts row + post opening JV ────
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
    /* eslint-disable global-require */
    const { LedgerAccount } = require('./index');
    /* eslint-enable global-require */

    const t = options && options.transaction;

    // Skip if a ledger is already linked (re-runs of afterCreate via update,
    // or rows that imported with their ledger pre-populated).
    if (party.ledger_account_id) return;

    // System Cash party: no auto-created Sundry Debtors/Creditors row.
    // Instead, link directly to the seeded Cash-in-Hand ledger so cash
    // sale / cash purchase party legs post to Cash directly. The seeder
    // sets ledger_account_id explicitly when creating this row, but
    // defensively short-circuit here in case anything ever creates a
    // system-cash party without pre-populating the ledger link.
    if (party.is_system_cash) {
      const cashLedger = await LedgerAccount.findOne({
        where: { ledger_name: 'Cash' },
        transaction: t,
      });
      if (cashLedger) {
        await Party.update(
          { ledger_account_id: cashLedger.ledger_id },
          { where: { party_id: party.party_id }, transaction: t, hooks: false },
        );
        party.ledger_account_id = cashLedger.ledger_id;
      }
      return;
    }

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

    await postPartyOpeningJV(party, ledger.ledger_id, t);
  });

  return Party;
};
