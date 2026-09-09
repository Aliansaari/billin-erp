import React, { useEffect, useRef, useState } from 'react';
import './ServerDialog.css';

// Hidden server-config dialog. Revealed by tapping the wordmark 3× on the
// login screen (or auto-opened on a fresh install that can't reach a server).
//
// Anchored in the UPPER-MIDDLE of the viewport so the iOS soft keyboard —
// which overlays the bottom ~45% without resizing the webview
// (Keyboard.resize='none') — never covers the input or the Connect button.
//
// Controlled component:
//   open            — boolean, mount the dialog
//   initialUrl      — pre-fill value (last saved server, no /api suffix)
//   onConnect(url)  — async; resolves on success, throws on failure. The
//                     parent owns the actual fetch + persistence.
//   onClose()       — fired on cancel / scrim tap / after a successful connect

const ServerIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);
const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);
const BoltIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L3 14h7l-1 8 10-12h-7z" />
  </svg>
);
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

// Turn whatever the user typed into a canonical origin:
//   "192.168.1.50"            → "http://192.168.1.50:3001"
//   "192.168.1.50:4000"       → "http://192.168.1.50:4000"
//   "http://192.168.1.50"     → "http://192.168.1.50:3001"
//   "https://shop.local/api/" → "https://shop.local:3001/api"
// Returns '' for empty input.
export function normalizeServerUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return '';
  s = s.replace(/\/+$/, '');                       // drop trailing slashes
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s; // default scheme
  const m = s.match(/^(https?:\/\/)([^/]+)(\/.*)?$/i);
  if (!m) return s;
  let [, scheme, host, rest = ''] = m;
  if (!/:\d+$/.test(host)) host += ':3001';        // default port
  return scheme + host + rest;
}

function humanizeError(e) {
  const msg = (e && e.message) || String(e || 'Unknown error');
  if (/HTTP 4\d\d/.test(msg)) return `Reached the address but it answered ${msg.replace('HTTP ', '')} — check the IP and port.`;
  if (/HTTP 5\d\d/.test(msg)) return `Server is up but errored (${msg.replace('HTTP ', '')}). Try again in a moment.`;
  if (/Failed to fetch|NetworkError|Load failed|timeout|timed out|ECONN|reach|connection/i.test(msg))
    return 'Can’t reach that address. Check the IP and port, and make sure your Mac and phone are on the same Wi‑Fi.';
  return msg;
}

export default function ServerDialog({ open, initialUrl, onConnect, onClose, onPair }) {
  const [raw, setRaw] = useState(initialUrl || '');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const inputRef = useRef(null);

  // Reset state + lift the keyboard each time the dialog opens. Focus is
  // deferred until the open animation settles so the field is already in
  // its final (keyboard-safe) position when the keyboard rises.
  useEffect(() => {
    if (!open) return;
    setRaw(initialUrl || '');
    setError('');
    setOk(false);
    setConnecting(false);
    const t = setTimeout(() => inputRef.current?.focus(), 260);
    return () => clearTimeout(t);
  }, [open, initialUrl]);

  // Freeze the login form behind the scrim.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const normalized = normalizeServerUrl(raw);
  const showPreview = !!normalized && normalized !== raw.trim() && !error && !ok;
  const canConnect = !!normalized && !connecting && !ok;

  async function handleConnect() {
    const url = normalizeServerUrl(raw);
    if (!url || connecting || ok) return;
    setConnecting(true);
    setError('');
    try {
      await onConnect(url);
      setOk(true);
      setTimeout(() => onClose(), 480); // let the success tick read before dismissing
    } catch (e) {
      setError(humanizeError(e));
      setConnecting(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); handleConnect(); }
  }

  return (
    <>
      <div className="sd-scrim" onClick={connecting || ok ? undefined : onClose} aria-hidden />
      <div className="sd-wrap">
        <div className="sd-card" role="dialog" aria-modal="true" aria-label="Connect to server">
          <div className="sd-head">
            <span className="sd-badge"><ServerIcon /></span>
            <div className="sd-head-text">
              <div className="sd-title">Connect to server</div>
              <div className="sd-sub">Enter your Mac’s LAN address</div>
            </div>
            <button type="button" className="sd-x" onClick={onClose} aria-label="Close" disabled={connecting || ok}>
              <CloseIcon />
            </button>
          </div>

          <label className={`sd-input${error ? ' err' : ''}${ok ? ' ok' : ''}`}>
            <input
              ref={inputRef}
              className="sd-input-text"
              type="text"
              inputMode="url"
              enterKeyHint="go"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck="false"
              placeholder="192.168.1.50"
              value={raw}
              onChange={(e) => { setRaw(e.target.value); setError(''); }}
              onKeyDown={onKeyDown}
              disabled={ok}
            />
            {raw && !connecting && !ok && (
              <button type="button" className="sd-clear" onClick={() => { setRaw(''); setError(''); inputRef.current?.focus(); }} aria-label="Clear">
                <CloseIcon />
              </button>
            )}
          </label>

          {showPreview && (
            <div className="sd-preview">
              <BoltIcon />
              <span>Connecting to <strong>{normalized}</strong></span>
            </div>
          )}
          {error && <div className="sd-error">{error}</div>}
          {!showPreview && !error && (
            <div className="sd-tip">Tip: just type the IP — we’ll add <code>http://</code> and <code>:3001</code> for you.</div>
          )}

          {/* A LAN address only works on the shop's own Wi-Fi. Pairing works
              from anywhere and needs no typing, so offer it here rather than
              leaving it to be discovered. */}
          {onPair && !connecting && !ok && (
            <button type="button" className="sd-pair-link" onClick={onPair}>
              Away from the shop? Pair with a QR code instead
            </button>
          )}

          <div className="sd-actions">
            <button type="button" className="sd-cancel" onClick={onClose} disabled={connecting || ok}>
              Cancel
            </button>
            <button type="button" className={`sd-connect${ok ? ' ok' : ''}`} onClick={handleConnect} disabled={!canConnect}>
              {connecting ? <span className="sd-spin" />
                : ok ? (<><CheckIcon /> Connected</>)
                : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
