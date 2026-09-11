import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cacheKey as mirrorKey, putCached as putMirrored, getCached as getMirrored } from '../utils/mirrorCache';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import OfflineBanner from '../components/OfflineBanner';
import { fetchSnapshot, sectionOf, snapshotAge, isUnreachable, friendlyError, snapshotMatchesSession, ageOf } from '../utils/offlineSnapshot';
import { sortVouchersNewestFirst } from '../utils/voucherOrder';
import ActivityRow from '../components/ActivityRow';
import { formatINR, isoDate } from '../utils/format';
import { shareViaNative } from '../utils/sharePdf';
import './DayBook.css';
import Overlay from '../components/Overlay';
import { tap as hapticTap } from '../utils/haptics';

// ── Inline icons ──────────────────────────────────────────────────────
const ChevL = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
);
const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
);
const PdfIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
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

// ── Voucher type definitions ─────────────────────────────────────────
// The four "primary" filter chips. Order matches the user's mockup.
const PRIMARY = [
  { key: 'sales',    label: 'Sales',    types: ['Sales']    },
  { key: 'purchase', label: 'Purchase', types: ['Purchase'] },
  { key: 'receipt',  label: 'Receipt',  types: ['Receipt']  },
  { key: 'payment',  label: 'Payment',  types: ['Payment']  },
];

// Anything else the day-book can return — surfaced in the "More" sheet.
// We additionally append any unknown voucher_type values we see in the
// response so unfamiliar types still show up.
const KNOWN_OTHER_TYPES = [
  'Sales Return', 'Credit Note',
  'Purchase Return', 'Debit Note',
  'Journal', 'Journal Voucher',
  'Expense',
  'Stock Transfer',
  'Cheque',
  'Contra',
];

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

const TODAY = isoDate();

