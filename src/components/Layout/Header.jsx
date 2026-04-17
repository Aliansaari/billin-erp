import React from 'react';
import { Layout, Button, Dropdown, Space, Typography, Avatar, Badge, Tooltip } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
  LogoutOutlined,
  SettingOutlined,
  BellOutlined,
  QuestionCircleOutlined,
  LockOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../../store/authStore';

const { Header } = Layout;
const { Text } = Typography;

export default function AppHeader({ collapsed, setCollapsed }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const roleColors = {
    'Admin': '#4F46E5',
    'Manager': '#7C3AED',
    'Cashier': '#10B981',
    'Inventory Staff': '#F59E0B',
    'Accountant': '#3B82F6',
  };

  const userMenuItems = [
    {
      key: 'user-info',
      label: (
        <div style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0', marginBottom: 4, pointerEvents: 'none' }}>
          <div style={{ fontWeight: 600, color: '#1f2937' }}>{user?.full_name || 'User'}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{user?.role || 'Admin'}</div>
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

  return (
    <Header className="erp-header" style={{
      padding: '0 24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      position: 'sticky',
      top: 0,
      zIndex: 10,
      height: 64,
    }}>
      <Space size="middle" align="center">
        <Button
          type="text"
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={() => setCollapsed(!collapsed)}
          style={{ fontSize: 18, width: 40, height: 40 }}
        />
        <div className="erp-header-shortcuts" style={{
          color: '#9ca3af',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span>Quick:</span>
          <kbd className="erp-kbd">Alt+S</kbd>
          <span>Sale</span>
          <kbd className="erp-kbd">Alt+P</kbd>
          <span>Purchase</span>
        </div>
      </Space>

      <Space size={16} align="center">
        <Tooltip title="Keyboard Shortcuts (Ctrl+Shift+?)">
          <Button type="text" icon={<QuestionCircleOutlined />} style={{ color: '#6b7280' }} />
        </Tooltip>

        <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={['click']}>
          <Space style={{ cursor: 'pointer', padding: '4px 8px', borderRadius: 10, transition: 'background 0.2s', }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <Avatar
              size={36}
              icon={<UserOutlined />}
              style={{
                backgroundColor: roleColors[user?.role] || '#4F46E5',
                boxShadow: '0 2px 8px rgba(79, 70, 229, 0.3)',
              }}
            />
            <div style={{ lineHeight: 1.2 }}>
              <Text strong style={{ display: 'block', fontSize: 13, color: '#1f2937' }}>
                {user?.full_name || 'User'}
              </Text>
              <Text style={{ fontSize: 11, color: '#6b7280' }}>
                {user?.role || 'Admin'}
              </Text>
            </div>
          </Space>
        </Dropdown>
      </Space>
    </Header>
  );
}
