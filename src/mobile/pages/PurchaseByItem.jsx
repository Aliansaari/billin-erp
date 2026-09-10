import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, isoDate, defaultFY } from '../utils/format';
import { useBack } from '../utils/useBack';
import { shareViaNative } from '../utils/sharePdf';
import './ReportList.css';
import { friendlyError } from '../utils/offlineSnapshot';

// ── Icons ───────────────────────────────────────────────────────────────
const ChevL = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6"/>
  </svg>
);
const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>
);
const PdfIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/>
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

// ── Helpers ─────────────────────────────────────────────────────────────
function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── Skeleton ────────────────────────────────────────────────────────────
function SkeletonRows() {
  return (
    <>
      {[75, 55, 85, 60, 70].map((w, i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 13, width: `${w}%`, marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 10, width: '40%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <div className="rl-skel" style={{ height: 13, width: 50 }} />
            <div className="rl-skel" style={{ height: 11, width: 68 }} />
          </div>
        </div>
      ))}
    </>
  );
}

// ── Row component ───────────────────────────────────────────────────────
function ItemRow({ row }) {
  return (
    <div className="rl-row" style={{ cursor: 'default' }}>
      <div className="rl-row-main">
        <div className="rl-row-party">{row.product_name || '—'}</div>
        <div className="rl-row-meta">
          {row.category_name && <span>{row.category_name}</span>}
          {row.hsn_code && (
            <><span className="rl-meta-dot">·</span><span>HSN {row.hsn_code}</span></>
          )}
          {row.unit_type && (
            <><span className="rl-meta-dot">·</span><span>{row.unit_type}</span></>
          )}
        </div>
      </div>
      <div className="rl-row-side">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {formatINR(row.quantity || 0)} qty
        </div>
        <div className="rl-row-amount" style={{ fontSize: 13 }}>
          ₹{formatINR(row.total_amount || 0)}
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────
export default function PurchaseByItem() {
  const goBack = useBack('/reports');
  const fy = defaultFY();

  const [fromDate, setFromDate] = useState(() => isoDate(fy.from));
  const [toDate,   setToDate]   = useState(() => isoDate(fy.to));
  const [data,     setData]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const [pdfBusy,  setPdfBusy]  = useState(false);
  const [pdfUrl,   setPdfUrl]   = useState(null);
  const searchRef = useRef(null);
  const pdfUrlRef = useRef(null);

  const TODAY = isoDate();

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, []);

  // Guard: to >= from
  useEffect(() => {
    if (toDate < fromDate) setToDate(fromDate);
  }, [fromDate, toDate]);

  // Auto-focus search
  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn) setSearch('');
  }, [searchOn]);

  // Load data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reportAPI.productPurchaseItems({ from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        const rows = res.data?.data || res.data || [];
        setData(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load data') });
        setData([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  // Filter + sort
  const filtered = useMemo(() => {
    let rows = data;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) =>
        (r.product_name   || '').toLowerCase().includes(q) ||
        (r.category_name  || '').toLowerCase().includes(q) ||
        (r.hsn_code       || '').toLowerCase().includes(q)
      );
    }
    return [...rows].sort((a, b) => Number(b.total_amount || 0) - Number(a.total_amount || 0));
  }, [data, search]);

  const totalValue = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.total_amount || 0), 0),
    [filtered],
  );

  // PDF generation
  async function generatePdf() {
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'),
    ]);
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('Purchase by Item', 40, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text(`${prettyDate(fromDate)} – ${prettyDate(toDate)}  ·  ${filtered.length} products`, 40, 56);
    autoTable(doc, {
      startY: 72,
      head: [['Product', 'Category', 'HSN', 'Qty', 'Rate', 'Value']],
      body: filtered.map((r) => [
        r.product_name    || '—',
        r.category_name   || '—',
        r.hsn_code        || '—',
        formatINR(r.quantity     || 0),
        `₹${formatINR(r.rate    || 0)}`,
        `₹${formatINR(r.total_amount  || 0)}`,
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [181, 66, 28], textColor: [255, 244, 234], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [251, 248, 241] },
      columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    });
    return { blob: doc.output('blob'), fileName: `purchase-by-item-${fromDate}_${toDate}.pdf` };
  }

  async function handleViewPdf() {
    if (filtered.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(result.blob);
      pdfUrlRef.current = url;
      setPdfUrl(url);
    } catch (e) {
      console.error('PDF', e);
      Toast.show({ icon: 'fail', content: 'PDF failed' });
    } finally { setPdfBusy(false); }
  }

  async function handleSharePdf() {
    if (filtered.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      const ok = await shareViaNative(result.blob, result.fileName, 'Purchase by Item');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } catch (e) {
      console.error('Share', e);
      Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  return (
    <div className="rl-screen drill-in">

      {/* Topbar */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">Purchase <em>by item</em></h1>
        <button
          className={`rl-icon-btn${searchOn ? ' active' : ''}`}
          onClick={() => setSearchOn((v) => !v)}
          aria-label="Search"
        >
          <SearchIcon />
        </button>
        <button
          className="rl-icon-btn"
          onClick={handleViewPdf}
          disabled={pdfBusy || filtered.length === 0}
          aria-label="PDF preview"
          style={{ color: filtered.length && !pdfBusy ? 'var(--c-primary)' : undefined }}
        >
          <PdfIcon />
        </button>
        <button
          className="rl-icon-btn"
          onClick={handleSharePdf}
          disabled={pdfBusy || filtered.length === 0}
          aria-label="Share PDF"
        >
          <ShareIcon />
        </button>
      </div>

      {/* Date range */}
      <div className="rl-range">
        <label className="rl-date">
          <span className="rl-date-key">FROM</span>
          <span className="rl-date-val">{prettyDate(fromDate)}</span>
          <input
            type="date" value={fromDate} max={TODAY}
            onChange={(e) => { if (e.target.value) setFromDate(e.target.value); }}
          />
        </label>
        <span className="rl-range-arrow">→</span>
        <label className="rl-date">
          <span className="rl-date-key">TO</span>
          <span className="rl-date-val">{prettyDate(toDate)}</span>
          <input
            type="date" value={toDate} min={fromDate}
            onChange={(e) => { if (e.target.value) setToDate(e.target.value); }}
          />
        </label>
      </div>

      {/* Search (collapsible) */}
      {searchOn && (
        <div className="rl-search">
          <input
            ref={searchRef}
            placeholder="Product, category, HSN…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off" autoCapitalize="none" spellCheck="false"
          />
        </div>
      )}

      {/* List */}
      <div className="rl-list">
        {loading && <SkeletonRows />}

        {!loading && filtered.length === 0 && (
          <div className="rl-empty">
            {search.trim()
              ? `No products matching "${search}"`
              : 'No purchase data in this period'}
          </div>
        )}

        {!loading && filtered.map((row, i) => (
          <ItemRow key={row.barcode || row.product_name || i} row={row} />
        ))}
      </div>

      {/* Sticky footer */}
      {!loading && filtered.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">
            {filtered.length} product{filtered.length === 1 ? '' : 's'}
          </span>
          <span className="rl-footer-total">₹{formatINR(totalValue)}</span>
        </div>
      )}

      {/* PDF overlay */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Purchase by Item</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `purchase-by-item-${fromDate}_${toDate}.pdf`, 'Purchase by Item');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="Purchase by Item PDF"
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
