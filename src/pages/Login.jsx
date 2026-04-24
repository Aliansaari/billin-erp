import React, { useState } from 'react';
import { Form, Input, Button, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { authAPI } from '../api';
import useAuthStore from '../store/authStore';

/**
 * Login — editorial Modern.
 *
 * Single centered glass card on a warm drifting mesh. No hero, no 3D, no nav.
 * Fraunces serif for the greeting, Inter for the form. Terracotta gradient
 * primary button with kbd badge. Fade-up + scale entry on mount.
 *
 * Behavior preserved from the previous implementation:
 *   - Auth call + redirect based on `must_change_password`
 *   - Authstore login persists flag to localStorage
 */
export default function Login() {
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const { data } = await authAPI.login(values);
      login(data.user, data.token, !!data.must_change_password);
      if (data.must_change_password) {
        message.warning('Please set a new password to continue.');
        window.location.href = '/change-password';
      } else {
        message.success(`Welcome back, ${data.user.full_name}!`);
        window.location.href = '/';
      }
    } catch (error) {
      message.error(error.response?.data?.error || 'Invalid username or password');
      setLoading(false);
    }
  };

  return (
    <div className="erp-login-root">
      {/* Warm radial mesh + fine grain overlay */}
      <div className="erp-login-mesh" />
      <div className="erp-login-grain" />

      <div className="erp-login-stage">
        <div className="erp-login-card">
          <h2 className="erp-login-h">Welcome back.</h2>
          <div className="erp-login-sub">Sign in to continue to your firm.</div>

          <Form name="login" onFinish={onFinish} layout="vertical" requiredMark={false}>
            <Form.Item
              name="username"
              label={<span className="erp-login-label">Username</span>}
              rules={[{ required: true, message: 'Please enter your username' }]}
              style={{ marginBottom: 18 }}
            >
              <Input
                className="erp-login-input"
                prefix={<UserOutlined style={{ color: '#8F8372' }} />}
                placeholder="admin"
                autoFocus
              />
            </Form.Item>

            <Form.Item
              name="password"
              label={<span className="erp-login-label">Password</span>}
              rules={[{ required: true, message: 'Please enter your password' }]}
              style={{ marginBottom: 22 }}
            >
              <Input.Password
                className="erp-login-input"
                prefix={<LockOutlined style={{ color: '#8F8372' }} />}
                placeholder="••••••••••"
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                className="erp-login-btn"
              >
                {loading ? 'Signing in…' : (
                  <span>Sign in <span className="erp-login-kbd">Enter</span></span>
                )}
              </Button>
            </Form.Item>
          </Form>

          <div className="erp-login-hint">
            <div className="erp-login-hint-ico">✦</div>
            <div className="erp-login-hint-text">
              First time? Try <code>admin</code> / <code>admin123</code> — we&rsquo;ll ask you to set a real password.
            </div>
          </div>
        </div>
      </div>

      {/* All styles inline for this page so the mesh/grain/glass feel
          stays self-contained and doesn't leak into the app shell. */}
      <style>{loginCss}</style>
    </div>
  );
}

const loginCss = `
.erp-login-root {
  position: fixed; inset: 0;
  background: #0B0807;
  color: #F5EEE2;
  font-family: 'Source Sans 3', system-ui, -apple-system, sans-serif;
  overflow: hidden;
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
  padding: 44px 40px 36px;
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
@keyframes erpLoginCardIn {
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.erp-login-h {
  font-family: 'Source Sans 3', sans-serif;
  font-optical-sizing: auto;
  font-size: 32px;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: #F5EEE2;
  margin: 0 0 6px;
}
.erp-login-sub {
  font-family: 'Source Sans 3', sans-serif;
  font-style: italic;
  font-size: 14.5px;
  color: #8F8372;
  margin-bottom: 32px;
}
.erp-login-label {
  font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
  color: #8F8372 !important; font-weight: 500;
}
.erp-login-input.ant-input-affix-wrapper,
.erp-login-input .ant-input {
  background: rgba(11, 8, 7, 0.55) !important;
  border: 1px solid rgba(245, 238, 226, 0.12) !important;
  border-radius: 9px !important;
  height: 48px !important;
  color: #F5EEE2 !important;
  font-size: 15px !important;
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
  height: 50px !important;
  margin-top: 8px;
  background: linear-gradient(135deg, #E26A4C, #B1472F) !important;
  border: none !important;
  border-radius: 9px !important;
  color: #FDFAF2 !important;
  font-weight: 600 !important;
  font-size: 15px !important;
  letter-spacing: 0.02em;
  box-shadow:
    0 14px 30px rgba(226, 106, 76, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
  transition: all .2s !important;
}
.erp-login-btn.ant-btn:hover {
  transform: translateY(-1px);
  box-shadow:
    0 18px 40px rgba(226, 106, 76, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.18) !important;
  filter: brightness(1.03);
}
.erp-login-btn.ant-btn:active { transform: translateY(0); }
.erp-login-kbd {
  display: inline-flex; align-items: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 3px;
  padding: 2px 6px;
  margin-left: 8px;
  letter-spacing: 0;
}
.erp-login-hint {
  margin-top: 20px;
  padding: 13px 15px;
  background: rgba(245, 238, 226, 0.04);
  border: 1px solid rgba(245, 238, 226, 0.08);
  border-radius: 9px;
  display: flex; align-items: center; gap: 11px;
}
.erp-login-hint-ico {
  width: 30px; height: 30px;
  display: grid; place-items: center;
  background: rgba(212, 165, 116, 0.16);
  color: #D4A574;
  border-radius: 7px;
  font-size: 14px;
  flex-shrink: 0;
}
.erp-login-hint-text {
  font-family: 'Source Sans 3', sans-serif; font-style: italic;
  font-size: 13px; color: #B2A791;
  line-height: 1.5;
}
.erp-login-hint-text code {
  font-family: 'JetBrains Mono', monospace;
  font-style: normal;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(245, 238, 226, 0.08);
  border-radius: 3px; padding: 1px 6px;
  color: #F5EEE2;
}

/* Form labels: override AntD's dark label color */
.erp-login-root .ant-form-item-label > label {
  color: #8F8372 !important;
  font-size: 11px !important; letter-spacing: 1.5px !important;
  text-transform: uppercase !important; font-weight: 500 !important;
}
`;