export default function DayBook() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initialDate = params.get('date') || TODAY;
  const initialFrom = params.get('from') || initialDate;
  const initialTo   = params.get('to')   || initialDate;

  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate,   setToDate]   = useState(initialTo);
  const [data,     setData]     = useState([]);
  const [summary,  setSummary]  = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [offline,  setOffline]  = useState(null);
  const [filter,   setFilter]   = useState('all'); // 'all' | primary key | specific voucher_type
  const [searchOn, setSearchOn] = useState(false);
  const [search,   setSearch]   = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [pdfBusy,  setPdfBusy]  = useState(false);
  const [pdfUrl,   setPdfUrl]   = useState(null);
  const searchRef = useRef(null);
  const pdfUrlRef = useRef(null);

  // Keep URL in sync with picked range so back/forward + deep-links round-trip.
  /* setParams is not referentially stable, so depending on it re-runs this on
   * every navigation. See the same note in VouchersList. */
  const setParamsRef = useRef(setParams);
  useEffect(() => { setParamsRef.current = setParams; }, [setParams]);
  useEffect(() => {
    setParamsRef.current({ from: fromDate, to: toDate }, { replace: true });
  }, [fromDate, toDate]);

  // Reverse direction: when the URL changes externally (browser back/forward,
  // a deep link, or a different chip target navigating here), pull the new
  // dates back into local state so the page reloads its data.
  useEffect(() => {
    const urlFrom = params.get('from');
    const urlTo   = params.get('to');
    if (urlFrom && urlFrom !== fromDate) setFromDate(urlFrom);
    if (urlTo   && urlTo   !== toDate)   setToDate(urlTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Auto-correct ranges where to < from — bump to up to from.
  useEffect(() => {
    if (toDate < fromDate) setToDate(fromDate);
  }, [fromDate, toDate]);

  // Focus search input the moment it appears (saves a tap).
  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn && search) setSearch('');
  }, [searchOn]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reportAPI.dayBook({ from_date: fromDate, to_date: toDate })
      .then((res) => {
        if (cancelled) return;
        setData(sortVouchersNewestFirst(res.data?.data || []));
        setSummary(res.data?.summary || null);
        // Keep this day. A day book is looked at for a particular date, and
        // the dates someone opens are the ones they come back to.
        putMirrored(mirrorKey('dayBook', { from: fromDate, to: toDate }), res.data);
      })
      .catch(async (e) => {
        if (cancelled) return;
        if (isUnreachable(e)) {
          /* This exact day as the server computed it, ahead of the shared
           * size-capped snapshot which holds only whatever fitted. */
          const mine = await getMirrored(mirrorKey('dayBook', { from: fromDate, to: toDate })).catch(() => null);
          if (!cancelled && mine?.data) {
            setData(sortVouchersNewestFirst(mine.data?.data || []));
            setSummary(mine.data?.summary || null);
            setOffline({ age: ageOf(mine.syncedAt) });
            return;
          }
          const snap = await fetchSnapshot().catch(() => null);
          const section = sectionOf(snap, 'dayBook');
          if (!cancelled && section) {
            // The snapshot holds TODAY only — that is what the desktop renders
            // when it uploads. Presenting it for any other requested range
            // would be a quietly wrong answer, so the banner says which day
            // this actually is.
            setData(sortVouchersNewestFirst(section?.data || []));
            setSummary(section?.summary || null);
            setOffline({
              age: snapshotAge(snap),
              todayOnly: true,
              note: snapshotMatchesSession(snap) ? null : 'no saved figures for this company',
            });
            return;
          }
        }
        const msg = friendlyError(e, 'Could not load the day book');
        Toast.show({ icon: 'fail', content: msg });
        setData([]);
        setSummary(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  // ── Counts per voucher type from the active range ───────────────────
  const counts = useMemo(() => {
    const c = { all: data.length };
    for (const row of data) {
      const t = String(row.voucher_type || 'Other');
      c[t] = (c[t] || 0) + 1;
    }
    return c;
  }, [data]);

  // Counts on the four primary chips (each maps to one voucher_type).
  const primaryCount = (key) => {
    const def = PRIMARY.find((p) => p.key === key);
    if (!def) return 0;
    return def.types.reduce((sum, t) => sum + (counts[t] || 0), 0);
  };

  // List of "other" voucher types actually present in the response, plus
  // the well-known list (for completeness even when current range is empty).
  const otherTypes = useMemo(() => {
    const primarySet = new Set(PRIMARY.flatMap((p) => p.types));
    const found = Object.keys(counts).filter((t) => t !== 'all' && !primarySet.has(t));
    const merged = Array.from(new Set([...found, ...KNOWN_OTHER_TYPES]));
    return merged.map((t) => ({ type: t, count: counts[t] || 0 }));
  }, [counts]);

  // ── Filter + search applied to the loaded rows ─────────────────────
  const filtered = useMemo(() => {
    let rows = data;
    if (filter !== 'all') {
      const def = PRIMARY.find((p) => p.key === filter);
      if (def) {
        const accept = new Set(def.types);
        rows = rows.filter((r) => accept.has(r.voucher_type));
      } else {
        rows = rows.filter((r) => r.voucher_type === filter);
      }
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) =>
        String(r.voucher_no       || '').toLowerCase().includes(q) ||
        String(r.party_or_account || '').toLowerCase().includes(q) ||
        String(r.entry_number     || '').toLowerCase().includes(q) ||
        String(r.narration        || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }, [data, filter, search]);

  // ── PDF export of the *currently filtered* list ────────────────────
  // jsPDF + autotable are ~350KB combined and only needed on Export tap,
  // so dynamic-import them here. The first export takes ~300ms longer
  // than later ones (the chunk has to download); after that it's cached.
  async function generatePdf() {
    if (filtered.length === 0) return null;
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'), import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const title = `Day Book — ${prettyDate(fromDate)}${fromDate !== toDate ? ` – ${prettyDate(toDate)}` : ''}`;
      const subtitle = filter === 'all' ? `All vouchers (${filtered.length})` : `${filterLabel(filter)} (${filtered.length})`;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(title, 40, 40);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(subtitle, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Date', 'Type', 'No', 'Party / Account', 'Debit', 'Credit']],
        body: filtered.map((r) => [
          r.entry_date, r.voucher_type, r.voucher_no || '', r.party_or_account || '',
          r.debit  ? formatINR(r.debit)  : '',
          r.credit ? formatINR(r.credit) : '',
        ]),
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [181, 66, 28], textColor: [255, 244, 234], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [251, 248, 241] },
        columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' } },
      });
      const fileName = `day-book-${fromDate}${fromDate !== toDate ? `_to_${toDate}` : ''}.pdf`;
      return { blob: doc.output('blob'), fileName };
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
      const ok = await shareViaNative(result.blob, result.fileName, 'Day Book');
      if (!ok) Toast.show({ icon: 'fail', content: 'Share failed' });
    } finally { setPdfBusy(false); }
  }

  function closePdfViewer() {
    setPdfUrl(null);
    if (pdfUrlRef.current) { URL.revokeObjectURL(pdfUrlRef.current); pdfUrlRef.current = null; }
  }

  function filterLabel(key) {
    const p = PRIMARY.find((x) => x.key === key);
    if (p) return p.label;
    return key;
  }

  // ── Render ─────────────────────────────────────────────────────────
  const total = filtered.length;
  const totalDebit  = filtered.reduce((s, r) => s + Number(r.debit  || 0), 0);
  const totalCredit = filtered.reduce((s, r) => s + Number(r.credit || 0), 0);

  return (
    <div className="db-screen drill-in">
      {/* Topbar */}
      <div className="db-top">
        <button className="db-icon-btn framed" onClick={() => { hapticTap(); navigate(-1); }} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="db-title">Day <em>book</em></h1>
        <button
          className={`db-icon-btn${searchOn ? ' active' : ''}`}
          onClick={() => setSearchOn((v) => !v)}
          aria-label="Search"
        >
          <SearchIcon />
        </button>
        <button
          className="db-icon-btn"
          onClick={handleViewPdf}
          disabled={pdfBusy || filtered.length === 0}
          aria-label="PDF preview"
          style={{ color: filtered.length && !pdfBusy ? 'var(--c-primary)' : undefined }}
        >
          <PdfIcon />
        </button>
        <button
          className="db-icon-btn"
          onClick={handleSharePdf}
          disabled={pdfBusy || filtered.length === 0}
          aria-label="Share PDF"
        >
          <ShareIcon />
        </button>
      </div>
      {offline && (
        <div className="offline-slot">
          <OfflineBanner
            note={offline.note}
            age={offline.todayOnly ? `${offline.age} — today only` : offline.age}
            onRetry={() => window.location.reload()}
          />
        </div>
      )}

      {/* From/To range row */}
      <div className="db-range">
        <label className="db-date">
          <span className="db-date-key">FROM</span>
          <span className="db-date-val">{prettyDate(fromDate)}</span>
          <input
            type="date"
            value={fromDate}
            max={TODAY}
            onChange={(e) => e.target.value && setFromDate(e.target.value)}
          />
        </label>
        <span className="db-range-arrow">→</span>
        <label className="db-date">
          <span className="db-date-key">TO</span>
          <span className="db-date-val">{prettyDate(toDate)}</span>
          <input
            type="date"
            value={toDate}
            min={fromDate}
            max={TODAY}
            onChange={(e) => e.target.value && setToDate(e.target.value)}
          />
        </label>
      </div>

      {/* Search input (collapsible) */}
      {searchOn && (
        <div className="db-search">
          <input
            ref={searchRef}
            placeholder="Search bill no, party name, narration…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck="false"
          />
        </div>
      )}

      {/* Filter chips */}
      <div className="db-chips">
        <button
          className={`db-chip${filter === 'all' ? ' active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All <span className="db-chip-count">{counts.all || 0}</span>
        </button>
        {PRIMARY.map((p) => (
          <button
            key={p.key}
            className={`db-chip${filter === p.key ? ' active' : ''}`}
            onClick={() => setFilter(p.key)}
          >
            {p.label} <span className="db-chip-count">{primaryCount(p.key)}</span>
          </button>
        ))}
        <button
          className={`db-chip db-chip-more${
            filter !== 'all' && !PRIMARY.find((p) => p.key === filter) ? ' active' : ''
          }`}
          onClick={() => setMoreOpen(true)}
          aria-label="More voucher types"
          title="More voucher types"
        >
          ⋯
        </button>
      </div>

      {/* List */}
      <div className="db-list-wrap">
        {loading && <div className="db-empty">Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="db-empty">
            {search.trim() ? `No matches for "${search.trim()}"` : 'No vouchers in this range'}
          </div>
        )}
        {!loading && filtered.map((entry) => (
          <ActivityRow
            key={entry.entry_number}
            entry={entry}
            onClick={() => {
              const r = String(entry.drill_route || '');
              const idMatch = r.match(/\/(\d+)\s*$/);
              const typeMap = { Sales: 'sales', Purchase: 'purchase', Receipt: 'receipt', Payment: 'payment' };
              const vType = typeMap[entry.voucher_type];
              if (!vType) return;
              if (idMatch) { navigate(`/vouchers/${vType}/${idMatch[1]}`); return; }
              if (entry.voucher_no) navigate(`/vouchers/${vType}/search?no=${encodeURIComponent(entry.voucher_no)}`);
            }}
          />
        ))}
      </div>

      {/* Footer — outside scroll so it stays visible, above tab bar */}
      {!loading && filtered.length > 0 && (
        <div className="db-footer">
          <span className="db-footer-count">{total} voucher{total === 1 ? '' : 's'}</span>
          {filter === 'all' ? (
            <div className="db-footer-totals">
              <span><span className="db-footer-lbl">DR</span>₹{formatINR(totalDebit)}</span>
              <span className="db-footer-sep">·</span>
              <span><span className="db-footer-lbl">CR</span>₹{formatINR(totalCredit)}</span>
            </div>
          ) : (
            <span className="db-footer-total">₹{formatINR(totalDebit + totalCredit)}</span>
          )}
        </div>
      )}

      {/* PDF preview overlay */}
      {pdfUrl && (
        <Overlay>
        <div className="db-pdf-overlay">
          <div className="db-pdf-toolbar">
            <button className="db-pdf-close" onClick={closePdfViewer} aria-label="Close"><CloseIcon /></button>
            <span className="db-pdf-title">Day Book</span>
            <button className="db-pdf-share" onClick={async () => {
              try {
                const resp = await fetch(pdfUrlRef.current);
                const blob = await resp.blob();
                const fileName = `day-book-${fromDate}${fromDate !== toDate ? `_to_${toDate}` : ''}.pdf`;
                await shareViaNative(blob, fileName, 'Day Book');
              } catch { Toast.show({ icon: 'fail', content: 'Share failed' }); }
            }} aria-label="Share"><ShareIcon /></button>
          </div>
          <div className="db-pdf-body">
            <iframe className="db-pdf-frame" src={pdfUrl} title="Day Book PDF"
              style={{ width: '612px', minHeight: '792px', transform: `scale(${window.innerWidth / 612})`, transformOrigin: 'top left' }}
            />
          </div>
        </div>
        </Overlay>
      )}

      {/* More-types bottom sheet */}
      {moreOpen && (
        <Overlay>
        <>
          <div className="db-sheet-scrim" onClick={() => setMoreOpen(false)} />
          <div className="db-sheet" role="dialog" aria-label="More voucher types">
            <div className="db-sheet-handle" />
            <div className="db-sheet-head">
              <h2 className="db-sheet-title">More <em>voucher types</em></h2>
              <div className="db-sheet-sub">{otherTypes.length} type{otherTypes.length === 1 ? '' : 's'} available</div>
            </div>
            <div className="db-sheet-list">
              <button
                className={`db-sheet-item${filter === 'all' ? ' active' : ''}`}
                onClick={() => { setFilter('all'); setMoreOpen(false); }}
              >
                <span>All voucher types</span>
                <span className="db-sheet-item-count">{counts.all || 0}</span>
              </button>
              {otherTypes.map((t) => (
                <button
                  key={t.type}
                  className={`db-sheet-item${filter === t.type ? ' active' : ''}`}
                  onClick={() => { setFilter(t.type); setMoreOpen(false); }}
                >
                  <span>{t.type}</span>
                  <span className="db-sheet-item-count">{t.count}</span>
                </button>
              ))}
            </div>
          </div>
        </>
        </Overlay>
      )}
    </div>
  );
}
