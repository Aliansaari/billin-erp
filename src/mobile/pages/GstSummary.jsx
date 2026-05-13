import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, isoDate, defaultFY } from '../utils/format';
import { useBack } from '../utils/useBack';
import { shareViaNative } from '../utils/sharePdf';
import './ReportList.css';

// ── Icons ──────────────────────────────────────────────────────────────
const ChevL = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6"/>
  </svg>
);
const ChevLSmall = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6"/>
  </svg>
);
const ChevRSmall = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l6-6-6-6"/>
  </svg>
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

// ── FY helpers ─────────────────────────────────────────────────────────
function fyForYear(year) {
  return {
    year,
    from: new Date(year, 3, 1),
    to:   new Date(year + 1, 2, 31),
  };
}
function currentFyYear() {
  const now = new Date();
  return now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
}
function fyLabel(year) {
  return `FY ${year}–${String(year + 1).slice(2)}`;
}

// ── Normalize row fields ───────────────────────────────────────────────
function normalizeRow(r) {
  const taxable  = Number(r.taxable_value ?? r.taxable ?? 0);
  const igst     = Number(r.igst ?? 0);
  const cgst     = Number(r.cgst ?? 0);
  const sgst     = Number(r.sgst ?? 0);
  const totalTax = Number(r.total_tax ?? r.cess ?? (igst + cgst + sgst));
  const rate     = r.rate ?? r.gst_rate ?? '';
  return { ...r, taxable, igst, cgst, sgst, totalTax, rate };
}

