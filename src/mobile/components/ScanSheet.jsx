/* ─────────────────────────────────────────────────────────────────────
 * ScanSheet — split-screen barcode scanning for billing
 *
 * Top half: transparent passthrough — Capacitor MLKit's startScan()
 * mode draws the camera preview straight on the native WebView's
 * background, and we punch a "viewfinder" frame on top for the
 * operator to aim.
 *
 * Bottom half: a solid card showing the LAST scanned product with
 * editable Quantity + Rate and one big Add button. Add commits the
 * line to the bill and clears the card so the next scan can populate
 * it. The camera stays running between scans — no taps to reopen.
 *
 * Native only. The web fallback (browser preview) shows a single
 * "Scanner only works on the device build" message.
 * ─────────────────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
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

  const [draft, setDraft] = useState(null);        // { product_id?, product_name, ... }
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const lastScannedRef = useRef({ code: '', ts: 0 });
  const listenerRef = useRef(null);

  // Start the transparent scanner on mount; stop + clean up on unmount.
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
        // Listen for every barcode the camera resolves.
        listenerRef.current = await BarcodeScanner.addListener('barcodesScanned', (event) => {
          const b = event?.barcodes?.[0];
          const code = b?.rawValue || b?.displayValue;
          if (!code) return;
          // Debounce — MLKit fires the same code many times per second
          // while it stays in frame.
          const now = Date.now();
          if (lastScannedRef.current.code === code && now - lastScannedRef.current.ts < 2500) return;
          lastScannedRef.current = { code, ts: now };
          handleResolve(code);
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

  const handleResolve = async (code) => {
    setBusy(true);
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
    setBusy(false);
    if (!product) {
      // Drop a transient "unknown" card the operator can dismiss.
      setDraft({
        unknown: true,
        product_name: code,
        barcode: code,
        quantity: 1,
        rate: 0,
      });
      return;
    }

    const rate = isPurchase
      ? Number(product.purchase_rate || product.last_purchase_rate || 0)
      : Number(product.sale_rate || 0);
    const qpb = Number(product.quantity_per_box) || 1;
    setDraft({
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
    });
  };

  const setField = (k) => (e) => {
    const v = e?.target ? e.target.value : e;
    setDraft((d) => d && { ...d, [k]: v });
  };

  const lineTotal = (() => {
    if (!draft) return 0;
    const q = Number(draft.quantity) || 0;
    const r = Number(draft.rate) || 0;
    const gst = Number(draft.gst_rate) || 0;
    const gross = q * r;
    return gross + (gross * gst / 100);
  })();

  const canAdd = !!draft && !draft.unknown
    && Number(draft.quantity) > 0
    && Number(draft.rate) >= 0;

  const handleAdd = () => {
    if (!canAdd) return;
    onAdd({
      ...draft,
      quantity: Number(draft.quantity) || 0,
      rate: Number(draft.rate) || 0,
    });
    // Reset for the next scan but keep the camera running.
    setDraft(null);
    lastScannedRef.current = { code: '', ts: 0 };
    Toast.show({
      icon: 'success',
      content: `Added ${draft.product_name}`,
      duration: 800,
    });
  };

  return (
    <div className="ss-root">
      {/* Top half: viewfinder frame, transparent passthrough */}
      <div className="ss-camera">
        <button className="ss-close" onClick={onClose} aria-label="Close scanner">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <div className="ss-frame">
          <span className="ss-corner ss-corner--tl" />
          <span className="ss-corner ss-corner--tr" />
          <span className="ss-corner ss-corner--bl" />
          <span className="ss-corner ss-corner--br" />
          <div className="ss-scanline" />
        </div>
        <div className="ss-hint">
          {error
            ? <span className="ss-hint-error">{error}</span>
            : busy
              ? 'Looking up…'
              : draft
                ? 'Tap Add or scan the next item'
                : 'Aim at a barcode'}
        </div>
      </div>

      {/* Bottom half: product card + Add */}
      <div className="ss-card">
        {!draft && (
          <div className="ss-empty">
            <div className="ss-empty-title">Ready</div>
            <div className="ss-empty-sub">The next scanned item appears here</div>
          </div>
        )}

        {draft && draft.unknown && (
          <div className="ss-unknown">
            <div className="ss-unknown-title">Unknown barcode</div>
            <div className="ss-unknown-code">{draft.barcode}</div>
            <div className="ss-unknown-sub">No product matches this code. Close the scanner and tap Manual to add a new product.</div>
            <button className="ss-unknown-dismiss" onClick={() => setDraft(null)}>Continue scanning</button>
          </div>
        )}

        {draft && !draft.unknown && (
          <>
            <div className="ss-product">
              <div className="ss-product-name">{draft.product_name}</div>
              <div className="ss-product-meta">
                {[
                  draft.size,
                  draft.article_number && `ART-${draft.article_number}`,
                  draft.mrp > 0 && `MRP ₹${formatINR(draft.mrp)}`,
                  draft.gst_rate > 0 && `GST ${draft.gst_rate}%`,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>

            <div className="ss-grid">
              <label className="ss-field">
                <span className="ss-label">Quantity</span>
                <input
                  className="ss-input"
                  type="number"
                  inputMode="decimal"
                  value={draft.quantity}
                  onChange={setField('quantity')}
                />
              </label>
              <label className="ss-field">
                <span className="ss-label">{isPurchase ? 'Purchase rate' : 'Rate'}</span>
                <input
                  className="ss-input"
                  type="number"
                  inputMode="decimal"
                  value={draft.rate}
                  onChange={setField('rate')}
                />
              </label>
            </div>

            <div className="ss-total-row">
              <span className="ss-total-label">Line total</span>
              <span className="ss-total-amt">₹{formatINR(Math.round(lineTotal))}</span>
            </div>

            <button
              className="ss-add"
              onClick={handleAdd}
              disabled={!canAdd}
            >
              Add to bill
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
