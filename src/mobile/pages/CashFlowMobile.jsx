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

// ── Normalize month row ────────────────────────────────────────────────
function normalizeMonth(m) {
  const inflow  = Number(m.inflow  ?? m.receipts  ?? m.cash_in  ?? 0);
  const outflow = Number(m.outflow ?? m.payments  ?? m.cash_out ?? 0);
  const net     = Number(m.net     ?? m.net_flow  ?? (inflow - outflow));
  const label   = m.month_label   || m.month      || m.period   || '';
  return { ...m, inflow, outflow, net, label };
}

// Format month label nicely: "2025-04" → "Apr '25", or pass through if already a string
function formatMonthLabel(raw) {
  if (!raw) return '—';
  // If ISO-style "YYYY-MM" or "YYYY-MM-DD"
  const m = raw.match(/^(\d{4})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    const mon = d.toLocaleString('en-IN', { month: 'short' });
    return `${mon} '${String(m[1]).slice(2)}`;
  }
  return raw;
}

// ── Component ──────────────────────────────────────────────────────────
export default function CashFlowMobile() {
  const goBack  = useBack('/reports');
  const baseFy  = currentFyYear();
  const [fyOffset, setFyOffset] = useState(0);
  const [months,   setMonths]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [pdfBusy,  setPdfBusy]  = useState(false);
  const [pdfUrl,   setPdfUrl]   = useState(null);
  const pdfUrlRef = useRef(null);

  const fyYear   = baseFy + fyOffset;
  const fy       = fyForYear(fyYear);
  const fromDate = isoDate(fy.from);
  const toDate   = isoDate(fy.to);

  useEffect(() => {
    return () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reportAPI.cashFlowMonthly({ from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        const raw = res.data?.months || (Array.isArray(res.data) ? res.data : []);
        setMonths((Array.isArray(raw) ? raw : []).map(normalizeMonth));
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load cash flow' });
        setMonths([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  const totals = useMemo(() => ({
    inflow:  months.reduce((s, m) => s + m.inflow, 0),
    outflow: months.reduce((s, m) => s + m.outflow, 0),
    net:     months.reduce((s, m) => s + m.net, 0),
  }), [months]);

  async function generatePdf() {
    if (months.length === 0) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('Cash Flow — Monthly', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${fyLabel(fyYear)}  ·  ${months.length} months`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Month', 'Receipts', 'Payments', 'Net']],
        body: months.map((m) => [
          formatMonthLabel(m.label),
          `₹${formatINR(m.inflow)}`,
          `₹${formatINR(m.outflow)}`,
          `₹${formatINR(m.net)}`,
        ]),
        foot: [['Total', `₹${formatINR(totals.inflow)}`, `₹${formatINR(totals.outflow)}`, `₹${formatINR(totals.net)}`]],
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [55, 65, 81], textColor: [255, 255, 255], fontStyle: 'bold' },
        footStyles: { fillColor: [245, 245, 245], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `cash-flow-${fyYear}.pdf` };
    } catch (e) { console.error('PDF', e); return null; }
  }

  async function handleViewPdf() {
    if (months.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
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
    if (months.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, 'Cash Flow');
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
        <h1 className="rl-title">Cash <em>flow</em></h1>
        <button
          className="rl-icon-btn"
          onClick={handleViewPdf}
          disabled={pdfBusy || months.length === 0}
          aria-label="PDF preview"
          style={{ color: months.length && !pdfBusy ? 'var(--c-primary)' : undefined }}
        >
          <PdfIcon />
        </button>
        <button
          className="rl-icon-btn"
          onClick={handleSharePdf}
          disabled={pdfBusy || months.length === 0}
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

        {!loading && months.length === 0 && (
          <div className="rl-empty">No data for this period</div>
        )}

        {!loading && months.map((m, i) => (
          <MonthRow key={m.label || i} month={m} />
        ))}
      </div>

      {/* ── Sticky footer ── */}
      {!loading && months.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">
            In ₹{formatINR(totals.inflow)}  ·  Out ₹{formatINR(totals.outflow)}
          </span>
          <span
            className="rl-footer-total"
            style={{ color: totals.net >= 0 ? 'var(--c-success)' : 'var(--c-error)' }}
          >
            ₹{formatINR(totals.net)}
          </span>
        </div>
      )}

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Cash Flow</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `cash-flow-${fyYear}.pdf`, 'Cash Flow');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="Cash Flow PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Month row ───────────────────────────────────────────────────────────
function MonthRow({ month }) {
  const netColor = month.net > 0
    ? 'var(--c-success)'
    : month.net < 0
      ? 'var(--c-error)'
      : 'var(--c-text)';
  return (
    <div className="rl-row" style={{ cursor: 'default' }}>
      <div className="rl-row-main">
        <div className="rl-row-party">{formatMonthLabel(month.label)}</div>
        <div className="rl-row-meta">
          <span style={{ color: 'var(--c-success)' }}>In ₹{formatINR(month.inflow)}</span>
          <span className="rl-meta-dot">·</span>
          <span style={{ color: 'var(--c-error)' }}>Out ₹{formatINR(month.outflow)}</span>
        </div>
      </div>
      <div className="rl-row-side">
        <div className="rl-row-amount" style={{ color: netColor }}>
          {month.net >= 0 ? '+' : ''}₹{formatINR(Math.abs(month.net))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--c-text-mute)' }}>net</div>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 13, width: '35%', marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 10, width: '55%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div className="rl-skel" style={{ height: 15, width: 72 }} />
            <div className="rl-skel" style={{ height: 10, width: 24 }} />
          </div>
        </div>
      ))}
    </>
  );
}
