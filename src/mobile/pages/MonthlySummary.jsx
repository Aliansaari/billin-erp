import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { reportAPI } from '../../api';
import { formatINR, isoDate } from '../utils/format';
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
const ChevR = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l6-6-6-6"/>
  </svg>
);

// ── FY helpers ─────────────────────────────────────────────────────────
function fyForDate(date = new Date()) {
  const y = date.getMonth() < 3 ? date.getFullYear() - 1 : date.getFullYear();
  return { year: y, from: new Date(y, 3, 1), to: new Date(y + 1, 2, 31) };
}
function fyLabel(year) {
  return `FY ${year}–${String(year + 1).slice(2)}`;
}

// ── Month modes ────────────────────────────────────────────────────────
const MODES = [
  { key: 'sales',    label: 'Sales',    apiMode: 'sales'    },
  { key: 'purchase', label: 'Purchase', apiMode: 'purchase' },
  { key: 'receipt',  label: 'Receipt',  apiMode: 'receipt'  },
  { key: 'payment',  label: 'Payment',  apiMode: 'payment'  },
];

const MONTH_NAMES = [
  'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December', 'January', 'February', 'March',
];

// Given a "YYYY-MM" string, return a display label like "Apr '25"
function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  const name = new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'short' });
  return `${name} '${String(y).slice(2)}`;
}

// Full month name + year for list rows
function monthFull(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  const name = d.toLocaleString('en-IN', { month: 'long' });
  return { name, year: String(y).slice(2) };
}

// ── Component ──────────────────────────────────────────────────────────
export default function MonthlySummary() {
  const navigate = useNavigate();
  const [urlParams, setUrlParams] = useSearchParams();

  const initFY = fyForDate();
  const [fyYear,   setFyYear]  = useState(initFY.year);
  const [mode,     setMode]    = useState(() => urlParams.get('mode') || 'sales');
  const [rows,     setRows]    = useState([]);
  const [loading,  setLoading] = useState(true);

  const fy = useMemo(() => fyForDate(new Date(fyYear, 3, 1)), [fyYear]);

  // Sync URL
  useEffect(() => {
    setUrlParams({ mode }, { replace: true });
  }, [mode, setUrlParams]);

  // Load data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reportAPI.monthlySummary({
      mode,
      from_date: isoDate(fy.from),
      to_date:   isoDate(fy.to),
    })
      .then((res) => {
        if (cancelled) return;
        // Response may be { data: [...] } or directly an array
        const d = res.data?.data || res.data || [];
        setRows(Array.isArray(d) ? d : []);
      })
      .catch((e) => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: e?.response?.data?.error || 'Failed to load' });
        setRows([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, fyYear, fy]);

  const grandTotal = useMemo(
    () => rows.reduce((s, r) => s + Number(r.total_amount ?? r.net_amount ?? r.debit ?? 0), 0),
    [rows],
  );
  const grandCount = useMemo(
    () => rows.reduce((s, r) => s + Number(r.bill_count ?? r.count ?? 0), 0),
    [rows],
  );

  function drillInto(row) {
    // Navigate to DayBook filtered to this month
    const from = row.from_date || `${row.month}-01`;
    const [y, m] = (row.month || from.slice(0, 7)).split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const to = row.to_date || `${row.month}-${String(lastDay).padStart(2, '0')}`;
    navigate(`/day-book?from=${from}&to=${to}`);
  }

  const currentModeLabel = MODES.find((m) => m.key === mode)?.label || 'Sales';

  return (
    <div className="rl-screen drill-in">

      {/* ── Topbar ── */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/reports'))} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">Monthly <em>summary</em></h1>
      </div>

      {/* ── Mode chips ── */}
      <div className="rl-chips">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`rl-chip${mode === m.key ? ' active' : ''}`}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* ── FY year navigator ── */}
      <div className="rl-fy-row">
        <button
          className="rl-fy-btn"
          onClick={() => setFyYear((y) => y - 1)}
          aria-label="Previous year"
        >
          <ChevLSmall />
        </button>
        <span className="rl-fy-label">{fyLabel(fyYear)}</span>
        <button
          className="rl-fy-btn"
          onClick={() => setFyYear((y) => y + 1)}
          disabled={fyYear >= initFY.year}
          aria-label="Next year"
          style={{ opacity: fyYear >= initFY.year ? 0.3 : 1 }}
        >
          <ChevRSmall />
        </button>
      </div>

      {/* ── KPI strip ── */}
      {!loading && rows.length > 0 && (
        <div className="rl-kpis">
          <div className="rl-kpi">
            <div className="rl-kpi-val">₹{formatINR(grandTotal)}</div>
            <div className="rl-kpi-label">{currentModeLabel}</div>
          </div>
          {grandCount > 0 && (
            <>
              <div className="rl-kpi-sep" />
              <div className="rl-kpi">
                <div className="rl-kpi-val">{grandCount}</div>
                <div className="rl-kpi-label">Vouchers</div>
              </div>
            </>
          )}
          <div className="rl-kpi-sep" />
          <div className="rl-kpi">
            <div className="rl-kpi-val">{rows.length}</div>
            <div className="rl-kpi-label">Months</div>
          </div>
        </div>
      )}

      {/* ── Month list ── */}
      <div className="rl-list">
        {loading && <SkeletonRows />}

        {!loading && rows.length === 0 && (
          <div className="rl-empty">No {currentModeLabel.toLowerCase()} data for {fyLabel(fyYear)}</div>
        )}

        {!loading && rows.map((row, i) => {
          const ym   = row.month || '';
          const { name, year } = monthFull(ym);
          const amount = Number(row.total_amount ?? row.net_amount ?? row.debit ?? 0);
          const count  = Number(row.bill_count ?? row.count ?? 0);
          return (
            <div key={ym || i} className="rl-month-row" onClick={() => drillInto(row)}>
              <div className="rl-month-label">
                {name}
                <span className="rl-month-label-year"> '{year}</span>
              </div>
              <div className="rl-month-side">
                <div className="rl-month-amount">₹{formatINR(amount)}</div>
                {count > 0 && (
                  <div className="rl-month-count">{count} voucher{count === 1 ? '' : 's'}</div>
                )}
              </div>
              <div className="rl-row-chev" style={{ marginLeft: 6 }}><ChevR /></div>
            </div>
          );
        })}

        {!loading && rows.length > 0 && (
          <div className="rl-footer">
            <span>{rows.length} month{rows.length === 1 ? '' : 's'}</span>
            <span className="rl-footer-total">₹{formatINR(grandTotal)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 14, width: '40%' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            <div className="rl-skel" style={{ height: 14, width: 72 }} />
            <div className="rl-skel" style={{ height: 10, width: 52 }} />
          </div>
        </div>
      ))}
    </>
  );
}
