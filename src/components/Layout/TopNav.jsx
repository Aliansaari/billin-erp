import React, { useMemo, useState } from 'react';
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
import { menuItems, getOpenKeys, filterMenuByPermissions } from './menuConfig';
import './top-nav.css';

/* ════════════════════════════════════════════════════════════════════════════
 *  TopNav — horizontal menu layout (vertical alternative lives in Sidebar).
 *
 *  Built from native buttons + AntD Dropdown instead of `<Menu mode="horizontal">`
 *  so every element is a predictable, properly-contained pill. Fighting AntD's
 *  horizontal menu defaults (variable line-height, space distribution, icon
 *  vertical-align) caused the earlier layout bugs — the menu stretching to
 *  fill the bar, icons not aligning with text, items appearing with different
 *  heights on hover. Hand-rolling the row gives us exact control over:
 *
 *    · the pill container around each item (hover + active states)
 *    · icon-to-label alignment (single inline-flex, no line-height drift)
 *    · the overall menu width (hugs its content, right cluster pinned right)
 *
 *  Submenus still use AntD's Dropdown so we inherit the proven popup behaviour
 *  (click/hover, keyboard, portal, viewport clamping) without reinventing it.
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

  // Controlled open state for the submenu dropdowns. Only one top-level
  // pill's submenu is open at a time (the key of that pill is stored here).
  // Having this explicit instead of leaving AntD to manage it means we can
  // force-close the dropdown after navigation (belt-and-braces for flaky
  // AntD auto-close timing) and also ensure mouse-out from the pill does
  // not close the dropdown while the cursor is still inside the popup.
  const [openKey, setOpenKey] = useState(null);

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
    const exact = menuItems.find((m) => m.key === location.pathname);
    if (exact) return exact.key;
    const opens = getOpenKeys(location.pathname);
    return opens[0] || null;
  }, [location.pathname]);

  // Prune the menu to items this user can reach.
  const visibleItems = useMemo(() => filterMenuByPermissions(menuItems, user), [user]);

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

  // Render a single top-level entry. Entries with `children` open a dropdown
  // of sub-routes; leaf entries navigate directly.
  const renderItem = (item) => {
    const isActive = activeKey === item.key;
    const pillClass = `erp-topnav-pill${isActive ? ' is-active' : ''}`;

    if (item.children && item.children.length > 0) {
      // Child `key` is the route path. The nav handler is centralised at
      // the AntD menu level (not per-item) so the dropdown auto-closes on
      // select. We track our own `open` state for the Dropdown too, so we
      // can explicitly close on select even if AntD 5's auto-close timing
      // flakes under fast clicks.
      const dropdownItems = item.children.map((c) => ({
        key: c.key,
        icon: c.icon,
        label: c.label,
      }));
      return (
        <Dropdown
          key={item.key}
          menu={{
            items: dropdownItems,
            selectedKeys: [location.pathname],
            onClick: ({ key, domEvent }) => {
              // Stop the click from bubbling to the outer pill button (which
              // would toggle the dropdown state right after we navigate).
              domEvent?.stopPropagation?.();
              // Close the dropdown explicitly in case AntD's auto-close
              // doesn't fire in time for the navigation render.
              setOpenKey(null);
              navigate(key);
            },
          }}
          /* Click-only trigger. The earlier ['click', 'hover'] combination
             caused a toggle conflict: hover would open the menu, then click
             (which AntD treats as a toggle) would close it again — making
             click look broken. */
          trigger={['click']}
          open={openKey === item.key}
          onOpenChange={(next) => setOpenKey(next ? item.key : null)}
          placement="bottom"
          overlayClassName="erp-topnav-dropdown"
        >
          <button type="button" className={pillClass} aria-label={item.label}>
            <span className="pill-icon">{item.icon}</span>
            <span className="pill-label">{item.label}</span>
          </button>
        </Dropdown>
      );
    }

    return (
      <button
        key={item.key}
        type="button"
        className={pillClass}
        onClick={() => navigate(item.key)}
        aria-label={item.label}
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

      {/* Main menu — hugs its content, doesn't stretch the bar. */}
      <nav className="erp-topnav-menu" aria-label="Primary">
        {visibleItems.map(renderItem)}
      </nav>

      {/* Right cluster — pinned to the right edge via margin-left: auto. */}
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
