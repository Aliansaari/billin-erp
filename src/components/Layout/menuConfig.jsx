/*
 * Shared menu definition for Sidebar (vertical) and TopNav (horizontal) layouts.
 *
 * Keeping the tree in one file means a new route added here shows up in BOTH
 * layouts automatically — nothing worse than clicking a sidebar entry that
 * the top-nav doesn't even have because the two configs drifted.
 *
 * Each leaf item can declare a `perm` (string) or `permAny` (string[]) so
 * the sidebar/topnav can filter the tree to what the current user can reach.
 * A parent with no visible children collapses automatically.
 *
 * The `getOpenKeys` helper resolves which parent menu should be highlighted/
 * expanded given the current pathname. Used by both layouts: the sidebar uses
 * it to auto-expand the right submenu on reload; the top-nav uses it as the
 * `selectedKeys` input so the current section is highlighted even when the
 * user is deep inside a child route (e.g. /sale/edit/42 still highlights
 * Sales).
 */
import React from 'react';
import {
  LineChartOutlined, ShoppingCartOutlined, ShoppingOutlined, TeamOutlined,
  InboxOutlined, DollarOutlined, BarChartOutlined, SettingOutlined,
  UserOutlined, TagsOutlined, FileTextOutlined, WalletOutlined,
  CreditCardOutlined, AppstoreOutlined, StockOutlined, PlusCircleOutlined,
  UnorderedListOutlined, RollbackOutlined, BankOutlined, ThunderboltOutlined,
  FieldTimeOutlined, BookOutlined,
  TableOutlined, CloudServerOutlined, BgColorsOutlined,
  SwapOutlined, ApiOutlined, PrinterOutlined,
  StarFilled, RiseOutlined, PieChartOutlined,
  CheckCircleOutlined, HomeOutlined, AuditOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import { hasPermission, hasAnyPermission } from '../../utils/perms';
import useFavoritesStore from '../../store/favoritesStore';
import { CATEGORY_META, resolveReports } from '../../config/reports';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import useDevModeStore from '../../store/devModeStore';

export const menuItems = [
  // Home (Command Center) — the / route. Distinct from /dashboard, which
  // is the deeper 9-tile editorial dashboard for end-of-day reading.
  { key: '/',          icon: <HomeOutlined />,      label: 'Home' },
  { key: '/dashboard', icon: <LineChartOutlined />, label: 'Dashboard' },
  {
    key: 'sales-menu',
    icon: <ShoppingOutlined />,
    label: 'Sales',
    children: [
      // Bare-noun label — operators type "sale" not "new sales bill", and
      // the sidebar shouldn't fight the global search palette on naming.
      { key: '/sale/new',         icon: <PlusCircleOutlined />,    label: 'Sale',             perm: 'sales.create' },
      { key: '/sales',            icon: <UnorderedListOutlined />, label: 'Sales List',       perm: 'sales.view' },
      // Receipt + Receipt List live under Sales because the natural next
      // step after a Sale is collecting the money for it. /receipt/new
      // and the filtered /payments list belong here now — the standalone
      // "Payments" top-level menu was retired (its three children all
      // moved into Sales / Purchase / Expenses where the operator's
      // mental model already groups them). The list route uses
      // ?transaction_type=Receipt to filter PaymentList down to receipts
      // only (the filter PaymentList already reads at line 71).
      { key: '/receipt/new',                         icon: <WalletOutlined />,        label: 'Receipt',      perm: 'payments.create' },
      { key: '/payments?transaction_type=Receipt',   icon: <UnorderedListOutlined />, label: 'Receipt List', perm: 'payments.view' },
      { key: '/sales-return/new', icon: <RollbackOutlined />,      label: 'New Sales Return', perm: 'sales_returns.create' },
      { key: '/sales-returns',    icon: <UnorderedListOutlined />, label: 'Sales Returns',    perm: 'sales_returns.view' },
    ],
  },
  {
    key: 'purchase-menu',
    icon: <ShoppingCartOutlined />,
    label: 'Purchase',
    children: [
      { key: '/purchase/new',        icon: <PlusCircleOutlined />,    label: 'Purchase',            perm: 'purchase.create' },
      { key: '/purchases',           icon: <UnorderedListOutlined />, label: 'Purchase List',       perm: 'purchase.view' },
      // Payment + Payment List mirror the Sales side — the natural next
      // step after a Purchase is paying for it. The standalone Payments
      // menu was retired; payments now live here (Purchase) and receipts
      // live in Sales, which matches how operators think about money
      // flow: out goes with what you bought, in goes with what you sold.
      { key: '/payment/new',                         icon: <DollarOutlined />,        label: 'Payment',      perm: 'payments.create' },
      { key: '/payments?transaction_type=Payment',   icon: <UnorderedListOutlined />, label: 'Payment List', perm: 'payments.view' },
      { key: '/purchase-return/new', icon: <RollbackOutlined />,      label: 'New Purchase Return', perm: 'purchase_returns.create' },
      { key: '/purchase-returns',    icon: <UnorderedListOutlined />, label: 'Purchase Returns',    perm: 'purchase_returns.view' },
    ],
  },
  {
    key: 'parties-menu',
    icon: <TeamOutlined />,
    label: 'Parties',
    children: [
      // "+ New …" shortcuts — same pattern Sales/Purchase use (a
      // create entry above the list entry). Each routes to the list
      // page with ?new=1; the list page reads the param and opens its
      // create modal on mount.
      { key: '/customers?new=1', icon: <PlusCircleOutlined />,    label: 'New Customer',  perm: 'parties.create' },
      { key: '/suppliers?new=1', icon: <PlusCircleOutlined />,    label: 'New Supplier',  perm: 'parties.create' },
      { key: '/customers',       icon: <UserOutlined />,          label: 'Customers',     perm: 'parties.view' },
      { key: '/suppliers',       icon: <BankOutlined />,          label: 'Suppliers',     perm: 'parties.view' },
    ],
  },
  {
    key: 'inventory-menu',
    icon: <InboxOutlined />,
    label: 'Inventory',
    children: [
      { key: '/products?new=1',   icon: <PlusCircleOutlined />, label: 'New Product',    perm: 'inventory.create' },
      { key: '/categories?new=1', icon: <PlusCircleOutlined />, label: 'New Category',   perm: 'inventory.create' },
      { key: '/products',         icon: <AppstoreOutlined />, label: 'Products',        perm: 'inventory.view' },
      { key: '/categories',       icon: <TagsOutlined />,     label: 'Categories',      perm: 'inventory.view' },
      { key: '/stock-movement',   icon: <SwapOutlined />,     label: 'Stock Movement',  perm: 'inventory.view' },
      { key: '/stock-report',     icon: <StockOutlined />,    label: 'Stock Report',    perm: 'inventory.view' },
      { key: '/stock-report-pro', icon: <TableOutlined />,    label: 'Smart Stock',     perm: 'inventory.view' },
      { key: '/stock-transfers',  icon: <SwapOutlined />,     label: 'Stock Transfers', perm: 'stock_transfers.view', flag: 'multi_warehouse_enabled' },
      // Batches (Commit 5) — gated on batches.view AND the global
      // batch_tracking_enabled toggle. The page itself still has an
      // "Enable batch tracking" placeholder for direct-URL hits, but
      // the sidebar entry hides when the toggle is off so operators
      // don't land there by accident.
      { key: '/inventory/batches', icon: <AppstoreOutlined />, label: 'Batches',         perm: 'batches.view', flag: 'batch_tracking_enabled' },
    ],
  },
  // Payments menu retired — Receipt + List moved to Sales, Payment + List
  // moved to Purchase, and Expenses already lived in its own top-level
  // menu (below). Operators reach the same screens from the new homes
  // (Alt+S → C / T for receipts, Alt+P → M / T for payments) and the
  // direct shortcuts Ctrl+M (payment) / Ctrl+N (receipt) / F6 / F7 are
  // unchanged. One fewer top-level pill in the nav.
  //
  // Expenses — separate from the (now removed) Payments menu because the
  // workflow is different: a Payment settles an outstanding party balance,
  // an Expense books a P&L hit (rent / fuel / supplies). Same double-entry
  // plumbing under the hood, distinct UX.
  {
    key: 'expenses-menu',
    // CreditCardOutlined reads as "bills you pay" (rent, fuel, supplies) —
    // much more direct than the generic FundOutlined chart we had before,
    // and visually distinct from the wallet/dollar/bank icons elsewhere in
    // the nav so the eye lands on the right pill without re-reading labels.
    icon: <CreditCardOutlined />,
    label: 'Expenses',
    children: [
      { key: '/expenses/new',    icon: <PlusCircleOutlined />,    label: 'New Expense',     perm: 'expenses.create' },
      { key: '/expenses',        icon: <UnorderedListOutlined />, label: 'Expense List',    perm: 'expenses.view' },
      { key: '/expenses/report', icon: <BarChartOutlined />,      label: 'Expense Report',  perm: 'expenses.view' },
    ],
  },
  // Bank — top-level dropdown covering bank accounts AND loans.
  //
  // Loans were originally a separate top-level entry, but operators
  // think of "money flowing in/out of the company" as one section,
  // and tucking loans under Bank keeps the sidebar from growing one
  // entry per finance feature.
  //
  //   Accounts        list of bank ledgers + per-bank metrics
  //   Reconciliation  cross-bank uncleared cheques + aging
  //   Loans           list of loan ledgers (taken & given) with EMI
  //                   status, outstanding, principal/interest paid
  //   Loan Schedule   cross-loan upcoming + overdue EMIs
  //
  // Per-bank Statement and per-loan Statement are reached by clicking
  // a card on the respective list page — no top-level entries of
  // their own (no useful landing without an account selected).
  {
    key: 'bank-menu',
    icon: <BankOutlined />,
    label: 'Bank',
    children: [
      { key: '/banks',                icon: <WalletOutlined />,      label: 'Accounts',       perm: 'accounts.view' },
      { key: '/banks/cheques',        icon: <AuditOutlined />,       label: 'Cheques',        perm: 'cheques.view' },
      { key: '/banks/reconciliation', icon: <CheckCircleOutlined />, label: 'Reconciliation', perm: 'accounts.view' },
      { key: '/loans',                icon: <FieldTimeOutlined />,   label: 'Loans',          perm: 'accounts.view' },
      { key: '/loans/schedule',       icon: <FieldTimeOutlined />,   label: 'Loan Schedule',  perm: 'accounts.view' },
    ],
  },
  {
    // Label is "Books" (the accounting term operators recognise — Tally
    // uses the same in its "Display More Reports → Books" tree). The
    // internal key stays 'accounts-menu' so getOpenKeys, the
    // accounts.view permission tag, and any deep-link out of /accounts
    // routes keep working without churn. BookOutlined replaces the
    // generic FundOutlined chart so the icon now means what the label
    // says.
    key: 'accounts-menu',
    icon: <BookOutlined />,
    label: 'Books',
    children: [
      { key: '/accounts/journal/new', icon: <PlusCircleOutlined />,    label: 'New Journal Voucher', perm: 'accounts.view' },
      { key: '/accounts/journal',     icon: <UnorderedListOutlined />, label: 'Journal Vouchers',    perm: 'accounts.view' },
      // Ledger Integrity is a heavy DB-diagnostic page. Default-hidden;
      // a developer can flip dev_show_ledger_integrity to expose it to
      // accountants who legitimately need it. Developer mode sees it
      // regardless of the flag.
      { key: '/accounts/integrity',   icon: <ThunderboltOutlined />,   label: 'Ledger Integrity',    perm: 'accounts.view', flag: 'dev_show_ledger_integrity' },
    ],
  },
  // Reports — children are dynamic (driven by user favorites). The
  // static placeholder below carries the parent shape only; consumers
  // call useMenuItems() to get the resolved tree with the favorites
  // expanded as children. See useMenuItems below for the rationale.
  {
    key: 'reports-menu',
    icon: <BarChartOutlined />,
    label: 'Reports',
    __dynamic: 'reports',
    children: [],   // filled in at render time by useMenuItems
  },
  // Settings — collapsed from a parent-with-children into a single leaf
  // that navigates straight to /settings/company. Reasons:
  //   · clicking the gear should go to Settings, not pop a 15-item menu
  //   · the Settings page (SettingsLayout) has its OWN internal nav
  //     listing every sub-page, so the sidebar dropdown was duplicate
  //     surface area
  //   · matches Tally / QuickBooks / Xero — Settings is one destination
  // Permission is intentionally not set: users without
  // settings.manage_company hit the /settings/company RoleRoute which
  // bounces them to an accessible sub-page. The submenu items above
  // (Theme, Print, Backup, etc.) remain reachable from inside the
  // Settings page's sidebar and via the Alt+T keyboard popup.
  {
    key:   '/settings/company',
    icon:  <SettingOutlined />,
    label: 'Settings',
  },
];

// Map category meta icon names to actual AntD icon components for the
// nav dropdown. Same icons the Reports hub uses on its category cards
// — keeps the operator's visual association from hub to dropdown.
const CATEGORY_ICON = {
  RiseOutlined:         <RiseOutlined />,
  ShoppingCartOutlined: <ShoppingCartOutlined />,
  InboxOutlined:        <InboxOutlined />,
  PieChartOutlined:     <PieChartOutlined />,
  TeamOutlined:         <TeamOutlined />,
  FileTextOutlined:     <FileTextOutlined />,
};

/**
 * Look up the icon for a given route by walking the static menuItems
 * tree (parents first, then their children). Returns null if no entry
 * exists for that route. Used by the menu popup and the sidebar's
 * collapsed-icon hover popup so each row in those popups carries the
 * same icon the user already sees in the main nav — no need to keep
 * a parallel icon mapping in menuCatalog.
 */
export function getRouteIcon(route) {
  for (const item of menuItems) {
    if (item.key === route) return item.icon;
    if (item.children) {
      for (const c of item.children) {
        if (c.key === route) return c.icon;
      }
    }
  }
  return null;
}

/**
 * Hook variant of menuItems. Reads the favorites store and inflates
 * the Reports parent's children with the user's pinned reports +
 * a "View all reports →" link. With zero pins, children collapse to
 * a single "Browse all reports" item so the menu still navigates
 * somewhere useful.
 *
 * Why a hook (not a static array): both the sidebar and the top nav
 * need to re-render when the user pins/unpins a report. Co-locating
 * the favorites read with the menu shape gives Sidebar/TopNav a
 * subscription via the store, so the dropdown updates the moment a
 * star is clicked anywhere in the app.
 */
export function useMenuItems() {
  const favIds = useFavoritesStore((s) => s.ids);
  const favs = resolveReports(favIds);
  // System settings drive feature-flag filtering. While the cache is
  // still loading we treat every flag as off (safer default — hides
  // gated entries until we know they should appear), which means a
  // brief moment after first paint the gated items are absent. They
  // pop in once the fetch resolves; consumers re-render via the
  // useSystemSettings subscription.
  const settings = useSystemSettings();
  // Developer mode unlock — when true (and not previewing), EVERY
  // `flag`-gated entry shows regardless of system_settings, and
  // __devOnly entries become visible. When `previewAsUser` is also
  // on, the dev temporarily sees the sidebar exactly as a regular
  // user does — gated entries respect their flags, __devOnly entries
  // stay hidden — so the developer can verify the toggle settings
  // without having to lock dev mode and re-enter the password.
  const devUnlocked   = useDevModeStore((s) => s.unlocked);
  const previewAsUser = useDevModeStore((s) => s.previewAsUser);
  const effectiveDev  = devUnlocked && !previewAsUser;

  const inflated = menuItems.map((item) => {
    if (item.__dynamic !== 'reports') return item;
    // Build the favorites children list. Each pinned report becomes a
    // menu item with its category icon (matches the hub) + the report
    // route as the key. Trailing "View all reports →" link always
    // shows so the operator can jump to /reports without opening the
    // hub from elsewhere.
    const children = [];
    if (favs.length === 0) {
      children.push({
        key: '/reports',
        icon: <StarFilled style={{ color: '#EF9F27' }} />,
        label: 'Browse all reports',
      });
    } else {
      for (const r of favs) {
        const meta = CATEGORY_META[r.category];
        children.push({
          key: r.route,
          icon: CATEGORY_ICON[meta?.icon] || <FileTextOutlined />,
          label: r.name,
          perm: r.perm,
          // Carry the report's `flag` onto the menu node so
          // filterMenuByFeatureFlags below drops Transfer Register /
          // Godown Valuation when Multi-warehouse is OFF, even for users
          // who pinned them while it was on.
          flag: r.flag,
        });
      }
      // Visual divider isn't supported by AntD Menu items spec without
      // type:'divider'; render the "View all" link as a regular leaf
      // with a ↗ glyph so it reads distinctly from the favorites.
      children.push({
        key: '/reports',
        icon: <BarChartOutlined />,
        label: 'View all reports →',
      });
    }
    return { ...item, children };
  });

  return filterMenuByFeatureFlags(inflated, settings, effectiveDev);
}

/**
 * Drop entries whose `flag` field names a system-settings boolean that is
 * currently OFF. Mirrors the recursion shape of filterMenuByPermissions:
 * a parent whose children all get filtered out is itself dropped, so the
 * sidebar never shows an empty heading.
 *
 * `settings` is the shared cache from useSystemSettings — pass null while
 * loading and every flagged entry hides (safer than a flicker where a
 * gated module appears for half a second).
 *
 * `devUnlocked` (third arg) overrides the entire filter: when true, every
 * `flag`-gated entry shows AND `__devOnly` entries (Developer Settings)
 * become visible. When false (default), `__devOnly` entries are hidden.
 */
export function filterMenuByFeatureFlags(items, settings, devUnlocked = false) {
  return items
    .map((item) => {
      // __devOnly entries: visible only when developer mode is unlocked.
      // (Developer Settings page itself.)
      if (item.__devOnly && !devUnlocked) return null;

      // `flag`-gated entries: hidden unless system_settings[flag] is on.
      // Developer mode override — devs see every flagged entry.
      if (item.flag && !devUnlocked && !settings?.[item.flag]) return null;

      if (item.children) {
        const children = filterMenuByFeatureFlags(item.children, settings, devUnlocked);
        if (children.length === 0) return null;
        return { ...item, children };
      }
      return item;
    })
    .filter(Boolean);
}

/**
 * Prune the menu tree to entries the user can reach. Keep parents whose
 * children are entirely hidden out of the nav entirely — nothing worse
 * than clicking a heading that only expands to "nothing to see here".
 */
export function filterMenuByPermissions(items, user) {
  return items
    .map(item => {
      if (item.children) {
        const children = filterMenuByPermissions(item.children, user);
        if (children.length === 0) return null;
        return { ...item, children };
      }
      if (item.permAny) return hasAnyPermission(user, item.permAny) ? item : null;
      if (item.perm)    return hasPermission(user, item.perm) ? item : null;
      return item; // no perm declared = visible to anyone authenticated
    })
    .filter(Boolean);
}

/**
 * Resolve the parent menu keys (e.g. `['sales-menu']`) that should be
 * highlighted/expanded for a given pathname.
 *
 * Order of checks matters: the more-specific `sales-return` / `purchase-return`
 * prefixes must be tested BEFORE `sale` / `purchase`, otherwise the shorter
 * prefix would match first and route the return pages under the wrong parent.
 */
export function getOpenKeys(pathname) {
  if (pathname.startsWith('/sales-return'))     return ['sales-menu'];
  if (pathname.startsWith('/purchase-return'))  return ['purchase-menu'];
  if (pathname.startsWith('/sale') || pathname === '/sales')         return ['sales-menu'];
  if (pathname.startsWith('/purchase') || pathname === '/purchases') return ['purchase-menu'];
  if (pathname.startsWith('/customer') || pathname.startsWith('/supplier')) return ['parties-menu'];
  if (pathname.startsWith('/product') || pathname.startsWith('/categor') || pathname.startsWith('/stock-movement') || pathname.startsWith('/stock-transfer') || pathname.startsWith('/inventory/batches') || pathname === '/stock-report' || pathname === '/stock-report-pro') return ['inventory-menu'];
  // Receipt routes now live under Sales (Alt+S → C); /receipt/* opens
  // sales-menu so the parent pill highlights correctly. Payment routes
  // live under Purchase (Alt+P → M); /payment/* opens purchase-menu.
  // The shared /payments list page (Receipt List + Payment List both
  // route here with ?transaction_type=…) doesn't have one canonical
  // parent — defaulting to sales-menu so the sidebar still expands
  // *something* when an operator lands on the bare /payments URL.
  if (pathname.startsWith('/receipt')) return ['sales-menu'];
  if (pathname.startsWith('/payment'))  return ['purchase-menu'];
  if (pathname === '/payments' || pathname.startsWith('/payments/')) return ['sales-menu'];
  if (pathname.startsWith('/expenses')) return ['expenses-menu'];
  // Both /banks/* and /loans/* highlight the Bank dropdown — loans
  // are nested under Bank in the sidebar (see menuItems above).
  if (pathname.startsWith('/banks') || pathname.startsWith('/loans')) return ['bank-menu'];
  if (pathname.startsWith('/accounts')) return ['accounts-menu'];
  if (pathname.startsWith('/reports')) return ['reports-menu'];
  // Settings is now a leaf with route '/settings/company'; resolve any
  // /settings/* path to that key so the gear icon stays highlighted on
  // every Settings sub-page (Theme, Print, Backup, Users, …).
  if (pathname.startsWith('/settings')) return ['/settings/company'];
  return [];
}
