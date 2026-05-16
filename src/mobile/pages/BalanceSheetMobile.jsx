import React, { useEffect, useRef, useState } from 'react';
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
const ChevDown = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6"/>
  </svg>
);
const ChevUp = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 15l-6-6-6 6"/>
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

// ── Intermediate group mapping (same as desktop BalanceSheet.jsx) ──
const SUB_TO_MID = {
  Assets: {
    'Sundry Debtors':            'Current Assets',
    'Cash-in-Hand':              'Current Assets',
    'Bank Accounts':             'Current Assets',
    'Bank Account':              'Current Assets',
    'Stock-in-Hand':             'Current Assets',
    'Loans & Advances (Asset)':  'Current Assets',
    'Loans and Advances (Asset)':'Current Assets',
    'Deposits (Asset)':          'Current Assets',
    'Other Current Assets':      'Current Assets',
    'Duties & Taxes':            'Current Assets',
    'Input GST':                 'Current Assets',
    'Fixed Assets':              'Fixed Assets',
    'Plant & Machinery':         'Fixed Assets',
    'Furniture & Fixtures':      'Fixed Assets',
    'Vehicles':                  'Fixed Assets',
    'Office Equipment':          'Fixed Assets',
    'Computer & Equipment':      'Fixed Assets',
    'Buildings':                 'Fixed Assets',
    'Land':                      'Fixed Assets',
    'Investments':               'Investments',
    'Misc. Expenses (Asset)':    'Misc. Expenses (Asset)',
  },
  Liabilities: {
    'Sundry Creditors':          'Current Liabilities',
    'Duties & Taxes':            'Current Liabilities',
    'Duties and Taxes':          'Current Liabilities',
    'Output GST':                'Current Liabilities',
    'Provisions':                'Current Liabilities',
    'Other Current Liabilities': 'Current Liabilities',
    'Loans (Liability)':         'Loans (Liability)',
    'Bank OD/CC':                'Loans (Liability)',
    'Bank OD A/c':               'Loans (Liability)',
    'Secured Loans':             'Loans (Liability)',
    'Unsecured Loans':           'Loans (Liability)',
  },
  Capital: {
    "Owner's Capital":           'Capital Account',
    "Owner's Funds":             'Capital Account',
    'Capital':                   'Capital Account',
    'Drawings':                  'Capital Account',
    'Reserves & Surplus':        'Capital Account',
    'Reserves and Surplus':      'Capital Account',
  },
};
function midFor(primarySide, sub) {
  return (SUB_TO_MID[primarySide] && SUB_TO_MID[primarySide][sub]) || sub;
}

const LIAB_ORDER  = ['Capital Account', 'Loans (Liability)', 'Current Liabilities'];
const ASSET_ORDER = ['Fixed Assets', 'Investments', 'Current Assets', 'Misc. Expenses (Asset)'];

