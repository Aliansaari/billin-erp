import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { tap as hapticTap } from '../utils/haptics';
import CommandCentre from './CommandCentre';

const HomeIcon = ({ filled }) => filled ? (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M3 12L12 3l9 9v9a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg>
) : (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12L12 3l9 9v9a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg>
);
const SalesIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
);
const StockIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>
);
const ReportsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
);

const TABS = [
  { key: 'home',    label: 'Home',     path: '/dashboard' },
  { key: 'sales',   label: 'Vouchers', path: '/vouchers'  },
  // centre slot is CommandCentre — not a regular tab
  { key: 'stock',   label: 'Stock',    path: '/stock'     },
  { key: 'reports', label: 'Reports',  path: '/reports'   },
];

const TAB_PREFIX = {
  '/dashboard': 'home',
  '/day-book':  'home',
  '/vouchers':  'sales',
  '/stock':     'stock',
  '/items':     'stock',
  '/reports':   'reports',
};

function activeTabFor(pathname) {
  for (const prefix of Object.keys(TAB_PREFIX)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return TAB_PREFIX[prefix];
  }
  return null;
}

function iconFor(key, active) {
  if (key === 'home')    return <HomeIcon filled={active} />;
  if (key === 'sales')   return <SalesIcon />;
  if (key === 'stock')   return <StockIcon />;
  if (key === 'reports') return <ReportsIcon />;
  return null;
}

export default function TabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = activeTabFor(pathname);

  const [left, right] = [TABS.slice(0, 2), TABS.slice(2)];

  return (
    <>
      <nav className="tabbar" role="tablist">
        {left.map((t) => (
          <button
            key={t.key}
            className={`tabbar-item${active === t.key ? ' active' : ''}`}
            onClick={() => { hapticTap(); navigate(t.path); }}
            role="tab"
            aria-selected={active === t.key}
          >
            <span className="tabbar-icon">{iconFor(t.key, active === t.key)}</span>
            <span>{t.label}</span>
          </button>
        ))}

        {/* Floating command centre pill — sits between the two tab groups */}
        <CommandCentre />

        {right.map((t) => (
          <button
            key={t.key}
            className={`tabbar-item${active === t.key ? ' active' : ''}`}
            onClick={() => { hapticTap(); navigate(t.path); }}
            role="tab"
            aria-selected={active === t.key}
          >
            <span className="tabbar-icon">{iconFor(t.key, active === t.key)}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
