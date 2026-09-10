import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, isoDate } from '../utils/format';
import { useBack } from '../utils/useBack';
import { shareViaNative } from '../utils/sharePdf';
import './ReportList.css';
import { friendlyError } from '../utils/offlineSnapshot';

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

// ── Month helpers ──────────────────────────────────────────────────────
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}
function prevMonth(year, month) {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}
function nextMonth(year, month) {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

// ── Section definitions ────────────────────────────────────────────────
const SECTIONS = [
  { key: 'b2b',  label: 'B2B — Registered'  },
  { key: 'b2cl', label: 'B2C — Large'        },
  { key: 'b2cs', label: 'B2C — Small'        },
  { key: 'nil',  label: 'Nil / Exempt'        },
  { key: 'hsn',  label: 'HSN Summary'         },
  { key: 'cdnr', label: 'Credit Notes (Reg)' },
];

function extractGrand(data) {
  const g = data?.grand || data?.rows?.[0] || {};
  return {
    invoice_count: Number(g.invoice_count ?? g.count ?? 0),
    taxable:       Number(g.taxable ?? g.taxable_value ?? 0),
    igst:          Number(g.igst ?? 0),
    cgst:          Number(g.cgst ?? 0),
    sgst:          Number(g.sgst ?? 0),
    total:         Number(g.total ?? g.total_tax ?? 0),
  };
}

// ── Component ──────────────────────────────────────────────────────────
export default function Gstr1Mobile() {
  const goBack = useBack('/reports');
  const now    = new Date();
  const [period,  setPeriod]  = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [rawData, setRawData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfUrl,  setPdfUrl]  = useState(null);
  const pdfUrlRef = useRef(null);

  const { year, month } = period;
  const fromDate = isoDate(new Date(year, month - 1, 1));
  const toDate   = isoDate(new Date(year, month, 0));  // last day of month

  // Cleanup on unmount
  useEffect(() => {
    return () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); };
  }, []);

  // Load data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reportAPI.getGstr1({ from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        setRawData(res.data || {});
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load GSTR-1') });
        setRawData({});
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  const sections = useMemo(() => {
    if (!rawData) return [];
    return SECTIONS.map((s) => ({
      ...s,
      grand: extractGrand(rawData[s.key]),
    }));
  }, [rawData]);

  const grandTotal = useMemo(() => ({
    invoice_count: sections.reduce((a, s) => a + s.grand.invoice_count, 0),
    taxable:       sections.reduce((a, s) => a + s.grand.taxable, 0),
    igst:          sections.reduce((a, s) => a + s.grand.igst, 0),
    cgst:          sections.reduce((a, s) => a + s.grand.cgst, 0),
    sgst:          sections.reduce((a, s) => a + s.grand.sgst, 0),
    total:         sections.reduce((a, s) => a + (s.grand.total || s.grand.igst + s.grand.cgst + s.grand.sgst), 0),
  }), [sections]);

  const hasData = sections.some((s) => s.grand.taxable > 0 || s.grand.invoice_count > 0);

  async function generatePdf() {
    if (!hasData) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('GSTR-1 Summary', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(monthLabel(year, month), 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Section', 'Invoices', 'Taxable', 'IGST', 'CGST', 'SGST', 'Total']],
        body: sections.map((s) => [
          s.label,
          s.grand.invoice_count || '',
          `₹${formatINR(s.grand.taxable)}`,
          `₹${formatINR(s.grand.igst)}`,
          `₹${formatINR(s.grand.cgst)}`,
          `₹${formatINR(s.grand.sgst)}`,
          `₹${formatINR(s.grand.total || (s.grand.igst + s.grand.cgst + s.grand.sgst))}`,
        ]),
        foot: [[
          'Grand Total',
          grandTotal.invoice_count || '',
          `₹${formatINR(grandTotal.taxable)}`,
          `₹${formatINR(grandTotal.igst)}`,
          `₹${formatINR(grandTotal.cgst)}`,
          `₹${formatINR(grandTotal.sgst)}`,
          `₹${formatINR(grandTotal.total)}`,
        ]],
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [55, 65, 81], textColor: [255, 255, 255], fontStyle: 'bold' },
        footStyles: { fillColor: [245, 245, 245], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `gstr1-${year}-${String(month).padStart(2, '0')}.pdf` };
    } catch (e) { console.error('PDF', e); return null; }
  }

  async function handleViewPdf() {
    if (!hasData) { Toast.show({ content: 'Nothing to export' }); return; }
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
    if (!hasData) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, 'GSTR-1 Summary');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  const pdfFileName = `gstr1-${year}-${String(month).padStart(2, '0')}.pdf`;

  return (
    <div className="rl-screen drill-in">

      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">GSTR-1</h1>
        <button
          className="rl-icon-btn"
          onClick={handleViewPdf}
          disabled={pdfBusy || !hasData}
          aria-label="PDF preview"
          style={{ color: hasData && !pdfBusy ? 'var(--c-primary)' : undefined }}
        >
          <PdfIcon />
        </button>
        <button
          className="rl-icon-btn"
          onClick={handleSharePdf}
          disabled={pdfBusy || !hasData}
          aria-label="Share PDF"
        >
          <ShareIcon />
        </button>
      </div>

      {/* ── Month picker ── */}
      <div className="rl-fy-row">
        <button
          className="rl-fy-btn"
          onClick={() => setPeriod((p) => prevMonth(p.year, p.month))}
          aria-label="Previous month"
        >
          <ChevLSmall />
        </button>
        <span className="rl-fy-label" style={{ minWidth: 120 }}>{monthLabel(year, month)}</span>
        <button
          className="rl-fy-btn"
          onClick={() => setPeriod((p) => nextMonth(p.year, p.month))}
          aria-label="Next month"
        >
          <ChevRSmall />
        </button>
      </div>

      {/* ── List ── */}
      <div className="rl-list">
        {loading && <SkeletonCards />}

        {!loading && !hasData && (
          <div className="rl-empty">No data for this period</div>
        )}

        {!loading && hasData && (
          <>
            {sections.map((s) => (
              <SectionCard key={s.key} section={s} />
            ))}

            {/* Grand total card */}
            <div style={{
              margin: '14px 14px 0',
              background: 'var(--c-primary-soft)',
              border: '1px solid var(--c-primary)',
              borderRadius: 10,
              padding: '12px 14px',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c-primary)', marginBottom: 8 }}>
                Grand Total
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--c-text-soft)' }}>
                  {grandTotal.invoice_count > 0 ? `${grandTotal.invoice_count} invoices` : '—'}
                </span>
                <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--c-primary)', fontVariantNumeric: 'tabular-nums' }}>
                  ₹{formatINR(grandTotal.taxable)}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--c-text-mute)' }}>
                Tax: ₹{formatINR(grandTotal.total || (grandTotal.igst + grandTotal.cgst + grandTotal.sgst))}
                {grandTotal.igst > 0 && <span>  IGST ₹{formatINR(grandTotal.igst)}</span>}
                {grandTotal.cgst > 0 && <span>  CGST ₹{formatINR(grandTotal.cgst)}</span>}
                {grandTotal.sgst > 0 && <span>  SGST ₹{formatINR(grandTotal.sgst)}</span>}
              </div>
            </div>
            {/* padding at bottom */}
            <div style={{ height: 20 }} />
          </>
        )}
      </div>

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">GSTR-1</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, pdfFileName, 'GSTR-1 Summary');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="GSTR-1 PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section card ────────────────────────────────────────────────────────
function SectionCard({ section }) {
  const { label, grand } = section;
  const tax = grand.total || (grand.igst + grand.cgst + grand.sgst);
  const empty = grand.taxable === 0 && grand.invoice_count === 0;
  return (
    <div style={{
      margin: '14px 14px 0',
      background: 'var(--c-bg-surface)',
      border: '1px solid var(--c-border)',
      borderRadius: 10,
      padding: '12px 14px',
      opacity: empty ? 0.55 : 1,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c-text-mute)', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--c-text-soft)' }}>
          {grand.invoice_count > 0 ? `${grand.invoice_count} invoices` : '—'}
        </span>
        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
          {empty ? '—' : `₹${formatINR(grand.taxable)}`}
        </span>
      </div>
      {!empty && (
        <div style={{ fontSize: 11, color: 'var(--c-text-mute)' }}>
          Tax: ₹{formatINR(tax)}
          {grand.igst > 0 && <span>  IGST ₹{formatINR(grand.igst)}</span>}
          {grand.cgst > 0 && <span>  CGST ₹{formatINR(grand.cgst)}</span>}
          {grand.sgst > 0 && <span>  SGST ₹{formatINR(grand.sgst)}</span>}
        </div>
      )}
    </div>
  );
}

function SkeletonCards() {
  return (
    <>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} style={{ margin: '14px 14px 0', padding: '12px 14px', background: 'var(--c-bg-surface)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
          <div className="rl-skel" style={{ height: 11, width: '45%', marginBottom: 10 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div className="rl-skel" style={{ height: 12, width: '30%' }} />
            <div className="rl-skel" style={{ height: 16, width: 80 }} />
          </div>
          <div className="rl-skel" style={{ height: 10, width: '60%' }} />
        </div>
      ))}
    </>
  );
}
