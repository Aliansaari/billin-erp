import React, { useState, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { Layout, Menu, Dropdown, Avatar } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import useAuthStore from '../../store/authStore';
import useThemeStore from '../../store/themeStore';
import { useNavGuard } from '../../hooks/useUnsavedChangesWarning';
import { resolveMode } from '../../theme/tokens';
import { useMenuItems, getOpenKeys, filterMenuByPermissions, getRouteIcon } from './menuConfig';
import useFavoritesStore from '../../store/favoritesStore';
import useFilteredAltMenus from '../../hooks/useFilteredAltMenus';
import {
  SettingOutlined,
  UserOutlined,
  ThunderboltOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LogoutOutlined,
  LockOutlined,
  SunOutlined,
  MoonOutlined,
  CodeOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import useDevModeStore from '../../store/devModeStore';
import CompanySwitcher from '../CompanySwitcher';
import FYSwitcher from '../FYSwitcher';
import { GlobalSearchTrigger } from '../GlobalSearch';
import { NotificationBell } from '../Notifications';

const { Sider } = Layout;

// menuItems + getOpenKeys are defined once in ./menuConfig and shared with
// TopNav so the two layouts always expose the same navigation. Adding a new
// route only needs one edit.

const roleColors = {
  'Super Admin':     '#B1472F',
  'Admin':           '#4F46E5',
  'Manager':         '#7C3AED',
  'Accountant':      '#3B82F6',
  'Salesman':        '#10B981',
  'Cashier':         '#10B981',
  'Inventory Staff': '#F59E0B',
};

/* ── Collapsed sidebar item with hover popup ──
 * Renders the same classic keyboard-driven popup that Alt+letter opens (matching
 * .mp-popup classes from MenuPopup.css), so mouse-hover and keyboard
 * shortcuts share one visual UI. Letters / sub-text come from
 * ALT_MENUS, keyed by anchorKey === item.key. Falls back to plain
 * children if the catalog has no entry. */
function CollapsedItem({ item, currentPath, navigate }) {
  const [popupPos, setPopupPos] = useState(null);
  const hideTimer = useRef(null);

  // Look up the classic keyboard menu definition for this sidebar item. Items
  // without a catalog entry (favorites, ad-hoc) render their plain
  // children with a bullet placeholder where the letter would be.
  // Uses the filtered version so dev-gated entries (Ledger Integrity
  // when its flag is off) don't appear in the hover popup either.
  const altMenus = useFilteredAltMenus();
  const keyboardMenu = useMemo(() => {
    for (const code in altMenus) {
      if (altMenus[code].anchorKey === item.key) return altMenus[code];
    }
    return null;
  }, [item.key, altMenus]);

  const popupItems = useMemo(() => {
    if (keyboardMenu) return keyboardMenu.items;
    return (item.children || []).map(c => ({ letter: '', label: c.label, sub: '', route: c.key }));
  }, [keyboardMenu, item.children]);

  const isActive = item.children
    ? item.children.some(c => currentPath === c.key || currentPath.startsWith(c.key))
    : currentPath === item.key;

  const showPopup = (e) => {
    clearTimeout(hideTimer.current);
    const rect = e.currentTarget.getBoundingClientRect();
    setPopupPos({ top: rect.top });
  };
  const hidePopup = () => {
    hideTimer.current = setTimeout(() => setPopupPos(null), 150);
  };
  const cancelHide = () => clearTimeout(hideTimer.current);

  return (
    <div
      className={`erp-ci${isActive ? ' erp-ci-active' : ''}`}
      onMouseEnter={showPopup}
      onMouseLeave={hidePopup}
      onClick={() => { if (!item.children) { navigate(item.key); } }}
      title={item.children ? '' : item.label}
      data-shortcut-key={item.key}
    >
      <span className="erp-ci-icon">{item.icon}</span>

      {item.children && popupPos && ReactDOM.createPortal(
        <>
          {/* Transparent bridge covers the icon→arrow gap so the cursor
              can travel across without triggering hide. */}
          <div
            style={{
              position: 'fixed', left: 56, top: popupPos.top,
              width: 10, height: 44, zIndex: 1299,
            }}
            onMouseEnter={cancelHide}
            onMouseLeave={hidePopup}
          />
          <div
            className="mp-popup"
            data-arrow="left"
            style={{
              // popup.left = 66 puts the arrow tip (7px left of popup)
              // exactly on the collapsed-sidebar's right edge (~59px),
              // so the caret reads as growing out of the icon.
              position: 'fixed', left: 66, top: popupPos.top, zIndex: 1300,
              // Icon row is 42px tall; arrow caret (12px) centres at 21-6=15
              '--arrow-y': '15px',
            }}
            onMouseEnter={cancelHide}
            onMouseLeave={hidePopup}
            role="menu"
            aria-label={item.label}
          >
            <div className="mp-head">
              <span className="mp-title">{item.label}</span>
              <span className="mp-hint">Alt+{ALT_HINTS[item.key] || keyboardMenu?.items?.[0]?.letter || ''}</span>
            </div>
            <ul className="mp-list">
              {popupItems.map(child => {
                const isCurrent =
                  currentPath === child.route ||
                  (child.route && currentPath.startsWith(child.route + '/'));
                return (
                  <li
                    key={child.route}
                    className={`mp-item${isCurrent ? ' is-current' : ''}`}
                    onClick={() => { setPopupPos(null); navigate(child.route); }}
                    role="menuitem"
                    aria-current={isCurrent ? 'page' : undefined}
                  >
                    <span className="mp-icon">{getRouteIcon(child.route)}</span>
                    <span className="mp-label">{child.label}</span>
                    {child.letter && <span className="mp-shortcut">{child.letter}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

/* Alt shortcut letter → menu key. Same mapping TopNav uses; kept here
 * because importing from TopNav would create a circular dep. */
const ALT_HINTS = {
  '/':               'H',
  '/dashboard':      'D',
  'sales-menu':      'S',
  'purchase-menu':   'P',
  'parties-menu':    'E',
  'inventory-menu':  'I',
  'bank-menu':       'B',
  'accounts-menu':   'A',
  'reports-menu':    'R',
  '/settings/company': 'T',
};

/* Underline the Alt shortcut letter inside a label string — standard
 * Windows accelerator-key convention (Tally, MS Office, etc.). */
function hintLabel(label, key) {
  const letter = ALT_HINTS[key];
  if (!letter || typeof label !== 'string') return label;
  const idx = label.toLowerCase().indexOf(letter.toLowerCase());
  if (idx === -1) return label;
  return (
    <>
      {label.slice(0, idx)}
      <span className="menu-hint-key">{label[idx]}</span>
      {label.slice(idx + 1)}
    </>
  );
}

/* Recursively replace plain-string labels with underlined-hint JSX.
 * Only touches the top-level items (children don't need hints). */
function applyHintLabels(items) {
  return items.map(item => ({
    ...item,
    label: hintLabel(item.label, item.key),
  }));
}

export default function Sidebar({ collapsed, setCollapsed }) {
  const rawNavigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const [openKeys, setOpenKeys] = useState(() => getOpenKeys(location.pathname));

  // Prune the menu to items this user can reach. Re-filters when the
  // user changes (login/logout/role reassignment).
  // Favorites drive the Reports submenu's children; load once on
  // auth and let the store push updates whenever the user pins/
  // unpins from the hub.
  const loadFavs   = useFavoritesStore((s) => s.load);
  const favsLoaded = useFavoritesStore((s) => s.loaded);
  React.useEffect(() => { if (user && !favsLoaded) loadFavs(); }, [user, favsLoaded, loadFavs]);

  // useMenuItems subscribes to favorites — Sidebar re-renders when
  // pins change, dropdown reflects new state without manual refresh.
  const menuItems = useMenuItems();
  const visibleItems = React.useMemo(() => filterMenuByPermissions(menuItems, user), [user, menuItems]);

  // Guarded navigate — asks for confirmation when the current form has unsaved work.
  // confirmLeave takes an onConfirm callback; when the form is clean it calls
  // the callback immediately, when dirty it pops the AntD modal and calls the
  // callback only on "Discard and leave". Previously we called it as a boolean
  // and wrapped navigation in an `if`, which silently dropped every click
  // because confirmLeave returns undefined when used without its callback.
  const navigate = (to, opts) => {
    if (to === location.pathname) return;
    useNavGuard.getState().confirmLeave(() => rawNavigate(to, opts));
  };

  const themeStyle = useThemeStore((s) => s.themeStyle);
  const appearance = useThemeStore((s) => s.appearance);
  const setAppearance = useThemeStore((s) => s.setAppearance);
  const mode = resolveMode(themeStyle, appearance);
  const isDark = mode.endsWith('dark');
  const menuTheme = 'dark';

  const handleOpenChange = (keys) => {
    const latest = keys.find(k => !openKeys.includes(k));
    setOpenKeys(latest ? [latest] : []);
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // Developer-mode affordances in the user menu. The unlock modal itself
  // and the hidden "/__dev" trigger listener live in <DeveloperGateMount/>
  // (mounted globally in App.jsx) so they work in every layout — the
  // sidebar only reads the unlocked state here to decide which menu
  // items to show.
  const devUnlocked   = useDevModeStore((s) => s.unlocked);
  const previewAsUser = useDevModeStore((s) => s.previewAsUser);
  const lockDevMode   = useDevModeStore((s) => s.lock);
  // "effective" dev = unlocked AND not previewing as a regular user.
  // When previewing, every dev affordance hides from the dropdown so
  // the developer sees the dropdown a normal user sees.
  const effectiveDev  = devUnlocked && !previewAsUser;

  const userMenuItems = [
    {
      key: 'user-info',
      label: (
        <div style={{ padding: '4px 0', borderBottom: '1px solid var(--border-subtle)', marginBottom: 4, pointerEvents: 'none' }}>
          <div style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>{user?.full_name || 'User'}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{user?.role || 'Admin'}</div>
          {effectiveDev && (
            <div style={{ fontSize: 11, color: '#9333ea', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
              <CodeOutlined style={{ fontSize: 11 }} /> Developer mode active
            </div>
          )}
          {devUnlocked && previewAsUser && (
            <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
              👁 Previewing as regular user
            </div>
          )}
        </div>
      ),
      disabled: true,
    },
    { key: 'profile', icon: <UserOutlined />, label: 'My Profile' },
    { key: 'change-password', icon: <LockOutlined />, label: 'Change Password', onClick: () => navigate('/change-password') },
    { key: 'settings', icon: <SettingOutlined />, label: 'Settings', onClick: () => navigate('/settings/company') },
    // Keyboard shortcuts cheat sheet — mouse path to the overlay (App.jsx
    // listens for 'shortcuts:open'). The Cmd/Ctrl+Shift+? keystroke still
    // works; this is the discovery surface for operators who don't know it.
    { key: 'shortcuts', icon: <QuestionCircleOutlined />, label: 'Keyboard shortcuts',
      onClick: () => window.dispatchEvent(new Event('shortcuts:open')) },
    // Developer affordances appear ONLY when developer mode is unlocked
    // AND not previewing as a regular user. The locked-state dropdown
    // is intentionally identical to a normal admin's — no clue that
    // developer mode exists. To unlock, type "/__dev" in global search.
    ...(effectiveDev ? [
      { type: 'divider' },
      { key: 'dev-settings', icon: <CodeOutlined style={{ color: '#9333ea' }} />, label: 'Developer Settings', onClick: () => navigate('/settings/developer') },
      { key: 'dev-lock',     icon: <LockOutlined />, label: 'Lock developer mode', onClick: lockDevMode },
    ] : []),
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: 'Sign Out', danger: true, onClick: handleLogout },
  ];

  const avatarBg = roleColors[user?.role] || '#4F46E5';

  return (
    <Sider
      trigger={null}
      collapsible
      collapsed={collapsed}
      width={230}
      collapsedWidth={68}
      className="erp-sidebar"
      style={{ height: '100vh', position: 'sticky', top: 0, left: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div className="erp-sidebar-inner">
        {/* Logo + collapse toggle */}
        <div className={`erp-sidebar-logo${collapsed ? ' collapsed' : ''}`}>
          {collapsed ? (
            <ThunderboltOutlined className="erp-sidebar-logo-icon" />
          ) : (
            <div className="erp-sidebar-logo-full">
              <ThunderboltOutlined className="erp-sidebar-logo-icon" />
              <span className="erp-sidebar-logo-text">Billing ERP</span>
            </div>
          )}
          <button
            type="button"
            className="erp-sidebar-collapse-btn top"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </div>

        {/* Company switcher — auto-hidden when only one company exists,
            so single-company installs see no extra UI clutter. Classic-style
            pill that opens a dropdown of every company + Manage link.
            Collapsed padding is 4 px symmetrical so every row in the
            icon column reads as the same rhythm (was 8 px bottom which
            created a visible hole above the search). */}
        <div style={{ padding: collapsed ? '4px 8px' : '0 12px 6px' }}>
          <CompanySwitcher collapsed={collapsed} />
        </div>

        {/* FY switcher — sits directly below the company switcher,
            same chrome. Shows the current FY context with a click-to-
            switch dropdown listing past FYs. Always visible. */}
        <div style={{ padding: collapsed ? '4px 8px' : '0 12px 10px' }}>
          <FYSwitcher collapsed={collapsed} />
        </div>

        {/* Search affordance — sits between the company switcher and the
            menu so it reads as a primary verb, not a utility. Collapsed
            sidebar renders the icon form; expanded uses the same pill
            variant the topbar uses (34 px tall, kbd hint right-aligned)
            so the chrome is consistent across both layouts.
            The notification bell used to ride alongside here; it moved to
            the bottom of the sidebar — closer to the user-avatar pill,
            matching the "personal cluster" convention in Slack / Discord
            / Linear, and leaving the top tools row for the search verb
            alone. */}
        <div
          className="erp-sidebar-tools"
          style={{
            display: 'flex',
            alignItems: 'center',
            /* Collapsed: 4 px symmetrical so search icon sits in the same
               rhythm as company icon above and menu icons below — was
               '0 8px 8px' which stacked with the menu region's 8 px top
               padding into a 16 px hole between search and home. */
            padding: collapsed ? '4px 8px' : '0 12px 10px',
          }}
        >
          <GlobalSearchTrigger variant={collapsed ? 'icon' : 'pill'} />
        </div>

        {/* ── Scrollable menu region ── */}
        <div className="erp-sidebar-scroll">
          {collapsed ? (
            /* 4 px top/bottom (was 8) so the menu rail's outer rhythm
               matches the other collapsed rows. The 2 px gap between
               icons inside stays. */
            <div style={{ padding: '4px 0', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {visibleItems.map(item => (
                <CollapsedItem
                  key={item.key}
                  item={item}
                  currentPath={location.pathname}
                  navigate={navigate}
                />
              ))}
            </div>
          ) : (
            <Menu
              theme={menuTheme}
              mode="inline"
              selectedKeys={[location.pathname]}
              openKeys={openKeys}
              onOpenChange={handleOpenChange}
              items={applyHintLabels(visibleItems)}
              onClick={({ key }) => { if (!key.endsWith('-menu')) navigate(key); }}
              style={{ borderRight: 0, padding: '8px 4px', background: 'transparent' }}
            />
          )}
        </div>

        {/* Notification bell — relocated from the top tools row. Sits
            just above the theme toggle so it groups with the "personal"
            chrome (theme + avatar) at the bottom rather than the
            "primary verbs" (search + workspace) at the top. Collapsed
            sidebar renders a single centred icon; expanded gives it a
            short row of its own. The bell component handles its own
            badge / dropdown / unread polling; we just place it. */}
        <div className={`erp-sidebar-notif${collapsed ? ' collapsed' : ''}`}>
          <NotificationBell align="left" />
        </div>

        {/* ── Sticky bottom: theme toggle + layout toggle + user avatar ── */}
        <div className={`erp-sidebar-theme${collapsed ? ' collapsed' : ''}`}>
          {collapsed ? (
            <button
              type="button"
              className="erp-sidebar-theme-btn icon"
              onClick={() => setAppearance(isDark ? 'light' : 'dark')}
              title={isDark ? 'Switch to Light' : 'Switch to Dark'}
            >
              {isDark ? <SunOutlined /> : <MoonOutlined />}
            </button>
          ) : (
            <div className="erp-sidebar-theme-toggle" role="tablist">
              <button
                type="button"
                className={`erp-sidebar-theme-opt${!isDark ? ' active' : ''}`}
                onClick={() => setAppearance('light')}
              >
                <SunOutlined /> Light
              </button>
              <button
                type="button"
                className={`erp-sidebar-theme-opt${isDark ? ' active' : ''}`}
                onClick={() => setAppearance('dark')}
              >
                <MoonOutlined /> Dark
              </button>
            </div>
          )}
        </div>

        {/* Menu orientation (vertical / horizontal) lives in Settings → Theme —
            it's a "pick once" preference, not something to flip from every page. */}

        <div className={`erp-sidebar-bottom${collapsed ? ' collapsed' : ''}`}>
          <Dropdown menu={{ items: userMenuItems }} placement={collapsed ? 'topLeft' : 'topRight'} trigger={['click']}>
            <div className="erp-sidebar-user" title={collapsed ? (user?.full_name || 'User') : ''}>
              <Avatar size={collapsed ? 32 : 34} icon={<UserOutlined />} style={{ backgroundColor: avatarBg, flexShrink: 0 }} />
              {!collapsed && (
                <div className="erp-sidebar-user-text">
                  <div className="erp-sidebar-user-name">{user?.full_name || 'User'}</div>
                  <div className="erp-sidebar-user-role">{user?.role || 'Admin'}</div>
                </div>
              )}
            </div>
          </Dropdown>
        </div>
      </div>
    </Sider>
  );
}
