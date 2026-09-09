import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import OfflineBanner from '../components/OfflineBanner';
import { fetchSnapshot, sectionOf, snapshotAge, isUnreachable } from '../utils/offlineSnapshot';
import { formatINR } from '../utils/format';
import { useBack } from '../utils/useBack';
import { shareViaNative } from '../utils/sharePdf';
import './ReportList.css';

// ── Icons ─────────────────────────────────────────────────────────────
const ChevL = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6"/>
  </svg>
);
const ChevR = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l6-6-6-6"/>
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

export default function Outstanding() {
  const navigate = useNavigate();
  const goBack = useBack('/reports');
  const [urlParams] = useSearchParams();

  const mode = urlParams.get('type') === 'Supplier' ? 'Supplier' : 'Customer';
  const [rows,     setRows]    = useState([]);
  const [loading,  setLoading] = useState(true);
  const [offline,  setOffline] = useState(null);
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
    reportAPI.getPartyOutstanding({ party_type: mode })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data?.data || []);
        setOffline(null);
      })
      .catch(async (err) => {
        if (cancelled) return;
        // Shop computer unreachable → show the last uploaded figures rather
        // than an empty list, which would read as "nothing is outstanding".
        // A 4xx means the server answered and refused: that is a real problem
        // and must not be hidden behind stale numbers.
        if (isUnreachable(err)) {
          const snap = await fetchSnapshot().catch(() => null);
          const section = sectionOf(snap, 'outstanding');
          if (!cancelled && section) {
            const all = section?.data || [];
            // The snapshot holds both parties; filter to the tab being viewed.
            setRows(all.filter((r) => !r.party_type || r.party_type === mode));
            setOffline({ age: snapshotAge(snap) });
            return;
          }
        }
        Toast.show({ icon: 'fail', content: 'Failed to load outstanding' });
        setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) =>
      (r.party_name || '').toLowerCase().includes(q) ||
      (r.mobile_1   || '').toLowerCase().includes(q) ||
      (r.city       || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const totalOutstanding = useMemo(
    () => filtered.reduce((s, r) => s + Math.abs(Number(r.current_balance || 0)), 0),
    [filtered],
  );

  async function generatePdf() {
    if (filtered.length === 0) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(`${mode} Outstanding`, 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${filtered.length} ${mode.toLowerCase()}s · Total ₹${formatINR(totalOutstanding)}`, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Party', 'Phone', 'City', 'Outstanding']],
        body: filtered.map((r) => [
          r.party_name || '—',
          r.mobile_1 || '—',
          r.city || '—',
          `₹${formatINR(Math.abs(r.current_balance || 0))}`,
        ]),
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [181, 66, 28], textColor: [255, 244, 234], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [251, 248, 241] },
        columnStyles: { 3: { halign: 'right' } },
      });
      return { blob: doc.output('blob'), fileName: `outstanding-${mode.toLowerCase()}.pdf` };
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
      const ok = await shareViaNative(result.blob, result.fileName, `${mode} Outstanding`);
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  function drillInto(row) {
    const route = mode === 'Customer' ? 'customer-statement' : 'supplier-statement';
    const params = new URLSearchParams({ party_id: row.party_id, party_name: row.party_name || '' });
    navigate(`/reports/${route}?${params}`);
  }

  return (
    <div className="rl-screen drill-in">


      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">{mode} <em>outstanding</em></h1>
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
      {offline && (
        <div className="offline-slot">
          <OfflineBanner age={offline.age} onRetry={() => window.location.reload()} />
        </div>
      )}

      {/* ── Search (collapsible) ── */}
      {searchOn && (
        <div className="rl-search">
          <input
            ref={searchRef}
            placeholder={`Search ${mode.toLowerCase()} name, city…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off" autoCapitalize="none" spellCheck="false"
          />
        </div>
      )}

      {/* ── List ── */}
      <div className="rl-list">
        {loading && <SkeletonRows />}

        {!loading && filtered.length === 0 && (
          <div className="rl-empty">
            {search.trim()
              ? `No matches for "${search}"`
              : `No outstanding ${mode.toLowerCase()} balances`}
          </div>
        )}

        {!loading && filtered.map((row) => (
          <div key={row.party_id} className="rl-row" onClick={() => drillInto(row)}>
            <div className="rl-row-main">
              <div className="rl-row-party">{row.party_name || '—'}</div>
              <div className="rl-row-meta">
                {row.mobile_1 && <span>{row.mobile_1}</span>}
                {row.city && row.mobile_1 && <span className="rl-meta-dot">·</span>}
                {row.city && <span>{row.city}</span>}
              </div>
            </div>
            <div className="rl-row-side">
              <div className="rl-row-amount" style={{ color: 'var(--c-primary)' }}>
                ₹{formatINR(Math.abs(row.current_balance || 0))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', marginLeft: 6, color: 'var(--c-text-mute)', flexShrink: 0 }}>
              <ChevR />
            </div>
          </div>
        ))}
      </div>

      {/* ── Footer ── */}
      {!loading && filtered.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">{filtered.length} {mode.toLowerCase()}{filtered.length === 1 ? '' : 's'}</span>
          <span className="rl-footer-total">₹{formatINR(totalOutstanding)}</span>
        </div>
      )}

      {/* ── PDF overlay ── */}
      {pdfUrl && (
        <div className="rl-pdf-overlay">
          <div className="rl-pdf-toolbar">
            <button className="rl-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="rl-pdf-title">{mode} Outstanding</span>
            <button className="rl-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                await shareViaNative(blob, `outstanding-${mode.toLowerCase()}.pdf`, `${mode} Outstanding`);
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="rl-pdf-body">
            <iframe className="rl-pdf-frame" src={pdfUrl} title="Outstanding PDF"
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
      {[75, 55, 85, 60, 70].map((w, i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 13, width: `${w}%`, marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 10, width: '40%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <div className="rl-skel" style={{ height: 14, width: 72 }} />
          </div>
        </div>
      ))}
    </>
  );
}
