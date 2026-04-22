const bcrypt = require('bcryptjs');
const { Role, User, BarcodeSettings, SystemSettings, LedgerAccount, PrintProfile } = require('../models');

async function seedDefaultData() {
  // ── Roles ──
  const roles = [
    {
      role_name: 'Admin',
      permissions_json: { all: true },
      can_view_reports: true,
      can_delete_bills: true,
      can_edit_rates: true,
      can_access_accounts: true,
      can_manage_users: true,
    },
    {
      role_name: 'Manager',
      permissions_json: { sales: true, purchase: true, inventory: true, reports: true, parties: true, payments: true },
      can_view_reports: true,
      can_delete_bills: true,
      can_edit_rates: true,
      can_access_accounts: true,
      can_manage_users: false,
    },
    {
      role_name: 'Cashier',
      permissions_json: { sales: true, payments: true, parties: { view: true, add: true } },
      can_view_reports: false,
      can_delete_bills: false,
      can_edit_rates: false,
      can_access_accounts: false,
      can_manage_users: false,
    },
    {
      role_name: 'Inventory Staff',
      permissions_json: { purchase: true, inventory: true },
      can_view_reports: false,
      can_delete_bills: false,
      can_edit_rates: false,
      can_access_accounts: false,
      can_manage_users: false,
    },
    {
      role_name: 'Accountant',
      permissions_json: { reports: true, accounts: true, payments: true },
      can_view_reports: true,
      can_delete_bills: false,
      can_edit_rates: false,
      can_access_accounts: true,
      can_manage_users: false,
    },
  ];

  for (const role of roles) {
    await Role.findOrCreate({ where: { role_name: role.role_name }, defaults: role });
  }

  // ── Default Admin User ──
  const adminRole = await Role.findOne({ where: { role_name: 'Admin' } });
  const hashedPassword = await bcrypt.hash('admin123', 10);
  await User.findOrCreate({
    where: { username: 'admin' },
    defaults: {
      username: 'admin',
      password_hash: hashedPassword,
      full_name: 'System Administrator',
      email: 'admin@company.com',
      role_id: adminRole.role_id,
      is_active: true,
    },
  });

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
  await SystemSettings.findOrCreate({
    where: { setting_id: 1 },
    defaults: {
      company_name: 'My Company',
      financial_year_start: '2026-04-01',
      financial_year_end: '2027-03-31',
      gst_enabled: false,
      low_stock_alert_enabled: true,
      backup_frequency: 'Daily',
    },
  });

  // ── Default Ledger Accounts ──
  const defaultLedgers = [
    { ledger_name: 'Cash', ledger_group: 'Assets', sub_group: 'Cash-in-Hand', is_system_ledger: true },
    { ledger_name: 'Bank Account', ledger_group: 'Assets', sub_group: 'Bank Accounts', is_system_ledger: true },
    { ledger_name: 'Accounts Receivable', ledger_group: 'Assets', sub_group: 'Sundry Debtors', is_system_ledger: true },
    { ledger_name: 'Accounts Payable', ledger_group: 'Liabilities', sub_group: 'Sundry Creditors', is_system_ledger: true },
    { ledger_name: 'Sales Account', ledger_group: 'Income', sub_group: 'Direct Incomes', is_system_ledger: true },
    { ledger_name: 'Purchase Account', ledger_group: 'Expenses', sub_group: 'Direct Expenses', is_system_ledger: true },
    { ledger_name: 'Sales Return', ledger_group: 'Income', sub_group: 'Direct Incomes', is_system_ledger: true },
    { ledger_name: 'Purchase Return', ledger_group: 'Expenses', sub_group: 'Direct Expenses', is_system_ledger: true },
    { ledger_name: 'Discount Allowed', ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: true },
    { ledger_name: 'Discount Received', ledger_group: 'Income', sub_group: 'Indirect Incomes', is_system_ledger: true },
    { ledger_name: 'CGST Input', ledger_group: 'Assets', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'SGST Input', ledger_group: 'Assets', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'IGST Input', ledger_group: 'Assets', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'CGST Output', ledger_group: 'Liabilities', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'SGST Output', ledger_group: 'Liabilities', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'IGST Output', ledger_group: 'Liabilities', sub_group: 'Duties & Taxes', is_system_ledger: true },
    { ledger_name: 'Round Off', ledger_group: 'Expenses', sub_group: 'Indirect Expenses', is_system_ledger: true },
    { ledger_name: 'Stock-in-Hand', ledger_group: 'Assets', sub_group: 'Current Assets', is_system_ledger: true },
    { ledger_name: 'Capital Account', ledger_group: 'Capital', sub_group: 'Capital Account', is_system_ledger: true },
  ];

  for (const ledger of defaultLedgers) {
    await LedgerAccount.findOrCreate({ where: { ledger_name: ledger.ledger_name }, defaults: ledger });
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

  console.log('Default data seeded successfully');
}

module.exports = seedDefaultData;
