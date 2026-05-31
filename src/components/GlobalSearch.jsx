import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  SearchOutlined, ShoppingCartOutlined, InboxOutlined, UserOutlined, TeamOutlined,
  AppstoreOutlined, FileTextOutlined, BankOutlined, BookOutlined, BarChartOutlined,
  SettingOutlined, DollarCircleOutlined, RollbackOutlined, SafetyCertificateOutlined,
  FundOutlined, CreditCardOutlined, ProductOutlined, GoldOutlined, AuditOutlined,
  WalletOutlined, BgColorsOutlined, PushpinOutlined, PushpinFilled,
} from '@ant-design/icons';
import api from '../api';
import { useSystemSettings } from '../hooks/useSystemSettings';
import './globalSearch.css';

/* ──────────────────────────────────────────────────────────────────────────
 * Static action / page index — anything reachable inside the app that
 * doesn't need an API call. Order is roughly by frequency-of-use within
 * each group; first result of the typed query wins by default.
 *
 * Adding a new page? Add an entry here so it shows up in global search.
 * ────────────────────────────────────────────────────────────────────────── */
const ACTIONS = [
  // Create — the verbs operators reach for first.
  //
  // Sale / Purchase entries use the bare noun (not "New sales bill") so
  // typing "sale" / "purchase" hits the exact-match score (1000) and the
  // create entry beats the sibling list / report entries that share the
  // prefix. The sub-line carries the "what does clicking this do" context.
  // Keywords keep "bill", "invoice", "new", etc. discoverable for users
  // who reach for those words.
  { id: 'sale-new',     icon: ShoppingCartOutlined, label: 'Sale',     sub: 'New customer invoice', group: 'Create',   route: '/sale/new',     kbd: 'Alt+S', keywords: 'sales invoice bill new tax gst' },
  { id: 'purchase-new', icon: InboxOutlined,        label: 'Purchase', sub: 'New supplier bill',    group: 'Create',   route: '/purchase/new', kbd: 'Alt+P', keywords: 'purchase bill new supplier inward' },
  { id: 'receipt-new',  icon: DollarCircleOutlined, label: 'Record receipt',            sub: 'Money in from customer',    group: 'Create',   route: '/receipt/new',  kbd: 'F6',    keywords: 'receipt money in customer payment in' },
  { id: 'payment-new',  icon: CreditCardOutlined,   label: 'Record payment',            sub: 'Money out to supplier',     group: 'Create',   route: '/payment/new',  kbd: 'F7',    keywords: 'payment money out supplier' },
  { id: 'sret-new',     icon: RollbackOutlined,     label: 'Sales return / credit note', sub: 'Reverse a customer bill',  group: 'Create',   route: '/sales-return/new',                 keywords: 'credit note sales return' },
  { id: 'pret-new',     icon: RollbackOutlined,     label: 'Purchase return / debit note', sub: 'Reverse a supplier bill', group: 'Create',  route: '/purchase-return/new',              keywords: 'debit note purchase return' },
  { id: 'jv-new',       icon: AuditOutlined,        label: 'New journal voucher',       sub: 'Manual accounting entry',   group: 'Create',   route: '/accounts/journal/new', keywords: 'journal voucher entry contra' },
  { id: 'expense-new',  icon: WalletOutlined,       label: 'Record expense',            sub: 'Indirect / direct expense',  group: 'Create',   route: '/expenses/new', keywords: 'expense booking rent salary office indirect direct fuel petrol' },
  { id: 'transfer-new', icon: GoldOutlined,         label: 'New stock transfer',        sub: 'Move stock between godowns', group: 'Create',  route: '/stock-transfer/new', keywords: 'stock transfer godown move', flag: 'multi_warehouse_enabled' },

  // Browse
  { id: 'home',         icon: AppstoreOutlined,     label: 'Home',                      sub: 'Command center',             group: 'Browse',   route: '/',             kbd: 'Alt+H', keywords: 'home command center landing search' },
  { id: 'dashboard',    icon: BarChartOutlined,     label: 'Dashboard',                 sub: 'Every metric · 9-up tiles',  group: 'Browse',   route: '/dashboard',    kbd: 'Alt+D', keywords: 'dashboard metrics tiles overview' },
  { id: 'customers',    icon: TeamOutlined,         label: 'Customers',                 sub: 'Party master',               group: 'Browse',   route: '/customers',    kbd: 'Alt+C', keywords: 'customer party' },
  { id: 'suppliers',    icon: TeamOutlined,         label: 'Suppliers',                 sub: 'Vendor master',              group: 'Browse',   route: '/suppliers',                  keywords: 'supplier vendor party' },
  { id: 'products',     icon: ProductOutlined,      label: 'Products / Inventory',      sub: 'Item master',                group: 'Browse',   route: '/products',     kbd: 'Alt+I', keywords: 'product item sku inventory master' },
  { id: 'categories',   icon: AppstoreOutlined,     label: 'Product categories',        sub: 'Brand / category tree',      group: 'Browse',   route: '/categories',                 keywords: 'category brand group' },
  { id: 'sales-list',   icon: FileTextOutlined,     label: 'Sales bills',               sub: 'All sales invoices',         group: 'Browse',   route: '/sales',                      keywords: 'sales list bills invoices' },
  { id: 'purc-list',    icon: FileTextOutlined,     label: 'Purchase bills',            sub: 'All purchase invoices',      group: 'Browse',   route: '/purchases',                  keywords: 'purchase list bills' },
  { id: 'sret-list',    icon: RollbackOutlined,     label: 'Sales returns',             sub: 'Credit notes',               group: 'Browse',   route: '/sales-returns',              keywords: 'sales return credit note list' },
  { id: 'pret-list',    icon: RollbackOutlined,     label: 'Purchase returns',          sub: 'Debit notes',                group: 'Browse',   route: '/purchase-returns',           keywords: 'purchase return debit note list' },
  { id: 'pay-list',     icon: DollarCircleOutlined, label: 'Payments & receipts',       sub: 'All money movements',        group: 'Browse',   route: '/payments',     kbd: 'Alt+M', keywords: 'payments receipts list ledger' },
  { id: 'expenses',     icon: WalletOutlined,       label: 'Expenses',                  sub: 'All expense entries',        group: 'Browse',   route: '/expenses',                   keywords: 'expense list register' },
  { id: 'stock-report', icon: AppstoreOutlined,     label: 'Stock report',              sub: 'On-hand by godown',          group: 'Browse',   route: '/stock-report',               keywords: 'stock report on hand inventory godown' },
  { id: 'stock-pro',    icon: AppstoreOutlined,     label: 'Stock report — categories', sub: 'Category-wise drilldown',    group: 'Browse',   route: '/stock-report-pro',           keywords: 'stock category report' },
  { id: 'stock-move',   icon: AppstoreOutlined,     label: 'Stock movement',            sub: 'Per-product inward / outward', group: 'Browse',   route: '/stock-movement',             keywords: 'stock movement inward outward history transactions ledger product' },
  { id: 'transfers',    icon: GoldOutlined,         label: 'Stock transfers',           sub: 'Inter-godown movement',      group: 'Browse',   route: '/stock-transfers',            keywords: 'stock transfer godown', flag: 'multi_warehouse_enabled' },
  { id: 'batches',      icon: AppstoreOutlined,     label: 'Batches',                   sub: 'Batch / expiry tracking',    group: 'Browse',   route: '/inventory/batches',          keywords: 'batch expiry mfg manufacturing lot' },
  { id: 'jv-list',      icon: AuditOutlined,        label: 'Journal vouchers',          sub: 'Manual entries',             group: 'Browse',   route: '/accounts/journal',           keywords: 'journal voucher manual entry' },

  // Reports
  { id: 'reports',      icon: BarChartOutlined,     label: 'Reports hub',               sub: 'All reports — searchable',   group: 'Reports',  route: '/reports',      kbd: 'Alt+R', keywords: 'reports hub all' },
  { id: 'r-sales',      icon: BarChartOutlined,     label: 'Sales report',              sub: 'Bill-level sales',           group: 'Reports',  route: '/reports/sales',              keywords: 'sales report' },
  { id: 'r-salesman',   icon: TeamOutlined,         label: 'Sales by Salesman',         sub: 'Per-salesman sales & commission', group: 'Reports', route: '/reports/sales-by-salesman',  keywords: 'salesman salesperson sales staff commission performance attribution by salesman' },
  { id: 'r-purc',       icon: BarChartOutlined,     label: 'Purchase report',           sub: 'Bill-level purchases',       group: 'Reports',  route: '/reports/purchases',          keywords: 'purchase report' },
  { id: 'r-day',        icon: BookOutlined,         label: 'Day book',                  sub: 'All vouchers by day',        group: 'Reports',  route: '/reports/day-book',           keywords: 'day book daybook journal' },
  { id: 'r-ledger',     icon: BookOutlined,         label: 'Ledger statement',          sub: 'COA ledger — pick to drill', group: 'Reports',  route: '/reports/ledger',             keywords: 'ledger statement coa chart account' },
  { id: 'r-tb',         icon: BookOutlined,         label: 'Trial balance',             sub: 'Period-end closing',        group: 'Reports',  route: '/reports/trial-balance',      keywords: 'trial balance tb' },
  { id: 'r-bs',         icon: BookOutlined,         label: 'Balance sheet',             sub: 'Assets & liabilities',       group: 'Reports',  route: '/reports/balance-sheet',      keywords: 'balance sheet bs assets liabilities' },
  { id: 'r-pl',         icon: BookOutlined,         label: 'Profit & Loss',             sub: 'P&L statement',              group: 'Reports',  route: '/reports/profit-loss',        keywords: 'profit loss pl income statement' },
  { id: 'r-cf',         icon: FundOutlined,         label: 'Cash flow',                 sub: 'Inflows & outflows',         group: 'Reports',  route: '/reports/cash-flow',          keywords: 'cash flow' },
  { id: 'r-ff',         icon: FundOutlined,         label: 'Fund flow',                 sub: 'Working-capital movement',   group: 'Reports',  route: '/reports/fund-flow',          keywords: 'fund flow' },
  { id: 'r-aging-r',    icon: BarChartOutlined,     label: 'Receivables aging',         sub: 'Customer outstanding by age', group: 'Reports', route: '/reports/receivables-aging',  keywords: 'aging receivables outstanding customer' },
  { id: 'r-aging-p',    icon: BarChartOutlined,     label: 'Payables aging',            sub: 'Supplier outstanding by age', group: 'Reports', route: '/reports/payables-aging',     keywords: 'aging payables outstanding supplier' },
  { id: 'r-cust-out',   icon: BarChartOutlined,     label: 'Customer outstanding',      sub: 'Bill-level receivables',     group: 'Reports',  route: '/reports/customer-outstanding', keywords: 'customer outstanding receivables' },
  { id: 'r-supp-out',   icon: BarChartOutlined,     label: 'Supplier outstanding',      sub: 'Bill-level payables',        group: 'Reports',  route: '/reports/supplier-outstanding', keywords: 'supplier outstanding payables' },
  { id: 'r-bills-r',    icon: FileTextOutlined,     label: 'Bills receivable',          sub: 'Open invoices in',           group: 'Reports',  route: '/reports/bills-receivable',   keywords: 'bills receivable open invoices' },
  { id: 'r-bills-p',    icon: FileTextOutlined,     label: 'Bills payable',             sub: 'Open invoices out',          group: 'Reports',  route: '/reports/bills-payable',      keywords: 'bills payable open invoices' },
  { id: 'r-gstr1',      icon: BookOutlined,         label: 'GSTR-1',                    sub: 'Outward supplies return',    group: 'Reports',  route: '/reports/gstr1',              keywords: 'gst gstr1 outward return' },
  { id: 'r-gstr3b',     icon: BookOutlined,         label: 'GSTR-3B',                   sub: 'Monthly summary return',     group: 'Reports',  route: '/reports/gstr3b',             keywords: 'gst gstr3b summary' },
  { id: 'r-hsn',        icon: BookOutlined,         label: 'HSN summary',               sub: 'HSN-wise tax breakup',       group: 'Reports',  route: '/reports/hsn-summary',        keywords: 'hsn tax breakup' },
  { id: 'r-monthly-s',  icon: BarChartOutlined,     label: 'Monthly sales register',    sub: 'Sales by month',             group: 'Reports',  route: '/reports/monthly-sales',      keywords: 'monthly sales register' },
  { id: 'r-monthly-p',  icon: BarChartOutlined,     label: 'Monthly purchase register', sub: 'Purchases by month',         group: 'Reports',  route: '/reports/monthly-purchases',  keywords: 'monthly purchase register' },
  { id: 'r-prod-sales', icon: BarChartOutlined,     label: 'Product sales report',      sub: 'Item-level sales',           group: 'Reports',  route: '/reports/product-sales',      keywords: 'product item sales report' },
  { id: 'r-prod-purc',  icon: BarChartOutlined,     label: 'Product purchase report',   sub: 'Item-level purchases',       group: 'Reports',  route: '/reports/product-purchases',  keywords: 'product item purchase report' },
  { id: 'r-cust-stmt',  icon: BookOutlined,         label: 'Customer statement',        sub: 'Bill-level customer ledger', group: 'Reports',  route: '/reports/customer-statement', keywords: 'customer statement ledger party bill account' },
  { id: 'r-supp-stmt',  icon: BookOutlined,         label: 'Supplier statement',        sub: 'Bill-level supplier ledger', group: 'Reports',  route: '/reports/supplier-statement', keywords: 'supplier statement ledger party bill account vendor' },
  { id: 'r-monthly-rec', icon: BarChartOutlined,    label: 'Monthly receipt register',  sub: 'Receipts by month',          group: 'Reports',  route: '/reports/monthly-receipts',   keywords: 'monthly receipt register money in' },
  { id: 'r-monthly-pay', icon: BarChartOutlined,    label: 'Monthly payment register',  sub: 'Payments by month',          group: 'Reports',  route: '/reports/monthly-payments',   keywords: 'monthly payment register money out' },
  { id: 'r-exp',        icon: WalletOutlined,       label: 'Expense report',            sub: 'Category-wise expenses',     group: 'Reports',  route: '/expenses/report',            keywords: 'expense report category indirect direct' },
  { id: 'r-stock-color', icon: BgColorsOutlined,    label: 'Stock by color',            sub: 'Colour-wise stock breakup',  group: 'Reports',  route: '/reports/stock-by-color',     keywords: 'stock color colour variant breakup product' },
  { id: 'r-transfer-reg', icon: GoldOutlined,       label: 'Godown transfer register',  sub: 'All inter-godown movements', group: 'Reports',  route: '/reports/transfer-register',  keywords: 'godown transfer register movement', flag: 'multi_warehouse_enabled' },
  { id: 'r-godown-val', icon: GoldOutlined,         label: 'Godown valuation',          sub: 'Stock value by godown',      group: 'Reports',  route: '/reports/godown-valuation',   keywords: 'godown valuation warehouse stock value', flag: 'multi_warehouse_enabled' },
  { id: 'r-fast',       icon: BarChartOutlined,     label: 'Fast / slow stock',         sub: 'Movers vs sleepers',         group: 'Reports',  route: '/reports/fast-slow-stock',    keywords: 'fast slow movers sleepers stock' },
  { id: 'r-expiry',     icon: AppstoreOutlined,     label: 'Expiry report',             sub: 'Batches near expiry',        group: 'Reports',  route: '/reports/expiry',             keywords: 'expiry batch near' },

  // Banks & loans
  { id: 'banks',        icon: BankOutlined,         label: 'Banks',                     sub: 'All bank accounts',          group: 'Banks',    route: '/banks',                      keywords: 'bank accounts' },
  { id: 'bank-recon',   icon: BankOutlined,         label: 'Bank reconciliation',       sub: 'Match statement to ledger',  group: 'Banks',    route: '/banks/reconciliation',       keywords: 'bank reconciliation match statement' },
  { id: 'cheques',      icon: BankOutlined,         label: 'Cheque register',           sub: 'Issued / received cheques',  group: 'Banks',    route: '/banks/cheques',              keywords: 'cheque check register pdc postdated bounce clear' },
  { id: 'loans',        icon: BankOutlined,         label: 'Loans',                     sub: 'All loan ledgers',           group: 'Banks',    route: '/loans',                      keywords: 'loan emi' },
  { id: 'loan-sched',   icon: BankOutlined,         label: 'Loan schedule',             sub: 'Upcoming EMIs',              group: 'Banks',    route: '/loans/schedule',             keywords: 'loan schedule emi upcoming' },

  // Settings
  { id: 's-home',       icon: SettingOutlined,      label: 'Home page',                 sub: 'Settings → Home',            group: 'Settings', route: '/settings/home',              keywords: 'home page settings landing layout customize hide show kpi clock action ribbon greeting' },
  { id: 's-dashboard',  icon: SettingOutlined,      label: 'Dashboard tiles',           sub: 'Settings → Dashboard',       group: 'Settings', route: '/settings/dashboard',         keywords: 'dashboard tile customize add remove pin metric' },
  { id: 's-company',    icon: SettingOutlined,      label: 'Company profile',           sub: 'Settings → Company',         group: 'Settings', route: '/settings/company',           keywords: 'company profile gstin pan address settings' },
  { id: 's-fy',         icon: SettingOutlined,      label: 'Financial year',            sub: 'Settings → Financial Year',  group: 'Settings', route: '/settings/financial-year',    keywords: 'financial year fy books period lock closing accounting compliance' },
  { id: 's-account',    icon: UserOutlined,         label: 'My account',                sub: 'My profile, password, email', group: 'Settings', route: '/settings/account',           keywords: 'my account profile password email name signature' },
  { id: 's-notifs',     icon: SettingOutlined,      label: 'Notifications',             sub: 'Settings → Notifications',   group: 'Settings', route: '/settings/notifications',     keywords: 'notifications alerts reminders bell preferences low stock' },
  { id: 's-users',      icon: SettingOutlined,      label: 'Users & roles',             sub: 'Settings → Users',           group: 'Settings', route: '/settings/users',             keywords: 'users roles permission settings' },
  { id: 's-companies',  icon: SettingOutlined,      label: 'Manage companies',          sub: 'Switch · create · archive',  group: 'Settings', route: '/settings/companies',         kbd: 'Ctrl+Alt+C', keywords: 'companies switch create archive add manage firm books' },
  { id: 's-godowns',    icon: SettingOutlined,      label: 'Godowns',                   sub: 'Settings → Godowns',         group: 'Settings', route: '/settings/godowns',           keywords: 'godown warehouse location', flag: 'multi_warehouse_enabled' },
  { id: 's-salesmen',   icon: TeamOutlined,         label: 'Salesmen',                  sub: 'Settings → Salesmen',        group: 'Settings', route: '/settings/salesmen',          keywords: 'salesman salesmen salesperson sales staff commission master add edit remove' },
  { id: 's-theme',      icon: SettingOutlined,      label: 'Theme',                     sub: 'Settings → Theme',           group: 'Settings', route: '/settings/theme',             keywords: 'theme dark light appearance' },
  { id: 's-modules',    icon: SettingOutlined,      label: 'Module settings',           sub: 'Toggle features on / off',   group: 'Settings', route: '/settings/modules',           keywords: 'module feature toggle settings' },
  { id: 's-defaults',   icon: SettingOutlined,      label: 'Defaults',                  sub: 'Defaults for new bills',     group: 'Settings', route: '/settings/defaults',          keywords: 'defaults default values new bill party tax round' },
  { id: 's-import',     icon: SettingOutlined,      label: 'Import / export',           sub: 'Bulk data in / out',         group: 'Settings', route: '/settings/import-export',     keywords: 'import export bulk csv excel' },
  { id: 's-backup',     icon: SettingOutlined,      label: 'Backup & restore',          sub: 'Database snapshots',         group: 'Settings', route: '/settings/backup',            keywords: 'backup restore snapshot db' },
  { id: 's-tally',      icon: SettingOutlined,      label: 'Tally sync',                sub: 'Push to Tally',              group: 'Settings', route: '/settings/tally',             keywords: 'tally sync export' },
  { id: 's-print',      icon: SettingOutlined,      label: 'Print settings',            sub: 'Invoice templates',          group: 'Settings', route: '/settings/print',             keywords: 'print template invoice paper' },
  { id: 's-barcode',    icon: SettingOutlined,      label: 'Barcode settings',          sub: 'Label · print layout',       group: 'Settings', route: '/settings/barcode',           keywords: 'barcode label print sku scanner' },
  { id: 's-license',    icon: SafetyCertificateOutlined, label: 'License',              sub: 'Activation · seats · expiry', group: 'Settings', route: '/settings/license',          keywords: 'license activation expiry seat key serial' },
  { id: 'integrity',    icon: SafetyCertificateOutlined, label: 'Ledger integrity',     sub: 'Reconcile double-entry',     group: 'Settings', route: '/accounts/integrity',         keywords: 'ledger integrity check reconcile audit' },
];

