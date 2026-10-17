import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BankOutlined, UserOutlined, BgColorsOutlined, TagsOutlined,
  PrinterOutlined, SwapOutlined, ApiOutlined,
  CloudServerOutlined, HomeOutlined, DashboardOutlined,
  AppstoreOutlined, CodeOutlined, KeyOutlined, BellOutlined,
  CalendarOutlined, TeamOutlined, InboxOutlined, ImportOutlined,
  IdcardOutlined, WifiOutlined, WhatsAppOutlined, RobotOutlined,
  CreditCardOutlined, GlobalOutlined, FieldTimeOutlined, CloudDownloadOutlined,
  ShoppingCartOutlined, ShoppingOutlined, DatabaseOutlined, PercentageOutlined,
  BarcodeOutlined, CloseCircleFilled, GiftOutlined,
} from '@ant-design/icons';
import useDevModeStore from '../../store/devModeStore';
import { hasPermission } from '../../utils/perms';
import useAuthStore from '../../store/authStore';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import './ModuleSettings.css';
import './SettingsLayout.css';
import { isRemoteShop } from '../../utils/remoteShop';

/**
 * SettingsLayout — macOS System Settings-style two-pane hub.
 *
 *   left rail (grouped by task)  │  right pane (active page)
 *
 * The rail is grouped by the job an operator is doing ("I'm billing a
 * sale", "I'm entering a purchase") rather than by how the settings are
 * stored, so a switch is found where it is used. Each item also lists
 * the individual settings on its page (`find`): the search box matches
 * those too, shows which one matched, and on click the page scrolls to
 * that row and flashes it.
 */

