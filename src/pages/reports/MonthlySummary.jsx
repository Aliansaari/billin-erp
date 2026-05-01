// ── Monthly Register (Sales / Purchase / Payment / Receipt) — R10 v3 ─
//
// Tally's monthly-register data shape (Particulars / Debit / Credit /
// Closing Balance with running cumulative + Dr/Cr suffix), dressed in
// our modern dark-mode design system. Visual language matches Bills
// Outstanding (.bo-* family) so it sits naturally next to the rest of
// the Reports family.
//
// Four wrappers preset `mode`:
//   MonthlySalesRegister     → mode='sales'
//   MonthlyPurchaseRegister  → mode='purchase'
//   MonthlyPaymentRegister   → mode='payment'
//   MonthlyReceiptRegister   → mode='receipt'
//
// Compare-with toggle overlays a SECOND register's columns alongside
// the primary so operators can scan Sales↔Purchase or Receipt↔Payment
// month-by-month in one view.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Button, Select, Space, message, DatePicker, Tag, Tooltip } from 'antd';
import {
  ReloadOutlined, PrinterOutlined, DownloadOutlined,
  SwapOutlined, CalendarOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';

const fmtAmt = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtClosing = (closing, side) => {
  const n = Number(closing) || 0;
  if (n === 0) return <span className="mr-zero">—</span>;
  return (
    <>
      <span className="mr-num-strong">{n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      <span className={`mr-side mr-side-${side.toLowerCase()}`}>{' '}{side}</span>
    </>
  );
};

const MODE_META = {
  sales:    { label: 'Sales Register',    sub: 'Sales Account · monthly summary',     short: 'Sales' },
  purchase: { label: 'Purchase Register', sub: 'Purchase Account · monthly summary',  short: 'Purchase' },
  payment:  { label: 'Payment Register',  sub: 'Payment vouchers · monthly summary',  short: 'Payment' },
  receipt:  { label: 'Receipt Register',  sub: 'Receipt vouchers · monthly summary',  short: 'Receipt' },
};

// Last day of a month for drill-down.
function lastDayOf(monthIso) {
  return dayjs(monthIso).endOf('month').format('YYYY-MM-DD');
}

// Period presets mirror the Bills Outstanding pattern.
function presetRange(key) {
  const today = dayjs();
  const fyStartYear = today.month() >= 3 ? today.year() : today.year() - 1;
  if (key === 'this_fy')  return { from: dayjs(`${fyStartYear}-04-01`),   to: dayjs(`${fyStartYear+1}-03-31`) };
  if (key === 'last_fy')  return { from: dayjs(`${fyStartYear-1}-04-01`), to: dayjs(`${fyStartYear}-03-31`) };
  if (key === 'last_12m') return { from: today.subtract(11, 'month').startOf('month'), to: today.endOf('month') };
  if (key === 'this_q') {
    const qStart = Math.floor(today.month() / 3) * 3;
    return { from: today.month(qStart).startOf('month'), to: today.endOf('month') };
  }
  return null;
}

export default function MonthlyRegister({ mode }) {
  if (!MODE_META[mode]) throw new Error(`MonthlyRegister: unknown mode "${mode}"`);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const cfg = MODE_META[mode];

  const [overlay, setOverlay]   = useState(() => searchParams.get('overlay') || '');
  const [fromDate, setFromDate] = useState(() => searchParams.get('from_date') || '');
  const [toDate, setToDate]     = useState(() => searchParams.get('to_date') || '');
  const [presetKey, setPresetKey] = useState(() => searchParams.get('preset') || 'this_fy');
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);

  // URL sync.
  useEffect(() => {
    const next = {};
    if (overlay)   next.overlay   = overlay;
    if (fromDate)  next.from_date = fromDate;
    if (toDate)    next.to_date   = toDate;
    if (presetKey) next.preset    = presetKey;
    setSearchParams(next, { replace: true });
  }, [overlay, fromDate, toDate, presetKey, setSearchParams]);

  // ── Data fetch ───────────────────────────────────────────────────
  const fetcher = useCallback(async () => {
    setLoading(true);
    try {
      const params = { mode };
      if (overlay)  params.overlay   = overlay;
      if (fromDate) params.from_date = fromDate;
      if (toDate)   params.to_date   = toDate;
      const r = await reportAPI.monthlySummary(params);
      setData(r.data);
      if (!fromDate && r.data?.period?.from_date) setFromDate(r.data.period.from_date);
      if (!toDate   && r.data?.period?.to_date)   setToDate(r.data.period.to_date);
    } catch (e) {
      message.error('Failed to load register');
    }
    setLoading(false);
  }, [mode, overlay, fromDate, toDate]);

  useEffect(() => { fetcher(); }, [fetcher]);

  // ── Period preset click ──────────────────────────────────────────
  const applyPreset = useCallback((k) => {
    const r = presetRange(k);
    if (!r) return;
    setFromDate(r.from.format('YYYY-MM-DD'));
    setToDate(r.to.format('YYYY-MM-DD'));
    setPresetKey(k);
  }, []);

  // ── Drill-down: a month → existing detailed report ───────────────
  // Param names match SalesReport / PurchaseReport's URL contract: they
  // read `from` and `to` (NOT `from_date` / `to_date`). Without exact-
  // matching keys the receiving report falls back to its default range.
  const drillRow = useCallback((monthIso) => {
    const from = monthIso;
    const to   = lastDayOf(monthIso);
    if (mode === 'sales')    return navigate(`/reports/sales?from=${from}&to=${to}`);
    if (mode === 'purchase') return navigate(`/reports/purchases?from=${from}&to=${to}`);
    return navigate(`/payments?type=${mode === 'payment' ? 'Payment' : 'Receipt'}&from=${from}&to=${to}`);
  }, [mode, navigate]);

  // CSV export.
  const handleExportCsv = useCallback(() => {
    if (!data) return;
    const p = data.primary, o = data.overlay;
    const header = ['Month',
                    `${p.label} Debit`,  `${p.label} Credit`,  `${p.label} Closing`,
                    ...(o ? [`${o.label} Debit`, `${o.label} Credit`, `${o.label} Closing`] : [])];
    const lines = p.rows.map((r, i) => {
      const ovr = o ? o.rows[i] : null;
      return [
        r.month_label,
        r.dr ? r.dr.toFixed(2) : '',
        r.cr ? r.cr.toFixed(2) : '',
        r.closing ? r.closing.toFixed(2) + ' ' + r.closing_side : '',
        ...(ovr ? [
          ovr.dr ? ovr.dr.toFixed(2) : '',
          ovr.cr ? ovr.cr.toFixed(2) : '',
          ovr.closing ? ovr.closing.toFixed(2) + ' ' + ovr.closing_side : '',
        ] : []),
      ];
    });
    const csv = [header, ...lines]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${mode}_register_${fromDate || 'fy'}_${toDate || ''}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  }, [data, mode, fromDate, toDate]);

  const overlayOptions = useMemo(() => ([
    { value: '', label: 'Compare with…' },
    ...Object.entries(MODE_META).filter(([k]) => k !== mode).map(([k, m]) => ({ value: k, label: m.label })),
  ]), [mode]);

  return (
    <div className="mr-page">
      {/* Header */}
      <div className="mr-hd">
        <div className="mr-title">
          <h1>{cfg.label}</h1>
        </div>
        <div className="mr-actions">
          {[
            ['this_fy',  'This FY'],
            ['last_fy',  'Last FY'],
            ['last_12m', 'Last 12 Months'],
            ['this_q',   'This Quarter'],
          ].map(([k, label]) => (
            <Button key={k} size="small"
              type={presetKey === k ? 'primary' : 'default'}
              onClick={() => applyPreset(k)}>
              {label}
            </Button>
          ))}
          <DatePicker.RangePicker
            size="small" picker="month"
            value={[fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null]}
            onChange={(vals) => {
              if (!vals) return;
              setFromDate(vals[0].format('YYYY-MM-01'));
              setToDate(vals[1].endOf('month').format('YYYY-MM-DD'));
              setPresetKey('custom');
            }}
            format="MMM YYYY" allowClear={false}
            style={{ width: 220 }}
          />
          <Tooltip title="Overlay a second register's columns next to this one — useful for Sales↔Purchase or Receipt↔Payment">
            <Select
              size="small" value={overlay || ''} onChange={(v) => setOverlay(v || '')}
              style={{ width: 200 }}
              options={overlayOptions}
              suffixIcon={<SwapOutlined />}
            />
          </Tooltip>
          <Button size="small" icon={<ReloadOutlined />} onClick={fetcher} loading={loading}>Refresh</Button>
          <Button size="small" icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleExportCsv} type="primary">Excel</Button>
        </div>
      </div>

      {/* Scrollable table area + always-visible total footer below */}
      {data
        ? <RegisterTable primary={data.primary} overlay={data.overlay} onRowClick={drillRow} />
        : <div className="mr-skel">Loading…</div>}
    </div>
  );
}

