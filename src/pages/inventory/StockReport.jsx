import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Input, Select, message, Spin, Upload, Modal, Progress, Dropdown, DatePicker,
} from 'antd';
import {
  SearchOutlined, FileExcelOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  SettingOutlined, ReloadOutlined, CalendarOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { reportAPI, categoryAPI, godownAPI, dataAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';
import './stock-report.css';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) =>    parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
const fmtL = (v) => {
  const n = parseFloat(v || 0);
  if (Math.abs(n) >= 10000000) return `₹ ${(n / 10000000).toFixed(2)} Cr`;
  if (Math.abs(n) >= 100000)   return `₹ ${(n / 100000).toFixed(2)} L`;
  return fmt(n);
};

// Column registry — `default` flags which are on at first run; `fixed`
// flags ones the user can't toggle off (Sr/Product/Stock are anchors).
// Order in this array determines render order in the table.
const COL_DEFS = [
  { key: 'sr',     label: 'Sr No',         default: true,  fixed: true,  group: 'id' },
  { key: 'bc',     label: 'Barcode',       default: true,                 group: 'id' },
  { key: 'cat',    label: 'Category',      default: true,                 group: 'id' },
  { key: 'prod',   label: 'Product',       default: true,  fixed: true,  group: 'id' },
  { key: 'size',   label: 'Size',          default: true,                 group: 'id' },
  { key: 'art',    label: 'Article No',    default: true,                 group: 'id' },
  { key: 'hsn',    label: 'HSN',           default: false,                group: 'id' },
  { key: 'gst',    label: 'GST %',         default: false,                group: 'id' },
  { key: 'open',   label: 'Opening Stock', default: true,                 group: 'qty' },
  { key: 'in',     label: 'Inward',        default: false,                group: 'qty' },
  { key: 'out',    label: 'Outward',       default: false,                group: 'qty' },
  { key: 'stk',    label: 'Stock',         default: true,  fixed: true,  group: 'qty' },
  { key: 'min',    label: 'Min Level',     default: false,                group: 'qty' },
  { key: 'pur',    label: 'Pur. Rate',     default: true,                 group: 'price' },
  { key: 'sale',   label: 'Sale Rate',     default: true,                 group: 'price' },
  { key: 'mrg',    label: 'Margin %',      default: true,                 group: 'price' },
  { key: 'val',    label: 'Stock Value',   default: true,                 group: 'price' },
  { key: 'vals',   label: 'Sale Value',    default: false,                group: 'price' },
];
const SEC_DEFS = [
  { key: 'kpiStrip', label: 'KPI strip (top tiles)' },
  { key: 'banner',   label: 'Data integrity banner' },
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
const LS_KEY = 'inv-stock-report-cols-v4';
const DEFAULT_PREFS = {
  ...Object.fromEntries(COL_DEFS.map(c => [c.key, c.default])),
  kpiStrip: true,
  banner:   true,
  totalRow: true,
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_PREFS }; }
}

// Status bucketing — same rules as the server's summary aggregates so
// the row's tint matches the chip count for that row's bucket.
function stockStatus(v, min) {
  const q = parseFloat(v);
  if (q < 0) return 'neg';
  if (q === 0) return 'out';
  if (parseFloat(min) > 0 && q <= parseFloat(min)) return 'low';
  return 'ok';
}

