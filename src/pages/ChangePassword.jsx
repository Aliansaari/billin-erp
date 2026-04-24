import React, { useState } from 'react';
import { Form, Input, Button, message, Alert } from 'antd';
import { LockOutlined, SafetyOutlined, LogoutOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { authAPI } from '../api';
import useAuthStore from '../store/authStore';

/**
 * ChangePassword — matches the editorial Login aesthetic.
 *
 * Two entry points:
 *   (1) forced  — first login with default admin/admin123 credentials.
 *                 Only escape is Sign Out.
 *   (2) voluntary — user menu → Change Password.
 *
 * Behavior (preserved from the previous implementation):
 *   - Validates new ≠ current, min length, blocks common defaults
 *   - Calls authAPI.changePassword
 *   - On success: clears flag, logs out, redirects to /login
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
    if (mustChangePassword && /^(admin|admin123|password|123456)$/i.test(new_password)) {
      message.error('Please choose a stronger password — avoid common defaults.');
      return;
    }
    setLoading(true);
    try {
      await authAPI.changePassword({ current_password, new_password });
      clearMustChangePassword();
      message.success('Password updated. Please sign in again.');
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
    <div className="erp-login-root">
      <div className="erp-login-mesh" />
      <div className="erp-login-grain" />

      <div className="erp-login-stage">
        <div className="erp-login-card" style={{ maxWidth: 480 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'linear-gradient(135deg, #E26A4C, #B1472F)',
              display: 'grid', placeItems: 'center',
              boxShadow: '0 6px 18px rgba(226,106,76,0.35)',
            }}>
              <SafetyOutlined style={{ color: '#FDFAF2', fontSize: 18 }} />
            </div>
            <div>
              <h2 className="erp-login-h" style={{ fontSize: 26, margin: 0 }}>
                {mustChangePassword ? 'Set a new password' : 'Change password'}
              </h2>
              <div className="erp-login-sub" style={{ margin: 0 }}>
                {mustChangePassword
                  ? 'For security, change the default before continuing.'
                  : 'Update your account password.'}
              </div>
            </div>
          </div>

          {mustChangePassword && (
            <Alert
              type="warning"
              showIcon
              message="Default password detected"
              description="You are signed in with the factory-default admin password. Please set a new one to secure your account."
              style={{
                marginBottom: 20,
                background: 'rgba(212, 165, 116, 0.12)',
                border: '1px solid rgba(212, 165, 116, 0.28)',
                color: '#F5EEE2',
              }}
            />
          )}

          <Form form={form} layout="vertical" requiredMark={false} onFinish={onFinish}>
            <Form.Item
              name="current_password"
              label={<span className="erp-login-label">Current password</span>}
              rules={[{ required: true, message: 'Enter your current password' }]}
              style={{ marginBottom: 16 }}
            >
              <Input.Password
                className="erp-login-input"
                prefix={<LockOutlined style={{ color: '#8F8372' }} />}
                placeholder="Current password"
                autoFocus
              />
            </Form.Item>

            <Form.Item
              name="new_password"
              label={<span className="erp-login-label">New password</span>}
              hasFeedback
              rules={[
                { required: true, message: 'Enter a new password' },
                { min: 8, message: 'Password must be at least 8 characters' },
              ]}
              style={{ marginBottom: 16 }}
            >
              <Input.Password
                className="erp-login-input"
                prefix={<LockOutlined style={{ color: '#8F8372' }} />}
                placeholder="At least 8 characters"
              />
            </Form.Item>

            <Form.Item
              name="confirm_password"
              label={<span className="erp-login-label">Confirm new password</span>}
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
              style={{ marginBottom: 22 }}
            >
              <Input.Password
                className="erp-login-input"
                prefix={<LockOutlined style={{ color: '#8F8372' }} />}
                placeholder="Re-enter new password"
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 10 }}>
              <Button type="primary" htmlType="submit" loading={loading} block className="erp-login-btn">
                {loading ? 'Updating…' : 'Update password'}
              </Button>
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              {mustChangePassword ? (
                <Button
                  icon={<LogoutOutlined />}
                  block
                  onClick={handleSignOut}
                  style={{
                    height: 44, borderRadius: 9,
                    background: 'transparent',
                    border: '1px solid rgba(245,238,226,0.14)',
                    color: '#B2A791',
                  }}
                >
                  Sign out
                </Button>
              ) : (
                <Button
                  block
                  onClick={() => navigate(-1)}
                  style={{
                    height: 44, borderRadius: 9,
                    background: 'transparent',
                    border: '1px solid rgba(245,238,226,0.14)',
                    color: '#B2A791',
                  }}
                >
                  Cancel
                </Button>
              )}
            </Form.Item>
          </Form>
        </div>
      </div>

      {/* Shared login styles already defined by Login.jsx when rendered;
          inline them here too so this page works on direct navigation. */}
      <style>{chgCss}</style>
    </div>
  );
}

