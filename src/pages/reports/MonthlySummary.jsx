// ── Monthly Summary (Sales / Purchase / Combined) — R10 ───────────────
//
// Shared component. Three thin wrappers preset `mode`:
//   MonthlySalesSummary    → side='sales'
//   MonthlyPurchaseSummary → side='purchase'
//   SalesPurchaseSummary   → side='combined'
//
// Layout (top → bottom):
//   1. Header — title + period selector + presets + recon chip
//   2. KPI tiles — period totals + best/worst month + (combined: margin)
//   3. Filter bar — party multi-select + min/max Net + show-zero toggle
//   4. Banner row — recon drift (if any), shown only when reconciliation
//                   is meaningful (no party filter applied; ledger isn't
//                   keyed by party so drift comparison is suppressed)
//   5. Toggle bar — Taxable ↔ With Tax (right-aligned, persisted)
//   6. Table — month rows + footer totals
//   7. (Combined only) Optional inline recharts bar chart below table
//
// Drill-down: click a row → existing Sales Report or Purchase Report
// with from_date / to_date set to that month's start + last day. URL
// param names match SalesReport.jsx exactly so the date picker
// hydrates. For Combined report rows, sales side wins (defer dual
// drill per brief).

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Tag, Button, Input, DatePicker, Select, Tooltip, Space, message, Switch } from 'antd';
import {
  DownloadOutlined, ReloadOutlined, PrinterOutlined, WhatsAppOutlined,
  WarningOutlined, CheckCircleOutlined, InfoCircleOutlined, FilterOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  CartesianGrid, Legend, Line, ComposedChart,
} from 'recharts';
import { reportAPI, partyAPI } from '../../api';

const fmtINR = (v) => {
  const n = Number(v) || 0;
  return '₹ ' + n.toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
};
const fmtINR0 = (v) => {
  // Compact for KPI tile values — no decimals when ≥ ₹1000.
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1000) return '₹ ' + Math.round(n).toLocaleString('en-IN');
  return fmtINR(n);
};

// Last day of a YYYY-MM-01 month — used for drill-down to detailed
// reports' to_date param. dayjs endOf('month') returns the right day
// (handles Feb / leap year correctly).
function lastDayOf(monthIso) {
  return dayjs(monthIso).endOf('month').format('YYYY-MM-DD');
}

// ─── Per-side configuration ───────────────────────────────────────────
const SIDE = {
  sales: {
    title:           'Monthly Sales Summary',
    partyLabel:      'Customer',
    partyTypeQuery:  'Customer',
    drillRoute:      '/reports/sales',
    csvBaseName:     'monthly_sales',
    chartLabel:      'Sales',
  },
  purchase: {
    title:           'Monthly Purchase Summary',
    partyLabel:      'Supplier',
    partyTypeQuery:  'Supplier',
    drillRoute:      '/reports/purchases',
    csvBaseName:     'monthly_purchases',
    chartLabel:      'Purchase',
  },
  combined: {
    title:           'Sales vs Purchase Summary',
    partyLabel:      'Party',
    drillRoute:      '/reports/sales',
    csvBaseName:     'sales_vs_purchase',
    chartLabel:      'Margin',
  },
};

// ─── Period presets ───────────────────────────────────────────────────
function presetRange(key) {
  const today = dayjs();
  // FY = Apr 1 → Mar 31. India convention.
  const fyStartYear = today.month() >= 3 ? today.year() : today.year() - 1;
  if (key === 'this_fy')   return { from: dayjs(`${fyStartYear}-04-01`),     to: today };
  if (key === 'last_fy')   return { from: dayjs(`${fyStartYear-1}-04-01`),   to: dayjs(`${fyStartYear}-03-31`) };
  if (key === 'last_12m')  return { from: today.subtract(11, 'month').startOf('month'), to: today };
  if (key === 'this_q') {
    const qStartMonth = Math.floor(today.month() / 3) * 3;
    return { from: today.month(qStartMonth).startOf('month'), to: today };
  }
  return null;
}

const TOGGLE_KEY_BASE = 'erp_monthly_summary_with_tax';

