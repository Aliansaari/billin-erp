import React, { useEffect, useRef, useState } from 'react';
import { Modal, Input, Form, Alert, Button, Typography } from 'antd';
import { CloudServerOutlined, LockOutlined, UserOutlined, DeleteOutlined } from '@ant-design/icons';
import { connectToShop, forgetShop } from '../utils/remoteShop';

const { Text } = Typography;

/* ──────────────────────────────────────────────────────────────────────
 * ConnectShopModal — sign in to another shop and open it here.
 *
 * Each shop is its own business with its own computer, its own database and
 * its own licence, so it has its own sign-in — the same email or phone number
 * and password used by that shop's app. This is not the company switcher's
 * password step, which re-checks the CURRENT user against another company on
 * THIS server; it is a sign-in to somewhere else entirely.
 *
 * The password is asked for every time, even for a shop opened before. The
 * device token we keep opens that shop's tunnel gate and its read-only
 * snapshot; it deliberately cannot buy a session that can write. If it could,
 * a copied user folder would be enough to bill into someone else's shop.
 * ────────────────────────────────────────────────────────────────────── */

export default function ConnectShopModal({ open, seed, onClose }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword]     = useState('');
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState('');
  const pwRef = useRef(null);
  const idRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setIdentifier(seed?.identifier || '');
    setPassword('');
    setError('');
    // A remembered shop needs only the password; a new one needs both.
    const t = setTimeout(() => (seed ? pwRef.current?.focus() : idRef.current?.focus()), 60);
    return () => clearTimeout(t);
  }, [open, seed]);

  const submit = async () => {
    if (!identifier.trim() || !password) {
      setError('Enter the shop’s sign-in and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { site } = await connectToShop({ identifier, password });
      // Hard navigation, not a re-render. Every store on screen holds this
      // shop's parties, products and open day book; swapping the base URL
      // underneath them would leave one shop's figures on screen while writes
      // went to another.
      window.location.replace('/');
      void site;
    } catch (e) {
      const status = e?.response?.status;
      const body = e?.response?.data;
      if (status === 401 || body?.error === 'bad_credentials') {
        setError('That sign-in or password is not right for this shop.');
      } else if (body?.code === 'device_limit' || body?.error === 'device_limit') {
        setError(body.message || 'That shop’s licence has no free device slot. Remove one from its Remote Access screen first.');
      } else if (body?.error === 'org_suspended') {
        setError('That shop’s account is suspended.');
      } else if (!e?.response) {
        setError('Could not reach that shop’s computer. It may be switched off, or this computer is offline.');
      } else {
        setError(body?.message || body?.error || e.message || 'Could not open that shop.');
      }
      setBusy(false);
    }
  };

  const forget = () => {
    forgetShop(seed.site_id);
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onCancel={busy ? undefined : onClose}
      title={
        <span>
          <CloudServerOutlined style={{ marginRight: 8, color: '#6366F1' }} />
          {seed ? `Open ${seed.name}` : 'Open another shop'}
        </span>
      }
      okText={busy ? 'Opening…' : 'Open shop'}
      onOk={submit}
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      destroyOnClose
      width={460}
      footer={(_, { OkBtn, CancelBtn }) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {seed && (
            <Button danger type="text" size="small" icon={<DeleteOutlined />}
                    disabled={busy} onClick={forget}>
              Forget this shop
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <CancelBtn />
          <OkBtn />
        </div>
      )}
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 14, fontSize: 13 }}>
        Sign in with that shop’s own ZEHEN account — the email or phone number and
        password its app uses. You will be working on that shop’s computer over the
        internet, and everything you save goes into its books.
      </Text>

      <Form layout="vertical" onFinish={submit}>
        <Form.Item label="Email or phone number" style={{ marginBottom: 14 }}>
          <Input
            ref={idRef}
            size="large"
            prefix={<UserOutlined style={{ color: '#94a3b8' }} />}
            value={identifier}
            disabled={busy}
            autoComplete="username"
            placeholder="owner@shop.com or 9876543210"
            onChange={(e) => { setIdentifier(e.target.value); setError(''); }}
          />
        </Form.Item>
        <Form.Item label="Password" style={{ marginBottom: 4 }}>
          <Input.Password
            ref={pwRef}
            size="large"
            prefix={<LockOutlined style={{ color: '#94a3b8' }} />}
            value={password}
            disabled={busy}
            autoComplete="current-password"
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            onPressEnter={submit}
          />
        </Form.Item>
      </Form>

      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 14 }}
        message="What you can do there"
        description={
          <span style={{ fontSize: 12.5 }}>
            Bills, payments, parties and reports work normally. Backup and restore,
            data import/export and licence changes stay on that shop’s own computer —
            they are refused over the internet by design.
          </span>
        }
      />
    </Modal>
  );
}
