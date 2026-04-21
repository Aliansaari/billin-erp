/*
 * Shared menu definition for Sidebar (vertical) and TopNav (horizontal) layouts.
 *
 * Keeping the tree in one file means a new route added here shows up in BOTH
 * layouts automatically — nothing worse than clicking a sidebar entry that
 * the top-nav doesn't even have because the two configs drifted.
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
  TableOutlined, CloudServerOutlined, BgColorsOutlined,
  SwapOutlined, ApiOutlined,
} from '@ant-design/icons';

export const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
  {
    key: 'sales-menu',
    icon: <ShoppingOutlined />,
    label: 'Sales',
    children: [
      { key: '/sale/new',          icon: <PlusCircleOutlined />,    label: 'New Sales Bill' },
      { key: '/sales',             icon: <UnorderedListOutlined />, label: 'Sales List' },
      { key: '/sales-return/new',  icon: <RollbackOutlined />,      label: 'New Sales Return' },
      { key: '/sales-returns',     icon: <UnorderedListOutlined />, label: 'Sales Returns' },
    ],
  },
  {
    key: 'purchase-menu',
    icon: <ShoppingCartOutlined />,
    label: 'Purchase',
    children: [
      { key: '/purchase/new',         icon: <PlusCircleOutlined />,    label: 'New Purchase Bill' },
      { key: '/purchases',            icon: <UnorderedListOutlined />, label: 'Purchase List' },
      { key: '/purchase-return/new',  icon: <RollbackOutlined />,      label: 'New Purchase Return' },
      { key: '/purchase-returns',     icon: <UnorderedListOutlined />, label: 'Purchase Returns' },
    ],
  },
  {
    key: 'parties-menu',
    icon: <TeamOutlined />,
    label: 'Parties',
    children: [
      { key: '/customers', icon: <UserOutlined />, label: 'Customers' },
      { key: '/suppliers', icon: <BankOutlined />, label: 'Suppliers' },
    ],
  },
  {
    key: 'inventory-menu',
    icon: <InboxOutlined />,
    label: 'Inventory',
    children: [
      { key: '/products',          icon: <AppstoreOutlined />, label: 'Products' },
      { key: '/categories',        icon: <TagsOutlined />,     label: 'Categories' },
      { key: '/stock-report',      icon: <StockOutlined />,    label: 'Stock Report' },
      { key: '/stock-report-pro',  icon: <TableOutlined />,    label: 'Smart Stock' },
    ],
  },
  {
    key: 'payments-menu',
    icon: <DollarOutlined />,
    label: 'Payments',
    children: [
      { key: '/payment/new', icon: <PlusCircleOutlined />,    label: 'Make Payment' },
      { key: '/receipt/new', icon: <WalletOutlined />,        label: 'Receive Payment' },
      { key: '/payments',    icon: <UnorderedListOutlined />, label: 'All Transactions' },
    ],
  },
  {
    key: 'reports-menu',
    icon: <BarChartOutlined />,
    label: 'Reports',
    children: [
      { key: '/reports/sales',         icon: <FileTextOutlined />, label: 'Sales Report' },
      { key: '/reports/purchases',     icon: <FileTextOutlined />, label: 'Purchase Report' },
      { key: '/reports/stock',         icon: <StockOutlined />,    label: 'Stock Report' },
      { key: '/reports/party-ledger',  icon: <WalletOutlined />,   label: 'Party Ledger' },
      { key: '/reports/profit-loss',   icon: <FundOutlined />,     label: 'Profit & Loss' },
    ],
  },
  {
    key: 'settings-menu',
    icon: <SettingOutlined />,
    label: 'Settings',
    children: [
      { key: '/settings/company',        icon: <BankOutlined />,        label: 'Company Profile' },
      { key: '/settings/users',          icon: <UserOutlined />,        label: 'Users' },
      { key: '/settings/theme',          icon: <BgColorsOutlined />,    label: 'Theme' },
      { key: '/settings/barcode',        icon: <TagsOutlined />,        label: 'Barcode' },
      { key: '/settings/modules',        icon: <ThunderboltOutlined />, label: 'Modules' },
      { key: '/settings/import-export',  icon: <SwapOutlined />,        label: 'Import & Export' },
      { key: '/settings/tally',          icon: <ApiOutlined />,         label: 'TallyPrime Sync' },
      { key: '/settings/backup',         icon: <CloudServerOutlined />, label: 'Backup & Recovery' },
    ],
  },
];

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
  if (pathname.startsWith('/product') || pathname.startsWith('/categor') || pathname === '/stock-report' || pathname === '/stock-report-pro') return ['inventory-menu'];
  if (pathname.startsWith('/payment') || pathname.startsWith('/receipt')) return ['payments-menu'];
  if (pathname.startsWith('/reports')) return ['reports-menu'];
  if (pathname.startsWith('/settings')) return ['settings-menu'];
  return [];
}
