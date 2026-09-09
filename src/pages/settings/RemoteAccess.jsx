import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Card, Button, Switch, Typography, Space, Tag, Alert, Modal,
  Descriptions, message, Spin, Empty, Table, Form, Input, Select, Popconfirm,
} from 'antd';
import {
  GlobalOutlined, QrcodeOutlined, ReloadOutlined, UserAddOutlined, DeleteOutlined, KeyOutlined,
  CheckCircleFilled, ExclamationCircleFilled, LoadingOutlined,
} from '@ant-design/icons';
import QRCode from 'qrcode';
import api from '../../api';
import './RemoteAccess.css';

const { Title, Text, Paragraph } = Typography;

/**
 * Settings → Remote Access.
 *
 * Turns this PC into something the shop's own phones can reach from outside
 * the Wi-Fi, via a Cloudflare Tunnel. Two things this screen must get right:
 *
 *   1. Be honest about state. "Enabled" and "actually reachable" are
 *      different things — the tunnel can be down while the toggle is on —
 *      so the status line reports what is true right now, not what was
 *      requested.
 *
 *   2. Never imply the shop depends on this. ZEHEN bills fine with the
 *      internet unplugged; remote access is an extra, and the copy says so.
 */

const POLL_MS = 5000;

function statusMeta(s) {
  switch (s) {
    case 'connected':  return { color: 'success', icon: <CheckCircleFilled />,      label: 'Connected' };
    case 'starting':   return { color: 'processing', icon: <LoadingOutlined />,     label: 'Connecting…' };
    case 'error':      return { color: 'warning', icon: <ExclamationCircleFilled />, label: 'Reconnecting' };
    default:           return { color: 'default', icon: null,                       label: 'Off' };
  }
}