// ── RegisterTable ────────────────────────────────────────────────────
//
// Modern dark-mode table with running closing balance + Dr/Cr suffix.
// Sticky header, hover-highlighted rows, opening-balance row when
// non-zero, double-line total separator.
function RegisterTable({ primary, overlay, onRowClick }) {
  const hasOpening = primary.opening_balance > 0 || (overlay && overlay.opening_balance > 0);
  // Total cols including the Particulars column. Used by the
  // group-label row's colSpan so the label spans Particulars + Dr +
  // Cr + Closing of the primary section. (Overlay groups pick up the
  // remaining 3 columns.)
  const primarySpan = 1 + 3;          // Particulars + Dr + Cr + Closing
  const lastClosing = primary.rows.length > 0
    ? fmtClosing(primary.rows[primary.rows.length-1].closing, primary.rows[primary.rows.length-1].closing_side)
    : '—';
  const lastOverlayClosing = overlay && overlay.rows.length > 0
    ? fmtClosing(overlay.rows[overlay.rows.length-1].closing, overlay.rows[overlay.rows.length-1].closing_side)
    : '—';

  // Shared colgroup so the scrollable body table + the fixed-bottom
  // total table align column-for-column. Particulars has a fixed
  // width so the columns don't drift between the two tables when
  // monthly amounts vary in length.
  const Cols = () => (
    <colgroup>
      <col className="mr-col-particulars" />
      <col className="mr-col-num" />
      <col className="mr-col-num" />
      <col className="mr-col-closing" />
      {overlay && (<>
        <col className="mr-col-num" />
        <col className="mr-col-num" />
        <col className="mr-col-closing" />
      </>)}
    </colgroup>
  );

  return (
    <>
      {/* Scrollable rows area */}
      <div className="mr-tablewrap">
        <table className="mr-table">
          <Cols />
          <thead>
            <tr className="mr-th-grp">
              <th colSpan={primarySpan} className="mr-grp-label mr-grp-primary">
                {primary.ledger_name}
                <span className="mr-grp-side"> · {primary.natural_side}-natural</span>
              </th>
              {overlay && (
                <th colSpan={3} className="mr-grp-label mr-grp-overlay">
                  {overlay.ledger_name}
                  <span className="mr-grp-side"> · {overlay.natural_side}-natural</span>
                </th>
              )}
            </tr>
            <tr className="mr-th-cols">
              <th className="mr-th-particulars">Particulars</th>
              <th className="mr-th-num">Debit</th>
              <th className="mr-th-num">Credit</th>
              <th className="mr-th-num mr-th-closing">Closing Balance</th>
              {overlay && <>
                <th className="mr-th-num mr-grp-overlay">Debit</th>
                <th className="mr-th-num mr-grp-overlay">Credit</th>
                <th className="mr-th-num mr-th-closing mr-grp-overlay">Closing Balance</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {hasOpening && (
              <tr className="mr-row-opening">
                <td>Opening Balance</td>
                <td className="mr-num"></td>
                <td className="mr-num"></td>
                <td className="mr-num">{fmtClosing(primary.opening_balance, primary.opening_side)}</td>
                {overlay && <>
                  <td className="mr-num mr-grp-overlay"></td>
                  <td className="mr-num mr-grp-overlay"></td>
                  <td className="mr-num mr-grp-overlay">{fmtClosing(overlay.opening_balance, overlay.opening_side)}</td>
                </>}
              </tr>
            )}
            {primary.rows.map((r, i) => {
              const ovr = overlay ? overlay.rows[i] : null;
              return (
                <tr key={r.month_iso} className="mr-row" onClick={() => onRowClick(r.month_iso)}>
                  <td className="mr-particulars">{r.month_label}</td>
                  <td className="mr-num">{fmtAmt(r.dr)}</td>
                  <td className="mr-num">{fmtAmt(r.cr)}</td>
                  <td className="mr-num">{fmtClosing(r.closing, r.closing_side)}</td>
                  {overlay && <>
                    <td className="mr-num mr-grp-overlay">{fmtAmt(ovr?.dr)}</td>
                    <td className="mr-num mr-grp-overlay">{fmtAmt(ovr?.cr)}</td>
                    <td className="mr-num mr-grp-overlay">{fmtClosing(ovr?.closing, ovr?.closing_side)}</td>
                  </>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Always-visible total — separate table pinned below the scroll area.
          Same colgroup so columns align with the body table above. */}
      <div className="mr-totalwrap">
        <table className="mr-table mr-table-total">
          <Cols />
          <tbody>
            <tr className="mr-row-total">
              <td>Total</td>
              <td className="mr-num">{fmtAmt(primary.totals.dr)}</td>
              <td className="mr-num">{fmtAmt(primary.totals.cr)}</td>
              <td className="mr-num">{lastClosing}</td>
              {overlay && <>
                <td className="mr-num mr-grp-overlay">{fmtAmt(overlay.totals.dr)}</td>
                <td className="mr-num mr-grp-overlay">{fmtAmt(overlay.totals.cr)}</td>
                <td className="mr-num mr-grp-overlay">{lastOverlayClosing}</td>
              </>}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