// Build intermediate-group tree from raw sub_group array/object.
// Returns [{ name, total, subs: [{ name, total, rows }] }]
function buildSide(rawSubGroups, primarySide, orderHints) {
  if (!rawSubGroups) return [];
  const list = Array.isArray(rawSubGroups) ? rawSubGroups : Object.values(rawSubGroups);
  const buckets = new Map();
  for (const raw of list) {
    if (!raw) continue;
    const subName  = raw.sub_group || raw.name || '(Uncategorised)';
    const subTotal = Number(raw.total) || 0;
    const ledgers  = raw.rows || raw.ledgers || [];
    const mid      = midFor(primarySide, subName);
    if (!buckets.has(mid)) buckets.set(mid, { name: mid, total: 0, subs: [] });
    const b = buckets.get(mid);
    b.subs.push({ name: subName, total: subTotal, rows: ledgers });
    b.total += subTotal;
  }
  const result = [];
  for (const name of orderHints) {
    if (buckets.has(name)) { result.push(buckets.get(name)); buckets.delete(name); }
  }
  for (const rem of [...buckets.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    result.push(rem);
  }
  for (const b of result) b.subs.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

// ── FY helpers ─────────────────────────────────────────────────────────
function fyDates(offset = 0) {
  const base = defaultFY();
  const ms   = offset * 365 * 24 * 60 * 60 * 1000;
  return { from: new Date(base.from.getTime() + ms), to: new Date(base.to.getTime() + ms) };
}
function fyEndLabel(offset = 0) {
  const { to } = fyDates(offset);
  return to.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fyLabel(offset = 0) {
  const { from } = fyDates(offset);
  const y = from.getFullYear();
  return `FY ${y}-${String(y + 1).slice(2)}`;
}

// ── Sub-group card (collapsible) ───────────────────────────────────────
function SubGroupCard({ sub }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      background: 'var(--c-bg-surface)',
      border: '1px solid var(--c-border)',
      borderRadius: 10,
      margin: '0 14px 6px 24px',
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', width: '100%',
          padding: '10px 14px', background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: 'var(--c-text)', minWidth: 0, paddingRight: 8 }}>
          {sub.name}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums', marginRight: 8, whiteSpace: 'nowrap' }}>
          ₹{formatINR(sub.total)}
        </span>
        <span style={{ color: 'var(--c-text-mute)', flexShrink: 0 }}>
          {open ? <ChevUp /> : <ChevDown />}
        </span>
      </button>
      {open && sub.rows && sub.rows.length > 0 && (
        <div style={{ borderTop: '1px solid var(--c-border-soft)' }}>
          {sub.rows.map((r, i) => {
            const balance = Math.abs(Number(r.credit || 0) - Number(r.debit || 0));
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center',
                padding: '7px 14px 7px 18px',
                borderBottom: i < sub.rows.length - 1 ? '1px solid var(--c-border-soft)' : 'none',
              }}>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--c-text-soft)', minWidth: 0, paddingRight: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.ledger_name || '—'}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  ₹{formatINR(balance)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Intermediate group row ─────────────────────────────────────────────
function GroupRow({ group, open, onToggle }) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', width: '100%',
        padding: '9px 14px', margin: 0,
        background: 'var(--c-bg-app)', border: 'none',
        borderBottom: '1px solid var(--c-border-soft)',
        cursor: 'pointer', textAlign: 'left',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ flex: 1, fontSize: 12, fontWeight: 700, color: 'var(--c-text-soft)', textTransform: 'uppercase', letterSpacing: '0.07em', minWidth: 0 }}>
        {group.name}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums', marginRight: 8, whiteSpace: 'nowrap' }}>
        ₹{formatINR(group.total)}
      </span>
      <span style={{ color: 'var(--c-text-mute)', flexShrink: 0 }}>
        {open ? <ChevUp /> : <ChevDown />}
      </span>
    </button>
  );
}

// ── Section header ─────────────────────────────────────────────────────
function SectionHeader({ title, total, accentColor }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '10px 14px 6px',
    }}>
      <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: 'var(--c-text-mute)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
        {title}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: accentColor || 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
        ₹{formatINR(total)}
      </span>
    </div>
  );
}

// ── Synthetic row (P&L A/c, Stock-in-Hand) ────────────────────────────
function SyntheticRow({ label, amount, color }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '10px 14px',
      borderTop: '1px solid var(--c-border-soft)',
      background: 'var(--c-bg-app)',
    }}>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: color || 'var(--c-text)', fontStyle: 'italic' }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
        ₹{formatINR(amount)}
      </span>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────
