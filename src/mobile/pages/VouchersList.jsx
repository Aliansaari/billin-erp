import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import ActivityRow from '../components/ActivityRow';
import { formatINR, isoDate } from '../utils/format';
import './VouchersList.css';

const SummaryIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
);
const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
);
const PdfIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
);

const PRIMARY = [
  { key: 'sales',    label: 'Sales',    types: ['Sales']    },
  { key: 'purchase', label: 'Purchase', types: ['Purchase'] },
  { key: 'receipt',  label: 'Receipt',  types: ['Receipt']  },
  { key: 'payment',  label: 'Payment',  types: ['Payment']  },
];

const KNOWN_OTHER_TYPES = [
  'Sales Return', 'Credit Note',
  'Purchase Return', 'Debit Note',
  'Journal', 'Journal Voucher',
  'Expense', 'Stock Transfer',
  'Cheque', 'Contra',
];

function fyDates() {
  const now = new Date();
  const y = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

const TODAY = isoDate();

export default function VouchersList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const fy = fyDates();
  const initialFrom = params.get('from') || fy.from;
  const initialTo   = params.get('to')   || TODAY;

  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate,   setToDate]   = useState(initialTo);
  const [data,     setData]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [filter,   setFilter]   = useState(params.get('type') || 'all');
  const [searchOn, setSearchOn] = useState(false);
  const [search,   setSearch]   = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    const p = { from: fromDate, to: toDate };
    if (filter !== 'all') p.type = filter;
    setParams(p, { replace: true });
  }, [fromDate, toDate, filter, setParams]);

  useEffect(() => {
    if (toDate < fromDate) setToDate(fromDate);
  }, [fromDate, toDate]);

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
        setData(res.data?.data || []);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e?.response?.data?.error || e?.message || 'Failed to load vouchers';
        Toast.show({ icon: 'fail', content: msg });
        setData([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  const counts = useMemo(() => {
    const c = { all: data.length };
    for (const row of data) {
      const t = String(row.voucher_type || 'Other');
      c[t] = (c[t] || 0) + 1;
    }
    return c;
  }, [data]);

  const primaryCount = (key) => {
    const def = PRIMARY.find((p) => p.key === key);
    if (!def) return 0;
    return def.types.reduce((sum, t) => sum + (counts[t] || 0), 0);
  };

  const otherTypes = useMemo(() => {
    const primarySet = new Set(PRIMARY.flatMap((p) => p.types));
    const found = Object.keys(counts).filter((t) => t !== 'all' && !primarySet.has(t));
    const merged = Array.from(new Set([...found, ...KNOWN_OTHER_TYPES]));
    return merged.map((t) => ({ type: t, count: counts[t] || 0 }));
  }, [counts]);

  const summary = useMemo(() => {
    const s = {};
    for (const p of PRIMARY) {
      const accept = new Set(p.types);
      const rows = data.filter((r) => accept.has(r.voucher_type));
      const amount = rows.reduce((sum, r) => sum + Number(r.debit || r.credit || 0), 0);
      s[p.key] = { count: rows.length, amount };
    }
    s.total = data.reduce((sum, r) => sum + Number(r.debit || r.credit || 0), 0);
    return s;
  }, [data]);

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

  async function exportPdf() {
    if (filtered.length === 0) {
      Toast.show({ content: 'Nothing to export' });
      return;
    }
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const title = `Vouchers — ${prettyDate(fromDate)}${fromDate !== toDate ? ` – ${prettyDate(toDate)}` : ''}`;
      const subtitle = filter === 'all' ? `All vouchers (${filtered.length})` : `${filterLabel(filter)} (${filtered.length})`;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.text(title, 40, 40);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.text(subtitle, 40, 56);
      autoTable(doc, {
        startY: 72,
        head: [['Date', 'Type', 'No', 'Party / Account', 'Debit', 'Credit']],
        body: filtered.map((r) => [
          r.entry_date,
          r.voucher_type,
          r.voucher_no || '',
          r.party_or_account || '',
          r.debit  ? formatINR(r.debit)  : '',
          r.credit ? formatINR(r.credit) : '',
        ]),
        styles:      { fontSize: 9, cellPadding: 4 },
        headStyles:  { fillColor: [181, 66, 28], textColor: [255, 244, 234], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [251, 248, 241] },
        columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' } },
      });
      const filename = `vouchers-${fromDate}${fromDate !== toDate ? `_to_${toDate}` : ''}.pdf`;
      doc.save(filename);
      Toast.show({ icon: 'success', content: 'Exported' });
    } catch {
      Toast.show({ icon: 'fail', content: 'Export failed' });
    }
  }

  function filterLabel(key) {
    const p = PRIMARY.find((x) => x.key === key);
    if (p) return p.label;
    return key;
  }

  const total = filtered.length;
  const totalAmount = filtered.reduce((s, r) => s + Number(r.debit || r.credit || 0), 0);
  const totalDebit  = filtered.reduce((s, r) => s + Number(r.debit  || 0), 0);
  const totalCredit = filtered.reduce((s, r) => s + Number(r.credit || 0), 0);

  return (
    <div className="vl-screen">
      {/* Topbar */}
      <div className="vl-top">
        <h1 className="vl-title">Vouchers</h1>
        <button
          className={`vl-icon-btn${showSummary ? ' active' : ''}`}
          onClick={() => setShowSummary((v) => !v)}
          aria-label="Toggle summary"
        >
          <SummaryIcon />
        </button>
        <button
          className={`vl-icon-btn${searchOn ? ' active' : ''}`}
          onClick={() => setSearchOn((v) => !v)}
          aria-label="Search"
        >
          <SearchIcon />
        </button>
        <button
          className="vl-icon-btn"
          onClick={exportPdf}
          aria-label="Export PDF"
          style={{ color: filtered.length ? 'var(--c-primary)' : 'var(--c-text-mute)' }}
        >
          <PdfIcon />
        </button>
      </div>

      {/* Date range */}
      <div className="vl-range">
        <label className="vl-date">
          <span className="vl-date-key">FROM</span>
          <span className="vl-date-val">{prettyDate(fromDate)}</span>
          <input
            type="date"
            value={fromDate}
            max={TODAY}
            onChange={(e) => e.target.value && setFromDate(e.target.value)}
          />
        </label>
        <span className="vl-range-arrow">→</span>
        <label className="vl-date">
          <span className="vl-date-key">TO</span>
          <span className="vl-date-val">{prettyDate(toDate)}</span>
          <input
            type="date"
            value={toDate}
            min={fromDate}
            max={TODAY}
            onChange={(e) => e.target.value && setToDate(e.target.value)}
          />
        </label>
      </div>

      {/* Summary card */}
      {showSummary && !loading && (
        <div className="vl-summary">
          <div className="vl-summary-grid">
            {PRIMARY.map((p) => (
              <div
                key={p.key}
                className={`vl-summary-item${filter === p.key ? ' active' : ''}`}
                onClick={() => setFilter(p.key)}
                role="button"
              >
                <span className="vl-summary-type">{p.label}</span>
                <span className="vl-summary-amt">₹{formatINR(summary[p.key]?.amount || 0)}</span>
                <span className="vl-summary-cnt">{summary[p.key]?.count || 0} entries</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      {searchOn && (
        <div className="vl-search">
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
      <div className="vl-chips">
        <button
          className={`vl-chip${filter === 'all' ? ' active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All <span className="vl-chip-count">{counts.all || 0}</span>
        </button>
        {PRIMARY.map((p) => (
          <button
            key={p.key}
            className={`vl-chip${filter === p.key ? ' active' : ''}`}
            onClick={() => setFilter(p.key)}
          >
            {p.label} <span className="vl-chip-count">{primaryCount(p.key)}</span>
          </button>
        ))}
        <button
          className={`vl-chip vl-chip-more${
            filter !== 'all' && !PRIMARY.find((p) => p.key === filter) ? ' active' : ''
          }`}
          onClick={() => setMoreOpen(true)}
          aria-label="More voucher types"
        >
          ⋯
        </button>
      </div>

      {/* List */}
      <div className="vl-list-wrap">
        {loading && <div className="vl-empty">Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="vl-empty">
            {search.trim() ? `No matches for "${search.trim()}"` : 'No vouchers in this period'}
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

      {/* Sticky footer */}
      {!loading && filtered.length > 0 && (
        <div className="vl-footer">
          <span className="vl-footer-count">{total} voucher{total === 1 ? '' : 's'}</span>
          {filter === 'all' ? (
            <div className="vl-footer-drcr">
              <span className="vl-footer-dr">Dr ₹{formatINR(totalDebit)}</span>
              <span className="vl-footer-sep">·</span>
              <span className="vl-footer-cr">Cr ₹{formatINR(totalCredit)}</span>
            </div>
          ) : (
            <span className="vl-footer-total">₹{formatINR(totalAmount)}</span>
          )}
        </div>
      )}

      {/* More-types bottom sheet */}
      {moreOpen && (
        <>
          <div className="vl-sheet-scrim" onClick={() => setMoreOpen(false)} />
          <div className="vl-sheet" role="dialog" aria-label="More voucher types">
            <div className="vl-sheet-handle" />
            <div className="vl-sheet-head">
              <h2 className="vl-sheet-title">More <em>voucher types</em></h2>
              <div className="vl-sheet-sub">{otherTypes.length} type{otherTypes.length === 1 ? '' : 's'} available</div>
            </div>
            <div className="vl-sheet-list">
              <button
                className={`vl-sheet-item${filter === 'all' ? ' active' : ''}`}
                onClick={() => { setFilter('all'); setMoreOpen(false); }}
              >
                <span>All voucher types</span>
                <span className="vl-sheet-item-count">{counts.all || 0}</span>
              </button>
              {otherTypes.map((t) => (
                <button
                  key={t.type}
                  className={`vl-sheet-item${filter === t.type ? ' active' : ''}`}
                  onClick={() => { setFilter(t.type); setMoreOpen(false); }}
                >
                  <span>{t.type}</span>
                  <span className="vl-sheet-item-count">{t.count}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