export default function StockReport() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  // period_from / period_to drive the Inward / Outward columns. NULL on
  // both means "all time" — the server treats the absence as no date
  // floor (sentinel 1900-01-01).
  const [filters, setFilters] = useState({
    search: '', category_id: null, stock_status: null, godown_id: null,
    period_from: null, period_to: null,
  });
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 220);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [categories, setCategories] = useState([]);
  const [godowns,    setGodowns]    = useState([]);
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch {} }, [prefs]);
  const cols = prefs;

  const [importing, setImporting] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importProgress, setImportProgress] = useState(0);
  const [importPhase, setImportPhase] = useState('');
  const [downloadingFailed, setDownloadingFailed] = useState(false);

  // Hidden file input drives the Import menu item (Antd Upload's wrapper
  // would close the dropdown before the file chooser opens).
  const fileInputRef = useRef(null);

  // ── Virtualized data layer (unchanged) ───────────────────────────
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => reportAPI.getStockReport(params),
    filters,
    chunkSize: 200,
  });

  useEffect(() => { loadRefs(); }, []);
  const loadRefs = async () => {
    try {
      const [{ data: cats }, { data: gds }] = await Promise.all([
        categoryAPI.getAllFlat(),
        godownAPI.getAll(),
      ]);
      setCategories(cats || []);
      setGodowns(Array.isArray(gds) ? gds : (gds?.data || []));
    } catch {}
  };

  /* ── export ── */
  const handleExport = async () => {
    try {
      const { data } = await reportAPI.exportStockReport(filters);
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock_report_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  /* ── template ── */
  const handleTemplate = async () => {
    try {
      const { data } = await dataAPI.downloadTemplate('products');
      const url = window.URL.createObjectURL(new Blob([data]));
      const a = document.createElement('a'); a.href = url; a.download = 'products_template.xlsx'; a.click();
    } catch { message.error('Template download failed'); }
  };

  /* ── import ── */
  const handleImport = async (file) => {
    setImporting(true);
    setImportProgress(0);
    setImportPhase('uploading');
    setImportResult(null);
    try {
      const res = await dataAPI.importExcel('products', file, (pct) => {
        setImportProgress(pct);
        if (pct >= 100) setImportPhase('processing');
      });
      setImportResult(res.data);
      setImportModal(true);
      refresh();
    } catch (e) {
      const errMsg = e.response?.data?.error || e.message || 'Import failed';
      setImportResult({ failed: true, error: errMsg });
      setImportModal(true);
    }
    setImporting(false);
    setImportPhase('');
  };

  const handleDownloadFailed = async () => {
    if (!importResult?.errors?.length) return;
    setDownloadingFailed(true);
    try {
      const { data } = await dataAPI.downloadFailedReport(importResult.errors);
      const url = window.URL.createObjectURL(new Blob([data]));
      const a = document.createElement('a'); a.href = url; a.download = 'failed_import_report.xlsx'; a.click();
    } catch { message.error('Failed to download report'); }
    setDownloadingFailed(false);
  };

  // Pretty label for the chosen movement period — used in column titles.
  const periodLabel = useMemo(() => {
    const f = filters.period_from, t = filters.period_to;
    if (!f && !t) return 'All time';
    const fmtD = (s) => s ? dayjs(s).format('DD MMM YY') : null;
    if (f && t) return `${fmtD(f)} → ${fmtD(t)}`;
    if (f)      return `since ${fmtD(f)}`;
    return `until ${fmtD(t)}`;
  }, [filters.period_from, filters.period_to]);

  /* ── columns ── */
  const columns = useMemo(() => [
    cols.sr && {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => <span className="sr-sr-num">{idx + 1}</span>,
    },
    cols.bc && {
      key: 'bc', title: 'Barcode', dataIndex: 'barcode', width: 130,
      render: (v) => v ? <span className="sr-bc">{v}</span> : <span className="sr-amt muted">—</span>,
    },
    cols.cat && {
      key: 'cat', title: 'Category', dataIndex: ['Category', 'category_name'], width: 140,
      render: (v) => <span className="sr-cat">{v || '—'}</span>,
    },
    {
      key: 'prod', title: 'Product', dataIndex: 'product_name', width: 240, fixed: 'left',
      render: (v) => <span className="sr-prod-name">{v}</span>,
    },
    cols.size && {
      key: 'size', title: 'Size', dataIndex: 'size_value', width: 70, align: 'center',
      render: (v) => v ? <span className="sr-size-pill">{v}</span> : <span className="sr-amt muted">—</span>,
    },
    cols.art && {
      key: 'art', title: 'Article', dataIndex: 'article_number', width: 110,
      render: (v) => v ? <span className="sr-art">{v}</span> : <span className="sr-amt muted">—</span>,
    },
    cols.hsn && {
      key: 'hsn', title: 'HSN', dataIndex: 'hsn_code', width: 90,
      render: (v) => v ? <span className="sr-art">{v}</span> : <span className="sr-amt muted">—</span>,
    },
    cols.gst && {
      key: 'gst', title: 'GST %', dataIndex: 'gst_rate', width: 80, align: 'right',
      sorter: (a, b) => parseFloat(a.gst_rate || 0) - parseFloat(b.gst_rate || 0),
      render: (v) => v != null
        ? <span className="sr-qty">{parseFloat(v).toFixed(0)}%</span>
        : <span className="sr-amt muted">—</span>,
    },
    cols.open && {
      key: 'open', title: 'Opening', dataIndex: 'opening_stock', width: 90, align: 'right',
      sorter: (a, b) => parseFloat(a.opening_stock || 0) - parseFloat(b.opening_stock || 0),
      render: (v) => <span className="sr-qty">{fmtN(v)}</span>,
    },
    cols.in && {
      key: 'in', title: `Inward${periodLabel ? ` · ${periodLabel}` : ''}`, dataIndex: 'inward_qty', width: 110, align: 'right',
      render: (v) => parseFloat(v || 0) > 0
        ? <span className="sr-qty in">+{fmtN(v)}</span>
        : <span className="sr-qty muted">0</span>,
    },
    cols.out && {
      key: 'out', title: `Outward${periodLabel ? ` · ${periodLabel}` : ''}`, dataIndex: 'outward_qty', width: 110, align: 'right',
      render: (v) => parseFloat(v || 0) > 0
        ? <span className="sr-qty out">−{fmtN(v)}</span>
        : <span className="sr-qty muted">0</span>,
    },
    {
      key: 'stk', title: 'Stock', dataIndex: 'current_stock', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.current_stock || 0) - parseFloat(b.current_stock || 0),
      render: (v, p) => {
        const s = stockStatus(v, p.minimum_stock_level);
        return <span className={`sr-stk ${s}`}>{fmtN(v)}</span>;
      },
    },
    cols.min && {
      key: 'min', title: 'Min Level', dataIndex: 'minimum_stock_level', width: 90, align: 'right',
      render: (v) => parseFloat(v) > 0 ? <span className="sr-qty muted">{fmtN(v)}</span> : <span className="sr-amt muted">—</span>,
    },
    cols.pur && {
      key: 'pur', title: 'Pur. Rate', dataIndex: 'purchase_rate', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.purchase_rate || 0) - parseFloat(b.purchase_rate || 0),
      render: (v) => <span className="sr-amt"><span className="rs">₹</span>{fmtN(v)}</span>,
    },
    cols.sale && {
      key: 'sale', title: 'Sale Rate', dataIndex: 'sale_rate', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.sale_rate || 0) - parseFloat(b.sale_rate || 0),
      render: (v) => <span className="sr-amt"><span className="rs">₹</span>{fmtN(v)}</span>,
    },
    cols.mrg && {
      key: 'mrg', title: 'Margin', width: 80, align: 'right',
      sorter: (a, b) => {
        // Margin% = (sale - pur) / pur. Rows with no purchase rate sort
        // last regardless of direction (treat as -Infinity for ASC, but
        // Antd handles equal sorter values stably so use a sentinel).
        const m = (r) => {
          const pur = parseFloat(r.purchase_rate || 0);
          const sale = parseFloat(r.sale_rate || 0);
          return pur > 0 ? ((sale - pur) / pur) * 100 : Number.NEGATIVE_INFINITY;
        };
        return m(a) - m(b);
      },
      render: (_, p) => {
        const pur = parseFloat(p.purchase_rate || 0);
        const sale = parseFloat(p.sale_rate || 0);
        if (pur <= 0) return <span className="sr-mrg warn">—</span>;
        const pct = ((sale - pur) / pur) * 100;
        const tone = pct > 5 ? 'pos' : pct < 0 ? 'bad' : 'warn';
        const sign = pct > 0 ? '+' : '';
        return <span className={`sr-mrg ${tone}`}>{sign}{pct.toFixed(1)}%</span>;
      },
    },
    cols.val && {
      key: 'val', title: 'Stock Value', width: 130, align: 'right',
      sorter: (a, b) =>
        parseFloat(a.current_stock || 0) * parseFloat(a.purchase_rate || 0) -
        parseFloat(b.current_stock || 0) * parseFloat(b.purchase_rate || 0),
      render: (_, p) => {
        const v = parseFloat(p.current_stock || 0) * parseFloat(p.purchase_rate || 0);
        const cls = v < 0 ? 'sr-amt neg-amt' : 'sr-amt val';
        return <span className={cls}><span className="rs">{v < 0 ? '−₹' : '₹'}</span>{fmtN(Math.abs(v))}</span>;
      },
    },
    cols.vals && {
      key: 'vals', title: 'Sale Value', width: 130, align: 'right',
      render: (_, p) => {
        const v = parseFloat(p.current_stock || 0) * parseFloat(p.sale_rate || 0);
        const cls = v < 0 ? 'sr-amt neg-amt' : 'sr-amt vals';
        return <span className={cls}><span className="rs">{v < 0 ? '−₹' : '₹'}</span>{fmtN(Math.abs(v))}</span>;
      },
    },
  ].filter(Boolean), [cols, periodLabel]);

  /* ── Total strip — render totals for every summable column ── */
  // SUMMABLE_RENDERERS maps column key → render function for the totals
  // row. Columns missing from this map render as blank (rate / margin /
  // identifiers don't aggregate meaningfully).
  const SUMMABLE_RENDERERS = useMemo(() => ({
    open: () => <span className="sr-qty">{fmtN(summary?.total_opening)}</span>,
    in:   () => <span className="sr-qty in">+{fmtN(summary?.total_inward)}</span>,
    out:  () => <span className="sr-qty out">−{fmtN(summary?.total_outward)}</span>,
    stk:  () => {
      const v = parseFloat(summary?.total_current_stock || 0);
      const cls = v < 0 ? 'sr-stk neg' : v === 0 ? 'sr-stk' : 'sr-stk ok';
      return <span className={cls}>{fmtN(v)}</span>;
    },
    val:  () => <span className="sr-amt val"><span className="rs">₹</span>{fmtN(summary?.total_purchase_value)}</span>,
    vals: () => <span className="sr-amt vals"><span className="rs">₹</span>{fmtN(summary?.total_sale_value)}</span>,
  }), [summary]);

  const firstAggIdx = useMemo(() => {
    const idx = columns.findIndex((c) => SUMMABLE_RENDERERS[c.key]);
    return idx === -1 ? columns.length : idx;
  }, [columns, SUMMABLE_RENDERERS]);

  const summaryCells = (col, idx) => {
    if (idx === 0) return totalCount > 0 ? `Total · ${totalCount} item${totalCount === 1 ? '' : 's'}` : null;
    if (idx > 0 && idx < firstAggIdx) return null;
    const renderer = SUMMABLE_RENDERERS[col.key];
    return renderer ? renderer() : null;
  };
  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  /* ── Customize popover ── */
  const renderColGroup = (groupKey) =>
    COL_DEFS.filter(c => c.group === groupKey).map(c => (
      <label key={c.key} className={`sr-cust-opt${c.fixed ? ' fixed' : ''}`}>
        <input
          type="checkbox"
          checked={!!cols[c.key] || !!c.fixed}
          disabled={!!c.fixed}
          onChange={(e) => setPrefs(p => ({ ...p, [c.key]: e.target.checked }))}
        />
        <span>{c.label}</span>
        {c.fixed && <span className="sr-cust-pin">Fixed</span>}
      </label>
    ));

  const customizePopoverContent = (
    <div className="sr-cust-pop">
      <div className="sr-cust-grp">
        <div className="sr-cust-gh">
          <span>Identifiers</span>
          <button className="sr-cust-reset" type="button" onClick={() => setPrefs(DEFAULT_PREFS)}>Reset</button>
        </div>
        {renderColGroup('id')}
      </div>
      <div className="sr-cust-grp">
        <div className="sr-cust-gh"><span>Quantity</span></div>
        {renderColGroup('qty')}
      </div>
      <div className="sr-cust-grp">
        <div className="sr-cust-gh"><span>Pricing &amp; Value</span></div>
        {renderColGroup('price')}
      </div>
      <div className="sr-cust-grp">
        <div className="sr-cust-gh"><span>Page Sections</span></div>
        {SEC_DEFS.map(s => (
          <label key={s.key} className="sr-cust-opt">
            <input
              type="checkbox"
              checked={!!cols[s.key]}
              onChange={(e) => setPrefs(p => ({ ...p, [s.key]: e.target.checked }))}
            />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  /* ── Excel dropdown menu ── */
  const excelMenu = {
    items: [
      { key: 'export',   label: 'Export to Excel',     icon: <FileExcelOutlined /> },
      { key: 'import',   label: 'Import from Excel',   icon: <FileExcelOutlined /> },
      { type: 'divider' },
      { key: 'template', label: 'Download Template',   icon: <FileExcelOutlined /> },
    ],
    onClick: ({ key }) => {
      if (key === 'export')   handleExport();
      if (key === 'import')   fileInputRef.current?.click();
      if (key === 'template') handleTemplate();
    },
  };

  /* ── Status filter chip selection ── */
  const setStatus = (status) => setFilters(f => ({ ...f, stock_status: status }));
  const activeStatus = filters.stock_status;

  const negativeCount = summary?.negative_count || 0;
  const negativeValue = summary?.negative_value || 0;

  // rowClassName tints negative / out rows
  const rowClassName = (r) => {
    if (!r || r.__loading) return '';
    const q = parseFloat(r.current_stock || 0);
    if (q < 0) return 'sr-row-neg';
    if (q === 0) return 'sr-row-out';
    return '';
  };

  const selectedGodownLabel = (() => {
    if (!filters.godown_id) return 'All Godowns';
    const g = godowns.find(x => x.godown_id === filters.godown_id);
    return g ? (g.name || g.code || `Godown #${filters.godown_id}`) : `Godown #${filters.godown_id}`;
  })();

  return (
    <div className="sr-page">

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <div className="sr-hd">
        <div className="sr-title">
          <h1>Stock Report</h1>
        </div>
        <div className="sr-ctrls">
          <div className="sr-search">
            <SearchOutlined />
            <input
              placeholder="Search product, barcode, article, category…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Select
            placeholder="All Categories"
            style={{ width: 160 }}
            allowClear
            value={filters.category_id}
            onChange={(v) => setFilters(f => ({ ...f, category_id: v ?? null }))}
            options={categories.map(c => ({ value: c.category_id, label: c.category_name }))}
          />
          <Select
            placeholder="All Godowns"
            style={{ width: 200 }}
            allowClear
            value={filters.godown_id}
            onChange={(v) => setFilters(f => ({ ...f, godown_id: v ?? null }))}
            optionFilterProp="label"
            options={godowns.map(g => ({
              value: g.godown_id,
              // Godown.name is the human label; .code is the short tag
              // (e.g. MAIN). Both shown so the picker is searchable by either.
              label: `${g.name || g.code || `Godown #${g.godown_id}`}${g.code ? ` · ${g.code}` : ''}${g.is_default ? ' · Default' : ''}`,
            }))}
          />
          <button className="sr-btn" onClick={() => refresh()} title="Refresh">
            <ReloadOutlined /> Refresh
          </button>
          <Dropdown menu={excelMenu} trigger={['click']} placement="bottomRight">
            <button className="sr-btn primary">
              <FileExcelOutlined /> Excel
            </button>
          </Dropdown>
          {/* Hidden file input — drives the Import menu item */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImport(f);
              e.target.value = '';
            }}
          />
          {importing && (
            <div style={{ width: 140 }}>
              {importPhase === 'uploading'
                ? <Progress percent={importProgress} size="small" showInfo={false} />
                : <Progress percent={100} size="small" status="active" showInfo={false} />}
              <div style={{ fontSize: 10, color: 'var(--fg-tertiary)', textAlign: 'center', marginTop: 2 }}>
                {importPhase === 'uploading' ? `Uploading ${importProgress}%` : 'Processing rows…'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── KPI STRIP (rounded card style, matches mockup) ─────── */}
      {cols.kpiStrip && (
        <div className="sr-kpis">
          <div
            className={`sr-kpi tot${activeStatus === null ? ' active' : ''}`}
            onClick={() => setStatus(null)}
          >
            <div className="sr-kpi-k">Total Items</div>
            <div className="sr-kpi-v">{summary?.total_items ?? totalCount}</div>
            <div className="sr-kpi-sub">{selectedGodownLabel}</div>
          </div>
          <div className="sr-kpi value-tone">
            <div className="sr-kpi-k">Stock Value (Pur)</div>
            <div className="sr-kpi-v">{fmtL(summary?.total_purchase_value)}</div>
            <div className="sr-kpi-sub">avg <b>{fmt((summary?.total_purchase_value || 0) / Math.max(1, summary?.total_items || 1))}</b> per item</div>
          </div>
          <div className="sr-kpi sale-tone">
            <div className="sr-kpi-k">Sale Potential</div>
            <div className="sr-kpi-v">{fmtL(summary?.total_sale_value)}</div>
            <div className="sr-kpi-sub">
              margin <b style={{ color: (summary?.potential_profit || 0) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {summary?.total_purchase_value > 0
                  ? `${((summary.potential_profit / summary.total_purchase_value) * 100).toFixed(2)} %`
                  : '—'}
              </b>
            </div>
          </div>
          <div
            className={`sr-kpi low-tone${activeStatus === 'low' ? ' active' : ''}`}
            onClick={() => setStatus(activeStatus === 'low' ? null : 'low')}
          >
            <div className="sr-kpi-k">Low Stock</div>
            <div className="sr-kpi-v">{summary?.low_count ?? 0}</div>
            <div className="sr-kpi-sub">at or below min level</div>
          </div>
          <div
            className={`sr-kpi out-tone${activeStatus === 'out' ? ' active' : ''}`}
            onClick={() => setStatus(activeStatus === 'out' ? null : 'out')}
          >
            <div className="sr-kpi-k">Out of Stock</div>
            <div className="sr-kpi-v">{summary?.out_count ?? 0}</div>
            <div className="sr-kpi-sub">
              {summary?.total_items > 0
                ? `${((summary.out_count / summary.total_items) * 100).toFixed(1)} % of catalogue`
                : '—'}
            </div>
          </div>
          <div
            className={`sr-kpi neg-tone${activeStatus === 'neg' ? ' active' : ''}`}
            onClick={() => setStatus(activeStatus === 'neg' ? null : 'neg')}
          >
            <div className="sr-kpi-k">Negative Stock</div>
            <div className="sr-kpi-v">{negativeCount}</div>
            <div className="sr-kpi-sub">data integrity flag</div>
          </div>
        </div>
      )}

      {/* ── DATA INTEGRITY BANNER ──────────────────────────────── */}
      {cols.banner && negativeCount > 0 && (
        <div className="sr-banner">
          <div className="sr-banner-ic">!</div>
          <div className="sr-banner-body">
            <b>{negativeCount} products show negative stock.</b>{' '}
            Sales recorded without matching purchase entries — most often
            from imported vouchers where opening balances weren't seeded.
            Total exposure: <b>{fmtN(Math.abs(summary?.negative_units || 0))} units</b> ·{' '}
            valued at <b>{fmt(Math.abs(negativeValue))}</b>.{' '}
            <button className="sr-banner-link" onClick={() => setStatus('neg')}>Filter to negatives →</button>
          </div>
          <div className="sr-banner-actions">
            <button className="sr-btn" onClick={() => setPrefs(p => ({ ...p, banner: false }))}>Dismiss</button>
          </div>
        </div>
      )}

      {/* ── FILTER ROW ──────────────────────────────────────────── */}
      <div className="sr-filters">
        {/* Movement period — drives Inward/Outward columns + their totals.
            Empty = all time. */}
        <span className="sr-period-lbl"><CalendarOutlined /> Movement period</span>
        <DatePicker.RangePicker
          size="small"
          format="DD MMM YYYY"
          allowEmpty={[true, true]}
          value={[
            filters.period_from ? dayjs(filters.period_from) : null,
            filters.period_to   ? dayjs(filters.period_to)   : null,
          ]}
          onChange={(v) => setFilters(f => ({
            ...f,
            period_from: v?.[0] ? v[0].format('YYYY-MM-DD') : null,
            period_to:   v?.[1] ? v[1].format('YYYY-MM-DD') : null,
          }))}
          presets={[
            { label: 'All time',     value: [null, null] },
            { label: 'This month',   value: [dayjs().startOf('month'),  dayjs().endOf('month')]  },
            { label: 'Last 30 days', value: [dayjs().subtract(30, 'day'), dayjs()] },
            { label: 'This quarter', value: [dayjs().startOf('quarter'), dayjs().endOf('quarter')] },
            { label: 'This FY',      value: [
                dayjs().month() < 3
                  ? dayjs().subtract(1, 'year').month(3).date(1)
                  : dayjs().month(3).date(1),
                dayjs(),
              ] },
          ]}
        />
        <span className="sr-period-val">{periodLabel}</span>
        <span className="sr-filters-divider" />
        <span
          className={`sr-chip${activeStatus === null ? ' on' : ''}`}
          onClick={() => setStatus(null)}
        ><span className="dot"></span>All</span>
        <span
          className={`sr-chip${activeStatus === 'ok' ? ' on' : ''}`}
          onClick={() => setStatus(activeStatus === 'ok' ? null : 'ok')}
        ><span className="dot ok"></span>In Stock</span>
        <span
          className={`sr-chip${activeStatus === 'low' ? ' on' : ''}`}
          onClick={() => setStatus(activeStatus === 'low' ? null : 'low')}
        ><span className="dot low"></span>Low</span>
        <span
          className={`sr-chip${activeStatus === 'out' ? ' on' : ''}`}
          onClick={() => setStatus(activeStatus === 'out' ? null : 'out')}
        ><span className="dot out"></span>Out</span>
        <span
          className={`sr-chip${activeStatus === 'neg' ? ' on' : ''}`}
          onClick={() => setStatus(activeStatus === 'neg' ? null : 'neg')}
        ><span className="dot neg"></span>Negative</span>

        <div className="ml-auto">
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            dropdownRender={() => customizePopoverContent}
          >
            <button className="sr-btn">
              <SettingOutlined /> Customize
            </button>
          </Dropdown>
        </div>
      </div>

      {/* ── TABLE (virtualization preserved) ──────────────────── */}
      <div className="sr-tbl-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="product_id"
          scroll={{ x: 1280 }}
          rowClassName={rowClassName}
          summaryCells={cols.totalRow ? summaryCells : undefined}
          summaryColSpan={cols.totalRow ? summaryColSpan : undefined}
          // ↑/↓ Home/End/PageUp/PageDown to move; Enter opens Stock
          // Movement for the active product; Esc clears the cursor.
          keyboardNav
          persistKey="stock-report"
          onRowEnter={(row) => row?.product_id && navigate(`/stock-movement/${row.product_id}`)}
        />
      </div>

      {/* ── Import Result Modal ── */}
      <Modal
        title={importResult?.failed ? 'Import Failed' : 'Import Complete'}
        open={importModal}
        onCancel={() => { setImportModal(false); setImportResult(null); }}
        footer={null}
        width={640}
      >
        {importResult && (
          <div style={{ padding: '8px 0' }}>
            {importResult.failed ? (
              <div style={{ background: 'var(--danger-bg)', borderRadius: 8, padding: 16, color: 'var(--danger)', fontWeight: 600 }}>
                <CloseCircleOutlined style={{ marginRight: 8 }} />{importResult.error}
              </div>
            ) : (
              <>
                <div className="sr-imp-grid">
                  <div className="sr-imp-stat ok">
                    <div className="sr-imp-stat-v">{importResult.imported || 0}</div>
                    <div className="sr-imp-stat-l"><CheckCircleOutlined /> Imported</div>
                  </div>
                  <div className="sr-imp-stat skipped">
                    <div className="sr-imp-stat-v">{importResult.skipped || 0}</div>
                    <div className="sr-imp-stat-l"><CloseCircleOutlined /> Not Imported</div>
                  </div>
                  <div className="sr-imp-stat total">
                    <div className="sr-imp-stat-v">{importResult.total || 0}</div>
                    <div className="sr-imp-stat-l">Total Rows</div>
                  </div>
                </div>

                {importResult.errors?.length > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-primary)' }}>
                        Not Imported Rows ({importResult.errors.length})
                      </span>
                      <button
                        className="sr-btn primary"
                        onClick={handleDownloadFailed}
                        disabled={downloadingFailed}
                      >
                        {downloadingFailed ? <Spin size="small" /> : <FileExcelOutlined />}
                        Download Failed Report
                      </button>
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--danger-bg)', position: 'sticky', top: 0 }}>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--danger)', fontWeight: 700, borderBottom: '1px solid var(--border)', width: 60 }}>Row</th>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--danger)', fontWeight: 700, borderBottom: '1px solid var(--border)' }}>Product</th>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--danger)', fontWeight: 700, borderBottom: '1px solid var(--border)' }}>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importResult.errors.map((e, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '5px 10px', color: 'var(--fg-tertiary)' }}>{e.row}</td>
                              <td style={{ padding: '5px 10px', color: 'var(--fg-primary)', fontWeight: 600 }}>
                                {e.rowData?.['Product Name *'] || e.rowData?.['Product Name'] || e.rowData?.barcode || '—'}
                              </td>
                              <td style={{ padding: '5px 10px', color: 'var(--danger)' }}>{e.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
