const bcrypt = require('bcryptjs');
const { Role, User, BarcodeSettings, SystemSettings, LedgerAccount, PrintProfile, Party, Godown, IndianState } = require('../models');
const { ROLES } = require('../utils/rolePerms');

// 36 Indian states + union territories with their GST state codes (the
// 2-digit GSTIN prefix). Reference: https://en.wikipedia.org/wiki/List_of_state_and_union_territory_capitals_in_India
// sort_order keeps states alphabetical first, then UTs alphabetical, so the
// dropdown looks natural without runtime sorting.
const INDIAN_STATES_SEED = [
  // States (alphabetical)
  { state_name: 'Andhra Pradesh',     gst_code: '28', is_union_territory: false, sort_order: 1  },
  { state_name: 'Arunachal Pradesh',  gst_code: '12', is_union_territory: false, sort_order: 2  },
  { state_name: 'Assam',              gst_code: '18', is_union_territory: false, sort_order: 3  },
  { state_name: 'Bihar',              gst_code: '10', is_union_territory: false, sort_order: 4  },
  { state_name: 'Chhattisgarh',       gst_code: '22', is_union_territory: false, sort_order: 5  },
  { state_name: 'Goa',                gst_code: '30', is_union_territory: false, sort_order: 6  },
  { state_name: 'Gujarat',            gst_code: '24', is_union_territory: false, sort_order: 7  },
  { state_name: 'Haryana',            gst_code: '06', is_union_territory: false, sort_order: 8  },
  { state_name: 'Himachal Pradesh',   gst_code: '02', is_union_territory: false, sort_order: 9  },
  { state_name: 'Jharkhand',          gst_code: '20', is_union_territory: false, sort_order: 10 },
  { state_name: 'Karnataka',          gst_code: '29', is_union_territory: false, sort_order: 11 },
  { state_name: 'Kerala',             gst_code: '32', is_union_territory: false, sort_order: 12 },
  { state_name: 'Madhya Pradesh',     gst_code: '23', is_union_territory: false, sort_order: 13 },
  { state_name: 'Maharashtra',        gst_code: '27', is_union_territory: false, sort_order: 14 },
  { state_name: 'Manipur',            gst_code: '14', is_union_territory: false, sort_order: 15 },
  { state_name: 'Meghalaya',          gst_code: '17', is_union_territory: false, sort_order: 16 },
  { state_name: 'Mizoram',            gst_code: '15', is_union_territory: false, sort_order: 17 },
  { state_name: 'Nagaland',           gst_code: '13', is_union_territory: false, sort_order: 18 },
  { state_name: 'Odisha',             gst_code: '21', is_union_territory: false, sort_order: 19 },
  { state_name: 'Punjab',             gst_code: '03', is_union_territory: false, sort_order: 20 },
  { state_name: 'Rajasthan',          gst_code: '08', is_union_territory: false, sort_order: 21 },
  { state_name: 'Sikkim',             gst_code: '11', is_union_territory: false, sort_order: 22 },
  { state_name: 'Tamil Nadu',         gst_code: '33', is_union_territory: false, sort_order: 23 },
  { state_name: 'Telangana',          gst_code: '36', is_union_territory: false, sort_order: 24 },
  { state_name: 'Tripura',            gst_code: '16', is_union_territory: false, sort_order: 25 },
  { state_name: 'Uttar Pradesh',      gst_code: '09', is_union_territory: false, sort_order: 26 },
  { state_name: 'Uttarakhand',        gst_code: '05', is_union_territory: false, sort_order: 27 },
  { state_name: 'West Bengal',        gst_code: '19', is_union_territory: false, sort_order: 28 },
  // Union Territories (alphabetical, sorted after states)
  { state_name: 'Andaman and Nicobar Islands',            gst_code: '35', is_union_territory: true, sort_order: 50 },
  { state_name: 'Chandigarh',                             gst_code: '04', is_union_territory: true, sort_order: 51 },
  { state_name: 'Dadra and Nagar Haveli and Daman and Diu', gst_code: '26', is_union_territory: true, sort_order: 52 },
  { state_name: 'Delhi',                                  gst_code: '07', is_union_territory: true, sort_order: 53 },
  { state_name: 'Jammu and Kashmir',                      gst_code: '01', is_union_territory: true, sort_order: 54 },
  { state_name: 'Ladakh',                                 gst_code: '38', is_union_territory: true, sort_order: 55 },
  { state_name: 'Lakshadweep',                            gst_code: '31', is_union_territory: true, sort_order: 56 },
  { state_name: 'Puducherry',                             gst_code: '34', is_union_territory: true, sort_order: 57 },
];