// Single registry of every settings page. Editing this list is the only
// thing required to add or remove an item from the rail. `perm` gates
// visibility (null = everyone); `find` is the search index for the page.
export const SETTINGS_GROUPS = [
  {
    label: 'Your Account',
    items: [
      { path: 'account',       icon: <UserOutlined />, tint: 'slate', label: 'My Account',    perm: null,
        find: ['Name', 'Password', 'Change password', 'Email', 'Mobile number', 'Profile', 'Sign-in'] },
      { path: 'notifications', icon: <BellOutlined />, tint: 'red', label: 'Notifications', perm: null,
        find: ['Bell', 'Alerts', 'Reminders'] },
    ],
  },
  {
    // Who the business is, and the books' calendar and tax rules.
    label: 'Business',
    items: [
      { path: 'company',        icon: <BankOutlined />,     tint: 'blue', label: 'Company Profile', perm: 'settings.manage_company',
        find: ['Company name', 'Address', 'GSTIN', 'PAN', 'Phone', 'Logo', 'Signature', 'Bank details', 'IFSC', 'UPI', 'State'] },
      { path: 'companies',      icon: <AppstoreOutlined />, tint: 'indigo', label: 'Companies',       perm: 'settings.manage_company',
        find: ['Switch company', 'New company', 'Archive company'] },
      { path: 'financial-year', icon: <CalendarOutlined />, tint: 'orange', label: 'Financial Year',  perm: 'settings.manage_company',
        find: ['Financial year dates', 'Compliance mode', 'Lock dates', 'Year end'] },
      { path: 'accounts',       icon: <PercentageOutlined />, tint: 'green', label: 'Tax & Accounts', perm: 'settings.manage_company',
        find: ['GST', 'Allow back-dated entries', 'Aging buckets', 'Overdue days', 'Audit trail', 'Watchful', 'Chase', 'Critical'] },
    ],
  },
  {
    // Everything that changes how a sale is billed.
    label: 'Sales',
    items: [
      { path: 'sales-bill',       icon: <ShoppingCartOutlined />, tint: 'accent', label: 'Sales Bill', perm: 'settings.manage_company',
        find: ['Sales form', 'Sale window', 'Amount-only billing', 'Merge repeat scans', 'Repeat scans', 'Back-to-back scans', 'Allow negative stock', 'Sell when stock runs out',
               'Sales bill prefix', 'Invoice number', 'Parcel label button', 'Bill numbering', 'GST calculation mode', 'Bill-wise GST', 'Product-wise GST', 'Due days on receipts'] },
      { path: 'salesmen',         icon: <IdcardOutlined />,   tint: 'teal', label: 'Salesmen',         perm: 'settings.manage_company',
        find: ['Salesman', 'Commission', 'Sales staff'] },
      { path: 'customer-insight', icon: <TeamOutlined />,     tint: 'purple', label: 'Party Insight',    perm: 'settings.manage_company',
        find: ['Party insight panel', 'F8', 'Customer history on sale'] },
      { path: 'membership',       icon: <CreditCardOutlined />, tint: 'pink', label: 'Membership',     perm: 'settings.manage_company',
        find: ['Loyalty', 'Points', 'Membership on sale bill'] },
      // Flag-gated on the membership master switch (Membership page).
      { path: 'membership-plans', icon: <TagsOutlined />,     tint: 'pink', label: 'Membership Plans', perm: 'settings.manage_company', flag: 'membership_enabled',
        find: ['Loyalty plans', 'Tiers', 'Plan price'] },
    ],
  },
  {
    label: 'Purchase',
    items: [
      { path: 'purchase-bill', icon: <ShoppingOutlined />, tint: 'brown', label: 'Purchase Bill', perm: 'settings.manage_company',
        find: ['Purchase form', 'Purchase window', 'Purchase bill prefix', 'Fixed margin', 'MG%', 'Margin', 'Due days on payments'] },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { path: 'stock',   icon: <DatabaseOutlined />, tint: 'amber', label: 'Stock & Products', perm: 'settings.manage_company',
        find: ['Default product mode', 'Variant', 'Single product', 'Cost of goods sold', 'COGS', 'FIFO', 'Weighted average',
               'Stock alerts', 'Low stock', 'Multi-warehouse', 'Batch tracking', 'Expiry', 'Block expired batches', 'Zero-stock batches',
               'Color', 'Single color label', 'Multi-color stock'] },
      { path: 'godowns', icon: <InboxOutlined />,    tint: 'amber', label: 'Godowns', perm: 'godowns.view', flag: 'multi_warehouse_enabled',
        find: ['Warehouse', 'Godown'] },
    ],
  },
  {
    label: 'Printing & Labels',
    items: [
      { path: 'print',   icon: <PrinterOutlined />, tint: 'slate', label: 'Print Templates', perm: 'settings.print',
        find: ['Invoice template', 'Bill print', 'Paper size', 'Thermal', 'A4', 'A5', 'Printer'] },
      { path: 'parcel-labels', icon: <GiftOutlined />, tint: 'brown', label: 'Parcel Labels', perm: 'settings.manage_company',
        find: ['Parcel tag', 'Parcel slip', 'Shipping label', 'Carton label', '10 x 10', 'Courier', 'Transport label', 'Label design', 'Show From', 'Sender', 'Button on the sale bill'] },
      { path: 'barcode', icon: <BarcodeOutlined />, tint: 'slate', label: 'Barcode Labels',  perm: 'settings.barcode',
        find: ['Barcode', 'Label size', 'Sticker', 'Label designer'] },
    ],
  },
  {
    label: 'Staff & Access',
    items: [
      { path: 'users',            icon: <TeamOutlined />,      tint: 'blue', label: 'Users & Roles',    perm: 'settings.manage_users',
        find: ['Users', 'Roles', 'Permissions', 'Back-dated entries for a role', 'Add user', 'Deactivate user'] },
      { path: 'staff-attendance', icon: <FieldTimeOutlined />, tint: 'teal', label: 'Staff Attendance', perm: 'settings.manage_company',
        find: ['Check-in', 'Staff phone', 'PIN', 'Selfie', 'Location', 'Wi-Fi check', 'Roster'] },
    ],
  },
  {
    // Moving data in and out, other computers and phones, and the safety net.
    label: 'Data & Sync',
    items: [
      { path: 'backup',        icon: <CloudServerOutlined />, tint: 'blue', label: 'Backup & Recovery', perm: 'settings.backup', localOnly: true,
        find: ['Backup', 'Restore', 'Auto backup', 'Cleanup', 'Wipe data'] },
      { path: 'network',       icon: <WifiOutlined />,        tint: 'blue', label: 'LAN & Network',     perm: 'settings.manage_company', localOnly: true,
        find: ['LAN access', 'Other computers', 'Wi-Fi', 'Devices'] },
      { path: 'remote-access', icon: <GlobalOutlined />,      tint: 'indigo', label: 'Remote Access',   perm: 'settings.manage_company', localOnly: true,
        find: ['Web link', 'Open from anywhere', 'Phone access'] },
      { path: 'whatsapp',      icon: <WhatsAppOutlined />,    tint: 'green', label: 'WhatsApp',         perm: 'settings.manage_company',
        find: ['Send invoice on WhatsApp', 'Statement on WhatsApp', 'QR', 'Cloud API'] },
      { path: 'whatsapp-bot',  icon: <RobotOutlined />,       tint: 'green', label: 'WhatsApp Bot',     perm: 'settings.manage_company',
        find: ['Auto reply', 'Customer bot'] },
      { path: 'import-export', icon: <SwapOutlined />,        tint: 'slate', label: 'Import & Export',  perm: 'settings.import_export', flag: 'dev_show_import_export', localOnly: true,
        find: ['Excel', 'CSV', 'Import products', 'Export'] },
      { path: 'import',        icon: <ImportOutlined />,      tint: 'slate', label: 'Import (queued)',  perm: 'settings.import_export', flag: 'dev_show_import_export', localOnly: true },
      { path: 'tally',         icon: <ApiOutlined />,         tint: 'slate', label: 'TallyPrime Sync',  perm: 'settings.tally',         flag: 'dev_show_tally_sync',
        find: ['Tally'] },
    ],
  },
  {
    // How ZEHEN itself looks and stays current on this computer.
    label: 'App',
    items: [
      { path: 'theme',           icon: <BgColorsOutlined />,      tint: 'purple', label: 'Theme',           perm: null,
        find: ['Dark mode', 'Light mode', 'Colours', 'Appearance', 'Accent colour', 'Menu layout'] },
      { path: 'home',            icon: <HomeOutlined />,          tint: 'orange', label: 'Home Screen',     perm: null,
        find: ['Home page', 'Shortcuts', 'Tiles'] },
      { path: 'dashboard',       icon: <DashboardOutlined />,     tint: 'orange', label: 'Dashboard',       perm: null,
        find: ['Dashboard tiles', 'Charts'] },
      { path: 'software-update', icon: <CloudDownloadOutlined />, tint: 'accent', label: 'Software Update', perm: 'settings.manage_company', localOnly: true,
        find: ['Update', 'Version', 'Automatic updates', 'Release notes'] },
      { path: 'license',         icon: <KeyOutlined />,           tint: 'amber', label: 'License',         perm: null, localOnly: true,
        find: ['Licence', 'Expiry', 'Customer ID', 'Activation'] },
      // Only when developer mode is unlocked on this device.
      { path: 'developer',       icon: <CodeOutlined />,          tint: 'slate', label: 'Developer Access', __devOnly: true },
    ],
  },
];