/* ──────────────────────────────────────────────────────────────────────────
 * Fuzzy helpers (#2)
 *
 * Three complementary fallbacks layered ABOVE the original substring tier
 * so they only fire when the strict match path comes up empty:
 *
 *   1. Initials — first letter of each word. "pl" → "Profit & Loss",
 *      "tb" → "Trial Balance", "bs" → "Balance Sheet". This is the single
 *      highest-value addition because accountants type these constantly.
 *
 *   2. Subsequence — letters of the query appear in order in the label,
 *      gaps allowed. "blsht" → "Balance Sheet", "ledgr" → "Ledger
 *      statement". Catches dropped vowels and shorthand without us having
 *      to maintain a keyword list for every page.
 *
 *   3. Typo — single-edit Damerau-Levenshtein on labels. "lossas" →
 *      "Losses", "purcase" → "Purchase". Bounded to small distance so
 *      "sale" doesn't fuzzy-match "scale" by accident.
 *
 * Each tier returns a fixed score that slots between the strict tiers
 * (see scoreAction below for the layout). The numbers are tuned so:
 *   - exact / prefix matches always beat fuzzy
 *   - initials-exact beats word-prefix (so "pl" hits P&L, not Payments)
 *   - subsequence beats substring-in-keywords (catches "blsht")
 *   - typo is the lowest-confidence path; only fires when nothing else does
 * ────────────────────────────────────────────────────────────────────────── */
function labelInitials(label) {
  // Strip punctuation, split on whitespace / dashes / ampersands, take the
  // first letter of each remaining word. Caches well per ACTIONS entry but
  // we recompute cheaply each call — the array is < 100 items.
  return String(label || '')
    .replace(/[^a-zA-Z0-9 &-]/g, ' ')
    .split(/[\s\-&]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toLowerCase();
}
function isSubsequence(q, hay) {
  // True if every char of q appears in hay in the same order, allowing
  // arbitrary gaps. q assumed lowercase; hay lowercased here.
  if (!q) return false;
  const H = hay.toLowerCase();
  let i = 0;
  for (let j = 0; j < H.length && i < q.length; j++) {
    if (H[j] === q[i]) i++;
  }
  return i === q.length;
}
function editDistance(a, b, max) {
  // Damerau-Levenshtein with early exit. Only used for short labels and
  // short queries, so the O(a·b) cost is bounded. `max` lets us bail when
  // we've blown past the threshold rather than computing the full grid.
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  if (m === 0) return n;
  if (n === 0) return m;
  // Two-row DP — we only need the previous row.
  let prev = new Array(n + 1);
  let cur  = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + cost,
      );
      // Transposition (Damerau) — swap of adjacent chars counts as 1.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev[j - 2] + cost);
      }
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;        // early-exit: can't possibly recover
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/* Match score for an action against a query.
 * Higher = better match. Returns null if no match.
 *
 * Scoring layout (high → low):
 *   1000  exact label match
 *    800  label starts-with
 *    700  initials exact     (eg. "pl" → "Profit & Loss")
 *    500  word-boundary starts-with anywhere in label/keywords/sub
 *    400  initials starts-with OR subsequence (eg. "blsht" → "Balance Sheet")
 *    300  substring in label
 *    200  substring in keywords
 *    150  typo within edit distance 1-2 (eg. "purcase" → "Purchase")
 *    100  substring in sub
 *
 * That ordering makes "sale" hit "Sales bills" before "Wholesale return",
 * "pl" hit "Profit & Loss" before "Payments list", and "blsht" hit "Balance
 * Sheet" at all. */
