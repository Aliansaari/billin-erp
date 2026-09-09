import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { salesAPI, purchaseAPI, paymentAPI, settingsAPI, printAPI } from '../../api';
import { buildBillPdf } from '../../utils/billPdf';
import { formatINR, formatINRWithSymbol, formatShortDate, formatTime } from '../utils/format';
import './BillDetail.css';

const BackIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
);
const MoreIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
);
const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
);
const ShareIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
);
const PrintIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/></svg>
);
const WhatsappIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
);
const ModeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
);
const SendIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
);
const ReceiveIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
);

const TYPE_CONFIG = {
  sales: {
    label:   'Sales Invoice',
    short:   'INV',
    docType: 'sales',
    fetch:   (id) => salesAPI.getById(id),
    nameKey: 'customer_name',
    nameLabel: 'CUSTOMER',
    items:   'items',
    ctaLabel: 'Receive payment',
    ctaIcon: ReceiveIcon,
  },
  purchase: {
    label:   'Purchase Bill',
    short:   'PUR',
    docType: 'purchase',
    fetch:   (id) => purchaseAPI.getById(id),
    nameKey: 'supplier_name',
    nameLabel: 'SUPPLIER',
    items:   'items',
    ctaLabel: 'Make payment',
    ctaIcon: SendIcon,
  },
  receipt: {
    label:   'Receipt Voucher',
    short:   'REC',
    docType: 'receipt',
    fetch:   (id) => paymentAPI.getById(id),
    nameKey: 'party_name',
    nameLabel: 'PARTY',
    items:   null,
    ctaLabel: 'Send to customer',
    ctaIcon: SendIcon,
  },
  payment: {
    label:   'Payment Voucher',
    short:   'PAY',
    docType: 'payment',
    fetch:   (id) => paymentAPI.getById(id),
    nameKey: 'party_name',
    nameLabel: 'PARTY',
    items:   null,
    ctaLabel: 'Send to supplier',
    ctaIcon: SendIcon,
  },
};

let _companyCache = null;
let _companyAt = 0;

async function loadCompany() {
  if (_companyCache && Date.now() - _companyAt < 60_000) return _companyCache;
  try {
    const r = await settingsAPI.getSystem();
    _companyCache = r.data?.data || r.data || {};
    _companyAt = Date.now();
  } catch {
    _companyCache = {};
  }
  return _companyCache;
}

async function loadProfile(docType) {
  try {
    const r = await printAPI.getDefault(docType);
    return r.data?.data || r.data || null;
  } catch {
    return null;
  }
}

