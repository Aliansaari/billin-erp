import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, isoDate, defaultFY } from '../utils/format';
import { useBack } from '../utils/useBack';
import { shareViaNative } from '../utils/sharePdf';
import './ReportList.css';

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

// ── Classification helpers ──────────────────────────────────────────────
function toTitleCase(str) {
  if (!str) return 'Unknown';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function getClassification(r) {
  const raw = r.classification || r.velocity_class || r.class || r.velocity || '';
  return toTitleCase(raw) || 'Unknown';
}

// Badge style per classification
const CLASS_STYLE = {
  Fast:    { background: '#dcfce7', color: '#166534' },
  Medium:  { background: '#dbeafe', color: '#1e40af' },
  Slow:    { background: '#fef3c7', color: '#92400e' },
  Dead:    { background: '#fee2e2', color: '#991b1b' },
  Unknown: { background: '#f1f5f9', color: '#64748b' },
};

function classBadgeStyle(cls) {
  return CLASS_STYLE[cls] || CLASS_STYLE.Unknown;
}

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
      {[80, 60, 90, 55, 70].map((w, i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 13, width: `${w}%`, marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 10, width: '35%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <div className="rl-skel" style={{ height: 13, width: 50 }} />
            <div className="rl-skel" style={{ height: 18, width: 44, borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </>
  );
}

// ── Row component ───────────────────────────────────────────────────────
function MoverRow({ row }) {
  const cls = getClassification(row);
  const badgeStyle = classBadgeStyle(cls);
  const qty = row.total_qty || row.qty || row.quantity || 0;

  return (
    <div className="rl-row" style={{ cursor: 'default' }}>
      <div className="rl-row-main">
        <div className="rl-row-party">{row.product_name || '—'}</div>
        <div className="rl-row-meta">
          {row.category_name && <span>{row.category_name}</span>}
        </div>
      </div>
      <div className="rl-row-side">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
          {formatINR(qty)} qty
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            letterSpacing: '0.04em',
            ...badgeStyle,
          }}
        >
          {cls}
        </div>
      </div>
    </div>
  );
}

// ── Filter chip config ───────────────────────────────────────────────────
const CHIPS = [
  { key: 'All',  label: 'All' },
  { key: 'Fast', label: 'Fast' },
  { key: 'Slow', label: 'Slow' },
  { key: 'Dead', label: 'Dead' },
];

// ── Main component ──────────────────────────────────────────────────────
export default function FastSlowMovers() {
  const goBack = useBack('/reports');
  const fy = defaultFY();

  const [fromDate,  setFromDate]  = useState(() => isoDate(fy.from));
  const [toDate,    setToDate]    = useState(() => isoDate(fy.to));
  const [data,      setData]      = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [searchOn,  setSearchOn]  = useState(false);
  const [chipFilter, setChipFilter] = useState('All');
  const [pdfBusy,   setPdfBusy]   = useState(false);
  const [pdfUrl,    setPdfUrl]    = useState(null);
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
    reportAPI.movers({ from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        const rows = res.data?.data || res.data || [];
        setData(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load data' });
        setData([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  // Filter + search
  const filtered = useMemo(() => {
    let rows = data;
    if (chipFilter !== 'All') {
      rows = rows.filter((r) => getClassification(r) === chipFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) =>
        (r.product_name || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [data, chipFilter, search]);

  // Chip counts
  const chipCounts = useMemo(() => {
    const counts = { All: data.length };
    for (const r of data) {
      const cls = getClassification(r);
      counts[cls] = (counts[cls] || 0) + 1;
    }
    return counts;
  }, [data]);

  // PDF generation
  async function generatePdf() {
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'),
    ]);
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('Fast & Slow Movers', 40, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    const filterLabel = chipFilter !== 'All' ? ` · ${chipFilter} movers` : '';
    doc.text(`${prettyDate(fromDate)} – ${prettyDate(toDate)}  ·  ${filtered.length} products${filterLabel}`, 40, 56);
    autoTable(doc, {
      startY: 72,
      head: [['Product', 'Category', 'Qty Sold', 'Value', 'Class']],
      body: filtered.map((r) => [
        r.product_name  || '—',
        r.category_name || '—',
        formatINR(r.total_qty || r.qty || r.quantity || 0),
        `₹${formatINR(r.total_value || r.total_amount || 0)}`,
        getClassification(r),
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [181, 66, 28], textColor: [255, 244, 234], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [251, 248, 241] },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' } },
    });
    return { blob: doc.output('blob'), fileName: `fast-slow-movers-${fromDate}_${toDate}.pdf` };
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
      const ok = await shareViaNative(result.blob, result.fileName, 'Fast & Slow Movers');
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
        <h1 className="rl-title">Fast &amp; <em>slow movers</em></h1>
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

      {/* Filter chips */}
      <div className="rl-chips">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            className={`rl-chip${chipFilter === c.key ? ' active' : ''}`}
            onClick={() => setChipFilter(c.key)}
          >
            {c.label}
            {chipCounts[c.key] != null && (
              <span className="rl-chip-count">{chipCounts[c.key]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Search (collapsible) */}
      {searchOn && (
        <div className="rl-search">
          <input
            ref={searchRef}
            placeholder="Search product…"
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
              : chipFilter !== 'All'
                ? `No ${chipFilter.toLowerCase()} movers in this period`
                : 'No data in this period'}
          </div>
        )}

        {!loading && filtered.map((row, i) => (
          <MoverRow key={row.barcode || row.product_name || i} row={row} />
        ))}
      </div>

      {/* Sticky footer */}
      {!loading && filtered.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">
            {filtered.length} product{filtered.length === 1 ? '' : 's'}
          </span>
          <span className="rl-footer-total" style={{ fontSize: 12, color: 'var(--c-text-soft)' }}>
            {chipFilter !== 'All' ? chipFilter : 'All classes'}
          </span>
        </div>
      )}

      {/* PDF overlay */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Fast &amp; Slow Movers</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `fast-slow-movers-${fromDate}_${toDate}.pdf`, 'Fast & Slow Movers');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="Fast Slow Movers PDF"
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