function scoreAction(a, q) {
  if (!q) return null;
  const Q = q.toLowerCase().trim();
  if (!Q) return null;
  const L = a.label.toLowerCase();
  const K = (a.keywords || '').toLowerCase();
  const S = (a.sub || '').toLowerCase();

  if (L === Q) return 1000;
  if (L.startsWith(Q)) return 800;

  // Initials. Cheap to compute, very high signal.
  const init = labelInitials(a.label);
  if (init && Q.length >= 2 && Q.length <= 6) {
    if (init === Q) return 700;
  }

  // Word-boundary prefix anywhere in label / keywords / sub.
  const words = (L + ' ' + K + ' ' + S).split(/[\s\-/]+/);
  if (words.some(w => w.startsWith(Q))) return 500;

  // Initials starts-with — eg. typing "p" with "pl" expected later.
  if (init && Q.length >= 2 && init.startsWith(Q)) return 420;

  // Subsequence in label — handles dropped-vowel shorthand.
  if (Q.length >= 3 && isSubsequence(Q, L)) return 400;

  if (L.includes(Q)) return 300;
  if (K.includes(Q)) return 200;

  // Typo tolerance — only worthwhile for queries long enough that an
  // edit-distance match isn't noise. Single-char or two-char typos
  // are too permissive and would match almost anything.
  if (Q.length >= 4) {
    // Allow 1 edit for 4-6 chars, 2 edits for 7+ chars. Stays conservative.
    const maxD = Q.length >= 7 ? 2 : 1;
    // Check each label word too, not just the whole label, so "purcase"
    // matches "Purchase report" (word match) without us blowing the
    // distance against the full multi-word label.
    const labelWords = L.split(/[\s\-/]+/).filter(Boolean);
    for (const w of labelWords) {
      if (editDistance(Q, w, maxD) <= maxD) return 150;
    }
  }

  if (S.includes(Q)) return 100;
  return null;
}

/* Group results by section for the dropdown.
 *
 * Group ORDER is by the highest-scoring item the group contains, so the
 * most-relevant section bubbles to the top. Without this, a fixed group
 * order (Create → Browse → Reports → …) buries higher-scoring matches:
 * typing "report" used to put `Stock report` (Browse, 500) above
 * `Reports hub` (Reports, 800) just because Browse always rendered first.
 *
 * Tie-break by the conventional fixed order so equal-relevance queries
 * (e.g. an empty query that surfaces every group at score 1000) still
 * feel predictable. */
