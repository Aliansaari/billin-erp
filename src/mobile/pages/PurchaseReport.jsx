import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, isoDate, defaultFY } from '../utils/format';
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
const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>
);
const ChevR = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l6-6-6-6"/>
  </svg>
);
const SummaryIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
    <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
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

// ── Period presets ─────────────────────────────────────────────────────
function buildPresets() {
  const today = new Date();
  const fy = defaultFY();
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 6);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  return [
    { key: 'today', label: 'Today', from: isoDate(today),     to: isoDate(today) },
    { key: 'week',  label: 'Week',  from: isoDate(weekAgo),    to: isoDate(today) },
    { key: 'month', label: 'Month', from: isoDate(monthStart), to: isoDate(today) },
    { key: 'fy',    label: 'FY',    from: isoDate(fy.from),    to: isoDate(fy.to) },
  ];
}

const PRESETS = buildPresets();
const TODAY = isoDate();

const STATUS_COLORS = {
  Paid:      { bg: '#dcfce7', color: '#166534' },
  Partial:   { bg: '#fef3c7', color: '#92400e' },
  Unpaid:    { bg: '#fee2e2', color: '#991b1b' },
  Cancelled: { bg: '#f1f5f9', color: '#64748b' },
};


function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── Component ──────────────────────────────────────────────────────────
export default function PurchaseReport() {
  const navigate = useNavigate();
  const goBack = useBack('/reports');
  const [urlParams, setUrlParams] = useSearchParams();

  const fy = defaultFY();
  const [fromDate, setFromDate] = useState(() => urlParams.get('from') || isoDate(fy.from));
  const [toDate,   setToDate]   = useState(() => urlParams.get('to')   || isoDate(fy.to));
  const [data,     setData]     = useState([]);
  const [summary,  setSummary]  = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const [preset,   setPreset]   = useState('fy');
  const [showKpi,  setShowKpi]  = useState(false);
  const [pdfBusy,  setPdfBusy]  = useState(false);
  const [pdfUrl,   setPdfUrl]   = useState(null);
  const searchRef = useRef(null);
  const pdfUrlRef = useRef(null);

  useEffect(() => {
    setUrlParams({ from: fromDate, to: toDate }, { replace: true });
  }, [fromDate, toDate, setUrlParams]);

  useEffect(() => {
    if (toDate < fromDate) setToDate(fromDate);
  }, [fromDate, toDate]);

  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn) setSearch('');
  }, [searchOn]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reportAPI.getPurchaseReport({ from_date: fromDate, to_date: toDate, limit: 500 })
      .then((res) => {
        if (cancelled) return;
        const rows = res.data?.data || [];
        setData(rows);
        const totalAmount  = rows.reduce((s, r) => s + Number(r.total_amount  || 0), 0);
        const totalGst     = rows.reduce((s, r) => s + Number(r.cgst_amount || 0) + Number(r.sgst_amount || 0) + Number(r.igst_amount || 0), 0);
        const totalBalance = rows.reduce((s, r) => s + Number(r.balance_amount || 0), 0);
        const paidCount    = rows.filter((r) => r.payment_status === 'Paid').length;
        const partialCount = rows.filter((r) => r.payment_status === 'Partial').length;
        setSummary({
          total_amount: totalAmount,
          bill_count: rows.length,
          total_gst: totalGst,
          total_balance: totalBalance,
          paid_count: paidCount,
          partial_count: partialCount,
          unpaid_count: rows.length - paidCount - partialCount,
          avg_bill: rows.length > 0 ? totalAmount / rows.length : 0,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load purchases') });
        setData([]);
        setSummary(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  function applyPreset(p) {
    setPreset(p.key);
    setFromDate(p.from);
    setToDate(p.to);
  }

  async function generatePdf() {
    if (filtered.length === 0) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('Purchase Report', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${prettyDate(fromDate)} – ${prettyDate(toDate)}  ·  ${filtered.length} bills  ·  ₹${formatINR(filteredTotal)}`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Supplier', 'Bill No', 'Date', 'Amount', 'Status']],
        body: filtered.map((r) => [
          r.supplier?.party_name || r.walk_in_name || '—',
          r.bill_number || r.supplier_bill_number || '',
          prettyDate(r.bill_date),
          `₹${formatINR(r.total_amount)}`,
          r.payment_status || '',
        ]),
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [8, 145, 168], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [240, 248, 252] },
        columnStyles: { 3: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `purchase-report-${fromDate}_${toDate}.pdf` };
    } catch (e) { console.error('PDF', e); return null; }
  }

  async function handleViewPdf() {
    if (filtered.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
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
    if (filtered.length === 0) { Toast.show({ content: 'Nothing to export' }); return; }
    setPdfBusy(true);
    try {
      const result = await generatePdf();
      if (!result) { Toast.show({ icon: 'fail', content: 'PDF failed' }); return; }
      const ok = await shareViaNative(result.blob, result.fileName, 'Purchase Report');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.trim().toLowerCase();
    return data.filter((r) =>
      (r.supplier?.party_name || r.walk_in_name || '').toLowerCase().includes(q) ||
      (r.bill_number              || '').toLowerCase().includes(q) ||
      (r.supplier_bill_number     || '').toLowerCase().includes(q) ||
      (r.supplier?.gstin          || '').toLowerCase().includes(q) ||
      (r.supplier?.city           || '').toLowerCase().includes(q)
    );
  }, [data, search]);

  const filteredTotal = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.total_amount || 0), 0),
    [filtered],
  );

  return (
    <div className="rl-screen drill-in">

      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">Purchase <em>report</em></h1>
        <button
          className={`rl-icon-btn${showKpi ? ' active' : ''}`}
          onClick={() => setShowKpi((v) => !v)}
          aria-label="Toggle summary"
        >
          <SummaryIcon />
        </button>
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

      {/* ── Date range ── */}
      <div className="rl-range">
        <label className="rl-date">
          <span className="rl-date-key">FROM</span>
          <span className="rl-date-val">{prettyDate(fromDate)}</span>
          <input
            type="date" value={fromDate} max={TODAY}
            onChange={(e) => { if (e.target.value) { setFromDate(e.target.value); setPreset(''); } }}
          />
        </label>
        <span className="rl-range-arrow">→</span>
        <label className="rl-date">
          <span className="rl-date-key">TO</span>
          <span className="rl-date-val">{prettyDate(toDate)}</span>
          <input
            type="date" value={toDate} min={fromDate}
            onChange={(e) => { if (e.target.value) { setToDate(e.target.value); setPreset(''); } }}
          />
        </label>
      </div>

      {/* ── Period presets ── */}
      <div className="rl-presets">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className={`rl-preset${preset === p.key ? ' active' : ''}`}
            onClick={() => applyPreset(p)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* ── Search (collapsible) ── */}
      {searchOn && (
        <div className="rl-search">
          <input
            ref={searchRef}
            placeholder="Supplier, bill no, city…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off" autoCapitalize="none" spellCheck="false"
          />
        </div>
      )}

      {/* ── KPI summary (toggleable via ⊞ button) ── */}
      {showKpi && summary && (
        <div className="rl-summary">
          <div className="rl-summary-grid">
            <div className="rl-summary-item">
              <span className="rl-summary-type">Purchase</span>
              <span className="rl-summary-amt">₹{formatINR(summary.total_amount)}</span>
              <span className="rl-summary-cnt">total invoiced</span>
            </div>
            <div className="rl-summary-item">
              <span className="rl-summary-type">GST Input</span>
              <span className="rl-summary-amt">₹{formatINR(summary.total_gst)}</span>
              <span className="rl-summary-cnt">ITC credit</span>
            </div>
            <div className="rl-summary-item">
              <span className="rl-summary-type">Payable</span>
              <span className={`rl-summary-amt${summary.total_balance > 0 ? ' danger' : ''}`}>
                {summary.total_balance > 0 ? `₹${formatINR(summary.total_balance)}` : '—'}
              </span>
              <span className="rl-summary-cnt">outstanding</span>
            </div>
            <div className="rl-summary-item">
              <span className="rl-summary-type">Avg Invoice</span>
              <span className="rl-summary-amt">₹{formatINR(summary.avg_bill)}</span>
              <span className="rl-summary-cnt">per bill</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Bill list ── */}
      <div className="rl-list">
        {loading && <SkeletonRows />}

        {!loading && filtered.length === 0 && (
          <div className="rl-empty">
            {search.trim()
              ? `No bills matching "${search}"`
              : 'No purchases in this period'}
          </div>
        )}

        {!loading && filtered.map((bill) => (
          <PurchaseBillRow
            key={bill.purchase_bill_id ?? bill.bill_number}
            bill={bill}
            onClick={() => navigate(`/vouchers/purchase/${bill.purchase_bill_id}`)}
          />
        ))}
      </div>

      {/* ── Sticky footer ── */}
      {!loading && filtered.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">{filtered.length} bill{filtered.length === 1 ? '' : 's'}</span>
          <span className="rl-footer-total">₹{formatINR(filteredTotal)}</span>
        </div>
      )}

      {/* ── PDF preview overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Purchase Report</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `purchase-report-${fromDate}_${toDate}.pdf`, 'Purchase Report');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe className="rl-pdf-frame" src={pdfUrl} title="Purchase Report PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Purchase bill row ───────────────────────────────────────────────────
function PurchaseBillRow({ bill, onClick }) {
  const status = bill.payment_status || 'Unpaid';
  const sc = STATUS_COLORS[status] || STATUS_COLORS.Unpaid;
  const partyName = bill.supplier?.party_name || bill.walk_in_name || '—';

  return (
    <div className="rl-row" onClick={onClick}>
      <div className="rl-row-main">
        <div className="rl-row-party">{partyName}</div>
        <div className="rl-row-meta">
          {bill.bill_number && <span>{bill.bill_number}</span>}
          {bill.supplier_bill_number && (
            <><span className="rl-meta-dot">·</span>
            <span>Sup: {bill.supplier_bill_number}</span></>
          )}
          {bill.bill_date && (
            <><span className="rl-meta-dot">·</span>
            <span>{prettyDate(bill.bill_date)}</span></>
          )}
          {Number(bill.balance_amount) > 0 && (
            <><span className="rl-meta-dot">·</span>
            <span className="rl-row-due">Due ₹{formatINR(bill.balance_amount)}</span></>
          )}
        </div>
      </div>
      <div className="rl-row-side">
        <div className="rl-row-amount">₹{formatINR(bill.total_amount)}</div>
        <div className="rl-status" style={{ background: sc.bg, color: sc.color }}>{status}</div>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[75, 55, 85, 60, 70].map((w, i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 13, width: `${w}%`, marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 10, width: '45%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <div className="rl-skel" style={{ height: 14, width: 64 }} />
            <div className="rl-skel" style={{ height: 10, width: 40, borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </>
  );
}
