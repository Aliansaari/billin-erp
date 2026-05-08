/*
 * Report registry — single source of truth for the Reports module.
 *
 * Every report on the hub (/reports), every entry in the favorites
 * dropdown, and every search match resolves through this array.
 * Adding a new report = a 2-line append here, plus the existing
 * route definition. Removing a report = drop one line + delete the
 * route. The hub page, the nav dropdown, and the favorites store
 * never hardcode anything that isn't here.
 *
 * Route values are pinned to the EXISTING paths the app uses today
 * (verified via grep against src/App.jsx). Do not change any `route`
 * value without a parallel rename in App.jsx — every existing deep
 * link, bookmark, and nav-list entry depends on these.
 *
 * 17 reports across 6 categories:
 *   Sales (1) · Purchase (1) · Inventory (5) · Financial (5) ·
 *   Parties (2) · Tax / GST (3)
 *
 * The "Sales register" / "Purchase register" reports the spec
 * mentioned were folded into Sales / Purchase Report (one route
 * carries both views — see comment in server/routes/reports.js).
 * Day Book, Transfer Register, Godown Valuation are present in
 * the live app and added here.
 */

// Category meta — colours match the existing dashboard tier palette
// (terracotta / gold / sage / warm slate / accent). Icons are AntD
// names — actual icon components are imported by the consumer to
// avoid pulling icon weight into the registry itself.
export const CATEGORY_META = {
  outstanding:       { label: 'Outstanding',       icon: 'AlertOutlined',       tone: 'danger'  },
  periodic_summary:  { label: 'Periodic Summary',  icon: 'CalendarOutlined',    tone: 'info'    },
  sales:             { label: 'Sales',             icon: 'RiseOutlined',        tone: 'info'    },
  purchase:          { label: 'Purchase',          icon: 'ShoppingCartOutlined',tone: 'warning' },
  inventory:         { label: 'Inventory',         icon: 'InboxOutlined',       tone: 'success' },
  financial:         { label: 'Financial',         icon: 'PieChartOutlined',    tone: 'danger'  },
  parties:           { label: 'Parties',           icon: 'TeamOutlined',        tone: 'purple'  },
  tax:               { label: 'Tax / GST',         icon: 'FileTextOutlined',    tone: 'teal'    },
};

// Category render order on the hub. Outstanding first (checked daily —
// these are the bills currently bleeding cash). Periodic Summary next
// (monthly trends — operators check pulse here). Then per-domain
// reports.
export const CATEGORY_ORDER = ['outstanding', 'periodic_summary', 'sales', 'purchase', 'inventory', 'financial', 'parties', 'tax'];

