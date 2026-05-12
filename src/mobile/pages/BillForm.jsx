/* ─────────────────────────────────────────────────────────────────────
 * BillForm — shared mobile form for /sale/new and /purchase/new
 *
 * Per the editorial mockup: customer/supplier at top, scan-first item
 * entry, items as cards, sticky net total at the bottom. The `type`
 * prop ('sale' | 'purchase') switches party label, item-variant line,
 * totals labels, and the create endpoint — same skeleton otherwise.
 * ─────────────────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { Capacitor } from '@capacitor/core';
import { salesAPI, purchaseAPI, productAPI, godownAPI } from '../../api';
import { formatINR } from '../utils/format';
import PartySheet from '../components/PartySheet';
import ItemSheet from '../components/ItemSheet';
import MoreSheet from '../components/MoreSheet';
import './BillForm.css';

const BackIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5M12 19l-7-7 7-7"/>
  </svg>
);
const MoreIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
  </svg>
);
const ChevR = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
);
const ScanIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>
    <path d="M7 12h10" strokeWidth="2.5"/>
  </svg>
);
const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
);
const ArrowRight = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
);

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

export default function BillForm({ type }) {
  const navigate = useNavigate();
  const isPurchase = type === 'purchase';
  const partyLabel = isPurchase ? 'Supplier' : 'Customer';

  const [party, setParty]           = useState(null);
  const [items, setItems]           = useState([]);
  const [godownId, setGodownId]     = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [paidAmount, setPaidAmount] = useState('');  // empty = pay full
  const [moreOpts, setMoreOpts]     = useState({
    sale_type: 'Retail',
    salesman_name: '',
    due_date: '',
    remarks: '',
  });
  const [partyOpen, setPartyOpen]   = useState(false);
  const [itemOpen, setItemOpen]     = useState(false);
  const [moreOpen, setMoreOpen]     = useState(false);
  const [editingIdx, setEditingIdx] = useState(-1);
  const [saving, setSaving]         = useState(false);
  const billDate = todayISO();

  // Fetch a default godown — we use the first one we can find. Users
  // change it from the ⋯ menu (later); for now the form just needs a
  // valid godown_id to satisfy the server contract.
  useEffect(() => {
    godownAPI.getAll({ limit: 5 })
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : (r.data?.data || []);
        const first = list[0];
        if (first) setGodownId(first.godown_id || first.id);
      })
      .catch(() => { /* leave null — save will surface a clear server error */ });
  }, []);

  // Lift the sticky totals above the soft keyboard. Capacitor is
  // configured with resize:'none' so neither the WebView nor the
  // visualViewport reflows when the iOS keyboard appears — the
  // visualViewport API stays put. The reliable source on native is
  // the Capacitor Keyboard plugin's keyboardWillShow event, which
  // reports the exact keyboard height. visualViewport is the web
  // fallback for the browser preview.
  useEffect(() => {
    const root = document.documentElement;
    const setKbd = (px) => root.style.setProperty('--bf-kbd-h', `${Math.max(0, px)}px`);
    let cleanup = () => {};

    if (Capacitor.isNativePlatform()) {
      let showH = null, hideH = null;
      import('@capacitor/keyboard').then(({ Keyboard }) => {
        Keyboard.addListener('keyboardWillShow', (info) => setKbd(info.keyboardHeight))
          .then((h) => { showH = h; });
        Keyboard.addListener('keyboardWillHide', () => setKbd(0))
          .then((h) => { hideH = h; });
      }).catch(() => {});
      cleanup = () => {
        showH?.remove?.();
        hideH?.remove?.();
        setKbd(0);
      };
    } else if (window.visualViewport) {
      const vv = window.visualViewport;
      const apply = () => setKbd(window.innerHeight - vv.height - vv.offsetTop);
      apply();
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      cleanup = () => {
        vv.removeEventListener('resize', apply);
        vv.removeEventListener('scroll', apply);
        setKbd(0);
      };
    }
    return cleanup;
  }, []);

  // Totals — naive product-mode calc that matches the desktop math for
  // the simple case (no inter-state, no inline returns). Each item ships
  // its own gst_rate; subtotal sums (qty × rate − line discount); tax
  // sums (taxable × gst_rate / 100).
  const totals = useMemo(() => {
    let sub = 0, tax = 0, disc = 0, qty = 0;
    for (const it of items) {
      const q = Number(it.quantity) || 0;
      const r = Number(it.rate) || 0;
      const gross = q * r;
      const lineDisc = (Number(it.discount_percentage) || 0) * gross / 100;
      const taxable = gross - lineDisc;
      const t = taxable * (Number(it.gst_rate) || 0) / 100;
      sub += gross;
      disc += lineDisc;
      tax += t;
      qty += q;
    }
    const net = sub - disc + tax;
    return { sub, disc, tax, qty, net };
  }, [items]);

  const handleAddItem = (item) => {
    setItems((prev) => {
      if (editingIdx >= 0) {
        const next = [...prev];
        next[editingIdx] = item;
        return next;
      }
      return [...prev, item];
    });
    setItemOpen(false);
    setEditingIdx(-1);
  };

  const handleRemoveItem = (idx) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleEditItem = (idx) => {
    setEditingIdx(idx);
    setItemOpen(true);
  };

  const handleScan = async () => {
    if (!Capacitor.isNativePlatform()) {
      Toast.show({ icon: 'fail', content: 'Scanner only works on the device build' });
      return;
    }
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      const supported = await BarcodeScanner.isSupported();
      if (!supported.supported) {
        Toast.show({ icon: 'fail', content: 'Scanner not supported' });
        return;
      }
      const perm = await BarcodeScanner.requestPermissions();
      if (perm.camera !== 'granted' && perm.camera !== 'limited') {
        Toast.show({ icon: 'fail', content: 'Camera permission denied' });
        return;
      }
      const result = await BarcodeScanner.scan();
      const code = result?.barcodes?.[0]?.rawValue || result?.barcodes?.[0]?.displayValue;
      if (!code) {
        Toast.show({ content: 'No barcode detected' });
        return;
      }
      // Try server lookup first; fall back to local search.
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
      if (product) {
        // Auto-add at one full box (qpb pieces) if the product is
        // box-tracked; otherwise 1 pc. Wholesalers scan to add a box,
        // not a single piece — they'd lose minutes editing every scan.
        const rate = isPurchase
          ? Number(product.purchase_rate || product.last_purchase_rate || 0)
          : Number(product.sale_rate || 0);
        const qpb = Number(product.quantity_per_box) || 1;
        const qty = qpb > 1 ? qpb : 1;
        setItems((prev) => [...prev, {
          product_id: product.product_id || product.id,
          barcode: product.barcode || code,
          product_name: product.product_name || product.name,
          hsn_code: product.hsn_code || '',
          gst_rate: Number(product.gst_rate) || 0,
          unit_type: product.unit_of_measurement || 'Pcs',
          quantity_per_box: qpb,
          quantity: qty,
          rate,
          mrp: Number(product.mrp) || 0,
          discount_percentage: 0,
          size: product.size_value || '',
          article_number: product.article_number || '',
          category_id: product.category_id || null,
          category_name: product.category_name || '',
        }]);
        Toast.show({
          icon: 'success',
          content: qpb > 1
            ? `Added ${product.product_name} — 1 box (${qpb} pcs)`
            : `Added ${product.product_name}`,
        });
      } else {
        // Open the manual sheet pre-filled so the user can complete the row
        setEditingIdx(-1);
        setItemOpen({ barcode: code });
      }
    } catch (e) {
      const msg = e?.message || 'Scan failed';
      if (!/cancel/i.test(msg)) {
        Toast.show({ icon: 'fail', content: msg });
      }
    }
  };

  const handleSave = async () => {
    if (saving) return;
    if (!items.length) {
      Toast.show({ icon: 'fail', content: 'Add at least one item' });
      return;
    }
    if (!godownId) {
      Toast.show({ icon: 'fail', content: 'No godown configured. Set one up first.' });
      return;
    }

    const partyField = isPurchase
      ? { supplier_id: party?.party_id || null }
      : { customer_id: party?.party_id || null, walk_in_name: party ? null : 'Walk-in' };

    // Default behaviour: empty field = pay full bill (Save & pay).
    // Number = partial payment. Zero = save unpaid (credit).
    const paidNum = paidAmount === '' ? totals.net : (Number(paidAmount) || 0);

    // Purchase items carry MRP / sale_rate / margin and ship the unit
    // cost under `purchase_rate` (server contract). Sale items use the
    // simpler shape — rate is the selling price.
    const items_payload = isPurchase
      ? items.map((i) => ({
          product_id: i.product_id || null,
          barcode: i.barcode || '',
          category_id: i.category_id || null,
          category_name: i.category_name || '',
          product_name: i.product_name,
          size: i.size || '',
          article_number: i.article_number || '',
          hsn_code: i.hsn_code || '',
          quantity: Number(i.quantity) || 0,
          quantity_per_box: Number(i.quantity_per_box) || 1,
          purchase_rate: Number(i.rate) || 0,
          margin_percentage: Number(i.margin_percentage) || 0,
          sale_rate: Number(i.sale_rate) || 0,
          mrp: Number(i.mrp) || 0,
          gst_rate: Number(i.gst_rate) || 0,
        }))
      : items.map((i) => ({
          product_id: i.product_id || null,
          barcode: i.barcode || '',
          category_id: i.category_id || null,
          category_name: i.category_name || '',
          product_name: i.product_name,
          size: i.size || '',
          article_number: i.article_number || '',
          hsn_code: i.hsn_code || '',
          unit_type: i.unit_type || 'Pcs',
          quantity: Number(i.quantity) || 0,
          rate: Number(i.rate) || 0,
          mrp: Number(i.mrp) || 0,
          discount_percentage: Number(i.discount_percentage) || 0,
          gst_rate: Number(i.gst_rate) || 0,
          quantity_per_box: Number(i.quantity_per_box) || 1,
        }));

    const body = {
      godown_id: godownId,
      ...partyField,
      bill_date: billDate,
      due_date: moreOpts.due_date || undefined,
      sale_type: moreOpts.sale_type || 'Retail',
      salesman_name: moreOpts.salesman_name || '',
      payment_method: isPurchase ? 'Credit' : paymentMethod,
      remarks: (moreOpts.remarks || '').trim(),
      gst_mode: 'product',
      bill_mode: 'items',
      cgst_pct: 0, sgst_pct: 0, igst_pct: 0,
      discount_percentage: 0,
      discount_amount: 0,
      other_charges: 0,
      freight_charges: 0,
      special_discount: 0,
      return_amount: 0,
      paid_amount: isPurchase ? 0 : paidNum,
      // Purchase-only: supplier bill #, transport, vehicle, LR. Sale
      // ignores these — the desktop sale form doesn't carry them either.
      ...(isPurchase && {
        supplier_bill_number: moreOpts.supplier_bill_number || '',
        transport_name: moreOpts.transport_name || '',
        vehicle_number: moreOpts.vehicle_number || '',
        lr_number: moreOpts.lr_number || '',
      }),
      items: items_payload,
    };

    setSaving(true);
    try {
      const res = isPurchase
        ? await purchaseAPI.create(body)
        : await salesAPI.create(body);
      const savedId = res.data?.bill_id || res.data?.id || res.data?.sales_bill_id || res.data?.purchase_bill_id;
      Toast.show({ icon: 'success', content: 'Saved' });
      if (savedId) {
        navigate(`/vouchers/${isPurchase ? 'purchase' : 'sales'}/${savedId}`, { replace: true });
      } else {
        navigate('/vouchers', { replace: true });
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Save failed';
      Toast.show({ icon: 'fail', content: msg });
    } finally {
      setSaving(false);
    }
  };

  const editingItem = editingIdx >= 0 ? items[editingIdx] : null;
  const sheetPrefill = (itemOpen && typeof itemOpen === 'object') ? itemOpen : null;

  return (
    <div className="bf-screen">
      <div className="bf-header">
        <button className="bf-icon-btn" onClick={() => navigate(-1)} aria-label="Back">
          <BackIcon />
        </button>
        <div className="bf-title-block">
          <h1 className="bf-title">New <em>{isPurchase ? 'purchase' : 'sale'}</em></h1>
          <div className="bf-meta">{fmtShortDate(billDate)} · {isPurchase ? 'Inward' : moreOpts.sale_type}</div>
        </div>
        <button className="bf-icon-btn" onClick={() => setMoreOpen(true)} aria-label="More">
          <MoreIcon />
        </button>
      </div>

      <div className="bf-content">
        {/* Party card */}
        <button
          className="bf-party"
          onClick={() => setPartyOpen(true)}
        >
          <div className={`bf-party-avatar ${isPurchase ? 'supplier' : 'customer'}`}>
            {party ? (party.party_name || 'P').charAt(0).toUpperCase() : (isPurchase ? 'S' : 'C')}
          </div>
          <div className="bf-party-info">
            <div className="bf-party-label">{partyLabel}</div>
            <div className="bf-party-name">
              {party ? party.party_name : `Tap to choose ${partyLabel.toLowerCase()}`}
            </div>
            <div className="bf-party-meta">
              {party ? [party.gstin, party.city].filter(Boolean).join(' · ') : 'Walk-in / cash'}
            </div>
            {party && (() => {
              const bal = Number(party.current_balance) || 0;
              const limit = Number(party.credit_limit) || 0;
              const limitOk = !!party.credit_allowed && limit > 0;
              const overLimit = limitOk && bal > limit;
              const bits = [];
              if (bal !== 0) bits.push(`Bal ₹${Math.abs(bal).toLocaleString('en-IN')} ${bal > 0 ? 'DR' : 'CR'}`);
              if (limitOk) bits.push(`Limit ₹${limit.toLocaleString('en-IN')}`);
              if (party.credit_days) bits.push(`${party.credit_days}d`);
              return bits.length ? (
                <div className={`bf-party-credit${overLimit ? ' over' : ''}`}>
                  {bits.join(' · ')}{overLimit ? ' · over limit' : ''}
                </div>
              ) : null;
            })()}
          </div>
          <div className="bf-party-chev"><ChevR /></div>
        </button>

        {/* Transport row — purchase only. Single tappable strip that
            opens the More sheet (where the four paperwork fields live). */}
        {isPurchase && (
          <button className="bf-transport" onClick={() => setMoreOpen(true)}>
            <span className="bf-transport-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/>
                <circle cx="5.5" cy="18.5" r="2.5"/>
                <circle cx="18.5" cy="18.5" r="2.5"/>
              </svg>
            </span>
            <span className="bf-transport-text">
              {(() => {
                const bits = [
                  moreOpts.supplier_bill_number && `Bill ${moreOpts.supplier_bill_number}`,
                  moreOpts.vehicle_number,
                  moreOpts.lr_number && `LR ${moreOpts.lr_number}`,
                  moreOpts.transport_name,
                ].filter(Boolean);
                return bits.length
                  ? bits.join(' · ')
                  : <span className="bf-transport-placeholder">Tap to add bill #, vehicle, LR…</span>;
              })()}
            </span>
            <ChevR />
          </button>
        )}

        {/* Items header */}
        <div className="bf-items-head">
          <span className="bf-items-label">Items <span className="acc">· {items.length}</span></span>
          <span className="bf-items-meta">Qty {totals.qty}</span>
        </div>

        {/* Scan + Manual */}
        <div className="bf-add-row">
          <button className="bf-scan-btn" onClick={handleScan}>
            <ScanIcon />
            Scan barcode
          </button>
          <button className="bf-manual-btn" onClick={() => { setEditingIdx(-1); setItemOpen(true); }}>
            <PlusIcon />
            Manual
          </button>
        </div>

        {/* Items list */}
        <div className="bf-items">
          {items.map((it, idx) => {
            const q = Number(it.quantity) || 0;
            const r = Number(it.rate) || 0;
            const gross = q * r;
            const lineDisc = (Number(it.discount_percentage) || 0) * gross / 100;
            const lineTotal = gross - lineDisc;
            const variant = isPurchase
              ? [
                  it.size,
                  it.article_number && `ART-${it.article_number}`,
                  it.mrp > 0 && `MRP ₹${formatINR(it.mrp)}`,
                  Number(it.margin_percentage) ? `MG ${Number(it.margin_percentage).toFixed(0)}%` : null,
                ].filter(Boolean).join(' · ')
              : [it.size, it.article_number && `ART-${it.article_number}`, it.gst_rate > 0 && `GST ${it.gst_rate}%`].filter(Boolean).join(' · ');
            return (
              <div key={idx} className="bf-item" onClick={() => handleEditItem(idx)}>
                <div className="bf-item-num">{idx + 1}</div>
                <div className="bf-item-body">
                  <div className="bf-item-row1">
                    <div className="bf-item-name">{it.product_name}</div>
                    <div className="bf-item-amt">
                      <span className="cur">₹</span>{formatINR(Math.round(lineTotal))}
                    </div>
                  </div>
                  {variant && <div className="bf-item-variant">{variant}</div>}
                  <div className="bf-item-rate">
                    <span className="strong">{q} {it.unit_type || 'pcs'}</span> × ₹{formatINR(r)}
                    {lineDisc > 0 && <> · −₹{formatINR(lineDisc)}</>}
                  </div>
                </div>
                <button
                  className="bf-item-remove"
                  onClick={(e) => { e.stopPropagation(); handleRemoveItem(idx); }}
                  aria-label="Remove"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="bf-empty">Tap <strong>Scan</strong> or <strong>Manual</strong> to add items</div>
          )}
        </div>
      </div>

      {/* Sticky totals */}
      <div className="bf-totals">
        <div className="bf-totals-handle"></div>
        <div className="bf-totals-row">
          <div>
            <div className="bf-totals-label">{isPurchase ? 'Net payable' : 'Net total'}</div>
            <div className="bf-totals-amt">
              <span className="cur">₹</span>{formatINR(Math.floor(totals.net))}
              <em>.{String(Math.round((totals.net % 1) * 100)).padStart(2, '0')}</em>
            </div>
          </div>
          <div className="bf-totals-breakdown">
            <div>Sub <span className="strong">₹{formatINR(totals.sub)}</span></div>
            <div>GST <span className="strong">₹{formatINR(totals.tax)}</span></div>
            {!isPurchase && totals.disc > 0 && (
              <div>Disc <span className="strong">−₹{formatINR(totals.disc)}</span></div>
            )}
            {isPurchase && (() => {
              // Avg margin = total profit / total cost × 100, weighted
              // by line value. Mirrors the desktop's bottom-panel pill.
              let cost = 0, profit = 0;
              for (const it of items) {
                const q = Number(it.quantity) || 0;
                const pr = Number(it.rate) || 0;
                const sr = Number(it.sale_rate) || 0;
                cost += q * pr;
                if (sr > 0) profit += q * (sr - pr);
              }
              if (cost <= 0) return null;
              const avgMg = (profit / cost) * 100;
              return <div>Avg MG <span className="strong">{avgMg.toFixed(0)}%</span></div>;
            })()}
          </div>
        </div>
        <div className="bf-totals-sub">
          <span>Items <span className="strong">{items.length}</span> · Qty <span className="strong">{totals.qty}</span></span>
          <span>{isPurchase
            ? `Due ${moreOpts.due_date ? fmtShortDate(moreOpts.due_date) : '—'}`
            : `Mode ${paymentMethod}`}</span>
        </div>

        {/* Sale: payment-mode chips + paid amount; Purchase skips this */}
        {!isPurchase && (
          <div className="bf-pay">
            <div className="bf-pay-chips">
              {['Cash', 'UPI', 'Card', 'Credit'].map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`bf-pay-chip${paymentMethod === m ? ' active' : ''}`}
                  onClick={() => setPaymentMethod(m)}
                >{m}</button>
              ))}
            </div>
            <div className="bf-pay-amt">
              <span className="bf-pay-amt-lbl">Paid</span>
              <input
                className="bf-pay-amt-input"
                type="number"
                inputMode="decimal"
                placeholder={totals.net > 0 ? `Full ₹${formatINR(Math.round(totals.net))}` : '0'}
                value={paidAmount}
                onChange={(e) => setPaidAmount(e.target.value)}
                onFocus={(e) => {
                  // iOS soft keyboard slides over the bottom — the
                  // Paid field then sits under the keyboard. Scroll
                  // it (with the rest of the totals) into view a beat
                  // after the keyboard finishes animating in.
                  setTimeout(() => {
                    e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  }, 250);
                }}
              />
              {paidAmount !== '' && Number(paidAmount) < totals.net && (
                <span className="bf-pay-balance">Balance ₹{formatINR(Math.max(0, totals.net - Number(paidAmount)))}</span>
              )}
            </div>
          </div>
        )}
        <div className="bf-actions">
          <button className="bf-btn-secondary" onClick={() => navigate(-1)} disabled={saving}>
            Cancel
          </button>
          <button className="bf-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : (isPurchase ? 'Save bill' : 'Save & pay')}
            <ArrowRight />
          </button>
        </div>
      </div>

      {partyOpen && (
        <PartySheet
          type={isPurchase ? 'supplier' : 'customer'}
          onClose={() => setPartyOpen(false)}
          onPick={(p) => { setParty(p); setPartyOpen(false); }}
        />
      )}

      {itemOpen && (
        <ItemSheet
          type={type}
          initial={editingItem || sheetPrefill}
          onClose={() => { setItemOpen(false); setEditingIdx(-1); }}
          onSave={handleAddItem}
        />
      )}

      {moreOpen && (
        <MoreSheet
          type={type}
          values={moreOpts}
          onClose={() => setMoreOpen(false)}
          onSave={(v) => { setMoreOpts(v); setMoreOpen(false); }}
        />
      )}
    </div>
  );
}