async function seedDefaultData() {
  // ── Roles ──
  // Upsert: create missing roles and refresh permissions_json on existing
  // ones so schema changes in rolePerms.js propagate to already-installed
  // databases. We intentionally do NOT touch role_name → role_id mappings,
  // so user rows keep their existing role_id values across upgrades.
  for (const role of ROLES) {
    const [row, created] = await Role.findOrCreate({
      where: { role_name: role.role_name },
      defaults: role,
    });
    if (!created) {
      await row.update({
        permissions_json:    role.permissions_json,
        can_view_reports:    role.can_view_reports,
        can_delete_bills:    role.can_delete_bills,
        can_edit_rates:      role.can_edit_rates,
        can_access_accounts: role.can_access_accounts,
        can_manage_users:    role.can_manage_users,
      });
    }
  }

  // ── Default Super Admin User ──
  // The seeded account used for first-run setup. Role = Super Admin so the
  // initial user can create other users and configure the system. The
  // "admin/admin123" default triggers a forced password change on login
  // (see authController.js) — we do NOT want a super-admin account with a
  // public default password in the wild.
  const superAdminRole = await Role.findOne({ where: { role_name: 'Super Admin' } });
  const adminRole      = await Role.findOne({ where: { role_name: 'Admin' } });
  // AUTH-H6 — bcrypt cost 12 (OWASP 2025). One-time cost at seed.
  const hashedPassword = await bcrypt.hash('admin123', 12);
  const [adminUser, adminCreated] = await User.findOrCreate({
    where: { username: 'admin' },
    defaults: {
      username: 'admin',
      password_hash: hashedPassword,
      full_name: 'System Administrator',
      email: 'admin@company.com',
      role_id: superAdminRole.role_id,
      is_active: true,
    },
  });

  // If the admin exists from a previous seed where Super Admin didn't yet
  // exist, upgrade them now so they can actually manage users. Only auto-
  // upgrade if they're currently on the 'Admin' role — don't downgrade a
  // deliberately-weakened admin account.
  if (!adminCreated && adminUser.role_id === adminRole?.role_id) {
    await adminUser.update({ role_id: superAdminRole.role_id });
  }

  // ── Barcode Settings ──
  await BarcodeSettings.findOrCreate({
    where: { setting_id: 1 },
    defaults: {
      prefix: 'PROD',
      starting_number: 1,
      current_number: 0,
      total_digits: 10,
      format_pattern: 'PREFIX-NNNNNN',
    },
  });

  // ── System Settings ──
  // FY compliance defaults: simple mode (off), no locks, no password
  // challenge. Admin opts into the audit features from Settings →
  // Financial Year, which walks them through picking a soft-lock date.
  await SystemSettings.findOrCreate({
    where: { setting_id: 1 },
    defaults: {
      company_name: 'My Company',
      financial_year_start: '2026-04-01',
      financial_year_end: '2027-03-31',
      gst_enabled: false,
      low_stock_alert_enabled: true,
      backup_frequency: 'Daily',
      fy_compliance_mode: false,
      fy_soft_lock_date: null,
      fy_hard_lock_date: null,
      fy_require_override_password: false,
    },
  });

  // ── Indian States reference table ──
  // Idempotent: findOrCreate keyed on state_name. Once a row exists we leave
  // it alone — operators who renamed a state (e.g. "Pondicherry" → "Puducherry"
  // legacy data) get to keep their override. New states added in future
  // releases are inserted on next boot without disturbing existing rows.
  for (const s of INDIAN_STATES_SEED) {
    await IndianState.findOrCreate({
      where: { state_name: s.state_name },
      defaults: s,
    });
  }

  // ── Default Ledger Accounts ──
  const defaultLedgers = [
    { ledger_name: 'Cash', ledger_group: 'Assets', sub_group: 'Cash-in-Hand', is_system_ledger: true },
    { ledger_name: 'Bank Account', ledger_group: 'Assets', sub_group: 'Bank Accounts', is_system_ledger: true },
    { ledger_name: 'Accounts Receivable', ledger_group: 'Assets', sub_group: 'Sundry Debtors', is_system_ledger: true },
    { ledger_name: 'Accounts Payable', ledger_group: 'Liabilities', sub_group: 'Sundry Creditors', is_system_ledger: true },
    // Sales / Purchase + their Returns sit in dedicated Tally primary groups
    // (Sales Accounts / Purchase Accounts) so the P&L can render the
    // "Less: Returns" deduction line cleanly. Direct Incomes / Direct
    // Expenses are reserved for operational direct items (service income,
    // freight inward, factory wages) — distinct primary groups in Tally.
    // Within each group the natural sign tells us which is sale vs return:
    // a Cr-balance ledger in 'Sales Accounts' is a sale, a Dr-balance
    // ledger is a return.
    { ledger_name: 'Sales Account', ledger_group: 'Income', sub_group: 'Sales Accounts', is_system_ledger: true },
    { ledger_name: 'Purchase Account', ledger_group: 'Expenses', sub_group: 'Purchase Accounts', is_system_ledger: true },
    { ledger_name: 'Sales Return', ledger_group: 'Income', sub_group: 'Sales Accounts', is_system_ledger: true },
    { ledger_name: 'Purchase Return', ledger_group: 'Expenses', sub_group: 'Purchase Accounts', is_system_ledger: true },
    { ledger_name: 'Discount Allowed', ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: true },
    { ledger_name: 'Discount Received', ledger_group: 'Income', sub_group: 'Indirect Incomes', is_system_ledger: true },
    { ledger_name: 'CGST Input', ledger_group: 'Assets', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'SGST Input', ledger_group: 'Assets', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'IGST Input', ledger_group: 'Assets', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'CGST Output', ledger_group: 'Liabilities', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'SGST Output', ledger_group: 'Liabilities', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'IGST Output', ledger_group: 'Liabilities', sub_group: 'Duties & Taxes', is_system_ledger: true },
    // Audit H8 — seed Cess Input/Output so RCM and regular cess collections
    // don't silently fold into IGST. The voucherBuilders fallback that maps
    // missing Cess ledgers to IGST stays in place as a safety net for legacy
    // installs that haven't re-seeded.
    { ledger_name: 'Cess Input',   ledger_group: 'Assets',      sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'Cess Output',  ledger_group: 'Liabilities', sub_group: 'Duties & Taxes', is_system_ledger: true },
    // Audit M (accounting) — Round Off is "Indirect Incomes" by Tally
    // convention so a rounding gain on a sale doesn't render as a negative
    // expense in the P&L. The voucher posts Dr (loss) or Cr (gain) against
    // this single ledger; either sign is correct math, but the group
    // determines which P&L line it shows up on.
    { ledger_name: 'Round Off', ledger_group: 'Income', sub_group: 'Indirect Incomes', is_system_ledger: true },
    { ledger_name: 'Stock-in-Hand', ledger_group: 'Assets', sub_group: 'Current Assets', is_system_ledger: true },
    { ledger_name: 'Capital Account', ledger_group: 'Capital', sub_group: 'Capital Account', is_system_ledger: true },
    // Phase-1 additions for double-entry wiring:
    // Opening Balance Equity is the contra account for opening-balance JVs
    // posted by the Party afterCreate hook. Suspense Account is a fallback
    // for unmappable entries during imports.
    { ledger_name: 'Opening Balance Equity', ledger_group: 'Capital', sub_group: 'Capital Account', is_system_ledger: true },
    { ledger_name: 'Suspense Account', ledger_group: 'Liabilities', sub_group: 'Suspense', is_system_ledger: true },

    // Cheque module ledgers — see server/models/Cheque.js for the
    // posting model. These hold the in-flight balances:
    //
    //   Cheques in Hand (Asset, current asset) — INWARD cheques received
    //   from a customer but not yet deposited at our bank. Drains to
    //   Bank when we deposit, and back to the customer when a cheque
    //   bounces / is voided.
    //
    //   Cheques Issued (PDC) (Liability, current liability) — OUTWARD
    //   post-dated cheques we've handed out but the bank hasn't been
    //   debited for yet. Sits as a "future obligation" until maturity,
    //   when it transfers to Bank.
    //
    //   Cheque Bounce Charges (Expense, indirect expense) — bank fees
    //   levied when a cheque (in either direction) bounces. Posted as
    //   a separate voucher so the P&L breaks out the cost of failed
    //   cheques cleanly.
    { ledger_name: 'Cheques in Hand',       ledger_group: 'Assets',      sub_group: 'Current Assets',     is_system_ledger: true },
    { ledger_name: 'Cheques Issued (PDC)',  ledger_group: 'Liabilities', sub_group: 'Current Liabilities', is_system_ledger: true },
    // INWARD PDC holding ledger (audit H11). When a customer hands over a
    // post-dated cheque, the receivable on the asset side belongs HERE,
    // not in Cheques in Hand — the funds aren't legally realisable until
    // the cheque date arrives. The deposit voucher then drains this
    // holding ledger into the bank when the cheque is presented.
    { ledger_name: 'Post-Dated Cheques (Receivable)', ledger_group: 'Assets', sub_group: 'Current Assets', is_system_ledger: true },
    { ledger_name: 'Cheque Bounce Charges', ledger_group: 'Expenses',    sub_group: 'Indirect Expenses',  is_system_ledger: true },

    // ── Common expense heads for the Expense Tracker ─────────────────
    //
    // Pre-seed the most common Indirect Expense ledgers so a fresh
    // install can record an expense voucher on day one without first
    // creating chart-of-accounts rows. is_system_ledger=false on these
    // so admins are free to rename / disable them; nothing in the
    // builder hard-codes their names. The form picks ANY ledger in
    // ledger_group='Expenses' as a valid expense head — direct vs
    // indirect lives in sub_group ('Direct Expenses' for operational
    // direct items like Freight Inward, 'Indirect Expenses' for
    // everything else).
    { ledger_name: 'Salaries & Wages',          ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Office Rent',               ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Electricity Charges',       ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Internet & Telephone',      ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Office Supplies',           ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Printing & Stationery',     ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Travel & Conveyance',       ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Repairs & Maintenance',     ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Bank Charges',              ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Professional Fees',         ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Insurance',                 ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Advertisement & Marketing', ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Freight Outward',           ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
    { ledger_name: 'Freight Inward',            ledger_group: 'Expenses', sub_group: 'Direct Expenses',   is_system_ledger: false },
    { ledger_name: 'Miscellaneous Expenses',    ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: false },
  ];

  for (const ledger of defaultLedgers) {
    const [row, created] = await LedgerAccount.findOrCreate({
      where: { ledger_name: ledger.ledger_name }, defaults: ledger,
    });
    // Audit (accounting M1) — upgrade legacy seeds whose Round Off ledger
    // is still classified as 'Expenses / Indirect Expenses'. New default
    // is 'Income / Indirect Incomes' so a rounding gain doesn't read as a
    // negative expense on the P&L. Idempotent — only fires when the group
    // is wrong AND the row was seeded by us (system ledger).
    if (!created && ledger.is_system_ledger
        && (row.ledger_group !== ledger.ledger_group || row.sub_group !== ledger.sub_group)) {
      // Only auto-migrate the specific Round Off case — leave other
      // user-customised ledgers alone.
      if (ledger.ledger_name === 'Round Off') {
        await row.update({
          ledger_group: ledger.ledger_group,
          sub_group: ledger.sub_group,
        });
      }
    }
  }

  // ── System "Cash" party ──────────────────────────────────────────────
  // One canonical row used as the customer (and supplier) for every cash
  // sale / cash purchase. Pre-linked to the seeded Cash-in-Hand ledger so
  // the voucher builder posts cash legs directly there — no auto-created
  // Sundry Debtors row, no per-import "Cash Sales" stub, no NULL
  // customer_id pattern. is_active=true, is_system_cash=true (which the
  // partyController + reports pivot on to pin to the top of dropdowns,
  // skip the /^cash/i name validation, and exclude from receivables/
  // payables aging + the Sundry Debtors/Creditors balance-sheet groups).
  //
  // findOrCreate is keyed on is_system_cash=true (only one row may have
  // that flag — partial unique index in the migration block) so reseeds
  // are no-ops. We bypass the Party afterCreate hook's auto-ledger
  // logic by pre-populating ledger_account_id; the hook short-circuits
  // when is_system_cash is set.
  const cashLedger = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' } });
  if (cashLedger) {
    await Party.findOrCreate({
      where: { is_system_cash: true },
      defaults: {
        is_system_cash: true,
        party_type: 'Both',
        party_name: 'Cash',
        // mobile_1 is NOT NULL on the model. The system Cash party isn't
        // a real contactable entity, so use a sentinel that won't collide
        // with a real number and clearly signals "system fixture".
        mobile_1: 'CASH',
        opening_balance: 0,
        opening_balance_type: 'Receivable',
        is_active: true,
        ledger_account_id: cashLedger.ledger_id,
      },
    });
  }

  // ── Default Print Profiles ──
  // One A4 default per major doc type, plus a thermal profile for Sales so
  // the POS flow has a sensible starter. Users can duplicate/edit these.
  const defaultPrintProfiles = [
    { name: 'A4 Tax Invoice (default)',  doc_type: 'sales',           format: 'a4',      is_default: true },
    { name: 'Thermal 80mm',              doc_type: 'sales',           format: 'thermal', is_default: false,
      paper_width_mm: 80, paper_height_mm: 0, margin_top_mm: 3, margin_right_mm: 3, margin_bottom_mm: 3, margin_left_mm: 3,
      font_size_pt: 9, show_hsn: false, show_mrp: false, show_tax_breakdown: false,
      tax_summary_mode: 'consolidated', copies: 1, copy_labels: 'Customer Copy' },
    { name: 'A4 Purchase Bill',          doc_type: 'purchase',        format: 'a4',      is_default: true },
    { name: 'A4 Credit Note',            doc_type: 'sales_return',    format: 'a4',      is_default: true },
    { name: 'A4 Debit Note',             doc_type: 'purchase_return', format: 'a4',      is_default: true },
    { name: 'A5 Receipt',                doc_type: 'receipt',         format: 'a5',      is_default: true,
      paper_width_mm: 148, paper_height_mm: 210, margin_top_mm: 8, margin_right_mm: 8, margin_bottom_mm: 8, margin_left_mm: 8 },
    { name: 'A5 Payment Voucher',        doc_type: 'payment',         format: 'a5',      is_default: true,
      paper_width_mm: 148, paper_height_mm: 210, margin_top_mm: 8, margin_right_mm: 8, margin_bottom_mm: 8, margin_left_mm: 8 },
  ];
  for (const p of defaultPrintProfiles) {
    await PrintProfile.findOrCreate({ where: { name: p.name, doc_type: p.doc_type }, defaults: p });
  }

  // ── Default Godown ────────────────────────────────────────────────────
  // Every install needs at least one godown for bill issuance. The "Main"
  // godown is_system=true (cannot be hard-deleted) and is_default=true
  // (auto-selected in bill forms unless the user picks otherwise). Single-
  // warehouse deployments live entirely on this row; multi-warehouse
  // deployments add more godowns from Settings → Godowns.
  //
  // findOrCreate keyed on is_system=true so re-seeds are no-ops even if
  // someone renames "Main" to something else. Partial unique index on
  // is_default ensures only one default exists.
  await Godown.findOrCreate({
    where: { is_system: true },
    defaults: {
      name: 'Main',
      code: 'MAIN',
      is_default: true,
      is_system: true,
      is_active: true,
    },
  });

  console.log('Default data seeded successfully');
}

module.exports = seedDefaultData;
