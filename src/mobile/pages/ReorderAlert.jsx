import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { productAPI } from '../../api';
import { formatINR } from '../utils/format';
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

// ── Skeleton ────────────────────────────────────────────────────────────
function SkeletonRows() {
  return (
    <>
      {[72, 58, 84, 65, 77].map((w, i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 13, width: `${w}%`, marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 10, width: '45%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <div className="rl-skel" style={{ height: 14, width: 38 }} />
            <div className="rl-skel" style={{ height: 10, width: 52 }} />
          </div>
        </div>
      ))}
    </>
  );
}

// ── Stock colour helper ─────────────────────────────────────────────────
function stockColor(current, minimum) {
  if (current <= 0) return 'var(--c-danger, #dc2626)';
  if (current < minimum) return '#f0a000';
  return 'var(--c-text)';
}

// ── Row component ───────────────────────────────────────────────────────
function AlertRow({ row }) {
  const current = Number(row.current_stock ?? 0);
  const minimum = Number(row.minimum_stock_level ?? 0);
  const color = stockColor(current, minimum);

  return (
    <div className="rl-row" style={{ cursor: 'default' }}>
      <div className="rl-row-main">
        <div className="rl-row-party">{row.product_name || '—'}</div>
        <div className="rl-row-meta">
          {row.barcode && <span>{row.barcode}</span>}
          {row.hsn_code && (
            <><span className="rl-meta-dot">·</span><span>HSN {row.hsn_code}</span></>
          )}
          {row.unit_of_measurement && (
            <><span className="rl-meta-dot">·</span><span>{row.unit_of_measurement}</span></>
          )}
        </div>
      </div>
      <div className="rl-row-side">
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.03em',
          }}
        >
          {formatINR(current)}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--c-text-mute)', fontVariantNumeric: 'tabular-nums' }}>
          min {formatINR(minimum)}
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────
export default function ReorderAlert() {
  const goBack = useBack('/reports');

  const [data,     setData]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const [pdfBusy,  setPdfBusy]  = useState(false);
  const [pdfUrl,   setPdfUrl]   = useState(null);
  const searchRef = useRef(null);
  const pdfUrlRef = useRef(null);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, []);

  // Auto-focus search
  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn) setSearch('');
  }, [searchOn]);

  // Load data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    productAPI.getLowStock()
      .then((res) => {
        if (cancelled) return;
        const rows = res.data?.data || res.data || [];
        setData(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load stock data' });
        setData([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Filter + sort by deficit descending
  const filtered = useMemo(() => {
    let rows = data;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) =>
        (r.product_name || '').toLowerCase().includes(q) ||
        (r.barcode      || '').toLowerCase().includes(q)
      );
    }
    return [...rows].sort((a, b) => {
      const defA = Number(a.minimum_stock_level || 0) - Number(a.current_stock || 0);
      const defB = Number(b.minimum_stock_level || 0) - Number(b.current_stock || 0);
      return defB - defA;
    });
  }, [data, search]);

  // PDF generation
  async function generatePdf() {
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'),
    ]);
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('Reorder Alert', 40, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text(`${filtered.length} item${filtered.length === 1 ? '' : 's'} below minimum stock`, 40, 56);
    autoTable(doc, {
      startY: 72,
      head: [['Product', 'Barcode', 'Current Stock', 'Min Stock', 'Deficit', 'Unit']],
      body: filtered.map((r) => {
        const current = Number(r.current_stock ?? 0);
        const minimum = Number(r.minimum_stock_level ?? 0);
        const deficit = minimum - current;
        return [
          r.product_name         || '—',
          r.barcode              || '—',
          formatINR(current),
          formatINR(minimum),
          deficit > 0 ? formatINR(deficit) : '0',
          r.unit_of_measurement  || '—',
        ];
      }),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [181, 66, 28], textColor: [255, 244, 234], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [251, 248, 241] },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    });
    return { blob: doc.output('blob'), fileName: 'reorder-alert.pdf' };
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
      const ok = await shareViaNative(result.blob, result.fileName, 'Reorder Alert');
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
        <h1 className="rl-title">Reorder <em>alert</em></h1>
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

      {/* Search (collapsible) */}
      {searchOn && (
        <div className="rl-search">
          <input
            ref={searchRef}
            placeholder="Product name or barcode…"
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
              ? `No items matching "${search}"`
              : 'No items below minimum stock'}
          </div>
        )}

        {!loading && filtered.map((row, i) => (
          <AlertRow key={row.barcode || row.product_name || i} row={row} />
        ))}
      </div>

      {/* Sticky footer */}
      {!loading && filtered.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">
            {filtered.length} item{filtered.length === 1 ? '' : 's'} below minimum
          </span>
          <span
            className="rl-footer-total"
            style={{ fontSize: 12, color: 'var(--c-danger, #dc2626)', fontWeight: 600 }}
          >
            reorder needed
          </span>
        </div>
      )}

      {/* PDF overlay */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Reorder Alert</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, 'reorder-alert.pdf', 'Reorder Alert');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="Reorder Alert PDF"
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
