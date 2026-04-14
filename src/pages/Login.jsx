import React, { useState } from 'react';
import { Form, Input, Button, Typography, message } from 'antd';
import { UserOutlined, LockOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { authAPI } from '../api';
import useAuthStore from '../store/authStore';

const { Text } = Typography;

export default function Login() {
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const { data } = await authAPI.login(values);
      login(data.user, data.token);
      message.success(`Welcome back, ${data.user.full_name}!`);
      // Full reload ensures fresh auth state across all components
      window.location.href = '/';
    } catch (error) {
      message.error(error.response?.data?.error || 'Invalid username or password');
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 40%, #312e81 100%)',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Background orbs */}
      <div style={{ position: 'absolute', top: '-100px', right: '-100px', width: 400, height: 400, borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,102,241,0.20) 0%, transparent 70%)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '-80px', left: '-80px', width: 320, height: 320, borderRadius: '50%', background: 'radial-gradient(circle, rgba(124,58,237,0.15) 0%, transparent 70%)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: '50%', left: '20%', width: 180, height: 180, borderRadius: '50%', background: 'radial-gradient(circle, rgba(79,70,229,0.10) 0%, transparent 70%)', pointerEvents: 'none' }} />

      {/* Login Card */}
      <div style={{
        width: 400,
        background: 'rgba(255,255,255,0.97)',
        borderRadius: 20,
        boxShadow: '0 24px 64px rgba(0,0,0,0.40)',
        overflow: 'hidden',
        position: 'relative',
        zIndex: 1,
      }}>
        {/* Top gradient bar */}
        <div style={{ height: 4, background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)' }} />

        <div style={{ padding: '40px 36px 36px' }}>
          {/* Brand */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{
              width: 60, height: 60, borderRadius: 16,
              background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 14,
              boxShadow: '0 8px 24px rgba(79,70,229,0.35)',
            }}>
              <ThunderboltOutlined style={{ color: 'white', fontSize: 26 }} />
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.3px', lineHeight: 1.2 }}>
              Billing ERP
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 4 }}>
              Sign in to your account
            </div>
          </div>

          {/* Form */}
          <Form name="login" onFinish={onFinish} layout="vertical" requiredMark={false} size="large">
            <Form.Item
              name="username"
              label={<span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Username</span>}
              rules={[{ required: true, message: 'Please enter your username' }]}
              style={{ marginBottom: 16 }}
            >
              <Input
                prefix={<UserOutlined style={{ color: '#9ca3af' }} />}
                placeholder="Enter username"
                autoFocus
                style={{ borderRadius: 10, height: 46, fontSize: 14 }}
              />
            </Form.Item>

            <Form.Item
              name="password"
              label={<span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Password</span>}
              rules={[{ required: true, message: 'Please enter your password' }]}
              style={{ marginBottom: 24 }}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: '#9ca3af' }} />}
                placeholder="Enter password"
                style={{ borderRadius: 10, height: 46, fontSize: 14 }}
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 16 }}>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                style={{
                  height: 48,
                  borderRadius: 10,
                  fontSize: 15,
                  fontWeight: 700,
                  background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
                  border: 'none',
                  boxShadow: '0 4px 16px rgba(79,70,229,0.40)',
                  letterSpacing: 0.3,
                }}
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </Button>
            </Form.Item>
          </Form>

          {/* Credentials hint */}
          <div style={{
            padding: '11px 14px',
            background: '#f8fafc',
            borderRadius: 10,
            border: '1px solid #e2e8f0',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ fontSize: 15 }}>💡</span>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>Default credentials</div>
              <div style={{ fontSize: 13, color: '#334155' }}>
                <code style={{ background: '#e2e8f0', padding: '1px 6px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>admin</code>
                {' '}/{' '}
                <code style={{ background: '#e2e8f0', padding: '1px 6px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>admin123</code>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{
        position: 'fixed', bottom: 20,
        color: 'rgba(255,255,255,0.35)',
        fontSize: 12,
        zIndex: 1,
        fontFamily: "'Inter', system-ui, sans-serif",
      }}>
        Billing ERP v1.0.0 &nbsp;·&nbsp; Press <kbd style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, padding: '1px 6px', fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>Enter</kbd> to sign in
      </div>
    </div>
  );
}
