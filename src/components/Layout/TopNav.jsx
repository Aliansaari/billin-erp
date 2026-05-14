import React, { useMemo } from 'react';
import { Dropdown, Avatar } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ThunderboltOutlined, UserOutlined, SettingOutlined, LockOutlined,
  LogoutOutlined, SunOutlined, MoonOutlined,
} from '@ant-design/icons';
import useAuthStore from '../../store/authStore';
import useThemeStore from '../../store/themeStore';
import { useNavGuard } from '../../hooks/useUnsavedChangesWarning';
import { resolveMode } from '../../theme/tokens';
import { useMenuItems, menuItems as staticMenuItems, getOpenKeys, filterMenuByPermissions } from './menuConfig';
import useFavoritesStore from '../../store/favoritesStore';
import { useMenuPopup } from '../keyboard/MenuPopup';
import useFilteredAltMenus from '../../hooks/useFilteredAltMenus';
import { GlobalSearchTrigger } from '../GlobalSearch';
import { NotificationBell } from '../Notifications';
import CompanySwitcher from '../CompanySwitcher';
import './top-nav.css';

/* ════════════════════════════════════════════════════════════════════════════
 *  TopNav — horizontal menu layout (vertical alternative lives in Sidebar).
 *
 *  Built from native buttons instead of `<Menu mode="horizontal">` so every
 *  element is a predictable, properly-contained pill. Fighting AntD's
 *  horizontal menu defaults (variable line-height, space distribution, icon
 *  vertical-align) caused the earlier layout bugs — the menu stretching to
 *  fill the bar, icons not aligning with text, items appearing with different
 *  heights on hover. Hand-rolling the row gives us exact control over:
 *
 *    · the pill container around each item (hover + active states)
 *    · icon-to-label alignment (single inline-flex, no line-height drift)
 *    · the overall menu width (hugs its content, right cluster pinned right)
 *
 *  Submenus open the Tally MenuPopup (same one Alt+letter triggers) so mouse
 *  and keyboard land in identical UI. The user-avatar dropdown still uses
 *  AntD's Dropdown — no keyboard equivalent, so unifying it would be over-
 *  reach.
 * ═══════════════════════════════════════════════════════════════════════════ */

const roleColors = {
  'Super Admin':     '#B1472F',
  'Admin':           '#4F46E5',
  'Manager':         '#7C3AED',
  'Accountant':      '#3B82F6',
  'Salesman':        '#10B981',
  'Cashier':         '#10B981',
  'Inventory Staff': '#F59E0B',
};

