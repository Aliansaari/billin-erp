/* ─────────────────────────────────────────────────────────────────────
 * ScanSheet — split-screen scan-to-list workflow
 *
 * Top half: transparent camera passthrough with a viewfinder frame.
 * MLKit's startScan() draws straight on the WebView background.
 *
 * Bottom half: a running list of items the operator has just
 * scanned. Each scan auto-appends a line (or increments the qty if
 * the same product was already scanned). The operator can adjust
 * the inline quantity or remove rows, then taps one big "Add N
 * to bill" button to commit the whole list. Single round-trip
 * through the camera, single tap to commit.
 *
 * Native only — web fallback shows a "device build" message.
 * ─────────────────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Toast } from 'antd-mobile';
import { Capacitor } from '@capacitor/core';
import { productAPI } from '../../api';
import { formatINR } from '../utils/format';
import './ScanSheet.css';

export default function ScanSheet(props) {
  return ReactDOM.createPortal(<ScanSheetInner {...props} />, document.body);
}

function ScanSheetInner({ type, onAdd, onClose }) {
  const isPurchase = type === 'purchase';

  const [lines, setLines] = useState([]);
  const [lookup, setLookup] = useState(''); // 'looking up <code>' hint
  const [unknownCode, setUnknownCode] = useState(''); // transient flash
  const [error, setError] = useState('');
  const lastScannedRef = useRef({ code: '', ts: 0 });
  const listenerRef = useRef(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      setError('Scanner only works on the device build');
      return;
    }
    let cancelled = false;
    document.body.classList.add('scan-active');

    (async () => {
      try {
        const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
        const supported = await BarcodeScanner.isSupported();
        if (!supported.supported) { setError('Scanner not supported on this device'); return; }
        const perm = await BarcodeScanner.requestPermissions();
        if (perm.camera !== 'granted' && perm.camera !== 'limited') {
          setError('Camera permission denied');
          return;
        }
        if (cancelled) return;
        listenerRef.current = await BarcodeScanner.addListener('barcodesScanned', (event) => {
          const b = event?.barcodes?.[0];
          const code = b?.rawValue || b?.displayValue;
          if (!code) return;
          // Debounce — MLKit fires this many times per second while
          // a code stays in frame. 2.5s gives enough time to move on.
          const now = Date.now();
          if (lastScannedRef.current.code === code && now - lastScannedRef.current.ts < 2500) return;
          lastScannedRef.current = { code, ts: now };
          handleScanned(code);
        });
        await BarcodeScanner.startScan();
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Scanner failed to start');
      }
    })();

    return () => {
      cancelled = true;
      document.body.classList.remove('scan-active');
      (async () => {
        try {
          const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
          await BarcodeScanner.stopScan();
        } catch {}
        try { await listenerRef.current?.remove?.(); } catch {}
        listenerRef.current = null;
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleScanned = async (code) => {
    setLookup(code);
    let product = null;
    try {
      const r = await productAPI.getByBarcode(code);
      product = r.data || null;
    } catch {
      try {
        const r2 = await productAPI.search(code, { limit: 1 });
        const list = Array.isArray(r2.data) ? r2.data : (r2.data?.data || []);
        product = list[0] || null;
      } catch { /* swallow */ }
    }
    setLookup('');

    if (!product) {
      setUnknownCode(code);
      setTimeout(() => setUnknownCode((c) => (c === code ? '' : c)), 1800);
      return;
    }

    const rate = isPurchase
      ? Number(product.purchase_rate || product.last_purchase_rate || 0)
      : Number(product.sale_rate || 0);
    const qpb = Number(product.quantity_per_box) || 1;
    const matchKey = product.product_id || product.id || product.barcode || code;

    setLines((prev) => {
      // If the same product is already in the list, increment qty
      // instead of adding a duplicate row. Wholesalers re-scan to
      // stack box counts.
      const idx = prev.findIndex((l) => l._key === matchKey);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: Number(next[idx].quantity) + qpb };
        return next;
      }
      const line = {
        _key: matchKey,
        product_id: product.product_id || product.id,
        barcode: product.barcode || code,
        product_name: product.product_name || product.name,
        size: product.size_value || '',
        article_number: product.article_number || '',
        hsn_code: product.hsn_code || '',
        gst_rate: Number(product.gst_rate) || 0,
        mrp: Number(product.mrp) || 0,
        unit_type: product.unit_of_measurement || 'Pcs',
        quantity_per_box: qpb,
        quantity: qpb > 1 ? qpb : 1,
        rate,
        discount_percentage: 0,
        category_id: product.category_id || null,
        category_name: product.category_name || '',
      };
      return [...prev, line];
    });
  };

  const setQty = (idx, val) => {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], quantity: Number(val) || 0 };
      return next;
    });
  };

  const bumpQty = (idx, delta) => {
    setLines((prev) => {
      const next = [...prev];
      const q = (Number(next[idx].quantity) || 0) + delta;
      if (q <= 0) return prev.filter((_, i) => i !== idx);
      next[idx] = { ...next[idx], quantity: q };
      return next;
    });
  };

  const removeLine = (idx) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const totals = useMemo(() => {
    let sub = 0, tax = 0;
    for (const l of lines) {
      const q = Number(l.quantity) || 0;
      const r = Number(l.rate) || 0;
      const g = (Number(l.gst_rate) || 0) / 100;
      sub += q * r;
      tax += q * r * g;
    }
    return { sub, tax, net: sub + tax, count: lines.length };
  }, [lines]);

  const handleAddAll = () => {
    if (!lines.length) return;
    for (const l of lines) {
      const { _key, ...clean } = l;
      onAdd(clean);
    }
    Toast.show({
      icon: 'success',
      content: `Added ${lines.length} item${lines.length === 1 ? '' : 's'} to the bill`,
      duration: 1000,
    });
    onClose();
  };

  const hintText = error
    ? null
    : lookup
      ? `Looking up ${lookup}…`
      : unknownCode
        ? `Unknown: ${unknownCode}`
        : lines.length === 0
          ? 'Aim at a barcode'
          : `${lines.length} scanned · keep going`;

  return (
    <div className="ss-root">
      {/* Top half: viewfinder */}
      <div className="ss-camera">
        <button className="ss-close" onClick={onClose} aria-label="Close scanner">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>

        {/* Top-right scan count chip */}
        {lines.length > 0 && (
          <div className="ss-count-chip">
            <span className="ss-count-num">{lines.length}</span>
            <span className="ss-count-lbl">scanned</span>
          </div>
        )}

        <div className="ss-frame">
          <span className="ss-corner ss-corner--tl" />
          <span className="ss-corner ss-corner--tr" />
          <span className="ss-corner ss-corner--bl" />
          <span className="ss-corner ss-corner--br" />
          <div className="ss-scanline" />
        </div>
        <div className={`ss-hint${unknownCode ? ' ss-hint--warn' : ''}`}>
          {error ? <span className="ss-hint-error">{error}</span> : hintText}
        </div>
      </div>

      {/* Bottom half: running scan list */}
      <div className="ss-list-wrap">
        <div className="ss-list">
          {lines.length === 0 && (
            <div className="ss-empty">
              <div className="ss-empty-title">Ready</div>
              <div className="ss-empty-sub">Scanned items appear here</div>
            </div>
          )}

          {lines.map((l, idx) => {
            const q = Number(l.quantity) || 0;
            const r = Number(l.rate) || 0;
            const total = q * r;
            return (
              <div key={l._key + ':' + idx} className="ss-line">
                <div className="ss-line-num">{idx + 1}</div>
                <div className="ss-line-body">
                  <div className="ss-line-name">{l.product_name}</div>
                  <div className="ss-line-meta">
                    {[
                      l.size,
                      l.article_number && `ART-${l.article_number}`,
                      l.mrp > 0 && `MRP ₹${formatINR(l.mrp)}`,
                    ].filter(Boolean).join(' · ') || '—'}
                  </div>
                  <div className="ss-line-qty">
                    <button className="ss-qty-btn" onClick={() => bumpQty(idx, -(l.quantity_per_box || 1))} aria-label="Decrease">−</button>
                    <input
                      className="ss-qty-input"
                      type="number"
                      inputMode="numeric"
                      value={l.quantity}
                      onChange={(e) => setQty(idx, e.target.value)}
                    />
                    <button className="ss-qty-btn" onClick={() => bumpQty(idx, (l.quantity_per_box || 1))} aria-label="Increase">+</button>
                    <span className="ss-line-rate">× ₹{formatINR(r)}</span>
                    <span className="ss-line-total">₹{formatINR(Math.round(total))}</span>
                  </div>
                </div>
                <button className="ss-line-remove" onClick={() => removeLine(idx)} aria-label="Remove">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
            );
          })}
        </div>

        {/* Bottom commit bar — always visible */}
        <div className="ss-commit-bar">
          <div className="ss-commit-summary">
            <span className="ss-commit-label">{totals.count} item{totals.count === 1 ? '' : 's'}</span>
            <span className="ss-commit-amt">₹{formatINR(Math.round(totals.net))}</span>
          </div>
          <button
            className="ss-commit-btn"
            onClick={handleAddAll}
            disabled={!lines.length}
          >
            Add {lines.length ? `${lines.length} ` : ''}to bill
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
