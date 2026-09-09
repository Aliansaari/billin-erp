import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { setServerUrl, setDeviceToken } from '../../api';
import './PairSheet.css';
import { controlPlaneUrl } from '../utils/controlPlane';

/**
 * Pair this phone with a shop.
 *
 * The owner turns on Remote Access on the billing PC, which shows a QR. One
 * scan carries everything the phone needs — the shop's public hostname AND a
 * single-use pairing code — so the user never types an IP address or a
 * server URL. That matters: the LAN-IP flow this replaces was the single
 * most error-prone step in setting the app up.
 *
 * QR payload (also accepted as plain text, so any generic scanner works):
 *   https://zehenapp.com/p#c=<CODE>&h=<hostname>
 *
 * The pairing CODE is redeemed at the control plane, not at the shop server,
 * and it is single-use and short-lived. What comes back is a long-lived
 * device token which the shop server checks on every tunnel request.
 */



const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);
const QrIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM19 19h2v2h-2z" />
  </svg>
);

/** Pull { code, host } out of a scanned string, in any of the shapes a QR
 *  reader might hand us. Returns null when it isn't a ZEHEN pairing code. */
export function parsePairPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // Canonical: a URL carrying the fields in the hash fragment.
  const hash = text.includes('#') ? text.slice(text.indexOf('#') + 1) : '';
  if (hash) {
    const q = new URLSearchParams(hash);
    const code = q.get('c') || q.get('code');
    const host = q.get('h') || q.get('host');
    if (code) return { code: code.toUpperCase(), host: host || '' };
  }

  // Bare 8-character code, typed by hand or read from a plain-text QR.
  if (/^[A-Za-z0-9]{6,12}$/.test(text)) return { code: text.toUpperCase(), host: '' };

  return null;
}

export default function PairSheet({ open, onClose, onPaired }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const listenerRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) { setCode(''); setError(''); setBusy(false); }
  }, [open]);

  // Always stop the camera when this unmounts — leaving MLKit running would
  // keep the WebView transparent and the app would look broken.
  useEffect(() => () => { stopScan(); }, []);

  async function stopScan() {
    try {
      if (listenerRef.current) { await listenerRef.current.remove(); listenerRef.current = null; }
      if (Capacitor.isNativePlatform()) {
        const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
        await BarcodeScanner.stopScan();
      }
    } catch { /* nothing to stop */ }
    document.body.classList.remove('pair-scanning');
    setScanning(false);
  }

  async function startScan() {
    if (!Capacitor.isNativePlatform()) {
      setError('Camera scanning needs the installed app. Type the code instead.');
      return;
    }
    setError('');
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      const perm = await BarcodeScanner.requestPermissions();
      if (perm.camera !== 'granted' && perm.camera !== 'limited') {
        setError('Camera permission denied. Type the code instead.');
        return;
      }
      setScanning(true);
      document.body.classList.add('pair-scanning');
      listenerRef.current = await BarcodeScanner.addListener('barcodesScanned', async (event) => {
        const value = event?.barcodes?.[0]?.rawValue;
        const parsed = parsePairPayload(value);
        if (!parsed) return;             // ignore non-ZEHEN codes, keep scanning
        await stopScan();
        submit(parsed.code, parsed.host);
      });
      await BarcodeScanner.startScan();
    } catch (e) {
      await stopScan();
      setError(e?.message || 'Could not start the camera.');
    }
  }

  async function submit(rawCode, host) {
    const parsed = parsePairPayload(rawCode);
    if (!parsed) { setError('That does not look like a pairing code.'); return; }

    setBusy(true); setError('');
    try {
      const res = await fetch(`${controlPlaneUrl()}/v1/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: parsed.code,
          label: 'Phone',
          platform: Capacitor.getPlatform?.() || 'web',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Pairing failed.');

      const hostname = host || parsed.host || body?.site?.hostname;
      if (!hostname) throw new Error('The shop did not return an address.');

      // Order matters: store the device token BEFORE pointing at the server,
      // so the very first request to the new host already carries it and
      // cannot bounce off the tunnel gate.
      setDeviceToken(body.device_token);
      setServerUrl(`https://${hostname}`);

      onPaired?.({ hostname, siteId: body?.site?.site_id });
    } catch (e) {
      setError(e?.message || 'Pairing failed.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return ReactDOM.createPortal(
    <div className="pair-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="pair-dialog" role="dialog" aria-label="Pair this phone">
        <div className="pair-head">
          <span className="pair-head-icon"><QrIcon /></span>
          <div className="pair-head-text">
            <div className="pair-title">Pair this phone</div>
            <div className="pair-sub">On the shop computer, open Settings → Remote Access</div>
          </div>
          <button type="button" className="pair-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <button type="button" className="pair-scan-btn" onClick={startScan} disabled={busy || scanning}>
          {scanning ? 'Scanning… point at the QR' : 'Scan the QR code'}
        </button>

        <div className="pair-or"><span>or enter the code</span></div>

        <input
          ref={inputRef}
          className="pair-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          placeholder="ABCD1234"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck="false"
          inputMode="text"
          maxLength={12}
        />

        {error && <div className="pair-error">{error}</div>}

        <button
          type="button"
          className="pair-submit"
          onClick={() => submit(code, '')}
          disabled={busy || code.length < 6}
        >
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
