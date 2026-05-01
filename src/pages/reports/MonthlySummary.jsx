// ── Monthly Register (Sales / Purchase / Payment / Receipt) — R10 v2 ─
//
// Tally-faithful monthly register. Four wrappers preset `mode`:
//   MonthlySalesRegister     → mode='sales'
//   MonthlyPurchaseRegister  → mode='purchase'
//   MonthlyPaymentRegister   → mode='payment'
//   MonthlyReceiptRegister   → mode='receipt'
//
// Layout matches the Tally screenshot exactly:
//
//   ┌───────────────────────────────────────────────────────────┐
//   │ Sales Register                Sabina Dresses        ✕    │  ← title strip
//   ├───────────────────────────────────────────────────────────┤
//   │                                  Sales                    │  ← ledger label
//   │ Particulars              Sabina Dresses                   │
//   │                          1-Apr-25 to 31-Mar-26            │
//   │                          Transactions   │ Closing         │
//   │                          Debit  | Credit│ Balance         │
//   ├──────────────────────────────────────────┼────────────────┤
//   │ April                          5,20,010.50 │ 5,20,010.50 Cr│  ← month rows
//   │ May                            5,82,691.00 │ 11,02,701.50 Cr│
//   │ ...                                                       │
//   └───────────────────────────────────────────────────────────┘
//
// Compare-with toggle at top-right lays a SECOND register's columns
// alongside the primary so operators can scan Sales vs Purchase or
// Receipt vs Payment month-by-month.

