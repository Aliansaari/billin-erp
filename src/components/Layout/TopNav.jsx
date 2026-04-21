import React, { useMemo } from 'react';
import { Menu, Dropdown, Avatar } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ThunderboltOutlined, UserOutlined, SettingOutlined, LockOutlined,
  LogoutOutlined, SunOutlined, MoonOutlined,
} from '@ant-design/icons';
import useAuthStore from '../../store/authStore';
import useThemeStore from '../../store/themeStore';
import { useNavGuard } from '../../hooks/useUnsavedChangesWarning';
import { resolveMode } from '../../theme/tokens';
import { menuItems, getOpenKeys } from './menuConfig';
import './top-nav.css';

/* ════════════════════════════════════════════════════════════════════════════
 *  TopNav — horizontal menu layout, paired with Sidebar via themeStore.menuOrientation.
 *
 *  Structure (left → right):
 *    · Logo + app name
 *    · AntD horizontal Menu with dropdown submenus for multi-child entries
 *    · Layout-orientation toggle (flips back to Sidebar)
 *    · Appearance toggle (light/dark)
 *    · User avatar → dropdown
 *
 *  Selected key: computed the same way Sidebar does — try an exact path match
 *  first, then fall back to the parent-menu key via getOpenKeys so a deep
 *  route like /sale/edit/42 still highlights "Sales" in the top bar.
 *
 *  Navigation guard: uses the shared useNavGuard store so pages with unsaved
 *  work (sales form, purchase form, etc.) get a confirmation before changing
 *  route — same behaviour as Sidebar.
 * ═══════════════════════════════════════════════════════════════════════════ */

const roleColors = {
  'Admin':           '#4F46E5',
  'Manager':         '#7C3AED',
  'Cashier':         '#10B981',
  'Inventory Staff': '#F59E0B',
  'Accountant':      '#3B82F6',
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

  // Guarded navigate — honours the unsaved-changes confirmation the way Sidebar does.
  const navigate = (to, opts) => {
    if (to === location.pathname) return;
    if (useNavGuard.getState().confirmLeave()) rawNavigate(to, opts);
  };

  // AntD horizontal Menu has a quirk: if selectedKeys includes a key that's
  // not a top-level item (like a deep path), nothing renders selected. Solve
  // by selecting either the exact path OR the parent-menu key.
  const selectedKeys = useMemo(() => {
    const exact = menuItems.some((m) => m.key === location.pathname);
    if (exact) return [location.pathname];
    const opens = getOpenKeys(location.pathname);
    return opens.length ? opens : [];
  }, [location.pathname]);

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
    { key: 'profile',  icon: <UserOutlined />,    label: 'My Profile' },
    { key: 'change-password', icon: <LockOutlined />, label: 'Change Password', onClick: () => navigate('/change-password') },
    { key: 'settings', icon: <SettingOutlined />, label: 'Settings', onClick: () => navigate('/settings/company') },
    { type: 'divider' },
    { key: 'logout',   icon: <LogoutOutlined />,  label: 'Sign Out', danger: true, onClick: handleLogout },
  ];

  const avatarBg = roleColors[user?.role] || '#4F46E5';

  return (
    <header className="erp-topnav" data-mode={isDark ? 'dark' : 'light'}>
      {/* Brand — icon only (double as a home link). The wordmark lives in
          the vertical sidebar layout; in horizontal mode we give every
          pixel back to the nav items. */}
      <div className="erp-topnav-brand icon-only" onClick={() => navigate('/')} role="button" tabIndex={0} title="Home">
        <ThunderboltOutlined className="brand-icon" />
      </div>

      {/* Main menu — horizontal */}
      <div className="erp-topnav-menu">
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={selectedKeys}
          items={menuItems}
          onClick={({ key }) => { if (!key.endsWith('-menu')) navigate(key); }}
          /* AntD adds its own className ("ant-menu") which we style to fit
             the editorial chrome via top-nav.css. */
          className="erp-topnav-menu-inner"
          /* Let AntD fold overflowing items into its "..." submenu on narrow
             viewports rather than wrapping onto a second row (which would
             overflow the fixed 56px bar). Setting disabledOverflow=false is
             the default; we spell it out so future edits don't accidentally
             flip back to the broken wrapping behaviour. */
          disabledOverflow={false}
        />
      </div>

      {/* Right cluster: appearance toggle + user. The layout-orientation
          toggle lives in Settings → Theme (it's a "pick once" preference,
          not something to flip from every page). */}
      <div className="erp-topnav-right">
        <button
          type="button"
          className="erp-topnav-iconbtn"
          onClick={() => setAppearance(isDark ? 'light' : 'dark')}
          title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
        >
          {isDark ? <SunOutlined /> : <MoonOutlined />}
        </button>
        <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={['click']}>
          <div className="erp-topnav-user" title={user?.full_name || 'User'}>
            <Avatar size={30} icon={<UserOutlined />} style={{ backgroundColor: avatarBg }} />
            <div className="user-text">
              <div className="user-name">{user?.full_name || 'User'}</div>
              <div className="user-role">{user?.role || 'Admin'}</div>
            </div>
          </div>
        </Dropdown>
      </div>
    </header>
  );
}