/* Old addresses → where those settings live now. Bookmarks, links in
 * other screens and the global search keep working. */
export const SETTINGS_REDIRECTS = {
  modules:  'stock',
  defaults: 'sales-bill',
  system:   'stock',
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

export default function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const settings = useSystemSettings();
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  // Developer mode + preview-as-user — same logic as the main sidebar's
  // useMenuItems filter. When dev is unlocked AND not previewing, every
  // `flag`-gated entry is visible regardless of the system_settings
  // value, and `__devOnly` entries (Developer Access) appear.
  const devUnlocked   = useDevModeStore((s) => s.unlocked);
  const previewAsUser = useDevModeStore((s) => s.previewAsUser);
  const effectiveDev  = devUnlocked && !previewAsUser;
  // Working in another shop over its tunnel — see the localOnly filter below.
  const remote = isRemoteShop();

  // Pages this user can reach. Items with a `flag` are also gated on the
  // matching system-settings boolean (null while the cache loads = hidden).
  const reachable = useMemo(() => SETTINGS_GROUPS
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => {
        if (it.__devOnly && !effectiveDev) return false;
        /* localOnly — administers the INSTALLATION rather than the books
         * (backups, licence, this PC's network). The tunnel refuses them,
         * so hide them while working in another shop. */
        if (it.localOnly && remote) return false;
        if (it.perm !== null && it.perm !== undefined && !hasPermission(user, it.perm)) return false;
        if (it.flag && !effectiveDev && !settings?.[it.flag]) return false;
        return true;
      }),
    }))
    .filter((g) => g.items.length > 0), [user, settings, effectiveDev, remote]);

  // Search: page name first, then any setting on that page. A setting
  // match carries the setting's own name so the row can say what matched.
  const visibleGroups = useMemo(() => {
    const q = norm(query);
    if (!q) return reachable;
    const words = q.split(' ');
    const hit = (text) => { const t = norm(text); return words.every((w) => t.includes(w)); };
    return reachable
      .map((g) => ({
        ...g,
        items: g.items.flatMap((it) => {
          if (hit(it.label) || hit(`${g.label} ${it.label}`)) return [{ ...it, key: it.path }];
          return (it.find || []).filter(hit).slice(0, 3)
            .map((f) => ({ ...it, key: `${it.path}:${f}`, match: f }));
        }),
      }))
      .filter((g) => g.items.length > 0);
  }, [reachable, query]);

  const totalVisible = visibleGroups.reduce((n, g) => n + g.items.length, 0);

  const isActive = (path) =>
    location.pathname === `/settings/${path}` ||
    location.pathname.startsWith(`/settings/${path}/`);

  const open = (it) => {
    navigate(`/settings/${it.path}`, it.match ? { state: { settingsFind: it.match } } : undefined);
  };

  // Ctrl/Cmd+F focuses the settings search while the hub is open.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Arrived from a search hit: find the row whose label matches and bring
  // it into view with a brief highlight. Pages load their data async, so
  // look for a little while before giving up.
  const findTarget = location.state?.settingsFind;
  useEffect(() => {
    if (!findTarget) return undefined;
    const want = norm(findTarget);
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const pane = document.querySelector('.settings-pane');
      const nodes = pane ? pane.querySelectorAll(
        '.ms-row-label, .ms-section-title, .ms-row-desc, .ant-form-item-label label, .ant-tabs-tab, h2, h3, b, label') : [];
      let el = null;
      for (const n of nodes) { if (norm(n.textContent).includes(want)) { el = n; break; } }
      if (el || tries > 25) {
        clearInterval(timer);
        if (!el) return;
        const row = el.closest('.ms-row, .ms-row-stacked, .ms-section, .ant-form-item') || el;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('settings-find-flash');
        void row.offsetWidth; // restart the animation
        row.classList.add('settings-find-flash');
        setTimeout(() => row.classList.remove('settings-find-flash'), 2400);
      }
    }, 120);
    return () => clearInterval(timer);
  }, [findTarget, location.key]);

  return (
    <div className="settings-layout">
      <aside className="settings-rail" role="navigation" aria-label="Settings">
        <div className="settings-rail-search">
          <div className="settings-rail-search-wrap">
            <input
              ref={searchRef}
              type="text"
              className="settings-rail-search-input"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); }
                if (e.key === 'Enter') {
                  const first = visibleGroups[0]?.items[0];
                  if (first) open(first);
                }
              }}
              aria-label="Search settings"
            />
            {query && (
              <button type="button" className="settings-rail-search-clear" aria-label="Clear search"
                      onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
                <CloseCircleFilled />
              </button>
            )}
          </div>
        </div>

        {totalVisible === 0 && (
          <div className="settings-rail-empty">
            {query ? `No settings match “${query}”.` : 'No settings available.'}
          </div>
        )}

        {visibleGroups.map((group) => (
          <div key={group.label} className="settings-rail-group">
            <div className="settings-rail-group-label">{group.label}</div>
            <ul className="settings-rail-list">
              {group.items.map((it) => (
                <li key={it.key || it.path}>
                  <button
                    type="button"
                    className={`settings-rail-item${isActive(it.path) && !it.match ? ' active' : ''}${it.match ? ' is-match' : ''}`}
                    onClick={() => open(it)}
                  >
                    <span className={`settings-rail-item-icon tint-${it.tint || 'accent'}`}>{it.icon}</span>
                    <span className="settings-rail-item-text">
                      <span className="settings-rail-item-label">{it.match || it.label}</span>
                      {it.match && <span className="settings-rail-item-sub">{it.label}</span>}
                    </span>
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
