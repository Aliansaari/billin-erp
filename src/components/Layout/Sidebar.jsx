import React, { useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Layout, Menu, Dropdown, Avatar } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import useAuthStore from '../../store/authStore';
import useThemeStore from '../../store/themeStore';
import { useNavGuard } from '../../hooks/useUnsavedChangesWarning';
import { resolveMode } from '../../theme/tokens';
import {
  DashboardOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  TeamOutlined,
  InboxOutlined,
  DollarOutlined,
  BarChartOutlined,
  SettingOutlined,
  UserOutlined,
  TagsOutlined,
  FileTextOutlined,
  WalletOutlined,
  FundOutlined,
  AppstoreOutlined,
  StockOutlined,
  PlusCircleOutlined,
  UnorderedListOutlined,
  RollbackOutlined,
  BankOutlined,
  ThunderboltOutlined,
  TableOutlined,
  CloudServerOutlined,
  BgColorsOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LogoutOutlined,
  LockOutlined,
  SunOutlined,
  MoonOutlined,
} from '@ant-design/icons';

const { Sider } = Layout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
  {
    key: 'sales-menu',
    icon: <ShoppingOutlined />,
    label: 'Sales',
    children: [
      { key: '/sale/new', icon: <PlusCircleOutlined />, label: 'New Sales Bill' },
      { key: '/sales', icon: <UnorderedListOutlined />, label: 'Sales List' },
      { key: '/sales-return/new', icon: <RollbackOutlined />, label: 'New Sales Return' },
      { key: '/sales-returns', icon: <UnorderedListOutlined />, label: 'Sales Returns' },
    ],
  },
  {
    key: 'purchase-menu',
    icon: <ShoppingCartOutlined />,
    label: 'Purchase',
    children: [
      { key: '/purchase/new', icon: <PlusCircleOutlined />, label: 'New Purchase Bill' },
      { key: '/purchases', icon: <UnorderedListOutlined />, label: 'Purchase List' },
      { key: '/purchase-return/new', icon: <RollbackOutlined />, label: 'New Purchase Return' },
      { key: '/purchase-returns', icon: <UnorderedListOutlined />, label: 'Purchase Returns' },
    ],
  },
  {
    key: 'parties-menu',
    icon: <TeamOutlined />,
    label: 'Parties',
    children: [
      { key: '/customers', icon: <UserOutlined />, label: 'Customers' },
      { key: '/suppliers', icon: <BankOutlined />, label: 'Suppliers' },
    ],
  },
  {
    key: 'inventory-menu',
    icon: <InboxOutlined />,
    label: 'Inventory',
    children: [
      { key: '/products', icon: <AppstoreOutlined />, label: 'Products' },
      { key: '/categories', icon: <TagsOutlined />, label: 'Categories' },
      { key: '/stock-report', icon: <StockOutlined />, label: 'Stock Report' },
      { key: '/stock-report-pro', icon: <TableOutlined />, label: 'Smart Stock' },
    ],
  },
  {
    key: 'payments-menu',
    icon: <DollarOutlined />,
    label: 'Payments',
    children: [
      { key: '/payment/new', icon: <PlusCircleOutlined />, label: 'Make Payment' },
      { key: '/receipt/new', icon: <WalletOutlined />, label: 'Receive Payment' },
      { key: '/payments', icon: <UnorderedListOutlined />, label: 'All Transactions' },
    ],
  },
  {
    key: 'reports-menu',
    icon: <BarChartOutlined />,
    label: 'Reports',
    children: [
      { key: '/reports/sales', icon: <FileTextOutlined />, label: 'Sales Report' },
      { key: '/reports/purchases', icon: <FileTextOutlined />, label: 'Purchase Report' },
      { key: '/reports/stock', icon: <StockOutlined />, label: 'Stock Report' },
      { key: '/reports/party-ledger', icon: <WalletOutlined />, label: 'Party Ledger' },
      { key: '/reports/profit-loss', icon: <FundOutlined />, label: 'Profit & Loss' },
    ],
  },
  {
    key: 'settings-menu',
    icon: <SettingOutlined />,
    label: 'Settings',
    children: [
      { key: '/settings/company', icon: <BankOutlined />, label: 'Company Profile' },
      { key: '/settings/users', icon: <UserOutlined />, label: 'Users' },
      { key: '/settings/theme', icon: <BgColorsOutlined />, label: 'Theme' },
      { key: '/settings/barcode', icon: <TagsOutlined />, label: 'Barcode' },
      { key: '/settings/modules', icon: <ThunderboltOutlined />, label: 'Modules' },
      { key: '/settings/backup', icon: <CloudServerOutlined />, label: 'Backup & Recovery' },
    ],
  },
];

const getOpenKeys = (pathname) => {
  // Order matters: more specific prefixes first so /sales-return* doesn't
  // match the /sale or /sales check below when routing rehydrates on reload.
  if (pathname.startsWith('/sales-return')) return ['sales-menu'];
  if (pathname.startsWith('/purchase-return')) return ['purchase-menu'];
  if (pathname.startsWith('/sale') || pathname === '/sales') return ['sales-menu'];
  if (pathname.startsWith('/purchase') || pathname === '/purchases') return ['purchase-menu'];
  if (pathname.startsWith('/customer') || pathname.startsWith('/supplier')) return ['parties-menu'];
  if (pathname.startsWith('/product') || pathname.startsWith('/categor') || pathname === '/stock-report' || pathname === '/stock-report-pro') return ['inventory-menu'];
  if (pathname.startsWith('/payment') || pathname.startsWith('/receipt')) return ['payments-menu'];
  if (pathname.startsWith('/reports')) return ['reports-menu'];
  if (pathname.startsWith('/settings')) return ['settings-menu'];
  return [];
};

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

        {/* ── Sticky bottom: theme toggle + user avatar ── */}
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