import React, { useEffect, useState, useCallback } from 'react';
import { Button, Select, Space, message, DatePicker } from 'antd';
import { ReloadOutlined, PrinterOutlined, DownloadOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';

// Indian-style number format with two decimals, italic per Tally.
const fmtAmt = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return '';   // Tally blanks out zero cells
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtClosing = (closing, side) => {
  const n = Number(closing) || 0;
  if (n === 0) return '';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + side;
};
const fmtTallyDate = (iso) => {
  const d = dayjs(iso);
  return d.format('D-MMM-YY');
};

const MODE_LABEL = {
  sales:    'Sales Register',
  purchase: 'Purchase Register',
  payment:  'Payment Register',
  receipt:  'Receipt Register',
};

// Last day of a month for drill-down.
function lastDayOf(monthIso) {
  return dayjs(monthIso).endOf('month').format('YYYY-MM-DD');
}

export default function MonthlyRegister({ mode }) {
  if (!MODE_LABEL[mode]) throw new Error(`MonthlyRegister: unknown mode "${mode}"`);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── State ─────────────────────────────────────────────────────────
  const [overlay, setOverlay]   = useState(() => searchParams.get('overlay') || '');
  const [fromDate, setFromDate] = useState(() => searchParams.get('from_date') || '');
  const [toDate, setToDate]     = useState(() => searchParams.get('to_date') || '');
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);

  // URL sync.
  useEffect(() => {
    const next = {};
    if (overlay)  next.overlay   = overlay;
    if (fromDate) next.from_date = fromDate;
    if (toDate)   next.to_date   = toDate;
    setSearchParams(next, { replace: true });
  }, [overlay, fromDate, toDate, setSearchParams]);

  // ── Data fetch ────────────────────────────────────────────────────
  const fetcher = useCallback(async () => {
    setLoading(true);
    try {
      const params = { mode };
      if (overlay)  params.overlay   = overlay;
      if (fromDate) params.from_date = fromDate;
      if (toDate)   params.to_date   = toDate;
      const r = await reportAPI.monthlySummary(params);
      setData(r.data);
      // If we didn't pass dates, hydrate from server defaults so the
      // picker shows the period actually rendered.
      if (!fromDate && r.data?.period?.from_date) setFromDate(r.data.period.from_date);
      if (!toDate   && r.data?.period?.to_date)   setToDate(r.data.period.to_date);
    } catch (e) {
      message.error('Failed to load register');
    }
    setLoading(false);
  }, [mode, overlay, fromDate, toDate]);

  useEffect(() => { fetcher(); }, [fetcher]);

  // Drill-down: click a month row → existing detailed report for that
  // month's range. Sales/Purchase route to the existing Sales/Purchase
  // Report; Payment/Receipt route to the Payments list filtered by
  // type + date.
  const drillRow = useCallback((monthIso) => {
    const from = monthIso;
    const to   = lastDayOf(monthIso);
    if (mode === 'sales')    return navigate(`/reports/sales?from_date=${from}&to_date=${to}`);
    if (mode === 'purchase') return navigate(`/reports/purchases?from_date=${from}&to_date=${to}`);
    // Payment / Receipt → Payments list — existing screen accepts a
    // type filter via query string. Keep this drill best-effort; the
    // list page handles unrecognised params gracefully.
    return navigate(`/payments?type=${mode === 'payment' ? 'Payment' : 'Receipt'}&from_date=${from}&to_date=${to}`);
  }, [mode, navigate]);

  // CSV export — matches the on-screen layout (overlay columns
  // included when toggled).
  const handleExportCsv = useCallback(() => {
    if (!data) return;
    const p = data.primary, o = data.overlay;
    const header = ['Particulars',
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

  if (!data) {
    return <div className="mr-page"><div className="mr-skel">Loading…</div></div>;
  }

  const { primary, overlay: overlayData, period, company_name } = data;

  return (
    <div className="mr-page">
      {/* ── Title strip — Sales Register | Sabina Dresses | ✕ ────── */}
      <div className="mr-titlebar">
        <div className="mr-title-left">{MODE_LABEL[mode]}</div>
        <div className="mr-title-center">{company_name}</div>
        <div className="mr-title-right">
          <button className="mr-close" onClick={() => navigate('/reports')} aria-label="Close">×</button>
        </div>
      </div>

      {/* ── Toolbar (period + compare-with + export) ─────────────── */}
      <div className="mr-toolbar">
        <Space size={6} wrap>
          <DatePicker.RangePicker
            size="small"
            picker="month"
            value={[fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null]}
            onChange={(vals) => {
              if (!vals) return;
              setFromDate(vals[0].format('YYYY-MM-01'));
              setToDate(vals[1].endOf('month').format('YYYY-MM-DD'));
            }}
            format="MMM YYYY"
            allowClear={false}
            style={{ width: 230 }}
          />
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Compare with:</span>
          <Select
            size="small"
            value={overlay || ''}
            onChange={(v) => setOverlay(v || '')}
            style={{ width: 180 }}
            options={[
              { value: '',         label: 'None' },
              ...Object.entries(MODE_LABEL)
                .filter(([k]) => k !== mode)
                .map(([k, label]) => ({ value: k, label })),
            ]}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={fetcher} loading={loading}>Refresh</Button>
          <Button size="small" icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleExportCsv}>Excel</Button>
        </Space>
      </div>

      {/* ── Tally-style table ───────────────────────────────────── */}
      <RegisterTable primary={primary} overlay={overlayData} period={period} companyName={company_name} onRowClick={drillRow} />
    </div>
  );
}

// ── RegisterTable ─────────────────────────────────────────────────────
//
// Tally-faithful table render. Two layers of headers — primary column
// group always present; overlay column group appended when `overlay`
// is non-null.
function RegisterTable({ primary, overlay, period, companyName, onRowClick }) {
  const [activeRow, setActiveRow] = useState(0);  // April highlighted by default
  const groupSpan = overlay ? 6 : 3;

  return (
    <div className="mr-tablewrap">
      <table className="mr-table">
        <colgroup>
          <col className="mr-col-particulars" />
          <col /><col /><col />
          {overlay && (<><col /><col /><col /></>)}
        </colgroup>
        <thead>
          {/* Row 1: ledger-label group header (italic, like Tally) */}
          <tr className="mr-th-group">
            <th></th>
            <th className="mr-grp-label" colSpan={3}>
              <span className="mr-grp-italic">{primary.ledger_name}</span>
            </th>
            {overlay && (
              <th className="mr-grp-label mr-grp-overlay" colSpan={3}>
                <span className="mr-grp-italic">{overlay.ledger_name}</span>
              </th>
            )}
          </tr>
          {/* Row 2: company name */}
          <tr className="mr-th-sub">
            <th></th>
            <th colSpan={3} className="mr-grp-label"><b>{companyName}</b></th>
            {overlay && <th colSpan={3} className="mr-grp-label mr-grp-overlay"><b>{companyName}</b></th>}
          </tr>
          {/* Row 3: period */}
          <tr className="mr-th-sub">
            <th></th>
            <th colSpan={3} className="mr-grp-label">{period.fy_label}</th>
            {overlay && <th colSpan={3} className="mr-grp-label mr-grp-overlay">{period.fy_label}</th>}
          </tr>
          {/* Row 4: Transactions / Closing-Balance group */}
          <tr className="mr-th-sub">
            <th></th>
            <th colSpan={2} className="mr-grp-label"><b>Transactions</b></th>
            <th rowSpan={2} className="mr-th-cb"><b>Closing<br/>Balance</b></th>
            {overlay && <>
              <th colSpan={2} className="mr-grp-label mr-grp-overlay"><b>Transactions</b></th>
              <th rowSpan={2} className="mr-th-cb mr-grp-overlay"><b>Closing<br/>Balance</b></th>
            </>}
          </tr>
          {/* Row 5: Particulars / Debit | Credit (per group) */}
          <tr className="mr-th-cols">
            <th className="mr-th-particulars"><b>Particulars</b></th>
            <th className="mr-th-num"><b>Debit</b></th>
            <th className="mr-th-num"><b>Credit</b></th>
            {overlay && <>
              <th className="mr-th-num mr-grp-overlay"><b>Debit</b></th>
              <th className="mr-th-num mr-grp-overlay"><b>Credit</b></th>
            </>}
          </tr>
        </thead>
        <tbody>
          {/* Opening balance row — italic, like Tally */}
          {(primary.opening_balance > 0 || (overlay && overlay.opening_balance > 0)) && (
            <tr className="mr-row-opening">
              <td><i>Opening Balance</i></td>
              <td className="mr-num"></td>
              <td className="mr-num"></td>
              <td className="mr-num"><i>{fmtClosing(primary.opening_balance, primary.opening_side)}</i></td>
              {overlay && <>
                <td className="mr-num mr-grp-overlay"></td>
                <td className="mr-num mr-grp-overlay"></td>
                <td className="mr-num mr-grp-overlay"><i>{fmtClosing(overlay.opening_balance, overlay.opening_side)}</i></td>
              </>}
            </tr>
          )}
          {primary.rows.map((r, i) => {
            const ovr = overlay ? overlay.rows[i] : null;
            const isActive = i === activeRow;
            return (
              <tr
                key={r.month_iso}
                className={'mr-row' + (isActive ? ' mr-row-active' : '')}
                onMouseEnter={() => setActiveRow(i)}
                onClick={() => onRowClick(r.month_iso)}
              >
                <td>{r.month_name}</td>
                <td className="mr-num"><i>{fmtAmt(r.dr)}</i></td>
                <td className="mr-num"><i>{fmtAmt(r.cr)}</i></td>
                <td className="mr-num">{fmtClosing(r.closing, r.closing_side)}</td>
                {overlay && <>
                  <td className="mr-num mr-grp-overlay"><i>{fmtAmt(ovr?.dr)}</i></td>
                  <td className="mr-num mr-grp-overlay"><i>{fmtAmt(ovr?.cr)}</i></td>
                  <td className="mr-num mr-grp-overlay">{fmtClosing(ovr?.closing, ovr?.closing_side)}</td>
                </>}
              </tr>
            );
          })}
          {/* Footer total row — sum of Dr + Cr columns. Closing column
              shows the FINAL closing balance (last month's closing). */}
          <tr className="mr-row-total">
            <td><b>Total</b></td>
            <td className="mr-num"><b>{fmtAmt(primary.totals.dr)}</b></td>
            <td className="mr-num"><b>{fmtAmt(primary.totals.cr)}</b></td>
            <td className="mr-num"><b>{primary.rows.length > 0
              ? fmtClosing(primary.rows[primary.rows.length-1].closing, primary.rows[primary.rows.length-1].closing_side)
              : ''}</b></td>
            {overlay && <>
              <td className="mr-num mr-grp-overlay"><b>{fmtAmt(overlay.totals.dr)}</b></td>
              <td className="mr-num mr-grp-overlay"><b>{fmtAmt(overlay.totals.cr)}</b></td>
              <td className="mr-num mr-grp-overlay"><b>{overlay.rows.length > 0
                ? fmtClosing(overlay.rows[overlay.rows.length-1].closing, overlay.rows[overlay.rows.length-1].closing_side)
                : ''}</b></td>
            </>}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
