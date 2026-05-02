// ── Cash Flow Statement (Tally-style three-level drill) ───────────────
//
// One component, three URL-driven views:
//
//   ?view=register (default) → Monthly Register
//     Shell mirrors MonthlySummary.jsx (.rpt-page-hd / preset chips /
//     month-range picker / Refresh-Print-Excel). Two-table layout —
//     scrollable body in .cf-tablewrap + sticky bottom total in
//     .cf-totalwrap, sharing a <colgroup> via <Cols/>.
//
//   ?view=month&month=YYYY-MM → Two-column Inflow / Outflow
//     Shell mirrors BalanceSheet.jsx (.cf-page → .cf-hd → .cf-headbar
//     → .cf-body two-column → .cf-totalbar sticky → .cf-nett centred).
//     ←/→ switches sides; ↑/↓ moves within the active side; Enter
//     drills the highlighted row.
//
//   ?view=group&month=YYYY-MM&sub_group=…&direction=in|out → Vouchers
//     Single chronological table, Date / Voucher / Contra / Amount,
//     with sticky-bottom Total. Terminal view (no further drill).
//
// Esc → AppLayout's history.back() handler. URL-driven design means
// that pops back to the previous view automatically.

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Button, DatePicker, message } from 'antd';
import {
  ReloadOutlined, PrinterOutlined, DownloadOutlined,
  ArrowLeftOutlined, CalendarOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import './cash-flow.css';

// ── Number formatting ────────────────────────────────────────────────
// Indian rupee, two decimals. Negative renders as `(-)X,XX,XXX.XX`
// inside a danger-colour wrapper — same visual contract used by Tally.
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

// Period presets — same set as MonthlySummary.jsx so the Reports
// segmented control reads the same across the family.
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

// Friendly date range label "1 Apr 2026 — 30 Apr 2026".
const fmtRange = (from, to) =>
  `${dayjs(from).format('D MMM YYYY')} — ${dayjs(to).format('D MMM YYYY')}`;

export default function CashFlow() {
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') || 'register';
  // Single component switching on view keeps URL-driven Esc behaviour
  // intact (history.back() pops to the previous view automatically).
  if (view === 'month') return <CashFlowMonthView />;
  if (view === 'group') return <CashFlowGroupView />;
  return <CashFlowRegisterView />;
}

// ── View 1 — Monthly Register ────────────────────────────────────────
function CashFlowRegisterView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [fromDate, setFromDate] = useState(() => searchParams.get('from_date') || '');
  const [toDate,   setToDate]   = useState(() => searchParams.get('to_date')   || '');
  const [presetKey, setPresetKey] = useState(() => searchParams.get('preset') || 'this_fy');

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // URL sync. Same shape as MonthlySummary so /loop preset chips
  // restore on reload.
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
      const r = await reportAPI.cashFlowMonthly({ from_date: fromDate, to_date: toDate });
      setData(r.data);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to load cash flow');
    }
    setLoading(false);
  }, [fromDate, toDate]);

  useEffect(() => { fetcher(); }, [fetcher]);

  // Reset highlighted row whenever the dataset shape changes.
  useEffect(() => { setActiveIdx(0); }, [fromDate, toDate]);

  const applyPreset = useCallback((k) => {
    const r = presetRange(k);
    if (!r) return;
    setFromDate(r.from.format('YYYY-MM-DD'));
    setToDate(r.to.format('YYYY-MM-DD'));
    setPresetKey(k);
  }, []);

  // Drill into a month → ?view=month, preserving the FY range so the
  // back-button returns to the same register.
  const drillMonth = useCallback((monthIso) => {
    const qs = new URLSearchParams({ view: 'month', month: monthIso.slice(0, 7) });
    if (fromDate) qs.set('from_date', fromDate);
    if (toDate)   qs.set('to_date',   toDate);
    if (presetKey) qs.set('preset',   presetKey);
    navigate(`/reports/cash-flow?${qs.toString()}`);
  }, [navigate, fromDate, toDate, presetKey]);

  // Keyboard nav — copy the contract from MonthlySummary.
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
    const header = ['Month', 'Inflow', 'Outflow', 'Nett Flow'];
    const lines = data.rows.map((r) => [
      r.month_label,
      r.inflow ? r.inflow.toFixed(2) : '',
      r.outflow ? r.outflow.toFixed(2) : '',
      r.nett ? r.nett.toFixed(2) : '',
    ]);
    lines.push(['Total',
      data.totals.inflow.toFixed(2),
      data.totals.outflow.toFixed(2),
      data.totals.nett.toFixed(2)]);
    const csv = [header, ...lines]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cash-flow-${fromDate || 'fy'}-${toDate || ''}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  }, [data, fromDate, toDate]);

  return (
    <div className="cf-page">
      <div className="rpt-page-hd cf-hd">
        <div className="rpt-title">
          <h1>Cash Flow</h1>
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
          <Button className="rpt-btn" icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
          <Button className="rpt-btn" icon={<DownloadOutlined />} onClick={handleExportCsv} type="primary">Excel</Button>
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

      <div className="cf-fbar">
        <span className="fkey"><kbd>↑</kbd> <kbd>↓</kbd> Navigate</span>
        <span className="fkey"><kbd>Enter</kbd> Drill into month</span>
        <span className="fkey"><kbd>Esc</kbd> Back</span>
        <span className="grow"></span>
      </div>
    </div>
  );
}

