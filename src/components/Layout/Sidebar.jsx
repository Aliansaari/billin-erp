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
import { ALT_MENUS } from '../keyboard/menuCatalog';
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
} from '@ant-design/icons';

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
 * Renders the same Tally-style popup that Alt+letter opens (matching
 * .mp-popup classes from MenuPopup.css), so mouse-hover and keyboard
 * shortcuts share one visual UI. Letters / sub-text come from
 * ALT_MENUS, keyed by anchorKey === item.key. Falls back to plain
 * children if the catalog has no entry. */
function CollapsedItem({ item, currentPath, navigate }) {
  const [popupPos, setPopupPos] = useState(null);
  const hideTimer = useRef(null);

  // Look up the Tally menu definition for this sidebar item. Items
  // without a catalog entry (favorites, ad-hoc) render their plain
  // children with a bullet placeholder where the letter would be.
  const tallyMenu = useMemo(() => {
    for (const code in ALT_MENUS) {
      if (ALT_MENUS[code].anchorKey === item.key) return ALT_MENUS[code];
    }
    return null;
  }, [item.key]);

  const popupItems = useMemo(() => {
    if (tallyMenu) return tallyMenu.items;
    return (item.children || []).map(c => ({ letter: '', label: c.label, sub: '', route: c.key }));
  }, [tallyMenu, item.children]);

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
          {/* Transparent bridge covers the gap between icon and popup so
              the cursor can travel across without triggering hide. */}
          <div
            style={{
              position: 'fixed', left: 64, top: popupPos.top,
              width: 12, height: 44, zIndex: 1299,
            }}
            onMouseEnter={cancelHide}
            onMouseLeave={hidePopup}
          />
          <div
            className="mp-popup"
            style={{ position: 'fixed', left: 76, top: popupPos.top, zIndex: 1300 }}
            onMouseEnter={cancelHide}
            onMouseLeave={hidePopup}
            role="menu"
            aria-label={item.label}
          >
            <div className="mp-head">
              <span className="mp-title">{item.label}</span>
              <span className="mp-hint">Alt+{tallyMenu?.items?.[0]?.letter || ''} for keyboard</span>
            </div>
            <ul className="mp-list">
              {popupItems.map(child => {
                const isCurrent =
                  currentPath === child.route ||
                  (child.route && currentPath.startsWith(child.route + '/'));
                return (
                  <li
                    key={child.route}
                    className="mp-item"
                    onClick={() => { setPopupPos(null); navigate(child.route); }}
                    role="menuitem"
                    aria-current={isCurrent ? 'page' : undefined}
                  >
                    <span className="mp-icon">{getRouteIcon(child.route)}</span>
                    <span className="mp-label">{child.label}</span>
                    {child.sub && <span className="mp-sub">{child.sub}</span>}
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

  const userMenuItems = [
    {
      key: 'user-info',
      label: (
        <div style={{ padding: '4px 0', borderBottom: '1px solid var(--border-subtle)', marginBottom: 4, pointerEvents: 'none' }}>
          <div style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>{user?.full_name || 'User'}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{user?.role || 'Admin'}</div>
        </div>
      ),
      disabled: true,
    },
    { key: 'profile', icon: <UserOutlined />, label: 'My Profile' },
    { key: 'change-password', icon: <LockOutlined />, label: 'Change Password', onClick: () => navigate('/change-password') },
    { key: 'settings', icon: <SettingOutlined />, label: 'Settings', onClick: () => navigate('/settings/company') },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: 'Sign Out', danger: true, onClick: handleLogout },
  ];

  const avatarBg = roleColors[user?.role] || '#4F46E5';

  return (
    <Sider
      trigger={null}
      collapsible
      collapsed={collapsed}
      width={270}
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

        {/* ── Scrollable menu region ── */}
        <div className="erp-sidebar-scroll">
          {collapsed ? (
            <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 2 }}>
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
              items={visibleItems}
              onClick={({ key }) => { if (!key.endsWith('-menu')) navigate(key); }}
              style={{ borderRight: 0, padding: '8px 4px', background: 'transparent' }}
            />
          )}
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
