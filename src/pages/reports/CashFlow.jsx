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

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Button, DatePicker, Checkbox, Popover, Input, message } from 'antd';
import {
  ReloadOutlined, PrinterOutlined, DownloadOutlined,
  ArrowLeftOutlined, CalendarOutlined, SettingOutlined, SearchOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import VirtualReportTable from '../../components/VirtualReportTable';
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
// Day Book-style column registry for the cash-flow voucher list.
// Persisted column visibility uses a per-page key so it doesn't
// collide with Day Book's own preferences.
//
// "Party" and "Details" answer different questions:
//   - Party   → just the customer/supplier name (one or two names,
//               easy to scan). Default ON.
//   - Details → the FULL contra-leg list (Sales Account, CGST Output,
//               SGST Output, party, etc.). Default OFF — useful when
//               reconciling a single voucher's posting; noisy for
//               normal use. The user opts in via Customize.
//
// Bumped storage key to v2 so the new defaults take effect on first
// open instead of inheriting v1's "party = full contra list".
const CFG_ALL_COLS = [
  { key: 'sr_no',    label: 'Sr No',        default: true  },
  { key: 'date',     label: 'Date',         default: true  },
  { key: 'type',     label: 'Voucher Type', default: true  },
  { key: 'no',       label: 'Voucher No',   default: true  },
  { key: 'party',    label: 'Party',        default: true  },
  { key: 'details',  label: 'Details',      default: false },
  { key: 'amount',   label: 'Amount',       default: true  },
];
const CFG_COLS_KEY     = 'cashFlowGroup_cols_v2';
const CFG_DEFAULT_COLS = CFG_ALL_COLS.reduce((o, c) => ({ ...o, [c.key]: c.default }), {});

// Voucher-number prefix → voucher type. Same convention shipping in
// the rest of the app (SAL/PUR/REC/PAY/JV/CONTRA/CN/DN). Falls back
// to "—" so unknown prefixes don't crash the cell.
function _voucherTypeFromNumber(no) {
  const s = String(no || '').toUpperCase();
  if (s.startsWith('SAL'))    return 'Sales';
  if (s.startsWith('PUR'))    return 'Purchase';
  if (s.startsWith('REC'))    return 'Receipt';
  if (s.startsWith('PAY'))    return 'Payment';
  if (s.startsWith('JV'))     return 'Journal';
  if (s.startsWith('CONTRA')) return 'Contra';
  if (s.startsWith('CN-SAL') || s.startsWith('CN-'))   return 'Sales Return';
  if (s.startsWith('DN-PUR') || s.startsWith('DN-'))   return 'Purchase Return';
  return '—';
}
const _CF_TYPE_TONE = {
  'Sales':           'success',
  'Sales Return':    'warning',
  'Purchase':        'accent',
  'Purchase Return': 'warning',
  'Receipt':         'success',
  'Payment':         'danger',
  'Journal':         'info',
  'Contra':          'neutral',
};

// View 3 — Day Book-style voucher list scoped to a single
// (month, sub_group, direction). Mirrors DayBook.jsx's chrome
// (search box, customize popover, VirtualReportTable, sticky
// bottom total) so operators land on a familiar layout. KPI
// cards intentionally OMITTED — the only meaningful number on
// this terminal view is the total, which already lives in the
// sticky bottom strip; KPIs would be redundant.
function CashFlowGroupView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const month     = searchParams.get('month');
  const subGroup  = searchParams.get('sub_group');
  const direction = searchParams.get('direction');
  // Outer-period passthrough — preserves the register's date range
  // through the drill chain so the back-link returns to the same view.
  // NOT used as a filter on this page; that's `gFrom` / `gTo` below.
  const fromDate  = searchParams.get('from_date') || '';
  const toDate    = searchParams.get('to_date')   || '';
  const presetKey = searchParams.get('preset')    || '';

  // Date-range filter for THIS view. URL params `from` and `to`
  // override the month-derived range. Default = the full month the
  // user originally drilled from. Lets the user widen ("show me all
  // Sundry Debtors inflow for this whole quarter") or narrow ("only
  // the last week of Jan") without leaving the page.
  const monthFromIso = useMemo(() => {
    if (!month) return '';
    const [y, m] = month.split('-').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-01`;
  }, [month]);
  const monthToIso = useMemo(() => {
    if (!month) return '';
    const [y, m] = month.split('-').map(Number);
    return dayjs(`${y}-${String(m).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');
  }, [month]);
  const gFrom = searchParams.get('from') || monthFromIso;
  const gTo   = searchParams.get('to')   || monthToIso;

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [colsVisible, setColsVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CFG_COLS_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...CFG_DEFAULT_COLS, ...saved } : CFG_DEFAULT_COLS;
    } catch { return CFG_DEFAULT_COLS; }
  });
  useEffect(() => {
    try { localStorage.setItem(CFG_COLS_KEY, JSON.stringify(colsVisible)); } catch {}
  }, [colsVisible]);

  useEffect(() => {
    if (!month || !subGroup || !direction) return;
    setLoading(true);
    reportAPI.cashFlowGroup({
      month,
      sub_group: subGroup,
      direction,
      // Pass the date-range override only when the URL has explicit
      // from/to (i.e., user changed the picker). Lets the server
      // fall back to its month-derived default when we send the
      // bare month — keeps the URL clean for the common case.
      ...(searchParams.get('from') ? { from_date: gFrom } : {}),
      ...(searchParams.get('to')   ? { to_date:   gTo   } : {}),
    })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load voucher list'))
      .finally(() => setLoading(false));
    // searchParams.toString() in deps so URL changes (date picker
    // updates from/to) re-trigger the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, subGroup, direction, gFrom, gTo]);

  // Date-range picker handler — updates URL `from` / `to`. Empty
  // values are dropped so picking "back to default month" cleans
  // the URL.
  const onPickRange = (vals) => {
    const next = new URLSearchParams(searchParams);
    if (vals?.[0] && vals?.[1]) {
      next.set('from', vals[0].format('YYYY-MM-DD'));
      next.set('to',   vals[1].format('YYYY-MM-DD'));
    } else {
      next.delete('from');
      next.delete('to');
    }
    navigate(`/reports/cash-flow?${next.toString()}`);
  };

  const goBack = useCallback(() => {
    const qs = new URLSearchParams({ view: 'month', month });
    if (fromDate)  qs.set('from_date', fromDate);
    if (toDate)    qs.set('to_date',   toDate);
    if (presetKey) qs.set('preset',    presetKey);
    navigate(`/reports/cash-flow?${qs.toString()}`);
  }, [navigate, month, fromDate, toDate, presetKey]);

  const monthLabel = data?.period?.month_label || _monthLabelFromKey(month) || '';
  const dirLabel   = direction === 'in' ? 'Inflow' : 'Outflow';

  // Client-side search across the loaded set — same UX as Day Book's
  // search box: matches voucher number, contra label, formatted date,
  // and the raw amount. Case-insensitive.
  const filteredRows = useMemo(() => {
    const rows = data?.rows || [];
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) =>
      String(r.entry_number || '').toLowerCase().includes(q) ||
      String(r.party_label  || '').toLowerCase().includes(q) ||
      String(r.contra_label || '').toLowerCase().includes(q) ||
      dayjs(r.entry_date).format('DD/MM/YYYY').includes(q) ||
      String(r.amount || '').includes(q)
    );
  }, [data, search]);

  const filteredTotal = useMemo(() => {
    return filteredRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  }, [filteredRows]);

  // Direction-aware amount colour: green for inflow, danger for
  // outflow — matches the colour vocabulary used elsewhere on the
  // cash-flow pages (Nett Inflow / Outflow line + register's nett).
  const amountColour = direction === 'in' ? 'var(--success)' : 'var(--danger)';

  const COL_SPECS = useMemo(() => ({
    sr_no:  { title: 'Sr', width: 56, align: 'center',
              render: (_v, _r, idx) => (
                <span style={{ color: 'var(--fg-tertiary)', fontFamily: 'Geist Mono, monospace' }}>
                  {idx + 1}
                </span>
              ) },
    date:   { title: 'Date', dataIndex: 'entry_date', width: 110,
              render: (v) => dayjs(v).format('DD/MM/YYYY') },
    type:   { title: 'Voucher Type', width: 130,
              render: (_v, r) => {
                const t = _voucherTypeFromNumber(r.entry_number);
                if (t === '—') return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
                return <span className={`rpt-pill type-${_CF_TYPE_TONE[t] || 'neutral'}`}>{t}</span>;
              } },
    no:     { title: 'Voucher No', dataIndex: 'entry_number', width: 160,
              render: (v) => <span className="rpt-bill-no">{v}</span> },
    // Party = just the customer/supplier name(s), filtered server-
    // side to is_party_ledger=true. Falls back to contra_label when
    // a voucher has no party leg (rare — opening JV, cash-only sale
    // posted directly to a non-party ledger, etc.) so the cell is
    // never empty when there's a sensible alternative.
    party:  { title: 'Party', dataIndex: 'party_label', width: 220,
              render: (v, r) => {
                const txt = v || r.contra_label;
                return txt
                  ? <span style={{ color: 'var(--fg-primary)' }}>{txt}</span>
                  : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
              } },
    // Details = full contra-leg list (party + tax accounts + sales/
    // purchase accounts). Useful for voucher-level reconciliation;
    // off by default so the table isn't a wall of noise.
    details: { title: 'Details', dataIndex: 'contra_label',
               render: (v) => v
                 ? <span style={{ color: 'var(--fg-secondary)', fontSize: 12 }}>{v}</span>
                 : <span style={{ color: 'var(--fg-tertiary)' }}>—</span> },
    amount: { title: 'Amount', dataIndex: 'amount', width: 150, align: 'right',
              render: (v) => {
                const n = Number(v) || 0;
                if (n === 0) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
                return <span style={{ color: amountColour, fontWeight: 600 }}>{fmtAmt(n)}</span>;
              } },
  }), [amountColour]);

  const columns = useMemo(() => {
    return CFG_ALL_COLS.filter((c) => colsVisible[c.key]).map((c) => ({ key: c.key, ...COL_SPECS[c.key] }));
  }, [colsVisible, COL_SPECS]);

  // Bottom Total — colSpan-merge the leading non-aggregable columns
  // into one wide cell holding "Total (N)", then drop the amount sum
  // into the Amount column. Same pattern as Day Book / Sales Report.
  const SUMMABLE_KEYS = useMemo(() => new Set(['amount']), []);
  const firstAggIdx = useMemo(() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  }, [columns, SUMMABLE_KEYS]);

  const summaryCells = (col, idx) => {
    if (idx === 0) return filteredRows.length > 0 ? `Total (${filteredRows.length})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;
    if (col.key === 'amount') return (
      <span style={{ color: amountColour, fontWeight: 700 }}>{fmtAmt(filteredTotal)}</span>
    );
    return null;
  };
  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  const customizePopoverContent = (
    <div style={{ width: 280 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
        Columns
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
        {CFG_ALL_COLS.map((c) => (
          <Checkbox key={c.key} checked={!!colsVisible[c.key]}
            onChange={(e) => setColsVisible((v) => ({ ...v, [c.key]: e.target.checked }))}>
            {c.label}
          </Checkbox>
        ))}
      </div>
    </div>
  );

  const handleExport = () => {
    // Excel export always includes BOTH the Party and Details columns
    // even if they're toggled off in the on-screen view — the export
    // is the canonical record, and it costs nothing to include both
    // for downstream reconciliation.
    const head = ['Sr', 'Date', 'Voucher Type', 'Voucher No', 'Party', 'Details', 'Amount'];
    const csv = [head.join(',')]
      .concat(filteredRows.map((r, i) => [
        i + 1,
        dayjs(r.entry_date).format('DD/MM/YYYY'),
        _voucherTypeFromNumber(r.entry_number),
        r.entry_number,
        `"${(r.party_label  || '').replace(/"/g, '""')}"`,
        `"${(r.contra_label || '').replace(/"/g, '""')}"`,
        Number(r.amount || 0).toFixed(2),
      ].join(',')))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cash-flow_${(monthLabel || month).replace(/\s+/g, '-')}_${subGroup.replace(/\s+/g, '-')}_${direction}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="report-editorial" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="rpt-page-hd" style={{ alignItems: 'center' }}>
        <div className="rpt-title">
          <button className="cf-back" onClick={goBack} title="Back">
            <ArrowLeftOutlined /> {monthLabel} {dirLabel}
          </button>
          <h1>{subGroup}</h1>
        </div>
        <div className="rpt-hd-ctrl">
          {/* Date-range filter — defaults to the original drilled
              month, but the user can widen ("show me the whole
              quarter") or narrow ("just last week") without leaving
              this view. Bottom Total + reconciliation auto-update. */}
          <DatePicker.RangePicker
            className="rpt-date"
            format="DD/MM/YYYY"
            allowClear={false}
            value={[gFrom ? dayjs(gFrom) : null, gTo ? dayjs(gTo) : null]}
            onChange={onPickRange}
          />
          <Popover content={customizePopoverContent} title="Customize" trigger="click" placement="bottomRight">
            <Button icon={<SettingOutlined />} className="rpt-btn">Customize</Button>
          </Popover>
          <Button icon={<DownloadOutlined />} onClick={handleExport} className="rpt-btn">Excel</Button>
          <Button icon={<PrinterOutlined />}  onClick={() => window.print()} className="rpt-btn">Print</Button>
        </div>
      </div>

      <div className="rpt-filter">
        <Input
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder="Search voucher no, contra ledger, date, or amount…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <div className="rpt-tbl-wrap">
        <VirtualReportTable
          columns={columns}
          rows={filteredRows}
          totalCount={filteredRows.length}
          loading={loading}
          rowKey="entry_number"
          scroll={{ x: 900 }}
          summaryCells={summaryCells}
          summaryColSpan={summaryColSpan}
        />
      </div>
    </div>
  );
}
