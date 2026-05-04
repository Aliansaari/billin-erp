// ── Fast & Slow Stock ─────────────────────────────────────────────────
//
// Inventory velocity report (file/component renamed from "Movers" so
// the code matches the user-facing label). The page is intentionally
// lean — but every operator wants different columns, so it's also
// fully customizable: a Popover behind the Customize button toggles
// individual columns and the KPI strip on/off, and preferences
// persist to localStorage so they carry across sessions.
//
// Sections (top to bottom):
//   1. Title strip — title + sub-stats + period chips + Top-N input
//                    + Customize / Refresh / Export.
//   2. KPI strip   — 4 action-oriented cards, optional via Customize.
//                    Total Stock Value · Capital at Risk · Reorder Now
//                    · Avg Cover Days.
//   3. Tabs strip  — All / Fast / Average / Slow / Dead with counts,
//                    plus search.
//   4. Table       — full-bleed; columns rendered dynamically from
//                    the visibility map.
//   5. Footer      — keyboard shortcuts + row count.
//
// Column-visibility design:
//   • COLUMNS array defines every available column with a default
//     visibility flag. `required: true` columns can never be hidden
//     (Product, Class, Action — the page would be useless without
//     them).
//   • visibleCols state is a Set of column ids; defaults from the
//     COLUMNS map are applied on first mount.
//   • localStorage key 'fss-prefs' persists { showKpi, visibleCols[] }.
//     "Reset to defaults" in the popover wipes the key and re-applies
//     the COLUMNS defaults.
//
// Period presets: 30 d · 90 d (default) · 180 d · This FY · All time
//   plus an always-visible RangePicker that doubles as Custom mode.
//
// Top-N picker: 20 · 30 · 50 (default) · 100 · always-visible custom
//   number input (any positive integer up to 10 000).
//
// Classification rules (server-side; documented in operationalReports
// Controller.stockVelocity):
//   fast    — qty_sold > 0 AND cover_days < 30
//   average — cover_days 30 – 90
//   slow    — cover_days ≥ 90  OR  (qty_sold == 0 AND last sale ≤ 180d)
//   dead    — qty_sold == 0 AND (no sale ever, OR last sale > 180d)

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Button, DatePicker, Popover, Checkbox, message, Tooltip } from 'antd';
import {
  ReloadOutlined, DownloadOutlined, SearchOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import './fast-slow-stock.css';

// ── Number / date formatters ─────────────────────────────────────────
const fmtAmt = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return '0';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};
const fmtDecimal = (v, dp = 1) => {
  const n = Number(v) || 0;
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const fmtRupees = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};
const fmtRupeesFull = (v) => `₹ ${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtCount = (v) => Number(v || 0).toLocaleString('en-IN');
const fmtDate  = (s) => s ? dayjs(s).format('DD MMM YYYY') : '—';

// ── Period presets ───────────────────────────────────────────────────
function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === '30d')   return { from: today.subtract(29, 'day'), to: today };
  if (key === '90d')   return { from: today.subtract(89, 'day'), to: today };
  if (key === '180d')  return { from: today.subtract(179, 'day'), to: today };
  if (key === 'this_fy' && fyStart && fyEnd) {
    return { from: dayjs(fyStart), to: dayjs(fyEnd) };
  }
  if (key === 'all_time') {
    return { from: dayjs('2000-01-01'), to: today };
  }
  return null;
}
const PRESETS = [
  { v: '30d',      l: '30 d' },
  { v: '90d',      l: '90 d' },
  { v: '180d',     l: '180 d' },
  { v: 'this_fy',  l: 'This FY' },
  { v: 'all_time', l: 'All time' },
];

const TOP_N_PRESETS = [20, 30, 50, 100];

const TABS = [
  { v: 'all',     l: 'All' },
  { v: 'fast',    l: 'Fast' },
  { v: 'average', l: 'Average' },
  { v: 'slow',    l: 'Slow' },
  { v: 'dead',    l: 'Dead' },
];

// ── Column registry ─────────────────────────────────────────────────
//
// Single source of truth for every column on the table. The order here
// is the rendering order. `required: true` columns are pinned visible
// (the user can't uncheck them in Customize). Each column owns its
// header label, alignment, default width, optional sortKey (clicking
// the header toggles), and a `render(row)` function that returns the
// cell content for that row.
//
// Width is a percentage of available table width. Browsers honour the
// proportions when columns are hidden / shown.
const COLUMNS = [
  { id: 'product',       label: 'Product',       group: 'Identity', default: true,  required: true,  align: 'left',  width: 18,
    render: (r) => <span className="mv-pname">{r.product_name}</span> },
  { id: 'category',      label: 'Category',      group: 'Identity', default: true,  align: 'left',  width: 10,
    render: (r) => <span className="mv-cat">{r.category_name || <span className="mv-dash">—</span>}</span> },
  { id: 'size',          label: 'Size',          group: 'Identity', default: true,  align: 'left',  width: 6,
    render: (r) => <span className="mv-size">{r.size || <span className="mv-dash">—</span>}</span> },
  { id: 'barcode',       label: 'Barcode',       group: 'Identity', default: true,  align: 'left',  width: 10,
    render: (r) => <span className="mv-barcode">{r.barcode || <span className="mv-dash">—</span>}</span> },
  { id: 'hsn',           label: 'HSN',           group: 'Identity', default: false, align: 'left',  width: 7,
    render: (r) => <span className="mv-cat">{r.hsn_code || <span className="mv-dash">—</span>}</span> },
  { id: 'article',       label: 'Article #',     group: 'Identity', default: false, align: 'left',  width: 9,
    render: (r) => <span className="mv-cat">{r.article_number || <span className="mv-dash">—</span>}</span> },
  { id: 'unit',          label: 'Unit',          group: 'Identity', default: false, align: 'left',  width: 5,
    render: (r) => <span className="mv-cat">{r.unit || 'PCS'}</span> },

  { id: 'stock',         label: 'Stock',         group: 'Inventory', default: true,  align: 'right', width: 6,  sortKey: 'stock',
    render: (r) => <span className="mv-num bold">{fmtAmt(r.current_stock)}</span> },
  { id: 'stock_value',   label: 'Stock Value',   group: 'Inventory', default: false, align: 'right', width: 9,
    render: (r) => <Tooltip title={fmtRupeesFull(r.stock_value)}><span className="mv-num">{fmtRupees(r.stock_value)}</span></Tooltip> },

  { id: 'sold',          label: 'Sold',          group: 'Sales',     default: true,  align: 'right', width: 6,  sortKey: 'sold',
    render: (r) => <span className={'mv-num' + (r.qty_sold === 0 ? ' dim' : '')}>{fmtAmt(r.qty_sold)}</span> },
  { id: 'revenue',       label: 'Revenue',       group: 'Sales',     default: false, align: 'right', width: 9,
    render: (r) => <Tooltip title={fmtRupeesFull(r.revenue)}><span className={'mv-num' + (r.revenue === 0 ? ' dim' : '')}>{fmtRupees(r.revenue)}</span></Tooltip> },
  { id: 'margin',        label: 'Margin %',      group: 'Sales',     default: false, align: 'right', width: 7,
    render: (r) => r.margin_pct == null
      ? <span className="mv-dash">—</span>
      : <span className="mv-num">{fmtDecimal(r.margin_pct, 1)}%</span> },

  { id: 'velocity',      label: 'Velocity',      group: 'Movement',  default: true,  align: 'right', width: 9,  sortKey: 'velocity',
    render: (r) => (
      <div className="mv-veloc">
        <span className={'qty' + (r.qty_sold === 0 ? ' dim' : '')}>
          {r.qty_sold === 0 ? '—' : fmtDecimal(r.velocity_per_month, r.velocity_per_month < 10 ? 1 : 0)}
        </span>
        <span className="unit">{r.qty_sold === 0 ? 'no sales' : 'units / month'}</span>
      </div>
    ) },
  { id: 'cover',         label: 'Cover',         group: 'Movement',  default: true,  align: 'right', width: 9,  sortKey: 'cover',
    render: (r) => {
      const hint = (() => {
        switch (r.cover_class) {
          case 'low':  return 'running out';
          case 'fast': return 'healthy';
          case 'avg':  return r.cover_days < 60 ? 'healthy' : 'overstocked';
          case 'slow': return r.qty_sold === 0 ? 'no movement' : 'overstocked';
          case 'dead': return 'since last sale';
          default:     return '';
        }
      })();
      const display = (() => {
        if (r.qty_sold === 0 && r.days_since_last_sale != null) return `${r.days_since_last_sale} d`;
        if (r.qty_sold === 0) return '—';
        if (r.cover_days == null) return '—';
        return `${Math.round(r.cover_days)} d`;
      })();
      return (
        <div className={`mv-cover mv-cover-${r.cover_class}`}>
          <span className="days">{display}</span>
          <span className="hint">{hint}</span>
        </div>
      );
    } },
  { id: 'last_sale',     label: 'Last Sale',     group: 'Movement',  default: false, align: 'right', width: 9,
    render: (r) => r.last_sale_date
      ? <Tooltip title={`${r.days_since_last_sale} days ago`}><span className="mv-num">{fmtDate(r.last_sale_date)}</span></Tooltip>
      : <span className="mv-dash">never sold</span> },
  { id: 'bills',         label: 'Bills',         group: 'Movement',  default: false, align: 'right', width: 5,
    render: (r) => <span className={'mv-num' + (r.bills_touched === 0 ? ' dim' : '')}>{r.bills_touched}</span> },

  { id: 'purchase_rate', label: 'Purchase ₹',    group: 'Pricing',   default: false, align: 'right', width: 8,
    render: (r) => <span className="mv-num">{fmtRupees(r.purchase_rate)}</span> },
  { id: 'sale_rate',     label: 'Sale ₹',        group: 'Pricing',   default: false, align: 'right', width: 8,
    render: (r) => <span className={'mv-num' + (r.sale_rate === 0 ? ' dim' : '')}>{fmtRupees(r.sale_rate)}</span> },
  { id: 'mrp',           label: 'MRP',           group: 'Pricing',   default: false, align: 'right', width: 7,
    render: (r) => <span className={'mv-num' + (r.mrp === 0 ? ' dim' : '')}>{fmtRupees(r.mrp)}</span> },

  { id: 'class',         label: 'Class',         group: 'Decision',  default: true,  required: true,  align: 'left',  width: 8,
    render: (r) => (
      <span className={`mv-pill mv-pill-${r.class}`}>
        <span className="dot"></span>
        {r.class === 'fast'    ? 'Fast'
          : r.class === 'average' ? 'Average'
          : r.class === 'slow'    ? 'Slow'
                                  : 'Dead'}
      </span>
    ) },
  { id: 'action',        label: 'Action',        group: 'Decision',  default: true,  required: true,  align: 'left',  width: 9, noHeader: true,
    render: (r, ctx) => {
      const label = r.class === 'fast'    ? (r.cover_class === 'low' ? 'Reorder now' : 'Reorder')
                  : r.class === 'average' ? 'View'
                  : r.class === 'slow'    ? 'Discount'
                  : r.class === 'dead'    ? 'Write-off'
                  :                          'View';
      return (
        <button
          className="mv-action"
          onClick={(e) => { e.stopPropagation(); ctx.onOpen(r); }}
        >
          {label}
        </button>
      );
    } },
];

// ── Persistence (localStorage) ──────────────────────────────────────
const PREFS_KEY = 'fss-prefs';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      showKpi: parsed.showKpi !== false,        // default ON
      visibleCols: Array.isArray(parsed.visibleCols) ? parsed.visibleCols : null,
    };
  } catch { return null; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}
function defaultVisibleCols() {
  return COLUMNS.filter((c) => c.default).map((c) => c.id);
}
function resolveInitialVisible() {
  const p = loadPrefs();
  if (!p?.visibleCols) return new Set(defaultVisibleCols());
  // Always-required columns can never be off, regardless of stored prefs.
  const fromStorage = new Set(p.visibleCols);
  for (const c of COLUMNS) if (c.required) fromStorage.add(c.id);
  return fromStorage;
}

export default function FastSlowStock() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { fyStart, fyEnd } = useFinancialYear();

  // ── State ────────────────────────────────────────────────────────
  const [fromDate,  setFromDate]  = useState(() => searchParams.get('from_date') || '');
  const [toDate,    setToDate]    = useState(() => searchParams.get('to_date')   || '');
  const [presetKey, setPresetKey] = useState(() => searchParams.get('preset') || '90d');

  const [topN,      setTopN]      = useState(() => parseInt(searchParams.get('limit'), 10) || 50);
  const [topNDraft, setTopNDraft] = useState(() => String(topN));

  const [klass,    setKlass]    = useState(() => searchParams.get('class') || 'all');
  const [search,   setSearch]   = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort,     setSort]     = useState(() => searchParams.get('sort') || 'velocity_desc');

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);

  // Customisation — KPI toggle + visible columns.
  const initialPrefs = loadPrefs();
  const [showKpi, setShowKpi] = useState(initialPrefs?.showKpi !== false);
  const [visibleCols, setVisibleCols] = useState(() => resolveInitialVisible());

  // Persist whenever either preference changes.
  useEffect(() => {
    savePrefs({ showKpi, visibleCols: [...visibleCols] });
  }, [showKpi, visibleCols]);

  // Debounce search.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Default range on first mount.
  useEffect(() => {
    if (!fromDate && !toDate) {
      const r = presetRange('90d', fyStart, fyEnd);
      if (r) {
        setFromDate(r.from.format('YYYY-MM-DD'));
        setToDate(r.to.format('YYYY-MM-DD'));
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // URL sync.
  useEffect(() => {
    const next = {};
    if (fromDate)  next.from_date = fromDate;
    if (toDate)    next.to_date   = toDate;
    if (presetKey) next.preset    = presetKey;
    if (klass !== 'all')           next.class = klass;
    if (topN  !== 50)              next.limit = String(topN);
    if (sort  !== 'velocity_desc') next.sort = sort;
    setSearchParams(next, { replace: true });
  }, [fromDate, toDate, presetKey, klass, topN, sort, setSearchParams]);

  // Fetch.
  const fetcher = useCallback(async () => {
    if (!fromDate || !toDate) return;
    setLoading(true);
    try {
      const r = await reportAPI.stockVelocity({
        from_date: fromDate,
        to_date:   toDate,
        class:     klass,
        limit:     topN,
        sort,
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      });
      setData(r.data);
      setActiveIdx(0);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to load Fast & Slow Stock report');
    }
    setLoading(false);
  }, [fromDate, toDate, klass, topN, sort, debouncedSearch]);
  useEffect(() => { fetcher(); }, [fetcher]);

  const applyPreset = useCallback((key) => {
    const r = presetRange(key, fyStart, fyEnd);
    if (!r) return;
    setFromDate(r.from.format('YYYY-MM-DD'));
    setToDate(r.to.format('YYYY-MM-DD'));
    setPresetKey(key);
  }, [fyStart, fyEnd]);

  useEffect(() => { setTopNDraft(String(topN)); }, [topN]);
  const applyTopN = useCallback((n) => { setTopN(n); }, []);
  const commitTopNDraft = useCallback(() => {
    const n = parseInt(topNDraft, 10);
    if (Number.isFinite(n) && n > 0 && n <= 10000) {
      if (n !== topN) setTopN(n);
    } else {
      setTopNDraft(String(topN));
    }
  }, [topNDraft, topN]);

  // Column-visibility helpers.
  const toggleCol = useCallback((colId) => {
    const col = COLUMNS.find((c) => c.id === colId);
    if (!col || col.required) return;       // can't hide required columns
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId); else next.add(colId);
      return next;
    });
  }, []);
  const resetCols = useCallback(() => {
    setVisibleCols(new Set(defaultVisibleCols()));
    setShowKpi(true);
  }, []);
  const visibleColumnList = useMemo(
    () => COLUMNS.filter((c) => visibleCols.has(c.id)),
    [visibleCols],
  );

  // Keyboard nav.
  useEffect(() => {
    if (!data?.rows?.length) return;
    const rows = data.rows;
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toUpperCase();
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
                   || e.target?.isContentEditable
                   || e.target?.closest?.('.ant-select, .ant-picker, .ant-popover');
      if (inField) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); setActiveIdx((i) => Math.min(rows.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Home') {
        e.preventDefault(); setActiveIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault(); setActiveIdx(rows.length - 1);
      } else if (e.key === 'Enter') {
        const r = rows[activeIdx];
        if (r) navigate(`/stock-movement/${r.product_id}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, activeIdx, navigate]);

  // CSV export — exports ALL columns regardless of UI visibility (the
  // sheet is the user's archive; selective columns belong on screen).
  const handleExport = useCallback(() => {
    if (!data || !data.rows.length) return;
    const header = [
      'Product', 'Category', 'Size', 'Barcode', 'HSN', 'Article', 'Unit',
      'Stock Qty', 'Stock Value', 'Sold', 'Revenue', 'Margin %',
      'Velocity (units/mo)', 'Cover (days)', 'Last Sale', 'Days Since Last Sale',
      'Bills', 'Purchase Rate', 'Sale Rate', 'MRP', 'Class',
    ];
    const lines = data.rows.map((r) => [
      r.product_name, r.category_name || '', r.size || '', r.barcode || '',
      r.hsn_code || '', r.article_number || '', r.unit || '',
      r.current_stock, r.stock_value, r.qty_sold, r.revenue,
      r.margin_pct == null ? '' : r.margin_pct,
      r.velocity_per_month, r.cover_days == null ? '' : r.cover_days,
      r.last_sale_date || '', r.days_since_last_sale == null ? '' : r.days_since_last_sale,
      r.bills_touched, r.purchase_rate, r.sale_rate, r.mrp, r.class,
    ]);
    const csv = [header, ...lines]
      .map((cols) => cols.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fast-slow-stock-${fromDate}-to-${toDate}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  }, [data, fromDate, toDate]);

  const totals = data?.totals;
  const periodLabel = useMemo(() => {
    if (!fromDate || !toDate) return '';
    const f = dayjs(fromDate), t = dayjs(toDate);
    if (presetKey === 'all_time') return 'All time';
    if (presetKey === 'this_fy')  return `FY ${f.format('YYYY')} – ${t.format('YYYY')}`;
    if (presetKey === '30d')      return 'Last 30 days';
    if (presetKey === '90d')      return 'Last 90 days';
    if (presetKey === '180d')     return 'Last 180 days';
    return `${f.format('D MMM YYYY')} — ${t.format('D MMM YYYY')}`;
  }, [fromDate, toDate, presetKey]);

  // Shared `.cols-menu` markup — see styles/global.css. Required
  // columns get the `.fixed` dimmer + a "Always on" pin. Reset link
  // sits in the last group's header.
  const customizeContent = (
    <div className="cols-menu">
      <div className="grp">
        <div className="mh">Page Sections</div>
        <label className="opt">
          <input
            type="checkbox"
            checked={showKpi}
            onChange={(e) => setShowKpi(e.target.checked)}
          />
          <span>KPI cards (top)</span>
        </label>
      </div>
      {(() => {
        const groups = {};
        for (const c of COLUMNS) {
          if (!groups[c.group]) groups[c.group] = [];
          groups[c.group].push(c);
        }
        const entries = Object.entries(groups);
        return entries.map(([group, cols], gIdx) => (
          <div key={group} className="grp">
            <div className="gh">
              <span>{group}</span>
              {gIdx === entries.length - 1 && (
                <button className="gh-reset" type="button" onClick={resetCols}>Reset</button>
              )}
            </div>
            {cols.map((c) => (
              <label key={c.id} className={`opt${c.required ? ' fixed' : ''}`}>
                <input
                  type="checkbox"
                  checked={visibleCols.has(c.id)}
                  disabled={c.required}
                  onChange={() => toggleCol(c.id)}
                />
                <span>{c.label}</span>
                {c.required && <span className="pin">Always on</span>}
              </label>
            ))}
          </div>
        ));
      })()}
    </div>
  );

  return (
    <div className="mv-page">

      {/* ─── 1. Title strip — uses the shared .rpt-* classes from
              global.css so the page reads the same as Cash Flow,
              Fund Flow, Bills Outstanding, etc. ─────────────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Fast &amp; Slow Stock</h1>
          <div className="rpt-sub">
            {periodLabel}
            {totals && <>
              <span className="sep">·</span>
              <b>{fmtCount(totals.products_active)}</b> SKUs ·
              {' '}<span className="stat-fast">{fmtCount(totals.products_fast)} fast</span>
              <span className="sep">·</span>
              <span className="stat-slow">{fmtCount(totals.products_slow)} slow</span>
              <span className="sep">·</span>
              <span className="stat-dead">
                {fmtCount(totals.products_dead)} dead ({fmtRupees(totals.stock_value_dead)} at risk)
              </span>
            </>}
          </div>
        </div>

        <div className="rpt-hd-ctrl">
          <div className="rpt-period">
            {PRESETS.map((p) => (
              <button key={p.v} className={presetKey === p.v ? 'on' : ''} onClick={() => applyPreset(p.v)}>
                {p.l}
              </button>
            ))}
          </div>
          <DatePicker.RangePicker
            className="rpt-date"
            value={[fromDate ? dayjs(fromDate) : null, toDate ? dayjs(toDate) : null]}
            onChange={(vals) => {
              if (!vals) return;
              setFromDate(vals[0].format('YYYY-MM-DD'));
              setToDate(vals[1].format('YYYY-MM-DD'));
              setPresetKey('custom');
            }}
            format="DD MMM YYYY"
            allowClear={false}
          />

          {/* Top-N picker — page-specific control, kept as .mv-topn since
              the rpt-* family doesn't have a "preset chips + free input"
              variant. Visually shaped to mirror .rpt-period proportions. */}
          <div className="mv-topn">
            <span className="mv-topn-label">Top</span>
            {TOP_N_PRESETS.map((n) => (
              <button key={n} className={topN === n ? 'on' : ''} onClick={() => applyTopN(n)}>{n}</button>
            ))}
            <input
              className="mv-topn-input"
              type="number"
              min={1}
              max={10000}
              value={topNDraft}
              onChange={(e) => setTopNDraft(e.target.value)}
              onBlur={commitTopNDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { commitTopNDraft(); e.target.blur(); }
                if (e.key === 'Escape') { setTopNDraft(String(topN)); e.target.blur(); }
              }}
              title="Type a custom Top-N (e.g. 250)"
              aria-label="Top-N rows"
            />
          </div>

          {/* Customize popover — column toggles + KPI strip toggle.
              trigger='click' so the popover stays open while the user
              ticks multiple checkboxes in one go. */}
          <Popover
            trigger="click"
            placement="bottomRight"
            content={customizeContent}
            overlayClassName="mv-customize-popover"
          >
            <Button className="rpt-btn" icon={<SettingOutlined />}>
              Customize
            </Button>
          </Popover>
          <Button className="rpt-btn" icon={<ReloadOutlined />} loading={loading} onClick={fetcher}>
            Refresh
          </Button>
          <Button className="rpt-btn" type="primary" icon={<DownloadOutlined />} onClick={handleExport}>
            Export
          </Button>
        </div>
      </header>

      {/* ─── 2. KPI strip — uses .rpt-kpis + .rpt-kpi from global.css.
              The tone-* modifiers (accent / warning / danger / success)
              give each card the right gradient + value colour. ──── */}
      {showKpi && totals && (
        <section className="rpt-kpis">
          <div className="rpt-kpi tone-accent">
            <div className="rpt-kpi-k">Total Stock Value</div>
            <div className="rpt-kpi-v">{fmtRupees(totals.stock_value_total)}</div>
            <div className="rpt-kpi-sub"><b>{fmtCount(totals.products_active)}</b> SKUs</div>
          </div>
          <div className="rpt-kpi tone-warning">
            <div className="rpt-kpi-k">Capital at Risk</div>
            <div className="rpt-kpi-v">{fmtRupees(totals.capital_at_risk)}</div>
            <div className="rpt-kpi-sub">slow + dead · <b>{fmtCount(totals.products_slow + totals.products_dead)}</b> SKUs</div>
          </div>
          <div className="rpt-kpi tone-danger">
            <div className="rpt-kpi-k">Reorder Now</div>
            <div className="rpt-kpi-v">{fmtCount(totals.reorder_count)}</div>
            <div className="rpt-kpi-sub">cover &lt; 7 days · stockout risk</div>
          </div>
          <div className="rpt-kpi tone-success">
            <div className="rpt-kpi-k">Avg Cover Days</div>
            <div className="rpt-kpi-v">
              {totals.avg_cover_days == null ? '—' : `${Math.round(totals.avg_cover_days)} d`}
            </div>
            <div className="rpt-kpi-sub">overall inventory health</div>
          </div>
        </section>
      )}

      {/* ─── 3. Tabs strip ───────────────────────────────────────── */}
      <nav className="mv-tabs">
        {TABS.map((t) => (
          <button key={t.v} className={klass === t.v ? 'on' : ''} onClick={() => setKlass(t.v)}>
            {t.l}
            <span className="count">
              {!totals ? '–'
                : t.v === 'all'     ? fmtCount(totals.products_active)
                : t.v === 'fast'    ? fmtCount(totals.products_fast)
                : t.v === 'average' ? fmtCount(totals.products_average)
                : t.v === 'slow'    ? fmtCount(totals.products_slow)
                                    : fmtCount(totals.products_dead)}
            </span>
          </button>
        ))}
        <span className="grow"></span>
        <div className="mv-search">
          <SearchOutlined style={{ color: 'var(--fg-tertiary)' }} />
          <input
            placeholder="Search by name or barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </nav>

      {/* ─── 4. Table ────────────────────────────────────────────── */}
      <div className="mv-tbl-wrap">
        <table className="mv-tbl">
          <colgroup>
            {visibleColumnList.map((c) => (
              <col key={c.id} style={{ width: `${c.width}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {visibleColumnList.map((c) => {
                const sortable = !!c.sortKey;
                const sortAsc  = sort === `${c.sortKey}_asc`;
                const sortDesc = sort === `${c.sortKey}_desc`;
                const onSort = sortable
                  ? () => setSort(sortDesc ? `${c.sortKey}_asc` : `${c.sortKey}_desc`)
                  : undefined;
                return (
                  <th
                    key={c.id}
                    className={c.align === 'left' ? 'l' : ''}
                    onClick={onSort}
                    style={sortable ? { cursor: 'pointer' } : undefined}
                  >
                    {c.noHeader ? '' : c.label}
                    {sortable && (sortDesc ? ' ↓' : sortAsc ? ' ↑' : '')}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!data ? (
              <tr><td colSpan={visibleColumnList.length} className="mv-empty">{loading ? 'Loading…' : 'Pick a period.'}</td></tr>
            ) : data.rows.length === 0 ? (
              <tr><td colSpan={visibleColumnList.length} className="mv-empty">
                No products in this slice. Try a different tab or widen the period.
              </td></tr>
            ) : data.rows.map((r, i) => (
              <Row
                key={r.product_id}
                row={r}
                cols={visibleColumnList}
                active={i === activeIdx}
                onHover={() => setActiveIdx(i)}
                onOpen={() => navigate(`/stock-movement/${r.product_id}`)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── 5. Footer ───────────────────────────────────────────── */}
      <footer className="mv-foot">
        <span>
          Showing <b>{data?.rows?.length || 0}</b>
          {' '}of <b>{data?.filtered_count || 0}</b>
          {data && totals && data.filtered_count !== totals.products_active && (
            <> ({fmtCount(totals.products_active)} total)</>
          )}
          {' '}SKUs
        </span>
        <span className="mv-foot-keys">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open product</span>
          <span><kbd>Esc</kbd> Back</span>
        </span>
      </footer>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────
//
// Renders cells dynamically from the cols array. The cols array is
// already filtered to visible columns by the parent — Row doesn't need
// to know about visibility state.
function Row({ row, cols, active, onHover, onOpen }) {
  const ctx = useMemo(() => ({ onOpen: () => onOpen() }), [onOpen]);
  return (
    <tr
      className={'mv-row' + (active ? ' mv-row-active' : '')}
      onMouseEnter={onHover}
      onClick={onOpen}
    >
      {cols.map((c) => (
        <td key={c.id} className={c.align === 'left' ? 'l' : ''}>
          {c.render(row, ctx)}
        </td>
      ))}
    </tr>
  );
}
