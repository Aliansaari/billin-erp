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

// ── Component ──────────────────────────────────────────────────────────
export default function Gstr3bMobile() {
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
  const toDate   = isoDate(new Date(year, month, 0));

  useEffect(() => {
    return () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reportAPI.getGstr3b({ from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        setRawData(res.data || {});
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load GSTR-3B') });
        setRawData({});
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  const parsed = useMemo(() => {
    if (!rawData) return null;
    const s31 = rawData.s31 || {};
    const outward      = s31.taxable_outward || [];
    const totalOutward = s31.total_outward_tax || { igst: 0, cgst: 0, sgst: 0 };
    const totalTaxable = outward.reduce((s, r) => s + Number(r.taxable ?? 0), 0);

    const s4       = rawData.s4 || {};
    const itcTotal = s4.C_net_available || s4.A_total || { igst: 0, cgst: 0, sgst: 0 };

    const s61     = rawData.s61 || {};
    const igstPay = s61.igst || { tax_payable: 0, paid_via_itc: 0, paid_via_cash: 0 };
    const cgstPay = s61.cgst || { tax_payable: 0, paid_via_itc: 0, paid_via_cash: 0 };
    const sgstPay = s61.sgst || { tax_payable: 0, paid_via_itc: 0, paid_via_cash: 0 };

    const netPayable =
      Number(igstPay.tax_payable ?? 0) +
      Number(cgstPay.tax_payable ?? 0) +
      Number(sgstPay.tax_payable ?? 0);

    return {
      totalTaxable,
      totalOutwardTax: Number(totalOutward.igst ?? 0) + Number(totalOutward.cgst ?? 0) + Number(totalOutward.sgst ?? 0),
      totalOutward,
      itcIgst:   Number(itcTotal.igst ?? 0),
      itcCgst:   Number(itcTotal.cgst ?? 0),
      itcSgst:   Number(itcTotal.sgst ?? 0),
      itcTotal:  Number(itcTotal.igst ?? 0) + Number(itcTotal.cgst ?? 0) + Number(itcTotal.sgst ?? 0),
      igstPay,
      cgstPay,
      sgstPay,
      netPayable,
      outward,
      s4itcRows: s4.A || [],
    };
  }, [rawData]);

  const hasData = parsed && (parsed.totalTaxable > 0 || parsed.itcTotal > 0 || parsed.netPayable > 0);

  async function generatePdf() {
    if (!parsed || !hasData) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('GSTR-3B Summary', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(monthLabel(year, month), 40, 56);

      const tableBody = [
        ['3.1 Output Tax', 'Taxable Value', '', '', '', `₹${formatINR(parsed.totalTaxable)}`],
        ['3.1 Output Tax', 'IGST', `₹${formatINR(parsed.totalOutward.igst)}`, `₹${formatINR(parsed.totalOutward.cgst)}`, `₹${formatINR(parsed.totalOutward.sgst)}`, `₹${formatINR(parsed.totalOutwardTax)}`],
        ['4 ITC Available', 'Net ITC', `₹${formatINR(parsed.itcIgst)}`, `₹${formatINR(parsed.itcCgst)}`, `₹${formatINR(parsed.itcSgst)}`, `₹${formatINR(parsed.itcTotal)}`],
        ['6.1 Tax Payable', 'IGST', `₹${formatINR(parsed.igstPay.tax_payable)}`, '', '', ''],
        ['6.1 Tax Payable', 'CGST', '', `₹${formatINR(parsed.cgstPay.tax_payable)}`, '', ''],
        ['6.1 Tax Payable', 'SGST', '', '', `₹${formatINR(parsed.sgstPay.tax_payable)}`, ''],
        ['6.1 Tax Payable', 'Net Payable', '', '', '', `₹${formatINR(parsed.netPayable)}`],
      ];
      autoTable(doc, {
        startY: 72,
        head: [['Section', 'Label', 'IGST', 'CGST', 'SGST', 'Total']],
        body: tableBody,
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [55, 65, 81], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `gstr3b-${year}-${String(month).padStart(2, '0')}.pdf` };
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
      const ok = await shareViaNative(result.blob, result.fileName, 'GSTR-3B Summary');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  const pdfFileName = `gstr3b-${year}-${String(month).padStart(2, '0')}.pdf`;

  return (
    <div className="rl-screen drill-in">

      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">GSTR-3B</h1>
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

        {!loading && hasData && parsed && (
          <>
            {/* Section 3.1 — Output Tax */}
            <SectionCard title="3.1 — Output Tax" accent="var(--c-primary)">
              <CardRow label="Taxable Value" value={`₹${formatINR(parsed.totalTaxable)}`} />
              <CardRow label="IGST" value={`₹${formatINR(parsed.totalOutward.igst ?? 0)}`} />
              <CardRow label="CGST" value={`₹${formatINR(parsed.totalOutward.cgst ?? 0)}`} />
              <CardRow label="SGST" value={`₹${formatINR(parsed.totalOutward.sgst ?? 0)}`} />
              <CardRow label="Total Tax" value={`₹${formatINR(parsed.totalOutwardTax)}`} bold />
            </SectionCard>

            {/* Section 4 — ITC */}
            <SectionCard title="4 — Input Tax Credit" accent="var(--c-success)">
              <CardRow label="IGST" value={`₹${formatINR(parsed.itcIgst)}`} />
              <CardRow label="CGST" value={`₹${formatINR(parsed.itcCgst)}`} />
              <CardRow label="SGST" value={`₹${formatINR(parsed.itcSgst)}`} />
              <CardRow label="Net ITC Available" value={`₹${formatINR(parsed.itcTotal)}`} bold />
            </SectionCard>

            {/* Section 6.1 — Net Payable */}
            <SectionCard title="6.1 — Net Tax Payable" accent={parsed.netPayable > 0 ? 'var(--c-error)' : 'var(--c-success)'}>
              <PayRow label="IGST" data={parsed.igstPay} />
              <PayRow label="CGST" data={parsed.cgstPay} />
              <PayRow label="SGST" data={parsed.sgstPay} />
              <div style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: '1px solid var(--c-border-soft)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-soft)' }}>Net Payable</span>
                <span style={{
                  fontSize: 18, fontWeight: 800,
                  color: parsed.netPayable > 0 ? 'var(--c-error)' : 'var(--c-success)',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  ₹{formatINR(parsed.netPayable)}
                </span>
              </div>
            </SectionCard>

            <div style={{ height: 20 }} />
          </>
        )}
      </div>

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">GSTR-3B</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, pdfFileName, 'GSTR-3B Summary');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="GSTR-3B PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section card ────────────────────────────────────────────────────────
function SectionCard({ title, accent, children }) {
  return (
    <div style={{
      margin: '14px 14px 0',
      background: 'var(--c-bg-surface)',
      border: `1px solid var(--c-border)`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 10,
      padding: '12px 14px',
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: accent, marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function CardRow({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--c-text-soft)', fontWeight: bold ? 600 : 400 }}>{label}</span>
      <span style={{
        fontSize: bold ? 14 : 12, fontWeight: bold ? 700 : 500,
        color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums',
      }}>{value}</span>
    </div>
  );
}

function PayRow({ label, data }) {
  const payable = Number(data.tax_payable ?? 0);
  const itc     = Number(data.paid_via_itc ?? 0);
  const cash    = Number(data.paid_via_cash ?? 0);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text)' }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: payable > 0 ? 'var(--c-error)' : 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
          ₹{formatINR(payable)}
        </span>
      </div>
      {(itc > 0 || cash > 0) && (
        <div style={{ fontSize: 10, color: 'var(--c-text-mute)', display: 'flex', gap: 8 }}>
          {itc > 0  && <span>ITC ₹{formatINR(itc)}</span>}
          {cash > 0 && <span>Cash ₹{formatINR(cash)}</span>}
        </div>
      )}
    </div>
  );
}

function SkeletonCards() {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ margin: '14px 14px 0', padding: '12px 14px', background: 'var(--c-bg-surface)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
          <div className="rl-skel" style={{ height: 11, width: '40%', marginBottom: 12 }} />
          {[1, 2, 3].map((j) => (
            <div key={j} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <div className="rl-skel" style={{ height: 11, width: '35%' }} />
              <div className="rl-skel" style={{ height: 11, width: '25%' }} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