// Register table — body + sticky total share a colgroup so columns
// pin to the same vertical edges regardless of content length.
function RegisterTable({ rows, totals, onRowClick, activeIdx, setActiveIdx }) {
  const activeRowRef = useRef(null);
  useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeIdx]);

  const Cols = () => (
    <colgroup>
      <col className="cf-col-particulars" />
      <col className="cf-col-num" />
      <col className="cf-col-num" />
      <col className="cf-col-num" />
    </colgroup>
  );

  return (
    <>
      <div className="cf-tablewrap">
        <table className="cf-table">
          <Cols />
          <thead>
            <tr className="cf-th-grp">
              <th></th>
              <th colSpan={2} className="cf-grp-label">Cash Movement</th>
              <th></th>
            </tr>
            <tr className="cf-th-cols">
              <th className="cf-th-particulars">Particulars</th>
              <th className="cf-th-num">Inflow</th>
              <th className="cf-th-num">Outflow</th>
              <th className="cf-th-num">Nett Flow</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={4} className="cf-empty">No cash activity in this period.</td></tr>
            ) : rows.map((r, i) => {
              const isActive = i === activeIdx;
              return (
                <tr
                  key={r.month_iso}
                  ref={isActive ? activeRowRef : null}
                  className={'cf-row' + (isActive ? ' cf-row-active' : '')}
                  onMouseEnter={() => setActiveIdx?.(i)}
                  onClick={() => onRowClick(r.month_iso)}
                >
                  <td className="cf-particulars">{r.month_label}</td>
                  <td className="cf-num">{fmtAmt(r.inflow)}</td>
                  <td className="cf-num">{fmtAmt(r.outflow)}</td>
                  <td className="cf-num">{fmtSigned(r.nett)}</td>
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
              <td className="cf-num">{fmtAmt(totals.inflow)}</td>
              <td className="cf-num">{fmtAmt(totals.outflow)}</td>
              <td className="cf-num">{fmtSigned(totals.nett)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── View 2 — Two-column Inflow / Outflow ─────────────────────────────
function CashFlowMonthView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const month = searchParams.get('month');
  // Carry-through period state so the back-button restores the
  // register's range exactly.
  const fromDate  = searchParams.get('from_date') || '';
  const toDate    = searchParams.get('to_date')   || '';
  const presetKey = searchParams.get('preset')    || '';

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  // Two-side keyboard nav: 'in' | 'out'.
  const [activeSide, setActiveSide] = useState('in');
  const [activeIdx,  setActiveIdx]  = useState(0);

  useEffect(() => {
    if (!month) return;
    setLoading(true);
    reportAPI.cashFlowMonth({ month })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load cash flow month'))
      .finally(() => setLoading(false));
  }, [month]);

  // Reset cursor whenever the month changes.
  useEffect(() => { setActiveSide('in'); setActiveIdx(0); }, [month]);

  // Build the back-link → restores ?view=register with the same period.
  const goBack = useCallback(() => {
    const qs = new URLSearchParams({ view: 'register' });
    if (fromDate)  qs.set('from_date', fromDate);
    if (toDate)    qs.set('to_date',   toDate);
    if (presetKey) qs.set('preset',    presetKey);
    navigate(`/reports/cash-flow?${qs.toString()}`);
  }, [navigate, fromDate, toDate, presetKey]);

  // Drill a sub_group → the canonical detail report for that group,
  // scoped to the same month. Mirrors BalanceSheet.jsx's drill pattern
  // (which routes sub-groups to Trial Balance / P&L) so the operator
  // gets the SAME destination from any report when they ask "what's
  // behind this number?".
  //
  // Mapping is by exact sub_group name (matches what the server's
  // cashFlowMonth endpoint returns). Unrecognised sub_groups fall
  // back to the in-app voucher list (?view=group) — useful for niche
  // sub_groups like "Misc. Expenses" that don't have their own page.
  //
  // Month-based date params: each detail report reads its date filter
  // from a different param name (sales/purchases use from/to; bills-
  // outstanding uses as_of; day-book uses date/from/to). The mapping
  // table records the exact param contract per target.
  const drillGroup = useCallback((subGroup, direction) => {
    if (!month) return;
    const m = String(month).slice(0, 7);
    const [yr, mo] = m.split('-').map(Number);
    const monthFrom = `${yr}-${String(mo).padStart(2, '0')}-01`;
    const monthTo   = new Date(Date.UTC(yr, mo, 0)).toISOString().slice(0, 10);

    // sub_group → { path, params } resolver. Returns null if no
    // existing report fits the sub_group — caller falls back to the
    // in-app voucher list.
    const resolveTarget = (sg) => {
      const k = String(sg || '').trim();
      // Sales-side income → Sales Report (filtered to the month).
      if (k === 'Sales Accounts' || k === 'Sales Account')
        return { path: '/reports/sales', params: { from: monthFrom, to: monthTo } };
      // Purchase-side expense → Purchase Report.
      if (k === 'Purchase Accounts' || k === 'Purchase Account')
        return { path: '/reports/purchases', params: { from: monthFrom, to: monthTo } };
      // Sundry Debtors / Sundry Creditors are intentionally NOT in the
      // mapping. We tried routing them to /payments (Receipt / Payment
      // filter) and to /reports/bills-{receivable,payable}, but BOTH
      // showed numbers that don't reconcile with the headline
      // ₹X figure on Cash Flow Summary:
      //   - Bills R/P is a CURRENT-outstanding snapshot, not a
      //     month-of-receipts breakdown.
      //   - /payments only lists rows from payments_receipts; cash
      //     legs that came in via sales-bill direct postings (no
      //     standalone Receipt voucher) are missing from that table.
      // Falling through to the in-app voucher list (?view=group)
      // queries the SAME ledger_entries the cash-flow number is
      // computed from, so the breakdown always sums back to the
      // headline. That's the only page guaranteed to reconcile.
      // (Routing logic for these two sub-groups: explicitly fall
      // through by returning null below.)
      // Income / Expense buckets all live on P&L. The to-date drives
      // the "as on" period — P&L is range-scoped so we pass both.
      if (/^Direct Income|^Indirect Income|^Direct Expenses|^Indirect Expenses/.test(k))
        return { path: '/reports/profit-loss', params: { from: monthFrom, to: monthTo } };
      // Tally intermediate groups → Trial Balance group view.
      // Sub_group becomes the group filter so the user lands on the
      // ledger list under that bucket.
      if (k === 'Duties & Taxes' || k === 'Duties and Taxes' ||
          k === 'Output GST' || k === 'Input GST' ||
          k === 'Capital Account' || k === "Owner's Capital" || k === 'Capital' ||
          k === 'Loans (Liability)' || k === 'Bank OD A/c' || k === 'Bank OD/CC' ||
          k === 'Secured Loans' || k === 'Unsecured Loans' ||
          k === 'Fixed Assets' || k === 'Investments' ||
          k === 'Provisions' || k === 'Other Current Liabilities' ||
          k === 'Loans & Advances (Asset)' || k === 'Deposits (Asset)')
        return { path: '/reports/trial-balance', params: { group: k } };
      // Cash & bank movement (cash sweeps, contra entries) → Day Book
      // is the right detail page; operator can scan vouchers chrono.
      if (k === 'Cash-in-Hand' || k === 'Bank Accounts' || k === 'Bank Account')
        return { path: '/reports/day-book', params: { from: monthFrom, to: monthTo } };
      return null;
    };

    const target = resolveTarget(subGroup);
    if (target) {
      const qs = new URLSearchParams(target.params);
      navigate(`${target.path}?${qs.toString()}`);
      return;
    }

    // Fallback: sub_group has no canonical detail page — show the
    // in-app voucher list (one row per voucher).
    const qs = new URLSearchParams({
      view: 'group',
      month: month,
      sub_group: subGroup,
      direction,
    });
    if (fromDate)  qs.set('from_date', fromDate);
    if (toDate)    qs.set('to_date',   toDate);
    if (presetKey) qs.set('preset',    presetKey);
    navigate(`/reports/cash-flow?${qs.toString()}`);
  }, [navigate, month, fromDate, toDate, presetKey]);

  const inflowGroups  = data?.inflow_groups  || [];
  const outflowGroups = data?.outflow_groups || [];

  // Keyboard: ↑/↓ within current side, ←/→ switch sides, Enter drill.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toUpperCase();
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
                   || e.target?.isContentEditable
                   || e.target?.closest?.('.ant-select, .ant-picker');
      if (inField) return;
      const list = activeSide === 'in' ? inflowGroups : outflowGroups;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(list.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (outflowGroups.length > 0) {
          setActiveSide('out');
          setActiveIdx((i) => Math.min(Math.max(i, 0), outflowGroups.length - 1));
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (inflowGroups.length > 0) {
          setActiveSide('in');
          setActiveIdx((i) => Math.min(Math.max(i, 0), inflowGroups.length - 1));
        }
      } else if (e.key === 'Home') {
        e.preventDefault(); setActiveIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault(); setActiveIdx(Math.max(0, list.length - 1));
      } else if (e.key === 'Enter') {
        const row = list[activeIdx];
        if (row) drillGroup(row.sub_group, activeSide);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeSide, activeIdx, inflowGroups, outflowGroups, drillGroup]);

  const t = data?.totals || {};
  const nett = Number(t.nett) || 0;
  const period = data?.period;

  // Month switcher inside this view — picking a new month re-loads
  // the drill for that month without bouncing the user back to the
  // register first. Navigates to the same ?view=month URL with the
  // new month param so back/forward + Esc still work cleanly.
  const onPickMonth = (v) => {
    if (!v) return;
    const newMonth = v.format('YYYY-MM');
    const qs = new URLSearchParams({ view: 'month', month: newMonth });
    if (fromDate)  qs.set('from_date', fromDate);
    if (toDate)    qs.set('to_date',   toDate);
    if (presetKey) qs.set('preset',    presetKey);
    navigate(`/reports/cash-flow?${qs.toString()}`);
  };

  return (
    <div className="cf-page">
      <div className="cf-hd">
        <div className="cf-title">
          <button className="cf-back" onClick={goBack} title="Back to register">
            <ArrowLeftOutlined /> Cash Flow
          </button>
          {/* Title is constant — "Cash Flow Summary" — and the active
              month moves into the action-bar date picker on the right.
              This matches the Balance Sheet pattern (constant title +
              "As on" picker), which the user wants to mirror so the
              same chrome reads consistently across financial reports. */}
          <h1>Cash Flow Summary</h1>
        </div>
        <div className="cf-actions">
          {/* "For" picker — month-precision DatePicker. Selecting a
              new month immediately re-fetches the drill for that
              month (see onPickMonth above). Borderless variant +
              calendar icon = same visual treatment as Balance Sheet's
              .bs-dp picker. */}
          <div className="cf-dp">
            <span className="lbl">For</span>
            <DatePicker
              size="small"
              picker="month"
              format="MMM YYYY"
              suffixIcon={<CalendarOutlined />}
              allowClear={false}
              value={month ? dayjs(`${month}-01`) : null}
              onChange={onPickMonth}
              variant="borderless"
            />
          </div>
          <button className="cf-btn cf-btn-icon" onClick={() => window.print()} title="Print">
            <PrinterOutlined />
          </button>
        </div>
      </div>

      <div className="cf-headbar">
        <div className="cf-side">
          <div className="hh">
            <span>Inflow</span>
            <span className="r">Amount</span>
          </div>
        </div>
        <div className="cf-side">
          <div className="hh">
            <span>Outflow</span>
            <span className="r">Amount</span>
          </div>
        </div>
      </div>

      <div className="cf-body">
        <div className="cf-side">
          <table className="cf-table-side">
            <colgroup><col /><col style={{ width: 200 }} /></colgroup>
            <tbody>
              {loading ? (
                <tr><td colSpan={2} className="cf-loading">Loading…</td></tr>
              ) : inflowGroups.length === 0 ? (
                <tr><td colSpan={2} className="cf-empty">No inflows in this month.</td></tr>
              ) : inflowGroups.map((g, i) => {
                const active = activeSide === 'in' && i === activeIdx;
                return (
                  <tr key={g.sub_group}
                      className={'cf-row-sub' + (active ? ' cf-active' : '')}
                      onMouseEnter={() => { setActiveSide('in'); setActiveIdx(i); }}
                      onClick={() => drillGroup(g.sub_group, 'in')}>
                    <td>
                      <div className="sh">
                        <span className="name">{g.sub_group}</span>
                        <span className="arrow">→</span>
                      </div>
                    </td>
                    <td className="num">{fmtAmt(g.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="cf-side">
          <table className="cf-table-side">
            <colgroup><col /><col style={{ width: 200 }} /></colgroup>
            <tbody>
              {loading ? (
                <tr><td colSpan={2} className="cf-loading">Loading…</td></tr>
              ) : outflowGroups.length === 0 ? (
                <tr><td colSpan={2} className="cf-empty">No outflows in this month.</td></tr>
              ) : outflowGroups.map((g, i) => {
                const active = activeSide === 'out' && i === activeIdx;
                return (
                  <tr key={g.sub_group}
                      className={'cf-row-sub' + (active ? ' cf-active' : '')}
                      onMouseEnter={() => { setActiveSide('out'); setActiveIdx(i); }}
                      onClick={() => drillGroup(g.sub_group, 'out')}>
                    <td>
                      <div className="sh">
                        <span className="name">{g.sub_group}</span>
                        <span className="arrow">→</span>
                      </div>
                    </td>
                    <td className="num">{fmtAmt(g.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {data && (
        <>
          <div className="cf-totalbar">
            <div className="cf-side">
              <table>
                <colgroup><col /><col style={{ width: 200 }} /></colgroup>
                <tbody>
                  <tr className="cf-row-total">
                    <td><span className="label">Total · Inflow</span></td>
                    <td className="num">{fmtAmt(t.inflow)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="cf-side">
              <table>
                <colgroup><col /><col style={{ width: 200 }} /></colgroup>
                <tbody>
                  <tr className="cf-row-total">
                    <td><span className="label">Total · Outflow</span></td>
                    <td className="num">{fmtAmt(t.outflow)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className={'cf-nett ' + (nett < 0 ? 'cf-nett-out' : 'cf-nett-in')}>
            {nett >= 0
              ? <>Nett Inflow: <strong>{fmtAmt(nett)}</strong></>
              : <>Nett Outflow: <strong>{fmtAmt(Math.abs(nett))}</strong></>}
          </div>
        </>
      )}

      <div className="cf-fbar">
        <span className="fkey"><kbd>↑</kbd> <kbd>↓</kbd> Navigate</span>
        <span className="fkey"><kbd>←</kbd> <kbd>→</kbd> Switch side</span>
        <span className="fkey"><kbd>Enter</kbd> Drill into group</span>
        <span className="fkey"><kbd>Esc</kbd> Back</span>
        <span className="grow"></span>
      </div>
    </div>
  );
}

// Fallback month label when the API hasn't responded yet.
function _monthLabelFromKey(monthIsoOrKey) {
  if (!monthIsoOrKey) return null;
  const m = String(monthIsoOrKey).match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return `${months[Number(m[2]) - 1]} ${m[1]}`;
}

// ── View 3 — Voucher list ────────────────────────────────────────────
function CashFlowGroupView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const month     = searchParams.get('month');
  const subGroup  = searchParams.get('sub_group');
  const direction = searchParams.get('direction');
  const fromDate  = searchParams.get('from_date') || '';
  const toDate    = searchParams.get('to_date')   || '';
  const presetKey = searchParams.get('preset')    || '';

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!month || !subGroup || !direction) return;
    setLoading(true);
    reportAPI.cashFlowGroup({ month, sub_group: subGroup, direction })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load voucher list'))
      .finally(() => setLoading(false));
  }, [month, subGroup, direction]);

  const goBack = useCallback(() => {
    const qs = new URLSearchParams({ view: 'month', month });
    if (fromDate)  qs.set('from_date', fromDate);
    if (toDate)    qs.set('to_date',   toDate);
    if (presetKey) qs.set('preset',    presetKey);
    navigate(`/reports/cash-flow?${qs.toString()}`);
  }, [navigate, month, fromDate, toDate, presetKey]);

  const monthLabel = data?.period?.month_label || _monthLabelFromKey(month) || '';
  const dirLabel   = direction === 'in' ? 'Inflow' : 'Outflow';

  return (
    <div className="cf-page">
      <div className="cf-hd">
        <div className="cf-title">
          <button className="cf-back" onClick={goBack} title="Back">
            <ArrowLeftOutlined /> {monthLabel} {dirLabel}
          </button>
          <h1>{subGroup}</h1>
          <div className="cf-sub">
            Cash Flow · {monthLabel} · {subGroup} · {dirLabel}
          </div>
        </div>
        <div className="cf-actions">
          <button className="cf-btn cf-btn-icon" onClick={() => window.print()} title="Print">
            <PrinterOutlined />
          </button>
        </div>
      </div>

      <div className="cf-tablewrap">
        <table className="cf-table cf-table-vouchers">
          <colgroup>
            <col style={{ width: 130 }} />
            <col style={{ width: 200 }} />
            <col />
            <col style={{ width: 180 }} />
          </colgroup>
          <thead>
            <tr className="cf-th-cols">
              <th className="cf-th-particulars">Date</th>
              <th className="cf-th-particulars">Voucher</th>
              <th className="cf-th-particulars">Contra Ledger</th>
              <th className="cf-th-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="cf-loading">Loading…</td></tr>
            ) : !data || data.rows.length === 0 ? (
              <tr><td colSpan={4} className="cf-empty">No vouchers in this group.</td></tr>
            ) : data.rows.map((r) => (
              <tr key={r.entry_number} className="cf-row">
                <td className="cf-particulars">{dayjs(r.entry_date).format('D-MMM-YY')}</td>
                <td className="cf-particulars">{r.entry_number}</td>
                <td className="cf-particulars">{r.contra_label || <span className="cf-zero">—</span>}</td>
                <td className="cf-num">{fmtAmt(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && (
        <div className="cf-totalwrap">
          <table className="cf-table cf-table-total">
            <colgroup>
              <col style={{ width: 130 }} />
              <col style={{ width: 200 }} />
              <col />
              <col style={{ width: 180 }} />
            </colgroup>
            <tbody>
              <tr className="cf-row-total">
                <td>Total</td>
                <td></td>
                <td></td>
                <td className="cf-num">{fmtAmt(data.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="cf-fbar">
        <span className="fkey"><kbd>Esc</kbd> Back</span>
        <span className="grow"></span>
      </div>
    </div>
  );
}
