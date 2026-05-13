import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, defaultFY, isoDate } from '../utils/format';
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

// ── Component ──────────────────────────────────────────────────────────
export default function TrialBalanceMobile() {
  const goBack = useBack('/reports');
  const [fyOffset, setFyOffset] = useState(0);
  const [rows,    setRows]    = useState([]);
  const [totals,  setTotals]  = useState({ debit: 0, credit: 0 });
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
    reportAPI.trialBalance({ from_date: fromIso, to_date: toIso })
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.rows || res.data?.data || [];
        setRows(data);
        const t = res.data?.totals || {
          debit:  data.reduce((s, r) => s + Number(r.debit  || 0), 0),
          credit: data.reduce((s, r) => s + Number(r.credit || 0), 0),
        };
        setTotals(t);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load trial balance' });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromIso, toIso]);

  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, []);

  // Group rows by ledger_group
  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const g = r.ledger_group || 'Other';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(r);
    }
    return [...map.entries()].map(([group, items]) => ({
      group,
      items,
      debit:  items.reduce((s, r) => s + Number(r.debit  || 0), 0),
      credit: items.reduce((s, r) => s + Number(r.credit || 0), 0),
    }));
  }, [rows]);

  const diff = Math.abs(totals.debit - totals.credit);
  const balanced = diff < 0.01;

  async function generatePdf() {
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('Trial Balance', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${fyLabel(fyOffset)}  ·  ${fromIso} to ${toIso}`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Ledger Group', 'Sub-Group', 'Ledger Name', 'Debit (₹)', 'Credit (₹)']],
        body: rows.map((r) => [
          r.ledger_group || '',
          r.sub_group    || '',
          r.ledger_name  || '',
          Number(r.debit  || 0) > 0 ? formatINR(r.debit)  : '',
          Number(r.credit || 0) > 0 ? formatINR(r.credit) : '',
        ]),
        foot: [['', '', 'TOTAL', formatINR(totals.debit), formatINR(totals.credit)]],
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [8, 145, 168], textColor: [255, 255, 255], fontStyle: 'bold' },
        footStyles: { fillColor: [240, 240, 240], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 252, 253] },
        columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `trial-balance-${fromIso}_${toIso}.pdf` };
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
      const ok = await shareViaNative(result.blob, result.fileName, 'Trial Balance');
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
        <h1 className="rl-title">Trial <em>balance</em></h1>
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
        <button className="rl-fy-btn" onClick={() => setFyOffset((v) => v - 1)} aria-label="Previous FY">
          <ChevLSmall />
        </button>
        <span className="rl-fy-label">{fyLabel(fyOffset)}</span>
        <button className="rl-fy-btn" onClick={() => setFyOffset((v) => v + 1)} aria-label="Next FY">
          <ChevRSmall />
        </button>
      </div>

      {/* ── Column header ── */}
      {!loading && rows.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '5px 14px',
          background: 'var(--c-bg-app)',
          borderBottom: '1px solid var(--c-border)',
          flexShrink: 0,
        }}>
          <span style={{ flex: 1, fontSize: 9, fontWeight: 600, color: 'var(--c-text-mute)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Ledger
          </span>
          <span style={{ width: 80, textAlign: 'right', fontSize: 9, fontWeight: 600, color: 'var(--c-text-mute)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Debit
          </span>
          <span style={{ width: 80, textAlign: 'right', fontSize: 9, fontWeight: 600, color: 'var(--c-text-mute)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Credit
          </span>
        </div>
      )}

      {/* ── List ── */}
      <div className="rl-list">
        {loading && <div className="rl-empty">Loading…</div>}

        {!loading && rows.length === 0 && (
          <div className="rl-empty">No data for {fyLabel(fyOffset)}</div>
        )}

        {!loading && grouped.map(({ group, items, debit: gDr, credit: gCr }) => (
          <div key={group}>
            {/* Group header */}
            <div style={{
              padding: '8px 14px',
              background: 'var(--c-bg-app)',
              borderBottom: '1px solid var(--c-border-soft)',
              display: 'flex',
              alignItems: 'center',
            }}>
              <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: 'var(--c-text)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {group}
              </span>
              <span style={{ width: 80, textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--c-text-mute)', fontVariantNumeric: 'tabular-nums' }}>
                {gDr > 0 ? formatINR(gDr) : '—'}
              </span>
              <span style={{ width: 80, textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--c-text-mute)', fontVariantNumeric: 'tabular-nums' }}>
                {gCr > 0 ? formatINR(gCr) : '—'}
              </span>
            </div>

            {/* Ledger rows */}
            {items.map((r, i) => {
              const dr = Number(r.debit  || 0);
              const cr = Number(r.credit || 0);
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center',
                  padding: '9px 14px 9px 20px',
                  borderBottom: '1px solid var(--c-border-soft)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--c-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.ledger_name || '—'}
                    </div>
                    {r.sub_group && (
                      <div style={{ fontSize: 10.5, color: 'var(--c-text-mute)', marginTop: 1 }}>
                        {r.sub_group}
                      </div>
                    )}
                  </div>
                  <span style={{
                    width: 80, textAlign: 'right', fontSize: 13, fontWeight: 600,
                    color: dr > 0 ? 'var(--c-success)' : 'var(--c-border)',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {dr > 0 ? formatINR(dr) : '—'}
                  </span>
                  <span style={{
                    width: 80, textAlign: 'right', fontSize: 13, fontWeight: 600,
                    color: cr > 0 ? 'var(--c-primary)' : 'var(--c-border)',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {cr > 0 ? formatINR(cr) : '—'}
                  </span>
                </div>
              );
            })}

            {/* Sub-total row */}
            <div style={{
              display: 'flex', alignItems: 'center',
              padding: '7px 14px',
              background: 'var(--c-bg-app)',
              borderBottom: '1px solid var(--c-border)',
            }}>
              <span style={{ flex: 1, fontSize: 10, fontWeight: 700, color: 'var(--c-text-soft)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Subtotal — {group}
              </span>
              <span style={{ width: 80, textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
                {gDr > 0 ? formatINR(gDr) : '—'}
              </span>
              <span style={{ width: 80, textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
                {gCr > 0 ? formatINR(gCr) : '—'}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Sticky footer ── */}
      {!loading && rows.length > 0 && (
        <div className="rl-sticky-footer" style={{ flexDirection: 'column', gap: 2, padding: '8px 14px' }}>
          <div style={{ display: 'flex', width: '100%', alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 10, fontWeight: 600, color: 'var(--c-text-mute)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Total Dr
            </span>
            <span style={{ width: 90, textAlign: 'right', fontSize: 13, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
              ₹{formatINR(totals.debit)}
            </span>
            <span style={{ width: 14 }} />
            <span style={{ flex: 1, fontSize: 10, fontWeight: 600, color: 'var(--c-text-mute)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Total Cr
            </span>
            <span style={{ width: 90, textAlign: 'right', fontSize: 13, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
              ₹{formatINR(totals.credit)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            {balanced ? (
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-success)' }}>Balanced ✓</span>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-error)' }}>
                Diff ₹{formatINR(diff)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Trial Balance</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `trial-balance-${fromIso}_${toIso}.pdf`, 'Trial Balance');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe className="rl-pdf-frame" src={pdfUrl} title="Trial Balance PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
