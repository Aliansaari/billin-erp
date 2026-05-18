import React, { useEffect, useState } from 'react';
import {
  Card, Form, Input, Button, Row, Col, Typography, message, Divider, Tag, Tabs,
} from 'antd';
import { SaveOutlined, KeyOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { settingsAPI, authAPI } from '../../api';
import useAuthStore from '../../store/authStore';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

const { Title } = Typography;

/* MyAccount — self-service "My Profile" page for the logged-in user.
 *
 * Three sections (tabs):
 *   1. Profile  — edit full_name, email, mobile_number
 *   2. Password — rotate own password (old + new + confirm)
 *   3. Access   — read-only view of role, permissions, allowed godowns,
 *                 last login. Useful for auditors and for users to
 *                 understand why something is hidden / disabled.
 *
 * Everything here is per-USER (not company-wide). Admins manage OTHER
 * users via Settings → Users; this page covers the gap where a user
 * just wants to fix a typo in their own email or change their password.
 */
export default function MyAccount() {
  const [profileForm] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [me, setMe] = useState(null);
  // Active tab — drives which form the F1 (Save) F-key targets.
  const [activeTab, setActiveTab] = useState('profile');
  const navigate = useNavigate();
  // Used to clear the must_change_password flag once the user
  // successfully rotates their password — matches what /change-password
  // does, so the lockout (audit C17) lifts.
  const clearMustChangePassword = useAuthStore((s) => s.clearMustChangePassword);
  // Updating the auth store after a profile save propagates the new
  // full_name / email to every component that reads useAuthStore (top-nav
  // avatar, Home page greeting, etc.). Without this, the page only re-renders
  // *itself* and the rest of the app stays on the stale cached user.
  const updateUserInStore = useAuthStore((s) => s.updateUser);
  const cachedUser        = useAuthStore((s) => s.user);

  useEffect(() => { loadProfile(); }, []);

  const loadProfile = async () => {
    setLoading(true);
    try {
      const { data } = await settingsAPI.getMyProfile();
      setMe(data);
      profileForm.setFieldsValue({
        full_name:     data.full_name || '',
        email:         data.email || '',
        mobile_number: data.mobile_number || '',
      });
    } catch (e) {
      message.error('Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async (values) => {
    setSavingProfile(true);
    try {
      const { data } = await settingsAPI.updateMyProfile(values);
      message.success('Profile updated');
      // Reload to surface server-normalised values (e.g. mobile sanitised).
      await loadProfile();
      // Refresh the auth store so the top-nav avatar tooltip and the Home
      // page greeting pick up the new name immediately — without this they
      // keep reading the stale cached user from login time.
      const merged = {
        ...(cachedUser || {}),
        full_name:     data?.full_name     ?? values.full_name     ?? cachedUser?.full_name,
        email:         data?.email         ?? values.email         ?? cachedUser?.email,
        mobile_number: data?.mobile_number ?? values.mobile_number ?? cachedUser?.mobile_number,
      };
      updateUserInStore?.(merged);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  };

  // Reset the currently-active form back to whatever's on the server.
  // Tab-aware: F5 means different things on Profile vs Password.
  const handleReset = () => {
    if (activeTab === 'profile') {
      profileForm.setFieldsValue({
        full_name:     me?.full_name || '',
        email:         me?.email || '',
        mobile_number: me?.mobile_number || '',
      });
    } else if (activeTab === 'password') {
      passwordForm.resetFields();
    }
  };

  // F1 — Save. Routes to whichever form belongs to the active tab.
  // The Access tab is read-only, so F1 there is a no-op (button greys out).
  const handleSaveActive = () => {
    if (activeTab === 'profile')      profileForm.submit();
    else if (activeTab === 'password') passwordForm.submit();
  };

  const handleChangePassword = async (values) => {
    if (values.new_password !== values.confirm_password) {
      message.error("New password and confirmation don't match");
      return;
    }
    if (values.new_password === values.current_password) {
      message.error('New password must differ from current');
      return;
    }
    setSavingPassword(true);
    try {
      const { data } = await authAPI.changePassword({
        current_password: values.current_password,
        new_password:     values.new_password,
      });
      // The change-password endpoint returns a refreshed JWT (audit C17
      // — clears the must_change_password flag and rotates the token).
      // Swap localStorage + axios picks the new one up via its
      // interceptor on the next request.
      if (data?.token) {
        localStorage.setItem('token', data.token);
        clearMustChangePassword?.();
      }
      message.success('Password changed');
      passwordForm.resetFields();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to change password');
    } finally {
      setSavingPassword(false);
    }
  };

  // Render the permissions object as a list of "modules.actions" so the
  // user can see exactly what they can do. Skips falsy + non-true leaves.
  const flattenPermissions = (obj, prefix = '') => {
    const out = [];
    if (!obj || typeof obj !== 'object') return out;
    if (obj.all === true) { out.push('all'); return out; }
    for (const [k, v] of Object.entries(obj)) {
      if (v === true) out.push(prefix ? `${prefix}.${k}` : k);
      else if (typeof v === 'object') out.push(...flattenPermissions(v, prefix ? `${prefix}.${k}` : k));
    }
    return out.sort();
  };

  const tabs = [
    {
      key: 'profile',
      label: <span><UserOutlined /> Profile</span>,
      children: (
        <Form form={profileForm} layout="vertical" onFinish={handleSaveProfile}>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="Username">
                <Input value={me?.username || ''} disabled />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="full_name" label="Full Name" rules={[{ required: true, message: 'Full name required' }]}>
                <Input placeholder="Your full name" maxLength={100} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="email" label="Email">
                <Input placeholder="you@example.com" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="mobile_number" label="Mobile" help="10-digit Indian mobile starting 6-9.">
                <Input placeholder="98765 43210" />
              </Form.Item>
            </Col>
          </Row>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={savingProfile}>
            Save Profile
          </Button>
        </Form>
      ),
    },
    {
      key: 'password',
      label: <span><KeyOutlined /> Password</span>,
      children: (
        <Form form={passwordForm} layout="vertical" onFinish={handleChangePassword} style={{ maxWidth: 480 }}>
          <Form.Item name="current_password" label="Current Password" rules={[{ required: true, message: 'Required' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="new_password"
            label="New Password"
            rules={[
              { required: true, message: 'Required' },
              { min: 4, message: 'At least 4 characters' },
            ]}
            help="Min 4 characters."
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="confirm_password" label="Confirm New Password" rules={[{ required: true, message: 'Required' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<KeyOutlined />} loading={savingPassword}>
            Change Password
          </Button>
        </Form>
      ),
    },
    {
      key: 'access',
      label: 'Access & Audit',
      children: (
        <div>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <div style={{ marginBottom: 16 }}>
                <Typography.Text type="secondary">Role</Typography.Text>
                <div style={{ fontSize: 18, fontWeight: 500, marginTop: 4 }}>
                  {me?.role_name || '—'}
                </div>
              </div>
            </Col>
            <Col xs={24} md={12}>
              <div style={{ marginBottom: 16 }}>
                <Typography.Text type="secondary">Last login</Typography.Text>
                <div style={{ fontSize: 14, marginTop: 4 }}>
                  {me?.last_login
                    ? `${dayjs(me.last_login).format('DD MMM YYYY · hh:mm A')} (${dayjs(me.last_login).fromNow ? dayjs(me.last_login).fromNow() : ''})`
                    : 'No recent login recorded'}
                </div>
              </div>
            </Col>
          </Row>
          <Divider />
          <Typography.Text type="secondary">Allowed godowns</Typography.Text>
          <div style={{ marginTop: 6, marginBottom: 16 }}>
            {me?.allowed_godowns == null
              ? <Tag color="green">All godowns</Tag>
              : (me.allowed_godowns.length === 0
                  ? <Tag color="red">No godown access</Tag>
                  : me.allowed_godowns.map((g) => <Tag key={g}>#{g}</Tag>))}
          </div>
          <Divider />
          <Typography.Text type="secondary">Permissions (effective)</Typography.Text>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {flattenPermissions(me?.permissions || {}).map((p) => (
              <Tag key={p} color={p === 'all' ? 'gold' : 'blue'}>{p}</Tag>
            ))}
            {(!me?.permissions || flattenPermissions(me?.permissions || {}).length === 0) && (
              <Typography.Text type="secondary">No permissions assigned — contact admin.</Typography.Text>
            )}
          </div>
          <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
            This is what your role + per-user customisations grant you. Read-only — only an
            administrator can change roles or permissions (Settings → Users).
          </Typography.Paragraph>
        </div>
      ),
    },
  ];

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">My Account</h1>
        <p className="ms-page-sub">
          Update your personal details, rotate your password, and see what access you have.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Card loading={loading} bordered={false} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
            <Tabs
              items={tabs}
              activeKey={activeTab}
              onChange={setActiveTab}
            />
          </Card>
        </div>
      </div>

      <ActionStrip
        actions={[
          // Esc on the left — matches SalesBillForm, PurchaseBillForm, etc.
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
          {
            id: 'refresh', key: 'F2', label: 'Reload',
            onAction: loadProfile,
          },
          {
            id: 'reset', key: 'F5', label: 'Reset',
            disabled: activeTab === 'access',
            onAction: handleReset,
          },
          // F1 Save (primary) on the right — app convention for the
          // screen's main action.
          {
            id: 'save', key: 'F1',
            label: activeTab === 'password' ? 'Change Password' : 'Save',
            tone: 'primary',
            // Access tab is read-only, disable F1 there.
            disabled: activeTab === 'access' || savingProfile || savingPassword,
            onAction: handleSaveActive,
          },
        ]}
      />
    </div>
  );
}
