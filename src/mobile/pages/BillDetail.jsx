import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { salesAPI, purchaseAPI, paymentAPI, settingsAPI, printAPI } from '../../api';
import { buildBillPdf } from '../../utils/billPdf';
import { formatINRWithSymbol, formatShortDate } from '../utils/format';
import './BillDetail.css';

const ChevL = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
);
const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
);
const PdfIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
);
const ShareIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
);
const WhatsappIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>
  </svg>
);

const TYPE_CONFIG = {
  sales: {
    label:   'Sales Invoice',
    short:   'Sales',
    docType: 'sales',
    fetch:   (id) => salesAPI.getById(id),
    nameKey: 'customer_name',
    nameLabel: 'CUSTOMER',
    items:   'items',
  },
  purchase: {
    label:   'Purchase Bill',
    short:   'Purchase',
    docType: 'purchase',
    fetch:   (id) => purchaseAPI.getById(id),
    nameKey: 'supplier_name',
    nameLabel: 'SUPPLIER',
    items:   'items',
  },
  receipt: {
    label:   'Receipt Voucher',
    short:   'Receipt',
    docType: 'receipt',
    fetch:   (id) => paymentAPI.getById(id),
    nameKey: 'party_name',
    nameLabel: 'PARTY',
    items:   null,
  },
  payment: {
    label:   'Payment Voucher',
    short:   'Payment',
    docType: 'payment',
    fetch:   (id) => paymentAPI.getById(id),
    nameKey: 'party_name',
    nameLabel: 'PARTY',
    items:   null,
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
    reader.onloadend = () => {
      const dataUrl = reader.result;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function shareViaNative(blob, fileName, title, text) {
  try {
    const base64 = await blobToBase64(blob);
    const saved = await Filesystem.writeFile({
      path: fileName,
      data: base64,
      directory: Directory.Cache,
    });
    await Share.share({
      title,
      text,
      url: saved.uri,
      dialogTitle: title,
    });
    return true;
  } catch (e) {
    if (e?.message?.includes('canceled') || e?.message?.includes('cancel')) return true;
    console.error('Native share failed', e);
    return false;
  }
}

export default function BillDetail() {
  const { type, id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const cfg = TYPE_CONFIG[type];

  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
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
        return rows[0];
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
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, []);

  const billNumber = bill?.bill_number || bill?.payment_number || bill?.transaction_number || `#${id}`;
  const billDate   = bill?.bill_date || bill?.payment_date || bill?.transaction_date;
  const partyName  = bill?.[cfg?.nameKey] || bill?.party_name || 'Cash';
  const total      = Number(bill?.total_amount ?? bill?.amount ?? 0);

  const generatePdf = useCallback(async () => {
    if (!bill || !cfg) return null;
    try {
      const [company, profile] = await Promise.all([loadCompany(), loadProfile(cfg.docType)]);
      const fileName = pdfFileName(bill, cfg);
      const blob = await buildBillPdf({
        docType: cfg.docType,
        bill,
        profile: profile || undefined,
        company,
        fileName,
      });
      return { blob, fileName };
    } catch (e) {
      console.error('PDF generation error', e);
      return null;
    }
  }, [bill, cfg]);

  const handleViewPdf = useCallback(async () => {
    setPdfBusy(true);
    setShareOpen(false);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF generation failed' }); return; }
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(result.blob);
      pdfUrlRef.current = url;
      setPdfUrl(url);
    } finally {
      setPdfBusy(false);
    }
  }, [generatePdf]);

  const closePdfViewer = useCallback(() => {
    setPdfUrl(null);
    if (pdfUrlRef.current) {
      URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = null;
    }
  }, []);

  const handleShareFromViewer = useCallback(async () => {
    if (!pdfUrlRef.current) return;
    try {
      const resp = await fetch(pdfUrlRef.current);
      const blob = await resp.blob();
      const fileName = pdfFileName(bill, cfg);
      const ok = await shareViaNative(blob, fileName, billNumber, `${cfg.label} — ${partyName}`);
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } catch (e) {
      Toast.show({ icon: 'fail', content: 'Share failed' });
    }
  }, [bill, cfg, billNumber, partyName]);

  const handleShareSheet = useCallback(async () => {
    setPdfBusy(true);
    setShareOpen(false);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF generation failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, billNumber, `${cfg.label} — ${partyName}`);
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally {
      setPdfBusy(false);
    }
  }, [generatePdf, billNumber, partyName, cfg]);

  const handleWhatsApp = useCallback(async () => {
    setPdfBusy(true);
    setShareOpen(false);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF generation failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, billNumber, `${cfg.label} — ${partyName}`);
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally {
      setPdfBusy(false);
    }
  }, [generatePdf, billNumber, partyName, cfg]);

  if (!cfg) {
    return (
      <div className="bd-screen drill-in">
        <div className="bd-top">
          <button className="bd-back" onClick={() => navigate(-1)} aria-label="Back"><ChevL /></button>
          <div className="bd-top-info">
            <h1 className="bd-top-title">Unknown type</h1>
          </div>
        </div>
      </div>
    );
  }

  const dueDate    = bill?.due_date;
  const partyAddr  = bill?.billing_address || bill?.address || '';
  const partyGstin = bill?.party_gstin || bill?.gstin || '';
  const partyMobile = bill?.mobile || bill?.phone || '';
  const items      = cfg.items ? (bill?.[cfg.items] || []) : [];
  const subtotal   = Number(bill?.subtotal ?? bill?.taxable_amount ?? total);
  const cgst       = Number(bill?.cgst_amount || 0);
  const sgst       = Number(bill?.sgst_amount || 0);
  const igst       = Number(bill?.igst_amount || 0);
  const cess       = Number(bill?.cess_amount || 0);
  const discount   = Number(bill?.discount_amount || bill?.total_discount || 0);
  const roundOff   = Number(bill?.round_off || 0);
  const balance    = Number(bill?.balance_amount ?? 0);
  const narration  = bill?.narration || bill?.notes || '';
  const payEntries = bill?.entries || bill?.payment_entries || [];
  const isPaid     = balance === 0 && total > 0;

  const handleBack = (e) => {
    e.stopPropagation();
    navigate(-1);
  };

  return (
    <div className="bd-screen drill-in" onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
      {/* ── Header ─────────────────────────────────── */}
      <div className="bd-top">
        <button className="bd-back" onClick={handleBack} aria-label="Back"><ChevL /></button>
        <div className="bd-top-info">
          <h1 className="bd-top-title">{billNumber}</h1>
          <div className="bd-top-sub">{cfg.label}{billDate ? ` · ${formatShortDate(billDate)}` : ''}</div>
        </div>
        <div className="bd-top-actions">
          <button
            className={`bd-action-btn whatsapp${pdfBusy ? ' loading' : ''}`}
            onClick={handleWhatsApp}
            disabled={pdfBusy || !bill}
            aria-label="WhatsApp"
          ><WhatsappIcon /></button>
          <button
            className={`bd-action-btn share${pdfBusy ? ' loading' : ''}`}
            onClick={handleShareSheet}
            disabled={pdfBusy || !bill}
            aria-label="Share"
          ><ShareIcon /></button>
          <button
            className={`bd-action-btn pdf${pdfBusy ? ' loading' : ''}`}
            onClick={handleViewPdf}
            disabled={pdfBusy || !bill}
            aria-label="View PDF"
          ><PdfIcon /></button>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────── */}
      <div className="bd-body">
        {loading && <div className="bd-empty">Loading…</div>}

        {!loading && !bill && (
          <div className="bd-empty">Could not load this voucher.</div>
        )}

        {!loading && bill && (
          <>
            {/* Hero: total amount */}
            <div className="bd-hero">
              <div className="bd-hero-amount">{formatINRWithSymbol(total)}</div>
              {isPaid && <span className="bd-hero-badge paid">Paid</span>}
              {balance > 0 && <span className="bd-hero-badge due">₹{formatINRWithSymbol(balance)} due</span>}
            </div>

            {/* Party */}
            <div className="bd-card">
              <div className="bd-card-label">{cfg.nameLabel}</div>
              <div className="bd-party-name">{partyName}</div>
              {(partyAddr || partyGstin || partyMobile) && (
                <div className="bd-party-meta">
                  {partyMobile && <span>{partyMobile}</span>}
                  {partyGstin && <span>GSTIN {partyGstin}</span>}
                  {partyAddr && <span>{partyAddr}</span>}
                </div>
              )}
            </div>

            {/* Details row */}
            <div className="bd-details-row">
              <div className="bd-detail-chip">
                <span className="bd-detail-label">Date</span>
                <span className="bd-detail-value">{formatShortDate(billDate)}</span>
              </div>
              {dueDate && (
                <div className="bd-detail-chip">
                  <span className="bd-detail-label">Due</span>
                  <span className="bd-detail-value">{formatShortDate(dueDate)}</span>
                </div>
              )}
              <div className="bd-detail-chip">
                <span className="bd-detail-label">Status</span>
                <span className={`bd-detail-value ${isPaid ? 'success' : balance > 0 ? 'warning' : ''}`}>
                  {isPaid ? 'Paid' : balance > 0 ? 'Unpaid' : '—'}
                </span>
              </div>
            </div>

            {/* Items (sales/purchase) */}
            {items.length > 0 && (
              <div className="bd-card">
                <div className="bd-card-label">ITEMS ({items.length})</div>
                <div className="bd-items-list">
                  {items.map((it, i) => {
                    const qty = Number(it.quantity || 0);
                    const rate = Number(it.rate || 0);
                    const amt = Number(it.total_amount || it.amount || 0);
                    const hsn = it.hsn_code || '';
                    const unit = it.unit || 'pcs';
                    return (
                      <div key={it.sales_bill_item_id || it.purchase_bill_item_id || i} className="bd-item">
                        <div className="bd-item-left">
                          <div className="bd-item-name">{it.product_name || it.description || 'Item'}</div>
                          <div className="bd-item-meta">
                            {qty} {unit} × ₹{rate.toLocaleString('en-IN')}
                            {hsn ? <span className="bd-item-hsn">HSN {hsn}</span> : null}
                          </div>
                        </div>
                        <div className="bd-item-amount">₹{amt.toLocaleString('en-IN')}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Payment entries (receipt/payment) */}
            {!cfg.items && payEntries.length > 0 && (
              <div className="bd-card">
                <div className="bd-card-label">ENTRIES</div>
                {payEntries.map((e, i) => (
                  <div key={e.entry_id || i} className="bd-pay-row">
                    <div>
                      <div className="bd-pay-account">{e.account_name || e.ledger_name || 'Account'}</div>
                      {e.payment_mode && <div className="bd-pay-mode">{e.payment_mode}</div>}
                    </div>
                    <div className="bd-pay-amount">{formatINRWithSymbol(Number(e.amount || 0))}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Summary */}
            <div className="bd-card">
              <div className="bd-card-label">SUMMARY</div>
              {subtotal !== total && (
                <div className="bd-sum-row">
                  <span>Subtotal</span>
                  <span>{formatINRWithSymbol(subtotal)}</span>
                </div>
              )}
              {discount > 0 && (
                <div className="bd-sum-row">
                  <span>Discount</span>
                  <span className="bd-sum-neg">−{formatINRWithSymbol(discount)}</span>
                </div>
              )}
              {cgst > 0 && (
                <div className="bd-sum-row">
                  <span>CGST</span>
                  <span>{formatINRWithSymbol(cgst)}</span>
                </div>
              )}
              {sgst > 0 && (
                <div className="bd-sum-row">
                  <span>SGST</span>
                  <span>{formatINRWithSymbol(sgst)}</span>
                </div>
              )}
              {igst > 0 && (
                <div className="bd-sum-row">
                  <span>IGST</span>
                  <span>{formatINRWithSymbol(igst)}</span>
                </div>
              )}
              {cess > 0 && (
                <div className="bd-sum-row">
                  <span>Cess</span>
                  <span>{formatINRWithSymbol(cess)}</span>
                </div>
              )}
              {roundOff !== 0 && (
                <div className="bd-sum-row">
                  <span>Round off</span>
                  <span>{roundOff > 0 ? '+' : ''}{formatINRWithSymbol(roundOff)}</span>
                </div>
              )}
              <div className="bd-sum-total">
                <span>Total</span>
                <span>{formatINRWithSymbol(total)}</span>
              </div>
            </div>

            {/* Narration */}
            {narration && (
              <div className="bd-card">
                <div className="bd-card-label">NARRATION</div>
                <div className="bd-narration">{narration}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Inline PDF viewer overlay ─────────────── */}
      {pdfUrl && (
        <div className="bd-pdf-overlay">
          <div className="bd-pdf-toolbar">
            <button className="bd-pdf-close" onClick={closePdfViewer} aria-label="Close PDF"><CloseIcon /></button>
            <span className="bd-pdf-title">PDF Preview</span>
            <button className="bd-pdf-share" onClick={handleShareFromViewer} aria-label="Share PDF"><ShareIcon /></button>
          </div>
          <iframe
            className="bd-pdf-frame"
            src={`${pdfUrl}#zoom=page-fit`}
            title="PDF Preview"
          />
        </div>
      )}

      {/* ── Share bottom sheet ─────────────────────── */}
      {shareOpen && (
        <>
          <div className="bd-sheet-scrim" onClick={() => setShareOpen(false)} />
          <div className="bd-sheet" role="dialog" aria-label="Share options">
            <div className="bd-sheet-handle" />

            <button className="bd-sheet-option" onClick={handleViewPdf}>
              <div className="bd-sheet-icon pdf"><PdfIcon /></div>
              <div className="bd-sheet-text">
                <span className="bd-sheet-label">View PDF</span>
                <span className="bd-sheet-desc">Preview the invoice PDF</span>
              </div>
            </button>

            <button className="bd-sheet-option" onClick={handleShareSheet}>
              <div className="bd-sheet-icon share"><ShareIcon /></div>
              <div className="bd-sheet-text">
                <span className="bd-sheet-label">Share PDF</span>
                <span className="bd-sheet-desc">Open share sheet with PDF attached</span>
              </div>
            </button>

            <button className="bd-sheet-option" onClick={handleWhatsApp}>
              <div className="bd-sheet-icon whatsapp"><WhatsappIcon /></div>
              <div className="bd-sheet-text">
                <span className="bd-sheet-label">WhatsApp</span>
                <span className="bd-sheet-desc">Send PDF via WhatsApp</span>
              </div>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
