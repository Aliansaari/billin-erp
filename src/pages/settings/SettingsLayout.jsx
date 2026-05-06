import React, { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BankOutlined, UserOutlined, BgColorsOutlined, TagsOutlined,
  PrinterOutlined, ThunderboltOutlined, SwapOutlined, ApiOutlined,
  CloudServerOutlined, HomeOutlined,
} from '@ant-design/icons';
import { hasPermission } from '../../utils/perms';
import useAuthStore from '../../store/authStore';
import './SettingsLayout.css';

/**
 * SettingsLayout — macOS-style two-pane settings hub.
 *
 *   left rail (grouped index of all settings)  │  right pane (active page)
 *
 * Each rail item is a route under /settings. The page renders via
 * <Outlet /> in the right pane. Items are filtered by permission so
 * users only see what they can actually open.
 *
 * Keyboard: Cmd/Ctrl+F focuses the search box; ↑/↓ would be a nice
 * follow-up but isn't wired here yet.
 */

// Single registry of every settings page. Editing this list is the
// only thing required to add or remove an item from the rail. The
// `perm` field gates visibility — use null for "everyone".
const SETTINGS_GROUPS = [
  {
    label: 'Business',
    items: [
      { path: 'company',  icon: <BankOutlined />,    label: 'Company Profile', perm: 'settings.manage_company' },
      { path: 'modules',  icon: <ThunderboltOutlined />, label: 'Modules',     perm: 'settings.manage_company' },
      { path: 'godowns',  icon: <BankOutlined />,    label: 'Godowns',         perm: 'godowns.view' },
    ],
  },
  {
    label: 'People',
    items: [
      { path: 'users', icon: <UserOutlined />, label: 'Users', perm: 'settings.manage_users' },
    ],
  },
  {
    label: 'Look & feel',
    items: [
      { path: 'theme',   icon: <BgColorsOutlined />, label: 'Theme',         perm: null },
      { path: 'home',    icon: <HomeOutlined />,    label: 'Home Page',      perm: null },
      { path: 'print',   icon: <PrinterOutlined />, label: 'Print',          perm: 'settings.print' },
      { path: 'barcode', icon: <TagsOutlined />,    label: 'Barcode',        perm: 'settings.barcode' },
    ],
  },
  {
    label: 'Data',
    items: [
      { path: 'import-export', icon: <SwapOutlined />,        label: 'Import & Export',  perm: 'settings.import_export' },
      { path: 'import',        icon: <ThunderboltOutlined />, label: 'Import (queued)',  perm: 'settings.import_export' },
      { path: 'tally',         icon: <ApiOutlined />,         label: 'TallyPrime Sync',  perm: 'settings.tally' },
      { path: 'backup',        icon: <CloudServerOutlined />, label: 'Backup & Recovery', perm: 'settings.backup' },
    ],
  },
];

export default function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [query, setQuery] = useState('');

  // Filter groups to ones the current user can reach. Drop groups that
  // end up with no visible items so the rail doesn't show empty
  // headers.
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SETTINGS_GROUPS
      .map((g) => ({
        ...g,
        items: g.items.filter((it) =>
          (it.perm === null || hasPermission(user, it.perm)) &&
          (!q || it.label.toLowerCase().includes(q))
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [user, query]);

  const totalVisible = visibleGroups.reduce((n, g) => n + g.items.length, 0);

  const isActive = (path) =>
    location.pathname === `/settings/${path}` ||
    location.pathname.startsWith(`/settings/${path}/`);

  return (
    <div className="settings-layout">
      <aside className="settings-rail" role="navigation" aria-label="Settings">
        <div className="settings-rail-search">
          <div className="settings-rail-search-wrap">
            <input
              type="text"
              className="settings-rail-search-input"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search settings"
            />
          </div>
        </div>

        {totalVisible === 0 && (
          <div className="settings-rail-empty">
            {query ? 'No settings match.' : 'No settings available.'}
          </div>
        )}

        {visibleGroups.map((group) => (
          <div key={group.label} className="settings-rail-group">
            <div className="settings-rail-group-label">{group.label}</div>
            <ul className="settings-rail-list">
              {group.items.map((it) => (
                <li key={it.path}>
                  <button
                    type="button"
                    className={`settings-rail-item${isActive(it.path) ? ' active' : ''}`}
                    onClick={() => navigate(`/settings/${it.path}`)}
                  >
                    <span className="settings-rail-item-icon">{it.icon}</span>
                    <span className="settings-rail-item-label">{it.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>

      <main className="settings-pane">
        <Outlet />
      </main>
    </div>
  );
}
