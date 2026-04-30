import React, { useEffect, useMemo, useState } from 'react';
import { DatePicker, Button, Tag, message, Checkbox, Popover, Input } from 'antd';
import { DownloadOutlined, SettingOutlined, PrinterOutlined, SearchOutlined, CloseOutlined, WarningOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';

// Non-breaking space between ₹ and the number so narrow cells can never
// split the glyph onto its own line. Affects every place fmt() is used
// — data cells, summary cells, and KPI tiles.
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// Every column in the table is toggleable from the Customize popover.
// `default: true` columns ship visible; the rest are off by default
// (mostly GST-filing / dispatch-routing columns the operator opts
// into when they need them). Persisted to localStorage so a user's
// column choice survives page reloads.
const ALL_COLS = [
  { key: 'sr_no',         label: 'Sr No',            default: true  },
  { key: 'bill_no',       label: 'Bill No',          default: true  },
  { key: 'date',          label: 'Date',             default: true  },
  { key: 'customer',      label: 'Customer',         default: true  },
  { key: 'gstin',         label: 'GSTIN',            default: false },
  { key: 'state',         label: 'State',            default: false },
  { key: 'city',          label: 'City',             default: false },
  { key: 'salesman',      label: 'Salesperson',      default: false },
  { key: 'items',         label: 'Items count',      default: true  },
  { key: 'sub_total',     label: 'Sub Total',        default: true  },
  { key: 'discount',      label: 'Discount',         default: true  },
  { key: 'cgst',          label: 'CGST',             default: false },
  { key: 'sgst',          label: 'SGST',             default: false },
  { key: 'igst',          label: 'IGST',             default: false },
  { key: 'cess',          label: 'Cess',             default: false },
  { key: 'gst',           label: 'GST (combined)',   default: true  },
  { key: 'cogs',          label: 'COGS',             default: false },
  { key: 'profit',        label: 'Profit (₹)',       default: true  },
  { key: 'margin',        label: 'Margin %',         default: false },
  { key: 'total',         label: 'Total',            default: true  },
  { key: 'paid',          label: 'Paid',             default: true  },
  { key: 'balance',       label: 'Balance',          default: true  },
  { key: 'payment_mode',  label: 'Payment mode',     default: false },
  { key: 'due_date',      label: 'Due date',         default: false },
  { key: 'overdue_days',  label: 'Days overdue',     default: false },
  { key: 'status',        label: 'Status',           default: true  },
];
const COLS_STORAGE_KEY = 'salesReport_cols_v2';
const DEFAULT_COLS = ALL_COLS.reduce((o, c) => ({ ...o, [c.key]: c.default }), {});

// KPI cards user can pick from the Customize popover. Each entry has a semantic
// `tone` (success / warning / danger / info / accent / neutral) that maps to
// theme CSS vars — so the same KPI re-skins automatically when the user
// switches between Classic (indigo/green/red) and Modern (cream/terracotta).
const ALL_KPIS = [
  { key: 'sales',       label: 'Total Sales',    tone: 'success', default: true,
    value: (s) => `₹ ${parseFloat(s.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'profit',      label: 'Total Profit',   tone: (s) => (s.total_profit || 0) >= 0 ? 'profit-pos' : 'profit-neg', default: true,
    value: (s) => `₹ ${parseFloat(s.total_profit || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'margin',      label: 'Margin',         tone: 'warning', default: true,
    value: (s) => `${(s.margin_pct || 0).toFixed(1)}%` },
  { key: 'gst',         label: 'Total GST',      tone: 'accent',  default: true,
    value: (s) => `₹ ${parseFloat(s.total_gst || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'discount',    label: 'Total Discount', tone: 'warning', default: true,
    value: (s) => `₹ ${parseFloat(s.total_discount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'outstanding', label: 'Outstanding',    tone: 'danger',  default: true,
    value: (s) => `₹ ${parseFloat(s.total_balance || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'paid',        label: 'Total Paid',     tone: 'success', default: false,
    value: (s) => `₹ ${parseFloat(s.total_paid || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'cogs',        label: 'Total COGS',     tone: 'neutral', default: false,
    value: (s) => `₹ ${parseFloat(s.total_cogs || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'sub_total',   label: 'Taxable Value',  tone: 'info',    default: false,
    value: (s) => `₹ ${parseFloat(s.total_sub || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'bill_count',  label: 'Bill Count',     tone: 'neutral', default: false,
    value: (_s, count) => String(count || 0) },
];
const KPIS_STORAGE_KEY = 'salesReport_kpis_v1';
const DEFAULT_KPIS = ALL_KPIS.reduce((o, k) => ({ ...o, [k.key]: k.default }), {});

// Period presets — dayjs values resolved against the company FY.
function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy'    && fyStart && fyEnd) return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'last_fy'    && fyStart && fyEnd) return [dayjs(fyStart).subtract(1, 'year'), dayjs(fyEnd).subtract(1, 'year')];
  if (key === 'this_q')     return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'), today.endOf('month')];
  return null;
}

export default function SalesReport() {
  const { fyStart, fyEnd } = useFinancialYear();
  // URL search params — when this page is reached via a drill-down
  // (e.g., Profit & Loss → Sales Account), `?from=YYYY-MM-DD&to=…` is
  // present and we honour it so the report opens on the same window
  // the user was viewing in the source report. Bare-URL navigation
  // falls through to the FY default.
  const [searchParams] = useSearchParams();
  const initialFrom = (() => {
    const q = searchParams.get('from');
    return q && dayjs(q).isValid() ? q : null;
  })();
  const initialTo = (() => {
    const q = searchParams.get('to');
    return q && dayjs(q).isValid() ? q : null;
  })();

  // Defaults to the company FY — every period selector across the
  // app uses the same window. Falls back to current month on first
  // install before settings are loaded.
  const [filters, setFilters] = useState({
    from_date: initialFrom || fyStart || dayjs().startOf('month').format('YYYY-MM-DD'),
    to_date:   initialTo   || fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD'),
    customer_id: null,
    payment_status: null,
    search: '',
  });
  // Local search input — debounced into filters.search so we don't fire
  // a server request on every keystroke. Server-side search is
  // mandatory under virtualization (the client can't filter rows it
  // hasn't loaded).
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 220);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [reconDismissed, setReconDismissed] = useState(false);
  // If the page was opened with explicit ?from / ?to from a drill-down,
  // start on 'custom' so the dropdown label reads honestly.
  const [preset, setPreset] = useState(initialFrom && initialTo ? 'custom' : 'this_fy');
  const [colsVisible, setColsVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  const [kpisVisible, setKpisVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KPIS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_KPIS, ...saved } : DEFAULT_KPIS;
    } catch { return DEFAULT_KPIS; }
  });

  // ── Virtualized data layer ────────────────────────────────────────
  // The hook owns chunked fetching, in-flight dedupe, sparse rows,
  // and meta passthrough (for the reconciliation banner). Filters are
  // a stable object — when any value changes, the cache resets and
  // chunk 0 re-fetches automatically.
  const { rows, totalCount, summary, meta, ensureChunk, loading } = useVirtualizedReport({
    fetcher: (params) => reportAPI.getSalesReport(params),
    filters,
    chunkSize: 200,
  });
  const reconciliation = meta?.reconciliation || null;

  // Sync filters dates when preset changes (and FY arrives async).
  useEffect(() => {
    if (preset === 'custom') return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) {
      const from = r[0].format('YYYY-MM-DD');
      const to   = r[1].format('YYYY-MM-DD');
      if (from !== filters.from_date || to !== filters.to_date) {
        setFilters((f) => ({ ...f, from_date: from, to_date: to }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, fyStart, fyEnd]);

  // Persist column-picker state.
  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(colsVisible)); } catch {}
  }, [colsVisible]);

  useEffect(() => {
    try { localStorage.setItem(KPIS_STORAGE_KEY, JSON.stringify(kpisVisible)); } catch {}
  }, [kpisVisible]);

  const handleExport = async () => {
    try {
      // Pass the SAME filters the table is using — server streams the full filtered
      // dataset (no pagination). Previously the Export button invoked the generic
      // "all sales ever" dump which ignored date/customer/status filters entirely.
      const res = await reportAPI.exportSalesReport(filters);
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      const from = filters.from_date || 'all';
      const to   = filters.to_date   || 'now';
      a.download = `sales_report_${from}_to_${to}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      message.error('Export failed');
    }
  };

  // Per-bill computed values used by the new operational columns.
  const rowGST    = (r) => parseFloat(r.cgst_amount || 0) + parseFloat(r.sgst_amount || 0)
                          + parseFloat(r.igst_amount || 0) + parseFloat(r.cess_amount || 0);
  // Profit = sub_total − COGS. Sub-total (taxable) rather than total
  // because GST is collected for the government and isn't margin.
  const rowProfit = (r) => parseFloat(r.sub_total || 0) - parseFloat(r.cogs || 0);
  const rowMargin = (r) => {
    const sub = parseFloat(r.sub_total || 0);
    return sub > 0 ? (rowProfit(r) / sub) * 100 : 0;
  };
  // Days overdue = today − (bill_date + customer.credit_days). Only
  // shown for bills with a balance > 0; clean (paid) bills render —.
  const rowOverdueDays = (r) => {
    if (parseFloat(r.balance_amount || 0) <= 0) return null;
    const billDate = dayjs(r.bill_date);
    const dueDate = r.due_date
      ? dayjs(r.due_date)
      : billDate.add(parseInt(r.customer?.credit_days, 10) || 0, 'day');
    const diff = dayjs().diff(dueDate, 'day');
    return diff > 0 ? diff : 0;
  };

  // Single source-of-truth column registry. Each entry is the full
  // antd Column spec; the render builds them in order based on
  // colsVisible. Adding/removing/renaming a column happens in one
  // place — no fragile push/spread chain.
  const COL_SPECS = useMemo(() => ({
    // Sr No is purely positional — driven by row index, no backing field.
    // The summary row replaces this cell with the "Total (count)" label
    // (see the summary renderer below) so the column header stays clean.
    sr_no:        { title: 'Sr',          width: 56, align: 'center',
                    render: (_v, _row, idx) => <span style={{ color: 'var(--fg-tertiary)', fontFamily: 'Geist Mono, monospace' }}>{idx + 1}</span> },
    bill_no:      { title: 'Bill No',     dataIndex: 'bill_number', width: 130,
                    render: (v) => <span className="rpt-bill-no">{v}</span> },
    date:         { title: 'Date',        dataIndex: 'bill_date',   width: 110, render: (v) => dayjs(v).format('DD/MM/YYYY') },
    customer:     { title: 'Customer',    dataIndex: ['customer', 'party_name'], width: 180,
                    render: (v, row) => {
                      const isCash = row?.customer?.is_system_cash || !v;
                      const w = String(row?.walk_in_name || '').trim();
                      return isCash ? (w ? `Cash — ${w}` : 'Cash') : v;
                    } },
    gstin:        { title: 'GSTIN',       dataIndex: ['customer', 'gstin'], width: 150,
                    render: (v) => v ? <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</Tag> : '—' },
    state:        { title: 'State',       dataIndex: ['customer', 'state'], width: 130, render: (v) => v || '—' },
    city:         { title: 'City',        dataIndex: ['customer', 'city'],  width: 130, render: (v) => v || '—' },
    salesman:     { title: 'Salesperson', dataIndex: 'salesman_name', width: 140, render: (v) => v || '—' },
    items:        { title: 'Items',       dataIndex: 'total_items', width: 70, align: 'center' },
    sub_total:    { title: 'Sub Total',   dataIndex: 'sub_total', width: 120, align: 'right', render: fmt },
    discount:     { title: 'Discount',    dataIndex: 'discount_amount', width: 100, align: 'right', render: fmt },
    cgst:         { title: 'CGST',        dataIndex: 'cgst_amount', width: 90, align: 'right', render: fmt },
    sgst:         { title: 'SGST',        dataIndex: 'sgst_amount', width: 90, align: 'right', render: fmt },
    igst:         { title: 'IGST',        dataIndex: 'igst_amount', width: 90, align: 'right', render: fmt },
    cess:         { title: 'Cess',        dataIndex: 'cess_amount', width: 90, align: 'right', render: fmt },
    gst:          { title: 'GST',         width: 100, align: 'right', render: (_, r) => fmt(rowGST(r)) },
    cogs:         { title: 'COGS',        dataIndex: 'cogs', width: 110, align: 'right',
                    render: (v) => fmt(v) },
    profit:       { title: 'Profit',      width: 110, align: 'right',
                    render: (_, r) => {
                      const p = rowProfit(r);
                      return <span style={{ color: p > 0 ? '#16a34a' : p < 0 ? '#dc2626' : undefined, fontWeight: 600 }}>{fmt(p)}</span>;
                    } },
    margin:       { title: 'Margin %',    width: 90, align: 'right',
                    render: (_, r) => {
                      const m = rowMargin(r);
                      return <span style={{ color: m > 0 ? '#16a34a' : m < 0 ? '#dc2626' : undefined }}>{m.toFixed(1)}%</span>;
                    } },
    total:        { title: 'Total',       dataIndex: 'total_amount', width: 120, align: 'right',
                    render: (v) => <strong>{fmt(v)}</strong> },
    paid:         { title: 'Paid',        dataIndex: 'paid_amount', width: 110, align: 'right', render: fmt },
    balance:      { title: 'Balance',     dataIndex: 'balance_amount', width: 110, align: 'right',
                    render: (v) => <span style={{ color: v > 0 ? '#ff4d4f' : '#52c41a' }}>{fmt(v)}</span> },
    payment_mode: { title: 'Mode',        dataIndex: 'payment_method', width: 100,
                    render: (v) => v ? <Tag>{v}</Tag> : '—' },
    due_date:     { title: 'Due',         dataIndex: 'due_date', width: 110,
                    render: (v) => v ? dayjs(v).format('DD/MM/YYYY') : '—' },
    overdue_days: { title: 'Overdue',     width: 90, align: 'right',
                    render: (_, r) => {
                      const d = rowOverdueDays(r);
                      if (d === null) return '—';
                      return <span style={{ color: d > 30 ? '#dc2626' : d > 0 ? '#d97706' : undefined, fontFamily: 'Geist Mono, monospace' }}>{d > 0 ? `${d} d` : '—'}</span>;
                    } },
    status:       { title: 'Status',      dataIndex: 'payment_status', width: 90,
                    render: (s) => <span className={`rpt-pill ${s === 'Paid' ? 'paid' : s === 'Partial' ? 'partial' : 'unpaid'}`}>{s}</span> },
  }), []);

  const columns = useMemo(() => {
    return ALL_COLS.filter((c) => colsVisible[c.key]).map((c) => ({ key: c.key, ...COL_SPECS[c.key] }));
  }, [colsVisible, COL_SPECS]);

  // Per-column summary content for VirtualReportTable. Driven by
  // server-aggregated `summary` over the full filtered set, so totals
  // stay correct regardless of how many chunks have streamed in.
  // Aggregable column keys are tracked here so the wrapper can also
  // determine where the leading "Total (N)" label should end (it spans
  // every leading non-aggregable column so the label has space and the
  // first numeric total sits directly under its column header).
  const SUMMABLE_KEYS = useMemo(() => new Set([
    'sub_total', 'discount', 'cgst', 'sgst', 'igst', 'cess', 'gst',
    'cogs', 'profit', 'margin', 'total', 'paid', 'balance',
  ]), []);

  // Index of the first visible column that has an aggregate. The
  // "Total (N)" label colSpans up to (but not including) this index,
  // so columns like Sr / Bill No / Date / Customer / Items merge into
  // one wide cell holding the label.
  const firstAggIdx = useMemo(() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  }, [columns, SUMMABLE_KEYS]);

  const totalForKey = (k) => {
    switch (k) {
      case 'sub_total': return fmt(summary.total_sub);
      case 'discount':  return fmt(summary.total_discount);
      case 'cgst':      return fmt(summary.total_cgst);
      case 'sgst':      return fmt(summary.total_sgst);
      case 'igst':      return fmt(summary.total_igst);
      case 'cess':      return fmt(summary.total_cess);
      case 'gst':       return fmt(summary.total_gst);
      case 'cogs':      return fmt(summary.total_cogs);
      case 'profit':    return <span style={{ color: (summary.total_profit || 0) >= 0 ? '#16a34a' : '#dc2626' }}>{fmt(summary.total_profit)}</span>;
      case 'margin':    return `${(summary.margin_pct || 0).toFixed(1)}%`;
      case 'total':     return fmt(summary.total_amount);
      case 'paid':      return fmt(summary.total_paid);
      case 'balance':   return fmt(summary.total_balance);
      default:          return null;
    }
  };

  const summaryCells = (col, idx) => {
    if (idx === 0) return totalCount > 0 ? `Total (${totalCount})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;          // merged into idx 0
    return totalForKey(col.key);
  };

  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);         // span leading non-aggregables
    if (idx > 0 && idx < firstAggIdx) return 0;             // hidden — merged
    return 1;
  };

  // Customize popover — two sections: KPI cards (top) + table columns (bottom).
  // Two-column grid so the toggles don't push the popover off-screen.
  const customizePopoverContent = (
    <div style={{ width: 360, maxHeight: '70vh', overflowY: 'auto' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-secondary, #6b7280)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>KPI Cards</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 14 }}>
        {ALL_KPIS.map((k) => (
          <div key={k.key}>
            <Checkbox checked={!!kpisVisible[k.key]} onChange={(e) => setKpisVisible((v) => ({ ...v, [k.key]: e.target.checked }))}>
              {k.label}
            </Checkbox>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-secondary, #6b7280)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Columns</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
        {ALL_COLS.map((c) => (
          <div key={c.key}>
            <Checkbox checked={!!colsVisible[c.key]} onChange={(e) => setColsVisible((v) => ({ ...v, [c.key]: e.target.checked }))}>
              {c.label}
            </Checkbox>
          </div>
        ))}
      </div>
    </div>
  );

  const fyLabel = fyStart ? `FY ${dayjs(fyStart).format('YYYY')}-${dayjs(fyEnd).format('YY')}` : '';
  const handlePrint = () => window.print();

  return (
    <div className="report-editorial" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── HEADER — title + period preset segments + date pill + Excel/Print ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Sales Report</h1>
          <div className="rpt-sub">
            <b>{totalCount}</b> bill{totalCount === 1 ? '' : 's'}
            {fyLabel && <><span className="sep">·</span>{fyLabel}</>}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <div className="rpt-period">
            {[
              { v: 'this_fy', l: 'This FY' },
              { v: 'last_fy', l: 'Last FY' },
              { v: 'this_q', l: 'This Q' },
              { v: 'this_month', l: 'This Month' },
              { v: 'custom', l: 'Custom' },
            ].map((p) => (
              <button key={p.v} className={preset === p.v ? 'on' : ''} onClick={() => setPreset(p.v)}>{p.l}</button>
            ))}
          </div>
          <DatePicker.RangePicker
            format="DD/MM/YYYY" className="rpt-date"
            allowClear={false}
            value={[dayjs(filters.from_date), dayjs(filters.to_date)]}
            onChange={(v) => {
              setPreset('custom');
              const from = v?.[0]?.format('YYYY-MM-DD') || fyStart || dayjs().startOf('month').format('YYYY-MM-DD');
              const to   = v?.[1]?.format('YYYY-MM-DD') || fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD');
              setFilters((f) => ({ ...f, from_date: from, to_date: to }));
            }}
          />
          <Popover content={customizePopoverContent} title="Customize" trigger="click" placement="bottomRight">
            <Button icon={<SettingOutlined />} className="rpt-btn">Customize</Button>
          </Popover>
          <Button icon={<DownloadOutlined />} onClick={handleExport} className="rpt-btn">Excel</Button>
          <Button icon={<PrinterOutlined />} onClick={handlePrint} className="rpt-btn">Print</Button>
        </div>
      </div>

      {/* ─── KPI STRIP ─── */}
      {ALL_KPIS.some((k) => kpisVisible[k.key]) && (
        <div className="rpt-kpis">
          {ALL_KPIS.filter((k) => kpisVisible[k.key]).map((k) => {
            const tone = typeof k.tone === 'function' ? k.tone(summary) : k.tone;
            return (
              <div key={k.key} className={`rpt-kpi tone-${tone}`}>
                <div className="rpt-kpi-k">{k.label}</div>
                <div className="rpt-kpi-v">{k.value(summary, totalCount)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── RECONCILIATION BANNER ─── */}
      {reconciliation && !reconciliation.balanced && !reconDismissed && (
        <div className="rpt-recon warn">
          <div className="rpt-recon-ic"><WarningOutlined /></div>
          <div className="rpt-recon-body">
            <div className="rpt-recon-title">Sales ledger does not reconcile to bill aggregate</div>
            <div className="rpt-recon-formula">
              {reconciliation.ledger_name} net Cr <b>{fmt(reconciliation.ledger_net_credit)}</b> vs bills:
              {' '}sub <b>{fmt(reconciliation.register_taxable)}</b>
              {' '}− discount <b>{fmt(reconciliation.register_discount)}</b>
              {' '}+ freight <b>{fmt(reconciliation.register_freight)}</b>
              {' '}+ other <b>{fmt(reconciliation.register_other)}</b>
              {' '}= <b>{fmt(reconciliation.register_net_to_ledger)}</b>
              <span className="delta"> → {fmt(reconciliation.difference)} drift</span>
            </div>
          </div>
          <button className="rpt-recon-x" onClick={() => setReconDismissed(true)} aria-label="Dismiss"><CloseOutlined /></button>
        </div>
      )}

      {/* ─── FILTER BAR — search + status chips ─── */}
      <div className="rpt-filter">
        <Input
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder="Search bill no, customer, or amount…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          allowClear
        />
        <span className="rpt-sep" />
        {[
          { v: 'Unpaid',  d: 'unpaid'  },
          { v: 'Partial', d: 'partial' },
          { v: 'Paid',    d: 'paid'    },
        ].map((s) => (
          <button key={s.v}
            className={`rpt-chip ${filters.payment_status === s.v ? 'on' : ''}`}
            onClick={() => setFilters((f) => ({ ...f, payment_status: f.payment_status === s.v ? null : s.v }))}>
            <span className={`rpt-dot ${s.d}`} />{s.v}
          </button>
        ))}
      </div>

      {/* ─── TABLE ─── */}
      <div className="rpt-tbl-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="sales_bill_id"
          scroll={{ x: 1300 }}
          summaryCells={summaryCells}
          summaryColSpan={summaryColSpan}
        />
      </div>
    </div>
  );
}
