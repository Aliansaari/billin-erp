import React, { useEffect, useRef, useState } from 'react';
import {
  Card, Tag, Button, Modal, Input, Alert, message, Tooltip, Descriptions,
  Skeleton, Space,
} from 'antd';
import {
  KeyOutlined, CheckCircleFilled, ExclamationCircleFilled, CopyOutlined,
  ReloadOutlined, FolderOpenOutlined, FieldTimeOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '../../api';

/**
 * License panel — read-only status for the customer plus the
 * "Replace license" flow you (the vendor) walk them through during
 * AnyDesk renewals.
 *
 * The panel surfaces:
 *   • Customer ID + name (from the signed payload — proves which
 *     customer this install belongs to)
 *   • License type (trial / annual / etc.)
 *   • Issued + expires dates with a days-left countdown
 *   • Machine fingerprint (for vendor support — paste back into
 *     License Studio to bind a floating license)
 *   • "Activation report" — a copyable block the vendor pastes into
 *     License Studio's Mark-Activated form so the customer record
 *     records when + on which machine the license was activated
 *
 * Replace flow — vendor uploads/pastes a fresh .dat that supersedes
 * the current license. Same /api/license/activate endpoint as
 * first-time activation; it's idempotent.
 */
export default function LicenseSettings() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [replaceOpen, setReplaceOpen] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get('/license/info');
      setInfo(r.data);
    } catch (e) {
      message.error('Could not read license status');
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <Skeleton active paragraph={{ rows: 6 }} />;

  const status = info?.status || { ok: false, code: 'no_license' };
  const today = dayjs().format('YYYY-MM-DD');
  const daysLeft = status.expires_at ? dayjs(status.expires_at).diff(today, 'day') : null;
  const tone = status.ok
    ? (daysLeft != null && daysLeft <= 14 ? 'expiring' : 'active')
    : 'invalid';

  const tag = (() => {
    if (status.ok && tone === 'active') {
      return <Tag color="green" icon={<CheckCircleFilled />}>Active — {daysLeft} days left</Tag>;
    }
    if (status.ok && tone === 'expiring') {
      return <Tag color="orange" icon={<FieldTimeOutlined />}>{daysLeft === 0 ? 'Expires today' : `${daysLeft} days left`}</Tag>;
    }
    return <Tag color="red" icon={<ExclamationCircleFilled />}>{statusLabel(status.code)}</Tag>;
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title={(
          <span>
            <KeyOutlined style={{ marginRight: 8 }} />
            License status
          </span>
        )}
        extra={(
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
            <Button type="primary" onClick={() => setReplaceOpen(true)}>Replace license</Button>
          </Space>
        )}
      >
        <div style={{ marginBottom: 12 }}>{tag}</div>

        {!status.ok && (
          <Alert
            type={status.code === 'no_license' ? 'info' : 'error'}
            showIcon
            message={statusLabel(status.code)}
            description={statusHelp(status)}
            style={{ marginBottom: 16 }}
          />
        )}

        <Descriptions
          size="small"
          column={2}
          labelStyle={{ width: 160 }}
        >
          <Descriptions.Item label="Customer">{status.customer_name || '—'}</Descriptions.Item>
          <Descriptions.Item label="Customer ID">
            <code>{status.customer_id || '—'}</code>
          </Descriptions.Item>
          <Descriptions.Item label="License type">
            {status.license_type
              ? <Tag color="blue" style={{ textTransform: 'capitalize' }}>{String(status.license_type).replace('_', ' ')}</Tag>
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Max companies">{status.max_companies ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Issued">{status.issued_at ? dayjs(status.issued_at).format('DD MMM YYYY') : '—'}</Descriptions.Item>
          <Descriptions.Item label="Expires">{status.expires_at ? dayjs(status.expires_at).format('DD MMM YYYY') : '—'}</Descriptions.Item>
          <Descriptions.Item label="Machine fingerprint" span={2}>
            <Space>
              <code style={{ wordBreak: 'break-all' }}>{info?.machine_fp || '—'}</code>
              <Tooltip title="Copy fingerprint">
                <Button size="small" icon={<CopyOutlined />} onClick={() => copyText(info?.machine_fp || '')} />
              </Tooltip>
            </Space>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <ActivationReportCard info={info} />

      {replaceOpen && (
        <ReplaceLicenseModal
          onClose={() => setReplaceOpen(false)}
          onReplaced={() => { setReplaceOpen(false); load(); }}
        />
      )}
    </div>
  );
}

/**
 * Activation report — a small copyable text block the vendor (you)
 * pastes into License Studio's "Mark Activated" form on the customer
 * detail page. License Studio updates `licenses.activated_at` and
 * `licenses.machine_fingerprint` based on it.
 *
 * Format is a single line of `key=value;` pairs so the parser in
 * License Studio doesn't have to be clever — easy to copy/paste even
 * over a phone call.
 */
function ActivationReportCard({ info }) {
  if (!info?.activated || !info?.status?.ok) return null;
  const s = info.status;
  const report = [
    `customer_id=${s.customer_id}`,
    `customer_name=${s.customer_name || ''}`,
    `license_type=${s.license_type}`,
    `issued_at=${s.issued_at}`,
    `expires_at=${s.expires_at}`,
    `machine_fp=${info.machine_fp}`,
    `activated_at=${new Date().toISOString()}`,
  ].join(';');

  return (
    <Card
      title="Activation report (for vendor)"
      extra={(
        <Button icon={<CopyOutlined />} onClick={() => copyText(report)}>
          Copy report
        </Button>
      )}
    >
      <p style={{ color: '#64748b', fontSize: 13, margin: '0 0 12px' }}>
        Send this single line to your vendor so they can record that this
        installation has been activated. Useful during phone-support and
        AnyDesk sessions — your vendor pastes it into License Studio
        and the customer record gets updated automatically.
      </p>
      <Input.TextArea
        readOnly
        value={report}
        rows={3}
        style={{ fontFamily: 'monospace', fontSize: 12, background: '#f8fafc' }}
        onClick={(e) => e.target.select()}
      />
    </Card>
  );
}

function ReplaceLicenseModal({ onClose, onReplaced }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const submit = async (envelope) => {
    if (!envelope) return setError('Pick or paste a license file first');
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/license/activate', { license: envelope });
      if (r.data?.ok) {
        message.success('License replaced successfully');
        onReplaced();
      } else {
        setError(r.data?.message || 'Activation failed');
      }
    } catch (e) {
      const data = e?.response?.data;
      setError(data?.message || data?.error || e.message || 'Activation failed');
    } finally { setBusy(false); }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    submit(txt);
    e.target.value = '';
  };

  return (
    <Modal
      open
      onCancel={onClose}
      title="Replace license"
      footer={null}
      width={560}
    >
      <p style={{ color: '#475569', fontSize: 13, margin: '0 0 12px' }}>
        Drop the new <code>.dat</code> from your vendor — it'll supersede the
        current license without losing any data. Your previous license file is
        backed up next to the new one.
      </p>
      <Space direction="vertical" style={{ width: '100%' }}>
        <input ref={fileRef} type="file" accept=".dat,application/json,text/plain" onChange={onFile} style={{ display: 'none' }} />
        <Button
          type="primary"
          size="large"
          icon={<FolderOpenOutlined />}
          block
          onClick={() => fileRef.current?.click()}
          loading={busy}
        >
          Choose .dat file
        </Button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#94a3b8', fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
          OR paste content
          <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
        </div>
        <Input.TextArea
          rows={6}
          value={text}
          onChange={(e) => { setText(e.target.value); setError(''); }}
          placeholder='{"v":1,"kind":"license-studio.license", ...}'
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
        <Button
          type="primary"
          size="large"
          icon={<CheckCircleFilled />}
          block
          onClick={() => submit(text)}
          disabled={!text.trim() || busy}
          loading={busy}
        >
          Activate
        </Button>
        {error && <Alert type="error" showIcon message={error} />}
      </Space>
    </Modal>
  );
}

function copyText(text) {
  navigator.clipboard?.writeText(text || '');
  message.success('Copied');
}

function statusLabel(code) {
  switch (code) {
    case 'no_license':         return 'No license activated';
    case 'expired':            return 'License expired';
    case 'machine_mismatch':   return 'Bound to a different machine';
    case 'clock_tampered':     return 'System clock changed';
    case 'invalid_signature':  return 'License signature invalid';
    case 'invalid_format':     return 'License file corrupted';
    case 'public_key_not_configured': return 'Build missing verification key';
    default:                   return 'Invalid license';
  }
}

function statusHelp(s) {
  switch (s.code) {
    case 'no_license':
      return 'Click "Replace license" above to activate this installation.';
    case 'expired':
      return `Renew your license to continue using Billing ERP. Contact your vendor with this customer ID: ${s.customer_id || '—'}.`;
    case 'machine_mismatch':
      return 'This license was issued for another machine. Ask your vendor to issue a fresh license bound to this PC.';
    case 'clock_tampered':
      return 'The system date/time has been changed. Set the correct date and try again.';
    case 'invalid_signature':
      return 'The license file is not signed by the vendor key embedded in this build.';
    case 'public_key_not_configured':
      return 'This build was packaged without the vendor verification key. Contact your vendor to get a corrected build.';
    default:
      return '';
  }
}
