import React, { useState } from 'react';
import { Form, Input, Button, Typography, message, Alert } from 'antd';
import { LockOutlined, SafetyOutlined, LogoutOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { authAPI } from '../api';
import useAuthStore from '../store/authStore';

const { Title, Text } = Typography;

/**
 * ChangePassword
 *
 * Two entry points land here:
 *   1. FORCED (first login with the seeded admin/admin123) — the server sets
 *      `must_change_password` on the login response; PrivateRoute redirects
 *      every route except `/change-password` to this page until the user
 *      rotates the password. Only escape is Sign Out.
 *   2. VOLUNTARY (user menu → "Change Password") — regular flow, Cancel
 *      returns to the previous page.
 *
 * The form enforces client-side checks (min 8 chars, not the same as the
 * default, confirm match) in addition to the server's bcrypt verification
 * of the current password.
 */
export default function ChangePassword() {
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const mustChangePassword = useAuthStore((s) => s.mustChangePassword);
  const clearMustChangePassword = useAuthStore((s) => s.clearMustChangePassword);
  const logout = useAuthStore((s) => s.logout);

  const onFinish = async (values) => {
    const { current_password, new_password, confirm_password } = values;
    if (new_password !== confirm_password) {
      message.error('New password and confirmation do not match.');
      return;
    }
    if (new_password === current_password) {
      message.error('New password must be different from the current password.');
      return;
    }
    // Block the most common default passwords when the server flagged the
    // account as default-password. The server only knows the seeded default;
    // this catch stops the user from rotating "admin" → "admin123" or vice
    // versa, which would technically satisfy "different" but defeat the
    // purpose of the forced change.
    if (mustChangePassword && /^(admin|admin123|password|123456)$/i.test(new_password)) {
      message.error('Please choose a stronger password — avoid common defaults.');
      return;
    }
    setLoading(true);
    try {
      await authAPI.changePassword({ current_password, new_password });
      clearMustChangePassword();
      message.success('Password updated successfully. Please sign in again.');
      // Always log out after a successful password change so the token
      // lifecycle is clean — the next login path won't carry the forced flag.
      setTimeout(() => {
        logout();
        window.location.href = '/login';
      }, 800);
    } catch (error) {
      message.error(error.response?.data?.error || 'Failed to change password');
      setLoading(false);
    }
  };

  const handleSignOut = () => {
    logout();
    window.location.href = '/login';
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: mustChangePassword
        ? 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 40%, #312e81 100%)'
        : '#f8fafc',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      padding: 20,
    }}>
      <div style={{
        width: 440,
        background: 'white',
        borderRadius: 16,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        overflow: 'hidden',
      }}>
        <div style={{ height: 4, background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)' }} />
        <div style={{ padding: '32px 32px 28px' }}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 14,
              background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 12,
              boxShadow: '0 8px 24px rgba(79,70,229,0.35)',
            }}>
              <SafetyOutlined style={{ color: 'white', fontSize: 24 }} />
            </div>
            <Title level={4} style={{ margin: 0, color: '#0f172a' }}>
              {mustChangePassword ? 'Set a New Password' : 'Change Password'}
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {mustChangePassword
                ? 'For security, change the default password before continuing.'
                : 'Update your account password.'}
            </Text>
          </div>

          {mustChangePassword && (
            <Alert
              type="warning"
              showIcon
              message="Default password detected"
              description="You are signed in with the factory-default admin password. Please set a new password to secure your account."
              style={{ marginBottom: 20 }}
            />
          )}

          <Form form={form} layout="vertical" requiredMark={false} onFinish={onFinish} size="large">
            <Form.Item
              name="current_password"
              label="Current Password"
              rules={[{ required: true, message: 'Enter your current password' }]}
            >
              <Input.Password prefix={<LockOutlined style={{ color: '#9ca3af' }} />} placeholder="Current password" autoFocus />
            </Form.Item>

            <Form.Item
              name="new_password"
              label="New Password"
              rules={[
                { required: true, message: 'Enter a new password' },
                { min: 8, message: 'Password must be at least 8 characters' },
              ]}
              hasFeedback
            >
              <Input.Password prefix={<LockOutlined style={{ color: '#9ca3af' }} />} placeholder="At least 8 characters" />
            </Form.Item>

            <Form.Item
              name="confirm_password"
              label="Confirm New Password"
              dependencies={['new_password']}
              hasFeedback
              rules={[
                { required: true, message: 'Confirm the new password' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('new_password') === value) return Promise.resolve();
                    return Promise.reject(new Error('Passwords do not match'));
                  },
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined style={{ color: '#9ca3af' }} />} placeholder="Re-enter new password" />
            </Form.Item>

            <Form.Item style={{ marginBottom: 12 }}>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                style={{
                  height: 46,
                  borderRadius: 10,
                  fontWeight: 700,
                  background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
                  border: 'none',
                }}
              >
                {loading ? 'Updating...' : 'Update Password'}
              </Button>
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              {mustChangePassword ? (
                <Button icon={<LogoutOutlined />} block onClick={handleSignOut} style={{ height: 42, borderRadius: 10 }}>
                  Sign Out
                </Button>
              ) : (
                <Button block onClick={() => navigate(-1)} style={{ height: 42, borderRadius: 10 }}>
                  Cancel
                </Button>
              )}
            </Form.Item>
          </Form>
        </div>
      </div>
    </div>
  );
}
