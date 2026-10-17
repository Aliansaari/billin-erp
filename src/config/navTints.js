/* One colour per area of the app, shared by the main sidebar and the
 * Settings list so the same thing always wears the same colour (Sales is
 * terracotta in both, Stock amber, Staff teal…). The colours themselves
 * live in global.css as `.tint-<name>` (soft on light pages, brighter on
 * dark pages and on the always-dark sidebar). */

// Main sidebar: top-level menu key → tint.
export const NAV_TINT = {
  '/':                 'orange',   // Home          ↔ Settings › Home Screen
  '/dashboard':        'blue',     // Dashboard     ↔ Settings › Dashboard
  'sales-menu':        'accent',   // Sales         ↔ Settings › Sales Bill
  'purchase-menu':     'brown',    // Purchase      ↔ Settings › Purchase Bill
  'parties-menu':      'purple',   // Parties       ↔ Settings › Party Insight
  'inventory-menu':    'amber',    // Inventory     ↔ Settings › Stock & Products
  'expenses-menu':     'red',
  'staff-menu':        'teal',     // Staff         ↔ Settings › Staff Attendance, Salesmen
  'bank-menu':         'indigo',
  'accounts-menu':     'green',    // Books         ↔ Settings › Tax & Accounts
  'reports-menu':      'pink',
  '/settings/company': 'slate',    // Settings
};

export const tintFor = (key) => NAV_TINT[key] || 'slate';
