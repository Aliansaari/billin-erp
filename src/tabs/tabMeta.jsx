import React from 'react';
import {
  HomeOutlined, FileTextOutlined, EditOutlined, SettingOutlined, BarChartOutlined,
} from '@ant-design/icons';
import { menuItems, getOpenKeys } from '../components/Layout/menuConfig';
import { REPORTS } from '../config/reports';
import { SETTINGS_GROUPS } from '../pages/settings/SettingsLayout';
import { tintFor } from '../config/navTints';

/*
 * What a tab is called and which colour it wears, worked out from its URL.
 * Same names as the sidebar and the same section colours (navTints), so a
 * Sale tab looks like the Sales entry it came from. A screen can name its
 * tab more precisely with useTabTitle (e.g. the customer on a bill).
 */

// Every sidebar destination: path (with query) → { label, icon, section }.
const LEAVES = new Map();
for (const top of menuItems) {
  if (typeof top.key === 'string' && top.key.startsWith('/')) {
    LEAVES.set(top.key, { label: top.label, icon: top.icon, section: top.key });
  }
  for (const c of top.children || []) {
    if (typeof c.key === 'string' && c.key.startsWith('/')) {
      LEAVES.set(c.key, { label: c.label, icon: c.icon, section: top.key });
    }
  }
}
const SECTION_ICON = Object.fromEntries(menuItems.map((m) => [m.key, m.icon]));

const REPORT_NAME = new Map(REPORTS.map((r) => [r.route, r.name]));

const SETTINGS_NAME = new Map();
for (const g of SETTINGS_GROUPS) for (const it of g.items || []) SETTINGS_NAME.set(it.path, it.label);

// Screens with an id in the URL: [pattern, title, detail].
const PATTERNS = [
  [/^\/sale\/edit\/[^/]+/,              'Sale',            'Edit bill'],
  [/^\/purchase\/edit\/[^/]+/,          'Purchase',        'Edit bill'],
  [/^\/sales-return\/edit\/[^/]+/,      'Sales Return',    'Edit'],
  [/^\/purchase-return\/edit\/[^/]+/,   'Purchase Return', 'Edit'],
  [/^\/sales-return\/new/,              'Sales Return',    null],
  [/^\/receipt\/edit\/[^/]+/,           'Receipt',         'Edit'],
  [/^\/payment\/edit\/[^/]+/,           'Payment',         'Edit'],
  [/^\/expenses\/edit\/[^/]+/,          'Expense',         'Edit'],
  [/^\/accounts\/journal\/edit\/[^/]+/, 'Journal Voucher', 'Edit'],
  [/^\/stock-transfer\/new/,            'Stock Transfer',  'New'],
  [/^\/stock-transfer\/edit\/[^/]+/,    'Stock Transfer',  'Edit'],
  [/^\/banks\/[^/]+\/statement/,        'Bank Statement',  null],
  [/^\/loans\/[^/]+\/statement/,        'Loan Statement',  null],
  [/^\/stock-movement\/.+/,             'Stock Movement',  null],
  [/^\/stock-report-pro\/.+/,           'Smart Stock',     null],
  [/^\/reports\/stock-by-color\/.+/,    'Stock by Color',  null],
  [/^\/inventory\/batches\/.+/,         'Batch',           null],
  [/^\/inventory\/batches$/,            'Batches',         null],
  [/^\/reports\/expiry$/,               'Expiry Report',   null],
  [/^\/dashboard\/classic/,             'Dashboard',       'Classic'],
];

// Sections the sidebar resolver (getOpenKeys) does not know about.
function sectionOf(pathname) {
  if (pathname === '/') return '/';
  if (pathname.startsWith('/dashboard')) return '/dashboard';
  if (pathname.startsWith('/staff-') || pathname === '/settings/staff-attendance') return 'staff-menu';
  if (pathname.startsWith('/members')) return 'parties-menu';
  if (pathname.startsWith('/stock-') || pathname.startsWith('/inventory')) return 'inventory-menu';
  return getOpenKeys(pathname)[0] || '/settings/company';
}

const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function describe(pathname, search) {
  const full = pathname + (search || '');
  // Exact sidebar destination first (query-aware: Receipt List vs Payment List).
  const typeQ = new URLSearchParams(search || '').get('transaction_type');
  const leaf = LEAVES.get(full) || (typeQ && LEAVES.get(`${pathname}?transaction_type=${typeQ}`)) || LEAVES.get(pathname);
  if (leaf) return { title: leaf.label, detail: null, icon: leaf.icon, section: leaf.section };

  const section = sectionOf(pathname);
  const sectionIcon = SECTION_ICON[section];

  for (const [re, title, detail] of PATTERNS) {
    if (re.test(pathname)) return { title, detail, icon: detail === 'Edit bill' || detail === 'Edit' ? <EditOutlined /> : sectionIcon, section };
  }
  if (REPORT_NAME.has(pathname)) return { title: REPORT_NAME.get(pathname), detail: null, icon: <BarChartOutlined />, section: 'reports-menu' };
  if (pathname.startsWith('/settings')) {
    const page = pathname.split('/')[2] || 'company';
    return { title: 'Settings', detail: SETTINGS_NAME.get(page) || null, icon: <SettingOutlined />, section: '/settings/company' };
  }
  const last = pathname.split('/').filter(Boolean).filter((s) => !/^\d+$/.test(s)).pop();
  return { title: last ? titleCase(last) : 'Home', detail: null, icon: sectionIcon || <FileTextOutlined />, section };
}

/** { title, detail, icon, tint } for a tab. Page-given names win. */
export function tabMeta(tab) {
  const d = describe(tab.loc.pathname, tab.loc.search);
  const icon = tab.loc.pathname === '/' ? <HomeOutlined /> : d.icon;
  return {
    title: tab.title || d.title,
    detail: tab.title ? tab.detail : (tab.detail || d.detail),
    icon,
    tint: tintFor(d.section),
  };
}

/** Screens that hold typed-in work: never refreshed behind the user's back. */
export const isEntryScreen = (pathname) =>
  /\/(new|edit)(\/|$)/.test(pathname) || pathname.startsWith('/settings') || pathname.startsWith('/staff-payroll');
