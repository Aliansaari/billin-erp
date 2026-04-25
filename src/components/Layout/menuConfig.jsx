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
  DashboardOutlined, ShoppingCartOutlined, ShoppingOutlined, TeamOutlined,
  InboxOutlined, DollarOutlined, BarChartOutlined, SettingOutlined,
  UserOutlined, TagsOutlined, FileTextOutlined, WalletOutlined,
  FundOutlined, AppstoreOutlined, StockOutlined, PlusCircleOutlined,
  UnorderedListOutlined, RollbackOutlined, BankOutlined, ThunderboltOutlined,
  FieldTimeOutlined,
  TableOutlined, CloudServerOutlined, BgColorsOutlined,
  SwapOutlined, ApiOutlined, PrinterOutlined,
} from '@ant-design/icons';
import { hasPermission, hasAnyPermission } from '../../utils/perms';

export const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
  {
    key: 'sales-menu',
    icon: <ShoppingOutlined />,
    label: 'Sales',
    children: [
      { key: '/sale/new',         icon: <PlusCircleOutlined />,    label: 'New Sales Bill',   perm: 'sales.create' },
      { key: '/sales',            icon: <UnorderedListOutlined />, label: 'Sales List',       perm: 'sales.view' },
      { key: '/sales-return/new', icon: <RollbackOutlined />,      label: 'New Sales Return', perm: 'sales_returns.create' },
      { key: '/sales-returns',    icon: <UnorderedListOutlined />, label: 'Sales Returns',    perm: 'sales_returns.view' },
    ],
  },
  {
    key: 'purchase-menu',
    icon: <ShoppingCartOutlined />,
    label: 'Purchase',
    children: [
      { key: '/purchase/new',        icon: <PlusCircleOutlined />,    label: 'New Purchase Bill',   perm: 'purchase.create' },
      { key: '/purchases',           icon: <UnorderedListOutlined />, label: 'Purchase List',       perm: 'purchase.view' },
      { key: '/purchase-return/new', icon: <RollbackOutlined />,      label: 'New Purchase Return', perm: 'purchase_returns.create' },
      { key: '/purchase-returns',    icon: <UnorderedListOutlined />, label: 'Purchase Returns',    perm: 'purchase_returns.view' },
    ],
  },
  {
    key: 'parties-menu',
    icon: <TeamOutlined />,
    label: 'Parties',
    children: [
      { key: '/customers', icon: <UserOutlined />, label: 'Customers', perm: 'parties.view' },
      { key: '/suppliers', icon: <BankOutlined />, label: 'Suppliers', perm: 'parties.view' },
    ],
  },
  {
    key: 'inventory-menu',
    icon: <InboxOutlined />,
    label: 'Inventory',
    children: [
      { key: '/products',         icon: <AppstoreOutlined />, label: 'Products',        perm: 'inventory.view' },
      { key: '/categories',       icon: <TagsOutlined />,     label: 'Categories',      perm: 'inventory.view' },
      { key: '/stock-movement',   icon: <SwapOutlined />,     label: 'Stock Movement',  perm: 'inventory.view' },
      { key: '/stock-report',     icon: <StockOutlined />,    label: 'Stock Report',    perm: 'inventory.view' },
      { key: '/stock-report-pro', icon: <TableOutlined />,    label: 'Smart Stock',     perm: 'inventory.view' },
    ],
  },
  {
    key: 'payments-menu',
    icon: <DollarOutlined />,
    label: 'Payments',
    children: [
      { key: '/payment/new', icon: <PlusCircleOutlined />,    label: 'Make Payment',     perm: 'payments.create' },
      { key: '/receipt/new', icon: <WalletOutlined />,        label: 'Receive Payment',  perm: 'payments.create' },
      { key: '/payments',    icon: <UnorderedListOutlined />, label: 'All Transactions', perm: 'payments.view' },
    ],
  },
  {
    key: 'reports-menu',
    icon: <BarChartOutlined />,
    label: 'Reports',
    children: [
      { key: '/reports/sales',        icon: <FileTextOutlined />, label: 'Sales Report',    perm: 'reports.view' },
      { key: '/reports/purchases',    icon: <FileTextOutlined />, label: 'Purchase Report', perm: 'reports.view' },
      { key: '/reports/stock',        icon: <StockOutlined />,    label: 'Stock Report',    perm: 'reports.view' },
      { key: '/reports/party-ledger', icon: <WalletOutlined />,   label: 'Party Ledger',    perm: 'accounts.view' },
      { key: '/reports/aging',        icon: <FieldTimeOutlined />,label: 'Aging Report',    perm: 'reports.view' },
      { key: '/reports/gstr1',        icon: <FileTextOutlined />, label: 'GSTR-1',          perm: 'reports.view' },
      { key: '/reports/gstr3b',       icon: <FileTextOutlined />, label: 'GSTR-3B',         perm: 'reports.view' },
      { key: '/reports/profit-loss',  icon: <FundOutlined />,     label: 'Profit & Loss',   perm: 'accounts.view' },
    ],
  },
  {
    key: 'settings-menu',
    icon: <SettingOutlined />,
    label: 'Settings',
    children: [
      { key: '/settings/company',        icon: <BankOutlined />,        label: 'Company Profile',  perm: 'settings.manage_company' },
      { key: '/settings/users',          icon: <UserOutlined />,        label: 'Users',            perm: 'settings.manage_users' },
      { key: '/settings/theme',          icon: <BgColorsOutlined />,    label: 'Theme',            perm: 'settings.theme' },
      { key: '/settings/barcode',        icon: <TagsOutlined />,        label: 'Barcode',          perm: 'settings.barcode' },
      { key: '/settings/print',          icon: <PrinterOutlined />,     label: 'Print Settings',   perm: 'settings.print' },
      { key: '/settings/modules',        icon: <ThunderboltOutlined />, label: 'Modules',          perm: 'settings.manage_company' },
      { key: '/settings/import-export',  icon: <SwapOutlined />,        label: 'Import & Export',  perm: 'settings.import_export' },
      { key: '/settings/tally',          icon: <ApiOutlined />,         label: 'TallyPrime Sync',  perm: 'settings.tally' },
      { key: '/settings/backup',         icon: <CloudServerOutlined />, label: 'Backup & Recovery',perm: 'settings.backup' },
    ],
  },
];

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
  if (pathname.startsWith('/product') || pathname.startsWith('/categor') || pathname.startsWith('/stock-movement') || pathname === '/stock-report' || pathname === '/stock-report-pro') return ['inventory-menu'];
  if (pathname.startsWith('/payment') || pathname.startsWith('/receipt')) return ['payments-menu'];
  if (pathname.startsWith('/reports')) return ['reports-menu'];
  if (pathname.startsWith('/settings')) return ['settings-menu'];
  return [];
}