export default function RemoteAccess() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState(null);      // { code, expires_at, hostname }
  const [qr, setQr] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [users, setUsers] = useState([]);
  const [usersErr, setUsersErr] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [pwFor, setPwFor] = useState(null);
  const [form] = Form.useForm();
  const [pwForm] = Form.useForm();
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/remote-access/status');
      setStatus(data);
    } catch {
      // A failure here means the local server is unreachable, which the rest
      // of the app already surfaces loudly. Stay quiet rather than stacking
      // another red banner on top.
    } finally {
      setLoading(false);
    }
  }, []);

  // These two loads are deliberately INDEPENDENT of each other.
  //
  // `/accounts` is proxied to the ZEHEN account service over the internet and
  // legitimately fails with 409 (no licence yet), 502 (shop offline) or a
  // pass-through non-2xx when the site isn't provisioned. `/linkable-users`
  // is a purely LOCAL database read that has nothing to do with any of that.
  //
  // They used to share one `Promise.all` and one silent `catch`, so any
  // failure of the remote half threw away the perfectly good local user list
  // and the "Signs in as" dropdown rendered a bare "No data" with no reason
  // given. Settle them separately, and remember WHY the list is empty so the
  // dropdown can say so instead of looking broken.
  const loadUsers = useCallback(async () => {
    try {
      const { data } = await api.get('/remote-access/linkable-users');
      const list = data?.users || [];
      setUsers(list);
      setUsersErr(list.length ? '' : 'No active ZEHEN users found — add one in Settings → Users.');
    } catch (e) {
      setUsers([]);
      setUsersErr(e?.response?.data?.error || 'Could not load the ZEHEN user list.');
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const { data } = await api.post('/remote-access/accounts', { action: 'list' });
      setAccounts(data?.accounts || []);
    } catch {
      // Needs a licence and internet; the card explains itself when empty.
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    load();
    loadAccounts();
    loadUsers();
    pollRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [load, loadAccounts, loadUsers]);

  async function manage(payload, okMsg) {
    try {
      const { data } = await api.post('/remote-access/accounts', payload);
      if (data?.error) throw new Error(data.error);
      message.success(okMsg);
      await loadAccounts();
      return true;
    } catch (e) {
      message.error(e?.response?.data?.error || e.message || 'That did not work.');
      return false;
    }
  }

  async function toggle(on) {
    setBusy(true);
    try {
      if (on) {
        const { data } = await api.post('/remote-access/enable', {});
        message.success(`Remote access on — ${data.hostname}`);
      } else {
        await api.post('/remote-access/disable', {});
        message.success('Remote access turned off');
      }
      await load();
    } catch (e) {
      message.error(e?.response?.data?.error || 'Could not change remote access.');
    } finally {
      setBusy(false);
    }
  }

  async function startPairing() {
    setBusy(true);
    try {
      const { data } = await api.post('/remote-access/pair', {});
      setPair(data);
      // The QR carries the hostname alongside the code, so one scan sets up
      // the phone completely — no typing an address on a phone keyboard.
      const payload = `https://zehenapp.com/p#c=${data.code}&h=${data.hostname}`;
      setQr(await QRCode.toDataURL(payload, { width: 320, margin: 1,
        color: { dark: '#1A1612', light: '#FFFFFF' } }));
    } catch (e) {
      message.error(e?.response?.data?.error || 'Could not create a pairing code.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="ra-loading"><Spin /></div>;
  }

  const meta = statusMeta(status?.status);
  const enabled = !!status?.enabled;

  return (
    <div className="ra-page">
      <div className="ra-header">
        <div>
          <Title level={4} style={{ margin: 0 }}>Remote Access</Title>
          <Text type="secondary">
            Let your own phones reach this computer from outside the shop Wi‑Fi.
          </Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} />
      </div>

      <Card className="ra-card">
        <div className="ra-toggle-row">
          <div className="ra-toggle-text">
            <div className="ra-toggle-title">
              <GlobalOutlined /> Reachable from the internet
            </div>
            <Text type="secondary" className="ra-toggle-sub">
              Billing, printing and reports keep working exactly as they do now
              whether this is on or off — including with no internet at all.
            </Text>
          </div>
          <Switch checked={enabled} loading={busy} onChange={toggle} />
        </div>

        {enabled && (
          <>
            <div className="ra-divider" />
            <Descriptions column={1} size="small" className="ra-desc">
              <Descriptions.Item label="Status">
                <Tag icon={meta.icon} color={meta.color}>{meta.label}</Tag>
                {status?.status === 'error' && status?.last_error && (
                  <Text type="secondary" className="ra-err">{status.last_error}</Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="Address">
                {status?.url
                  ? <Text copyable code>{status.url}</Text>
                  : <Text type="secondary">Not provisioned yet</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Paired phones">
                {status?.paired_devices ?? 0}
              </Descriptions.Item>
            </Descriptions>
          </>
        )}

        {!status?.cloudflared_available && (
          <Alert
            className="ra-alert"
            type="warning"
            showIcon
            message="Connector not installed"
            description="This build does not include the cloudflared connector, so remote access cannot start. Reinstall using the full installer."
          />
        )}
      </Card>

      <Card
        className="ra-card"
        title="Paired phones"
        extra={
          <Button type="primary" icon={<QrcodeOutlined />}
                  disabled={!enabled || !status?.site_id} onClick={startPairing} loading={busy}>
            Pair a phone
          </Button>
        }
      >
        {!enabled ? (
          <Empty description="Turn on remote access to pair a phone"
                 image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {status?.paired_devices
              ? <>This shop has <b>{status.paired_devices}</b> paired {status.paired_devices === 1 ? 'phone' : 'phones'}. Only paired phones can connect from outside — a lost phone can be un-paired without changing anyone's password.</>
              : <>No phones paired yet. Tap <b>Pair a phone</b>, then scan the code from the ZEHEN app on the phone.</>}
          </Paragraph>
        )}
      </Card>

      <Card
        className="ra-card"
        title="App accounts"
        extra={
          <Button icon={<UserAddOutlined />} onClick={() => { form.resetFields(); loadUsers(); setAddOpen(true); }}>
            Add account
          </Button>
        }
      >
        <Paragraph type="secondary">
          These are the email addresses and phone numbers that can sign in to the
          ZEHEN mobile app for this shop. Each one signs in with its own password
          and acts as the ZEHEN user you link it to — so permissions stay exactly
          as you set them here.
        </Paragraph>
        <Table
          size="small"
          rowKey="account_id"
          dataSource={accounts}
          pagination={false}
          locale={{ emptyText: 'No app accounts yet' }}
          columns={[
            { title: 'Email / phone', dataIndex: 'identifier' },
            { title: 'Name', dataIndex: 'label', render: (v) => v || <Text type="secondary">—</Text> },
            { title: 'Signs in as', dataIndex: 'shop_username', render: (v) => <Tag>{v}</Tag> },
            {
              title: 'Last used',
              dataIndex: 'last_login',
              render: (v) => (v ? new Date(v).toLocaleString() : <Text type="secondary">never</Text>),
            },
            {
              title: '',
              width: 120,
              render: (_, r) => (
                <Space>
                  <Button size="small" icon={<KeyOutlined />} onClick={() => { pwForm.resetFields(); setPwFor(r); }} />
                  <Popconfirm
                    title="Remove this account?"
                    description="They will be signed out of the app immediately."
                    onConfirm={() => manage({ action: 'delete', account_id: r.account_id }, 'Account removed')}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={addOpen}
        title="Add an app account"
        okText="Create"
        onCancel={() => setAddOpen(false)}
        onOk={async () => {
          const v = await form.validateFields().catch(() => null);
          if (!v) return;
          if (await manage({ action: 'create', ...v }, 'Account created')) setAddOpen(false);
        }}
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="identifier" label="Email or phone number"
                     rules={[{ required: true, message: 'Enter an email address or phone number' }]}>
            <Input placeholder="rahul@shop.com or 98765 43210" autoComplete="off" />
          </Form.Item>
          <Form.Item name="label" label="Name (optional)">
            <Input placeholder="Rahul — counter" autoComplete="off" />
          </Form.Item>
          <Form.Item name="shop_username" label="Signs in as"
                     rules={[{ required: true, message: 'Pick the ZEHEN user this account acts as' }]}
                     extra="Permissions come from this user, exactly as on the desktop.">
            <Select
              placeholder="Choose a ZEHEN user"
              loading={!users.length && !usersErr}
              notFoundContent={usersErr || 'No users found'}
              options={users.map((u) => ({
                value: u.username,
                label: `${u.username}${u.full_name ? ` — ${u.full_name}` : ''}${u.role ? ` (${u.role})` : ''}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="password" label="Password"
                     rules={[{ required: true, min: 8, message: 'At least 8 characters' }]}
                     extra="Share this with them once; they can keep using it on their phone.">
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!pwFor}
        title={`Set a new password for ${pwFor?.identifier || ''}`}
        okText="Update"
        onCancel={() => setPwFor(null)}
        onOk={async () => {
          const v = await pwForm.validateFields().catch(() => null);
          if (!v) return;
          if (await manage({ action: 'set_password', account_id: pwFor.account_id, password: v.password }, 'Password updated')) setPwFor(null);
        }}
      >
        <Form form={pwForm} layout="vertical" requiredMark={false}>
          <Form.Item name="password" label="New password"
                     rules={[{ required: true, min: 8, message: 'At least 8 characters' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!pair}
        onCancel={() => { setPair(null); setQr(''); }}
        footer={null}
        title="Scan this on the phone"
        width={380}
        centered
      >
        <div className="ra-qr">
          {qr ? <img src={qr} alt="Pairing QR code" /> : <Spin />}
          <div className="ra-qr-code">{pair?.code}</div>
          <Text type="secondary" className="ra-qr-note">
            In the ZEHEN app on the phone, tap <b>Pair this phone with your shop</b>.
            This code works once and expires in 10 minutes.
          </Text>
        </div>
      </Modal>
    </div>
  );
}