export default function BalanceSheetMobile() {
  const goBack = useBack('/reports');
  const [fyOffset,  setFyOffset]  = useState(0);
  const [rawData,   setRawData]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [openGroups, setOpenGroups] = useState(new Set());
  const [pdfBusy,   setPdfBusy]   = useState(false);
  const [pdfUrl,    setPdfUrl]    = useState(null);
  const pdfUrlRef = useRef(null);

  const { to } = fyDates(fyOffset);
  const toIso  = isoDate(to);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRawData(null);
    setOpenGroups(new Set());
    reportAPI.balanceSheet({ to_date: toIso })
      .then((res) => {
        if (cancelled) return;
        setRawData(res.data);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load balance sheet' });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [toIso]);

  useEffect(() => () => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
  }, []);

  // ── Build sides (same logic as desktop) ───────────────────────────────
  const sides = (() => {
    if (!rawData) return { liab: [], assets: [], lTotal: 0, aTotal: 0, netProfit: 0, netLoss: 0, stockValue: 0 };
    const liabReal = buildSide(rawData.liabilities?.sub_groups, 'Liabilities', LIAB_ORDER);
    const capital  = buildSide(rawData.liabilities?.capital_sub_groups, 'Capital', ['Capital Account']);
    const liab     = [...capital, ...liabReal];
    const assets   = buildSide(rawData.assets?.sub_groups, 'Assets', ASSET_ORDER);
    const netProfit  = Number(rawData.liabilities?.net_profit) || 0;
    const netLoss    = Number(rawData.assets?.net_loss) || 0;
    const stockValue = Number(rawData.stock_value) || 0;
    const lTotal   = Number(rawData.totals?.total_liabilities) || 0;
    const aTotal   = Number(rawData.totals?.total_assets)      || 0;
    return { liab, assets, lTotal, aTotal, netProfit, netLoss, stockValue };
  })();

  const hasData = sides.liab.length > 0 || sides.assets.length > 0;
  const diff    = Math.abs(sides.lTotal - sides.aTotal);
  const balanced = diff < 0.01;

  function toggleGroup(key) {
    setOpenGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // ── PDF ───────────────────────────────────────────────────────────────
  async function generatePdf() {
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('Balance Sheet', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`As of ${fyEndLabel(fyOffset)}  ·  ${fyLabel(fyOffset)}`, 40, 56);

      // Build side-by-side rows matching desktop layout:
      // Each intermediate group = 1 header row; sub-groups = indented rows; synthetics at bottom
      const liabRows = [];
      for (const g of sides.liab) {
        liabRows.push({ label: g.name, amount: g.total, isGroup: true });
        for (const s of g.subs) liabRows.push({ label: `  ${s.name}`, amount: s.total });
      }
      if (sides.netProfit > 0.01) liabRows.push({ label: 'Profit & Loss A/c', amount: sides.netProfit });

      const assetRows = [];
      for (const g of sides.assets) {
        assetRows.push({ label: g.name, amount: g.total, isGroup: true });
        for (const s of g.subs) assetRows.push({ label: `  ${s.name}`, amount: s.total });
      }
      if (sides.stockValue > 0.01) assetRows.push({ label: 'Stock-in-Hand', amount: sides.stockValue });
      if (sides.netLoss > 0.01)    assetRows.push({ label: 'Net Loss A/c',   amount: sides.netLoss });

      const maxRows = Math.max(liabRows.length, assetRows.length);
      const body = [];
      for (let i = 0; i < maxRows; i++) {
        const l = liabRows[i];
        const a = assetRows[i];
        body.push([
          l ? l.label : '',
          l ? `₹${formatINR(l.amount)}` : '',
          a ? a.label : '',
          a ? `₹${formatINR(a.amount)}` : '',
        ]);
      }
      body.push([
        'TOTAL LIABILITIES', `₹${formatINR(sides.lTotal)}`,
        'TOTAL ASSETS',      `₹${formatINR(sides.aTotal)}`,
      ]);

      autoTable(doc, {
        startY: 72,
        head: [['Liabilities', 'Amount', 'Assets', 'Amount']],
        body,
        styles: { fontSize: 8.5, cellPadding: 4 },
        headStyles: { fillColor: [8, 145, 168], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 252, 253] },
        columnStyles: { 1: { halign: 'right' }, 3: { halign: 'right' } },
        didParseCell: ({ row, cell }) => {
          const isLast = row.index === body.length - 1;
          if (isLast) { cell.styles.fontStyle = 'bold'; cell.styles.fillColor = [230, 245, 248]; }
        },
      });
      return { blob: doc.output('blob'), fileName: `balance-sheet-${toIso}.pdf` };
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
      const ok = await shareViaNative(result.blob, result.fileName, 'Balance Sheet');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  // ── Render a side (array of intermediate groups + optional synthetics) ─
  function renderSide(groups, synthetics, sectionTitle, accentColor, totalAmount) {
    return (
      <>
        <SectionHeader title={sectionTitle} total={totalAmount} accentColor={accentColor} />
        {groups.map((g) => {
          const key = `${sectionTitle}:${g.name}`;
          const open = openGroups.has(key);
          return (
            <div key={key}>
              <GroupRow group={g} open={open} onToggle={() => toggleGroup(key)} />
              {open && g.subs.map((sub) => (
                <SubGroupCard key={sub.name} sub={sub} />
              ))}
            </div>
          );
        })}
        {synthetics.map((s) => (
          <SyntheticRow key={s.label} label={s.label} amount={s.amount} color={s.color} />
        ))}
      </>
    );
  }

  const liabSynthetics = sides.netProfit > 0.01
    ? [{ label: 'Profit & Loss A/c', amount: sides.netProfit, color: 'var(--c-success)' }]
    : [];
  const assetSynthetics = [
    ...(sides.stockValue > 0.01 ? [{ label: 'Stock-in-Hand',  amount: sides.stockValue, color: 'var(--c-primary)' }] : []),
    ...(sides.netLoss   > 0.01  ? [{ label: 'Net Loss A/c',   amount: sides.netLoss,    color: 'var(--c-error)'   }] : []),
  ];

  return (
    <div className="rl-screen drill-in">

      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">Balance <em>sheet</em></h1>
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

      {/* ── Date navigator (as-of FY end) ── */}
      <div className="rl-fy-row">
        <button className="rl-fy-btn" onClick={() => setFyOffset(v => v - 1)} aria-label="Previous year">
          <ChevLSmall />
        </button>
        <span className="rl-fy-label" style={{ minWidth: 140, fontSize: 12 }}>
          As of {fyEndLabel(fyOffset)}
        </span>
        <button className="rl-fy-btn" onClick={() => setFyOffset(v => v + 1)} aria-label="Next year">
          <ChevRSmall />
        </button>
      </div>

      {/* ── Content ── */}
      <div className="rl-list" style={{ background: 'var(--c-bg-app)' }}>
        {loading && <div className="rl-empty">Loading…</div>}

        {!loading && !hasData && (
          <div className="rl-empty">No data as of {fyEndLabel(fyOffset)}</div>
        )}

        {!loading && hasData && (
          <>
            {/* Liabilities */}
            {renderSide(sides.liab, liabSynthetics, 'Liabilities', 'var(--c-error)', sides.lTotal)}

            {/* Divider */}
            <div style={{ height: 8, background: 'var(--c-bg-app)', borderTop: '1px solid var(--c-border-soft)', borderBottom: '1px solid var(--c-border-soft)', margin: '4px 0' }} />

            {/* Assets */}
            {renderSide(sides.assets, assetSynthetics, 'Assets', 'var(--c-success)', sides.aTotal)}

            <div style={{ height: 24 }} />
          </>
        )}
      </div>

      {/* ── Sticky footer ── */}
      {!loading && hasData && (
        <div className="rl-sticky-footer" style={{ flexDirection: 'column', gap: 4, padding: '8px 14px' }}>
          <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--c-text-mute)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Total Liabilities
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-error)', fontVariantNumeric: 'tabular-nums' }}>
                ₹{formatINR(sides.lTotal)}
              </span>
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--c-border-soft)' }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--c-text-mute)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Total Assets
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-success)', fontVariantNumeric: 'tabular-nums' }}>
                ₹{formatINR(sides.aTotal)}
              </span>
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
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
            <span className="rl-pdf-title">Balance Sheet</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `balance-sheet-${toIso}.pdf`, 'Balance Sheet');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe className="rl-pdf-frame" src={pdfUrl} title="Balance Sheet PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
