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
  sales:     { label: 'Sales',     icon: 'RiseOutlined',         tone: 'info'    },
  purchase:  { label: 'Purchase',  icon: 'ShoppingCartOutlined', tone: 'warning' },
  inventory: { label: 'Inventory', icon: 'InboxOutlined',        tone: 'success' },
  financial: { label: 'Financial', icon: 'PieChartOutlined',     tone: 'danger'  },
  parties:   { label: 'Parties',   icon: 'TeamOutlined',         tone: 'purple'  },
  tax:       { label: 'Tax / GST', icon: 'FileTextOutlined',     tone: 'teal'    },
};

// Category render order on the hub. Sales first (most-used), then
// Purchase, Inventory (largest group), Financial, Parties, Tax last.
export const CATEGORY_ORDER = ['sales', 'purchase', 'inventory', 'financial', 'parties', 'tax'];

export const REPORTS = [
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

  // ── Inventory ────────────────────────────────────────────────────
  {
    id: 'stock_report',
    name: 'Stock Report',
    subtitle: 'Per-product current stock + value',
    category: 'inventory',
    route: '/reports/stock',
    perm: 'reports.view',
  },
  {
    id: 'stock_summary',
    name: 'Stock Summary',
    subtitle: 'Period opening / in / out / closing',
    category: 'inventory',
    route: '/reports/stock-summary',
    perm: 'reports.view',
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
  {
    id: 'party_ledger',
    name: 'Party Ledger',
    subtitle: 'Per-customer / supplier statement',
    category: 'parties',
    route: '/reports/party-ledger',
    perm: 'accounts.view',
  },
  {
    id: 'aging_report',
    name: 'Aging Report',
    subtitle: '0-30 / 30-60 / 60-90 / 90+ buckets',
    category: 'parties',
    route: '/reports/aging',
    perm: 'reports.view',
    aliases: ['outstanding'],
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
