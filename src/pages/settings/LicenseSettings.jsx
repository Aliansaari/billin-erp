import React, { useEffect, useRef, useState } from 'react';
import {
  Button, Modal, Input, Alert, message, Tooltip, Skeleton,
} from 'antd';
import {
  KeyOutlined, CheckCircleFilled, ExclamationCircleFilled, CopyOutlined,
  ReloadOutlined, FolderOpenOutlined, FieldTimeOutlined, ClockCircleFilled,
  SafetyCertificateFilled, CrownFilled, CalendarOutlined, IdcardOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '../../api';

/**
 * License panel — read-only status + vendor "Replace license" flow.
 *
 * Surfaces:
 *   • Customer ID + name (from signed payload)
 *   • License type, issued + expires dates, days-left countdown
 *   • Machine fingerprint (for vendor support)
 *   • Activation report — copyable block for License Studio
 *
 * Replace flow uses the same /api/license/activate endpoint as first
 * activation; it's idempotent.
 */
export default function LicenseSettings() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [fpCopied, setFpCopied] = useState(false);
  const [reportCopied, setReportCopied] = useState(false);

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

  if (loading) {
    return (
      <div className="lic-settings-wrap">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  const status = info?.status || { ok: false, code: 'no_license' };
  const today = dayjs().format('YYYY-MM-DD');
  const daysLeft = status.expires_at ? dayjs(status.expires_at).diff(today, 'day') : null;
  const tone = status.ok
    ? (daysLeft != null && daysLeft <= 14 ? 'expiring' : 'active')
    : 'invalid';

  const copyFp = () => {
    navigator.clipboard?.writeText(info?.machine_fp || '');
    setFpCopied(true);
    setTimeout(() => setFpCopied(false), 1800);
  };

  // Format fingerprint into 4 balanced 8-char groups
  const fp = info?.machine_fp || '';
  const fpDisplay = fp.length >= 32
    ? `${fp.slice(0, 8)} · ${fp.slice(8, 16)} · ${fp.slice(16, 24)} · ${fp.slice(24, 32)}`
    : (fp || '—');

  return (
    <div className="lic-settings-wrap">
      <style>{LIC_SET_STYLES}</style>

      <header className="lic-set-header">
        <div>
          <h1>License</h1>
          <p>Status, expiry, and machine binding for this installation.</p>
        </div>
        <div className="lic-set-header-actions">
          <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
          <Button type="primary" icon={<KeyOutlined />} onClick={() => setReplaceOpen(true)} className="lic-set-replace-btn">
            Replace license
          </Button>
        </div>
      </header>

      {/* Hero status card — visual centerpiece */}
      <section className={`lic-set-hero lic-set-hero-${tone}`}>
        <div className="lic-set-hero-pattern" />
        <div className="lic-set-hero-content">
          <div className="lic-set-hero-row">
            <div className="lic-set-hero-icon">
              {tone === 'active' && <SafetyCertificateFilled />}
              {tone === 'expiring' && <FieldTimeOutlined />}
              {tone === 'invalid' && <ExclamationCircleFilled />}
            </div>
            <div className="lic-set-hero-text">
              <div className="lic-set-hero-eyebrow">License Status</div>
              <h2>{toneTitle(tone, daysLeft, status)}</h2>
              <p>{toneSubtitle(tone, daysLeft, status)}</p>
            </div>
          </div>

          {tone === 'active' && daysLeft != null && (
            <div className="lic-set-hero-countdown">
              <div className="lic-set-countdown-num">{daysLeft}</div>
              <div className="lic-set-countdown-label">days remaining</div>
            </div>
          )}
        </div>
      </section>

      {!status.ok && (
        <Alert
          type={status.code === 'no_license' ? 'info' : 'error'}
          showIcon
          message={statusLabel(status.code)}
          description={statusHelp(status)}
          style={{ marginBottom: 18, borderRadius: 12 }}
        />
      )}

      {/* Details grid */}
      <section className="lic-set-card">
        <div className="lic-set-card-head">
          <h3>License details</h3>
          <span className="lic-set-card-sub">From the signed license payload</span>
        </div>
        <div className="lic-set-grid">
          <Detail icon={<IdcardOutlined />} label="Customer" value={status.customer_name || '—'} />
          <Detail icon={<KeyOutlined />} label="Customer ID" value={status.customer_id || '—'} mono />
          <Detail
            icon={<CrownFilled />}
            label="License type"
            value={status.license_type ? String(status.license_type).replace('_', ' ') : '—'}
            capitalize
          />
          <Detail icon={<CalendarOutlined />} label="Max companies" value={status.max_companies ?? '—'} />
          <Detail
            icon={<CalendarOutlined />}
            label="Issued"
            value={status.issued_at ? dayjs(status.issued_at).format('DD MMM YYYY') : '—'}
          />
          <Detail
            icon={<FieldTimeOutlined />}
            label="Expires"
            value={status.expires_at ? dayjs(status.expires_at).format('DD MMM YYYY') : '—'}
          />
        </div>
      </section>

      {/* Machine binding */}
      <section className="lic-set-card lic-set-fp-card">
        <div className="lic-set-card-head">
          <h3>Machine binding</h3>
          <span className="lic-set-card-sub">This license is locked to this PC</span>
        </div>
        <div className="lic-set-fp-row">
          <div className="lic-set-fp-icon-badge"><KeyOutlined /></div>
          <div className="lic-set-fp-content">
            <div className="lic-set-fp-label">Machine ID</div>
            <div className="lic-set-fp-value">{fpDisplay}</div>
          </div>
          <button
            type="button"
            className={`lic-set-copy-btn ${fpCopied ? 'is-copied' : ''}`}
            onClick={copyFp}
            disabled={!fp}
            title="Copy machine ID"
          >
            {fpCopied ? <CheckCircleFilled /> : <CopyOutlined />}
            <span>{fpCopied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </section>

      <ActivationReportCard
        info={info}
        copied={reportCopied}
        setCopied={setReportCopied}
      />

      {replaceOpen && (
        <ReplaceLicenseModal
          onClose={() => setReplaceOpen(false)}
          onReplaced={() => { setReplaceOpen(false); load(); }}
        />
      )}
    </div>
  );
}

function Detail({ icon, label, value, mono, capitalize }) {
  return (
    <div className="lic-set-detail">
      <div className="lic-set-detail-icon">{icon}</div>
      <div className="lic-set-detail-text">
        <div className="lic-set-detail-label">{label}</div>
        <div className={`lic-set-detail-value ${mono ? 'is-mono' : ''} ${capitalize ? 'is-capitalize' : ''}`}>{value}</div>
      </div>
    </div>
  );
}

function ActivationReportCard({ info, copied, setCopied }) {
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

  const copy = () => {
    navigator.clipboard?.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <section className="lic-set-card">
      <div className="lic-set-card-head">
        <div>
          <h3>Activation report</h3>
          <span className="lic-set-card-sub">For vendor — paste into License Studio</span>
        </div>
        <button
          type="button"
          className={`lic-set-copy-btn ${copied ? 'is-copied' : ''}`}
          onClick={copy}
          title="Copy report"
        >
          {copied ? <CheckCircleFilled /> : <CopyOutlined />}
          <span>{copied ? 'Copied' : 'Copy report'}</span>
        </button>
      </div>
      <Input.TextArea
        readOnly
        value={report}
        rows={3}
        onClick={(e) => e.target.select()}
        className="lic-set-report-textarea"
      />
    </section>
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
      title={<span><KeyOutlined style={{ marginRight: 8 }} />Replace license</span>}
      footer={null}
      width={560}
    >
      <p style={{ color: '#475569', fontSize: 13, margin: '4px 0 18px', lineHeight: 1.55 }}>
        Drop the new <code style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>.dat</code> from your vendor — it'll supersede the
        current license without losing any data. Your previous license file is
        backed up automatically.
      </p>
      <input ref={fileRef} type="file" accept=".dat,application/json,text/plain" onChange={onFile} style={{ display: 'none' }} />
      <Button
        type="primary"
        size="large"
        icon={<FolderOpenOutlined />}
        block
        onClick={() => fileRef.current?.click()}
        loading={busy}
        style={{ height: 46, borderRadius: 10, fontWeight: 600 }}
      >
        Choose .dat file
      </Button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0 10px', color: '#94a3b8', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
        Or paste content
        <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
      </div>
      <Input.TextArea
        rows={6}
        value={text}
        onChange={(e) => { setText(e.target.value); setError(''); }}
        placeholder='{"v":1,"kind":"license-studio.license", ...}'
        style={{ fontFamily: 'ui-monospace, SF Mono, Consolas, monospace', fontSize: 12, borderRadius: 10 }}
      />
      <Button
        type="primary"
        size="large"
        icon={<CheckCircleFilled />}
        block
        onClick={() => submit(text)}
        disabled={!text.trim() || busy}
        loading={busy}
        style={{ marginTop: 12, height: 46, borderRadius: 10, fontWeight: 600 }}
      >
        Activate
      </Button>
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 14, borderRadius: 8 }} />}
    </Modal>
  );
}

