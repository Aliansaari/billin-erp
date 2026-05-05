import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SearchOutlined, ShoppingCartOutlined, InboxOutlined, UserOutlined, TeamOutlined,
  AppstoreOutlined, FileTextOutlined, BankOutlined, BookOutlined, BarChartOutlined,
  SettingOutlined, DollarCircleOutlined, RollbackOutlined, SafetyCertificateOutlined,
  FundOutlined, CreditCardOutlined, ProductOutlined, GoldOutlined, AuditOutlined,
} from '@ant-design/icons';
import { partyAPI, productAPI, ledgerAPI } from '../api';
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
  { id: 'transfer-new', icon: GoldOutlined,         label: 'New stock transfer',        sub: 'Move stock between godowns', group: 'Create',  route: '/stock-transfer/new', keywords: 'stock transfer godown move' },

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
  { id: 'stock-report', icon: AppstoreOutlined,     label: 'Stock report',              sub: 'On-hand by godown',          group: 'Browse',   route: '/stock-report',               keywords: 'stock report on hand inventory godown' },
  { id: 'stock-pro',    icon: AppstoreOutlined,     label: 'Stock report — categories', sub: 'Category-wise drilldown',    group: 'Browse',   route: '/stock-report-pro',           keywords: 'stock category report' },
  { id: 'transfers',    icon: GoldOutlined,         label: 'Stock transfers',           sub: 'Inter-godown movement',      group: 'Browse',   route: '/stock-transfers',            keywords: 'stock transfer godown' },
  { id: 'batches',      icon: AppstoreOutlined,     label: 'Batches',                   sub: 'Batch / expiry tracking',    group: 'Browse',   route: '/inventory/batches',          keywords: 'batch expiry mfg manufacturing lot' },
  { id: 'jv-list',      icon: AuditOutlined,        label: 'Journal vouchers',          sub: 'Manual entries',             group: 'Browse',   route: '/accounts/journal',           keywords: 'journal voucher manual entry' },

  // Reports
  { id: 'reports',      icon: BarChartOutlined,     label: 'Reports hub',               sub: 'All reports — searchable',   group: 'Reports',  route: '/reports',      kbd: 'Alt+R', keywords: 'reports hub all' },
  { id: 'r-sales',      icon: BarChartOutlined,     label: 'Sales report',              sub: 'Bill-level sales',           group: 'Reports',  route: '/reports/sales',              keywords: 'sales report' },
  { id: 'r-purc',       icon: BarChartOutlined,     label: 'Purchase report',           sub: 'Bill-level purchases',       group: 'Reports',  route: '/reports/purchases',          keywords: 'purchase report' },
  { id: 'r-day',        icon: BookOutlined,         label: 'Day book',                  sub: 'All vouchers by day',        group: 'Reports',  route: '/reports/day-book',           keywords: 'day book daybook journal' },
  { id: 'r-ledger',     icon: BookOutlined,         label: 'Ledger statement',          sub: 'COA ledger — pick to drill', group: 'Reports',  route: '/reports/ledger',             keywords: 'ledger statement coa chart account' },
  { id: 'r-tb',         icon: BookOutlined,         label: 'Trial balance',             sub: 'Tally-style closing',        group: 'Reports',  route: '/reports/trial-balance',      keywords: 'trial balance tb' },
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
  { id: 'r-fast',       icon: BarChartOutlined,     label: 'Fast / slow stock',         sub: 'Movers vs sleepers',         group: 'Reports',  route: '/reports/fast-slow-stock',    keywords: 'fast slow movers sleepers stock' },
  { id: 'r-expiry',     icon: AppstoreOutlined,     label: 'Expiry report',             sub: 'Batches near expiry',        group: 'Reports',  route: '/reports/expiry',             keywords: 'expiry batch near' },

  // Banks & loans
  { id: 'banks',        icon: BankOutlined,         label: 'Banks',                     sub: 'All bank accounts',          group: 'Banks',    route: '/banks',                      keywords: 'bank accounts' },
  { id: 'bank-recon',   icon: BankOutlined,         label: 'Bank reconciliation',       sub: 'Match statement to ledger',  group: 'Banks',    route: '/banks/reconciliation',       keywords: 'bank reconciliation match statement' },
  { id: 'loans',        icon: BankOutlined,         label: 'Loans',                     sub: 'All loan ledgers',           group: 'Banks',    route: '/loans',                      keywords: 'loan emi' },
  { id: 'loan-sched',   icon: BankOutlined,         label: 'Loan schedule',             sub: 'Upcoming EMIs',              group: 'Banks',    route: '/loans/schedule',             keywords: 'loan schedule emi upcoming' },

  // Settings
  { id: 's-home',       icon: SettingOutlined,      label: 'Home page',                 sub: 'Settings → Home',            group: 'Settings', route: '/settings/home',              keywords: 'home page settings landing layout customize hide show kpi clock action ribbon greeting' },
  { id: 's-company',    icon: SettingOutlined,      label: 'Company profile',           sub: 'Settings → Company',         group: 'Settings', route: '/settings/company',           keywords: 'company profile gstin pan address settings' },
  { id: 's-users',      icon: SettingOutlined,      label: 'Users & roles',             sub: 'Settings → Users',           group: 'Settings', route: '/settings/users',             keywords: 'users roles permission settings' },
  { id: 's-godowns',    icon: SettingOutlined,      label: 'Godowns',                   sub: 'Settings → Godowns',         group: 'Settings', route: '/settings/godowns',           keywords: 'godown warehouse location' },
  { id: 's-theme',      icon: SettingOutlined,      label: 'Theme',                     sub: 'Settings → Theme',           group: 'Settings', route: '/settings/theme',             keywords: 'theme dark light appearance' },
  { id: 's-modules',    icon: SettingOutlined,      label: 'Module settings',           sub: 'Toggle features on / off',   group: 'Settings', route: '/settings/modules',           keywords: 'module feature toggle settings' },
  { id: 's-import',     icon: SettingOutlined,      label: 'Import / export',           sub: 'Bulk data in / out',         group: 'Settings', route: '/settings/import-export',     keywords: 'import export bulk csv excel' },
  { id: 's-backup',     icon: SettingOutlined,      label: 'Backup & restore',          sub: 'Database snapshots',         group: 'Settings', route: '/settings/backup',            keywords: 'backup restore snapshot db' },
  { id: 's-tally',      icon: SettingOutlined,      label: 'Tally sync',                sub: 'Push to Tally',              group: 'Settings', route: '/settings/tally',             keywords: 'tally sync export' },
  { id: 's-print',      icon: SettingOutlined,      label: 'Print settings',            sub: 'Invoice templates',          group: 'Settings', route: '/settings/print',             keywords: 'print template invoice paper' },
  { id: 'integrity',    icon: SafetyCertificateOutlined, label: 'Ledger integrity',     sub: 'Reconcile double-entry',     group: 'Settings', route: '/accounts/integrity',         keywords: 'ledger integrity check reconcile audit' },
];

