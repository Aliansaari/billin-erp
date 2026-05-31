import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DatePicker, Button, Tag, Tooltip, message, Popover, Input, Select, Table } from 'antd';
import { SettingOutlined, SearchOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI, salesmanAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';

/*
 * Sales by Salesman — performance rollup, one row per salesman.
 *
 * This report is PURE ATTRIBUTION. Every number is summed from values
 * the bill already stored (sub_total, GST, total, balance, returns,
 * COGS). Nothing here re-prices, re-taxes, or re-posts anything — it
 * only groups existing bill figures by sb.salesman_id. Bills with no
 * salesman fall into a single honest "Unassigned" bucket.
 *
 * Commission is INDICATIVE ONLY: period taxable × the salesman's
 * stored commission %. It is never posted to the ledger and is clearly
 * labelled as informational throughout the page.
 *
 * UI mirrors the editorial-report chrome shared by Sales Report et al.
 * (.report-editorial / .rpt-*), but the per-salesman dataset is tiny
 * (one row each), so this uses a plain sortable Ant Table with a
 * server-aggregated footer rather than the virtualized table.
 */

// Non-breaking space between ₹ and the number so a narrow cell never
// splits the glyph onto its own line. Matches Sales Report's fmt().
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// Toggleable columns. `default: true` ship visible. Identity + the
// headline money columns are on; the GST-filing / cost-analysis
// columns are opt-in. Persisted to localStorage.
const ALL_COLS = [
  { key: 'sr_no',          label: 'Sr No',         default: true  },
  { key: 'salesman',       label: 'Salesman',      default: true  },
  { key: 'bills',          label: 'Bills',         default: true  },
  { key: 'sub_total',      label: 'Taxable value', default: true  },
  { key: 'discount',       label: 'Discount',      default: false },
  { key: 'gst',            label: 'GST',           default: true  },
  { key: 'total',          label: 'Total Sales',   default: true  },
  { key: 'paid',           label: 'Collected',     default: true  },
  { key: 'balance',        label: 'Outstanding',   default: true  },
  { key: 'returns',        label: 'Returns',       default: false },
  { key: 'cogs',           label: 'COGS',          default: false },
  { key: 'profit',         label: 'Profit (₹)',    default: true  },
  { key: 'margin',         label: 'Margin %',      default: true  },
  { key: 'commission_pct', label: 'Commission %',  default: false },
  { key: 'commission',     label: 'Commission ₹ (indicative)', default: true },
];
const COLS_STORAGE_KEY = 'salesmanReport_cols_v2';
const DEFAULT_COLS = ALL_COLS.reduce((o, c) => ({ ...o, [c.key]: c.default }), {});

// KPI tiles. `tone` maps to the theme CSS vars so the cards re-skin
// with the active theme (same convention as Sales Report).
const ALL_KPIS = [
  { key: 'sales',       label: 'Total Sales',             tone: 'success', default: true,
    value: (s) => fmt(s.total_amount) },
  { key: 'profit',      label: 'Total Profit',            tone: (s) => (s.total_profit || 0) >= 0 ? 'profit-pos' : 'profit-neg', default: true,
    value: (s) => fmt(s.total_profit) },
  { key: 'margin',      label: 'Margin',                  tone: 'warning', default: true,
    value: (s) => `${(s.margin_pct || 0).toFixed(1)}%` },
  { key: 'commission',  label: 'Commission (indicative)', tone: 'info',    default: true,
    value: (s) => fmt(s.total_commission) },
  { key: 'outstanding', label: 'Outstanding',             tone: 'danger',  default: true,
    value: (s) => fmt(s.total_balance) },
  { key: 'salesmen',    label: 'Salesmen',                tone: 'neutral', default: true,
    value: (s) => String(s.salesmen_count || 0) },
  { key: 'bills',       label: 'Bills',                   tone: 'neutral', default: true,
    value: (s) => String(s.total_bills || 0) },
  { key: 'gst',         label: 'Total GST',               tone: 'accent',  default: false,
    value: (s) => fmt(s.total_gst) },
  { key: 'sub_total',   label: 'Taxable Value',           tone: 'info',    default: false,
    value: (s) => fmt(s.total_sub) },
  { key: 'discount',    label: 'Total Discount',          tone: 'warning', default: false,
    value: (s) => fmt(s.total_discount) },
  { key: 'paid',        label: 'Collected',               tone: 'success', default: false,
    value: (s) => fmt(s.total_paid) },
  { key: 'returns',     label: 'Returns',                 tone: 'warning', default: false,
    value: (s) => fmt(s.total_return) },
  { key: 'cogs',        label: 'Total COGS',              tone: 'neutral', default: false,
    value: (s) => fmt(s.total_cogs) },
];
const KPIS_STORAGE_KEY = 'salesmanReport_kpis_v1';
const DEFAULT_KPIS = ALL_KPIS.reduce((o, k) => ({ ...o, [k.key]: k.default }), {});

// Period presets resolved against the company FY (same helper shape as
// Sales Report so the two pages behave identically).
function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy'    && fyStart && fyEnd) return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'last_fy'    && fyStart && fyEnd) return [dayjs(fyStart).subtract(1, 'year'), dayjs(fyEnd).subtract(1, 'year')];
  if (key === 'this_q')     return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'), today.endOf('month')];
  return null;
}