function toneTitle(tone, daysLeft, status) {
  if (tone === 'active') return 'Licensed & Active';
  if (tone === 'expiring') return daysLeft === 0 ? 'Expires today' : 'Expiring soon';
  return statusLabel(status.code);
}
function toneSubtitle(tone, daysLeft, status) {
  if (tone === 'active') return `Your installation is fully licensed. Expires ${dayjs(status.expires_at).format('DD MMM YYYY')}.`;
  if (tone === 'expiring') return `Contact your vendor to renew. Expires ${dayjs(status.expires_at).format('DD MMM YYYY')}.`;
  return statusHelp(status);
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
      return `Renew your license to continue using ZEHEN. Contact your vendor with customer ID: ${s.customer_id || '—'}.`;
    case 'machine_mismatch':
      return 'This license was issued for another machine. Ask your vendor for a fresh license bound to this PC.';
    case 'clock_tampered':
      return 'The system date/time has been changed. Set the correct date and try again.';
    case 'invalid_signature':
      return 'The license file is not signed by the vendor key embedded in this build.';
    case 'public_key_not_configured':
      return 'This build was packaged without the vendor verification key. Contact your vendor.';
    default:
      return '';
  }
}

const LIC_SET_STYLES = `
.lic-settings-wrap {
  max-width: 920px;
  margin: 0 auto;
  padding: 8px 0 32px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Header */
.lic-set-header {
  display: flex; justify-content: space-between; align-items: flex-end;
  gap: 16px; flex-wrap: wrap;
  margin-bottom: 24px;
}
.lic-set-header h1 {
  font-size: 28px; font-weight: 700; letter-spacing: -0.6px;
  margin: 0 0 4px;
  color: var(--fg-primary, #0F172A);
  line-height: 1.2;
}
.lic-set-header p {
  font-size: 14px; color: var(--fg-secondary, #64748b);
  margin: 0; line-height: 1.5;
}
.lic-set-header-actions { display: flex; gap: 8px; }
.lic-set-replace-btn.ant-btn-primary {
  background: linear-gradient(135deg, #0F172A 0%, #1e293b 100%) !important;
  border-color: #0F172A !important;
  border-radius: 8px !important;
  font-weight: 600 !important;
  box-shadow: 0 4px 12px -4px rgba(15, 23, 42, 0.4) !important;
}
.lic-set-replace-btn.ant-btn-primary:hover {
  background: linear-gradient(135deg, #1e293b 0%, #334155 100%) !important;
}

/* Hero status card */
.lic-set-hero {
  position: relative;
  border-radius: 18px;
  padding: 28px 32px;
  margin-bottom: 18px;
  color: #fff;
  overflow: hidden;
}
.lic-set-hero-active {
  background: linear-gradient(135deg, #065f46 0%, #0d9488 60%, #14b8a6 100%);
  box-shadow: 0 12px 28px -10px rgba(13, 148, 136, 0.4);
}
.lic-set-hero-expiring {
  background: linear-gradient(135deg, #92400e 0%, #d97706 60%, #f59e0b 100%);
  box-shadow: 0 12px 28px -10px rgba(217, 119, 6, 0.4);
}
.lic-set-hero-invalid {
  background: linear-gradient(135deg, #7f1d1d 0%, #b91c1c 60%, #dc2626 100%);
  box-shadow: 0 12px 28px -10px rgba(185, 28, 28, 0.4);
}
.lic-set-hero-pattern {
  position: absolute; inset: 0;
  background-image: radial-gradient(circle at 1px 1px, rgba(255,255,255,0.08) 1px, transparent 0);
  background-size: 24px 24px;
  mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 30%, transparent 80%);
  -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 30%, transparent 80%);
  pointer-events: none;
}
.lic-set-hero-content {
  position: relative; z-index: 1;
  display: flex; justify-content: space-between; align-items: center;
  gap: 20px;
}
.lic-set-hero-row {
  display: flex; gap: 16px; align-items: center;
}
.lic-set-hero-icon {
  width: 56px; height: 56px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 14px;
  background: rgba(255,255,255,0.16);
  border: 1px solid rgba(255,255,255,0.18);
  backdrop-filter: blur(6px);
  font-size: 28px;
  color: #fff;
  flex-shrink: 0;
}
.lic-set-hero-eyebrow {
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: rgba(255,255,255,0.7);
  margin-bottom: 4px;
}
.lic-set-hero h2 {
  font-size: 26px; font-weight: 700; letter-spacing: -0.5px;
  margin: 0 0 4px; color: #fff; line-height: 1.2;
}
.lic-set-hero p {
  font-size: 13.5px; color: rgba(255,255,255,0.85);
  margin: 0; line-height: 1.5; max-width: 480px;
}
.lic-set-hero-countdown {
  text-align: right;
  flex-shrink: 0;
}
.lic-set-countdown-num {
  font-size: 48px; font-weight: 800;
  line-height: 1; color: #fff;
  letter-spacing: -2px;
  font-variant-numeric: tabular-nums;
}
.lic-set-countdown-label {
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(255,255,255,0.75);
  margin-top: 6px;
}

/* Cards */
.lic-set-card {
  background: var(--bg-panel, #fff);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.06));
  border-radius: 16px;
  padding: 22px 24px;
  margin-bottom: 16px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
}
.lic-set-card-head {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 12px;
  margin-bottom: 18px;
}
.lic-set-card-head h3 {
  font-size: 15px; font-weight: 700;
  margin: 0; color: var(--fg-primary, #0F172A);
  letter-spacing: -0.2px;
}
.lic-set-card-sub {
  display: block;
  font-size: 12px; color: var(--fg-tertiary, #94a3b8);
  margin-top: 2px;
}

/* Detail grid */
.lic-set-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}
.lic-set-detail {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 14px 16px;
  background: var(--bg-muted, #f8fafc);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.04));
  border-radius: 12px;
}
.lic-set-detail-icon {
  flex: 0 0 32px; height: 32px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px;
  background: var(--bg-panel, #fff);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.06));
  color: #6366f1;
  font-size: 14px;
}
.lic-set-detail-text { flex: 1; min-width: 0; }
.lic-set-detail-label {
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--fg-tertiary, #94a3b8);
  margin-bottom: 4px;
}
.lic-set-detail-value {
  font-size: 14px; font-weight: 600;
  color: var(--fg-primary, #0F172A);
  word-break: break-word;
}
.lic-set-detail-value.is-mono {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.lic-set-detail-value.is-capitalize { text-transform: capitalize; }

/* Fingerprint card */
.lic-set-fp-card { padding: 22px 24px; }
.lic-set-fp-row {
  display: flex; gap: 14px; align-items: center;
  background: var(--bg-muted, #f8fafc);
  border: 1px solid var(--border-subtle, rgba(15, 23, 42, 0.04));
  border-radius: 12px;
  padding: 14px 16px;
}
.lic-set-fp-icon-badge {
  width: 40px; height: 40px;
  border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #0F172A 0%, #334155 100%);
  color: #fff;
  font-size: 18px;
  box-shadow: 0 4px 10px -4px rgba(15, 23, 42, 0.4);
  flex-shrink: 0;
}
.lic-set-fp-content { flex: 1; min-width: 0; }
.lic-set-fp-label {
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--fg-secondary, #64748b);
  margin-bottom: 4px;
}
.lic-set-fp-value {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 13px; font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--fg-primary, #0F172A);
  user-select: all;
  font-variant-numeric: tabular-nums;
}

/* Copy button */
.lic-set-copy-btn {
  display: inline-flex; gap: 6px; align-items: center;
  padding: 7px 12px;
  background: var(--bg-panel, #fff);
  border: 1px solid var(--border-subtle, #e2e8f0);
  border-radius: 8px;
  font-size: 12px; font-weight: 500;
  color: var(--fg-secondary, #475569);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  font-family: inherit;
}
.lic-set-copy-btn:hover:not(:disabled) {
  border-color: #6366f1;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.04);
}
.lic-set-copy-btn.is-copied {
  border-color: #10b981;
  color: #10b981;
  background: rgba(16, 185, 129, 0.06);
}
.lic-set-copy-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Report textarea */
.lic-set-report-textarea.ant-input {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace !important;
  font-size: 12px !important;
  border-radius: 10px !important;
  background: var(--bg-muted, #f8fafc) !important;
  border-color: var(--border-subtle, #e2e8f0) !important;
}

@media (max-width: 720px) {
  .lic-set-hero-content { flex-direction: column; align-items: flex-start; }
  .lic-set-hero-countdown { text-align: left; }
  .lic-set-countdown-num { font-size: 40px; }
  .lic-set-fp-row { flex-wrap: wrap; }
}
`;