function pdfFileName(bill, cfg) {
  const num = bill?.bill_number || bill?.payment_number || bill?.transaction_number || 'doc';
  const party = bill?.[cfg.nameKey] || bill?.party_name || 'Cash';
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  return `${safe(party)}-${safe(num)}.pdf`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function shareViaNative(blob, fileName, title, text) {
  const cap = window.Capacitor;
  const isNative = cap?.isNativePlatform?.();

  if (isNative && cap.nativePromise) {
    try {
      const base64 = await blobToBase64(blob);
      const saved = await cap.nativePromise('Filesystem', 'writeFile', {
        path: fileName, data: base64, directory: 'CACHE',
      });
      await cap.nativePromise('Share', 'share', {
        title, text, url: saved.uri, dialogTitle: title,
      });
      return true;
    } catch (e) {
      if (e?.message?.includes('canceled') || e?.message?.includes('cancel')) return true;
      console.error('Capacitor native bridge share failed', e);
    }
  }

  if (isNative) {
    try {
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([
        import('@capacitor/filesystem'), import('@capacitor/share'),
      ]);
      const base64 = await blobToBase64(blob);
      const saved = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
      await Share.share({ title, text, url: saved.uri, dialogTitle: title });
      return true;
    } catch (e) {
      if (e?.message?.includes('canceled') || e?.message?.includes('cancel')) return true;
      console.error('Capacitor plugin share failed', e);
    }
  }

  try {
    const file = new File([blob], fileName, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title, text, files: [file] });
      return true;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return true;
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch { return false; }
}

export default function BillDetail() {
  const { type, id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const cfg = TYPE_CONFIG[type];

  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfUrl, setPdfUrl] = useState(null);
  const pdfUrlRef = useRef(null);

  useEffect(() => {
    if (!cfg) return;
    let cancelled = false;
    setLoading(true);

    const fetchBill = async () => {
      if (id === 'search') {
        const no = searchParams.get('no');
        if (!no) throw new Error('No voucher number');
        const searchApi = cfg.docType === 'receipt' || cfg.docType === 'payment' ? paymentAPI : (cfg.docType === 'sales' ? salesAPI : purchaseAPI);
        const res = await searchApi.getAll({ search: no, limit: 1 });
        const rows = Array.isArray(res.data) ? res.data : (res.data?.data || []);
        if (rows.length === 0) throw new Error('Voucher not found');

        // The LIST endpoint returns bill summaries with no `items` array, so
        // returning this row directly rendered a bill with no line items and
        // every price as ₹0. Re-fetch the full record by id.
        const found = rows[0];
        const foundId = found.sales_bill_id ?? found.purchase_bill_id
          ?? found.receipt_id ?? found.payment_id ?? found.id;
        if (foundId != null) {
          const full = await cfg.fetch(foundId);
          return full.data?.data || full.data || found;
        }
        return found;
      }
      const res = await cfg.fetch(id);
      return res.data?.data || res.data;
    };

    fetchBill()
      .then((d) => { if (!cancelled) setBill(d); })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || e?.message || 'Failed to load' });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, id, cfg, searchParams]);

  useEffect(() => {
    return () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); };
  }, []);

  const billNumber = bill?.bill_number || bill?.payment_number || bill?.transaction_number || `#${id}`;
  const billDate   = bill?.bill_date || bill?.payment_date || bill?.transaction_date;
  const partyName  = bill?.customer?.party_name || bill?.supplier?.party_name || bill?.party?.party_name || bill?.walk_in_name || bill?.[cfg?.nameKey] || bill?.party_name || 'Cash';
  const total      = Number(bill?.total_amount ?? bill?.amount ?? 0);

  const generatePdf = useCallback(async () => {
    if (!bill || !cfg) return null;
    try {
      const [company, profile] = await Promise.all([loadCompany(), loadProfile(cfg.docType)]);
      return { blob: await buildBillPdf({ docType: cfg.docType, bill, profile: profile || undefined, company, fileName: pdfFileName(bill, cfg) }), fileName: pdfFileName(bill, cfg) };
    } catch (e) { console.error('PDF generation error', e); return null; }
  }, [bill, cfg]);

  const handleViewPdf = useCallback(async () => {
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF generation failed' }); return; }
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(result.blob);
      pdfUrlRef.current = url;
      setPdfUrl(url);
    } finally { setPdfBusy(false); }
  }, [generatePdf]);

  const closePdfViewer = useCallback(() => {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }, []);

  const handleShareFromViewer = useCallback(async () => {
    if (!pdfUrlRef.current) return;
    try {
      const resp = await fetch(pdfUrlRef.current);
      const blob = await resp.blob();
      const ok = await shareViaNative(blob, pdfFileName(bill, cfg), billNumber, `${cfg.label} — ${partyName}`);
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
  }, [bill, cfg, billNumber, partyName]);

  const handleShareSheet = useCallback(async () => {
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF generation failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, billNumber, `${cfg.label} — ${partyName}`);
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }, [generatePdf, billNumber, partyName, cfg]);

  const handleWhatsApp = useCallback(() => {
    const msg = `${cfg.label}: ${billNumber}\nParty: ${partyName}\nAmount: ${formatINRWithSymbol(total)}\nDate: ${billDate ? formatShortDate(billDate) : '—'}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  }, [cfg, billNumber, partyName, total, billDate]);

  if (!cfg) {
    return (
      <div className="bd-screen drill-in">
        <div className="bd-topbar">
          <button className="bd-icon-btn" onClick={() => navigate(-1)}><BackIcon /></button>
        </div>
        <div className="bd-empty">Unknown voucher type</div>
      </div>
    );
  }

  const dueDate     = bill?.due_date;
  const partyObj    = bill?.customer || bill?.supplier || bill?.party || {};
  const partyGstin  = partyObj?.gstin || bill?.party_gstin || bill?.gstin || '';
  const partyAddr   = [partyObj?.address_line_1, partyObj?.city].filter(Boolean).join(', ') || bill?.billing_address || bill?.address || '';
  const partyMobile = partyObj?.mobile_1 || '';
  const partyBalance = partyObj?.current_balance != null ? Number(partyObj.current_balance) : null;
  const items       = cfg.items ? (bill?.[cfg.items] || []) : [];
  const subtotal    = Number(bill?.sub_total ?? bill?.subtotal ?? bill?.taxable_amount ?? total);
  const cgst        = Number(bill?.cgst_amount || 0);
  const sgst        = Number(bill?.sgst_amount || 0);
  const igst        = Number(bill?.igst_amount || 0);
  const cess        = Number(bill?.cess_amount || 0);
  const discount    = Number(bill?.discount_amount || bill?.total_discount || 0);
  const roundOff    = Number(bill?.round_off || 0);
  const balance     = Number(bill?.balance_amount ?? 0);
  const narration   = bill?.remarks || bill?.narration || bill?.notes || '';
  const splits      = bill?.splits || [];
  const billAllocs  = bill?.bill_allocations || [];
  const isPaid      = balance === 0 && total > 0;
  const paymentMode = bill?.payment_method || splits?.[0]?.payment_mode || bill?.payment_mode || '';
  const createdAt   = bill?.created_date || bill?.created_at;
  const createdBy   = bill?.created_by_name || bill?.created_by || '';
  const totalQty    = items.reduce((s, it) => s + Number(it.quantity || 0), 0);
  const CtaIcon     = cfg.ctaIcon;
  const isRecPay    = type === 'receipt' || type === 'payment';

  const statusLabel = type === 'receipt' ? 'Received' : type === 'payment' ? 'Paid' : isPaid ? 'Paid' : balance > 0 ? 'Unpaid' : '—';

  const handleBack = (e) => { e.stopPropagation(); navigate(-1); };

  return (
    <div className={`bd-screen ${type} drill-in`}>

      {/* ── Topbar ──────────────────────────────────── */}
      <div className="bd-topbar">
        <button className="bd-icon-btn" onClick={handleBack} aria-label="Back"><BackIcon /></button>
        <button className="bd-icon-btn more-btn" onClick={handleViewPdf} aria-label="PDF"><MoreIcon /></button>
      </div>

      {loading && <div className="bd-empty">Loading…</div>}
      {!loading && !bill && <div className="bd-empty">Could not load this voucher.</div>}

      {!loading && bill && (
        <>
          {/* ── Doc Header — party + bill# ─────────── */}
          <div className="bd-doc-header">
            <div className="bd-doc-party">
              <div className="bd-doc-party-name">{partyName}</div>
              <div className="bd-doc-party-meta">
                {partyGstin && <>{partyGstin}<br /></>}
                {partyAddr && <>{partyAddr}</>}
                {isRecPay && partyMobile && <>{(partyGstin || partyAddr) && <br />}{partyMobile}</>}
                {!partyGstin && !partyAddr && !partyMobile && <span className="acc">{cfg.nameLabel}</span>}
              </div>
            </div>
            <div className="bd-doc-status">
              <div className={`bd-status-pill ${isPaid && (type === 'sales' || type === 'purchase') ? 'paid' : 'unpaid'}`}>
                <span className="dot" />
                {statusLabel}
              </div>
              <div className="bd-doc-no">{cfg.short} <span className="num">{billNumber.replace(/^(INV|PUR|REC|PAY|#)\s*-?\s*/i, '')}</span></div>
              <div className="bd-doc-date">
                {formatShortDate(billDate)}
                {dueDate && ` · due ${formatShortDate(dueDate)}`}
                {isRecPay && paymentMode && ` · ${paymentMode}`}
              </div>
            </div>
          </div>

          {/* ── Content ────────────────────────────── */}
          <div className="bd-content">

            {/* Payment mode strip (receipt/payment) */}
            {isRecPay && splits.length > 0 && (
              <div className="bd-mode">
                <div className="bd-mode-icon"><ModeIcon /></div>
                <div className="bd-mode-info">
                  <div className="bd-mode-label">{type === 'receipt' ? 'RECEIVED VIA' : 'PAID VIA'}</div>
                  <div className="bd-mode-value">
                    {splits.map((s, i) => (
                      <span key={s.split_id || i}>
                        {i > 0 && ' + '}
                        {s.payment_mode || 'Cash'}
                        {s.bank_name ? ` (${s.bank_name})` : ''}
                        {splits.length > 1 && ` ₹${formatINR(Number(s.amount || 0))}`}
                      </span>
                    ))}
                  </div>
                  {splits.some(s => s.cheque_number || s.upi_transaction_id) && (
                    <div className="bd-mode-ref">
                      {splits.map((s, i) => (
                        <span key={i}>
                          {s.cheque_number && <>Cheque #{s.cheque_number}{s.cheque_date ? ` · ${formatShortDate(s.cheque_date)}` : ''}</>}
                          {s.upi_transaction_id && <>UTR {s.upi_transaction_id}</>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {isRecPay && !splits.length && paymentMode && (
              <div className="bd-mode">
                <div className="bd-mode-icon"><ModeIcon /></div>
                <div className="bd-mode-info">
                  <div className="bd-mode-label">{type === 'receipt' ? 'RECEIVED VIA' : 'PAID VIA'}</div>
                  <div className="bd-mode-value">{paymentMode}</div>
                </div>
              </div>
            )}

            {/* Items section (sales/purchase) */}
            {items.length > 0 && (
              <>
                <div className="bd-sec">
                  <span className="bd-sec-label">Items</span>
                  <span className="bd-sec-meta">{items.length} item{items.length !== 1 ? 's' : ''} · {totalQty} qty</span>
                </div>
                {items.map((it, i) => {
                  const qty = Number(it.quantity || 0);
                  const rate = Number(it.rate || 0);
                  const amt = Number(it.total_amount || it.amount || 0);
                  const hsn = it.hsn_code || '';
                  const size = it.size || '';
                  const unit = it.unit || 'pcs';
                  return (
                    <div key={it.sales_bill_item_id || it.purchase_bill_item_id || i} className="bd-item">
                      <span className="bd-item-num">{String(i + 1).padStart(2, '0')}</span>
                      <div className="bd-item-info">
                        <div className="bd-item-name">{it.product_name || it.description || 'Item'}</div>
                        <div className="bd-item-meta">
                          {hsn && <><span className="hsn">HSN {hsn}</span><span className="dim">·</span></>}
                          {size && <><span className="size">{size}</span><span className="dim">·</span></>}
                          <span className="qty">{qty} {unit}</span>
                          <span className="dim">·</span>
                          ₹{rate.toLocaleString('en-IN')}
                        </div>
                      </div>
                      <div className="bd-item-amount">₹{formatINR(amt)}</div>
                    </div>
                  );
                })}
              </>
            )}

            {/* Applied to bills (receipt/payment) */}
            {isRecPay && billAllocs.length > 0 && (
              <>
                <div className="bd-sec">
                  <span className="bd-sec-label">Applied to bills</span>
                  <span className="bd-sec-meta">{billAllocs.length} bill{billAllocs.length !== 1 ? 's' : ''}</span>
                </div>
                {billAllocs.map((a, i) => (
                  <div key={a.bill_id || i} className="bd-alloc">
                    <div className="bd-alloc-check">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                    </div>
                    <div className="bd-alloc-info">
                      <div className="bd-alloc-name">{a.bill_type || 'Invoice'} {a.bill_number || `#${a.bill_id}`}</div>
                      {a.bill_date && <div className="bd-alloc-meta">{formatShortDate(a.bill_date)}</div>}
                    </div>
                    <div className="bd-alloc-amount">₹{formatINR(Number(a.amount || 0))}</div>
                  </div>
                ))}
              </>
            )}

            {/* Narration */}
            {narration && (
              <div className="bd-notes">
                <div className="bd-notes-text">{narration}</div>
              </div>
            )}

            {/* Trail */}
            {(createdAt || createdBy) && (
              <div className="bd-trail">
                {createdAt ? <>Created <span className="acc">{formatShortDate(createdAt)}{' '}{formatTime(createdAt)}</span></> : 'Created'}
                {createdBy && <> by <span className="acc">{createdBy}</span></>}
              </div>
            )}
          </div>

          {/* ── Sticky Footer — totals + actions ──── */}
          <div className="bd-footer">
            <div className="bd-totals">
              {!isRecPay && subtotal !== total && (
                <div className="bd-total-row">
                  <span className="lbl">Subtotal</span>
                  <span className="val">₹{formatINR(subtotal)}</span>
                </div>
              )}
              {!isRecPay && cgst > 0 && sgst > 0 && (
                <div className="bd-total-row">
                  <span className="lbl">CGST + SGST</span>
                  <span className="val">₹{formatINR(cgst + sgst)}</span>
                </div>
              )}
              {!isRecPay && igst > 0 && (
                <div className="bd-total-row">
                  <span className="lbl">IGST</span>
                  <span className="val">₹{formatINR(igst)}</span>
                </div>
              )}
              {!isRecPay && cess > 0 && (
                <div className="bd-total-row">
                  <span className="lbl">Cess</span>
                  <span className="val">₹{formatINR(cess)}</span>
                </div>
              )}
              {discount > 0 && (
                <div className="bd-total-row discount">
                  <span className="lbl">{isRecPay ? 'Discount given' : 'Discount'}</span>
                  <span className="val">−₹{formatINR(discount)}</span>
                </div>
              )}
              {!isRecPay && roundOff !== 0 && (
                <div className="bd-total-row">
                  <span className="lbl">Round off</span>
                  <span className="val">{roundOff > 0 ? '+' : ''}₹{formatINR(Math.abs(roundOff))}</span>
                </div>
              )}
              <div className="bd-total-row net">
                <span className="lbl">{isRecPay ? (type === 'receipt' ? 'Total received' : 'Total paid') : 'Net total'}</span>
                <span className="val">₹{formatINR(total)}</span>
              </div>
              {isRecPay && partyBalance !== null && (
                <div className="bd-total-row balance">
                  <span className="lbl">{type === 'receipt' ? 'Customer balance' : 'Supplier balance'}</span>
                  <span className={`val ${partyBalance > 0 ? 'receivable' : partyBalance < 0 ? 'payable' : ''}`}>
                    ₹{formatINR(Math.abs(partyBalance))} {partyBalance > 0 ? 'Dr' : partyBalance < 0 ? 'Cr' : ''}
                  </span>
                </div>
              )}
            </div>

            <div className="bd-actions">
              <button className="bd-btn-sq whatsapp" onClick={handleWhatsApp} disabled={!bill} aria-label="WhatsApp"><WhatsappIcon /></button>
              <button className="bd-btn-sq" onClick={handleShareSheet} disabled={pdfBusy || !bill} aria-label="Share"><ShareIcon /></button>
              <button className="bd-btn-sq" onClick={handleViewPdf} disabled={pdfBusy || !bill} aria-label="Print"><PrintIcon /></button>
              <button className="bd-btn-primary" disabled={pdfBusy} onClick={handleShareSheet}>
                {cfg.ctaLabel}
                <CtaIcon />
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── PDF Viewer overlay ────────────────────── */}
      {pdfUrl && (
        <div className="bd-pdf-overlay">
          <div className="bd-pdf-toolbar">
            <button className="bd-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="bd-pdf-title">PDF Preview</span>
            <button className="bd-pdf-share" onClick={handleShareFromViewer} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="bd-pdf-body">
            <iframe
              className="bd-pdf-frame"
              src={pdfUrl}
              title="PDF Preview"
              style={{
                width: '612px',
                minHeight: '792px',
                transform: `scale(${window.innerWidth / 612})`,
                transformOrigin: 'top left',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
