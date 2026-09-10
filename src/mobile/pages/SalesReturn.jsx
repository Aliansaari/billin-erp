import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from 'antd-mobile';
import { salesReturnAPI } from '../../api';
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
export default function SalesReturn() {
  const goBack = useBack('/reports');
  const fy = useMemo(() => defaultFY(), []);

  const [rows,     setRows]    = useState([]);
  const [loading,  setLoading] = useState(true);
  const [chip,     setChip]    = useState('all');   // 'all' | 'pending' | 'cancelled'
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
    salesReturnAPI.getAll({ from_date: isoDate(fy.from), to_date: isoDate(fy.to) })
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data || [];
        setRows(Array.isArray(data) ? data : []);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load sales returns') });
        setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fy]);

  const filtered = useMemo(() => {
    let list = rows;

    if (chip === 'pending')   list = list.filter((r) => Number(r.balance_amount || 0) > 0 && !r.is_cancelled);
    else if (chip === 'cancelled') list = list.filter((r) => r.is_cancelled);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) => {
        const name = r.customer?.party_name || r.party_name || '';
        return name.toLowerCase().includes(q) || (r.return_number || '').toLowerCase().includes(q);
      });
    }
    return list;
  }, [rows, chip, search]);

  const totalAmount = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.total_amount || 0), 0),
    [filtered],
  );

  function partyName(row) {
    return row.customer?.party_name || row.party_name || '—';
  }

  async function generatePdf() {
    if (filtered.length === 0) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('Sales Return', 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${filtered.length} return${filtered.length === 1 ? '' : 's'} · Total ₹${formatINR(totalAmount)}`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Return #', 'Date', 'Party', 'Ref Bill', 'Amount', 'Refund', 'Status']],
        body: filtered.map((r) => [
          r.return_number          || '—',
          formatShortDate(r.return_date),
          partyName(r),
          r.reference_bill_number  || '—',
          `₹${formatINR(r.total_amount   || 0)}`,
          `₹${formatINR(r.refund_amount  || 0)}`,
          r.is_cancelled ? 'Cancelled' : Number(r.balance_amount || 0) > 0 ? 'Pending' : 'Settled',
        ]),
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [181, 66, 28], textColor: [255, 244, 234], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [251, 248, 241] },
        columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: 'sales-return.pdf' };
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
      const ok = await shareViaNative(result.blob, result.fileName, 'Sales Return');
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
        <h1 className="rl-title">Sales <em>return</em></h1>
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
            placeholder="Search party or return number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off" autoCapitalize="none" spellCheck="false"
          />
        </div>
      )}

      {/* ── Filter chips ── */}
      <div className="rl-chips">
        {[
          { key: 'all',       label: 'All' },
          { key: 'pending',   label: 'Pending' },
          { key: 'cancelled', label: 'Cancelled' },
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
            {search.trim() ? `No matches for "${search}"` : 'No sales returns found'}
          </div>
        )}

        {!loading && filtered.map((row, i) => {
          const cancelled = Boolean(row.is_cancelled);
          const pending   = !cancelled && Number(row.balance_amount || 0) > 0;
          return (
            <div key={row.return_number || i} className="rl-row">
              <div className="rl-row-main">
                <div
                  className="rl-row-party"
                  style={cancelled ? { color: 'var(--c-text-mute)' } : undefined}
                >
                  {partyName(row)}
                </div>
                <div className="rl-row-meta">
                  <span>{row.return_number || '—'}</span>
                  {row.return_date && (
                    <>
                      <span className="rl-meta-dot">·</span>
                      <span>{formatShortDate(row.return_date)}</span>
                    </>
                  )}
                  {row.reference_bill_number && (
                    <>
                      <span className="rl-meta-dot">·</span>
                      <span>Ref {row.reference_bill_number}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="rl-row-side" style={{ alignItems: 'flex-end', gap: 4 }}>
                <div
                  className="rl-row-amount"
                  style={{ color: cancelled ? 'var(--c-text-mute)' : 'var(--c-primary)' }}
                >
                  ₹{formatINR(row.total_amount || 0)}
                </div>
                {cancelled && (
                  <div style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--c-text-mute)',
                    background: 'rgba(0,0,0,0.06)', borderRadius: 4,
                    padding: '1px 5px', lineHeight: 1.4,
                  }}>
                    cancelled
                  </div>
                )}
                {pending && (
                  <div style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--c-error, #d32f2f)',
                    background: 'rgba(211,47,47,0.08)', borderRadius: 4,
                    padding: '1px 5px', lineHeight: 1.4,
                  }}>
                    pending
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
          <span className="rl-footer-count">{filtered.length} return{filtered.length === 1 ? '' : 's'}</span>
          <span className="rl-footer-total">₹{formatINR(totalAmount)}</span>
        </div>
      )}

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">Sales Return</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, 'sales-return.pdf', 'Sales Return');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe
              className="rl-pdf-frame"
              src={pdfUrl}
              title="Sales Return PDF"
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
