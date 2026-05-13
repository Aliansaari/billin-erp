import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { productAPI } from '../../api';
import { formatINR, formatShortDate } from '../utils/format';
import { shareViaNative } from '../utils/sharePdf';
import './StockMovement.css';
import './ReportList.css';

const ChevL = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
);
const PdfIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/>
  </svg>
);
const ShareIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
    <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/>
  </svg>
);
const CloseIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12"/>
  </svg>
);

const TYPE_COLORS = {
  'Opening Stock':    'neutral',
  'Purchase':         'in',
  'Sales':            'out',
  'Sales Return':     'in',
  'Purchase Return':  'out',
  'Stock Adjustment': 'neutral',
};

function typeClass(t) {
  return TYPE_COLORS[t] || 'neutral';
}

function shortType(t) {
  if (t === 'Opening Stock') return 'Opening';
  if (t === 'Stock Adjustment') return 'Adjust';
  if (t === 'Purchase Return') return 'Pur. Return';
  if (t === 'Sales Return') return 'Sale Return';
  return t || 'Other';
}

export default function StockMovement() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [product, setProduct] = useState(null);
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfUrl,  setPdfUrl]  = useState(null);
  const pdfUrlRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      productAPI.getById(id),
      productAPI.getStockMovement(id),
    ]).then(([pRes, mRes]) => {
      if (cancelled) return;
      if (pRes.status === 'fulfilled') {
        const d = pRes.value.data;
        setProduct(d?.data || d);
      }
      if (mRes.status === 'fulfilled') {
        const raw = mRes.value.data;
        const rows = Array.isArray(raw) ? raw : (raw?.data || []);
        rows.sort((a, b) => new Date(a.transaction_date) - new Date(b.transaction_date));
        let bal = 0;
        for (const r of rows) {
          bal += Number(r.quantity_in || 0) - Number(r.quantity_out || 0);
          r._balance = bal;
        }
        setMovements(rows.reverse());
      } else {
        Toast.show({ icon: 'fail', content: 'Failed to load movements' });
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const types = useMemo(() => {
    const s = new Set();
    for (const m of movements) s.add(m.transaction_type);
    return Array.from(s);
  }, [movements]);

  const filtered = useMemo(() => {
    if (filter === 'all') return movements;
    return movements.filter((m) => m.transaction_type === filter);
  }, [movements, filter]);

  const stats = useMemo(() => {
    let totalIn = 0, totalOut = 0;
    for (const m of movements) {
      totalIn  += Number(m.quantity_in  || 0);
      totalOut += Number(m.quantity_out || 0);
    }
    return { totalIn, totalOut, closing: totalIn - totalOut };
  }, [movements]);

  async function generatePdf() {
    if (filtered.length === 0) return null;
    const pName = product?.product_name || product?.name || 'Product';
    const unit  = product?.unit_of_measurement || product?.unit || 'pcs';
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(`Stock Movement — ${pName}`, 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${filtered.length} transactions · In ${stats.totalIn} ${unit} · Out ${stats.totalOut} ${unit} · Closing ${stats.closing} ${unit}`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Date', 'Type', 'Reference', 'Party', 'In', 'Out', 'Balance']],
        body: filtered.map((m) => [
          formatShortDate(m.transaction_date),
          shortType(m.transaction_type),
          m.reference_number || '—',
          m.party_name || '—',
          Number(m.quantity_in  || 0) || '',
          Number(m.quantity_out || 0) || '',
          m._balance,
        ]),
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
      });
      const safe = pName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      return { blob: doc.output('blob'), fileName: `stock-movement-${safe}.pdf` };
    } catch (e) { console.error('PDF', e); return null; }
  }

  async function handleViewPdf() {
    if (filtered.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(result.blob);
      pdfUrlRef.current = url;
      setPdfUrl(url);
    } finally { setPdfBusy(false); }
  }

  async function handleSharePdf() {
    if (filtered.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, 'Stock Movement');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  const name = product?.product_name || product?.name || 'Product';
  const unit = product?.unit_of_measurement || product?.unit || 'pcs';
  const purRate = Number(product?.purchase_rate ?? product?.display_cost ?? 0);
  const saleRate = Number(product?.sale_rate ?? product?.sale_price ?? 0);
  const currentStock = Number(product?.current_stock ?? 0);
  const stockValue = Number(product?.display_stock_value ?? 0);
  const barcode = product?.barcode || '';
  const hsn = product?.hsn_code || '';
  const size = product?.size_value || '';
  const meta = [barcode, hsn && `HSN ${hsn}`, size && `Size ${size}`].filter(Boolean);

  return (
    <div className="sm-screen">
      {/* Header */}
      <div className="sm-top">
        <button className="sm-back" onClick={() => navigate(-1)} aria-label="Back">
          <ChevL />
        </button>
        <div className="sm-top-info">
          <h1 className="sm-top-name">{name}</h1>
          {meta.length > 0 && <div className="sm-top-meta">{meta.join(' · ')}</div>}
          <div className="sm-top-sub">{unit} · {movements.length} transactions</div>
        </div>
        <button
          className="sm-icon-btn"
          onClick={handleViewPdf}
          disabled={pdfBusy || filtered.length === 0}
          aria-label="PDF preview"
          style={{ color: filtered.length && !pdfBusy ? 'var(--c-primary)' : undefined }}
        >
          <PdfIcon />
        </button>
        <button
          className="sm-icon-btn"
          onClick={handleSharePdf}
          disabled={pdfBusy || filtered.length === 0}
          aria-label="Share PDF"
        >
          <ShareIcon />
        </button>
      </div>

      {/* Product stats card */}
      {product && (
        <div className="sm-stats">
          <div className="sm-stat-row">
            <div className="sm-stat">
              <span className="sm-stat-label">Current stock</span>
              <span className="sm-stat-value">{currentStock} <small>{unit}</small></span>
            </div>
            <div className="sm-stat">
              <span className="sm-stat-label">Stock value</span>
              <span className="sm-stat-value">₹{formatINR(stockValue)}</span>
            </div>
          </div>
          <div className="sm-stat-row">
            <div className="sm-stat">
              <span className="sm-stat-label">Purchase rate</span>
              <span className="sm-stat-value sm-pur">₹{formatINR(purRate)}</span>
            </div>
            <div className="sm-stat">
              <span className="sm-stat-label">Sale rate</span>
              <span className="sm-stat-value sm-sale">₹{formatINR(saleRate)}</span>
            </div>
          </div>
          <div className="sm-stat-row sm-stat-row-3">
            <div className="sm-stat">
              <span className="sm-stat-label">Total in</span>
              <span className="sm-stat-value sm-in">{stats.totalIn}</span>
            </div>
            <div className="sm-stat">
              <span className="sm-stat-label">Total out</span>
              <span className="sm-stat-value sm-out">{stats.totalOut}</span>
            </div>
            <div className="sm-stat">
              <span className="sm-stat-label">Closing</span>
              <span className="sm-stat-value">{stats.closing}</span>
            </div>
          </div>
        </div>
      )}

      {/* Filter chips */}
      {types.length > 1 && (
        <div className="sm-chips">
          <button
            className={`sm-chip${filter === 'all' ? ' active' : ''}`}
            onClick={() => setFilter('all')}
          >All</button>
          {types.map((t) => (
            <button
              key={t}
              className={`sm-chip${filter === t ? ' active' : ''}`}
              onClick={() => setFilter(t)}
            >{shortType(t)}</button>
          ))}
        </div>
      )}

      {/* Movement ledger */}
      <div className="sm-list-wrap">
        {loading && <div className="sm-empty">Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="sm-empty">No movements found</div>
        )}

        {/* Table header */}
        {!loading && filtered.length > 0 && (
          <div className="sm-thead">
            <span className="sm-th sm-th-date">Date</span>
            <span className="sm-th sm-th-type">Type</span>
            <span className="sm-th sm-th-qty">In</span>
            <span className="sm-th sm-th-qty">Out</span>
            <span className="sm-th sm-th-bal">Bal</span>
          </div>
        )}

        {!loading && filtered.map((m, i) => {
          const qIn  = Number(m.quantity_in  || 0);
          const qOut = Number(m.quantity_out || 0);
          const tc = typeClass(m.transaction_type);

          return (
            <div key={m.ledger_id || i} className="sm-row">
              <div className="sm-row-top">
                <span className={`sm-type-tag ${tc}`}>{shortType(m.transaction_type)}</span>
                <span className="sm-row-date">{formatShortDate(m.transaction_date)}</span>
              </div>
              <div className="sm-row-bot">
                <span className="sm-row-ref">
                  {m.reference_number || '—'}
                  {m.party_name && <span className="sm-row-party"> · {m.party_name}</span>}
                </span>
                <div className="sm-row-nums">
                  <span className={`sm-num ${qIn ? 'in' : 'zero'}`}>{qIn || '—'}</span>
                  <span className={`sm-num ${qOut ? 'out' : 'zero'}`}>{qOut || '—'}</span>
                  <span className="sm-num bal">{m._balance}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      {!loading && filtered.length > 0 && (
        <div className="sm-footer">
          <span className="sm-footer-count">{filtered.length} movement{filtered.length === 1 ? '' : 's'}</span>
          <div className="sm-footer-sum">
            <span className="sm-footer-in">↑ {stats.totalIn}</span>
            <span className="sm-footer-out">↓ {stats.totalOut}</span>
          </div>
        </div>
      )}

      {/* PDF overlay */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Stock Movement</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                const safe = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
                await shareViaNative(blob, `stock-movement-${safe}.pdf`, 'Stock Movement');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe className="rl-pdf-frame" src={pdfUrl} title="Stock Movement PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
