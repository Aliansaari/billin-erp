import React, { useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Layout, Menu } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
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
  BankOutlined,
  ThunderboltOutlined,
  TableOutlined,
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
    ],
  },
  {
    key: 'purchase-menu',
    icon: <ShoppingCartOutlined />,
    label: 'Purchase',
    children: [
      { key: '/purchase/new', icon: <PlusCircleOutlined />, label: 'New Purchase Bill' },
      { key: '/purchases', icon: <UnorderedListOutlined />, label: 'Purchase List' },
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
      { key: '/settings/barcode', icon: <TagsOutlined />, label: 'Barcode' },
      { key: '/settings/modules', icon: <ThunderboltOutlined />, label: 'Modules' },
    ],
  },
];

const getOpenKeys = (pathname) => {
  if (pathname.startsWith('/sale') || pathname === '/sales') return ['sales-menu'];
  if (pathname.startsWith('/purchase') || pathname === '/purchases') return ['purchase-menu'];
  if (pathname.startsWith('/customer') || pathname.startsWith('/supplier')) return ['parties-menu'];
  if (pathname.startsWith('/product') || pathname.startsWith('/categor') || pathname === '/stock-report' || pathname === '/stock-report-pro') return ['inventory-menu'];
  if (pathname.startsWith('/payment') || pathname.startsWith('/receipt')) return ['payments-menu'];
  if (pathname.startsWith('/reports')) return ['reports-menu'];
  if (pathname.startsWith('/settings')) return ['settings-menu'];
  return [];
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

export default function Sidebar({ collapsed }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [openKeys, setOpenKeys] = useState(() => getOpenKeys(location.pathname));

  const handleOpenChange = (keys) => {
    const latest = keys.find(k => !openKeys.includes(k));
    setOpenKeys(latest ? [latest] : []);
  };

  return (
    <Sider
      trigger={null}
      collapsible
      collapsed={collapsed}
      width={270}
      collapsedWidth={68}
      className="erp-sidebar"
      style={{ overflow: 'auto', height: '100vh', position: 'sticky', top: 0, left: 0 }}
    >
      {/* Logo */}
      <div className="erp-sidebar-logo">
        {collapsed ? (
          <ThunderboltOutlined className="erp-sidebar-logo-icon" />
        ) : (
          <div className="erp-sidebar-logo-full">
            <ThunderboltOutlined className="erp-sidebar-logo-icon" />
            <span className="erp-sidebar-logo-text">Billing ERP</span>
          </div>
        )}
      </div>

      {/* ── COLLAPSED: custom icon list with hover popups ── */}
      {collapsed && (
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
      )}

      {/* ── EXPANDED: normal Ant Design inline menu ── */}
      {!collapsed && (
        <>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[location.pathname]}
            openKeys={openKeys}
            onOpenChange={handleOpenChange}
            items={menuItems}
            onClick={({ key }) => { if (!key.endsWith('-menu')) navigate(key); }}
            style={{ borderRight: 0, padding: '8px 4px', background: 'transparent' }}
          />
          <div className="erp-sidebar-footer">
            <span>Ctrl+Shift+? for shortcuts</span>
          </div>
        </>
      )}
    </Sider>
  );
}