export default function TopNav() {
  const rawNavigate = useNavigate();
  const location    = useLocation();
  const { user, logout } = useAuthStore();

  const themeStyle    = useThemeStore((s) => s.themeStyle);
  const appearance    = useThemeStore((s) => s.appearance);
  const setAppearance = useThemeStore((s) => s.setAppearance);
  const mode   = resolveMode(themeStyle, appearance);
  const isDark = mode.endsWith('dark');

  const { openMenu } = useMenuPopup();

  // Reverse-lookup: anchorKey ('sales-menu') -> ALT_MENUS entry. Lets a
  // pill click open the same Tally popup that Alt+S opens, so mouse and
  // keyboard land in identical UI instead of two different dropdowns.
  // Uses the dev-flag-filtered version so pill-click can't reach a
  // route the sidebar / keyboard wouldn't allow.
  const altMenus = useFilteredAltMenus();
  const menusByAnchor = useMemo(() => {
    const m = {};
    for (const code in altMenus) {
      const menu = altMenus[code];
      if (menu.anchorKey) m[menu.anchorKey] = menu;
    }
    return m;
  }, [altMenus]);

  // Guarded navigate — matches Sidebar. confirmLeave takes an onConfirm
  // callback and fires it (clean form) or shows the AntD modal and fires
  // it on "Discard and leave" (dirty form). The earlier boolean form was
  // swallowing every click because confirmLeave returns undefined when
  // used without its callback.
  const navigate = (to, opts) => {
    if (to === location.pathname) return;
    useNavGuard.getState().confirmLeave(() => rawNavigate(to, opts));
  };

  // Which top-level pill is "active". Walk up via getOpenKeys so deep routes
  // like /sale/edit/42 still highlight the Sales pill.
  const activeKey = useMemo(() => {
    // activeKey resolution uses the static parent shape (favorites
    // children don't influence which top-level pill is highlighted).
    const exact = staticMenuItems.find((m) => m.key === location.pathname);
    if (exact) return exact.key;
    const opens = getOpenKeys(location.pathname);
    return opens[0] || null;
  }, [location.pathname]);

  // Favorites drive the Reports submenu's children; load once on auth.
  const loadFavs   = useFavoritesStore((s) => s.load);
  const favsLoaded = useFavoritesStore((s) => s.loaded);
  React.useEffect(() => { if (user && !favsLoaded) loadFavs(); }, [user, favsLoaded, loadFavs]);

  // useMenuItems subscribes to favorites so this nav re-renders when
  // a star toggles anywhere in the app.
  const menuItems = useMenuItems();
  // Prune the menu to items this user can reach.
  const visibleItems = useMemo(() => filterMenuByPermissions(menuItems, user), [user, menuItems]);

  const handleLogout = () => { logout(); navigate('/login'); };

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
    { key: 'profile',  icon: <UserOutlined />,    label: 'My Account', onClick: () => navigate('/settings/account') },
    { key: 'change-password', icon: <LockOutlined />, label: 'Change Password', onClick: () => navigate('/change-password') },
    { key: 'settings', icon: <SettingOutlined />, label: 'Settings', onClick: () => navigate('/settings/company') },
    { type: 'divider' },
    { key: 'logout',   icon: <LogoutOutlined />,  label: 'Sign Out', danger: true, onClick: handleLogout },
  ];

  const avatarBg = roleColors[user?.role] || '#4F46E5';

  // Render a single top-level entry. Entries with `children` open a dropdown
  // of sub-routes; leaf entries navigate directly.
  const renderItem = (item) => {
    const isActive = activeKey === item.key;
    const pillClass = `erp-topnav-pill${isActive ? ' is-active' : ''}`;

    if (item.children && item.children.length > 0) {
      // Click opens the same Tally popup that Alt+letter opens — single
      // UI for mouse and keyboard. Falls back to navigating the first
      // child if the catalog is missing this anchor (shouldn't happen
      // while menuConfig and menuCatalog stay in sync).
      const menu = menusByAnchor[item.key];
      const handleClick = () => {
        if (menu) {
          openMenu({
            title: menu.title,
            items: menu.items,
            anchorKey: menu.anchorKey,
            onPick: (it) => navigate(it.route),
          });
        } else {
          navigate(item.children[0].key);
        }
      };
      return (
        <button
          key={item.key}
          type="button"
          className={pillClass}
          onClick={handleClick}
          aria-label={item.label}
          data-shortcut-key={item.key}
        >
          <span className="pill-icon">{item.icon}</span>
          <span className="pill-label">{item.label}</span>
        </button>
      );
    }

    return (
      <button
        key={item.key}
        type="button"
        className={pillClass}
        onClick={() => navigate(item.key)}
        aria-label={item.label}
        data-shortcut-key={item.key}
      >
        <span className="pill-icon">{item.icon}</span>
        <span className="pill-label">{item.label}</span>
      </button>
    );
  };

  return (
    <header className="erp-topnav" data-mode={isDark ? 'dark' : 'light'}>
      {/* Brand — icon only (doubles as a home link). */}
      <button
        type="button"
        className="erp-topnav-brand"
        onClick={() => navigate('/')}
        title="Home"
        aria-label="Home"
      >
        <ThunderboltOutlined className="brand-icon" />
      </button>

      {/* Company switcher — was sidebar-only before; surfacing it here means
          horizontal-mode users can see + switch the active company without
          flipping layouts. Auto-hides when only one company exists, so
          single-company installs see no clutter. F9 still opens the
          dropdown from anywhere. */}
      <span className="erp-topnav-rule" aria-hidden="true" />
      <CompanySwitcher />

      {/* Main menu — hugs its content, doesn't stretch the bar. */}
      <span className="erp-topnav-rule" aria-hidden="true" />
      <nav className="erp-topnav-menu" aria-label="Primary">
        {visibleItems.map(renderItem)}
      </nav>

      {/* Right cluster — pinned to the right edge via margin-left: auto. */}
      <div className="erp-topnav-right">
        {/* Visible search affordance — onboards new operators who don't know
            Cmd/Ctrl+K. Sits at the head of the right cluster because it's a
            primary verb, not a utility. Collapses to icon-only under 900px
            via the .gs-trigger-pill media query. */}
        <GlobalSearchTrigger variant="pill" />
        {/* Smart notifications bell — auto-hides when the user has set
            master_enabled=false in Settings → Notifications. Polls the
            unread count in the background; full panel fetched on click. */}
        <NotificationBell />
        <button
          type="button"
          className="erp-topnav-iconbtn"
          onClick={() => setAppearance(isDark ? 'light' : 'dark')}
          title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
        >
          {isDark ? <SunOutlined /> : <MoonOutlined />}
        </button>
        {/* Avatar-only — the dropdown already shows name + role at the top of
            its menu, so duplicating them next to the avatar was noise. */}
        <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={['click']}>
          <button
            type="button"
            className="erp-topnav-avatarbtn"
            title={`${user?.full_name || 'User'} · ${user?.role || 'Admin'}`}
            aria-label="User menu"
          >
            <Avatar size={28} icon={<UserOutlined />} style={{ backgroundColor: avatarBg }} />
          </button>
        </Dropdown>
      </div>
    </header>
  );
}
