import React, { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BankOutlined, UserOutlined, BgColorsOutlined, TagsOutlined,
  PrinterOutlined, ThunderboltOutlined, SwapOutlined, ApiOutlined,
  CloudServerOutlined, HomeOutlined, ControlOutlined, DashboardOutlined,
  AppstoreOutlined, CodeOutlined, KeyOutlined, BellOutlined,
  CalendarOutlined, TeamOutlined, InboxOutlined, ImportOutlined,
  IdcardOutlined, WifiOutlined, WhatsAppOutlined, RobotOutlined,
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
    // Company-level setup — the natural starting point for a fresh
    // install: who you are, the books' financial year, and where
    // stock physically lives.
    label: 'Organization',
    items: [
      { path: 'company',        icon: <BankOutlined />,     label: 'Company Profile', perm: 'settings.manage_company' },
      // Companies — list / create / archive across companies in the
      // master DB. Same permission gate as Company Profile so anyone who
      // can edit the current company's profile can also see the list.
      { path: 'companies',      icon: <AppstoreOutlined />, label: 'Companies',       perm: 'settings.manage_company' },
      // Financial Year — FY config + accounting-style compliance toggle
      // (soft/hard locks + override workflow + audit log).
      { path: 'financial-year', icon: <CalendarOutlined />, label: 'Financial Year',  perm: 'settings.manage_company' },
      { path: 'godowns',        icon: <InboxOutlined />,    label: 'Godowns',         perm: 'godowns.view', flag: 'multi_warehouse_enabled' },
      // Salesmen — master list of sales staff credited on bills. No flag
      // gate; always available to company-settings managers.
      { path: 'salesmen',       icon: <IdcardOutlined />,   label: 'Salesmen',        perm: 'settings.manage_company' },
    ],
  },
  {
    // How billing and inventory behave day to day — the master feature
    // switches and the default values pre-filled on new entries.
    label: 'Preferences',
    items: [
      { path: 'modules',          icon: <ThunderboltOutlined />, label: 'Features',         perm: 'settings.manage_company' },
      { path: 'defaults',         icon: <ControlOutlined />,     label: 'Defaults',         perm: 'settings.manage_company' },
      { path: 'customer-insight', icon: <TeamOutlined />,        label: 'Party Insight',    perm: 'settings.manage_company' },
    ],
  },
  {
    // Appearance + the document and label templates the operator prints.
    label: 'Customization',
    items: [
      { path: 'print',     icon: <PrinterOutlined />,   label: 'Print Templates', perm: 'settings.print' },
      { path: 'barcode',   icon: <TagsOutlined />,      label: 'Barcode Labels',  perm: 'settings.barcode' },
      { path: 'theme',     icon: <BgColorsOutlined />,  label: 'Theme',           perm: null },
      { path: 'home',      icon: <HomeOutlined />,      label: 'Home Screen',     perm: null },
      { path: 'dashboard', icon: <DashboardOutlined />, label: 'Dashboard',       perm: null },
    ],
  },
  {
    // People — personal preferences first (every signed-in user has
    // these), then the admin-only user roster.
    label: 'Users & Access',
    items: [
      // My Account / Notifications — every logged-in user can reach
      // these (perm:null). Each operator manages their own.
      { path: 'account',       icon: <UserOutlined />, label: 'My Account',    perm: null },
      { path: 'notifications', icon: <BellOutlined />, label: 'Notifications', perm: null },
      { path: 'users',         icon: <TeamOutlined />, label: 'Users',         perm: 'settings.manage_users' },
    ],
  },
  {
    // Moving data in/out, external sync, and the safety net. Import /
    // Export + Tally mirror the developer-tier flags used by the main
    // sidebar so the rail honours the same hide/show toggles. Backup
    // stays visible regardless.
    label: 'Data & Integrations',
    items: [
      // LAN access — share this PC's Billing ERP with other PCs / phones
      // on the same Wi-Fi. Admin-level (super admin / company manager).
      { path: 'network',       icon: <WifiOutlined />,        label: 'LAN & Network',     perm: 'settings.manage_company' },
      // Send invoices / statements to customers on WhatsApp (Web link or official Cloud-API).
      { path: 'whatsapp',      icon: <WhatsAppOutlined />,    label: 'WhatsApp',          perm: 'settings.manage_company' },
      // Customer self-service bot — auto-replies to customers who message the number.
      { path: 'whatsapp-bot',  icon: <RobotOutlined />,       label: 'WhatsApp Bot',      perm: 'settings.manage_company' },
      { path: 'import-export', icon: <SwapOutlined />,        label: 'Import & Export',   perm: 'settings.import_export', flag: 'dev_show_import_export' },
      { path: 'import',        icon: <ImportOutlined />,      label: 'Import (queued)',   perm: 'settings.import_export', flag: 'dev_show_import_export' },
      { path: 'tally',         icon: <ApiOutlined />,         label: 'TallyPrime Sync',   perm: 'settings.tally',         flag: 'dev_show_tally_sync' },
      { path: 'backup',        icon: <CloudServerOutlined />, label: 'Backup & Recovery', perm: 'settings.backup' },
    ],
  },
  {
    // Visible only when developer mode is unlocked on this device
    // (the `__devOnly` marker — honoured by visibleGroups below).
    label: 'Developer',
    items: [
      { path: 'developer', icon: <CodeOutlined />, label: 'Developer Access', __devOnly: true },
      // License — visible to anyone (so the customer can see expiry /
      // customer ID); the sensitive Replace flow is dev-gated inside
      // the panel itself.
      { path: 'license',   icon: <KeyOutlined />,  label: 'License',          perm: null },
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