// ── Component ──────────────────────────────────────────────────────────
export default function GstSummary() {
  const goBack = useBack('/reports');
  const baseFy = currentFyYear();
  const [fyOffset, setFyOffset] = useState(0);
  const [rows,     setRows]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [pdfBusy,  setPdfBusy]  = useState(false);
  const [pdfUrl,   setPdfUrl]   = useState(null);
  const pdfUrlRef = useRef(null);

  const fyYear = baseFy + fyOffset;
  const fy     = fyForYear(fyYear);
  const fromDate = isoDate(fy.from);
  const toDate   = isoDate(fy.to);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); };
  }, []);

  // Load data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reportAPI.hsnSummary({ from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        const raw = res.data?.data || res.data || [];
        setRows((Array.isArray(raw) ? raw : []).map(normalizeRow));
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load' });
        setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  const totals = useMemo(() => ({
    taxable:  rows.reduce((s, r) => s + r.taxable, 0),
    igst:     rows.reduce((s, r) => s + r.igst, 0),
    cgst:     rows.reduce((s, r) => s + r.cgst, 0),
    sgst:     rows.reduce((s, r) => s + r.sgst, 0),
    totalTax: rows.reduce((s, r) => s + r.totalTax, 0),
  }), [rows]);

  async function generatePdf() {
    if (rows.length === 0) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('GST Summary — HSN/SAC', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${fyLabel(fyYear)}  ·  ${rows.length} HSN codes`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['HSN', 'Description', 'UOM', 'Qty', 'Taxable', 'IGST', 'CGST', 'SGST', 'Total Tax']],
        body: rows.map((r) => [
          r.hsn_code || '—',
          r.description || '',
          r.uom || '',
          r.qty != null ? Number(r.qty).toLocaleString('en-IN') : '',
          `₹${formatINR(r.taxable)}`,
          `₹${formatINR(r.igst)}`,
          `₹${formatINR(r.cgst)}`,
          `₹${formatINR(r.sgst)}`,
          `₹${formatINR(r.totalTax)}`,
        ]),
        foot: [['', 'Total', '', '', `₹${formatINR(totals.taxable)}`, `₹${formatINR(totals.igst)}`, `₹${formatINR(totals.cgst)}`, `₹${formatINR(totals.sgst)}`, `₹${formatINR(totals.totalTax)}`]],
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [55, 65, 81], textColor: [255, 255, 255], fontStyle: 'bold' },
        footStyles: { fillColor: [245, 245, 245], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `gst-summary-${fyYear}.pdf` };
    } catch (e) { console.error('PDF', e); return null; }
  }

  async function handleViewPdf() {
    if (rows.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
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
    if (rows.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, 'GST Summary');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  return (
    <div className="rl-screen drill-in">

      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">GST <em>summary</em></h1>
        <button
          className="rl-icon-btn"
          onClick={handleViewPdf}
          disabled={pdfBusy || rows.length === 0}
          aria-label="PDF preview"
          style={{ color: rows.length && !pdfBusy ? 'var(--c-primary)' : undefined }}
        >
          <PdfIcon />
        </button>
        <button
          className="rl-icon-btn"
          onClick={handleSharePdf}
          disabled={pdfBusy || rows.length === 0}
          aria-label="Share PDF"
        >
          <ShareIcon />
        </button>
      </div>

      {/* ── FY navigator ── */}
      <div className="rl-fy-row">
        <button
          className="rl-fy-btn"
          onClick={() => setFyOffset((o) => o - 1)}
          aria-label="Previous FY"
        >
          <ChevLSmall />
        </button>
        <span className="rl-fy-label">{fyLabel(fyYear)}</span>
        <button
          className="rl-fy-btn"
          onClick={() => setFyOffset((o) => o + 1)}
          disabled={fyOffset >= 0}
          aria-label="Next FY"
          style={{ opacity: fyOffset >= 0 ? 0.3 : 1 }}
        >
          <ChevRSmall />
        </button>
      </div>

      {/* ── List ── */}
      <div className="rl-list">
        {loading && <SkeletonRows />}

        {!loading && rows.length === 0 && (
          <div className="rl-empty">No data for this period</div>
        )}

        {!loading && rows.map((row, i) => (
          <HsnRow key={row.hsn_code || i} row={row} />
        ))}
      </div>

      {/* ── Sticky footer ── */}
      {!loading && rows.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">
            {rows.length} HSN  ·  Tax ₹{formatINR(totals.totalTax)}
          </span>
          <span className="rl-footer-total">₹{formatINR(totals.taxable)}</span>
        </div>
      )}

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">GST Summary</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `gst-summary-${fyYear}.pdf`, 'GST Summary');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="GST Summary PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── HSN row ─────────────────────────────────────────────────────────────
function HsnRow({ row }) {
  const hasBothGST = row.cgst > 0 || row.sgst > 0;
  const hasIGST    = row.igst > 0;
  return (
    <div className="rl-row" style={{ cursor: 'default' }}>
      <div className="rl-row-main">
        <div className="rl-row-party" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>{row.hsn_code || '—'}</span>
          {row.rate !== '' && (
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '1px 6px',
              background: 'var(--c-info-soft)', color: 'var(--c-info)',
              borderRadius: 99,
            }}>{row.rate}%</span>
          )}
        </div>
        {row.description && (
          <div className="rl-row-meta" style={{ marginTop: 2 }}>{row.description}</div>
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
          {hasIGST && (
            <span style={{
              fontSize: 10, padding: '2px 6px',
              background: 'var(--c-primary-soft)', color: 'var(--c-primary)',
              borderRadius: 6, fontWeight: 500,
            }}>IGST ₹{formatINR(row.igst)}</span>
          )}
          {hasBothGST && (
            <>
              <span style={{
                fontSize: 10, padding: '2px 6px',
                background: 'var(--c-success-soft)', color: 'var(--c-success)',
                borderRadius: 6, fontWeight: 500,
              }}>CGST ₹{formatINR(row.cgst)}</span>
              <span style={{
                fontSize: 10, padding: '2px 6px',
                background: 'var(--c-success-soft)', color: 'var(--c-success)',
                borderRadius: 6, fontWeight: 500,
              }}>SGST ₹{formatINR(row.sgst)}</span>
            </>
          )}
        </div>
      </div>
      <div className="rl-row-side">
        <div className="rl-row-amount">₹{formatINR(row.taxable)}</div>
        <div style={{ fontSize: 10, color: 'var(--c-text-mute)' }}>taxable</div>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[70, 55, 80, 60, 75].map((w, i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 13, width: `${w}%`, marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 10, width: '45%', marginBottom: 6 }} />
            <div style={{ display: 'flex', gap: 4 }}>
              <div className="rl-skel" style={{ height: 18, width: 60, borderRadius: 6 }} />
              <div className="rl-skel" style={{ height: 18, width: 60, borderRadius: 6 }} />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div className="rl-skel" style={{ height: 15, width: 72 }} />
            <div className="rl-skel" style={{ height: 10, width: 40 }} />
          </div>
        </div>
      ))}
    </>
  );
}