// Stable zeroed summary skeleton — what we show before the first load
// and on an empty result.
const EMPTY_SUMMARY = {
  salesmen_count: 0, total_bills: 0, total_sub: 0, total_discount: 0,
  total_gst: 0, total_amount: 0, total_paid: 0, total_balance: 0,
  total_return: 0, total_cogs: 0, total_profit: 0, margin_pct: 0,
  total_commission: 0,
};

// Stable rowKey — the Unassigned bucket has a null salesman_id.
const rowKeyOf = (r) => (r.salesman_id === null || r.salesman_id === undefined ? 'unassigned' : `sm_${r.salesman_id}`);

export default function SalesmanReport() {
  const { fyStart, fyEnd } = useFinancialYear();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Honour drill-in params (?from=&to=&salesman_id=) when present;
  // otherwise default to the company FY.
  const initialFrom = (() => { const q = searchParams.get('from'); return q && dayjs(q).isValid() ? q : null; })();
  const initialTo   = (() => { const q = searchParams.get('to');   return q && dayjs(q).isValid() ? q : null; })();
  const initialSm   = (() => { const q = searchParams.get('salesman_id'); return q ? parseInt(q, 10) || null : null; })();

  const [filters, setFilters] = useState({
    from_date:   initialFrom || fyStart || dayjs().startOf('month').format('YYYY-MM-DD'),
    to_date:     initialTo   || fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD'),
    salesman_id: initialSm,
  });
  const [preset, setPreset] = useState(initialFrom && initialTo ? 'custom' : 'this_fy');

  const [data, setData]       = useState([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(false);

  // Master salesman list for the focus dropdown (includes inactive so a
  // disabled salesman with historical bills can still be selected).
  const [salesmenList, setSalesmenList] = useState([]);
  useEffect(() => {
    salesmanAPI.getAll({ include_inactive: 'true' })
      .then(({ data: d }) => setSalesmenList(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  // ── Client-side view controls (instant; never hit the server) ──────
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);       // hide explicitly inactive salesmen
  const [hideUnassigned, setHideUnassigned] = useState(false);
  const searchRef = useRef(null);

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
  useEffect(() => { try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(colsVisible)); } catch {} }, [colsVisible]);
  useEffect(() => { try { localStorage.setItem(KPIS_STORAGE_KEY, JSON.stringify(kpisVisible)); } catch {} }, [kpisVisible]);

  // ── Data load ──────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { from_date: filters.from_date, to_date: filters.to_date };
      if (filters.salesman_id) params.salesman_id = filters.salesman_id;
      const res = await reportAPI.getSalesBySalesman(params);
      setData(Array.isArray(res.data?.data) ? res.data.data : []);
      setSummary(res.data?.summary || EMPTY_SUMMARY);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to load Sales by Salesman');
      setData([]);
      setSummary(EMPTY_SUMMARY);
    } finally {
      setLoading(false);
    }
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  // Sync dates when the preset changes (and when FY arrives async).
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

  // ── Client-side filtered view ───────────────────────────────────────
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.filter((r) => {
      if (hideUnassigned && (r.salesman_id === null || r.salesman_id === undefined)) return false;
      // "Active only" hides salesmen explicitly flagged inactive. The
      // Unassigned bucket (salesman_active === null) is left to the
      // dedicated "Hide unassigned" chip, not this one.
      if (activeOnly && r.salesman_active === false) return false;
      if (q) {
        const hay = `${r.salesman_name || ''} ${r.salesman_code || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, search, activeOnly, hideUnassigned]);

  // View summary recomputed from the rows actually on screen so the KPI
  // tiles + footer always agree with the visible table (the server
  // summary covers the full server-filtered set; client chips/search
  // can narrow it). Pure summation over already-stored figures.
  const viewSummary = useMemo(() => {
    // No client narrowing → trust the server's rounded summary verbatim.
    if (!search.trim() && !activeOnly && !hideUnassigned) return summary;
    const s = { ...EMPTY_SUMMARY };
    for (const r of visibleRows) {
      s.salesmen_count   += 1;
      s.total_bills      += r.bill_count || 0;
      s.total_sub        += r.total_sub || 0;
      s.total_discount   += r.total_discount || 0;
      s.total_gst        += r.total_gst || 0;
      s.total_amount     += r.total_amount || 0;
      s.total_paid       += r.total_paid || 0;
      s.total_balance    += r.total_balance || 0;
      s.total_return     += r.total_return || 0;
      s.total_cogs       += r.total_cogs || 0;
      s.total_profit     += r.total_profit || 0;
      s.total_commission += r.commission_amount || 0;
    }
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    Object.keys(s).forEach((k) => {
      if (k !== 'salesmen_count' && k !== 'total_bills') s[k] = r2(s[k]);
    });
    s.margin_pct = s.total_sub > 0 ? r2((s.total_profit / s.total_sub) * 100) : 0;
    return s;
  }, [visibleRows, summary, search, activeOnly, hideUnassigned]);

  // ── Cursor (single-click highlight; F1 acts on it) ─────────────────
  const [cursorKey, setCursorKey] = useState(null);
  const cursorRow = visibleRows.find((r) => rowKeyOf(r) === cursorKey) || null;

  // Focus the report on one salesman (server re-query). No-op for the
  // Unassigned bucket since there's no id to filter on.
  const focusSalesman = (row) => {
    if (!row || row.salesman_id === null || row.salesman_id === undefined) return;
    setFilters((f) => ({ ...f, salesman_id: row.salesman_id }));
  };

  // ── Column registry ────────────────────────────────────────────────
  const COL_SPECS = useMemo(() => ({
    sr_no: {
      title: 'Sr', width: 56, align: 'center',
      render: (_v, _r, idx) => <span style={{ color: 'var(--fg-tertiary)', fontFamily: 'Geist Mono, monospace' }}>{idx + 1}</span>,
    },
    salesman: {
      title: 'Salesman', dataIndex: 'salesman_name', width: 240, ellipsis: true,
      render: (v, r) => {
        const unassigned = r.salesman_id === null || r.salesman_id === undefined;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: unassigned ? 400 : 600, color: unassigned ? 'var(--fg-tertiary)' : undefined }}>{v}</span>
            {r.salesman_code ? <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>{r.salesman_code}</Tag> : null}
            {r.salesman_active === false && <Tag color="default">Inactive</Tag>}
          </div>
        );
      },
    },
    bills:     { title: 'Bills',     dataIndex: 'bill_count', width: 80, align: 'center',
                 sorter: (a, b) => (a.bill_count || 0) - (b.bill_count || 0) },
    sub_total: { title: 'Taxable',   dataIndex: 'total_sub', width: 120, align: 'right', render: fmt,
                 sorter: (a, b) => (a.total_sub || 0) - (b.total_sub || 0) },
    discount:  { title: 'Discount',  dataIndex: 'total_discount', width: 110, align: 'right', render: fmt,
                 sorter: (a, b) => (a.total_discount || 0) - (b.total_discount || 0) },
    gst:       { title: 'GST',       dataIndex: 'total_gst', width: 110, align: 'right', render: fmt,
                 sorter: (a, b) => (a.total_gst || 0) - (b.total_gst || 0) },
    total:     { title: 'Total Sales', dataIndex: 'total_amount', width: 130, align: 'right',
                 render: (v) => <strong>{fmt(v)}</strong>,
                 sorter: (a, b) => (a.total_amount || 0) - (b.total_amount || 0) },
    paid:      { title: 'Collected', dataIndex: 'total_paid', width: 120, align: 'right', render: fmt,
                 sorter: (a, b) => (a.total_paid || 0) - (b.total_paid || 0) },
    balance:   { title: 'Outstanding', dataIndex: 'total_balance', width: 120, align: 'right',
                 render: (v) => <span style={{ color: v > 0 ? '#ff4d4f' : '#52c41a' }}>{fmt(v)}</span>,
                 sorter: (a, b) => (a.total_balance || 0) - (b.total_balance || 0) },
    returns:   { title: 'Returns',   dataIndex: 'total_return', width: 110, align: 'right', render: fmt,
                 sorter: (a, b) => (a.total_return || 0) - (b.total_return || 0) },
    cogs:      { title: 'COGS',      dataIndex: 'total_cogs', width: 110, align: 'right', render: fmt,
                 sorter: (a, b) => (a.total_cogs || 0) - (b.total_cogs || 0) },
    profit:    { title: 'Profit',    dataIndex: 'total_profit', width: 120, align: 'right',
                 render: (v) => <span style={{ color: v > 0 ? '#16a34a' : v < 0 ? '#dc2626' : undefined, fontWeight: 600 }}>{fmt(v)}</span>,
                 sorter: (a, b) => (a.total_profit || 0) - (b.total_profit || 0) },
    margin:    { title: 'Margin %',  dataIndex: 'margin_pct', width: 100, align: 'right',
                 render: (v) => <span style={{ color: v > 0 ? '#16a34a' : v < 0 ? '#dc2626' : undefined }}>{(v || 0).toFixed(1)}%</span>,
                 sorter: (a, b) => (a.margin_pct || 0) - (b.margin_pct || 0) },
    commission_pct: { title: 'Comm %', dataIndex: 'commission_percentage', width: 90, align: 'right',
                 render: (v) => `${(v || 0).toFixed(2)}%` },
    commission: {
      title: (
        <Tooltip title="Indicative only — period taxable × the salesman's stored commission %. Never posted to the ledger.">
          <span>Commission <InfoCircleOutlined style={{ fontSize: 11, opacity: 0.55 }} /></span>
        </Tooltip>
      ),
      dataIndex: 'commission_amount', width: 150, align: 'right',
      render: (v) => <span style={{ color: 'var(--fg-secondary)' }}>{fmt(v)}</span>,
      sorter: (a, b) => (a.commission_amount || 0) - (b.commission_amount || 0),
    },
  }), []);

  const columns = useMemo(
    () => ALL_COLS.filter((c) => colsVisible[c.key]).map((c) => ({ key: c.key, ...COL_SPECS[c.key] })),
    [colsVisible, COL_SPECS],
  );

  // ── Footer (Σ over the visible rows) ───────────────────────────────
  // Percentages aren't additive, so Commission % shows no total. Margin
  // % is the aggregate (Σprofit / Σtaxable), which IS meaningful.
  const SUMMABLE = useMemo(() => new Set([
    'bills', 'sub_total', 'discount', 'gst', 'total', 'paid',
    'balance', 'returns', 'cogs', 'profit', 'margin', 'commission',
  ]), []);
  const firstAggIdx = useMemo(() => {
    const idx = columns.findIndex((c) => SUMMABLE.has(c.key));
    return idx === -1 ? columns.length : idx;
  }, [columns, SUMMABLE]);

  const footerForKey = (key) => {
    switch (key) {
      case 'bills':     return <strong>{viewSummary.total_bills}</strong>;
      case 'sub_total': return fmt(viewSummary.total_sub);
      case 'discount':  return fmt(viewSummary.total_discount);
      case 'gst':       return fmt(viewSummary.total_gst);
      case 'total':     return <strong>{fmt(viewSummary.total_amount)}</strong>;
      case 'paid':      return fmt(viewSummary.total_paid);
      case 'balance':   return <span style={{ color: viewSummary.total_balance > 0 ? '#ff4d4f' : '#52c41a' }}>{fmt(viewSummary.total_balance)}</span>;
      case 'returns':   return fmt(viewSummary.total_return);
      case 'cogs':      return fmt(viewSummary.total_cogs);
      case 'profit':    return <span style={{ color: (viewSummary.total_profit || 0) >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{fmt(viewSummary.total_profit)}</span>;
      case 'margin':    return `${(viewSummary.margin_pct || 0).toFixed(1)}%`;
      case 'commission':return <strong>{fmt(viewSummary.total_commission)}</strong>;
      default:          return null;
    }
  };

  const renderSummary = () => {
    if (!visibleRows.length) return null;
    // When at least one leading column isn't summable (the usual case:
    // Sr / Salesman), the "Total · N" label spans those columns. If the
    // very first column is already summable (both identity columns
    // hidden), skip the label and just total every column.
    const hasLabelRoom = firstAggIdx > 0;
    return (
      <Table.Summary fixed>
        <Table.Summary.Row>
          {columns.map((c, idx) => {
            if (hasLabelRoom && idx === 0) {
              return (
                <Table.Summary.Cell key={c.key} index={0} colSpan={firstAggIdx}>
                  <strong>Total · {viewSummary.salesmen_count} {viewSummary.salesmen_count === 1 ? 'row' : 'rows'}</strong>
                </Table.Summary.Cell>
              );
            }
            if (hasLabelRoom && idx < firstAggIdx) return null;   // merged into the label cell
            return (
              <Table.Summary.Cell key={c.key} index={idx} align="right">
                {footerForKey(c.key)}
              </Table.Summary.Cell>
            );
          })}
        </Table.Summary.Row>
      </Table.Summary>
    );
  };

  // ── Export (client-side CSV of the visible rows) ───────────────────
  const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const handleExport = () => {
    try {
      const headers = ['Salesman', 'Code', 'Status', 'Bills', 'Taxable', 'Discount', 'GST',
        'Total Sales', 'Collected', 'Outstanding', 'Returns', 'COGS', 'Profit', 'Margin %',
        'Commission %', 'Commission (indicative)'];
      const lines = [headers.map(csvCell).join(',')];
      for (const r of visibleRows) {
        const status = (r.salesman_id === null || r.salesman_id === undefined)
          ? '' : (r.salesman_active === false ? 'Inactive' : 'Active');
        lines.push([
          r.salesman_name, r.salesman_code, status, r.bill_count,
          r.total_sub, r.total_discount, r.total_gst, r.total_amount,
          r.total_paid, r.total_balance, r.total_return, r.total_cogs,
          r.total_profit, r.margin_pct, r.commission_percentage, r.commission_amount,
        ].map(csvCell).join(','));
      }
      lines.push([
        'TOTAL', '', '', viewSummary.total_bills,
        viewSummary.total_sub, viewSummary.total_discount, viewSummary.total_gst, viewSummary.total_amount,
        viewSummary.total_paid, viewSummary.total_balance, viewSummary.total_return, viewSummary.total_cogs,
        viewSummary.total_profit, viewSummary.margin_pct, '', viewSummary.total_commission,
      ].map(csvCell).join(','));

      const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sales_by_salesman_${filters.from_date}_to_${filters.to_date}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      message.error('Export failed');
    }
  };

  const handlePrint = () => window.print();

  // F2 — classic accounting-style range popup.
  const { openDate } = useDatePopup();
  const f2PeriodPopup = () => openDate({
    mode: 'range',
    title: 'Period',
    value: [dayjs(filters.from_date), dayjs(filters.to_date)],
    onConfirm: ([from, to]) => {
      setPreset('custom');
      setFilters((f) => ({ ...f, from_date: from.format('YYYY-MM-DD'), to_date: to.format('YYYY-MM-DD') }));
    },
  });

  const customizePopoverContent = (
    <div className="cols-menu" style={{ width: 280, maxHeight: '70vh', overflowY: 'auto' }}>
      <div className="grp">
        <div className="mh">KPI Cards</div>
        {ALL_KPIS.map((k) => (
          <label key={k.key} className="opt">
            <input type="checkbox" checked={!!kpisVisible[k.key]}
              onChange={(e) => setKpisVisible((v) => ({ ...v, [k.key]: e.target.checked }))} />
            <span>{k.label}</span>
          </label>
        ))}
      </div>
      <div className="grp">
        <div className="mh">Columns</div>
        {ALL_COLS.map((c) => (
          <label key={c.key} className="opt">
            <input type="checkbox" checked={!!colsVisible[c.key]}
              onChange={(e) => setColsVisible((v) => ({ ...v, [c.key]: e.target.checked }))} />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  const fyLabel = fyStart ? `FY ${dayjs(fyStart).format('YYYY')}-${dayjs(fyEnd).format('YY')}` : '';
  const focusedSalesman = filters.salesman_id
    ? salesmenList.find((s) => s.salesman_id === filters.salesman_id)
    : null;

  return (
    <div className="report-editorial" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── HEADER ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Sales by Salesman</h1>
          <div className="rpt-sub">
            <b>{viewSummary.salesmen_count}</b> salesman{viewSummary.salesmen_count === 1 ? '' : 'en'}
            <span className="sep">·</span><b>{viewSummary.total_bills}</b> bill{viewSummary.total_bills === 1 ? '' : 's'}
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
            format="DD/MM/YYYY" className="rpt-date" allowClear={false}
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
        </div>
      </div>

      {/* ─── KPI STRIP ─── */}
      {ALL_KPIS.some((k) => kpisVisible[k.key]) && (
        <div className="rpt-kpis">
          {ALL_KPIS.filter((k) => kpisVisible[k.key]).map((k) => {
            const tone = typeof k.tone === 'function' ? k.tone(viewSummary) : k.tone;
            return (
              <div key={k.key} className={`rpt-kpi tone-${tone}`}>
                <div className="rpt-kpi-k">{k.label}</div>
                <div className="rpt-kpi-v">{k.value(viewSummary)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── FILTER BAR ─── */}
      <div className="rpt-filter">
        <Input
          ref={searchRef}
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder="Search salesman or code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <Select
          placeholder="All salesmen"
          allowClear showSearch optionFilterProp="label"
          value={filters.salesman_id || undefined}
          onChange={(val) => setFilters((f) => ({ ...f, salesman_id: val || null }))}
          options={salesmenList.map((s) => ({ value: s.salesman_id, label: s.code ? `${s.name} (${s.code})` : s.name }))}
          style={{ minWidth: 190 }}
        />
        <span className="rpt-sep" />
        <button
          className={`rpt-chip ${activeOnly ? 'on' : ''}`}
          onClick={() => setActiveOnly((v) => !v)}
        >Active only</button>
        <button
          className={`rpt-chip ${hideUnassigned ? 'on' : ''}`}
          onClick={() => setHideUnassigned((v) => !v)}
        >Hide unassigned</button>
        {focusedSalesman && (
          <Tag closable color="processing" onClose={() => setFilters((f) => ({ ...f, salesman_id: null }))}>
            Showing: {focusedSalesman.name}
          </Tag>
        )}
      </div>

      {/* ─── TABLE — contained in a bordered panel that fills the
              available height, so the page reads as a deliberate data
              panel rather than a few rows floating in empty space. ─── */}
      <div className="rpt-tbl-wrap">
        <div className="smr-card">
          <div className="smr-card-hd">
            <span className="smr-card-ttl">Salesman performance</span>
            <span className="smr-card-meta">
              {visibleRows.length} {visibleRows.length === 1 ? 'row' : 'rows'}
              {filters.salesman_id ? ' · filtered' : ''} · highest sales first
            </span>
          </div>
          <div className="smr-card-body">
            <Table
              className="smr-table"
              size="middle"
              rowKey={rowKeyOf}
              loading={loading}
              dataSource={visibleRows}
              columns={columns}
              pagination={false}
              scroll={{ x: 1200 }}
              sticky
              summary={renderSummary}
              rowClassName={(r) => (rowKeyOf(r) === cursorKey ? 'rpt-row-cursor' : '')}
              onRow={(r) => ({
                onClick: () => setCursorKey(rowKeyOf(r)),
                onDoubleClick: () => focusSalesman(r),
                style: { cursor: r.salesman_id != null ? 'pointer' : 'default' },
              })}
            />
          </div>
          <div className="smr-note">
            <InfoCircleOutlined />
            <span>Commission is indicative only (period taxable × stored %); it is never posted to any ledger. Bills with no salesman appear under “Unassigned”.</span>
          </div>
        </div>
      </div>

      {/* ─── ACTION STRIP ─── */}
      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: () => navigate('/reports') },
          { id: 'period', key: 'F2', label: 'Period', onAction: f2PeriodPopup, title: 'Open the smart-input period popup' },
          { id: 'find', key: 'F4', label: 'Find', onAction: () => searchRef.current?.focus?.() },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: () => load() },
          { id: 'print', key: 'F9', label: 'Print', onAction: handlePrint },
          { id: 'export', key: 'F10', label: 'Export', onAction: handleExport },
          { id: 'focus', key: 'F1', label: 'Focus', tone: 'primary',
            disabled: !cursorRow || cursorRow.salesman_id == null,
            onAction: () => focusSalesman(cursorRow) },
        ]}
      />
    </div>
  );
}
