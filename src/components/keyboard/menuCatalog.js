// Classic keyboard-driven Alt-letter menu catalog.
//
// Maps a physical key code (e.code, so Mac's Option dead-keys don't
// break it) to the menu that should pop open.
//
// Each menu lists items with a letter shortcut; pressing that letter
// inside the open menu picks the item. The first letter of an item
// label that's UNIQUE within the menu is the natural pick — but the
// letter doesn't have to be the first letter, just unique within the
// menu, so "Sales List" can be `L` even though the label starts
// with S (which is taken by "Sale").
//
// Routes here are the canonical destinations — keep them in sync
// with src/App.jsx Routes if a path moves.

// Each menu carries an `anchorKey` matching the data-shortcut-key on
// the corresponding Sidebar / TopNav menu item, so the popup opens
// next to it instead of centered.
export const ALT_MENUS = {
  // Alt+H = Home — single-item "menu", just routes to /. Kept here
  // for symmetry with the others; the global hook short-circuits
  // and navigates directly without opening a popup when the menu has
  // exactly one item.
  KeyH: {
    title: 'Home',
    anchorKey: '/',
    items: [
      { letter: 'H', label: 'Home',      sub: 'Command Center',     route: '/' },
    ],
  },
  KeyD: {
    title: 'Dashboard',
    anchorKey: '/dashboard',
    items: [
      { letter: 'D', label: 'Dashboard', sub: '9-tile metrics view', route: '/dashboard' },
    ],
  },

  KeyS: {
    title: 'Sales',
    anchorKey: 'sales-menu',
    items: [
      { letter: 'S', label: 'Sale',              sub: 'New customer invoice',    route: '/sale/new' },
      { letter: 'L', label: 'Sales List',        sub: 'All customer bills',      route: '/sales' },
      // C for Collection / Cash-in (R is taken by Sales Returns below).
      // The standalone Alt+M Payments menu was retired; receipts live
      // here now so the natural sale→receive-money flow is one menu,
      // not two. Ctrl+N still works as a direct shortcut to /receipt/new
      // for operators who skip the menu entirely.
      { letter: 'C', label: 'Receipt',           sub: 'Money in from customer',  route: '/receipt/new' },
      { letter: 'T', label: 'Receipt List',      sub: 'All receipts received',   route: '/payments?transaction_type=Receipt' },
      { letter: 'N', label: 'New Sales Return',  sub: 'Credit note',             route: '/sales-return/new' },
      { letter: 'R', label: 'Sales Returns',     sub: 'All credit notes',        route: '/sales-returns' },
    ],
  },

  KeyP: {
    title: 'Purchase',
    anchorKey: 'purchase-menu',
    items: [
      { letter: 'P', label: 'Purchase',             sub: 'New supplier bill',      route: '/purchase/new' },
      { letter: 'L', label: 'Purchase List',        sub: 'All supplier bills',     route: '/purchases' },
      // M for Money-out / Make Payment. Mirrors C in the Sales menu — both
      // sit one row below their list, both route into the Payments module
      // but live here because that's the operator's mental model.
      { letter: 'M', label: 'Payment',              sub: 'Money out to supplier',  route: '/payment/new' },
      { letter: 'T', label: 'Payment List',         sub: 'All payments made',      route: '/payments?transaction_type=Payment' },
      { letter: 'N', label: 'New Purchase Return',  sub: 'Debit note',             route: '/purchase-return/new' },
      { letter: 'R', label: 'Purchase Returns',     sub: 'All debit notes',        route: '/purchase-returns' },
    ],
  },

  // Alt+E for parti**E**s (S is taken by Sales, P by Purchase).
  KeyE: {
    title: 'Parties',
    anchorKey: 'parties-menu',
    items: [
      // "New X" entries route to the list page with ?new=1; the list
      // page reads the param on mount and auto-opens its create modal.
      { letter: 'N', label: 'New Customer', sub: 'Add a new customer',  route: '/customers?new=1' },
      { letter: 'A', label: 'Add Supplier', sub: 'Add a new supplier',  route: '/suppliers?new=1' },
      { letter: 'C', label: 'Customers',    sub: 'Party master',        route: '/customers' },
      { letter: 'S', label: 'Suppliers',    sub: 'Vendor master',       route: '/suppliers' },
    ],
  },

  KeyI: {
    title: 'Inventory',
    anchorKey: 'inventory-menu',
    items: [
      { letter: 'N', label: 'New Product',      sub: 'Add a new product',   route: '/products?new=1' },
      { letter: 'A', label: 'Add Category',     sub: 'Add a new category',  route: '/categories?new=1' },
      { letter: 'P', label: 'Products',         sub: 'Item master',         route: '/products' },
      { letter: 'C', label: 'Categories',       sub: 'Product categories',  route: '/categories' },
      { letter: 'M', label: 'Stock Movement',   sub: 'Transaction history', route: '/stock-movement' },
      { letter: 'R', label: 'Stock Report',     sub: 'On-hand by godown',   route: '/stock-report' },
      { letter: 'S', label: 'Smart Stock',      sub: 'Category drill-down', route: '/stock-report-pro' },
      { letter: 'T', label: 'Stock Transfers',  sub: 'Inter-godown moves',  route: '/stock-transfers' },
      { letter: 'B', label: 'Batches',          sub: 'Batch tracking',      route: '/inventory/batches' },
    ],
  },

  // Alt+M (Payments menu) retired — Receipt moved to Alt+S → C, Payment
  // moved to Alt+P → M, the unified transactions list is reachable from
  // either (Alt+S → T for receipts, Alt+P → T for payments). The direct
  // CTRL_DIRECT['KeyM'] = '/payment/new' below stays put — Ctrl+M still
  // jumps straight to the payment form for operators who want a single
  // chord, no menu.

  KeyB: {
    title: 'Bank',
    anchorKey: 'bank-menu',
    items: [
      { letter: 'A', label: 'Accounts',       sub: 'Bank ledgers',        route: '/banks' },
      { letter: 'R', label: 'Reconciliation', sub: 'Uncleared cheques',   route: '/banks/reconciliation' },
      { letter: 'L', label: 'Loans',          sub: 'Loan ledgers',        route: '/loans' },
      { letter: 'S', label: 'Loan Schedule',  sub: 'Upcoming EMIs',       route: '/loans/schedule' },
    ],
  },

  KeyA: {
    // Title shown in the Alt+A popup header. Internal anchorKey stays
    // 'accounts-menu' so it still resolves to the sidebar's accounts-menu
    // anchor after the rename — the user-visible label is the only thing
    // that changed.
    title: 'Books',
    anchorKey: 'accounts-menu',
    items: [
      { letter: 'J', label: 'New Journal',      sub: 'Manual entry',     route: '/accounts/journal/new' },
      { letter: 'V', label: 'Journal Vouchers', sub: 'All vouchers',     route: '/accounts/journal' },
      // `flag` mirrors the sidebar's menuConfig — when the named system
      // setting is OFF (and dev mode isn't bypassing) the item is
      // filtered out of the Alt-letter popup, the collapsed-sidebar
      // hover popup, and the top-nav dropdown via filterAltMenuItems
      // below. Without this filter, a regular user could still reach
      // Ledger Integrity by pressing Alt+A then I, even though the
      // sidebar didn't show the entry.
      { letter: 'I', label: 'Ledger Integrity', sub: 'Audit + drift',    route: '/accounts/integrity', flag: 'dev_show_ledger_integrity' },
    ],
  },

  // Alt+R = Reports menu. The hub already has rich keyboard nav of
  // its own, so the "menu" here is just a one-item shortcut to it —
  // kept for consistency with the other Alt+letter slots. The hub
  // takes over once the user is there.
  KeyR: {
    title: 'Reports',
    anchorKey: '/reports',
    items: [
      { letter: 'B', label: 'Browse Reports', sub: 'Reports hub', route: '/reports' },
      { letter: 'D', label: 'Day Book',       sub: 'All vouchers · today', route: '/reports/day-book' },
      { letter: 'P', label: 'Profit & Loss',  sub: 'P&L statement',  route: '/reports/profit-loss' },
      { letter: 'A', label: 'Balance Sheet',  sub: 'Assets & liabilities', route: '/reports/balance-sheet' },
      { letter: 'T', label: 'Trial Balance',  sub: 'Period-end closing',  route: '/reports/trial-balance' },
      { letter: 'L', label: 'Ledger',         sub: 'Account ledger',       route: '/reports/ledger' },
    ],
  },

  // Alt+T = se**T**tings (S is taken by Sales). Single-item menu where
  // anchorKey === items[0].route — useGlobalShortcuts detects this and
  // skips the popup, navigating directly. Matches the click behaviour
  // of the gear icon, which is also a direct-navigate after Settings
  // was collapsed from a parent-with-children to a single leaf in
  // menuConfig.
  KeyT: {
    title: 'Settings',
    anchorKey: '/settings/company',
    items: [
      { letter: 'S', label: 'Settings', sub: 'Company · users · theme · backup', route: '/settings/company' },
    ],
  },
};

