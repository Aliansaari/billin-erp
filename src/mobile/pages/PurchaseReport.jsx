import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, isoDate, defaultFY } from '../utils/format';
import './ReportList.css';

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
  const searchRef = useRef(null);

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
        setSummary({ total_amount: totalAmount, bill_count: rows.length, total_gst: totalGst, total_balance: totalBalance });
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load purchases' });
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
        <button className="rl-icon-btn framed" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/reports'))} aria-label="Back">
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

      {/* ── KPI grid (collapsed by default, toggled by ⊞ button) ── */}
      {showKpi && summary && (
        <div className="rl-summary">
          <div className="rl-summary-grid">
            <div className="rl-summary-item">
              <span className="rl-summary-type">Total</span>
              <span className="rl-summary-amt">₹{formatINR(summary.total_amount)}</span>
              <span className="rl-summary-cnt">{summary.bill_count ?? data.length} bills</span>
            </div>
            <div className="rl-summary-item">
              <span className="rl-summary-type">GST</span>
              <span className="rl-summary-amt">₹{formatINR(summary.total_gst ?? 0)}</span>
              <span className="rl-summary-cnt">paid</span>
            </div>
            <div className="rl-summary-item">
              <span className="rl-summary-type">Due</span>
              <span className={`rl-summary-amt${summary.total_balance > 0 ? ' danger' : ''}`}>₹{formatINR(summary.total_balance ?? 0)}</span>
              <span className="rl-summary-cnt">outstanding</span>
            </div>
            <div className="rl-summary-item">
              <span className="rl-summary-type">Avg Bill</span>
              <span className="rl-summary-amt">₹{formatINR(summary.bill_count > 0 ? summary.total_amount / summary.bill_count : 0)}</span>
              <span className="rl-summary-cnt">per bill</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Bill list ── */}
      <div className="rl-list" style={filtered.length > 0 && !loading ? { paddingBottom: 56 } : {}}>
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
          {bill.balance_amount > 0 && (
            <><span className="rl-meta-dot">·</span>
            <span className="rl-row-due">Due ₹{formatINR(bill.balance_amount)}</span></>
          )}
        </div>
      </div>
      <div className="rl-row-side">
        <div className="rl-row-amount">₹{formatINR(bill.total_amount)}</div>
        <div className="rl-status" style={{ background: sc.bg, color: sc.color }}>{status}</div>
      </div>
      <div className="rl-row-chev"><ChevR /></div>
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