export default function MonthlySummary({ side }) {
  const cfg = SIDE[side];
  if (!cfg) throw new Error(`MonthlySummary: unknown side "${side}"`);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── State ─────────────────────────────────────────────────────────
  const initialFrom = (key, fallback) => searchParams.get(key) ?? fallback;
  const [fromDate, setFromDate] = useState(() => {
    const q = initialFrom('from_date', '');
    return q && dayjs(q).isValid() ? q : presetRange('this_fy').from.format('YYYY-MM-01');
  });
  const [toDate, setToDate] = useState(() => {
    const q = initialFrom('to_date', '');
    return q && dayjs(q).isValid() ? q : dayjs().format('YYYY-MM-DD');
  });
  const [presetKey, setPresetKey] = useState(() => initialFrom('preset', 'this_fy'));
  const [partyIds, setPartyIds] = useState(() => (initialFrom('party_ids', '') || '').split(',').filter(Boolean).map(Number));
  const [supplierIds, setSupplierIds] = useState(() => (initialFrom('supplier_ids', '') || '').split(',').filter(Boolean).map(Number));
  const [minNet, setMinNet]   = useState(() => initialFrom('min_net', ''));
  const [maxNet, setMaxNet]   = useState(() => initialFrom('max_net', ''));
  const [includeZero, setIncludeZero] = useState(() => initialFrom('include_zero', 'true') !== 'false');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Taxable ↔ With Tax — persisted per-side so different reports remember
  // independently.
  const TOGGLE_KEY = `${TOGGLE_KEY_BASE}_${side}`;
  const [withTax, setWithTax] = useState(() => {
    try { return localStorage.getItem(TOGGLE_KEY) === 'true'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(TOGGLE_KEY, String(withTax)); } catch {}
  }, [withTax, TOGGLE_KEY]);

  const [showChart, setShowChart] = useState(false);

  // ── Data fetch ────────────────────────────────────────────────────
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);

  const fetcher = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        mode: side,
        from_date: fromDate,
        to_date:   toDate,
        include_zero: includeZero ? 'true' : 'false',
      };
      if (side === 'sales' || side === 'purchase') {
        if (partyIds.length) params.party_ids = partyIds.join(',');
      } else {
        if (partyIds.length)    params.customer_ids = partyIds.join(',');
        if (supplierIds.length) params.supplier_ids = supplierIds.join(',');
      }
      if (minNet) params.min_net = minNet;
      if (maxNet) params.max_net = maxNet;
      const r = await reportAPI.monthlySummary(params);
      setData(r.data);
    } catch (e) {
      message.error('Failed to load monthly summary');
    }
    setLoading(false);
  }, [side, fromDate, toDate, includeZero, partyIds, supplierIds, minNet, maxNet]);

  useEffect(() => { fetcher(); }, [fetcher]);

  // URL sync — round-trip every filter so a copy-paste of the URL
  // reproduces the view (mirrors BillsOutstanding's URL-shareable
  // filter pattern).
  useEffect(() => {
    const next = {};
    if (fromDate)         next.from_date    = fromDate;
    if (toDate)           next.to_date      = toDate;
    if (presetKey)        next.preset       = presetKey;
    if (partyIds.length)  next.party_ids    = partyIds.join(',');
    if (supplierIds.length) next.supplier_ids = supplierIds.join(',');
    if (minNet)           next.min_net      = String(minNet);
    if (maxNet)           next.max_net      = String(maxNet);
    if (!includeZero)     next.include_zero = 'false';
    setSearchParams(next, { replace: true });
  }, [fromDate, toDate, presetKey, partyIds, supplierIds, minNet, maxNet, includeZero, setSearchParams]);

  // ── Party options — loaded once per side ──────────────────────────
  const [partyOptions, setPartyOptions]   = useState([]);
  const [supplierOptions, setSupplierOpts] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const loadParties = async (type, setter) => {
      try {
        const r = await partyAPI.getAll({ party_type: type, limit: 5000 });
        if (cancelled) return;
        const list = r?.data?.data || r?.data || [];
        setter(list.map((p) => ({ value: p.party_id, label: p.party_name })));
      } catch (_) {}
    };
    if (side === 'sales')    loadParties('Customer', setPartyOptions);
    if (side === 'purchase') loadParties('Supplier', setPartyOptions);
    if (side === 'combined') {
      loadParties('Customer', setPartyOptions);
      loadParties('Supplier', setSupplierOpts);
    }
    return () => { cancelled = true; };
  }, [side]);

  // ── Period preset click ──────────────────────────────────────────
  const applyPreset = useCallback((k) => {
    const r = presetRange(k);
    if (!r) return;
    setFromDate(r.from.format('YYYY-MM-DD'));
    setToDate(r.to.format('YYYY-MM-DD'));
    setPresetKey(k);
  }, []);

  // ── Drill-down ────────────────────────────────────────────────────
  const drillRow = useCallback((row) => {
    const monthIso = row.month_iso;
    const from = monthIso;
    const to   = lastDayOf(monthIso);
    navigate(`${cfg.drillRoute}?from_date=${from}&to_date=${to}`);
  }, [cfg, navigate]);

  // ── Render helpers ────────────────────────────────────────────────
  const recon = data?.reconciliation;
  const reconBanner = useMemo(() => {
    if (!recon) return null;
    if (side === 'combined') {
      const sales = recon.sales, purchase = recon.purchase;
      const banners = [];
      if (sales && sales.ledger_net != null && !sales.balanced && !sales.party_filtered) {
        banners.push({ side: 'sales', diff: sales.difference, ledger_name: sales.ledger_name });
      }
      if (purchase && purchase.ledger_net != null && !purchase.balanced && !purchase.party_filtered) {
        banners.push({ side: 'purchase', diff: purchase.difference, ledger_name: purchase.ledger_name });
      }
      return banners;
    }
    if (recon.party_filtered || recon.balanced || recon.ledger_net == null) return null;
    return [{ side, diff: recon.difference, ledger_name: recon.ledger_name }];
  }, [recon, side]);

  const reconClean = useMemo(() => {
    if (!recon) return false;
    if (side === 'combined') {
      const s = recon.sales, p = recon.purchase;
      return (s?.balanced || s?.party_filtered) && (p?.balanced || p?.party_filtered);
    }
    return recon.balanced || recon.party_filtered;
  }, [recon, side]);

  // ── Sub-components ────────────────────────────────────────────────
  const Header = () => (
    <div className="ms-hd">
      <div className="ms-title">
        <h1>{cfg.title}</h1>
        <Tag className="ms-as-of">
          {dayjs(fromDate).format('MMM YYYY')} – {dayjs(toDate).format('MMM YYYY')}
        </Tag>
        {reconClean && (
          <Tag color="success" className="ms-recon-chip">
            <CheckCircleOutlined /> Reconciled to {side === 'combined' ? 'Sales + Purchase' : (recon?.ledger_name || 'ledger')}
          </Tag>
        )}
      </div>
      <Space size={6} wrap>
        {[
          ['this_fy',  'This FY'],
          ['last_fy',  'Last FY'],
          ['last_12m', 'Last 12 Months'],
          ['this_q',   'This Quarter'],
        ].map(([k, label]) => (
          <Button
            key={k} size="small"
            type={presetKey === k ? 'primary' : 'default'}
            onClick={() => applyPreset(k)}
          >
            {label}
          </Button>
        ))}
        <DatePicker.RangePicker
          size="small"
          picker="month"
          value={[fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null]}
          onChange={(vals) => {
            if (!vals) return;
            setFromDate(vals[0].format('YYYY-MM-01'));
            setToDate(vals[1].endOf('month').format('YYYY-MM-DD'));
            setPresetKey('custom');
          }}
          format="MMM YYYY"
          allowClear={false}
          style={{ width: 220 }}
        />
        <Button size="small" icon={<ReloadOutlined />} onClick={fetcher} loading={loading}>Refresh</Button>
        <Button size="small" icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
        <Button size="small" icon={<DownloadOutlined />} onClick={handleExportCsv} type="primary">Excel</Button>
      </Space>
    </div>
  );

  // KPI tiles vary by mode.
  const KpiRow = () => {
    if (!data) return <div className="ms-kpis ms-skel" />;
    if (side === 'combined') {
      const s = data.summary || {};
      const k = data.kpis    || {};
      return (
        <div className="ms-kpis">
          <Tile label="Total Sales Net"     value={fmtINR0(s.total_sales_net)} strong />
          <Tile label="Total Purchase Net"  value={fmtINR0(s.total_purchase_net)} />
          <Tile label="Total Margin"        value={fmtINR0(s.total_margin)}
                 valueColor={s.total_margin > 0 ? 'var(--success, #10B981)' : (s.total_margin < 0 ? 'var(--danger, #EF4444)' : undefined)} />
          <Tile label="Avg Monthly Margin"  value={fmtINR0(k.avg_monthly_margin)} />
          <Tile label="Best Margin Month"   value={k.best_margin_month
                  ? `${k.best_margin_month.month_label} · ${fmtINR0(k.best_margin_month.margin)}` : '—'} small />
          <Tile label="Months Cash-Negative" value={String(k.months_cash_negative || 0)}
                 valueColor={(k.months_cash_negative || 0) > 0 ? 'var(--warning, #B5872B)' : undefined} />
        </div>
      );
    }
    const s = data.summary || {};
    const k = data.kpis    || {};
    return (
      <div className="ms-kpis">
        <Tile label={`Total Net ${side === 'sales' ? 'Sales' : 'Purchase'}`} value={fmtINR0(s.total_net)} strong />
        <Tile label="Months in View"   value={String(k.months_in_view || 0)} />
        <Tile label="Avg Monthly Net"  value={fmtINR0(s.avg_monthly_net)} />
        <Tile label="Best Month"       value={k.best_month
                ? `${k.best_month.month_label} · ${fmtINR0(k.best_month.net)}` : '—'} small />
        {(k.months_in_view || 0) > 1 && (
          <Tile label="Worst Month"    value={k.worst_month
                ? `${k.worst_month.month_label} · ${fmtINR0(k.worst_month.net)}` : '—'} small />
        )}
        {k.returns_pct != null && k.returns_pct > 0 && (
          <Tile label="Returns %" value={(k.returns_pct).toFixed(1) + '%'} />
        )}
      </div>
    );
  };

  // Table — single-side or combined.
  const Table = () => {
    if (!data) return <div className="ms-table-skeleton">Loading…</div>;
    const rows = data.data || [];
    if (rows.length === 0) {
      const filtered = !!(partyIds.length || supplierIds.length || minNet || maxNet);
      return (
        <div className="ms-empty">
          {filtered
            ? <>No matches — <a onClick={resetFilters}>clear filters</a></>
            : <>No bills in this period — try expanding the date range.</>}
        </div>
      );
    }

    if (side === 'combined') return <CombinedTable rows={rows} summary={data.summary} onRowClick={drillRow} />;
    return <SideTable rows={rows} summary={data.summary} side={side} withTax={withTax} onRowClick={drillRow} />;
  };

  // ── Filter helpers ────────────────────────────────────────────────
  const resetFilters = useCallback(() => {
    setPartyIds([]); setSupplierIds([]); setMinNet(''); setMaxNet('');
    setIncludeZero(true);
  }, []);

  // ── Excel export ─────────────────────────────────────────────────
  const handleExportCsv = useCallback(() => {
    if (!data) return;
    const rows = data.data || [];
    let header, lines;
    if (side === 'combined') {
      header = ['Month', 'Sales Bills', 'Sales Net', 'Sales Total Invoiced',
                'Purchase Bills', 'Purchase Net', 'Purchase Total Invoiced',
                'Margin', 'Margin %'];
      lines = rows.map((r) => [
        r.month_label, r.sales_bills_count, r.sales_net.toFixed(2), r.sales_total_invoiced.toFixed(2),
        r.purchase_bills_count, r.purchase_net.toFixed(2), r.purchase_total_invoiced.toFixed(2),
        r.margin.toFixed(2), r.margin_pct == null ? '—' : r.margin_pct.toFixed(1) + '%',
      ]);
    } else {
      header = ['Month', '# Bills', '# Returns', 'Gross', 'Returns', 'Net', 'Tax',
                'Total Invoiced', 'Avg Bill Value'];
      lines = rows.map((r) => [
        r.month_label, r.bills_count, r.returns_count,
        r.gross.toFixed(2), r.returns.toFixed(2), r.net.toFixed(2), r.tax.toFixed(2),
        r.total_invoiced.toFixed(2),
        r.avg_bill_value == null ? '—' : r.avg_bill_value.toFixed(2),
      ]);
    }
    const csv = [header, ...lines]
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${cfg.csvBaseName}_${fromDate}_${toDate}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  }, [data, side, cfg.csvBaseName, fromDate, toDate]);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="ms-page">
      <Header />

      {/* Recon banner row */}
      {(reconBanner || []).map((b, i) => (
        <div key={i} className="ms-banner ms-banner-warn">
          <WarningOutlined />
          <span>
            <b>{b.side === 'sales' ? 'Sales' : 'Purchase'}</b> totals differ from {b.ledger_name} by <b>{fmtINR(Math.abs(b.diff))}</b>.
            {' '}<a onClick={() => navigate(b.side === 'sales' ? `/reports/sales?from_date=${fromDate}&to_date=${toDate}` : `/reports/purchases?from_date=${fromDate}&to_date=${toDate}`)}>View reconciliation →</a>
          </span>
        </div>
      ))}

      <KpiRow />

      <div className="ms-filterbar">
        <Space size={8} wrap>
          {side !== 'combined' && (
            <Select
              size="small" mode="multiple"
              placeholder={`Filter by ${cfg.partyLabel}`}
              value={partyIds} onChange={setPartyIds}
              options={partyOptions} optionFilterProp="label"
              allowClear maxTagCount="responsive"
              style={{ minWidth: 220, maxWidth: 360 }}
            />
          )}
          {side === 'combined' && (
            <>
              <Select
                size="small" mode="multiple"
                placeholder="Filter by Customer"
                value={partyIds} onChange={setPartyIds}
                options={partyOptions} optionFilterProp="label"
                allowClear maxTagCount="responsive"
                style={{ minWidth: 200, maxWidth: 280 }}
              />
              <Select
                size="small" mode="multiple"
                placeholder="Filter by Supplier"
                value={supplierIds} onChange={setSupplierIds}
                options={supplierOptions} optionFilterProp="label"
                allowClear maxTagCount="responsive"
                style={{ minWidth: 200, maxWidth: 280 }}
              />
            </>
          )}
          <Input
            size="small" allowClear placeholder="Min Net ₹"
            value={minNet}
            onChange={(e) => setMinNet(e.target.value.replace(/[^0-9.]/g, ''))}
            style={{ width: 110 }}
          />
          <Input
            size="small" allowClear placeholder="Max Net ₹"
            value={maxNet}
            onChange={(e) => setMaxNet(e.target.value.replace(/[^0-9.]/g, ''))}
            style={{ width: 110 }}
          />
          <Tooltip title={withTax
            ? 'Showing amounts with GST included. Switch off to see taxable only.'
            : 'Showing taxable amounts only. Switch on to include GST.'}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
              Taxable <Switch size="small" checked={withTax} onChange={setWithTax} /> With Tax
            </span>
          </Tooltip>
          <Button
            size="small" type={advancedOpen ? 'primary' : 'default'}
            icon={<FilterOutlined />}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            Advanced
          </Button>
        </Space>
        {advancedOpen && (
          <div className="ms-filterbar-adv">
            <Space size={8}>
              <label style={{ fontSize: 12 }}>
                <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
                {' '}Show empty months
              </label>
              <Button size="small" onClick={resetFilters}>Reset filters</Button>
            </Space>
          </div>
        )}
      </div>

      <Table />

      {side === 'combined' && data?.data?.length > 0 && (
        <div className="ms-chart-toggle">
          <Button size="small" type={showChart ? 'primary' : 'default'} onClick={() => setShowChart((v) => !v)}>
            {showChart ? 'Hide chart' : 'Show chart'}
          </Button>
          {showChart && <CombinedChart rows={data.data} />}
        </div>
      )}
    </div>
  );
}