// Ctrl+letter — direct jumps to the most-common action in each menu.
// Keep it conservative: only the actions an operator hits dozens of
// times a day, where saving one keystroke (Alt+S+S → Ctrl+S) matters.
//
// Browser conflicts to know about:
//   Ctrl+S — browser "Save page"      → ours wins via preventDefault
//   Ctrl+P — browser "Print page"     → harder to override on Mac
//                                       Cmd+P; on Win/Linux Ctrl+P
//                                       we preventDefault and go to
//                                       the new-purchase form
//   Ctrl+R — browser "Reload"         → genuinely fights us; SKIP
//   Ctrl+M — generally free
//   Ctrl+H — Chrome history; Firefox / Safari handle differently;
//            usually we can preventDefault but on some setups the
//            browser still opens its history. Acceptable for now —
//            user can fall back to Alt+H opening the menu.
export const CTRL_DIRECT = {
  KeyS: '/sale/new',
  KeyP: '/purchase/new',
  KeyM: '/payment/new',  // money out
  KeyN: '/receipt/new',  // moNey in (R for Receive would clash with browser reload)
  KeyH: '/',
  KeyD: '/dashboard',
};

/**
 * Drop items whose `flag` field names a system_settings boolean that's
 * currently OFF. Mirrors the sidebar's filterMenuByFeatureFlags but
 * for the flat ALT_MENUS shape. When `effectiveDev` is true (developer
 * mode unlocked AND not previewing), every flagged item is allowed
 * through — same override the sidebar uses.
 *
 * Returns a NEW ALT_MENUS-shaped object; the original is never mutated
 * so consumers that import it directly stay safe.
 */
export function filterAltMenus(altMenus, settings, effectiveDev) {
  const out = {};
  for (const code of Object.keys(altMenus)) {
    const menu = altMenus[code];
    const items = (menu.items || []).filter((it) => {
      if (!it.flag) return true;
      if (effectiveDev) return true;
      return !!settings?.[it.flag];
    });
    if (items.length === 0) continue;     // drop a menu that's been emptied
    out[code] = { ...menu, items };
  }
  return out;
}
