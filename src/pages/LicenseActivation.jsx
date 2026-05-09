import React, { useEffect, useRef, useState } from 'react';
import { Card, Button, Input, message, Tag, Alert, Tabs } from 'antd';
import {
  KeyOutlined, FolderOpenOutlined, CheckCircleFilled,
  WarningFilled, CopyOutlined,
} from '@ant-design/icons';
import api from '../api';

/**
 * License Activation screen.
 * ──────────────────────────
 * Shown automatically when the server reports `no_license`. Two ways to
 * activate:
 *
 *   1. Choose .dat file — the customer (or you, on AnyDesk) browses to
 *      the file and uploads its content.
 *   2. Paste content   — for AnyDesk sessions where you've copied the
 *      envelope text from License Studio.
 *
 * After activation we hard-reload so every component re-fetches its
 * data with a fresh license-aware session.
 *
 * The page also surfaces this machine's fingerprint so the vendor can
 * tell the issuer (License Studio) which device to bind to. This is
 * what the customer reads to me over the phone if I want to bind
 * before they've activated.
 */
export default function LicenseActivation() {
  const [machineFp, setMachineFp] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [serverStatus, setServerStatus] = useState(null);
  const fileRef = useRef(null);

  // Pull the cached license_block payload that the API interceptor
  // stashed when it bounced us here, plus the live server status so
  // the screen reflects the actual state on every refresh.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('license_block_status');
      if (raw) setServerStatus(JSON.parse(raw));
    } catch {}
    api.get('/license/info').then(r => {
      const s = r.data?.status;
      if (s) setServerStatus({ ...(s || {}), code: s?.code || (r.data?.activated ? null : 'no_license') });
      setMachineFp(r.data?.machine_fp || '');
    }).catch(() => {
      // /info may itself 403 if the gate has a quirk; fall back to fp endpoint
      api.get('/license/machine-fingerprint').then(r => setMachineFp(r.data?.machine_fp || '')).catch(() => {});
    });
  }, []);

  const initialStatus = serverStatus;

  const submitText = async (text) => {
    if (!text || !text.trim()) return setError('Paste the license file content first');
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/license/activate', { license: text });
      if (r.data?.ok) {
        message.success('License activated successfully');
        // Full reload — easier than rehydrating every store; this only
        // happens once per install per machine.
        setTimeout(() => window.location.reload(), 600);
      } else {
        setError(r.data?.message || 'Activation failed');
      }
    } catch (e) {
      const data = e?.response?.data;
      setError(data?.message || data?.error || e.message || 'Activation failed');
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    submitText(text);
    e.target.value = '';
  };

  const copyFp = () => {
    navigator.clipboard?.writeText(machineFp);
    message.success('Machine fingerprint copied');
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      background: 'radial-gradient(circle at 20% 10%, rgba(33,96,76,0.12), transparent 50%), radial-gradient(circle at 80% 90%, rgba(177,71,47,0.10), transparent 60%)',
    }}>
      <Card style={{ width: 560, boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10,
            background: 'linear-gradient(135deg, #21604C, #163d31)',
            color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22,
          }}>
            <KeyOutlined />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Activate Billing ERP</h2>
            <div style={{ color: '#64748b', fontSize: 13 }}>This installation needs a valid license to start.</div>
          </div>
        </div>

        {initialStatus?.code && initialStatus.code !== 'no_license' && (
          <Alert
            type="warning"
            showIcon
            message={statusHeadline(initialStatus.code)}
            description={initialStatus.message || ''}
            style={{ marginTop: 12, marginBottom: 4 }}
          />
        )}

        <div style={{ marginTop: 16 }}>
          <Tabs
            defaultActiveKey="file"
            items={[
              {
                key: 'file', label: <span><FolderOpenOutlined /> Choose .dat file</span>,
                children: (
                  <div style={{ padding: '16px 0 4px' }}>
                    <p style={{ color: '#475569', fontSize: 13, marginTop: 0 }}>
                      Browse to the license file you received from your vendor
                      (e.g. <code>C-2026-0042-2026-05-09.dat</code>).
                    </p>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".dat,application/json,application/octet-stream,text/plain"
                      onChange={onFile}
                      style={{ display: 'none' }}
                    />
                    <Button
                      type="primary"
                      size="large"
                      icon={<FolderOpenOutlined />}
                      onClick={() => fileRef.current?.click()}
                      loading={busy}
                      block
                    >
                      Choose license file
                    </Button>
                  </div>
                ),
              },
              {
                key: 'paste', label: <span><CopyOutlined /> Paste content</span>,
                children: (
                  <div style={{ padding: '16px 0 4px' }}>
                    <p style={{ color: '#475569', fontSize: 13, marginTop: 0 }}>
                      For AnyDesk activation: open the .dat in any text editor on your
                      vendor's machine, copy ALL of its content, and paste below.
                    </p>
                    <Input.TextArea
                      rows={6}
                      value={pasteText}
                      onChange={(e) => { setPasteText(e.target.value); setError(''); }}
                      placeholder='{"v":1,"kind":"license-studio.license", ...}'
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <Button
                      type="primary"
                      size="large"
                      icon={<CheckCircleFilled />}
                      onClick={() => submitText(pasteText)}
                      loading={busy}
                      block
                      style={{ marginTop: 12 }}
                      disabled={!pasteText.trim()}
                    >
                      Activate
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </div>

        {error && (
          <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />
        )}

        <div style={{
          marginTop: 24, padding: 14, borderRadius: 8,
          background: '#f1f5f9', border: '1px solid #e2e8f0',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#64748b', marginBottom: 4 }}>
            <WarningFilled style={{ color: '#f59e0b', marginRight: 6 }} />
            For your vendor: this machine's fingerprint
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#334155', wordBreak: 'break-all' }}>
            {machineFp || '—'}
          </div>
          <Button size="small" icon={<CopyOutlined />} onClick={copyFp} style={{ marginTop: 8 }}>
            Copy fingerprint
          </Button>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
            Read this to your vendor when you call to get a license bound to this PC.
          </div>
        </div>
      </Card>
    </div>
  );
}

function statusHeadline(code) {
  switch (code) {
    case 'expired':           return 'License expired';
    case 'machine_mismatch':  return 'License is bound to a different machine';
    case 'clock_tampered':    return 'System clock has been changed';
    case 'invalid_signature': return 'License signature is invalid';
    case 'invalid_format':    return 'License file is corrupted';
    case 'public_key_not_configured': return 'Build is missing the verification key';
    default:                  return 'License problem';
  }
}
