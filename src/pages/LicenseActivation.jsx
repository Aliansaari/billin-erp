import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, message, Alert } from 'antd';
import {
  FolderOpenOutlined, CheckCircleFilled,
  CopyOutlined, FileTextOutlined, SafetyOutlined,
  ThunderboltFilled, SafetyCertificateFilled, ClockCircleFilled,
  LockOutlined, CloudUploadOutlined, KeyOutlined,
} from '@ant-design/icons';
import api from '../api';

/**
 * License Activation — first-impression screen.
 * Shown when the server reports `no_license`. Path-1 is .dat file upload,
 * path-2 is paste-content (for AnyDesk). After activation we hard-navigate
 * to '/' so App.jsx re-evaluates state from scratch.
 */
export default function LicenseActivation() {
  const [machineFp, setMachineFp] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [serverStatus, setServerStatus] = useState(null);
  const [tab, setTab] = useState('file');
  const [fpCopied, setFpCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

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
      api.get('/license/machine-fingerprint').then(r => setMachineFp(r.data?.machine_fp || '')).catch(() => {});
    });
  }, []);

  const submitText = async (text) => {
    if (!text || !text.trim()) return setError('Paste the license file content first');
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/license/activate', { license: text });
      if (r.data?.ok) {
        message.success('License activated successfully');
        try { sessionStorage.removeItem('license_block_status'); } catch {}
        setTimeout(() => { window.location.href = '/'; }, 600);
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

  const onFileSelected = async (file) => {
    if (!file) return;
    const text = await file.text();
    submitText(text);
  };

  const onFile = async (e) => {
    await onFileSelected(e.target.files?.[0]);
    e.target.value = '';
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFileSelected(f);
  };

  const copyFp = () => {
    navigator.clipboard?.writeText(machineFp);
    setFpCopied(true);
    setTimeout(() => setFpCopied(false), 1800);
  };

  const showStatusAlert = serverStatus?.code && serverStatus.code !== 'no_license';

  // Format fingerprint into 4 balanced 8-char groups for readability.
  // Full value remains copyable as-is.
  const fpDisplay = machineFp && machineFp.length >= 32
    ? `${machineFp.slice(0, 8)} · ${machineFp.slice(8, 16)} · ${machineFp.slice(16, 24)} · ${machineFp.slice(24, 32)}`
    : (machineFp || '—');

  return (
    <div className="lic-act-page">
      <style>{LIC_STYLES}</style>

      {/* LEFT — brand panel */}
      <aside className="lic-act-brand">
        <div className="lic-act-orb lic-act-orb-1" />
        <div className="lic-act-orb lic-act-orb-2" />
        <div className="lic-act-grid" />

        <div className="lic-act-brand-inner">
          <header className="lic-act-logo">
            <div className="lic-act-logo-mark">
              <svg viewBox="0 0 80 80" width="32" height="32" aria-hidden="true">
                <path d="M 19 60 L 19 22 L 40 48 L 61 22 L 61 60" stroke="#fff" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div className="lic-act-wordmark">manas</div>
              <div className="lic-act-tagline">Billing ERP</div>
            </div>
          </header>

          <div className="lic-act-hero">
            <div className="lic-act-eyebrow">
              <span className="lic-act-eyebrow-dot" />
              Awaiting activation
            </div>
            <h1>
              Welcome to <span className="lic-act-hero-accent">Manas</span>.
            </h1>
            <p>One quick step before you can start billing — activate this installation with the license your vendor sent you.</p>
          </div>

          <ul className="lic-act-features">
            <li>
              <span className="lic-act-feat-icon lic-act-feat-icon-indigo"><SafetyCertificateFilled /></span>
              <div>
                <strong>Secure by default</strong>
                <span>Signed, machine-bound license — works offline forever.</span>
              </div>
            </li>
            <li>
              <span className="lic-act-feat-icon lic-act-feat-icon-amber"><ThunderboltFilled /></span>
              <div>
                <strong>Activates in seconds</strong>
                <span>Drop the file or paste the contents — no signups, no cloud.</span>
              </div>
            </li>
            <li>
              <span className="lic-act-feat-icon lic-act-feat-icon-emerald"><SafetyOutlined /></span>
              <div>
                <strong>Yours forever</strong>
                <span>Your data stays on this machine. No subscription lock-in.</span>
              </div>
            </li>
          </ul>

          <footer className="lic-act-footnote">
            <LockOutlined /> Need help? Call your vendor with the Machine ID on the right.
          </footer>
        </div>
      </aside>

      {/* RIGHT — activation form */}
      <main className="lic-act-form-wrap">
        <div className="lic-act-form-shell">
          <div className="lic-act-form-card">
            <div className="lic-act-form-head">
              <div className="lic-act-step-pill">
                <span className="lic-act-step-pill-num">1</span> Activation
              </div>
              <h2>Activate your license</h2>
              <p>Two ways to do this — pick whichever's easier.</p>
            </div>

            {showStatusAlert && (
              <Alert
                type="warning"
                showIcon
                icon={<ClockCircleFilled />}
                message={statusHeadline(serverStatus.code)}
                description={serverStatus.message || ''}
                style={{ marginBottom: 22, borderRadius: 10 }}
              />
            )}

            {/* Underline tabs */}
            <div className="lic-act-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === 'file'}
                className={`lic-act-tab ${tab === 'file' ? 'is-active' : ''}`}
                onClick={() => setTab('file')}
                type="button"
              >
                <FolderOpenOutlined /> Upload file
              </button>
              <button
                role="tab"
                aria-selected={tab === 'paste'}
                className={`lic-act-tab ${tab === 'paste' ? 'is-active' : ''}`}
                onClick={() => setTab('paste')}
                type="button"
              >
                <FileTextOutlined /> Paste contents
              </button>
            </div>

            {tab === 'file' && (
              <div className="lic-act-panel">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".dat,application/json,application/octet-stream,text/plain"
                  onChange={onFile}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  className={`lic-act-dropzone ${dragOver ? 'is-drag' : ''} ${busy ? 'is-busy' : ''}`}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  disabled={busy}
                >
                  <div className="lic-act-dz-icon-wrap">
                    <CloudUploadOutlined />
                  </div>
                  <div className="lic-act-dz-title">
                    {busy ? 'Activating…' : (dragOver ? 'Drop to activate' : 'Drop your license file here')}
                  </div>
                  <div className="lic-act-dz-sub">
                    or <span className="lic-act-dz-link">click to browse</span>
                  </div>
                  <div className="lic-act-dz-hint">
                    Usually named like <code>C-2026-0042-2026-05-09.dat</code>
                  </div>
                </button>
              </div>
            )}

            {tab === 'paste' && (
              <div className="lic-act-panel">
                <p className="lic-act-helper-text">
                  Open the .dat file in any text editor, copy <strong>all</strong> of its content, and paste below.
                </p>
                <Input.TextArea
                  rows={8}
                  value={pasteText}
                  onChange={(e) => { setPasteText(e.target.value); setError(''); }}
                  placeholder='{"v":1,"kind":"license-studio.license", ...}'
                  className="lic-act-textarea"
                />
                <Button
                  type="primary"
                  size="large"
                  icon={<CheckCircleFilled />}
                  onClick={() => submitText(pasteText)}
                  loading={busy}
                  block
                  disabled={!pasteText.trim()}
                  className="lic-act-submit"
                >
                  Activate
                </Button>
              </div>
            )}

            {error && (
              <Alert
                type="error"
                showIcon
                message={error}
                style={{ marginTop: 18, borderRadius: 10 }}
              />
            )}

          </div>

          {/* Machine fingerprint — separate elevated card */}
          <div className="lic-act-fp">
            <div className="lic-act-fp-head">
              <div className="lic-act-fp-head-left">
                <div className="lic-act-fp-icon"><KeyOutlined /></div>
                <div>
                  <div className="lic-act-fp-label">Machine ID</div>
                  <div className="lic-act-fp-sub">Read this to your vendor on the phone</div>
                </div>
              </div>
              <button
                type="button"
                className={`lic-act-fp-copy ${fpCopied ? 'is-copied' : ''}`}
                onClick={copyFp}
                disabled={!machineFp}
                title="Copy to clipboard"
              >
                {fpCopied ? <CheckCircleFilled /> : <CopyOutlined />}
                <span>{fpCopied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <div className="lic-act-fp-value" title={machineFp}>
              {fpDisplay}
            </div>
          </div>

          <footer className="lic-act-bottom">
            <span>© {new Date().getFullYear()} Manas Software</span>
            <span className="lic-act-bottom-sep" />
            <span>Need a license? <a href="#" onClick={(e) => e.preventDefault()}>Contact your vendor</a></span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function statusHeadline(code) {
  switch (code) {
    case 'expired':           return 'Your license has expired';
    case 'machine_mismatch':  return 'This license belongs to a different machine';
    case 'clock_tampered':    return 'System clock has been changed';
    case 'invalid_signature': return 'License signature is invalid';
    case 'invalid_format':    return 'License file is corrupted';
    case 'public_key_not_configured': return 'Build is missing the verification key';
    default:                  return 'License problem';
  }
}

const LIC_STYLES = `
.lic-act-page {
  min-height: 100vh;
  width: 100%;
  display: grid;
  grid-template-columns: minmax(380px, 0.9fr) minmax(480px, 1fr);
  background: #f6f7fb;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  color: #0F172A;
}
@media (max-width: 960px) {
  .lic-act-page { grid-template-columns: 1fr; }
  .lic-act-brand { min-height: 320px; }
}

/* =================== BRAND PANEL =================== */
.lic-act-brand {
  position: relative;
  overflow: hidden;
  color: #fff;
  background: linear-gradient(165deg, #0B1120 0%, #0F172A 45%, #1e1b4b 100%);
  display: flex;
  align-items: center;
}
.lic-act-grid {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
  background-size: 56px 56px;
  background-position: -1px -1px;
  mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 30%, transparent 80%);
  -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 30%, transparent 80%);
  pointer-events: none;
}
.lic-act-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  pointer-events: none;
  animation: lic-orb-float 14s ease-in-out infinite;
}
.lic-act-orb-1 {
  width: 480px; height: 480px;
  top: -120px; left: -120px;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.35), transparent 70%);
}
.lic-act-orb-2 {
  width: 420px; height: 420px;
  bottom: -100px; right: -100px;
  background: radial-gradient(circle, rgba(168, 85, 247, 0.25), transparent 70%);
  animation-delay: -7s;
}
@keyframes lic-orb-float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50%      { transform: translate(20px, -20px) scale(1.05); }
}

.lic-act-brand-inner {
  position: relative; z-index: 2;
  padding: 64px 64px 56px;
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  display: flex; flex-direction: column;
  height: 100%;
  animation: lic-fade-in 0.6s ease-out;
}

/* Logo lockup */
.lic-act-logo {
  display: flex; gap: 14px; align-items: center;
  margin-bottom: 80px;
}
.lic-act-logo-mark {
  width: 44px; height: 44px;
  border-radius: 12px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12);
  display: inline-flex; align-items: center; justify-content: center;
  backdrop-filter: blur(8px);
}
.lic-act-wordmark {
  font-size: 24px; font-weight: 800; letter-spacing: -1.2px;
  line-height: 1; color: #fff;
}
.lic-act-tagline {
  font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase;
  color: rgba(255,255,255,0.5); margin-top: 5px; font-weight: 500;
}

/* Hero */
.lic-act-hero { margin-bottom: 56px; }
.lic-act-eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 12px 6px 10px;
  background: rgba(251, 191, 36, 0.12);
  border: 1px solid rgba(251, 191, 36, 0.28);
  border-radius: 100px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  color: #fcd34d;
  margin-bottom: 24px;
}
.lic-act-eyebrow-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #fbbf24;
  box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.2);
  animation: lic-pulse 2s ease-in-out infinite;
}
@keyframes lic-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
.lic-act-hero h1 {
  font-size: 52px; font-weight: 700; line-height: 1.02;
  letter-spacing: -2px; margin: 0 0 18px;
  color: #fff;
}
.lic-act-hero-accent {
  background: linear-gradient(135deg, #a5b4fc 0%, #c4b5fd 50%, #ddd6fe 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.lic-act-hero p {
  font-size: 16px; line-height: 1.6;
  color: rgba(255,255,255,0.68);
  margin: 0;
  max-width: 420px;
}

/* Features */
.lic-act-features {
  list-style: none; padding: 0; margin: 0 0 auto;
  display: flex; flex-direction: column; gap: 20px;
}
.lic-act-features li {
  display: flex; gap: 14px; align-items: flex-start;
}
.lic-act-feat-icon {
  flex: 0 0 44px; height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 12px;
  position: relative;
}
.lic-act-feat-icon .anticon { font-size: 26px; }
.lic-act-feat-icon-indigo {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.18), rgba(99, 102, 241, 0.06));
  border: 1px solid rgba(165, 180, 252, 0.22);
  color: #a5b4fc;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
}
.lic-act-feat-icon-amber {
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.20), rgba(251, 191, 36, 0.06));
  border: 1px solid rgba(252, 211, 77, 0.22);
  color: #fcd34d;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
}
.lic-act-feat-icon-emerald {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.20), rgba(16, 185, 129, 0.06));
  border: 1px solid rgba(110, 231, 183, 0.22);
  color: #6ee7b7;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
}
.lic-act-features strong {
  display: block;
  font-size: 14px; font-weight: 600; color: #fff;
  margin-bottom: 3px;
}
.lic-act-features span {
  display: block;
  font-size: 13px; color: rgba(255,255,255,0.55);
  line-height: 1.5;
}
.lic-act-footnote {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; color: rgba(255,255,255,0.4);
  padding-top: 24px;
  margin-top: 40px;
  border-top: 1px solid rgba(255,255,255,0.08);
}
.lic-act-footnote .anticon { font-size: 13px; }

/* =================== FORM SIDE =================== */
.lic-act-form-wrap {
  display: flex; align-items: center; justify-content: center;
  padding: 48px 40px;
  background:
    radial-gradient(900px 600px at 100% 0%, rgba(99, 102, 241, 0.05), transparent 50%),
    radial-gradient(700px 500px at 0% 100%, rgba(168, 85, 247, 0.04), transparent 55%),
    linear-gradient(180deg, #fbfbfd 0%, #f6f7fb 100%);
  position: relative;
}
.lic-act-form-wrap::before {
  content: '';
  position: absolute; inset: 0;
  background-image: radial-gradient(circle at 1px 1px, rgba(15, 23, 42, 0.04) 1px, transparent 0);
  background-size: 22px 22px;
  mask-image: radial-gradient(ellipse 90% 80% at 50% 50%, #000 20%, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 90% 80% at 50% 50%, #000 20%, transparent 75%);
  pointer-events: none;
}
.lic-act-form-shell {
  width: 100%; max-width: 480px;
  display: flex; flex-direction: column;
  min-height: 100%;
  justify-content: center;
  position: relative; z-index: 1;
}
.lic-act-form-card {
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.06);
  border-radius: 18px;
  padding: 36px 36px 32px;
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.04),
    0 24px 48px -16px rgba(15, 23, 42, 0.10),
    0 8px 16px -8px rgba(15, 23, 42, 0.06);
  animation: lic-slide-up 0.5s 0.1s ease-out backwards;
}

.lic-act-form-head { margin-bottom: 28px; }
.lic-act-step-pill {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: #475569;
  background: #f1f5f9;
  padding: 5px 12px 5px 5px;
  border-radius: 100px;
  margin-bottom: 14px;
}
.lic-act-step-pill-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: #0F172A;
  color: #fff;
  font-size: 11px; font-weight: 700;
  letter-spacing: 0;
}
.lic-act-form-head h2 {
  font-size: 28px; font-weight: 700;
  letter-spacing: -0.7px;
  margin: 0 0 8px; color: #0F172A;
  line-height: 1.15;
}
.lic-act-form-head p {
  font-size: 14px; color: #64748b;
  margin: 0; line-height: 1.5;
}

/* Underline tabs */
.lic-act-tabs {
  display: flex;
  border-bottom: 1px solid #e2e8f0;
  margin-bottom: 24px;
  gap: 24px;
}
.lic-act-tab {
  display: inline-flex; gap: 8px; align-items: center;
  padding: 10px 0 14px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  font-size: 14px; font-weight: 500;
  color: #94a3b8;
  cursor: pointer;
  transition: all 0.18s ease;
  margin-bottom: -1px;
}
.lic-act-tab:hover { color: #475569; }
.lic-act-tab.is-active {
  color: #0F172A;
  border-bottom-color: #0F172A;
}

/* Panel */
.lic-act-panel { animation: lic-fade-in 0.25s ease-out; }

/* Dropzone */
.lic-act-dropzone {
  display: flex; flex-direction: column; align-items: center;
  width: 100%; padding: 44px 24px;
  border: 1.5px dashed #cbd5e1;
  border-radius: 14px;
  background: linear-gradient(180deg, #fafbfc 0%, #f6f8fb 100%);
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
  position: relative;
  overflow: hidden;
}
.lic-act-dropzone::before {
  content: '';
  position: absolute; inset: 0;
  background: radial-gradient(circle at 50% 0%, rgba(99, 102, 241, 0.06), transparent 60%);
  opacity: 0; transition: opacity 0.25s ease;
  pointer-events: none;
}
.lic-act-dropzone:hover:not(:disabled),
.lic-act-dropzone.is-drag {
  border-color: #6366f1;
  background: linear-gradient(180deg, #fff 0%, #fafbff 100%);
  transform: translateY(-1px);
  box-shadow: 0 12px 30px -12px rgba(99, 102, 241, 0.25);
}
.lic-act-dropzone:hover:not(:disabled)::before,
.lic-act-dropzone.is-drag::before { opacity: 1; }
.lic-act-dropzone.is-drag { border-style: solid; }
.lic-act-dropzone:focus-visible {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15);
}
.lic-act-dropzone:disabled { opacity: 0.7; cursor: wait; }
.lic-act-dz-icon-wrap {
  width: 56px; height: 56px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 14px;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  color: #fff;
  font-size: 26px;
  margin-bottom: 16px;
  box-shadow: 0 10px 24px -8px rgba(99, 102, 241, 0.45);
  transition: transform 0.2s ease;
}
.lic-act-dropzone:hover:not(:disabled) .lic-act-dz-icon-wrap,
.lic-act-dropzone.is-drag .lic-act-dz-icon-wrap {
  transform: translateY(-2px) scale(1.04);
}
.lic-act-dz-title {
  font-size: 16px; font-weight: 600; color: #0F172A;
  margin-bottom: 4px;
}
.lic-act-dz-sub {
  font-size: 13px; color: #64748b;
}
.lic-act-dz-link {
  color: #6366f1; font-weight: 500; text-decoration: underline;
  text-underline-offset: 2px;
}
.lic-act-dz-hint {
  font-size: 12px; color: #94a3b8;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e2e8f0;
  width: 100%;
}
.lic-act-dz-hint code {
  background: #f1f5f9;
  padding: 1px 7px; border-radius: 4px;
  font-size: 11.5px;
  color: #0F172A;
  font-family: 'SF Mono', Consolas, monospace;
}

/* Paste tab */
.lic-act-helper-text {
  font-size: 13px; color: #64748b; line-height: 1.55;
  margin: 0 0 14px;
}
.lic-act-helper-text strong {
  color: #334155; font-weight: 600;
}
.lic-act-textarea.ant-input {
  font-family: 'SF Mono', Consolas, monospace !important;
  font-size: 12px !important;
  border-radius: 10px !important;
  border-color: #e2e8f0 !important;
  background: #fafbfc !important;
}
.lic-act-textarea.ant-input:focus,
.lic-act-textarea.ant-input-focused {
  border-color: #6366f1 !important;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12) !important;
  background: #fff !important;
}
.lic-act-submit.ant-btn-primary {
  margin-top: 14px !important;
  height: 48px !important;
  background: linear-gradient(135deg, #0F172A 0%, #1e293b 100%) !important;
  border-color: #0F172A !important;
  border-radius: 10px !important;
  font-weight: 600 !important;
  font-size: 14px !important;
  letter-spacing: 0.01em !important;
  box-shadow: 0 8px 22px -8px rgba(15, 23, 42, 0.5) !important;
  transition: all 0.18s ease !important;
}
.lic-act-submit.ant-btn-primary:hover:not(:disabled) {
  background: linear-gradient(135deg, #1e293b 0%, #334155 100%) !important;
  transform: translateY(-1px);
  box-shadow: 0 12px 28px -8px rgba(15, 23, 42, 0.55) !important;
}
.lic-act-submit.ant-btn-primary:disabled {
  background: #f1f5f9 !important;
  border: 1px solid #e2e8f0 !important;
  color: #94a3b8 !important;
  box-shadow: none !important;
  cursor: not-allowed;
}

/* Machine ID */
.lic-act-fp {
  margin-top: 18px;
  padding: 20px 22px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.06);
  border-radius: 16px;
  box-shadow: 0 4px 12px -4px rgba(15, 23, 42, 0.06);
}
.lic-act-fp-head {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 14px;
  gap: 12px;
}
.lic-act-fp-head-left {
  display: flex; align-items: center; gap: 12px;
}
.lic-act-fp-icon {
  width: 38px; height: 38px;
  border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #0F172A 0%, #334155 100%);
  color: #fff;
  font-size: 18px;
  box-shadow: 0 4px 10px -4px rgba(15, 23, 42, 0.35);
}
.lic-act-fp-label {
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: #334155;
  margin-bottom: 2px;
}
.lic-act-fp-sub {
  font-size: 12px; color: #94a3b8;
  line-height: 1.4;
}
.lic-act-fp-value {
  font-family: ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
  font-size: 13px; font-weight: 500;
  letter-spacing: 0.02em;
  color: #0F172A;
  padding: 14px 12px;
  border-radius: 10px;
  border: 1px dashed #cbd5e1;
  background-color: #fff;
  user-select: all;
  text-align: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: border-color 0.2s ease;
}
.lic-act-fp-value:hover {
  border-style: solid;
  border-color: #94a3b8;
}
.lic-act-fp-copy {
  display: inline-flex; gap: 6px; align-items: center;
  padding: 7px 12px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 12px; font-weight: 500;
  color: #475569;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.lic-act-fp-copy:hover:not(:disabled) {
  border-color: #6366f1;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.04);
}
.lic-act-fp-copy.is-copied {
  border-color: #10b981;
  color: #10b981;
  background: rgba(16, 185, 129, 0.06);
}
.lic-act-fp-copy:disabled { opacity: 0.5; cursor: not-allowed; }

/* Bottom footer */
.lic-act-bottom {
  display: flex; align-items: center; gap: 12px;
  font-size: 12px; color: #94a3b8;
  margin-top: 40px;
  padding-top: 24px;
  border-top: 1px solid #f1f5f9;
}
.lic-act-bottom a {
  color: #475569; text-decoration: none; font-weight: 500;
  border-bottom: 1px dashed #cbd5e1;
}
.lic-act-bottom a:hover { color: #0F172A; border-color: #0F172A; }
.lic-act-bottom-sep {
  width: 3px; height: 3px; border-radius: 50%;
  background: #cbd5e1;
}

@keyframes lic-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes lic-slide-up {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;
