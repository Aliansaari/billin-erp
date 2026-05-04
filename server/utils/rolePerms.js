/*
 * Role permission matrix — single source of truth for what each seeded role
 * can do. Consumed by the seeder (on DB init) and by `hasPermission` at
 * request time.
 *
 * Permission shape:
 *   { all: true }                                 // super-admin shortcut
 *   { sales: true }                                // module-level grant
 *   { sales: { view: true, create: true } }        // per-action grant
 *
 * Path checks use dot notation: `hasPermission(user, 'sales.create')`
 * resolves left-to-right, short-circuiting on `true` at any level.
 *
 * Module set:
 *   sales / purchase / parties / inventory / payments:
 *     view, create, edit, delete
 *   sales_returns / purchase_returns:
 *     view, create, edit, delete           (own-module so a salesman can
 *                                          handle customer returns without
 *                                          gaining supplier-return access)
 *   reports:   view                         (read-only — sales, purchase,
 *                                           stock reports)
 *   accounts:  view                         (P&L, party ledger)
 *   settings:  view, manage_users, manage_company, backup, cleanup,
 *              import_export, tally, print, theme, barcode
 *
 * Delete is destructive (cancels bills, voids ledger entries). Reserved
 * for Admin + Super Admin. Manager can edit but not delete so a senior
 * sign-off is required to void anything.
 */

const ROLES = [
  {
    role_name: 'Super Admin',
    permissions_json: { all: true },
    // Legacy boolean columns kept in sync so older code paths that still read
    // `req.user.Role.can_view_reports` etc. don't break.
    can_view_reports: true,
    can_delete_bills: true,
    can_edit_rates:   true,
    can_access_accounts: true,
    can_manage_users: true,
  },
  {
    role_name: 'Admin',
    permissions_json: {
      sales:            { view: true, create: true, edit: true, delete: true },
      purchase:         { view: true, create: true, edit: true, delete: true },
      sales_returns:    { view: true, create: true, edit: true, delete: true },
      purchase_returns: { view: true, create: true, edit: true, delete: true },
      parties:          { view: true, create: true, edit: true, delete: true },
      inventory:        { view: true, create: true, edit: true, delete: true },
      payments:         { view: true, create: true, edit: true, delete: true },
      reports:          { view: true },
      accounts:         { view: true },
      settings:         { view: true, manage_company: true, import_export: true, tally: true, print: true, theme: true, barcode: true },
      godowns:          { view: true, manage: true },
      stock_transfers:  { view: true, create: true },
      // Batch tracking (Commit 5) — Admin gets full batch surface
      // (list/detail/expiry report) + the right to flip the global
      // toggle in Settings. batches.manage covers any future per-batch
      // adjustment voucher path.
      batches:          { view: true, manage: true },
      batch_tracking:   { settings: true },
      // NO manage_users / backup / cleanup — reserved for Super Admin.
    },
    can_view_reports: true, can_delete_bills: true, can_edit_rates: true,
    can_access_accounts: true, can_manage_users: false,
  },
  {
    role_name: 'Manager',
    permissions_json: {
      sales:            { view: true, create: true, edit: true },
      purchase:         { view: true, create: true, edit: true },
      sales_returns:    { view: true, create: true, edit: true },
      purchase_returns: { view: true, create: true, edit: true },
      parties:          { view: true, create: true, edit: true },
      inventory:        { view: true, create: true, edit: true },
      payments:         { view: true, create: true, edit: true },
      reports:          { view: true },
      accounts:         { view: true },
      settings:         { view: true, theme: true, print: true },
      godowns:          { view: true },
      stock_transfers:  { view: true, create: true },
      // Batches: read-only for Manager (matches the Operator/Manager
      // default in the Commit-5 spec). batch_tracking.settings stays
      // off — flipping the global toggle is an admin-only call.
      batches:          { view: true },
    },
    can_view_reports: true, can_delete_bills: false, can_edit_rates: true,
    can_access_accounts: true, can_manage_users: false,
  },
  {
    role_name: 'Accountant',
    permissions_json: {
      sales:            { view: true },
      purchase:         { view: true },
      sales_returns:    { view: true },
      purchase_returns: { view: true },
      parties:          { view: true },
      payments:         { view: true, create: true, edit: true },
      reports:          { view: true },
      accounts:         { view: true },
      settings:         { view: true, theme: true, print: true },
      godowns:          { view: true },
      stock_transfers:  { view: true },
      batches:          { view: true },
    },
    can_view_reports: true, can_delete_bills: false, can_edit_rates: false,
    can_access_accounts: true, can_manage_users: false,
  },
  {
    role_name: 'Salesman',
    permissions_json: {
      // The person behind the counter / on the floor. Creates sales bills
      // against customers, records receipts, sees the product catalog. No
      // visibility into purchase data or supplier returns.
      sales:         { view: true, create: true, edit: true },
      sales_returns: { view: true, create: true },
      parties:       { view: true, create: true, edit: true },
      inventory:     { view: true },
      payments:      { view: true, create: true },
      reports:       { view: true },
      settings:      { view: true, theme: true },
      batches:       { view: true },
    },
    can_view_reports: true, can_delete_bills: false, can_edit_rates: false,
    can_access_accounts: false, can_manage_users: false,
  },
  {
    role_name: 'Inventory Staff',
    permissions_json: {
      purchase:         { view: true, create: true, edit: true },
      purchase_returns: { view: true, create: true },
      parties:          { view: true, create: true },            // suppliers
      inventory:        { view: true, create: true, edit: true },
      reports:          { view: true },
      settings:         { view: true, theme: true },
      // Inventory Staff manages stock day-to-day, so they get manage
      // (per-batch adjustments) too — matches the godowns.manage grant.
      batches:          { view: true, manage: true },
    },
    can_view_reports: true, can_delete_bills: false, can_edit_rates: true,
    can_access_accounts: false, can_manage_users: false,
  },
  // Retained for backwards compatibility with existing databases that
  // already assigned users to 'Cashier'. Same perms as Salesman.
  {
    role_name: 'Cashier',
    permissions_json: {
      sales:         { view: true, create: true },
      sales_returns: { view: true, create: true },
      parties:       { view: true, create: true },
      payments:      { view: true, create: true },
      inventory:     { view: true },
      settings:      { view: true, theme: true },
    },
    can_view_reports: false, can_delete_bills: false, can_edit_rates: false,
    can_access_accounts: false, can_manage_users: false,
  },
];

module.exports = { ROLES };