// ─── Tiny KPI tile component ──────────────────────────────────────────
function Tile({ label, value, strong, small, valueColor }) {
  return (
    <div className="ms-kpi">
      <div className="ms-kpi-label">{label}</div>
      <div
        className={`ms-kpi-value ${strong ? 'ms-kpi-strong' : ''} ${small ? 'ms-kpi-small' : ''}`}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Single-side table (Sales OR Purchase) ────────────────────────────
function SideTable({ rows, summary, side, withTax, onRowClick }) {
  // With Tax flips Net/Gross/Returns/Total Invoiced display: show
  // total_invoiced as the "Net" column and hide the Tax column.
  return (
    <div className="ms-table-wrap">
      <table className="ms-table">
        <thead>
          <tr>
            <th>Month</th>
            <th className="ms-num">Bills</th>
            <th className="ms-num">Returns</th>
            <th className="ms-num">Gross</th>
            <th className="ms-num">Returns ₹</th>
            <th className="ms-num ms-th-strong">{withTax ? 'Total Invoiced' : 'Net'}</th>
            {!withTax && <th className="ms-num">Tax</th>}
            {!withTax && <th className="ms-num">Total Invoiced</th>}
            <th className="ms-num">Avg Bill</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month_iso} onClick={() => onRowClick(r)} className="ms-row-clickable">
              <td>{r.month_label}</td>
              <td className="ms-num">{r.bills_count || '—'}</td>
              <td className="ms-num ms-muted">{r.returns_count || '—'}</td>
              <td className="ms-num">{fmtINR(r.gross)}</td>
              <td className="ms-num ms-muted">{fmtINR(r.returns)}</td>
              <td className="ms-num ms-strong">{fmtINR(withTax ? r.total_invoiced : r.net)}</td>
              {!withTax && <td className="ms-num ms-muted">{fmtINR(r.tax)}</td>}
              {!withTax && <td className="ms-num">{fmtINR(r.total_invoiced)}</td>}
              <td className="ms-num">{r.avg_bill_value == null ? '—' : fmtINR(r.avg_bill_value)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="ms-tot">
            <td>Total</td>
            <td className="ms-num">{summary.total_bills}</td>
            <td className="ms-num ms-muted">{summary.total_returns_count}</td>
            <td className="ms-num">{fmtINR(summary.total_gross)}</td>
            <td className="ms-num ms-muted">{fmtINR(summary.total_returns)}</td>
            <td className="ms-num ms-strong">{fmtINR(withTax ? summary.total_invoiced : summary.total_net)}</td>
            {!withTax && <td className="ms-num ms-muted">{fmtINR(summary.total_tax)}</td>}
            {!withTax && <td className="ms-num">{fmtINR(summary.total_invoiced)}</td>}
            <td className="ms-num">{summary.avg_bill_value == null ? '—' : fmtINR(summary.avg_bill_value)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Combined Sales-vs-Purchase table ─────────────────────────────────
function CombinedTable({ rows, summary, onRowClick }) {
  return (
    <div className="ms-table-wrap">
      <table className="ms-table">
        <thead>
          <tr>
            <th>Month</th>
            <th className="ms-num">Sales · Bills</th>
            <th className="ms-num">Sales · Net</th>
            <th className="ms-num">Purchase · Bills</th>
            <th className="ms-num">Purchase · Net</th>
            <th className="ms-num ms-th-strong">
              Margin{' '}
              <Tooltip title="Cash-flow direction at invoice level. Not gross profit — see P&L for that.">
                <InfoCircleOutlined style={{ fontSize: 11 }} />
              </Tooltip>
            </th>
            <th className="ms-num">Margin %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month_iso} onClick={() => onRowClick(r)} className="ms-row-clickable">
              <td>{r.month_label}</td>
              <td className="ms-num">{r.sales_bills_count || '—'}</td>
              <td className="ms-num">{fmtINR(r.sales_net)}</td>
              <td className="ms-num">{r.purchase_bills_count || '—'}</td>
              <td className="ms-num">{fmtINR(r.purchase_net)}</td>
              <td className="ms-num ms-strong" style={{ color: marginColor(r.margin) }}>
                {fmtINR(r.margin)}
              </td>
              <td className="ms-num">{r.margin_pct == null ? '—' : (r.margin_pct.toFixed(1) + '%')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="ms-tot">
            <td>Total</td>
            <td className="ms-num">{summary.total_sales_bills}</td>
            <td className="ms-num">{fmtINR(summary.total_sales_net)}</td>
            <td className="ms-num">{summary.total_purchase_bills}</td>
            <td className="ms-num">{fmtINR(summary.total_purchase_net)}</td>
            <td className="ms-num ms-strong" style={{ color: marginColor(summary.total_margin) }}>
              {fmtINR(summary.total_margin)}
            </td>
            <td className="ms-num">
              {summary.total_sales_net > 0
                ? ((summary.total_margin / summary.total_sales_net) * 100).toFixed(1) + '%'
                : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function marginColor(margin) {
  if (margin > 1)  return 'var(--success, #10B981)';
  if (margin < -1) return 'var(--danger,  #EF4444)';
  return 'var(--text-tertiary, #9CA3AF)';
}

// ─── Combined chart (recharts) ────────────────────────────────────────
function CombinedChart({ rows }) {
  // Sales bar (green), Purchase bar (red), Margin line overlay.
  const data = rows.map((r) => ({
    month:    r.month_label,
    Sales:    r.sales_net,
    Purchase: r.purchase_net,
    Margin:   r.margin,
  }));
  return (
    <div className="ms-chart">
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }}
                 tickFormatter={(v) => Math.round(v / 1000) + 'k'} />
          <RTooltip formatter={(v) => fmtINR(v)} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar  dataKey="Sales"    fill="#10B981" />
          <Bar  dataKey="Purchase" fill="#EF4444" />
          <Line dataKey="Margin"   type="monotone" stroke="#6366F1" strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