const chgCss = `
.erp-login-root {
  position: fixed; inset: 0;
  background: #0B0807;
  color: #F5EEE2;
  font-family: 'Source Sans 3', system-ui, -apple-system, sans-serif;
  overflow: auto;
}
.erp-login-mesh {
  position: fixed; inset: 0;
  pointer-events: none; z-index: 0;
  background:
    radial-gradient(800px 600px at 18% 20%, rgba(226, 106, 76, 0.22), transparent 60%),
    radial-gradient(700px 500px at 85% 10%, rgba(212, 165, 116, 0.16), transparent 60%),
    radial-gradient(900px 700px at 70% 90%, rgba(154, 76, 56, 0.18), transparent 60%),
    radial-gradient(600px 500px at 10% 90%, rgba(86, 50, 38, 0.22), transparent 60%);
  animation: erpLoginDrift 24s ease-in-out infinite alternate;
  filter: saturate(1.1);
}
@keyframes erpLoginDrift {
  0%   { transform: translate3d(0, 0, 0) scale(1); }
  50%  { transform: translate3d(-18px, 10px, 0) scale(1.04); }
  100% { transform: translate3d(12px, -8px, 0) scale(1); }
}
.erp-login-grain {
  position: fixed; inset: 0;
  pointer-events: none; z-index: 0;
  opacity: .06; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.9'/></svg>");
}
.erp-login-stage {
  position: relative; z-index: 5;
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 40px 20px;
}
.erp-login-card {
  width: 100%; max-width: 440px;
  padding: 40px 38px 32px;
  background: rgba(26, 23, 19, 0.72);
  backdrop-filter: blur(24px) saturate(140%);
  -webkit-backdrop-filter: blur(24px) saturate(140%);
  border: 1px solid rgba(245, 238, 226, 0.10);
  border-radius: 20px;
  box-shadow:
    0 30px 80px rgba(0, 0, 0, 0.50),
    inset 0 1px 0 rgba(245, 238, 226, 0.05);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(18px) scale(.985);
  animation: erpLoginCardIn 1.1s cubic-bezier(.2, .7, .2, 1) .15s forwards;
}
.erp-login-card::before {
  content: '';
  position: absolute; inset: 0 0 auto 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(226, 106, 76, 0.55), transparent);
}
@keyframes erpLoginCardIn { to { opacity: 1; transform: translateY(0) scale(1); } }
.erp-login-h {
  font-family: 'Source Sans 3', sans-serif;
  font-optical-sizing: auto;
  font-size: 28px;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: #F5EEE2;
}
.erp-login-sub {
  font-family: 'Source Sans 3', sans-serif;
  font-style: italic;
  font-size: 14px;
  color: #8F8372;
}
.erp-login-label {
  font-size: 11px !important; letter-spacing: 1.5px !important; text-transform: uppercase !important;
  color: #8F8372 !important; font-weight: 500 !important;
}
.erp-login-input.ant-input-affix-wrapper,
.erp-login-input .ant-input {
  background: rgba(11, 8, 7, 0.55) !important;
  border: 1px solid rgba(245, 238, 226, 0.12) !important;
  border-radius: 9px !important;
  height: 46px !important;
  color: #F5EEE2 !important;
  font-size: 14px !important;
  box-shadow: none !important;
}
.erp-login-input.ant-input-affix-wrapper:hover { border-color: rgba(245, 238, 226, 0.22) !important; }
.erp-login-input.ant-input-affix-wrapper-focused,
.erp-login-input.ant-input-affix-wrapper:focus-within {
  border-color: rgba(226, 106, 76, 0.6) !important;
  box-shadow: 0 0 0 3px rgba(226, 106, 76, 0.14) !important;
  background: rgba(11, 8, 7, 0.75) !important;
}
.erp-login-input input::placeholder,
.erp-login-input .ant-input::placeholder { color: #6D6355 !important; }
.erp-login-btn.ant-btn {
  height: 48px !important;
  background: linear-gradient(135deg, #E26A4C, #B1472F) !important;
  border: none !important;
  border-radius: 9px !important;
  color: #FDFAF2 !important;
  font-weight: 600 !important;
  font-size: 15px !important;
  box-shadow:
    0 14px 30px rgba(226, 106, 76, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
}
.erp-login-btn.ant-btn:hover {
  filter: brightness(1.03);
  transform: translateY(-1px);
}
.erp-login-root .ant-form-item-label > label {
  color: #8F8372 !important;
  font-size: 11px !important; letter-spacing: 1.5px !important;
  text-transform: uppercase !important; font-weight: 500 !important;
}
`;