function groupResults(results) {
  const groups = {};
  for (const r of results) {
    if (!groups[r.group]) groups[r.group] = [];
    groups[r.group].push(r);
  }
  const tieBreak = ['Vouchers', 'Create', 'Customers', 'Suppliers', 'Ledgers', 'Products', 'Browse', 'Reports', 'Banks', 'Settings'];
  const tieIdx   = (g) => { const i = tieBreak.indexOf(g); return i === -1 ? 99 : i; };
  /* Parties / products don't have a computed score — they're API hits we
   * already trust as relevant — so default them to 1000. Actions carry
   * their scoreAction() result on _score (set in the matches mapper). */
  const maxScore = (items) => Math.max(...items.map((x) => x._score ?? 1000));
  return Object.keys(groups)
    .sort((a, b) => {
      const sa = maxScore(groups[a]);
      const sb = maxScore(groups[b]);
      if (sa !== sb) return sb - sa;
      return tieIdx(a) - tieIdx(b);
    })
    .map((g) => ({ name: g, items: groups[g] }));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Voucher-jump heuristic (#5)
 *
 * Operators often arrive at search knowing a specific voucher number — a
 * customer asks about INV-2024-001, an auditor about Receipt-Q3-15. The
 * default search hits parties / products / ledgers; without a voucher
 * branch the only path is opening the relevant list page and re-typing.
 *
 * Heuristic: voucher-shaped queries are
 *   - those starting with "#" (explicit signal, strip the # and search)
 *   - those containing 3+ digits AND being shorter than 40 chars
 *   - those matching a typical pattern: [A-Z]+ optional separator + digits
 *     (eg. "INV-001", "S/2024/01", "RCT12")
 *
 * Strict heuristic on purpose — we don't want to triple every keystroke's
 * API calls. When matched, parallel-hit /sales + /purchases + /payments
 * with the query as `search`. Results show in a new "Vouchers" group that
 * sorts to the very top (vouchers were what the operator asked for).
 *
 * Why client-side regex (not a server `is-voucher-looking` endpoint):
 * the cost of three extra paginated queries when triggered is ~150ms;
 * the cost of a server round trip just to decide whether to trigger
 * would be ~80ms. We save more by pre-filtering than a server gate ever
 * could.
 * ────────────────────────────────────────────────────────────────────────── */
function looksLikeVoucher(q) {
  if (!q) return false;
  const s = String(q).trim();
  if (s.length === 0 || s.length > 40) return false;
  // Explicit "#" trigger — strip and force-search.
  if (s.startsWith('#')) return s.length >= 2;
  // Has 3+ contiguous digits and no spaces (voucher numbers rarely have
  // spaces; "anil 98765" is a phone-tagged party name, not a voucher).
  if (/\s/.test(s)) return false;
  if (/\d{3,}/.test(s)) return true;
  // Pattern: letters+separator+digits (eg. "S-001", "INV/01", "PAY12")
  if (/^[A-Za-z]{1,5}[-/_]?\d{1,}$/.test(s)) return true;
  return false;
}
function stripVoucherPrefix(q) {
  const s = String(q || '').trim();
  return s.startsWith('#') ? s.slice(1) : s;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Scope prefixes — narrow the palette to one kind of result.
 *
 * Slash form (the one shown in the footer, the one users actually type):
 *   /c apex   → customer scope, query "apex"
 *   /s tata   → supplier scope
 *   /p hp     → product scope
 *   /l bank   → ledger scope
 *   /r gst    → report scope
 *   /a sale   → actions / command scope
 *
 * "/" is universal command-mode in Slack, Discord, Notion, GitHub — two
 * keystrokes total, no shift required, no muscle-memory clash with names.
 * Replaced the previous "letter:" form (c:apex), which needed three
 * keystrokes — operator presses `c`, holds shift, hits `;` — and read as
 * fussy in the footer. The colon form is intentionally NOT a back-compat
 * fallback; one syntax is easier to teach than two.
 *
 * Why a sentinel character is needed at all: a real query like
 * "c hand drill" would otherwise vanish under a customer-scope filter the
 * operator never asked for. The leading "/" makes intent unambiguous.
 *
 * Scope maps to which API calls fire AND which result groups render. An
 * "actions" scope skips parties/products/ledgers fetches entirely, so the
 * palette is faster (no network) and the list isn't noisy with unrelated
 * COA hits when the operator is hunting a specific page like Settings →
 * Print.
 * ────────────────────────────────────────────────────────────────────────── */
const SCOPE_LETTER = {
  c: 'customers', s: 'suppliers', p: 'products',
  l: 'ledgers',   r: 'reports',   a: 'actions',
};
const SCOPE_LABEL = {
  customers: 'Customers',
  suppliers: 'Suppliers',
  products:  'Products',
  ledgers:   'Ledgers',
  reports:   'Reports',
  actions:   'Actions',
};
function parseScope(raw) {
  const q = String(raw || '');
  // Slash form: "/c", "/c apex". Requires end-of-string or whitespace
  // after the letter so "/capex" stays a literal search, not a customer-
  // scope query for "apex".
  const m = q.match(/^\/([a-zA-Z])(?:\s+(.*))?$/);
  if (m) {
    const scope = SCOPE_LETTER[m[1].toLowerCase()];
    if (scope) return { scope, query: (m[2] || '').trim() };
  }
  return { scope: null, query: q };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Telemetry (#13) — ring buffer of search-palette events.
 *
 * What's in scope: queries that produced at least one search session, the
 * pick (or abandon) that ended the session, and the picked row's identity
 * (id + kind + group). What's out of scope: keystroke-by-keystroke logs,
 * any party/product data, full row contents. The buffer answers two
 * questions:
 *
 *   1. "What did operators search for and never click?"  →  ABANDON events
 *      with query strings reveal what's missing from the catalog. Top-of-
 *      list misses get prioritised in the next ACTIONS expansion pass.
 *   2. "What's actually being clicked the most?"         →  CLICK events
 *      drive the learned-ranking frequency map (#1) and inform which
 *      static actions earn keyboard shortcuts.
 *
 * Stored in localStorage so a reload survives the buffer; capped at
 * TELEMETRY_MAX entries (LRU eviction) so the firm's machine doesn't
 * accumulate megabytes of search history. Exposed on the window for
 * console inspection — there's no admin UI yet, but `__gsTelemetry()`
 * dumps the recent slice for ad-hoc analysis.
 *
 * Privacy note: stays on-device. No network call. If we later want to
 * aggregate per-firm, do it explicitly via an opt-in admin page that
 * uploads the buffer; never silently.
 * ────────────────────────────────────────────────────────────────────────── */
const TELEMETRY_KEY = 'gs_telemetry_v1';
const TELEMETRY_MAX = 200;
function telemetryRead() {
  try {
    const raw = localStorage.getItem(TELEMETRY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function telemetryPush(event) {
  try {
    const list = telemetryRead();
    list.push({ ts: Date.now(), ...event });
    // Drop the oldest when over the cap. The buffer is intentionally a
    // sliding window — we only need recent signal, not all-time history.
    while (list.length > TELEMETRY_MAX) list.shift();
    localStorage.setItem(TELEMETRY_KEY, JSON.stringify(list));
  } catch { /* swallow — Safari private mode etc. */ }
}
// Dev surface — typing `__gsTelemetry()` in the console returns the
// recent events. Wrapped in a window guard so SSR / non-browser builds
// don't choke on the assignment.
if (typeof window !== 'undefined') {
  window.__gsTelemetry = (limit = 50) => telemetryRead().slice(-limit);
  window.__gsTelemetryClear = () => { try { localStorage.removeItem(TELEMETRY_KEY); } catch {} };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Learned ranking (#1) — frequency map derived from telemetry clicks.
 *
 * Daily-driver pages (Create Sale, Day book, the operator's three favourite
 * reports) should land at the top of relevant searches before ever earning
 * an exact match. We aggregate click events from the telemetry ring buffer
 * into a per-item count, then add a small log-scaled boost to the row's
 * _score. The cap keeps the most-clicked item from drowning out fresh
 * matches: the 10th click is worth ~40 points, the 100th is worth ~80,
 * so a row never overtakes a strict label-match (1000) on frequency alone.
 *
 * Why telemetry-derived (not a separate counter): single source of truth.
 * If the operator clears `__gsTelemetryClear()` they expect a fresh
 * personalisation slate too — and they get one, because frequency is
 * derived not stored.
 * ────────────────────────────────────────────────────────────────────────── */
function deriveFreqMap() {
  const events = telemetryRead();
  const map = Object.create(null);
  for (const e of events) {
    if (e.kind === 'click' && e.pickedId) {
      map[e.pickedId] = (map[e.pickedId] || 0) + 1;
    }
  }
  return map;
}
function freqBoost(map, id) {
  const n = map[id] || 0;
  if (n <= 0) return 0;
  // log10 scaled: 1→6, 5→16, 10→21, 50→34, 100→40. Cap at 80 so the
  // boost can never beat a strict label-match tier (1000) — frequent
  // matches climb to the top of their relevance band, not past it.
  return Math.min(80, Math.round(20 * Math.log10(n + 1)));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Context boost (#11) — weigh results by where the operator currently is.
 *
 * Search relevance is heavily location-dependent in an ERP. From a Sales
 * Bill form, typing "ank" almost certainly means "Ankit (customer)" — not
 * "Ankit Pvt Ltd (supplier)" and definitely not a Settings page named
 * "Anchor". The same query from the Purchase list flips the priority to
 * suppliers. From any /reports route, report actions deserve a leg up.
 *
 * Implementation: detect a coarse "module" from pathname (the prefix
 * tells us most of what we need), then add a small score boost to items
 * whose kind/group matches the module. Boosts are intentionally smaller
 * than the strict-match tier deltas so an exact name match always beats
 * a context-only hit.
 *
 * Why not server-side? Because the operator's current screen is a
 * client-side fact; piping it through every search request would mean
 * extending the API, the cache key, and the prod backend. The boost is
 * additive on already-fetched data — cheap, local, no extra round trip.
 * ────────────────────────────────────────────────────────────────────────── */
function detectContext(pathname) {
  const p = String(pathname || '');
  if (/^\/sale/.test(p))                              return 'sales';
  if (/^\/sales-return/.test(p))                      return 'sales';
  if (/^\/purchase-return/.test(p))                   return 'purchase';
  if (/^\/purchase/.test(p))                          return 'purchase';
  if (/^\/receipt/.test(p))                           return 'receipts';
  if (/^\/payment/.test(p))                           return 'payments';
  if (/^\/expenses/.test(p))                          return 'expenses';
  if (/^\/reports/.test(p))                           return 'reports';
  if (/^\/products|^\/stock|^\/inventory|^\/categories|^\/batches/.test(p)) return 'inventory';
  if (/^\/customers|^\/suppliers|^\/parties/.test(p)) return 'parties';
  if (/^\/banks|^\/loans/.test(p))                    return 'banks';
  if (/^\/accounts/.test(p))                          return 'accounts';
  if (/^\/settings/.test(p))                          return 'settings';
  return null;
}
const CTX_BOOST = {
  // Direct kind boosts — applies regardless of the action group.
  sales:     { partyType: 'Customer',         actionGroups: ['Create'],            kinds: { party: 60 } },
  receipts:  { partyType: 'Customer',         actionGroups: ['Create'],            kinds: { party: 60 } },
  purchase:  { partyType: 'Supplier',         actionGroups: ['Create'],            kinds: { party: 60 } },
  payments:  { partyType: 'Supplier',         actionGroups: ['Create'],            kinds: { party: 60 } },
  expenses:  {                                actionGroups: ['Create'],            kinds: { ledger: 40 } },
  reports:   {                                actionGroups: ['Reports'],           kinds: { action: 40 } },
  inventory: {                                actionGroups: ['Browse', 'Reports'], kinds: { product: 40 } },
  parties:   {                                actionGroups: ['Browse'],            kinds: { party: 30 } },
  banks:     {                                actionGroups: ['Banks'],             kinds: { ledger: 30 } },
  accounts:  {                                actionGroups: ['Reports'],           kinds: { ledger: 30 } },
  settings:  {                                actionGroups: ['Settings'],          kinds: {} },
};
function contextBoost(item, ctx) {
  if (!ctx) return 0;
  const rules = CTX_BOOST[ctx];
  if (!rules) return 0;
  let delta = 0;
  if (rules.partyType && item.kind === 'party' && item.partyType === rules.partyType) {
    delta += 60;
  }
  // Generic kind boost (eg. product boost in inventory context).
  if (rules.kinds && rules.kinds[item.kind]) {
    delta += rules.kinds[item.kind];
  }
  // Action group boost — favour "Create" actions when in a creation flow,
  // "Reports" when reading reports, etc.
  if (item.kind === 'action' && rules.actionGroups && rules.actionGroups.includes(item.group)) {
    delta += 30;
  }
  return delta;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Stale-while-revalidate cache (#6)
 *
 * Each fetch round trip costs ~80–250ms on a populated firm; without
 * caching, the same (scope, query) re-fired on every palette re-open or
 * keystroke that briefly returned to a prior prefix. The cache lives at
 * module scope so it survives palette open/close cycles but resets on
 * page reload — short-lived enough that data staleness across the firm
 * is bounded by the TTL.
 *
 * Cache key: `${scope || ''}:${query.toLowerCase()}` — scope-aware so a
 * "/c apex" hit doesn't pollute the unscoped "apex" entry (different
 * downstream filtering means the rendered result diverges).
 *
 * Strategy:
 *   - On query change, look up the key. Hit → set state from cache
 *     immediately (no spinner). Then still fire the network call to
 *     refresh — when it lands, replace silently.
 *   - TTL: 30 seconds. Older entries are dropped on access without
 *     being displayed; we treat them as "definitely re-fetch".
 *   - LRU cap: 50 entries. Map iteration order gives us insertion order
 *     for cheap LRU eviction without dragging in a real LRU library.
 * ────────────────────────────────────────────────────────────────────────── */
const SWR_TTL_MS = 30_000;
const SWR_MAX    = 50;
const swrCache   = new Map();   // key → { ts, parties, products, ledgers }

function swrGet(key) {
  const entry = swrCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SWR_TTL_MS) {
    swrCache.delete(key);
    return null;
  }
  // LRU bump — re-insert so this entry moves to the back of the order.
  swrCache.delete(key);
  swrCache.set(key, entry);
  return entry;
}
function swrPut(key, payload) {
  swrCache.set(key, { ts: Date.now(), ...payload });
  while (swrCache.size > SWR_MAX) {
    const oldest = swrCache.keys().next().value;
    swrCache.delete(oldest);
  }
}

/* Recent picks — removed. The palette previously kept the last 6 picks in
 * localStorage and surfaced them in a "Recent" group on the empty state.
 * Dropped because in an ERP the rows below "Pinned" and "Quick start"
 * already cover the same need (you pin what you actually return to;
 * Quick start covers first-time discovery), and a stale Recent list led
 * to confusion when an operator's pattern shifted. Keys gs_recent_v1
 * are left in localStorage on existing installs — harmless orphans. */

/* ──────────────────────────────────────────────────────────────────────────
 * Pinned results (#17) — operator-curated shortcuts.
 *
 * Learned-ranking changes over time and can demote a row the operator
 * deliberately wants stable at the top. Pinning is the override: a row
 * tagged "pinned" always renders in its own group at the very top,
 * regardless of query relevance, frequency, or learned weight. Twelve
 * slots is the soft cap — enough to cover a typical work day's verbs
 * without the section becoming a wall.
 *
 * Storage is localStorage so pins ride the operator's machine, not the
 * firm's profile. The reasoning: pins are personal muscle-memory; what
 * an accountant pins differs from what a salesman pins, and that's the
 * right boundary.
 * ────────────────────────────────────────────────────────────────────────── */
const PINS_KEY = 'gs_pins_v1';
const PINS_MAX = 12;
function readPins() {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function writePins(list) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(list)); } catch { /* swallow */ }
}
function isPinned(id, pins) {
  return Array.isArray(pins) ? pins.some((p) => p.id === id) : false;
}
function togglePin(item, currentPins) {
  if (!item || !item.id) return currentPins;
  const list = (currentPins || []).filter((p) => p.id !== item.id);
  if (list.length === (currentPins || []).length) {
    // wasn't there → add to front
    list.unshift({
      id: item.id, label: item.label, sub: item.sub,
      route: item.route, group: item.group, kind: item.kind,
    });
  }
  const trimmed = list.slice(0, PINS_MAX);
  writePins(trimmed);
  return trimmed;
}

/* ──────────────────────────────────────────────────────────────────────────
 * GlobalSearchPalette — the inner UI (input + results list).
 * Used by both the hero variant on the home page and the modal overlay
 * triggered by ⌘K elsewhere in the app.
 *
 * Props:
 *   variant — 'hero' | 'modal'   visual treatment
 *   onClose — () => void         only the modal calls this on Esc / select
 *   autoFocus — bool             default true, focuses the input on mount
 * ────────────────────────────────────────────────────────────────────────── */
export function GlobalSearchPalette({ variant = 'modal', onClose, autoFocus = true }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Context module — the high-level area the operator is currently in.
  // Stable per pathname, so a typing burst across the SAME page reuses
  // the same boost rather than recomputing per result mapping.
  const ctx = useMemo(() => detectContext(location.pathname), [location.pathname]);
  const inputRef = useRef(null);
  const listRef  = useRef(null);
  const [query,   setQuery]   = useState('');
  const [parties, setParties] = useState([]);
  const [products, setProds]  = useState([]);
  const [ledgers, setLedgers] = useState([]);
  // Voucher results (#5). Shape: { type: 'sale'|'purchase'|'receipt'|'payment',
  // id, number, date, party_name, amount }. Populated only when the
  // looksLikeVoucher heuristic fires AND no scope filter excludes them.
  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSel] = useState(0);
  // Operator-curated pins (#17). Lives in component state so the star
  // chip flips immediately on toggle without a page reload. Persisted
  // via writePins inside togglePin.
  const [pins, setPins] = useState(() => readPins());
  // Learned-ranking frequency map (#1). Loaded once per palette open.
  // The bump happens on choose(); next palette open picks it up.
  // We don't recompute on every click within a single open because the
  // operator is about to navigate away anyway — re-reading mid-session
  // would be wasted work.
  const [freqMap] = useState(() => deriveFreqMap());
  // Per-group expand toggles (#3). Hard-cap of 6 hides matches when the
  // operator has 12 customers starting with "An" — the seventh is
  // invisible. Each group renders up to GROUP_PEEK then a "+N more"
  // row; expanding flips this map and unlocks the full slice. State
  // resets to empty on every new query so a fresh search starts compact.
  const [expanded, setExpanded] = useState({});
  const expandGroup = (name) => setExpanded((m) => ({ ...m, [name]: true }));
  // Wrapper for pin/unpin that keeps both component state and the
  // localStorage backing in sync. Returning the new list also keeps
  // useState's setter signature compatible with togglePin's internals.
  const onTogglePin = (item) => setPins((cur) => togglePin(item, cur));

  // Monotonic request id — every fetch cycle bumps the counter and
  // captures its value; only writes to state if the captured id still
  // matches the latest. Belt-and-suspenders alongside AbortController:
  // if a response slips past abort (eg. cached/in-flight), the id check
  // still prevents stale writes from clobbering newer results.
  const reqIdRef = useRef(0);
  // System settings drive the action-flag filter — actions tagged with
  // `flag: '<key>'` only appear when that key is truthy in /settings/system.
  // Today this hides the Stock Transfer / Godown entries when the
  // Multi-warehouse master toggle is OFF.
  const settings = useSystemSettings();

  // Parse the live query for a scope prefix BEFORE deciding which APIs to
  // call. The fetched search term is always the post-scope substring, so
  // typing "/c apex" sends "apex" (not "/c apex") to /parties — important
  // for correctness, also faster because the backend filter sees the
  // real terms. Declared up here (before any effect that references it)
  // so the telemetry effect below doesn't hit a temporal-dead-zone error.
  const parsed = useMemo(() => parseScope(query), [query]);
  const scope = parsed.scope;
  const scopedQuery = parsed.query;

  // Session telemetry (#13). We log a single CLICK or ABANDON per
  // palette-open cycle. lastQueryRef tracks the most recent query that
  // had enough characters to fire a fetch — that's the query we attribute
  // to the abandon event if the operator closes without clicking. clicked
  // flips true when choose() lands, so the unmount-time abandon writer
  // can tell the two outcomes apart.
  const lastQueryRef = useRef('');
  const lastScopeRef = useRef(null);
  const clickedRef   = useRef(false);
  const openedAtRef  = useRef(Date.now());
  useEffect(() => {
    if (scopedQuery && scopedQuery.length >= 2) {
      lastQueryRef.current = scopedQuery;
      lastScopeRef.current = scope;
    }
  }, [scopedQuery, scope]);
  // On unmount: if the operator never clicked and had typed something,
  // record it as an abandon. That's the high-signal event for the
  // "what's missing from search?" question — every abandoned query is
  // a UX miss worth investigating.
  useEffect(() => {
    return () => {
      if (clickedRef.current) return;
      const q = lastQueryRef.current;
      if (!q) return;
      telemetryPush({
        kind: 'abandon',
        query: q,
        scope: lastScopeRef.current || null,
        dwell: Date.now() - openedAtRef.current,
      });
    };
  }, []);

  /* Live API search — debounced. Three endpoints in parallel: parties +
   * products + COA ledgers. We don't search bills here on purpose (the
   * bill list pages have their own bill-number search; the global
   * palette navigates to those entry points instead).
   *
   * exclude_party_ledgers=1 on the ledger fetch keeps the chart-of-account
   * results free of party ledgers (Bharat Wholesale's auto-created ledger
   * etc.) — those are already surfaced under Customers / Suppliers via
   * the parties endpoint. */

  useEffect(() => {
    if (!scopedQuery || scopedQuery.length < 2) {
      setParties([]); setProds([]); setLedgers([]); setVouchers([]);
      setLoading(false);
      return;
    }
    // Scope-driven fetch elision — actions/reports scopes hit purely static
    // data, no API needed. Skipping the network on those modes makes the
    // palette feel instant for power users hunting a specific page.
    const wantParties  = scope == null || scope === 'customers' || scope === 'suppliers';
    const wantProducts = scope == null || scope === 'products';
    const wantLedgers  = scope == null || scope === 'ledgers';
    // Voucher fetch only fires when:
    //   (a) the query looks voucher-shaped (heuristic above), AND
    //   (b) no scope filter would hide vouchers anyway (only the null
    //       scope and 'actions'/'reports' scopes can coexist with the
    //       voucher group — but 'actions' / 'reports' scopes mean the
    //       operator is hunting a page, not a voucher number, so we
    //       skip the fetch there).
    const wantVouchers = scope == null && looksLikeVoucher(scopedQuery);
    if (!wantParties && !wantProducts && !wantLedgers && !wantVouchers) {
      setParties([]); setProds([]); setLedgers([]); setVouchers([]);
      setLoading(false);
      return;
    }

    // Stale-while-revalidate (#6): warm-render from cache first so the
    // operator sees immediate results, then refresh in the background.
    // The cache key is scope-aware (see swrCache comment above) so an
    // unscoped "apex" doesn't bleed into "/c apex".
    const cacheKey = `${scope || ''}:${scopedQuery.toLowerCase()}`;
    const cached = swrGet(cacheKey);
    if (cached) {
      setParties (wantParties  ? (cached.parties  || []) : []);
      setProds   (wantProducts ? (cached.products || []) : []);
      setLedgers (wantLedgers  ? (cached.ledgers  || []) : []);
      setVouchers(wantVouchers ? (cached.vouchers || []) : []);
      // Don't flip loading on — the cached results are visible, so the
      // skeleton path is wrong and the inline spinner alone signals the
      // background revalidation.
    } else if (!wantVouchers) {
      // Cache miss + voucher-fetch not firing → no need to keep stale
      // voucher results from a previous voucher-shaped query around.
      setVouchers([]);
    }

    // Bump the request id BEFORE scheduling. A fast-typing user generates
    // a new effect on every keystroke; each cycle captures its own id and
    // only writes to state if reqIdRef.current still matches it on resolve.
    const myId = ++reqIdRef.current;
    const ctrl = new AbortController();
    // Only show the cold-load spinner / skeleton when we have NO results
    // to display — the cache hit above already populated state. Without
    // this gate, a cache-hit query would briefly clear the visible rows
    // and re-render them, causing a jarring flash.
    setLoading(!cached);
    const t = setTimeout(async () => {
      try {
        // Fetch a wider pool than we display (25 per kind). The default
        // render still peeks at GROUP_PEEK rows; the rest waits behind a
        // "+N more" expander so the palette doesn't feel cluttered on a
        // typical query, but the seventh-customer-matching-"An" use case
        // is rescued.
        //
        // Vouchers branch — only added when the heuristic fires. Strip
        // the leading "#" so the backend search-filter sees the raw
        // number. Each voucher endpoint gets a small limit (5) because
        // voucher-jump is a precision flow: the operator types a number
        // they expect to find, not browse a list.
        const voucherTerm = stripVoucherPrefix(scopedQuery);
        const calls = [
          wantParties  ? api.get('/parties',         { params: { search: scopedQuery, limit: 25 },                         signal: ctrl.signal }) : Promise.resolve(null),
          wantProducts ? api.get('/products',        { params: { search: scopedQuery, limit: 25 },                         signal: ctrl.signal }) : Promise.resolve(null),
          wantLedgers  ? api.get('/ledger/accounts', { params: { search: scopedQuery, exclude_party_ledgers: '1' },        signal: ctrl.signal }) : Promise.resolve(null),
          wantVouchers ? api.get('/sales',           { params: { search: voucherTerm, limit: 5 },                            signal: ctrl.signal }) : Promise.resolve(null),
          wantVouchers ? api.get('/purchases',       { params: { search: voucherTerm, limit: 5 },                            signal: ctrl.signal }) : Promise.resolve(null),
          wantVouchers ? api.get('/payments',        { params: { search: voucherTerm, limit: 5 },                            signal: ctrl.signal }) : Promise.resolve(null),
        ];
        const [pRes, prRes, lRes, sRes, puRes, payRes] = await Promise.allSettled(calls);
        // Drop stale responses. Either we were aborted (cleanup ran) or a
        // newer request has already bumped reqIdRef past our captured id.
        if (myId !== reqIdRef.current) return;
        const pickData = (r) => {
          if (!r || r.status !== 'fulfilled' || !r.value) return [];
          const d = r.value.data?.data ?? r.value.data ?? [];
          return Array.isArray(d) ? d : [];
        };
        const freshParties  = wantParties  ? pickData(pRes)  : [];
        const freshProducts = wantProducts ? pickData(prRes) : [];
        // Backend doesn't honour a `limit` on /ledger/accounts (it's ordered
        // by group then name and used by COA pickers that want the full
        // list). Cap client-side at 25 — same widened pool as parties /
        // products; the GROUP_PEEK display cap is enforced at render time.
        const freshLedgers  = wantLedgers  ? pickData(lRes).slice(0, 25) : [];
        // Voucher rows — three endpoints; each is tagged with its source
        // type so the result mapper can render the right verb / route.
        const freshVouchers = wantVouchers ? [
          ...pickData(sRes  ).map((v) => ({ ...v, _voucherType: 'sale'     })),
          ...pickData(puRes ).map((v) => ({ ...v, _voucherType: 'purchase' })),
          ...pickData(payRes).map((v) => ({ ...v, _voucherType: 'payment'  })),
        ] : [];
        setParties(freshParties);
        setProds  (freshProducts);
        setLedgers(freshLedgers);
        setVouchers(freshVouchers);
        // SWR write — only cache what we actually fetched. Keys aren't
        // sliced on scope-derived "wants" because the next palette open
        // might use the unscoped variant. We always cache the full
        // payload as fetched; the read path masks fields by scope.
        swrPut(cacheKey, {
          parties:  wantParties  ? freshParties  : (cached?.parties  || []),
          products: wantProducts ? freshProducts : (cached?.products || []),
          ledgers:  wantLedgers  ? freshLedgers  : (cached?.ledgers  || []),
          vouchers: wantVouchers ? freshVouchers : (cached?.vouchers || []),
        });
      } catch { /* swallow — empty results render */ }
      finally {
        if (myId === reqIdRef.current) setLoading(false);
      }
    }, 160);
    return () => {
      // Abort the network calls themselves (axios honours AbortSignal),
      // then drop the timeout in case it hasn't fired yet. The id-guard
      // above protects against any response that already slipped through.
      ctrl.abort();
      clearTimeout(t);
    };
  }, [scopedQuery, scope]);

  /* Build the flat result list — mixes typed quick-actions, live parties,
   * live products. Order: parties first (operators usually search for a
   * customer name), then products, then quick actions.
   *
   * Scope filters: when a scope prefix is active, only the matching kind
   * is included. "Customers" and "Suppliers" both come from /parties — we
   * filter further by party_type to honour the scope's intent. */
  const groupedResults = useMemo(() => {
    const out = [];
    // Use the post-scope query for action matching, so "a:sale" matches
    // ACTIONS against "sale" rather than the raw "a:sale" string.
    const q = scopedQuery.trim();
    const want = (k) => scope == null || scope === k;

    // Vouchers (#5) — voucher-shaped queries surface matching bills /
    // receipts / payments at the very top. Score 1200 (above the strict
    // party-trust default of 1000) so the group sorts above every other
    // group in groupResults. Mapper builds a "Receipt #INV-001" label
    // and routes to the bill's edit page so the operator lands on the
    // exact voucher they typed.
    for (const v of vouchers) {
      const vt = v._voucherType;
      const number = v.bill_number || v.transaction_number || v.voucher_number || v.invoice_number;
      if (!number) continue;
      // Voucher table uses kind-specific PKs: sales_bill_id, purchase_bill_id,
      // transaction_id. The earlier `bill_id` fallback only worked by accident
      // on responses that happened to include it; the React key collision
      // surfaced when the field was missing entirely. Look up the right PK
      // by kind so every row gets a unique, stable id.
      const vid =
        vt === 'sale'     ? (v.sales_bill_id    ?? v.bill_id ?? v.id) :
        vt === 'purchase' ? (v.purchase_bill_id ?? v.bill_id ?? v.id) :
        vt === 'payment'  ? (v.transaction_id   ?? v.id) :
        v.id;
      if (vid == null) continue;
      const amount = Number(v.total_amount ?? v.amount ?? v.bill_amount ?? 0);
      const date   = v.bill_date || v.transaction_date || v.date || null;
      const party  = v.party?.party_name || v.customer?.party_name || v.supplier?.party_name || v.party_name || null;
      const isReceipt = vt === 'payment' && String(v.transaction_type || '').toLowerCase() === 'receipt';
      const verbMap = {
        sale:     { label: 'Sale',     route: `/sale/edit/${vid}`,                              icon: ShoppingCartOutlined },
        purchase: { label: 'Purchase', route: `/purchase/edit/${vid}`,                          icon: InboxOutlined },
        payment:  isReceipt
          ? { label: 'Receipt', route: `/receipt/edit/${vid}`,                                  icon: DollarCircleOutlined }
          : { label: 'Payment', route: `/payment/edit/${vid}`,                                  icon: CreditCardOutlined },
      };
      const meta = verbMap[vt] || { label: 'Voucher', route: '/', icon: FileTextOutlined };
      const dateLabel = date ? new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
      const sub = [
        party,
        dateLabel,
        amount ? `₹${Math.round(amount).toLocaleString('en-IN')}` : null,
      ].filter(Boolean).join(' · ');
      const row = {
        id: `voucher-${vt}-${vid}`,
        kind: 'voucher',
        icon: meta.icon,
        label: `${meta.label} #${number}`,
        sub,
        group: 'Vouchers',
        route: meta.route,
      };
      // Score 1200 — outranks parties (1000) so a voucher-shaped query
      // that finds a real voucher always shows it FIRST.
      row._score = 1200 + freqBoost(freqMap, row.id);
      out.push(row);
    }

    // Parties → split into Customer / Supplier sections so the verbs
    // ("New bill to X", "Receipt from X") read naturally.
    for (const p of parties) {
      const id = `party-${p.party_id || p.id}`;
      const isCust = (p.party_type || 'Customer').toLowerCase().startsWith('cust');
      // Scope filter — /c limits to customers, /s to suppliers. Note that
      // the API call already used `/parties` (mixed) since the server's
      // search index isn't typed; we filter client-side here for correctness.
      if (scope === 'customers' && !isCust) continue;
      if (scope === 'suppliers' &&  isCust) continue;
      const balance = Number(p.outstanding_balance || p.balance || 0);
      const balLabel = balance > 0
        ? `${isCust ? 'Receivable' : 'Payable'} ₹${Math.abs(Math.round(balance)).toLocaleString('en-IN')}`
        : balance < 0 ? `Advance ₹${Math.abs(Math.round(balance)).toLocaleString('en-IN')}` : 'Squared';
      const pid = p.party_id || p.id;
      // Credit-limit pressure warning — surfaces a tiny exclamation chip
      // on the sub line when a customer's outstanding has crossed (or is
      // grazing 90% of) their credit_limit. Operators glancing at search
      // see "this is the customer to chase" without having to drill in.
      const limit = Number(p.credit_limit || 0);
      const overLimit = isCust && limit > 0 && balance > 0 && balance >= limit * 0.9;
      // Phone first — phone-based party lookup is the #1 disambiguator in
      // Indian SMB workflows ("Anil — which Anil?  the 98765 one"). City
      // and GSTIN come next; GSTIN matters for B2B operators reconciling
      // invoices. Cap at 3 fields so the line doesn't truncate awkwardly.
      const phone = p.mobile_1 || p.mobile_2 || p.phone || null;
      const sub = [
        phone,
        p.city,
        p.gstin,
        balLabel,
        overLimit ? '⚠ credit limit' : null,
      ].filter(Boolean).slice(0, 4).join(' · ');
      // Route to the proper Customer / Supplier Statement page (not the
      // retired /parties/:id detail view). The statement pages accept
      // ?id=<party_id> and pre-select the party in their picker.
      const statementRoute = isCust
        ? `/reports/customer-statement?id=${pid}`
        : `/reports/supplier-statement?id=${pid}`;
      const row = {
        id, kind: 'party',
        icon: isCust ? UserOutlined : TeamOutlined,
        label: p.party_name,
        sub,
        group: isCust ? 'Customers' : 'Suppliers',
        route: statementRoute,
        // Surface the party id for action-key handlers (#7) so E/N can
        // navigate to the edit form / new-bill flow without re-fetching.
        partyId: pid,
        partyType: isCust ? 'Customer' : 'Supplier',
      };
      // Context boost (#11) — Sales-context customers and Purchase-context
      // suppliers float to the top of mixed-results sets. Frequency boost
      // (#1) lifts the operator's most-clicked customers above the rest.
      row._score = 1000 + contextBoost(row, ctx) + freqBoost(freqMap, row.id);
      out.push(row);
    }

    // Ledgers (COA — Sales A/c, Bank, Office Rent, etc.). Party ledgers
    // are filtered out at the API call (?exclude_party_ledgers=1) so a
    // customer never appears here in addition to the Customers section.
    for (const l of ledgers) {
      if (!want('ledgers')) break;
      const lid = l.ledger_id;
      const balance = Number(l.current_balance || 0);
      const balLabel = balance !== 0
        ? `₹${Math.abs(Math.round(balance)).toLocaleString('en-IN')} ${balance > 0 ? 'Dr' : 'Cr'}`
        : null;
      const row = {
        id: `ledger-${lid}`, kind: 'ledger',
        icon: BookOutlined,
        label: l.ledger_name,
        sub: [l.ledger_group, l.sub_group, balLabel].filter(Boolean).join(' · '),
        group: 'Ledgers',
        // Land on the COA Ledger Statement with this ledger preselected.
        // Same picker / period chips / print path as Customer & Supplier
        // Statement, just keyed off ledger_id instead of party_id.
        route: `/reports/ledger?id=${lid}`,
      };
      row._score = 1000 + contextBoost(row, ctx) + freqBoost(freqMap, row.id);
      out.push(row);
    }

    // Products
    for (const pr of products) {
      if (!want('products')) break;
      const pid = pr.product_id || pr.id;
      const id = `prod-${pid}`;
      const stock = Number(pr.current_stock ?? pr.stock_qty ?? 0);
      const price = Number(pr.sale_price ?? pr.mrp ?? 0);
      const reorder = Number(pr.reorder_level || 0);
      const lowStock = reorder > 0 && stock <= reorder;
      // Pack the sub line with the highest-signal disambiguators first.
      // - SKU / barcode: the unique-id by which warehouse staff scan stock.
      // - HSN code: tax code accountants reach for during return filing.
      // - Category: groups same-name items (eg. multiple "T-shirt 32").
      // - Price + stock with a low-stock chip when reorder-level breached.
      const stockLabel = lowStock ? `⚠ ${stock} (reorder ${reorder})` : `${stock} in stock`;
      const sub = [
        pr.sku || pr.barcode,
        pr.hsn_code ? `HSN ${pr.hsn_code}` : null,
        pr.category_name,
        price ? `₹${Math.round(price).toLocaleString('en-IN')}` : null,
        stockLabel,
      ].filter(Boolean).slice(0, 4).join(' · ');
      const row = {
        id, kind: 'product',
        icon: ProductOutlined,
        label: pr.product_name,
        sub,
        group: 'Products',
        route: `/stock-movement/${pid}`,
        productId: pid,
      };
      row._score = 1000 + contextBoost(row, ctx) + freqBoost(freqMap, row.id);
      out.push(row);
    }

    // Quick actions / pages — included when no scope, or when the operator
    // explicitly asked for them (a:/>:) or for reports (r:, which is just
    // a narrower view of actions filtered to the Reports group).
    const includeActions = scope == null || scope === 'actions' || scope === 'reports';
    if (includeActions) {
      // ">"  with no query → show ALL actions (capped). Useful as a
      // command-palette browse mode: hit ">" then arrow through everything.
      const showAllActions = (scope === 'actions') && q === '';
      const matches = ACTIONS
        .filter(a => !a.flag || !!settings?.[a.flag])
        .filter(a => scope !== 'reports' || a.group === 'Reports')
        .map(a => {
          if (showAllActions) return { a, s: 1 };       // any non-null keeps it
          return { a, s: scoreAction(a, q) };
        })
        .filter(x => x.s != null)
        .sort((x, y) => y.s - x.s)
        .slice(0, showAllActions ? 50 : 14)
        .map(x => {
          const row = {
            id: x.a.id, kind: 'action',
            icon: x.a.icon, label: x.a.label, sub: x.a.sub,
            group: x.a.group, route: x.a.route, kbd: x.a.kbd,
          };
          /* Carried into groupResults so groups with higher-scoring items
           * bubble to the top. Stripped before render — readers ignore
           * unknown props on the row object. Context boost adds a small
           * delta so Reports rows surface first when reading reports.
           * Frequency boost lifts the operator's daily-driver actions. */
          row._score = x.s + contextBoost(row, ctx) + freqBoost(freqMap, row.id);
          return row;
        });
      out.push(...matches);
    }

    return groupResults(out);
  }, [scopedQuery, scope, parties, products, ledgers, vouchers, settings, ctx, freqMap]);

  // Per-group peek cap. Six rows fit comfortably in the modal without
  // scrolling; anything beyond that sits behind a "Show N more" expander.
  const GROUP_PEEK = 6;

  // Reset the per-group expand map whenever the query changes — a fresh
  // search should always start in the compact peek state. Without this,
  // searching for "An" expanded → typing "Anv" would still show every
  // match in the new (smaller) set, fighting the user's intent.
  useEffect(() => { setExpanded({}); }, [scopedQuery, scope]);

  // Apply the GROUP_PEEK cap per group, injecting a synthetic "more" row
  // when there are hidden items. The synthetic row participates in the
  // flat list for keyboard nav so Enter on it expands the group rather
  // than navigating.
  const renderGroups = useMemo(() => {
    return groupedResults.map((g) => {
      const isExpanded = !!expanded[g.name];
      const peek = isExpanded ? g.items : g.items.slice(0, GROUP_PEEK);
      const overflow = g.items.length - peek.length;
      if (overflow <= 0) return g;
      return {
        ...g,
        items: [
          ...peek,
          {
            id: `__more-${g.name}`,
            kind: 'more',
            label: `Show ${overflow} more in ${g.name.toLowerCase()}`,
            sub: null,
            _moreOf: g.name,
            _moreCount: overflow,
          },
        ],
      };
    });
  }, [groupedResults, expanded]);

  /* What renders when the input is empty:
   *   - Modal (⌘K / Alt+G): Pinned (if any) + a Quick-start group so the
   *     palette is never just an empty box — the user just opened it
   *     deliberately, they want suggestions.
   *   - Hero (home page): nothing. The bar lives alone above the fold;
   *     pre-loaded suggestions felt like clutter on a landing page.
   *     Once the user types one character, results render normally.
   *
   * "Empty" is judged on the post-scope query, so "/a" (actions browse)
   * is NOT empty — it intentionally surfaces every action. Same logic
   * for "/c" with no party name: an empty Customers scope IS empty and
   * we let the Quick-start suggestions render. */
  const emptyState = !scopedQuery.trim() && scope !== 'actions';
  const showSuggestions = emptyState && variant !== 'hero';
  // Pinned rows render in the empty state (top of the palette) and ALSO
  // as a sticky header in the active-results state, so a frequently-
  // pinned destination is one keystroke away regardless of the current
  // search. Resolved icons by id from ACTIONS so the visual stays
  // consistent with the action's primary surface.
  const showPinned = pins.length > 0 && variant !== 'hero';
  const pinnedItems = useMemo(
    () => pins.map((p) => ({ ...p, icon: ACTIONS.find((a) => a.id === p.id)?.icon || FileTextOutlined })),
    [pins],
  );
  // Module-aware empty-state (#12). Six suggestion slots, picked from
  // the action catalog by id. When the palette opens inside a known
  // module the slots are tailored — "Quick start" on a sales screen
  // means "New sale / Customer / Sales return" rather than the generic
  // global six. The default branch still ships sensible suggestions
  // when the operator opens search from a context we don't have a
  // map for (login screen, brand-new install, unknown deep link).
  const trySuggestions = useMemo(() => {
    if (!showSuggestions) return [];
    const ids = ({
      sales:     ['sale-new',     'sret-new',  'customers', 'r-sales',     'r-aging-r', 'r-bills-r'],
      receipts:  ['receipt-new',  'customers', 'pay-list',  'r-aging-r',   'r-cust-out','r-monthly-rec'],
      purchase:  ['purchase-new', 'pret-new',  'suppliers', 'r-purc',      'r-aging-p', 'r-bills-p'],
      payments:  ['payment-new',  'suppliers', 'pay-list',  'r-aging-p',   'r-supp-out','r-monthly-pay'],
      expenses:  ['expense-new',  'expenses',  'r-exp',     'r-day',       'r-tb',      'r-pl'],
      inventory: ['products',     'stock-report','categories','batches',   'r-fast',    'r-expiry'],
      parties:   ['customers',    'suppliers', 'sale-new',  'receipt-new', 'r-aging-r', 'r-aging-p'],
      reports:   ['reports',      'r-day',     'r-tb',      'r-pl',        'r-bs',      'r-cf'],
      banks:     ['banks',        'bank-recon','cheques',   'loans',       'loan-sched','r-day'],
      accounts:  ['jv-new',       'jv-list',   'r-day',     'r-tb',        'r-ledger',  'integrity'],
      settings:  ['s-company',    's-users',   's-companies','s-print',    's-modules', 's-backup'],
    })[ctx] || ['sale-new', 'purchase-new', 'reports', 'r-day', 'customers', 'r-tb'];
    return ids
      .map((id) => ACTIONS.find((a) => a.id === id))
      .filter(Boolean)
      .map((a) => ({
        id: a.id, kind: 'action', icon: a.icon, label: a.label, sub: a.sub,
        group: a.group, route: a.route, kbd: a.kbd,
      }));
  }, [showSuggestions, ctx]);

  /* "Did you mean" candidates (#14). Fires only when the live query has
   * produced ZERO results — at that point we widen the fuzzy net: every
   * ACTION gets its full edit-distance computed against the query, and
   * the closest 4 surface as soft suggestions. Keeps the no-result state
   * useful instead of dead. */
  const didYouMean = useMemo(() => {
    const q = scopedQuery.trim().toLowerCase();
    if (!q || q.length < 3) return [];
    // Allow generous distance (up to 4 for longer queries) — we already
    // know the strict / regular fuzzy paths returned nothing, so widen
    // before giving up. Cap candidates by SCORE rather than count so
    // very-distant matches don't pollute the suggestion list.
    const maxD = Math.min(4, Math.max(1, Math.floor(q.length / 2)));
    const candidates = [];
    for (const a of ACTIONS) {
      if (a.flag && !settings?.[a.flag]) continue;
      const label = a.label.toLowerCase();
      // Closest label word to the query.
      const words = label.split(/[\s\-/]+/).filter(Boolean);
      let best = maxD + 1;
      for (const w of words) {
        const d = editDistance(q, w, maxD);
        if (d < best) best = d;
      }
      // Try the full label too for multi-word queries.
      const dWhole = editDistance(q, label, maxD);
      if (dWhole < best) best = dWhole;
      if (best <= maxD) candidates.push({ a, d: best });
    }
    candidates.sort((x, y) => x.d - y.d);
    return candidates.slice(0, 4).map((c) => ({
      id: c.a.id, kind: 'action',
      icon: c.a.icon, label: c.a.label, sub: c.a.sub,
      group: c.a.group, route: c.a.route, kbd: c.a.kbd,
    }));
  }, [scopedQuery, settings]);

  /* Flat list (for keyboard nav) — order matches what's rendered. In the
   * empty state we still want Enter to do something useful, so the idle
   * Pinned + Quick-start rows participate in selection too. Without this,
   * opening the palette and hitting Enter on the visibly highlighted row
   * was a no-op (Enter looked dead until the user typed).
   *
   * Pinned items sit above everything when present; they reflect the
   * operator's deliberate curation and should be the FIRST thing arrow
   * keys land on.
   *
   * Uses renderGroups (peeked) so arrow keys can't roll past visible rows
   * into a hidden tail — until the operator expands a group via its
   * "+N more" row, hidden items are unreachable. */
  const flat = useMemo(() => {
    if (emptyState) {
      const base = [];
      if (showPinned)      base.push(...pinnedItems);
      if (showSuggestions) base.push(...trySuggestions);
      return base;
    }
    const live = renderGroups.flatMap((g) => g.items);
    // Did-you-mean rows participate in keyboard nav so Enter on the
    // first suggestion just works. They only render when live results
    // are empty, so this never collides with the regular result flow.
    if (live.length === 0 && didYouMean.length > 0) return didYouMean;
    return live;
  }, [emptyState, showPinned, showSuggestions, pinnedItems, trySuggestions, renderGroups, didYouMean]);

  /* Keep the highlighted row in view as the user arrows through. */
  useEffect(() => {
    if (selectedIdx < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${selectedIdx}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  /* Reset selection whenever the result set changes shape, so the first
   * result is always pre-highlighted (palette muscle-memory: "type, hit
   * Enter, go"). */
  useEffect(() => { setSel(0); }, [flat.length]);

  useEffect(() => {
    if (autoFocus && inputRef.current) inputRef.current.focus();
  }, [autoFocus]);

  // Seed query from GlobalSearchHomeCard (#18) — when the operator typed
  // a letter on the home card before the modal opened, that letter is
  // stashed in sessionStorage. Pick it up on mount so the palette starts
  // with that seed in the input; one-shot read, immediately cleared.
  useEffect(() => {
    try {
      const seed = sessionStorage.getItem('gs_seed');
      if (seed) {
        sessionStorage.removeItem('gs_seed');
        setQuery(seed);
      }
    } catch { /* swallow */ }
  }, []);

  const choose = (item) => {
    if (!item) return;
    // Synthetic "Show N more" row — expand the group instead of routing.
    // The flat list rebuilds with the full group inline and keyboard
    // focus stays on the row that was just expanded (its idx is now the
    // first hidden item, which we want pre-highlighted).
    if (item.kind === 'more') {
      expandGroup(item._moreOf);
      return;
    }
    // Telemetry click event — records WHAT was picked against the query
    // that produced it. The id+kind+group triple is enough to drive both
    // the abandon analysis and the learned ranking. We intentionally
    // don't store the row's label/sub (privacy: customer names etc.).
    clickedRef.current = true;
    telemetryPush({
      kind: 'click',
      query: scopedQuery || '',
      scope: scope || null,
      pickedId: item.id,
      pickedKind: item.kind,
      pickedGroup: item.group,
      dwell: Date.now() - openedAtRef.current,
    });
    if (item.route) {
      /* Stash the source route + query string so AppLayout's global ESC
       * handler can take the operator straight back here when they hit
       * Esc on the destination page. Cleared once consumed. Same flag
       * works for both hero (home page) and modal (anywhere) variants. */
      try {
        sessionStorage.setItem(
          'search_back_from',
          window.location.pathname + window.location.search,
        );
      } catch { /* swallow — Safari private mode etc. */ }
      navigate(item.route);
    }
    onClose?.();
  };

  const onKey = (e) => {
    // ⌘B / Ctrl+B — toggle pin on the currently selected row (#17).
    // B for "bookmark"; Cmd+B in a search input is a safe chord because
    // bold formatting doesn't apply here, and the global shortcut catalog
    // doesn't bind Cmd+B to anything else. Pin/unpin is silent: the star
    // icon flips state and a future re-open shows the row at the top.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      const item = flat[selectedIdx];
      if (item && item.id && item.kind !== 'more') onTogglePin(item);
      return;
    }
    // ⌘Enter / Ctrl+Enter — open the selected row in a new window (#7).
    // Useful when comparing reports / vouchers side-by-side, or when the
    // operator wants to peek at a destination without losing their place.
    // Electron treats window.open as a real new window; the dev/browser
    // build opens a new tab. We stopPropagation so the global Enter
    // shortcut chain (if any in future) doesn't ALSO fire.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const item = flat[selectedIdx];
      if (item && item.route && item.kind !== 'more') {
        try {
          // Pre-load source-route for the cmd-tab dance to feel sane:
          // if the new window is opened from /reports, closing it leaves
          // the operator back here automatically (browser back / Esc).
          window.open(item.route, '_blank', 'noopener,noreferrer');
        } catch { /* swallow — popup blocker etc. */ }
        // Cmd+Enter still records as a click for telemetry & frequency
        // — the operator picked this row, just into a different window.
        clickedRef.current = true;
        telemetryPush({
          kind: 'click',
          query: scopedQuery || '',
          scope: scope || null,
          pickedId: item.id,
          pickedKind: item.kind,
          pickedGroup: item.group,
          secondary: true,
          dwell: Date.now() - openedAtRef.current,
        });
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // ── Hidden developer-access trigger ──────────────────────────
      // Typing "/__dev" + Enter opens the developer-mode password
      // modal. Intentionally invisible: no autocomplete suggestion,
      // no result row, no hint anywhere in the UI. A regular user
      // glancing at this code wouldn't see anything; only the
      // string-match branch below produces an effect.
      //
      // Why the global search palette: it's the one input that's
      // always reachable from any page (Ctrl+K / Alt+G), shared
      // across browser and Electron clients alike, and already has
      // an Enter handler — adding a magic-string intercept is a few
      // lines instead of plumbing a separate keyboard listener.
      const trimmed = String(query || '').trim();
      if (trimmed === '/__dev' || trimmed === '/__developer') {
        // Fire a window event the Sidebar listens for; it owns the
        // DeveloperGate modal. Keeps the palette decoupled from the
        // dev-mode store.
        window.dispatchEvent(new CustomEvent('dev-gate:open'));
        setQuery('');
        onClose?.();
        return;
      }
      choose(flat[selectedIdx]);
    } else if (e.key === 'Escape') {
      // The underlying page (bill forms, lists) usually has its own
      // window-level Escape handler — typically "Back" via ActionStrip.
      // Without stopping propagation here, closing the palette also
      // navigates the page behind it. stopImmediatePropagation kills
      // every later window-level listener for this keystroke.
      e.preventDefault();
      e.stopPropagation();
      if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) {
        e.nativeEvent.stopImmediatePropagation();
      }
      if (query) setQuery('');
      else onClose?.();
    }
  };

  // "Live" = real result rows (renderGroups), independent of the
  // didYouMean fallback that flat may contain. Used to decide whether
  // to show the no-match panel: if didYouMean has anything, flat is
  // non-empty even when LIVE is zero, and we still want the panel.
  const liveCount = useMemo(
    () => renderGroups.reduce((sum, g) => sum + g.items.length, 0),
    [renderGroups],
  );
  const hasAnything = !emptyState && liveCount > 0;
  // Single-character queries don't fire a fetch (the effect bails on
  // length < 2) — so we mustn't render the "Nothing matches" empty state,
  // which would lie to the operator. A dedicated keep-typing hint covers
  // that gap.
  // singleChar judged on the SCOPED query — typing "c:a" should show
  // "Keep typing" rather than searching for one letter ("a") against
  // every customer in the firm.
  const singleChar = scopedQuery.trim().length === 1;
  const noMatch = !emptyState && !singleChar && liveCount === 0 && !loading;

  // Scope chip — when a scope is active, surface it visibly inside the
  // input row so the operator knows the palette is filtered. Clearing
  // the chip drops back to the unfiltered view AND wipes the prefix from
  // the input, so the next keystroke starts fresh.
  const clearScope = () => {
    setQuery('');
    inputRef.current?.focus();
  };

  return (
    <div className={`gs gs-${variant}`} onKeyDown={onKey}>
      <div className="gs-input-wrap">
        <SearchOutlined className="gs-input-icon" />
        {scope && (
          <button
            type="button"
            className="gs-scope-chip"
            onClick={clearScope}
            title="Clear scope filter"
            aria-label={`Scope: ${SCOPE_LABEL[scope]}. Click to clear.`}
          >
            {SCOPE_LABEL[scope]}<span className="gs-scope-x" aria-hidden="true">×</span>
          </button>
        )}
        <input
          ref={inputRef}
          className="gs-input"
          placeholder={scope ? `Search in ${SCOPE_LABEL[scope].toLowerCase()}…` : 'Search anything — customers, products, bills, reports…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {/* Inline progress chip — pulses next to the input when a refetch
            is in flight AND we already have stale results visible. Without
            this the palette looked frozen on the previous result set while
            the new one was loading. Hidden in hero variant to keep the
            home-page bar minimal. */}
        {loading && hasAnything && variant !== 'hero' && (
          <span className="gs-input-spinner" aria-hidden="true" />
        )}
        {variant === 'hero' ? (
          <span className="gs-input-hint">
            <kbd className="gs-kbd">Alt</kbd><kbd className="gs-kbd">G</kbd>
          </span>
        ) : (
          <span className="gs-input-hint">
            <kbd className="gs-kbd">esc</kbd>
          </span>
        )}
      </div>

      {/* Hide the results panel entirely in hero mode while idle — keeps the
          home page clean: just a search bar with no decorative dropdown.
          The modal variant always renders the panel since the user just
          deliberately opened ⌘K and expects something there. */}
      {!(variant === 'hero' && emptyState) && (
      <div className="gs-results" ref={listRef}>
        {/* Type-more hint sits in the same gap as the empty / loading rows.
            Single-character queries get this instead of the no-match panel
            so we don't lie about having searched. */}
        {singleChar && !loading && (
          <div className="gs-status">Keep typing — at least 2 characters.</div>
        )}

        {/* Cold-load skeleton — only when there's nothing on screen yet.
            Matches the height/shape of a real row so the layout doesn't
            jump when results land. Once we have prior results, the inline
            spinner takes over and we leave the stale list visible. */}
        {loading && !hasAnything && !singleChar && (
          <div className="gs-group" aria-busy="true">
            <div className="gs-group-name">Searching…</div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="gs-row gs-row-skel">
                <div className="gs-row-icon gs-skel-block" />
                <div className="gs-row-text">
                  <div className="gs-skel-line gs-skel-line-lg" />
                  <div className="gs-skel-line gs-skel-line-sm" />
                </div>
              </div>
            ))}
          </div>
        )}

        {hasAnything && renderGroups.map((g) => (
          <GsGroup
            key={g.name}
            name={g.name}
            items={g.items}
            startIdx={flat.indexOf(g.items[0])}
            selectedIdx={selectedIdx}
            onPick={choose}
            onHover={setSel}
            pins={pins}
            onTogglePin={onTogglePin}
          />
        ))}

        {/* Pinned — operator-curated row block, always first in the empty
            state. Pins are deliberate; whatever the user starred should
            be one keystroke away, above the generic Quick-start row. */}
        {emptyState && showPinned && (
          <GsGroup
            name="Pinned"
            items={pinnedItems}
            startIdx={0}
            selectedIdx={selectedIdx}
            onPick={choose}
            onHover={setSel}
            pins={pins}
            onTogglePin={onTogglePin}
          />
        )}

        {showSuggestions && (
          <GsGroup
            name="Quick start"
            items={trySuggestions}
            startIdx={showPinned ? pinnedItems.length : 0}
            selectedIdx={selectedIdx}
            onPick={choose}
            onHover={setSel}
            pins={pins}
            onTogglePin={onTogglePin}
          />
        )}

        {noMatch && didYouMean.length === 0 && (
          <div className="gs-empty">
            <div className="gs-empty-title">Nothing matches "{scopedQuery || query}"</div>
            <div className="gs-empty-sub">
              {scope
                ? <>Try clearing the <strong>{SCOPE_LABEL[scope]}</strong> filter, or a different name / id.</>
                : 'Try a customer name, product SKU, or report title.'}
            </div>
          </div>
        )}

        {/* Did-you-mean (#14) — soft fuzzy suggestions when nothing matched.
            Renders as a regular group so keyboard nav + Enter behave the
            same as any other result; the header text differentiates it. */}
        {noMatch && didYouMean.length > 0 && (
          <>
            <div className="gs-empty gs-empty-soft">
              <div className="gs-empty-title">Nothing matches "{scopedQuery || query}"</div>
              <div className="gs-empty-sub">Did you mean one of these?</div>
            </div>
            <GsGroup
              name="Suggestions"
              items={didYouMean}
              startIdx={0}
              selectedIdx={selectedIdx}
              onPick={choose}
              onHover={setSel}
              pins={pins}
              onTogglePin={onTogglePin}
            />
          </>
        )}
      </div>
      )}

      {/* Footer — scope-prefix hints. Universal keys (↑↓ / ↵ / esc) are
          intentionally NOT shown; everyone knows them and the footer
          shouldn't compete with the result list for attention. What stays
          is the four /-prefixes — they're the only thing here a user
          can't figure out on their own. Slash because it's two keys total
          (no shift) and matches Slack / Discord / Notion convention. */}
      <div className="gs-footer">
        <span className="gs-footer-tip"><kbd className="gs-kbd">/c</kbd> customers</span>
        <span className="gs-footer-tip"><kbd className="gs-kbd">/p</kbd> products</span>
        <span className="gs-footer-tip"><kbd className="gs-kbd">/r</kbd> reports</span>
        <span className="gs-footer-tip"><kbd className="gs-kbd">/a</kbd> actions</span>
      </div>
    </div>
  );
}

/* Single section in the result list. Renders a small group-header plus
 * the rows. Index is the absolute index in the flat list (so keyboard
 * highlight survives jumping across groups).
 *
 * `pins` / `onTogglePin` plumb through so each row can render its pin
 * star and react to clicks. Pure read of pins (a list of {id}) — the
 * row computes `pinned` inline so a single pin toggle re-renders only
 * the affected row instead of the entire palette. */
function GsGroup({ name, items, startIdx, selectedIdx, onPick, onHover, pins, onTogglePin }) {
  return (
    <div className="gs-group">
      <div className="gs-group-name">{name}</div>
      {items.map((item, i) => {
        const idx = startIdx + i;
        // "More" synthetic rows (#3) render as a slimmer affordance — no
        // icon background, no sub, italics. Distinguishing them visually
        // is important: an operator expects clicking it to expand, not
        // navigate. Same selection / hover plumbing as a real row.
        if (item.kind === 'more') {
          return (
            <div
              key={item.id}
              data-idx={idx}
              className={`gs-row gs-row-more ${selectedIdx === idx ? 'is-selected' : ''}`}
              onMouseEnter={() => onHover(idx)}
              onClick={() => onPick(item)}
            >
              <div className="gs-row-icon gs-row-icon-more">+{item._moreCount}</div>
              <div className="gs-row-text">
                <div className="gs-row-label gs-row-label-more">{item.label}</div>
              </div>
            </div>
          );
        }
        const Icon = item.icon || FileTextOutlined;
        const pinned = isPinned(item.id, pins);
        return (
          <div
            key={item.id}
            data-idx={idx}
            className={`gs-row ${selectedIdx === idx ? 'is-selected' : ''}${pinned ? ' is-pinned' : ''}`}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onPick(item)}
          >
            <div className="gs-row-icon"><Icon /></div>
            <div className="gs-row-text">
              <div className="gs-row-label">{item.label}</div>
              {item.sub && <div className="gs-row-sub">{item.sub}</div>}
            </div>
            {item.kbd && (
              <div className="gs-row-kbd">
                {item.kbd.split('+').map((k, j) => (
                  <kbd key={j} className="gs-kbd">{k}</kbd>
                ))}
              </div>
            )}
            {/* Pin toggle. Always rendered but only made visible on hover
                or when the row is pinned/selected — see CSS. Stops click
                propagation so picking a row vs pinning it stay separate
                actions. aria-pressed gives screen readers the state. */}
            {onTogglePin && (
              <button
                type="button"
                className={`gs-pin-btn ${pinned ? 'is-pinned' : ''}`}
                onClick={(e) => { e.stopPropagation(); onTogglePin(item); }}
                title={pinned ? 'Unpin (⌘B)' : 'Pin to top (⌘B)'}
                aria-label={pinned ? 'Unpin from top' : 'Pin to top'}
                aria-pressed={pinned}
              >
                {pinned ? <PushpinFilled /> : <PushpinOutlined />}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * GlobalSearchHero — DEPRECATED. The embedded-on-home-page palette was a
 * second surface to maintain alongside the modal (per-variant CSS sizing,
 * keyboard hint placement, absolute-positioned results dropdown). #18 of
 * the search-improvement work retired it in favour of GlobalSearchHomeCard
 * below, which is a single visual element that opens the modal on click
 * or first keystroke. The export is preserved as a thin shim so any
 * dormant callers don't crash; new code should not use it.
 * ────────────────────────────────────────────────────────────────────────── */
export function GlobalSearchHero({ autoFocus = true } = {}) {
  return <GlobalSearchHomeCard autoFocus={autoFocus} />;
}

/* ──────────────────────────────────────────────────────────────────────────
 * GlobalSearchHomeCard — the prominent search affordance for the home
 * landing page. Visually a big input-shaped card with the magnifier glyph
 * and placeholder; functionally a button that opens the modal. First
 * keystroke when focused likewise opens the modal AND passes the key as
 * the seed query, so the operator's typing flow is uninterrupted — the
 * letter they typed lands inside the modal's input, not lost.
 *
 * Why the swap (#18): the old hero variant duplicated the palette's
 * input + results + keyboard plumbing for one screen. Every change had
 * to be tested twice. With this card, the modal is the single palette
 * surface; the home page just provides an entry point that feels heavy
 * enough to be obvious.
 * ────────────────────────────────────────────────────────────────────────── */
export function GlobalSearchHomeCard({ autoFocus = false }) {
  const btnRef = useRef(null);
  // autoFocus from Home — when the user navigates to Home, focus the card
  // so a single keystroke opens the palette pre-seeded.
  useEffect(() => {
    if (autoFocus && btnRef.current) btnRef.current.focus();
  }, [autoFocus]);
  const open  = () => window.dispatchEvent(new Event('global-search:open'));
  const onKey = (e) => {
    // Any printable character → open modal with that char as the seed.
    // Use sessionStorage to communicate the seed across the event firing;
    // GlobalSearchModal reads it on open and primes the palette state.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); return; }
    // Single printable character only (skip Tab, Escape, Arrow*, etc.)
    if (e.key.length === 1 && /\S/.test(e.key)) {
      try { sessionStorage.setItem('gs_seed', e.key); } catch {}
      open();
    }
  };
  const [key1, key2] = platformShortcut();
  return (
    <div className="gs-hero-wrap">
      <button
        ref={btnRef}
        type="button"
        className="gs-home-card"
        onClick={open}
        onKeyDown={onKey}
        aria-label="Open search"
      >
        <SearchOutlined className="gs-home-card-icon" />
        <span className="gs-home-card-text">
          Search anything — customers, products, bills, reports…
        </span>
        <span className="gs-home-card-kbd">
          <kbd>{key1}</kbd><span className="gs-trigger-plus">+</span><kbd>{key2}</kbd>
        </span>
      </button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * GlobalSearchModal — the global ⌘K overlay. Mounted once in App.jsx and
 * listens for the `global-search:open` window event. Esc / backdrop /
 * picking a result all close it.
 * ────────────────────────────────────────────────────────────────────────── */
export function GlobalSearchModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onToggle = () => setOpen((o) => !o);
    window.addEventListener('global-search:open', onOpen);
    window.addEventListener('global-search:toggle', onToggle);
    return () => {
      window.removeEventListener('global-search:open', onOpen);
      window.removeEventListener('global-search:toggle', onToggle);
    };
  }, []);

  /* Body scroll lock while open — keeps the palette stable on pages
   * with their own scroll containers (reports etc.). */
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;
  return (
    <div className="gs-modal-backdrop" onClick={() => setOpen(false)}>
      <div className="gs-modal" onClick={(e) => e.stopPropagation()}>
        <GlobalSearchPalette variant="modal" onClose={() => setOpen(false)} />
      </div>
    </div>
  );
}

/* Helper exported so callers can open the palette imperatively
 * (e.g. a topbar button). */
export const openGlobalSearch = () => {
  window.dispatchEvent(new Event('global-search:open'));
};

/* ──────────────────────────────────────────────────────────────────────────
 * GlobalSearchTrigger — visible search affordance for the topbar / sidebar.
 *
 * Before this existed, the only discoverable way to reach the palette was
 * a keyboard chord (Cmd+K / Ctrl+K / Alt+G), all of which require knowing
 * the shortcut. New
 * operators on a fresh install never found global search. The trigger sits
 * in chrome and reads "Search…" with the platform-correct shortcut chip,
 * onboarding by sight without taking up a menu slot.
 *
 * Variants:
 *   - 'pill'  — compact, fits next to icon-buttons in the topnav right
 *               cluster. Always shows the kbd hint.
 *   - 'wide'  — fills its parent's width; reads as a fake search input.
 *               Used inside the vertical sidebar between the company
 *               switcher and the menu region.
 *   - 'icon'  — single 34px button (collapsed-sidebar form). No label;
 *               magnifier glyph only with a title tooltip.
 *
 * Clicks fire `global-search:open` — the existing event the modal already
 * listens for — so this hooks into the same code path as the keyboard
 * shortcut without any extra wiring.
 * ────────────────────────────────────────────────────────────────────────── */
function platformShortcut() {
  // Always advertise Alt+G — universal across macOS / Windows / Linux,
  // no shift required, no platform detection branch. The keyboard hook
  // still wires Cmd+K and Ctrl+K (see useKeyboardShortcuts.js) so Mac
  // users with the muscle memory keep working; the chrome just doesn't
  // teach the platform-specific keystroke anymore. One hint, every OS.
  return ['Alt', 'G'];
}

export function GlobalSearchTrigger({ variant = 'pill', className = '' }) {
  const [key1, key2] = platformShortcut();
  const onClick = () => openGlobalSearch();
  // Icon variant — collapsed sidebar / narrow viewports. No label.
  if (variant === 'icon') {
    return (
      <button
        type="button"
        className={`gs-trigger gs-trigger-icon ${className}`}
        onClick={onClick}
        title={`Search (${key1}+${key2})`}
        aria-label="Open global search"
      >
        <SearchOutlined />
      </button>
    );
  }
  // Wide / pill variants — share markup, differ only in width handling
  // via CSS. Both show "Search…" + the platform-correct kbd hint.
  return (
    <button
      type="button"
      className={`gs-trigger gs-trigger-${variant} ${className}`}
      onClick={onClick}
      aria-label="Open global search"
    >
      <SearchOutlined className="gs-trigger-icon-glyph" />
      <span className="gs-trigger-label">Search</span>
      <span className="gs-trigger-kbd" aria-hidden="true">
        <kbd>{key1}</kbd><span className="gs-trigger-plus">+</span><kbd>{key2}</kbd>
      </span>
    </button>
  );
}

export default GlobalSearchPalette;
