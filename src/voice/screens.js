import { ALT_MENUS } from '../components/keyboard/menuCatalog';
import { findBest } from './match.js';

/*
 * Screens "open …" can reach: every Alt-menu item (labels kept in sync
 * with the keyboard menus), plus a few reports and Hindi names people
 * actually say. Pages still check permissions as usual (RoleRoute).
 */
const EXTRA = [
  { label: 'Sales Report',         route: '/reports/sales',                say: ['sales report', 'bikri report'] },
  { label: 'Purchase Report',      route: '/reports/purchases',            say: ['purchase report', 'kharid report'] },
  { label: 'Profit and Loss',      route: '/reports/profit-loss',          say: ['profit loss', 'p and l', 'munafa'] },
  { label: 'Customer Outstanding', route: '/reports/customer-outstanding', say: ['outstanding', 'baki', 'udhaar', 'udhar'] },
  { label: 'Supplier Outstanding', route: '/reports/supplier-outstanding', say: ['supplier outstanding'] },
  { label: 'Customer Statement',   route: '/reports/customer-statement',   say: ['customer statement'] },
  { label: 'Drafts',               route: '/sales',                        say: ['drafts', 'hold bills'] },
];
const ALIASES = {
  '/': ['home', 'ghar'],
  '/sales': ['sales', 'bills', 'bikri', 'sales bills', 'bill list'],
  '/purchases': ['purchases', 'kharid', 'purchase bills'],
  '/customers': ['grahak', 'customer list'],
  '/suppliers': ['supplier list'],
  '/products': ['saman', 'maal', 'items', 'product list'],
  '/stock-report': ['stock', 'maal report', 'inventory'],
  '/receipt/new': ['receipt', 'paisa mila', 'jama'],
  '/payment/new': ['payment', 'paisa diya'],
  '/settings/company': ['settings', 'setting'],
};

let cache = null;
function variants() {
  if (cache) return cache;
  const list = [];
  for (const menu of Object.values(ALT_MENUS)) {
    for (const it of menu.items || []) {
      if (it.flag || !it.route) continue;
      list.push({ label: it.label, route: it.route, text: it.label });
      for (const a of ALIASES[it.route] || []) list.push({ label: it.label, route: it.route, text: a });
    }
  }
  for (const e of EXTRA) {
    list.push({ label: e.label, route: e.route, text: e.label });
    for (const a of e.say) list.push({ label: e.label, route: e.route, text: a });
  }
  cache = list;
  return list;
}

export function matchScreen(query) {
  const { best } = findBest(query, variants(), (v) => v.text, { min: 0.75, margin: 0 });
  return best ? { label: best.label, route: best.route } : null;
}
