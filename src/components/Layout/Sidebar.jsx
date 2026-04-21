import React, { useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Layout, Menu, Dropdown, Avatar } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import useAuthStore from '../../store/authStore';
import useThemeStore from '../../store/themeStore';
import { useNavGuard } from '../../hooks/useUnsavedChangesWarning';
import { resolveMode } from '../../theme/tokens';
import { menuItems, getOpenKeys } from './menuConfig';
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
  SwapOutlined,
} from '@ant-design/icons';

const { Sider } = Layout;

// menuItems + getOpenKeys are defined once in ./menuConfig and shared with
// TopNav so the two layouts always expose the same navigation. Adding a new
// route only needs one edit.

const roleColors = {
  'Admin':           '#4F46E5',
  'Manager':         '#7C3AED',
  'Cashier':         '#10B981',
  'Inventory Staff': '#F59E0B',
  'Accountant':      '#3B82F6',
};

/* ── Collapsed sidebar item with hover popup ── */
function CollapsedItem({ item, currentPath, navigate }) {
  const [popupPos, setPopupPos] = useState(null);
  const hideTimer = useRef(null);

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
    >
      <span className="erp-ci-icon">{item.icon}</span>

      {/* Popup — portal to document.body so it's always on top */}
      {item.children && popupPos && ReactDOM.createPortal(
        <>
          {/* Transparent bridge covers the gap between icon and popup */}
          <div
            style={{
              position:'fixed', left:64, top:popupPos.top,
              width:12, height:44, zIndex:99998,
            }}
            onMouseEnter={cancelHide}
            onMouseLeave={hidePopup}
          />
          <div
            className="erp-ci-popup"
            style={{ top: popupPos.top }}
            onMouseEnter={cancelHide}
            onMouseLeave={hidePopup}
          >
            <div className="erp-ci-popup-title">{item.label}</div>
            {item.children.map(child => {
              const childActive = currentPath === child.key || currentPath.startsWith(child.key);
              return (
                <div
                  key={child.key}
                  className={`erp-ci-popup-item${childActive ? ' active' : ''}`}
                  onClick={() => { setPopupPos(null); navigate(child.key); }}
                >
                  <span style={{ fontSize: 14 }}>{child.icon}</span>
                  <span>{child.label}</span>
                </div>
              );
            })}
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

  // Guarded navigate — asks for confirmation when the current form has unsaved work.
  const navigate = (to, opts) => {
    if (to === location.pathname) return;
    if (useNavGuard.getState().confirmLeave()) {
      rawNavigate(to, opts);
    }
  };

  const themeStyle = useThemeStore((s) => s.themeStyle);
  const appearance = useThemeStore((s) => s.appearance);
  const setAppearance = useThemeStore((s) => s.setAppearance);
  // Switch to the horizontal top-nav layout. Persisted in themeStore so the
  // user's choice survives reloads; AppLayout re-renders with TopNav when it flips.
  const toggleMenuOrientation = useThemeStore((s) => s.toggleMenuOrientation);
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
              {menuItems.map(item => (
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
              items={menuItems}
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

        {/* Layout orientation toggle — flips between vertical sidebar (current)
            and horizontal top-nav. Persisted via themeStore so it stays set
            across reloads. Sidebar is the default; this button moves the menu
            to the top and renders TopNav via AppLayout. */}
        <div className={`erp-sidebar-layout${collapsed ? ' collapsed' : ''}`}>
          <button
            type="button"
            className="erp-sidebar-layout-btn"
            onClick={toggleMenuOrientation}
            title="Switch to horizontal top-nav layout"
            aria-label="Switch to horizontal top-nav layout"
          >
            <SwapOutlined />
            {!collapsed && <span>Horizontal layout</span>}
          </button>
        </div>

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
