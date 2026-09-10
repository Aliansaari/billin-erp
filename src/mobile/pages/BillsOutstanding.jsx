import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, formatShortDate, defaultFY, isoDate } from '../utils/format';
import { useBack } from '../utils/useBack';
import { shareViaNative } from '../utils/sharePdf';
import './ReportList.css';
import { friendlyError } from '../utils/offlineSnapshot';

// ── Icons ─────────────────────────────────────────────────────────────
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

// ── Component ─────────────────────────────────────────────────────────
export default function BillsOutstanding({ partyType }) {
  const goBack = useBack('/reports');
  const fy = useMemo(() => defaultFY(), []);

  const [rows,     setRows]    = useState([]);
  const [loading,  setLoading] = useState(true);
  const [chip,     setChip]    = useState('all');   // 'all' | 'overdue' | 'paid'
  const [searchOn, setSearchOn] = useState(false);
  const [search,   setSearch]  = useState('');
  const [pdfBusy,  setPdfBusy] = useState(false);
  const [pdfUrl,   setPdfUrl]  = useState(null);
  const searchRef = useRef(null);
  const pdfUrlRef = useRef(null);

  useEffect(() => () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); }, []);

  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn) setSearch('');
  }, [searchOn]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = { from_date: isoDate(fy.from), to_date: isoDate(fy.to) };
    const call = partyType === 'Supplier'
      ? reportAPI.billsPayable(params)
      : reportAPI.billsReceivable(params);

    call
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.bills || res.data?.data || res.data || [];
        setRows(Array.isArray(data) ? data : []);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load bills') });
        setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [partyType, fy]);

  const filtered = useMemo(() => {
    let list = rows;

    if (chip === 'overdue') list = list.filter((r) => Number(r.overdue_days || 0) > 0);
    else if (chip === 'paid') list = list.filter((r) => Number(r.outstanding || 0) === 0);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) =>
        (r.party_name   || '').toLowerCase().includes(q) ||
        (r.bill_number  || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [rows, chip, search]);

  const totalOutstanding = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.outstanding || 0), 0),
    [filtered],
  );

  const titleWord = partyType === 'Supplier' ? 'payable' : 'receivable';

  async function generatePdf() {
    if (filtered.length === 0) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(`Bills ${titleWord.charAt(0).toUpperCase() + titleWord.slice(1)}`, 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${filtered.length} bill${filtered.length === 1 ? '' : 's'} · Total outstanding ₹${formatINR(totalOutstanding)}`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Bill #', 'Date', 'Party', 'Due Date', 'Overdue', 'Amount', 'Paid', 'Outstanding']],
        body: filtered.map((r) => [
          r.bill_number         || '—',
          formatShortDate(r.bill_date),
          r.party_name          || '—',
          formatShortDate(r.effective_due_date),
          r.overdue_days > 0 ? `${r.overdue_days}d` : '—',
          `₹${formatINR(r.bill_amount    || 0)}`,
          `₹${formatINR(r.paid_amount    || 0)}`,
          `₹${formatINR(r.outstanding    || 0)}`,
        ]),
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [181, 66, 28], textColor: [255, 244, 234], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [251, 248, 241] },
        columnStyles: { 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `bills-${titleWord}.pdf` };
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
      const ok = await shareViaNative(result.blob, result.fileName, `Bills ${titleWord}`);
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
        <h1 className="rl-title">Bills <em>{titleWord}</em></h1>
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

      {/* ── Search ── */}
      {searchOn && (
        <div className="rl-search">
          <input
            ref={searchRef}
            placeholder="Search party or bill number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off" autoCapitalize="none" spellCheck="false"
          />
        </div>
      )}

      {/* ── Filter chips ── */}
      <div className="rl-chips">
        {[
          { key: 'all',    label: 'All' },
          { key: 'overdue', label: 'Overdue' },
          { key: 'paid',   label: 'Paid' },
        ].map(({ key, label }) => (
          <button
            key={key}
            className={`rl-chip${chip === key ? ' active' : ''}`}
            onClick={() => setChip(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── List ── */}
      <div className="rl-list">
        {loading && <SkeletonRows />}

        {!loading && filtered.length === 0 && (
          <div className="rl-empty">
            {search.trim() ? `No matches for "${search}"` : 'No bills found'}
          </div>
        )}

        {!loading && filtered.map((row, i) => {
          const overdue = Number(row.overdue_days || 0);
          const outstanding = Number(row.outstanding || 0);
          return (
            <div key={row.bill_number || i} className="rl-row">
              <div className="rl-row-main">
                <div className="rl-row-party">{row.party_name || '—'}</div>
                <div className="rl-row-meta">
                  <span>{row.bill_number || '—'}</span>
                  {row.bill_date && (
                    <>
                      <span className="rl-meta-dot">·</span>
                      <span>{formatShortDate(row.bill_date)}</span>
                    </>
                  )}
                  {row.effective_due_date && (
                    <>
                      <span className="rl-meta-dot">·</span>
                      <span>Due {formatShortDate(row.effective_due_date)}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="rl-row-side" style={{ alignItems: 'flex-end', gap: 4 }}>
                <div
                  className="rl-row-amount"
                  style={{ color: outstanding === 0 ? 'var(--c-text-mute)' : 'var(--c-primary)' }}
                >
                  ₹{formatINR(outstanding)}
                </div>
                {overdue > 0 && (
                  <div style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--c-error, #d32f2f)',
                    background: 'rgba(211,47,47,0.08)', borderRadius: 4,
                    padding: '1px 5px', lineHeight: 1.4,
                  }}>
                    {overdue}d
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Footer ── */}
      {!loading && filtered.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">{filtered.length} bill{filtered.length === 1 ? '' : 's'}</span>
          <span className="rl-footer-total">₹{formatINR(totalOutstanding)}</span>
        </div>
      )}

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Bills {titleWord.charAt(0).toUpperCase() + titleWord.slice(1)}</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `bills-${titleWord}.pdf`, `Bills ${titleWord}`);
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="Bills PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
      )}
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
            <div className="rl-skel" style={{ height: 10, width: '55%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <div className="rl-skel" style={{ height: 14, width: 72 }} />
          </div>
        </div>
      ))}
    </>
  );
}