/* Match score for an action against a query.
 * Higher = better match. Returns null if no match.
 *
 * Scoring philosophy:
 *   - exact label match → top
 *   - label starts-with → next
 *   - any word in label/keywords starts-with → next
 *   - substring anywhere → fallback
 * That ordering makes "sale" match "Sales bills" before "Wholesale return". */
function scoreAction(a, q) {
  if (!q) return null;
  const Q = q.toLowerCase().trim();
  const L = a.label.toLowerCase();
  const K = (a.keywords || '').toLowerCase();
  const S = (a.sub || '').toLowerCase();
  if (L === Q) return 1000;
  if (L.startsWith(Q)) return 800;
  // Word-boundary starts-with anywhere in label/keywords
  const words = (L + ' ' + K + ' ' + S).split(/[\s\-/]+/);
  if (words.some(w => w.startsWith(Q))) return 500;
  if (L.includes(Q)) return 300;
  if (K.includes(Q)) return 200;
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
  const tieBreak = ['Create', 'Customers', 'Suppliers', 'Ledgers', 'Products', 'Browse', 'Reports', 'Banks', 'Settings'];
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

/* ── Recent picks — track the last 6 actions/parties so an empty palette
 * shows something useful instead of a static splash. Persisted in
 * localStorage so it survives reloads. */
const RECENT_KEY = 'gs_recent_v1';
function readRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function pushRecent(item) {
  try {
    const list = readRecent().filter(r => r.id !== item.id);
    list.unshift({ id: item.id, label: item.label, sub: item.sub, route: item.route, group: item.group, kind: item.kind });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6)));
  } catch { /* swallow */ }
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
  const inputRef = useRef(null);
  const listRef  = useRef(null);
  const [query,   setQuery]   = useState('');
  const [parties, setParties] = useState([]);
  const [products, setProds]  = useState([]);
  const [ledgers, setLedgers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSel] = useState(0);
  const [recent] = useState(() => readRecent());

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
    if (!query || query.length < 2) {
      setParties([]); setProds([]); setLedgers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const [pRes, prRes, lRes] = await Promise.allSettled([
          partyAPI.getAll({ search: query, limit: 6 }),
          productAPI.search(query, { limit: 6 }),
          ledgerAPI.listAccounts({ search: query, exclude_party_ledgers: '1' }),
        ]);
        if (cancelled) return;
        const pData  = pRes.status  === 'fulfilled' ? (pRes.value.data?.data  || pRes.value.data  || []) : [];
        const prData = prRes.status === 'fulfilled' ? (prRes.value.data?.data || prRes.value.data || []) : [];
        const lData  = lRes.status  === 'fulfilled' ? (lRes.value.data?.data  || lRes.value.data  || []) : [];
        setParties(Array.isArray(pData)  ? pData  : []);
        setProds  (Array.isArray(prData) ? prData : []);
        // Backend doesn't honour a `limit` on /ledger/accounts (it's ordered
        // by group then name and used by COA pickers that want the full
        // list). Cap client-side to keep the palette compact.
        setLedgers(Array.isArray(lData)  ? lData.slice(0, 6) : []);
      } catch { /* swallow — empty results render */ }
      finally { if (!cancelled) setLoading(false); }
    }, 160);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  /* Build the flat result list — mixes typed quick-actions, live parties,
   * live products. Order: parties first (operators usually search for a
   * customer name), then products, then quick actions. */
  const groupedResults = useMemo(() => {
    const out = [];
    const q = query.trim();

    // Parties → split into Customer / Supplier sections so the verbs
    // ("New bill to X", "Receipt from X") read naturally.
    for (const p of parties) {
      const id = `party-${p.party_id || p.id}`;
      const isCust = (p.party_type || 'Customer').toLowerCase().startsWith('cust');
      const balance = Number(p.outstanding_balance || p.balance || 0);
      const balLabel = balance > 0
        ? `${isCust ? 'Receivable' : 'Payable'} ₹${Math.abs(Math.round(balance)).toLocaleString('en-IN')}`
        : balance < 0 ? `Advance ₹${Math.abs(Math.round(balance)).toLocaleString('en-IN')}` : 'Squared';
      const pid = p.party_id || p.id;
      // Route to the proper Customer / Supplier Statement page (not the
      // retired /parties/:id detail view). The statement pages accept
      // ?id=<party_id> and pre-select the party in their picker.
      const statementRoute = isCust
        ? `/reports/customer-statement?id=${pid}`
        : `/reports/supplier-statement?id=${pid}`;
      out.push({
        id, kind: 'party',
        icon: isCust ? UserOutlined : TeamOutlined,
        label: p.party_name,
        sub: [p.city, p.gstin, balLabel].filter(Boolean).join(' · '),
        group: isCust ? 'Customers' : 'Suppliers',
        route: statementRoute,
      });
    }

    // Ledgers (COA — Sales A/c, Bank, Office Rent, etc.). Party ledgers
    // are filtered out at the API call (?exclude_party_ledgers=1) so a
    // customer never appears here in addition to the Customers section.
    for (const l of ledgers) {
      const lid = l.ledger_id;
      const balance = Number(l.current_balance || 0);
      const balLabel = balance !== 0
        ? `₹${Math.abs(Math.round(balance)).toLocaleString('en-IN')} ${balance > 0 ? 'Dr' : 'Cr'}`
        : null;
      out.push({
        id: `ledger-${lid}`, kind: 'ledger',
        icon: BookOutlined,
        label: l.ledger_name,
        sub: [l.ledger_group, l.sub_group, balLabel].filter(Boolean).join(' · '),
        group: 'Ledgers',
        // Land on the COA Ledger Statement with this ledger preselected.
        // Same picker / period chips / print path as Customer & Supplier
        // Statement, just keyed off ledger_id instead of party_id.
        route: `/reports/ledger?id=${lid}`,
      });
    }

    // Products
    for (const pr of products) {
      const id = `prod-${pr.product_id || pr.id}`;
      const stock = Number(pr.current_stock ?? pr.stock_qty ?? 0);
      const price = Number(pr.sale_price ?? pr.mrp ?? 0);
      out.push({
        id, kind: 'product',
        icon: ProductOutlined,
        label: pr.product_name,
        sub: [pr.sku, pr.category_name, price ? `₹${Math.round(price).toLocaleString('en-IN')}` : null, `${stock} in stock`].filter(Boolean).join(' · '),
        group: 'Products',
        route: `/stock-movement/${pr.product_id || pr.id}`,
      });
    }

    // Quick actions / pages
    if (q) {
      const matches = ACTIONS
        .map(a => ({ a, s: scoreAction(a, q) }))
        .filter(x => x.s != null)
        .sort((x, y) => y.s - x.s)
        .slice(0, 14)
        .map(x => ({
          id: x.a.id, kind: 'action',
          icon: x.a.icon, label: x.a.label, sub: x.a.sub,
          group: x.a.group, route: x.a.route, kbd: x.a.kbd,
          /* Carried into groupResults so groups with higher-scoring items
           * bubble to the top. Stripped before render — readers ignore
           * unknown props on the row object. */
          _score: x.s,
        }));
      out.push(...matches);
    }

    return groupResults(out);
  }, [query, parties, products, ledgers]);

  /* Flat list (for keyboard nav) — order matches what's rendered. */
  const flat = useMemo(() => groupedResults.flatMap(g => g.items), [groupedResults]);

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

  const choose = (item) => {
    if (!item) return;
    pushRecent(item);
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
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[selectedIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else onClose?.();
    }
  };

  /* What renders when the input is empty:
   *   - Modal (⌘K): a "recent + try this" panel so the palette is never
   *     just an empty box — the user just opened it deliberately, they
   *     want suggestions.
   *   - Hero (home page): nothing. The bar lives alone above the fold;
   *     pre-loaded suggestions felt like clutter on a landing page.
   *     Once the user types one character, results render normally. */
  const emptyState = !query.trim();
  const showSuggestions = emptyState && variant !== 'hero';
  const showRecent = showSuggestions && recent.length > 0;
  const trySuggestions = showSuggestions ? [
    ACTIONS.find(a => a.id === 'sale-new'),
    ACTIONS.find(a => a.id === 'purchase-new'),
    ACTIONS.find(a => a.id === 'reports'),
    ACTIONS.find(a => a.id === 'r-day'),
    ACTIONS.find(a => a.id === 'customers'),
    ACTIONS.find(a => a.id === 'r-tb'),
  ].filter(Boolean).map(a => ({
    id: a.id, kind: 'action', icon: a.icon, label: a.label, sub: a.sub,
    group: a.group, route: a.route, kbd: a.kbd,
  })) : [];

  const hasAnything = !emptyState && flat.length > 0;
  const noMatch = !emptyState && flat.length === 0 && !loading;

  return (
    <div className={`gs gs-${variant}`} onKeyDown={onKey}>
      <div className="gs-input-wrap">
        <SearchOutlined className="gs-input-icon" />
        <input
          ref={inputRef}
          className="gs-input"
          placeholder="Search anything — customers, products, bills, reports…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {variant === 'hero' ? (
          <span className="gs-input-hint">
            <kbd className="gs-kbd">⌘</kbd><kbd className="gs-kbd">K</kbd>
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
        {loading && !hasAnything && (
          <div className="gs-status">Searching…</div>
        )}

        {hasAnything && groupedResults.map((g) => (
          <GsGroup
            key={g.name}
            name={g.name}
            items={g.items}
            startIdx={flat.indexOf(g.items[0])}
            selectedIdx={selectedIdx}
            onPick={choose}
            onHover={setSel}
          />
        ))}

        {showRecent && (
          <GsGroup
            name="Recent"
            items={recent.map(r => ({ ...r, icon: ACTIONS.find(a => a.id === r.id)?.icon || FileTextOutlined }))}
            startIdx={0}
            selectedIdx={-1}
            onPick={choose}
            onHover={() => {}}
          />
        )}

        {showSuggestions && (
          <GsGroup
            name={recent.length ? 'Try' : 'Quick start'}
            items={trySuggestions}
            startIdx={recent.length}
            selectedIdx={-1}
            onPick={choose}
            onHover={() => {}}
          />
        )}

        {noMatch && (
          <div className="gs-empty">
            <div className="gs-empty-title">Nothing matches "{query}"</div>
            <div className="gs-empty-sub">Try a customer name, product SKU, or report title.</div>
          </div>
        )}
      </div>
      )}

      <div className="gs-footer">
        <span><kbd className="gs-kbd">↑</kbd><kbd className="gs-kbd">↓</kbd> navigate</span>
        <span><kbd className="gs-kbd">↵</kbd> open</span>
        <span><kbd className="gs-kbd">esc</kbd> {variant === 'modal' ? 'close' : 'clear'}</span>
        <span className="gs-footer-spacer" />
        <span className="gs-footer-brand">Billing ERP · global search</span>
      </div>
    </div>
  );
}

/* Single section in the result list. Renders a small group-header plus
 * the rows. Index is the absolute index in the flat list (so keyboard
 * highlight survives jumping across groups). */
function GsGroup({ name, items, startIdx, selectedIdx, onPick, onHover }) {
  return (
    <div className="gs-group">
      <div className="gs-group-name">{name}</div>
      {items.map((item, i) => {
        const idx = startIdx + i;
        const Icon = item.icon || FileTextOutlined;
        return (
          <div
            key={item.id}
            data-idx={idx}
            className={`gs-row ${selectedIdx === idx ? 'is-selected' : ''}`}
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
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * GlobalSearchHero — the embedded variant on the home page. No modal
 * chrome, just the palette in a glassy card.
 * ────────────────────────────────────────────────────────────────────────── */
export function GlobalSearchHero({ autoFocus = true }) {
  return (
    <div className="gs-hero-wrap">
      <GlobalSearchPalette variant="hero" autoFocus={autoFocus} />
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

export default GlobalSearchPalette;