export const REPORTS = [
  // ── Outstanding ──────────────────────────────────────────────────
  // Bill-LEVEL outstanding (cf. Aging which is party-level). Checked
  // daily — surfaced first on the hub.
  {
    id: 'bills_receivable',
    name: 'Bills Receivable',
    subtitle: 'Unpaid customer bills · bill-level',
    category: 'outstanding',
    route: '/reports/bills-receivable',
    perm: 'reports.view',
    aliases: ['receivable', 'br', 'unpaid sales', 'debtors bills'],
    isNew: true,
  },
  {
    id: 'bills_payable',
    name: 'Bills Payable',
    subtitle: 'Unpaid supplier bills · bill-level',
    category: 'outstanding',
    route: '/reports/bills-payable',
    perm: 'reports.view',
    aliases: ['payable', 'bp', 'unpaid purchases', 'creditors bills'],
    isNew: true,
  },
  // Party-level siblings — same data and the same page component, but
  // landing on the customer / supplier rollup view by default. Either
  // can flip to bill-level via the segmented pill in the header. Two
  // entries instead of "let users find the toggle" because the
  // accountant searches "outstanding by customer" as one phrase.
  {
    id: 'customer_outstanding',
    name: 'Customer Outstanding',
    subtitle: 'Outstanding by customer · expand for bill detail',
    category: 'outstanding',
    route: '/reports/customer-outstanding',
    perm: 'reports.view',
    aliases: ['customer outstanding', 'debtors', 'outstanding by customer'],
    isNew: true,
  },
  {
    id: 'supplier_outstanding',
    name: 'Supplier Outstanding',
    subtitle: 'Outstanding by supplier · expand for bill detail',
    category: 'outstanding',
    route: '/reports/supplier-outstanding',
    perm: 'reports.view',
    aliases: ['supplier outstanding', 'creditors', 'outstanding by supplier'],
    isNew: true,
  },

  // ── Periodic Summary (R10) ───────────────────────────────────────
  // Tally-style monthly registers. Each row = month, columns = Dr / Cr
  // / Closing-Balance with running ledger total. Each register has a
  // "Compare with…" toggle to overlay a second register's columns
  // alongside the primary (Sales↔Purchase, Receipt↔Payment, etc).
  {
    id: 'monthly_sales_register',
    name: 'Sales Register',
    subtitle: 'Monthly summary · Sales Account',
    category: 'periodic_summary',
    route: '/reports/monthly-sales',
    perm: 'reports.view',
    aliases: ['monthly sales', 'sales register', 'sales by month'],
    isNew: true,
  },
  {
    id: 'monthly_purchase_register',
    name: 'Purchase Register',
    subtitle: 'Monthly summary · Purchase Account',
    category: 'periodic_summary',
    route: '/reports/monthly-purchases',
    perm: 'reports.view',
    aliases: ['monthly purchase', 'purchase register', 'purchase by month'],
    isNew: true,
  },
  {
    id: 'monthly_payment_register',
    name: 'Payment Register',
    subtitle: 'Monthly summary · Payment vouchers',
    category: 'periodic_summary',
    route: '/reports/monthly-payments',
    perm: 'reports.view',
    aliases: ['monthly payment', 'payment register', 'payments by month'],
    isNew: true,
  },
  {
    id: 'monthly_receipt_register',
    name: 'Receipt Register',
    subtitle: 'Monthly summary · Receipt vouchers',
    category: 'periodic_summary',
    route: '/reports/monthly-receipts',
    perm: 'reports.view',
    aliases: ['monthly receipt', 'receipt register', 'receipts by month'],
    isNew: true,
  },

  // ── Sales ────────────────────────────────────────────────────────
  {
    id: 'sales_report',
    name: 'Sales Report',
    subtitle: 'By date / customer / item',
    category: 'sales',
    route: '/reports/sales',
    perm: 'reports.view',
    aliases: ['sales register', 'invoice'],
  },
  {
    id: 'product_sales_detail',
    name: 'Product Sales Detail',
    subtitle: 'Per-line item · with profit',
    category: 'sales',
    route: '/reports/product-sales',
    perm: 'reports.view',
    aliases: ['product sales', 'item sales', 'sales by product', 'sales line items'],
    isNew: true,
  },

  // ── Purchase ─────────────────────────────────────────────────────
  {
    id: 'purchase_report',
    name: 'Purchase Report',
    subtitle: 'By supplier / item',
    category: 'purchase',
    route: '/reports/purchases',
    perm: 'reports.view',
    aliases: ['purchase register'],
  },
  {
    id: 'product_purchase_detail',
    name: 'Product Purchase Detail',
    subtitle: 'Per-line item · with line value',
    category: 'purchase',
    route: '/reports/product-purchases',
    perm: 'reports.view',
    aliases: ['product purchase', 'item purchase', 'purchase by product', 'purchase line items'],
    isNew: true,
  },

  // ── Inventory ────────────────────────────────────────────────────
  // Stock Report routes to the inventory-menu page (the duplicate
  // /reports/stock and /reports/stock-summary pages were removed).
  // Period opening/in/out/closing data lives there too via the
  // movement-period range picker.
  {
    id: 'stock_report',
    name: 'Stock Report',
    subtitle: 'Per-product stock, value, inward / outward',
    category: 'inventory',
    route: '/stock-report',
    perm: 'inventory.view',
    aliases: ['stock summary'],
  },
  {
    id: 'smart_stock',
    name: 'Smart Stock',
    subtitle: 'Category-grouped stock with bulk edit',
    category: 'inventory',
    route: '/stock-report-pro',
    perm: 'inventory.view',
    aliases: ['category stock', 'stock pro'],
  },
  {
    id: 'stock_movement',
    name: 'Stock Movement',
    subtitle: 'Per-product inward / outward history',
    category: 'inventory',
    route: '/stock-movement',
    perm: 'inventory.view',
    aliases: ['movement', 'transactions', 'ledger'],
  },
  {
    id: 'fast_slow_stock',
    // Legacy id retained so any UserReportFavorite row that pre-dates
    // the rename still resolves. The server-side migration in
    // server/index.js bulk-renames `report_id='movers'` → 'fast_slow_stock'
    // on boot; legacy_ids is the in-flight safety net + a long-term
    // marker so the next dev knows what was renamed.
    legacy_ids: ['movers'],
    name: 'Fast & Slow Stock',
    subtitle: 'Velocity & cover · fast / slow / dead classification',
    category: 'inventory',
    route: '/reports/fast-slow-stock',
    perm: 'reports.view',
    // Aliases drive the Reports Hub search. Cover every word a user
    // might type — "stock" + "movers" are the canonical pair, but
    // velocity / cover / dead / aging / abc all surface this report.
    aliases: [
      'stock', 'movers', 'moving', 'movement',
      'fast', 'slow', 'dead', 'dead stock',
      'velocity', 'turnover', 'cover',
      'reorder', 'discount', 'inventory analysis',
      'abc', 'pareto',
    ],
  },
  {
    id: 'transfer_register',
    name: 'Transfer Register',
    subtitle: 'Godown-to-godown movement log',
    category: 'inventory',
    route: '/reports/transfer-register',
    perm: 'reports.view',
    flag: 'multi_warehouse_enabled',
    isNew: true,
  },
  {
    id: 'godown_valuation',
    name: 'Godown Valuation',
    subtitle: 'Per-godown stock value snapshot',
    category: 'inventory',
    route: '/reports/godown-valuation',
    perm: 'reports.view',
    flag: 'multi_warehouse_enabled',
    isNew: true,
  },
  // Expiry Report (Commit 5) — bucketed view of every batch with an
  // expiry date, plus a "no expiry" group. Same editorial-report skin
  // as Sales Report. perm: 'batches.view' so it hides when the global
  // batch toggle is OFF / role lacks the perm.
  {
    id: 'expiry_report',
    name: 'Expiry Report',
    subtitle: 'Batches by expiry bucket · expired / 0-30 / 31-60 / 61-90 / 91+',
    category: 'inventory',
    route: '/reports/expiry',
    perm: 'batches.view',
    aliases: ['expiry', 'batch expiry', 'shelf life', 'stock expiry', 'expired'],
    isNew: true,
  },

  // ── Financial ────────────────────────────────────────────────────
  {
    id: 'day_book',
    name: 'Day Book',
    subtitle: 'Chronological voucher list',
    category: 'financial',
    route: '/reports/day-book',
    perm: 'accounts.view',
  },
  {
    id: 'profit_loss',
    name: 'Profit & Loss',
    subtitle: 'Revenue minus expenses',
    category: 'financial',
    route: '/reports/profit-loss',
    perm: 'accounts.view',
    aliases: ['p&l', 'pnl', 'profit', 'loss'],
  },
  {
    id: 'balance_sheet',
    name: 'Balance Sheet',
    subtitle: 'Assets · liabilities · equity (as-of date)',
    category: 'financial',
    route: '/reports/balance-sheet',
    perm: 'accounts.view',
    aliases: ['bs'],
  },
  {
    id: 'trial_balance',
    name: 'Trial Balance',
    subtitle: 'Group/sub-group ledger balances',
    category: 'financial',
    route: '/reports/trial-balance',
    perm: 'accounts.view',
    aliases: ['tb'],
  },
  {
    id: 'banks',
    name: 'Banks',
    subtitle: 'Bank balances · statements · reconciliation',
    category: 'financial',
    route: '/banks',
    perm: 'accounts.view',
    aliases: ['bank', 'bank statement', 'reconcile', 'cheques', 'cleared', 'uncleared'],
  },
  {
    id: 'loans',
    name: 'Loans',
    subtitle: 'Loan tracking · EMI schedule · interest paid',
    category: 'financial',
    route: '/loans',
    perm: 'accounts.view',
    aliases: ['loan', 'emi', 'interest', 'principal', 'amortization', 'borrowing', 'lending', 'debt'],
  },
  {
    id: 'loan_schedule',
    name: 'Loan Schedule',
    subtitle: 'Upcoming + overdue EMIs across all loans',
    category: 'financial',
    route: '/loans/schedule',
    perm: 'accounts.view',
    aliases: ['emi', 'overdue emi', 'upcoming emi', 'amortization', 'loan due'],
  },
  {
    id: 'cash_flow',
    name: 'Cash Flow',
    subtitle: 'Cash in vs cash out',
    category: 'financial',
    route: '/reports/cash-flow',
    perm: 'accounts.view',
  },
  {
    id: 'fund_flow',
    name: 'Fund Flow',
    subtitle: 'Working-capital changes · sources & applications',
    category: 'financial',
    route: '/reports/fund-flow',
    perm: 'accounts.view',
    aliases: ['ff', 'funds', 'working capital'],
  },

  // ── Parties ──────────────────────────────────────────────────────
  // Customer / Supplier Statement replaced the old combined Party
  // Ledger. The split mirrors the workflow split: Customer Statement
  // is sent OUT to a customer (collection follow-up, year-end recon);
  // Supplier Statement is reconciled IN against a statement the
  // supplier sent us. Different print headers, different defaults,
  // different mental model. The old route still resolves via a
  // redirect — see App.jsx <PartyLedgerRedirect>.
  {
    id: 'customer_statement',
    name: 'Customer Statement',
    subtitle: 'Per-customer account-of-record · sales / receipts / returns',
    category: 'parties',
    route: '/reports/customer-statement',
    perm: 'accounts.view',
    aliases: ['party ledger', 'customer ledger', 'customer account', 'debtor statement'],
    isNew: true,
  },
  {
    id: 'supplier_statement',
    name: 'Supplier Statement',
    subtitle: 'Per-supplier account-of-record · purchases / payments / returns',
    category: 'parties',
    route: '/reports/supplier-statement',
    perm: 'accounts.view',
    aliases: ['supplier ledger', 'creditor statement', 'vendor statement'],
    isNew: true,
  },
  // Chart-of-accounts ledger drill — Sales A/c, Bank, Office Rent,
  // every JV-targetable ledger. Listed under Financial because it's
  // an internal accountant tool, not a customer-facing document.
  {
    id: 'ledger',
    name: 'Ledger Statement',
    subtitle: 'Voucher-level statement of any chart-of-accounts ledger',
    category: 'financial',
    route: '/reports/ledger',
    perm: 'accounts.view',
    aliases: ['ledger', 'general ledger', 'chart of accounts ledger', 'gl', 'account ledger'],
    isNew: true,
  },
  // Bucketed aging — split into customer / supplier flavors so the
  // hub search "payables aging" lands directly on the supplier side.
  // Same shared <AgingReport> engine; the menu entry just fixes the
  // partyType. Legacy /reports/aging route still works (lands on
  // Receivables) so old bookmarks don't 404.
  {
    id: 'receivables_aging',
    name: 'Receivables Aging',
    subtitle: 'Customer-level bucketed outstanding · 0-30 / 30-60 / 60-90 / 90+',
    category: 'outstanding',
    route: '/reports/receivables-aging',
    perm: 'reports.view',
    aliases: ['aging', 'receivables', 'customer aging', 'debtors aging'],
    isNew: true,
  },
  {
    id: 'payables_aging',
    name: 'Payables Aging',
    subtitle: 'Supplier-level bucketed outstanding · 0-30 / 30-60 / 60-90 / 90+',
    category: 'outstanding',
    route: '/reports/payables-aging',
    perm: 'reports.view',
    aliases: ['aging', 'payables', 'supplier aging', 'creditors aging'],
    isNew: true,
  },

  // ── Tax / GST ────────────────────────────────────────────────────
  {
    id: 'gstr1',
    name: 'GSTR-1',
    subtitle: 'Outward supplies (B2B / B2C / CDN / HSN)',
    category: 'tax',
    route: '/reports/gstr1',
    perm: 'reports.view',
    aliases: ['gstr 1', 'gst1'],
  },
  {
    id: 'gstr3b',
    name: 'GSTR-3B',
    subtitle: 'Monthly summary, ITC, liability',
    category: 'tax',
    route: '/reports/gstr3b',
    perm: 'reports.view',
    aliases: ['gstr 3b', 'gst3b'],
  },
  {
    id: 'hsn_summary',
    name: 'HSN Summary',
    subtitle: 'HSN aggregation for GSTR-1 Table 12',
    category: 'tax',
    route: '/reports/hsn-summary',
    perm: 'reports.view',
    aliases: ['hsn'],
  },
];

