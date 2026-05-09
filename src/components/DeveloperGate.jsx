import React, { useState } from 'react';
import { Modal, Input, Alert, Typography, Tag, Space, message } from 'antd';
import { LockOutlined, CodeOutlined, KeyOutlined } from '@ant-design/icons';
import { authAPI } from '../api';
import useDevModeStore from '../store/devModeStore';

const { Paragraph, Text } = Typography;

/* ── DeveloperGate ──────────────────────────────────────────────────────
 *
 * Modal that prompts for the developer password and unlocks dev mode on
 * success. The unlocked state lives in localStorage (devModeStore) so the
 * machine stays unlocked across reloads until explicitly locked again.
 *
 * The default password ships in the source as `dev@billing2025`. Integrators
 * should override via the DEVELOPER_PASSWORD env var on the server before
 * shipping a build to a customer.
 *
 * Trigger: render `<DeveloperGate open={...} onClose={...} />` from any
 * component. Most natural entry point is the user-menu dropdown in the
 * sidebar/topnav under "Developer Access".
 * ────────────────────────────────────────────────────────────────────── */
export default function DeveloperGate({ open, onClose }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const unlock = useDevModeStore((s) => s.unlock);

  const reset = () => {
    setPassword('');
    setError('');
    setBusy(false);
  };

  const handleClose = () => {
    reset();
    onClose && onClose();
  };

  const handleSubmit = async () => {
    if (!password.trim()) {
      setError('Enter the developer password');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await authAPI.verifyDeveloperPassword(password);
      const ok = r.data?.ok || r.data?.data?.ok;
      const usingDefault = r.data?.using_default_password ?? r.data?.data?.using_default_password;
      if (!ok) {
        setError('Verification failed.');
        return;
      }
      unlock();
      message.success({
        content: usingDefault
          ? 'Developer mode unlocked. (Using the default password — change DEVELOPER_PASSWORD in .env before shipping.)'
          : 'Developer mode unlocked.',
        duration: 4,
      });
      reset();
      onClose && onClose({ unlocked: true });
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data?.error || e.message;
      if (status === 429) {
        setError('Too many failed attempts. Try again in 15 minutes.');
      } else if (status === 401) {
        setError('Wrong password.');
      } else {
        setError(msg || 'Could not verify password.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<span><CodeOutlined style={{ marginRight: 8 }} />Developer Access</span>}
      open={open}
      onCancel={handleClose}
      onOk={handleSubmit}
      okText="Unlock"
      okButtonProps={{ icon: <KeyOutlined />, loading: busy, disabled: !password.trim() }}
      cancelText="Cancel"
      destroyOnClose
      maskClosable={!busy}
    >
      <Paragraph style={{ marginBottom: 16, color: '#475569' }}>
        Developer mode unlocks power tools that can corrupt accounting data — Ledger Integrity scans,
        bulk Data Cleanup, Restore from backup, Tally live sync, and the Server / LAN settings.
      </Paragraph>
      <Paragraph style={{ marginBottom: 16, fontSize: 13, color: '#64748b' }}>
        These are gated to prevent accidental clicks. The password is the same on every machine
        in the office; ask your developer / installer for it.
      </Paragraph>

      <Input.Password
        size="large"
        placeholder="Developer password"
        prefix={<LockOutlined />}
        value={password}
        onChange={(e) => { setPassword(e.target.value); setError(''); }}
        onPressEnter={handleSubmit}
        autoFocus
        autoComplete="off"
      />

      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginTop: 14 }}
        />
      )}

      <Paragraph style={{ marginTop: 18, marginBottom: 0, fontSize: 12, color: '#94a3b8' }}>
        <Space size={6}>
          <Tag color="default" style={{ marginRight: 0 }}>tip</Tag>
          The default ships as <code>dev@billing2025</code>. Override via the
          {' '}<code>DEVELOPER_PASSWORD</code> env on the server before going live.
        </Space>
      </Paragraph>
    </Modal>
  );
}
