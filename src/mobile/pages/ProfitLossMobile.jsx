import React, { useEffect, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, defaultFY, isoDate } from '../utils/format';
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

// ── FY helpers ─────────────────────────────────────────────────────────
function fyDates(offset = 0) {
  const base = defaultFY();
  const ms = offset * 365 * 24 * 60 * 60 * 1000;
  return {
    from: new Date(base.from.getTime() + ms),
    to:   new Date(base.to.getTime()   + ms),
  };
}
function fyLabel(offset = 0) {
  const { from } = fyDates(offset);
  const y = from.getFullYear();
  return `FY ${y}-${String(y + 1).slice(2)}`;
}

// ── Sub-row ────────────────────────────────────────────────────────────
function SubRow({ label, amount, suffix }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}>
      <span style={{ flex: 1, fontSize: 12.5, color: 'var(--c-text-soft)', minWidth: 0, paddingRight: 8 }}>
        {label}
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        ₹{formatINR(amount)}{suffix ? ` ${suffix}` : ''}
      </span>
    </div>
  );
}

// ── Section card ───────────────────────────────────────────────────────
function SectionCard({ title, total, children, accentColor }) {
  return (
    <div style={{
      background: 'var(--c-bg-surface)',
      border: '1px solid var(--c-border)',
      borderRadius: 10,
      padding: '12px 14px',
      margin: '0 14px 10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: children ? 8 : 0 }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--c-text)' }}>
          {title}
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: accentColor || 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
          ₹{formatINR(total)}
        </span>
      </div>
      {children && (
        <div style={{ borderTop: '1px solid var(--c-border-soft)', paddingTop: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────
export default function ProfitLossMobile() {
  const goBack = useBack('/reports');
  const [fyOffset, setFyOffset] = useState(0);
  const [pl,      setPl]      = useState(null);
  const [loading, setLoading] = useState(true);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfUrl,  setPdfUrl]  = useState(null);
  const pdfUrlRef = useRef(null);

  const { from, to } = fyDates(fyOffset);
  const fromIso = isoDate(from);
  const toIso   = isoDate(to);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPl(null);
    reportAPI.profitLoss({ from_date: fromIso, to_date: toIso })
      .then((res) => {
        if (cancelled) return;
        setPl(res.data?.current || res.data);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load P&L') });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromIso, toIso]);

  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, []);

  // Extract figures
  const salesNet      = Number(pl?.credit?.sales_accounts?.net       || 0);
  const closingStock  = Number(pl?.credit?.closing_stock             || 0);
  const openingStock  = Number(pl?.debit?.opening_stock              || 0);
  const purchaseNet   = Number(pl?.debit?.purchase_accounts?.net     || 0);
  const directIncome  = Number(pl?.credit?.direct_income?.total      || 0);
  const directExp     = Number(pl?.debit?.direct_expenses?.total     || 0);
  const indirectIncome = Number(pl?.credit?.indirect_income?.total   || 0);
  const indirectExp   = Number(pl?.debit?.indirect_expenses?.total   || 0);
  const netProfit     = Number(pl?.debit?.net_profit                 || 0);
  const netLoss       = Number(pl?.credit?.net_loss                  || 0);
  const isProfit      = netProfit > 0 || (netProfit === 0 && netLoss === 0);
  const netResult     = isProfit ? netProfit : netLoss;

  const cogs         = openingStock + purchaseNet - closingStock;
  const totalIncome  = salesNet + directIncome + indirectIncome;
  const totalExpenses = cogs + directExp + indirectExp;

  const hasData = pl !== null;

  async function generatePdf() {
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('Profit & Loss Statement', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${fyLabel(fyOffset)}  ·  ${fromIso} to ${toIso}`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Category', 'Amount (₹)']],
        body: [
          ['INCOME', ''],
          ['  Sales Revenue', formatINR(salesNet)],
          ['  Direct Income', formatINR(directIncome)],
          ['  Indirect Income', formatINR(indirectIncome)],
          ['Total Income', formatINR(totalIncome)],
          ['', ''],
          ['EXPENSES', ''],
          ['  Opening Stock', formatINR(openingStock)],
          ['  Purchases', formatINR(purchaseNet)],
          ['  Closing Stock', `(${formatINR(closingStock)})`],
          ['  Cost of Goods Sold', formatINR(cogs)],
          ['  Direct Expenses', formatINR(directExp)],
          ['  Indirect Expenses', formatINR(indirectExp)],
          ['Total Expenses', formatINR(totalExpenses)],
          ['', ''],
          [isProfit ? 'NET PROFIT' : 'NET LOSS', formatINR(netResult)],
        ],
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [8, 145, 168], textColor: [255, 255, 255], fontStyle: 'bold' },
        columnStyles: { 1: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `profit-loss-${fromIso}_${toIso}.pdf` };
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
      const ok = await shareViaNative(result.blob, result.fileName, 'Profit & Loss');
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
        <h1 className="rl-title">Profit <em>& loss</em></h1>
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

      {/* ── FY navigator ── */}
      <div className="rl-fy-row">
        <button className="rl-fy-btn" onClick={() => setFyOffset((v) => v - 1)} aria-label="Previous FY">
          <ChevLSmall />
        </button>
        <span className="rl-fy-label">{fyLabel(fyOffset)}</span>
        <button className="rl-fy-btn" onClick={() => setFyOffset((v) => v + 1)} aria-label="Next FY">
          <ChevRSmall />
        </button>
      </div>

      {/* ── Content ── */}
      <div className="rl-list" style={{ background: 'var(--c-bg-app)' }}>
        {loading && <div className="rl-empty">Loading…</div>}

        {!loading && !hasData && (
          <div className="rl-empty">No P&L data for {fyLabel(fyOffset)}</div>
        )}

        {!loading && hasData && (
          <>
            {/* Income section */}
            <div style={{ height: 12 }} />
            <SectionCard
              title="Income"
              total={totalIncome}
              accentColor="var(--c-success)"
            >
              <SubRow label="Sales Revenue" amount={salesNet} />
              {directIncome > 0 && <SubRow label="Direct Income" amount={directIncome} />}
              {indirectIncome > 0 && <SubRow label="Indirect Income" amount={indirectIncome} />}
            </SectionCard>

            {/* Expenses section */}
            <SectionCard
              title="Expenses"
              total={totalExpenses}
              accentColor="var(--c-error)"
            >
              <SubRow label="Opening Stock" amount={openingStock} />
              <SubRow label="Purchases" amount={purchaseNet} />
              {closingStock > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0' }}>
                  <span style={{ flex: 1, fontSize: 12.5, color: 'var(--c-text-soft)', paddingRight: 8 }}>
                    Closing Stock
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--c-success)', fontVariantNumeric: 'tabular-nums' }}>
                    (₹{formatINR(closingStock)})
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', padding: '5px 0', borderTop: '1px dashed var(--c-border-soft)', marginTop: 2 }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--c-text)', paddingRight: 8 }}>
                  Cost of Goods Sold
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
                  ₹{formatINR(cogs)}
                </span>
              </div>
              {directExp > 0 && <SubRow label="Direct Expenses" amount={directExp} />}
              {indirectExp > 0 && <SubRow label="Indirect Expenses" amount={indirectExp} />}
            </SectionCard>

            {/* Net Result */}
            <div style={{
              margin: '0 14px 24px',
              borderRadius: 12,
              padding: '18px 16px',
              background: isProfit
                ? 'rgba(22,163,74,0.08)'
                : 'rgba(220,38,38,0.08)',
              border: `1px solid ${isProfit ? 'rgba(22,163,74,0.25)' : 'rgba(220,38,38,0.25)'}`,
              display: 'flex',
              alignItems: 'center',
            }}>
              <span style={{ flex: 1, fontSize: 15, fontWeight: 700, color: isProfit ? 'var(--c-success)' : 'var(--c-error)' }}>
                {isProfit ? 'Net Profit' : 'Net Loss'}
              </span>
              <span style={{
                fontSize: 20, fontWeight: 800,
                color: isProfit ? 'var(--c-success)' : 'var(--c-error)',
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '-0.03em',
              }}>
                ₹{formatINR(netResult)}
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Profit & Loss</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `profit-loss-${fromIso}_${toIso}.pdf`, 'Profit & Loss');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe className="rl-pdf-frame" src={pdfUrl} title="Profit & Loss PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
