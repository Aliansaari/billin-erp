// ── Fund Flow Statement (classic accounting-style three-level drill) ──
//
// Exact UI parallel of CashFlow.jsx. One component, three views via URL
// param ?view=:
//
//   ?view=register (default) → Monthly Funds-Flow Register
//     One row per calendar month between from..to. Columns:
//       Particulars | Working Capital (Opening | Closing) | Funds Flow
//     Cumulative running totals — month N's Opening equals month N−1's
//     Closing. The Grand-Total foot row shows period-level Opening,
//     Closing, and Σ Funds Flow (which equals Closing − Opening, the
//     report's own internal check).
//     ↑/↓ navigate · Enter drills to the month summary.
//
//   ?view=month&month=YYYY-MM → Funds Flow Summary for ONE month
//     Two-column statement: Sources (left) | Applications (right) with
//     totals at the foot. A small Working-Capital strip at the bottom
//     shows Current Assets / Current Liabilities / Working Capital
//     Opening, Closing, and Wkg Cap Increase — same shape standard reports print.
//     Click "Net Profit" / "Funds From Operations" → drill into the
//     existing Profit & Loss report scoped to the same month.
//     Esc → back to the register (handled by AppLayout's history.back).
//
//   Drill into Profit & Loss is via /reports/profit-loss?from_date&to_date
//     — that page already exists, mirroring the standard drill from
//     "Nett Profit" on the Funds Flow summary into the P&L statement.
//
// Number formatting + period presets + URL-driven state are byte-for-
// byte the same as CashFlow.jsx so the segmented preset chips read
// the same across financial reports.

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Button, DatePicker, message } from 'antd';
import {
  ReloadOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';
import './cash-flow.css';
import './fund-flow.css';

// ── Number formatting (mirrors CashFlow.jsx) ─────────────────────────
const fmtAmt = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtSigned = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return <span className="cf-zero">—</span>;
  if (n < 0) {
    return (
      <span className="cf-neg">
        (-){Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  }
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// ── Period presets — same set as CashFlow / MonthlySummary ──────────
function presetRange(key) {
  const today = dayjs();
  const fyStartYear = today.month() >= 3 ? today.year() : today.year() - 1;
  if (key === 'this_fy')    return { from: dayjs(`${fyStartYear}-04-01`),   to: dayjs(`${fyStartYear+1}-03-31`) };
  if (key === 'last_fy')    return { from: dayjs(`${fyStartYear-1}-04-01`), to: dayjs(`${fyStartYear}-03-31`) };
  if (key === 'this_month') return { from: today.startOf('month'),          to: today.endOf('month') };
  if (key === 'this_q') {
    const qStart = Math.floor(today.month() / 3) * 3;
    return { from: today.month(qStart).startOf('month'), to: today.endOf('month') };
  }
  return null;
}
const PRESETS = [
  { v: 'this_fy',    l: 'This FY' },
  { v: 'last_fy',    l: 'Last FY' },
  { v: 'this_q',     l: 'This Q' },
  { v: 'this_month', l: 'This Month' },
  { v: 'custom',     l: 'Custom' },
];

const fmtRange = (from, to) =>
  `${dayjs(from).format('D MMM YYYY')} — ${dayjs(to).format('D MMM YYYY')}`;

// ── Top-level switcher ───────────────────────────────────────────────
export default function FundFlow() {
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') || 'register';
  if (view === 'month') return <FundFlowMonthView />;
  return <FundFlowRegisterView />;
}

// ─────────────────────────────────────────────────────────────────────
// View 1 — Monthly Funds-Flow Register
// ─────────────────────────────────────────────────────────────────────
function FundFlowRegisterView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [fromDate, setFromDate] = useState(() => searchParams.get('from_date') || '');
  const [toDate,   setToDate]   = useState(() => searchParams.get('to_date')   || '');
  const [presetKey, setPresetKey] = useState(() => searchParams.get('preset') || 'this_fy');

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // URL sync — same shape as MonthlySummary so a copy-paste of the URL
  // restores the view-driving state.
  useEffect(() => {
    const next = { view: 'register' };
    if (fromDate)  next.from_date = fromDate;
    if (toDate)    next.to_date   = toDate;
    if (presetKey) next.preset    = presetKey;
    setSearchParams(next, { replace: true });
  }, [fromDate, toDate, presetKey, setSearchParams]);

  // Apply a default range on first mount so the page isn't blank.
  useEffect(() => {
    if (!fromDate && !toDate) {
      const r = presetRange('this_fy');
      if (r) {
        setFromDate(r.from.format('YYYY-MM-DD'));
        setToDate(r.to.format('YYYY-MM-DD'));
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetcher = useCallback(async () => {
    if (!fromDate || !toDate) return;
    setLoading(true);
    try {
      const r = await reportAPI.fundFlowMonthly({ from_date: fromDate, to_date: toDate });
      setData(r.data);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to load fund flow');
    }
    setLoading(false);
  }, [fromDate, toDate]);

  useEffect(() => { fetcher(); }, [fetcher]);
  useEffect(() => { setActiveIdx(0); }, [fromDate, toDate]);

  const applyPreset = useCallback((k) => {
    const r = presetRange(k);
    if (!r) return;
    setFromDate(r.from.format('YYYY-MM-DD'));
    setToDate(r.to.format('YYYY-MM-DD'));
    setPresetKey(k);
  }, []);

  // Drill into a month → ?view=month, preserving the FY range so the
  // back-button restores the register scrolled to the same row.
  const drillMonth = useCallback((monthIso) => {
    const qs = new URLSearchParams({ view: 'month', month: monthIso.slice(0, 7) });
    if (fromDate) qs.set('from_date', fromDate);
    if (toDate)   qs.set('to_date',   toDate);
    if (presetKey) qs.set('preset',   presetKey);
    navigate(`/reports/fund-flow?${qs.toString()}`);
  }, [navigate, fromDate, toDate, presetKey]);

  // Keyboard nav — same contract as CashFlow / MonthlySummary.
  useEffect(() => {
    if (!data?.rows?.length) return;
    const rowCount = data.rows.length;
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toUpperCase();
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
                   || e.target?.isContentEditable
                   || e.target?.closest?.('.ant-select, .ant-picker');
      if (inField) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(rowCount - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Home') {
        e.preventDefault(); setActiveIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault(); setActiveIdx(rowCount - 1);
      } else if (e.key === 'Enter') {
        const row = data.rows[activeIdx];
        if (row) drillMonth(row.month_iso);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, activeIdx, drillMonth]);

  // CSV export.
  const handleExportCsv = useCallback(() => {
    if (!data) return;
    const header = ['Month', 'Opening Working Capital', 'Closing Working Capital', 'Funds Flow'];
    const lines = data.rows.map((r) => [
      r.month_label,
      r.opening_wc.toFixed(2),
      r.closing_wc.toFixed(2),
      r.funds_flow.toFixed(2),
    ]);
    lines.push(['Grand Total',
      data.totals.opening_wc.toFixed(2),
      data.totals.closing_wc.toFixed(2),
      data.totals.funds_flow.toFixed(2)]);
    const csv = [header, ...lines]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fund-flow-${fromDate || 'fy'}-${toDate || ''}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  }, [data, fromDate, toDate]);

  return (
    <div className="cf-page">
      <div className="rpt-page-hd cf-hd">
        <div className="rpt-title">
          <h1>Fund Flow</h1>
        </div>
        <div className="rpt-hd-ctrl">
          <div className="rpt-period">
            {PRESETS.map((p) => (
              <button
                key={p.v}
                className={presetKey === p.v ? 'on' : ''}
                onClick={() => p.v === 'custom' ? setPresetKey('custom') : applyPreset(p.v)}
              >
                {p.l}
              </button>
            ))}
          </div>
          <DatePicker.RangePicker
            picker="month"
            className="rpt-date"
            value={[fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null]}
            onChange={(vals) => {
              if (!vals) return;
              setFromDate(vals[0].format('YYYY-MM-01'));
              setToDate(vals[1].endOf('month').format('YYYY-MM-DD'));
              setPresetKey('custom');
            }}
            format="MMM YYYY" allowClear={false}
          />
          <Button className="rpt-btn" icon={<ReloadOutlined />} onClick={fetcher} loading={loading}>Refresh</Button>
          {/* Print + Excel moved to the bottom strip (F9 / F10). */}
        </div>
      </div>

      {data
        ? <RegisterTable
            rows={data.rows}
            totals={data.totals}
            onRowClick={drillMonth}
            activeIdx={activeIdx}
            setActiveIdx={setActiveIdx}
          />
        : <div className="cf-skel">{loading ? 'Loading…' : 'Pick a period.'}</div>}

      <FundFlowRegisterStrip
        navigate={navigate}
        fromDate={fromDate}
        toDate={toDate}
        setFromDate={setFromDate}
        setToDate={setToDate}
        setPresetKey={setPresetKey}
        fetcher={fetcher}
        handleExportCsv={handleExportCsv}
        onDrill={() => {
          const row = data?.rows?.[activeIdx];
          if (row) drillMonth(row.month_iso);
        }}
        canDrill={!!(data?.rows?.[activeIdx])}
      />
    </div>
  );
}

function FundFlowRegisterStrip({ navigate, fromDate, toDate, setFromDate, setToDate, setPresetKey, fetcher, handleExportCsv, onDrill, canDrill }) {
  const { openDate } = useDatePopup();
  return (
    <ActionStrip
      actions={[
        { id: 'back', key: 'Esc', label: 'Back',
          onAction: () => navigate('/reports') },
        { id: 'period', key: 'F2', label: 'Period',
          onAction: () => openDate({
            mode: 'range', title: 'Period',
            value: [fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null],
            onConfirm: ([from, to]) => {
              setPresetKey('custom');
              setFromDate(from.format('YYYY-MM-DD'));
              setToDate(to.format('YYYY-MM-DD'));
            },
          }) },
        { id: 'refresh', key: 'F5', label: 'Refresh',
          onAction: () => fetcher() },
        { id: 'print', key: 'F9', label: 'Print',
          onAction: () => window.print() },
        { id: 'export', key: 'F10', label: 'Export',
          onAction: handleExportCsv },
        { id: 'drill', key: 'F1', label: 'Open Month', tone: 'primary',
          disabled: !canDrill,
          onAction: onDrill },
      ]}
    />
  );
}

// Register table — body + sticky bottom Grand-Total share a colgroup so
// columns line up regardless of content length. Mirrors the same
// pattern as CashFlow's RegisterTable.
function RegisterTable({ rows, totals, onRowClick, activeIdx, setActiveIdx }) {
  const activeRowRef = useRef(null);
  useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeIdx]);

  // 4-column grid: Particulars · Opening · Closing · Funds Flow.
  // We re-use cf-col-particulars / cf-col-num from cash-flow.css so the
  // visual density matches. Cash flow uses the same set.
  const Cols = () => (
    <colgroup>
      <col className="cf-col-particulars" />
      <col className="cf-col-num" />
      <col className="cf-col-num" />
      <col className="cf-col-num" />
    </colgroup>
  );

  // Empty-period detection — every month in the range has zero flow.
  // Common case: requesting a future FY that has no entries yet. We
  // still render the rows (with blank cells per standard accounting convention) and
  // surface a one-line banner above so the user reads it as "no
  // activity" rather than "report broken".
  const isEmptyPeriod = rows.length > 0
    && rows.every((r) => Math.abs(r.funds_flow) < 0.005);
  const carryingWc = isEmptyPeriod && rows[0] ? rows[0].opening_wc : null;

  return (
    <>
      {isEmptyPeriod && (
        <div className="ff-empty-period">
          <span className="ff-empty-period-icon">·</span>
          No transactions recorded in this period &mdash; working capital
          unchanged at <b>₹ {fmtAmt(carryingWc)}</b> throughout.
        </div>
      )}
      <div className="cf-tablewrap">
        <table className="cf-table">
          <Cols />
          <thead>
            <tr className="cf-th-grp">
              <th></th>
              <th colSpan={2} className="cf-grp-label">Working Capital</th>
              <th></th>
            </tr>
            <tr className="cf-th-cols">
              <th className="cf-th-particulars">Particulars</th>
              <th className="cf-th-num">Opening</th>
              <th className="cf-th-num">Closing</th>
              <th className="cf-th-num">Funds Flow</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={4} className="cf-empty">No working-capital activity in this period.</td></tr>
            ) : rows.map((r, i) => {
              const isActive = i === activeIdx;
              // Standard accounting convention — months with no activity (zero funds
              // flow) leave Opening/Closing/Funds-Flow cells blank
              // rather than repeating the carrying balance row after
              // row. The month label still renders so the time
              // progression is visible.
              const noActivity = Math.abs(r.funds_flow) < 0.005;
              return (
                <tr
                  key={r.month_iso}
                  ref={isActive ? activeRowRef : null}
                  className={'cf-row' + (isActive ? ' cf-row-active' : '')}
                  onMouseEnter={() => setActiveIdx?.(i)}
                  onClick={() => onRowClick(r.month_iso)}
                >
                  <td className="cf-particulars">{r.month_label}</td>
                  <td className="cf-num">{noActivity ? '' : fmtAmt(r.opening_wc)}</td>
                  <td className="cf-num">{noActivity ? '' : fmtAmt(r.closing_wc)}</td>
                  <td className="cf-num">{noActivity ? '' : fmtSigned(r.funds_flow)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="cf-totalwrap">
        <table className="cf-table cf-table-total">
          <Cols />
          <tbody>
            <tr className="cf-row-total">
              <td>Grand Total</td>
              <td className="cf-num">{fmtAmt(totals.opening_wc)}</td>
              <td className="cf-num">{fmtAmt(totals.closing_wc)}</td>
              <td className="cf-num">{fmtSigned(totals.funds_flow)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// View 2 — Funds Flow Summary for ONE month
// ─────────────────────────────────────────────────────────────────────
//
// Layout mirrors the standard fund-flow statement: top half is a two-column
// Sources/Applications statement, bottom strip is a small WC summary
// (CA / CL / Working Capital × Opening / Closing / Wkg Cap Increase).
//
// Drill targets:
//   • "Net Profit" / "Funds From Operations" in Sources → /reports/profit-loss
//     scoped to the same month
//   • "Net Loss" / "Funds Lost in Operations" in Applications → same
function FundFlowMonthView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const month = searchParams.get('month');           // YYYY-MM
  const fromDate  = searchParams.get('from_date') || '';
  const toDate    = searchParams.get('to_date')   || '';
  const presetKey = searchParams.get('preset')    || '';

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  // Two-side keyboard cursor: 'sources' | 'apps'.
  const [activeSide, setActiveSide] = useState('sources');
  const [activeIdx,  setActiveIdx]  = useState(0);

  // Resolve the month into ISO date bounds, then call the existing
  // /api/reports/fund-flow endpoint (which returns the full statement
  // for ANY date range — passing month-start/month-end gives us the
  // single-month version rendered here).
  const monthBounds = useMemo(() => {
    if (!month || !/^\d{4}-\d{2}/.test(month)) return null;
    const [y, m] = month.split('-').map(Number);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const end   = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of month
    return { from: start, to: end };
  }, [month]);

  useEffect(() => {
    if (!monthBounds) return;
    setLoading(true);
    reportAPI.fundFlow({ from_date: monthBounds.from, to_date: monthBounds.to })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load fund flow month'))
      .finally(() => setLoading(false));
  }, [monthBounds]);

  useEffect(() => { setActiveSide('sources'); setActiveIdx(0); }, [month]);

  // Build the back-link → restores ?view=register with the same period.
  const goBack = useCallback(() => {
    const qs = new URLSearchParams({ view: 'register' });
    if (fromDate)  qs.set('from_date', fromDate);
    if (toDate)    qs.set('to_date',   toDate);
    if (presetKey) qs.set('preset',    presetKey);
    navigate(`/reports/fund-flow?${qs.toString()}`);
  }, [navigate, fromDate, toDate, presetKey]);

  // Drill from "Net Profit" / "Funds From Operations" → P&L for this
  // same month. Existing ProfitLoss.jsx accepts from_date/to_date
  // query params directly.
  const drillToPl = useCallback(() => {
    if (!monthBounds) return;
    const qs = new URLSearchParams({
      from_date: monthBounds.from,
      to_date:   monthBounds.to,
    });
    navigate(`/reports/profit-loss?${qs.toString()}`);
  }, [navigate, monthBounds]);

  // Keyboard nav — ←/→ switches columns, ↑/↓ moves within, Enter drills
  // (only meaningful on Net Profit / Funds Lost rows for now).
  const sources     = data?.sources || [];
  const applications = data?.applications || [];
  useEffect(() => {
    if (!data) return;
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const list = activeSide === 'sources' ? sources : applications;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); setActiveIdx((i) => Math.min((list.length || 1) - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (activeSide === 'apps') { setActiveSide('sources'); setActiveIdx(0); }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (activeSide === 'sources') { setActiveSide('apps'); setActiveIdx(0); }
      } else if (e.key === 'Enter') {
        const row = list[activeIdx];
        if (!row) return;
        // Only Net Profit / Funds From Operations / Lost variants drill
        // into the supporting P&L. Everything else is informational.
        if (row.id === 'ffo' || row.id === 'ffl') drillToPl();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, activeSide, activeIdx, sources, applications, drillToPl]);

  return (
    <div className="cf-page">
      <div className="cf-hd">
        <div className="cf-title">
          <button className="cf-back" onClick={goBack}>
            <ArrowLeftOutlined /> Register
          </button>
          <h1>Funds Flow Summary</h1>
          <div className="cf-sub">
            {data ? `${dayjs(data.period.from).format('D MMM YYYY')} — ${dayjs(data.period.to).format('D MMM YYYY')}` : ' '}
          </div>
        </div>
        <div className="cf-actions">
          {/* Print moved to the bottom strip (F9). */}
        </div>
      </div>

      {!data ? (
        <div className="cf-skel">{loading ? 'Loading…' : 'Pick a month.'}</div>
      ) : (
        <FundFlowMonthBody
          data={data}
          activeSide={activeSide} setActiveSide={setActiveSide}
          activeIdx={activeIdx}   setActiveIdx={setActiveIdx}
          drillToPl={drillToPl}
        />
      )}

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: goBack },
          { id: 'print', key: 'F9', label: 'Print',
            onAction: () => window.print() },
          { id: 'drill', key: 'F1', label: 'Drill P&L', tone: 'primary',
            onAction: drillToPl },
        ]}
      />
    </div>
  );
}

// Month-summary body — top half is the two-column statement, bottom
// strip is the WC summary.
function FundFlowMonthBody({ data, activeSide, setActiveSide, activeIdx, setActiveIdx, drillToPl }) {
  const sources      = data.sources;
  const applications = data.applications;
  const totals       = data.totals;
  const sch          = data.schedule.totals;
  // Verify state — same logic as the existing statement view.
  const verifyState = totals.balanced
    ? 'ok'
    : Math.abs(totals.drift) > 0.01 ? 'danger' : 'warn';

  const sourceLabel = (row) => {
    // If FFO has no add-backs/less, surface "Net Profit" instead of
    // "Funds From Operations" — matches standard practice and is more
    // self-explanatory when there's nothing to adjust.
    if (row.id === 'ffo' && data.ffo.add_back.length === 0 && data.ffo.less.length === 0) {
      return 'Net Profit';
    }
    if (row.id === 'ffl' && data.ffo.add_back.length === 0 && data.ffo.less.length === 0) {
      return 'Net Loss';
    }
    return row.label;
  };
  const isDrillable = (row) => row.id === 'ffo' || row.id === 'ffl';

  return (
    <div className="ff-month-body">
      {/* ── Two-column Sources / Applications statement ──────────── */}
      <div className="ff-stmt">
        <div
          className={'ff-stmt-side' + (activeSide === 'sources' ? ' ff-side-active' : '')}
          onClick={() => setActiveSide('sources')}
        >
          <div className="ff-stmt-hd">
            <div className="ff-stmt-hd-l">Sources</div>
            <div className="ff-stmt-hd-r">{fmtRange(data.period.from, data.period.to)}</div>
          </div>
          <div className="ff-stmt-rows">
            {sources.length === 0 ? (
              <div className="ff-stmt-empty">No sources of funds this month.</div>
            ) : sources.map((row, i) => {
              const isActive = activeSide === 'sources' && i === activeIdx;
              const drillable = isDrillable(row);
              return (
                <div
                  key={row.id}
                  className={
                    'ff-stmt-row'
                    + (isActive ? ' ff-stmt-row-active' : '')
                    + (drillable ? ' ff-stmt-row-drill' : '')
                  }
                  onMouseEnter={() => { setActiveSide('sources'); setActiveIdx(i); }}
                  onClick={() => drillable && drillToPl()}
                >
                  <span className="ff-stmt-row-label">{sourceLabel(row)}</span>
                  <span className="ff-stmt-row-amt">{fmtAmt(row.amount)}</span>
                </div>
              );
            })}
          </div>
          <div className="ff-stmt-total">
            <span>Total</span>
            <span>{fmtAmt(totals.total_sources)}</span>
          </div>
        </div>

        <div
          className={'ff-stmt-side' + (activeSide === 'apps' ? ' ff-side-active' : '')}
          onClick={() => setActiveSide('apps')}
        >
          <div className="ff-stmt-hd">
            <div className="ff-stmt-hd-l">Applications</div>
            <div className="ff-stmt-hd-r">{fmtRange(data.period.from, data.period.to)}</div>
          </div>
          <div className="ff-stmt-rows">
            {applications.length === 0 ? (
              <div className="ff-stmt-empty">No applications of funds this month.</div>
            ) : applications.map((row, i) => {
              const isActive = activeSide === 'apps' && i === activeIdx;
              const drillable = isDrillable(row);
              return (
                <div
                  key={row.id}
                  className={
                    'ff-stmt-row'
                    + (isActive ? ' ff-stmt-row-active' : '')
                    + (drillable ? ' ff-stmt-row-drill' : '')
                  }
                  onMouseEnter={() => { setActiveSide('apps'); setActiveIdx(i); }}
                  onClick={() => drillable && drillToPl()}
                >
                  <span className="ff-stmt-row-label">{sourceLabel(row)}</span>
                  <span className="ff-stmt-row-amt">{fmtAmt(row.amount)}</span>
                </div>
              );
            })}
          </div>
          <div className="ff-stmt-total">
            <span>Total</span>
            <span>{fmtAmt(totals.total_applications)}</span>
          </div>
        </div>
      </div>

      {/* ── Working-Capital summary strip (bottom) ─────────────────
          Standard accounting convention: each balance is rendered as |amount| + a
          Dr/Cr tag derived from sign. CA defaults to Dr, CL defaults
          to Cr — but if an aggregate is naturally on the opposite
          side (eg. Sundry Creditors net Dr because of supplier
          advances/refunds), the tag flips so the operator sees the
          true direction rather than a confusing negative-with-Cr-tag.
          The signed delta still drives the Wkg Cap Increase column. */}
      <div className="ff-month-wc">
        <table className="ff-month-wc-tbl">
          <thead>
            <tr>
              <th className="l">Particulars</th>
              <th>Opening Balance</th>
              <th>Closing Balance</th>
              <th>Wkg Cap Increase</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="l">Current Assets</td>
              <td><DrCrAmount value={sch.opening_ca} naturalSide="Dr" /></td>
              <td><DrCrAmount value={sch.closing_ca} naturalSide="Dr" /></td>
              <td><WcDelta value={sch.closing_ca - sch.opening_ca} /></td>
            </tr>
            <tr>
              <td className="l">Current Liabilities</td>
              <td><DrCrAmount value={sch.opening_cl} naturalSide="Cr" /></td>
              <td><DrCrAmount value={sch.closing_cl} naturalSide="Cr" /></td>
              <td><WcDelta value={-(sch.closing_cl - sch.opening_cl)} /></td>
            </tr>
            <tr className="ff-month-wc-row-net">
              <td className="l">Working Capital</td>
              <td><DrCrAmount value={sch.opening_wc} naturalSide="Dr" /></td>
              <td><DrCrAmount value={sch.closing_wc} naturalSide="Dr" /></td>
              <td><WcDelta value={sch.net_change_in_wc} /></td>
            </tr>
          </tbody>
        </table>

        {/* Reconciliation banner — accounting identity: Sources − Applications = ΔWC.
            The bottom-row Working Capital "Wkg Cap Increase" must equal
            (Total Sources − Total Applications). A non-zero drift here
            means our classifier missed something — eg. a sub_group not
            covered by the FA / Investment / LTL lists. */}
        <div className={`ff-month-verify ff-${verifyState}`}>
          {verifyState === 'ok'
            ? <span>✓ Reconciled — Sources less Applications equals the change in Working Capital.</span>
            : verifyState === 'warn'
              ? <span>⚠ Sub-paisa rounding drift (within ±0.01).</span>
              : <span>✗ Out of balance: (Sources − Applications) − Δ Working Capital = ₹ {fmtAmt(Math.abs(totals.drift))}</span>}
        </div>
      </div>
    </div>
  );
}

// Render a balance with its classic accounting-style Dr/Cr tag. The natural side
// is what we expect (Dr for assets, Cr for liabilities); when the
// aggregate is naturally negative (eg. Sundry Creditors with net Dr
// balance from supplier advances), the tag flips so the operator
// reads the true direction rather than a confusing negative number
// with the wrong tag.
function DrCrAmount({ value, naturalSide }) {
  const n = Number(value) || 0;
  if (Math.abs(n) < 0.005) return <><span className="cf-zero">—</span></>;
  // Positive value → keep natural side. Negative value → flip side
  // and show absolute value.
  const sideShown = n >= 0
    ? naturalSide
    : (naturalSide === 'Dr' ? 'Cr' : 'Dr');
  const abs = Math.abs(n);
  return (
    <>
      {abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      {' '}<span className="ff-side-tag">{sideShown}</span>
    </>
  );
}

// Render a working-capital change column entry. Positive = increase
// (green), negative = decrease (rendered as `(-)X.XX` per standard format).
function WcDelta({ value }) {
  const n = Number(value) || 0;
  if (Math.abs(n) < 0.005) return <span className="cf-zero">—</span>;
  if (n < 0) {
    return (
      <span className="cf-neg">
        (-){Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  }
  return <span className="ff-wc-pos">{n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}