// Lookup helpers — the consumer code shouldn't `find()` over REPORTS.
// BY_ID lookup. Each report registers under its canonical `id` AND
// every `legacy_ids` it lists, so a favourite row stored under an
// old slug still resolves to the right report after a rename. New
// pins always use the canonical id (server migration has run by then).
const BY_ID = REPORTS.reduce((m, r) => {
  m[r.id] = r;
  for (const old of (r.legacy_ids || [])) m[old] = r;
  return m;
}, {});
export function getReportById(id) { return BY_ID[id]; }

export function getReportsByCategory(cat) {
  return REPORTS.filter((r) => r.category === cat);
}

// Resolve a list of report ids (in any order) into the canonical REPORTS
// shape, preserving the input order. Used by the favorites store +
// dropdown which both want the user's pinned-order honoured.
export function resolveReports(ids) {
  return (ids || []).map((id) => BY_ID[id]).filter(Boolean);
}

// Search predicate — case-insensitive; matches name, subtitle, category
// label, and aliases. Caller provides the query; this returns a function
// the array can be filtered with.
export function matchReport(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return () => true;
  return (r) => {
    if (r.name.toLowerCase().includes(q)) return true;
    if (r.subtitle.toLowerCase().includes(q)) return true;
    const catLabel = CATEGORY_META[r.category]?.label?.toLowerCase() || '';
    if (catLabel.includes(q)) return true;
    if ((r.aliases || []).some((a) => a.toLowerCase().includes(q))) return true;
    return false;
  };
}
