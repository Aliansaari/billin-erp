import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { productAPI } from '../../api';
import { formatINR, formatShortDate } from '../utils/format';
import { shareViaNative } from '../utils/sharePdf';
import './StockMovement.css';
import './ReportList.css';
import { tap as hapticTap } from '../utils/haptics';
import { isUnreachable, ageOf } from '../utils/offlineSnapshot';
import { cacheKey as mirrorKey, putCached as putMirrored, getCached as getMirrored } from '../utils/mirrorCache';
import OfflineBanner from '../components/OfflineBanner';

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
  const [offline, setOffline] = useState(null);
  const pdfUrlRef = useRef(null);

  /* One transform for both paths.
   *
   * The running balance is worked out here, on the phone, exactly as it
   * always was — and that is fine precisely BECAUSE it is the same code on
   * the same rows whether they came from the shop or from storage. What is
   * cached is the raw movement list, never the computed balance: derive it
   * twice from one input and the two can never disagree; store the derived
   * figure and they eventually will. */
  const applyMovements = (raw) => {
    const rows = Array.isArray(raw) ? raw : (raw?.data || []);
    rows.sort((a, b) => new Date(a.transaction_date) - new Date(b.transaction_date));
    let bal = 0;
    for (const r of rows) {
      bal += Number(r.quantity_in || 0) - Number(r.quantity_out || 0);
      r._balance = bal;
    }
    setMovements(rows.reverse());
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const CK = mirrorKey('movement', { product: id });

    // The stored copy first, so the screen is there before the tunnel answers.
    getMirrored(CK).then((hit) => {
      if (cancelled || !hit?.data) return;
      if (hit.data.product) setProduct(hit.data.product);
      applyMovements(hit.data.movements);
      setLoading(false);
    }).catch(() => {});

    Promise.allSettled([
      productAPI.getById(id),
      productAPI.getStockMovement(id),
    ]).then(([pRes, mRes]) => {
      if (cancelled) return;
      let prod = null;
      if (pRes.status === 'fulfilled') {
        const d = pRes.value.data;
        prod = d?.data || d;
        setProduct(prod);
      }
      if (mRes.status === 'fulfilled') {
        const raw = mRes.value.data;
        applyMovements(raw);
        setOffline(null);
        // Keep the RAW rows — the balance above is derived from them.
        putMirrored(CK, { product: prod, movements: Array.isArray(raw) ? raw : (raw?.data || []) });
      } else if (isUnreachable(mRes.reason)) {
        /* This screen had no offline path at all, so an unreachable shop
         * showed an empty movement history — which reads as "this item has
         * never moved", a statement about the stock rather than about the
         * connection. */
        getMirrored(CK).then((hit) => {
          if (cancelled || !hit?.data) {
            if (!cancelled) Toast.show({ icon: 'fail', content: 'Could not load movements' });
            return;
          }
          if (hit.data.product) setProduct(hit.data.product);
          applyMovements(hit.data.movements);
          setOffline({ age: ageOf(hit.syncedAt) });
        }).catch(() => {});
      } else {
        Toast.show({ icon: 'fail', content: 'Could not load movements' });
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

  /* Margin, worked out here rather than left to the reader.
   *
   * Both inputs were already on screen as separate tiles, so anyone wanting
   * the one number that matters — what this item actually earns — had to do
   * the subtraction themselves. Showing the inputs and withholding the
   * conclusion is the most common way a dense screen manages to say nothing. */
  const margin = saleRate - purRate;
  const marginPct = purRate > 0 ? (margin / purRate) * 100 : null;

  /* Closing is the balance the MOVEMENTS add up to; currentStock is what the
   * product record says. They should agree, and when they do, showing both is
   * the same number twice. When they do NOT agree the stock ledger has
   * drifted from the item — which is worth knowing and was previously buried
   * as one tile among seven, saying nothing to distinguish it. */
  const ledgerDrift = product && Math.abs(Number(stats.closing) - currentStock) > 0.001;
  const barcode = product?.barcode || '';
  const hsn = product?.hsn_code || '';
  const size = product?.size_value || '';
  const meta = [barcode, hsn && `HSN ${hsn}`, size && `Size ${size}`].filter(Boolean);

  return (
    <div className="sm-screen">
      {/* Header */}
      <div className="sm-top">
        <button className="sm-back" onClick={() => { hapticTap(); navigate(-1); }} aria-label="Back">
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

      {/* Says when. A movement history with no date on it is the one thing
          someone checks before telling a customer an item is in stock. */}
      {offline && (
        <div className="offline-slot">
          <OfflineBanner age={offline.age} onRetry={() => window.location.reload()} />
        </div>
      )}

      {/* Product stats card */}
      {product && (
        <div className="sm-stats">
          {/* The answer first: is there any, and what is it worth.

              A two-row grid rather than two stacked columns, so the labels
              share one line and the figures share the next. Laid out as
              separate columns they staggered against each other and the band
              read as two unrelated things that happened to be side by side. */}
          <div className="sm-hero">
            <span className="sm-hero-label">In stock</span>
            <span className="sm-hero-label sm-hero-label-end">Stock value</span>
            <span className="sm-hero-value">
              {currentStock}<small>{unit}</small>
            </span>
            <span className="sm-hero-side-value">₹{formatINR(stockValue)}</span>
          </div>

          {/* What it costs, what it sells for, and the gap — which is the
              thing the first two exist to tell you. */}
          <div className="sm-rates">
            <div className="sm-rate">
              <span className="sm-rate-label">Buy</span>
              <span className="sm-rate-value">₹{formatINR(purRate)}</span>
            </div>
            <span className="sm-rate-arrow" aria-hidden>→</span>
            <div className="sm-rate">
              <span className="sm-rate-label">Sell</span>
              <span className="sm-rate-value sm-sale">₹{formatINR(saleRate)}</span>
            </div>
            <div className={`sm-rate sm-rate-margin${margin < 0 ? ' is-loss' : ''}`}>
              <span className="sm-rate-label">Margin</span>
              <span className="sm-rate-value">
                ₹{formatINR(Math.abs(margin))}
                {marginPct !== null && (
                  <small>{margin < 0 ? '−' : ''}{Math.abs(marginPct).toFixed(1)}%</small>
                )}
              </span>
            </div>
          </div>

          {/* Only when the two disagree. Silence is the useful state. */}
          {ledgerDrift && (
            <div className="sm-drift">
              Movements total {stats.closing} {unit}, item record says {currentStock}
            </div>
          )}
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
