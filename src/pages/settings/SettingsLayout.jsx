import React, { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BankOutlined, UserOutlined, BgColorsOutlined, TagsOutlined,
  PrinterOutlined, ThunderboltOutlined, SwapOutlined, ApiOutlined,
  CloudServerOutlined, HomeOutlined, ControlOutlined, DashboardOutlined,
  AppstoreOutlined, CodeOutlined, KeyOutlined,
} from '@ant-design/icons';
import useDevModeStore from '../../store/devModeStore';
import { hasPermission } from '../../utils/perms';
import useAuthStore from '../../store/authStore';
import { useSystemSettings } from '../../hooks/useSystemSettings';
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
      { path: 'company',   icon: <BankOutlined />,        label: 'Company Profile', perm: 'settings.manage_company' },
      // Companies entry — list / create / archive across companies in
      // the master DB. Same permission gate as Company Profile so any
      // user who can edit the current company's profile can also see
      // the list.
      { path: 'companies', icon: <AppstoreOutlined />,    label: 'Companies',       perm: 'settings.manage_company' },
      { path: 'modules',   icon: <ThunderboltOutlined />, label: 'Features',        perm: 'settings.manage_company' },
      { path: 'defaults',  icon: <ControlOutlined />,     label: 'Defaults',        perm: 'settings.manage_company' },
      { path: 'godowns',   icon: <BankOutlined />,        label: 'Godowns',         perm: 'godowns.view', flag: 'multi_warehouse_enabled' },
    ],
  },
  {
    label: 'People',
    items: [
      // My Account — every logged-in user can reach this. perm:null means
      // no extra check beyond authentication.
      { path: 'account', icon: <UserOutlined />, label: 'My Account', perm: null },
      { path: 'users',   icon: <UserOutlined />, label: 'Users',      perm: 'settings.manage_users' },
    ],
  },
  {
    label: 'Look & feel',
    items: [
      { path: 'theme',     icon: <BgColorsOutlined />,   label: 'Theme',         perm: null },
      { path: 'home',      icon: <HomeOutlined />,       label: 'Home Page',     perm: null },
      { path: 'dashboard', icon: <DashboardOutlined />,  label: 'Dashboard',     perm: null },
      { path: 'print',     icon: <PrinterOutlined />,    label: 'Print',         perm: 'settings.print' },
      { path: 'barcode',   icon: <TagsOutlined />,       label: 'Barcode',       perm: 'settings.barcode' },
    ],
  },
  {
    label: 'Data',
    items: [
      // Import / Export + Tally Sync mirror the developer-tier flags
      // used by the main sidebar so the settings rail honours the same
      // hide/show toggles. Backup creation stays visible regardless.
      { path: 'import-export', icon: <SwapOutlined />,        label: 'Import & Export',  perm: 'settings.import_export', flag: 'dev_show_import_export' },
      { path: 'import',        icon: <ThunderboltOutlined />, label: 'Import (queued)',  perm: 'settings.import_export', flag: 'dev_show_import_export' },
      { path: 'tally',         icon: <ApiOutlined />,         label: 'TallyPrime Sync',  perm: 'settings.tally',         flag: 'dev_show_tally_sync' },
      { path: 'backup',        icon: <CloudServerOutlined />, label: 'Backup & Recovery', perm: 'settings.backup' },
    ],
  },
  {
    // Visible only when developer mode is unlocked on this device.
    // Filtered by the `__devOnly` marker — the visibleGroups computation
    // below honours it.
    label: 'Developer',
    items: [
      { path: 'developer',  icon: <CodeOutlined />,        label: 'Developer Access', __devOnly: true },
      // License panel — visible to anyone (so the customer can see their
      // expiry / customer ID), but the sensitive Replace flow is dev-gated
      // inside the panel itself.
      { path: 'license',    icon: <KeyOutlined />,         label: 'License',          perm: null },
    ],
  },
];

export default function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const settings = useSystemSettings();
  const [query, setQuery] = useState('');
  // Developer mode + preview-as-user — same logic as the main sidebar's
  // useMenuItems filter. When dev is unlocked AND not previewing, every
  // `flag`-gated entry is visible regardless of the system_settings
  // value, and `__devOnly` entries (Developer Access) appear.
  const devUnlocked   = useDevModeStore((s) => s.unlocked);
  const previewAsUser = useDevModeStore((s) => s.previewAsUser);
  const effectiveDev  = devUnlocked && !previewAsUser;

  // Filter groups to ones the current user can reach. Drop groups that
  // end up with no visible items so the rail doesn't show empty
  // headers. Items with a `flag` field are also gated on the matching
  // system-settings boolean — null while the cache loads (treated as
  // off, so flagged entries hide until we know they should appear).
  // Developer mode override: when active, all flag-gated items show
  // and __devOnly items become visible.
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SETTINGS_GROUPS
      .map((g) => ({
        ...g,
        items: g.items.filter((it) => {
          // __devOnly entries — only when dev mode is unlocked AND not previewing.
          if (it.__devOnly && !effectiveDev) return false;
          // Permission check.
          if (it.perm !== null && it.perm !== undefined && !hasPermission(user, it.perm)) return false;
          // Flag check — bypass when dev mode is active.
          if (it.flag && !effectiveDev && !settings?.[it.flag]) return false;
          // Search filter.
          if (q && !it.label.toLowerCase().includes(q)) return false;
          return true;
        }),
      }))
      .filter((g) => g.items.length > 0);
  }, [user, settings, query, effectiveDev]);

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
