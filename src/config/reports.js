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
    id: 'movers',
    name: 'Fast / Slow Movers',
    subtitle: 'Top & bottom by quantity sold',
    category: 'inventory',
    route: '/reports/movers',
    perm: 'reports.view',
    aliases: ['velocity', 'dead stock'],
  },
  {
    id: 'transfer_register',
    name: 'Transfer Register',
    subtitle: 'Godown-to-godown movement log',
    category: 'inventory',
    route: '/reports/transfer-register',
    perm: 'reports.view',
    isNew: true,
  },
  {
    id: 'godown_valuation',
    name: 'Godown Valuation',
    subtitle: 'Per-godown stock value snapshot',
    category: 'inventory',
    route: '/reports/godown-valuation',
    perm: 'reports.view',
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
    id: 'cash_flow',
    name: 'Cash Flow',
    subtitle: 'Cash in vs cash out',
    category: 'financial',
    route: '/reports/cash-flow',
    perm: 'accounts.view',
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
    name: 'Ledger',
    subtitle: 'Voucher-level statement of any chart-of-accounts ledger',
    category: 'financial',
    route: '/reports/ledger',
    perm: 'accounts.view',
    aliases: ['general ledger', 'chart of accounts ledger', 'gl', 'account ledger'],
    isNew: true,
  },
  {
    id: 'aging_report',
    name: 'Aging Report',
    subtitle: 'Party-level bucketed outstanding · 0-30/30-60/60-90/90+',
    category: 'outstanding',
    route: '/reports/aging',
    perm: 'reports.view',
    aliases: ['outstanding', 'receivables aging', 'payables aging'],
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
const BY_ID = REPORTS.reduce((m, r) => ((m[r.id] = r), m), {});
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
