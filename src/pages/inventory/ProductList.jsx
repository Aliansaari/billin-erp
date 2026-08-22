import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Input, Button, Form, InputNumber, Select, Switch,
  Row, Col, Divider, message, DatePicker, Dropdown, Tooltip,
} from 'antd';
import { BarcodeOutlined, SettingOutlined, EditOutlined, ArrowRightOutlined, TagsOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { productAPI, productColorAPI, categoryAPI, dataAPI, settingsAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import ProductColorsPanel from '../../components/ProductColorsPanel';
import EntityFormModal from '../../components/EntityFormModal';
import { useSingleColorEnabled, useMultiColorEnabled } from '../../hooks/useSystemSettings';

dayjs.extend(relativeTime);
import '../../styles/editorial-product-list.css';

/*
 * ProductList — virtualized rewrite. Editorial visual treatment is
 * preserved through Antd column renders: category dots, health pills,
 * margin chips, runway display, monospace HSN/barcode. Click-cycle
 * sort headers replaced by Antd's native column-sort arrow (more
 * accessible). Status chips reduced to All / In Stock / Low / Out
 * (Top Selling and Dead Stock will return when server-side support
 * for those filters lands). Multi-category filter replaced with a
 * single-category Select for now.
 */

const LS_COLS = 'ed-products-cols-v2';

const COL_DEFS = [
  { key: 'sr',    label: 'Number',                default: true  },
  { key: 'cat',   label: 'Category',              default: true  },
  { key: 'prod',  label: 'Product',               default: true,  fixed: true },
  { key: 'hsn',   label: 'HSN Code',              default: false },
  { key: 'gst',   label: 'GST %',                 default: false },
  { key: 'bc',    label: 'Barcode',               default: false },
  { key: 'stk',   label: 'Stock (On Hand)',       default: true  },
  { key: 'tpur',  label: 'Total Stock Purchased', default: true  },
  { key: 'tsale', label: 'Total Stock Sold',      default: true  },
  { key: 'pur',   label: 'Purchase Rate',         default: false },
  { key: 'sale',  label: 'Sale Rate',             default: true  },
  { key: 'mgn',   label: 'Margin',                default: true  },
  { key: 'hlt',   label: 'Health',                default: true  },
  { key: 'run',   label: 'Last Sold',             default: true  },
  { key: 'val',   label: 'Stock Value',           default: true  },
];
// Toggleable sections (page-level, not data columns).
const SEC_DEFS = [
  { key: 'hero',     label: 'KPI Cards' },
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
const DEFAULT_COLS = {
  ...Object.fromEntries(COL_DEFS.map(c => [c.key, c.default])),
  hero: true, totalRow: true,
};

function loadPrefs(key, defaults) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch { return { ...defaults }; }
}

const fmtMoney = (v) => parseFloat(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtQty   = (v) => parseFloat(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function healthOf(product) {
  const stock = parseFloat(product.current_stock || 0);
  const min   = parseFloat(product.minimum_stock_level || 0);
  if (stock === 0) return { kind: 'out',  label: 'Out of stock' };
  if (stock < 0)   return { kind: 'out',  label: 'Negative' };
  if (min > 0 && stock <= min) return { kind: 'low', label: 'Low' };
  return { kind: 'ok', label: 'Healthy' };
}

// True margin % = (sale - cost) / sale × 100. Cost basis is mode-aware
// via display_cost (variant: purchase_rate, single: weighted_avg_cost,
// single+batch: batch-weighted average) — falls back to purchase_rate
// for older/cached rows. Denominator is the sale price (not cost), so
// the chip reads as "what fraction of the sale we keep" rather than
// markup over cost.
function marginPct(p) {
  const cost = parseFloat(p.display_cost ?? p.purchase_rate ?? 0);
  const sale = parseFloat(p.sale_rate || 0);
  if (!sale || !cost) return null;
  return ((sale - cost) / sale) * 100;
}

// Stable category dot palette — same product = same color across sessions.
const CAT_PALETTE = [
  '#7A9660', '#B1472F', '#4F6A7A', '#B8923C', '#7F5AA3',
  '#6D5F4E', '#3F5A4A', '#CA7537', '#8E4F2E', '#55503F',
];
function catColor(name) {
  if (!name) return 'var(--ed-fg-3)';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CAT_PALETTE[h % CAT_PALETTE.length];
}

export default function ProductList() {
  const navigate = useNavigate();

  /* ── filters ── */
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState({
    search: '',
    category_id: null,
    stock_status: null,
    include_stats: 'true',
  });
  // Debounced search → server.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 220);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [categories, setCategories] = useState([]);
  // Global batch-tracking toggle. Cached on mount so the form can hide the
  // "Track by batch" field cleanly when the feature is off — same condition
  // the bill forms and reports apply.
  const [batchTrackingEnabled, setBatchTrackingEnabled] = useState(false);

  // Audit GST-H5 — canonical GSTN UQC list for the UoM dropdown. Loaded
  // once on mount from /api/products/uqc-codes; falls back to the
  // common-units list if the fetch fails so the form stays usable.
  const [uqcList, setUqcList] = useState([
    { code: 'PCS', label: 'PIECES' },
    { code: 'KGS', label: 'KILOGRAMS' },
    { code: 'MTR', label: 'METRES' },
    { code: 'LTR', label: 'LITRES' },
    { code: 'BOX', label: 'BOX' },
    { code: 'DOZ', label: 'DOZENS' },
    { code: 'NOS', label: 'NUMBERS' },
    { code: 'OTH', label: 'OTHERS' },
  ]);
  useEffect(() => {
    productAPI.getUqcCodes()
      .then(({ data }) => Array.isArray(data?.data) && data.data.length && setUqcList(data.data))
      .catch(() => {});
  }, []);

  /* ── data layer ── */
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => productAPI.getAll(params),
    filters,
    chunkSize: 500,
  });

  /* ── Selection model — cursor + multi-select.
     Cursor is the "active" SKU for F-key actions in the bottom strip.
     Plain click moves cursor; double-click opens Stock Movement
     (the page's primary row action). Shift / Ctrl click extend or
     toggle the selection without navigating. */
  const sel = useListSelection({ totalCount, rows });
  const activeRow      = sel.activeRow;
  const selectionCount = sel.selectionCount;
  const isMulti        = selectionCount > 1;
  const single         = !isMulti ? activeRow : null;

  /* ── columns / sections ── */
  const [cols, setCols] = useState(() => loadPrefs(LS_COLS, DEFAULT_COLS));
  useEffect(() => {
    try { localStorage.setItem(LS_COLS, JSON.stringify(cols)); } catch {}
  }, [cols]);
  const visibleColCount = COL_DEFS.filter(c => cols[c.key] || c.fixed).length;

  /* ── form modal ── */
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [form] = Form.useForm();

  // Sidebar deep-link — /products?new=1 lands here from the "New
  // Product" entry. Open the modal every time the param appears, then
  // strip it. Dep on searchParams so revisiting the URL while already
  // on /products also fires (without it, "New Product" while already
  // on /products is a no-op).
  //
  // Open synchronously (no setTimeout). A previous version deferred the
  // open via setTimeout + clearTimeout cleanup — but stripping the
  // search param re-fires the effect, the cleanup runs, and the
  // pending timeout is cancelled before the modal renders. Doing it
  // synchronously matches PartyListView's working pattern.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setEditing(null);
      form.resetFields();
      form.setFieldsValue({ opening_stock_date: dayjs() });
      setColorState({ color_mode: 'none', color_label: '', colors: [] });
      setFormVisible(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams]);

  // Color section state — kept outside the AntD form because the colors
  // panel is a custom controlled component (mode picker + dynamic list)
  // that doesn't fit the Form.Item shape cleanly.
  const [colorState, setColorState] = useState({ color_mode: 'none', color_label: '', colors: [] });
  const singleColorEnabled = useSingleColorEnabled();
  const multiColorEnabled  = useMultiColorEnabled();

  // F4 = Find target — focused by the strip.
  const searchInputRef = useRef(null);

  useEffect(() => { loadCategories(); loadBatchSetting(); }, []);

  const loadCategories = async () => {
    try { const { data } = await categoryAPI.getAllFlat(); setCategories(data || []); }
    catch { /* ignore */ }
  };

  const loadBatchSetting = async () => {
    try {
      const { data } = await settingsAPI.getSystem();
      const s = (data && data.data) ? data.data : data;
      setBatchTrackingEnabled(!!s?.batch_tracking_enabled);
    } catch { /* best effort — feature stays hidden if settings unavailable */ }
  };

  /* ── form helpers ── */
  const marginChanged = () => {
    const pr = form.getFieldValue('purchase_rate') || 0;
    const mg = form.getFieldValue('margin_percentage') || 0;
    form.setFieldsValue({ sale_rate: +(pr * (1 + mg / 100)).toFixed(2) });
  };

  const openForm = async (product = null) => {
    setEditing(product);
    if (product) {
      let openingQty = 0, openingRate = product.purchase_rate, openingDate = dayjs();
      try {
        const { data: movements } = await productAPI.getStockMovement(product.product_id);
        const opening = (movements || []).find(m => m.transaction_type === 'Opening Stock');
        if (opening) {
          openingQty  = parseFloat(opening.quantity_in || 0);
          openingRate = parseFloat(opening.rate || product.purchase_rate || 0);
          openingDate = dayjs(opening.transaction_date);
        }
      } catch { /* best effort */ }
      form.setFieldsValue({
        ...product,
        category_id: product.category_id,
        opening_stock: openingQty || null,
        opening_stock_rate: openingRate,
        opening_stock_date: openingDate,
      });
      // Reset the color section to whatever the product carried.
      // ProductColorsPanel will hydrate the multi-color list from the
      // server when productId is supplied AND mode is 'multi'.
      setColorState({
        color_mode:  product.color_mode || 'none',
        color_label: product.color_label || '',
        colors:      [],
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ opening_stock_date: dayjs() });
      setColorState({ color_mode: 'none', color_label: '', colors: [] });
    }
    setFormVisible(true);
  };

  const handleSubmit = async () => {
    setFormLoading(true);
    try {
      const values = await form.validateFields();
      if (values.opening_stock_date) {
        values.opening_stock_date = dayjs(values.opening_stock_date).format('YYYY-MM-DD');
      }
      // Stamp color_mode + color_label onto the product payload so the
      // controller's whitelist persists them. The colors[] list is sent
      // separately to the bulk endpoint after the product save returns
      // (we need the product_id, which only exists post-create).
      values.color_mode  = colorState.color_mode || 'none';
      values.color_label = colorState.color_mode === 'single' ? (colorState.color_label || null) : null;

      let savedProductId;
      if (editing) {
        await productAPI.update(editing.product_id, values);
        savedProductId = editing.product_id;
        message.success('Product updated');
      } else {
        const { data } = await productAPI.create(values);
        savedProductId = data.product_id || data.product?.product_id;
        // { existing: true, product } means the controller matched an
        // existing SKU and created nothing — don't report it as an add.
        if (data.existing) {
          message.warning(
            `"${data.product?.product_name}" already exists in this category (Barcode: ${data.product?.barcode || '—'}). ` +
            'Nothing was created — change the category, size, article number or pack size to add a separate SKU.',
          );
        } else {
          message.success(`Product added — Barcode: ${data.barcode || data.product?.barcode}`);
        }
      }

      // Sync the color list when the product is in multi-color mode.
      // Bulk endpoint diffs against the server-side state and applies
      // adds / renames / threshold edits / soft-or-hard deletes per
      // the lifecycle rules in the controller.
      if (savedProductId && colorState.color_mode === 'multi') {
        try {
          await productColorAPI.bulkReplace(
            savedProductId,
            (colorState.colors || []).map((c) => ({
              color_id:        c.color_id || undefined,
              color_name:      c.color_name,
              opening_stock:   c.opening_stock || 0,
              low_stock_alert: c.low_stock_alert,
            })),
          );
        } catch (e) {
          message.error(e.response?.data?.error || 'Colors save failed.');
          // Continue — the product itself saved; the colors panel can
          // be re-saved by reopening the form.
        }
      }
      setFormVisible(false);
      refresh();
    } catch (e) { message.error(e.response?.data?.error || 'Failed to save'); }
    setFormLoading(false);
  };

  const handleExport = async () => {
    try {
      const params = {};
      if (filters.search) params.search = filters.search;
      if (filters.category_id) params.category_id = filters.category_id;
      if (filters.stock_status) params.stock_status = filters.stock_status;
      const { data } = await dataAPI.exportExcel('products', params);
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `products_export_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  /* ── KPI values from server summary ── */
  const stockValue = parseFloat(summary?.total_stock_value || 0);
  const lowCount   = summary?.low_count   || 0;
  const outCount   = summary?.out_count   || 0;
  const inCount    = summary?.in_count    || 0;
  const topCount   = summary?.top_count   || 0;
  const deadCount  = summary?.dead_count  || 0;
  const totalSku   = summary?.total_count || totalCount;

  /* ── columns ── */
  const columns = [
    cols.sr && {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => <span className="sr-n">{String(idx + 1).padStart(2, '0')}</span>,
    },
    cols.cat && {
      key: 'cat', title: 'Category', width: 150,
      render: (_, p) => {
        const catName = p.Category?.category_name || categories.find(c => c.category_id === p.category_id)?.category_name || '—';
        return (
          <span className="cat-pill">
            <span className="cat-dot" style={{ background: catColor(catName) }} />
            {catName}
          </span>
        );
      },
    },
    {
      key: 'prod', title: 'Product', dataIndex: 'product_name', width: 240, fixed: 'left',
      render: (v, p) => (
        <span>
          <span className="p-name">{v}</span>
          {p.size_value && <span className="p-var" style={{ marginLeft: 6 }}>{p.size_value}</span>}
        </span>
      ),
    },
    cols.hsn && {
      key: 'hsn', title: 'HSN', dataIndex: 'hsn_code', width: 100,
      render: (v) => <span className="mono">{v || '—'}</span>,
    },
    cols.gst && {
      key: 'gst', title: 'GST %', dataIndex: 'gst_rate', width: 80, align: 'right',
      render: (v) => <span className="gst-pct">{v != null ? `${v}%` : '—'}</span>,
    },
    cols.bc && {
      key: 'bc', title: 'Barcode', dataIndex: 'barcode', width: 130,
      render: (v) => <span className="bc">{v || '—'}</span>,
    },
    cols.stk && {
      key: 'stk', title: 'Stock', dataIndex: 'current_stock', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.current_stock || 0) - parseFloat(b.current_stock || 0),
      render: (v) => (
        <span className={`qty-m${parseFloat(v || 0) === 0 ? ' zero' : ''}`}>{fmtQty(v)}</span>
      ),
    },
    cols.tpur && {
      key: 'tpur', title: 'Total Pur.', dataIndex: 'total_purchased', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.total_purchased || 0) - parseFloat(b.total_purchased || 0),
      render: (v) => v != null
        ? <span className="qty-m">{fmtQty(v)}</span>
        : <span className="qty-m">—</span>,
    },
    cols.tsale && {
      key: 'tsale', title: 'Total Sold', dataIndex: 'total_sold', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.total_sold || 0) - parseFloat(b.total_sold || 0),
      render: (v) => v != null
        ? <span className="qty-m">{fmtQty(v)}</span>
        : <span className="qty-m">—</span>,
    },
    cols.pur && {
      key: 'pur', title: 'Purchase', width: 110, align: 'right',
      // Mode-aware cost basis (display_cost). For variant products
      // display_cost === purchase_rate, so this is a no-op there. For
      // single-mode it reads weighted_avg_cost; for single+batch it
      // reads the batch-weighted average. Sort + render use the same
      // value so the column is internally consistent.
      sorter: (a, b) =>
        parseFloat(a.display_cost ?? a.purchase_rate ?? 0)
        - parseFloat(b.display_cost ?? b.purchase_rate ?? 0),
      render: (_, p) => {
        const v = parseFloat(p.display_cost ?? p.purchase_rate ?? 0);
        return <span className="mon-m"><span className="rs">₹</span>{fmtMoney(v)}</span>;
      },
    },
    cols.sale && {
      key: 'sale', title: 'Sale', dataIndex: 'sale_rate', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.sale_rate || 0) - parseFloat(b.sale_rate || 0),
      render: (v) => <span className="mon-m"><span className="rs">₹</span>{fmtMoney(v)}</span>,
    },
    cols.mgn && {
      key: 'mgn', title: 'Margin', width: 90, align: 'right',
      sorter: (a, b) => (marginPct(a) ?? -Infinity) - (marginPct(b) ?? -Infinity),
      render: (_, p) => {
        const m = marginPct(p);
        return m != null
          ? <span className="mg-chip">{m >= 0 ? '+' : ''}{m.toFixed(0)}%</span>
          : <span className="mg-chip muted">—</span>;
      },
    },
    cols.hlt && {
      key: 'hlt', title: 'Health', width: 110,
      sorter: (a, b) => ({ out: 0, low: 1, ok: 2 }[healthOf(a).kind] ?? 3) - ({ out: 0, low: 1, ok: 2 }[healthOf(b).kind] ?? 3),
      render: (_, p) => {
        const h = healthOf(p);
        return <span className={`health ${h.kind}`}><span className="dot" />{h.label}</span>;
      },
    },
    cols.run && {
      key: 'run', title: 'Last Sold', dataIndex: 'last_sold_at', width: 140,
      sorter: (a, b) => new Date(a.last_sold_at || 0) - new Date(b.last_sold_at || 0),
      render: (v) => {
        if (!v) return <span><span className="rw-m none">never sold</span><span className="rw-s">no sales yet</span></span>;
        const days = dayjs().diff(dayjs(v), 'day');
        const cls = days > 60 ? 'urgent' : days > 14 ? 'soon' : 'calm';
        const label = days === 0 ? 'today'
                    : days === 1 ? 'yesterday'
                    : days < 30  ? `${days}d ago`
                    : days < 365 ? `${Math.round(days/30)}mo ago`
                    :              `${Math.round(days/365)}y ago`;
        return (
          <span>
            <span className={`rw-m ${cls}`}>{label}</span>
            <span className="rw-s" style={{ marginLeft: 6 }}>on {dayjs(v).format('DD MMM YYYY')}</span>
          </span>
        );
      },
    },
    cols.val && {
      key: 'val', title: 'Stock Value', width: 130, align: 'right',
      // Mode-aware: variant → stock × purchase_rate; single → stock ×
      // weighted_avg_cost; single+batch → SUM(qty × batch.rate). The
      // server attaches display_stock_value via attachDisplayCost; the
      // legacy fallback applies only to rows from older/cached payloads.
      sorter: (a, b) => {
        const av = parseFloat(a.display_stock_value ?? (parseFloat(a.current_stock || 0) * parseFloat(a.purchase_rate || 0)));
        const bv = parseFloat(b.display_stock_value ?? (parseFloat(b.current_stock || 0) * parseFloat(b.purchase_rate || 0)));
        return av - bv;
      },
      render: (_, p) => {
        const v = parseFloat(p.display_stock_value ?? (parseFloat(p.current_stock || 0) * parseFloat(p.purchase_rate || 0)));
        return v > 0
          ? <span className="mon-m"><span className="rs">₹</span>{fmtMoney(v)}</span>
          : <span className="mon-m zero">—</span>;
      },
    },
    // (Per-row actions column removed — Stock Movement + Edit moved
    // to the bottom ActionStrip and operate on the cursored row.)
  ].filter(Boolean);

  /* ── Total strip ── */
  const SUMMABLE_KEYS = new Set(['val']);
  const firstAggIdx = (() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  })();
  const summaryCells = (col, idx) => {
    if (idx === 0) return totalCount > 0 ? `Total (${totalCount} SKU${totalCount === 1 ? '' : 's'})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;
    if (col.key === 'val') {
      return <strong><span className="rs">₹</span>{fmtMoney(stockValue)}</strong>;
    }
    return null;
  };
  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  /* ── Customize popover content ── */
  const customizePopoverContent = (
    <div className="cols-menu" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.12)' }}>
      <div className="grp">
        <div className="gh">
          <span>Columns</span>
          <button className="gh-reset" type="button" onClick={() => setCols(DEFAULT_COLS)}>Reset</button>
        </div>
        {COL_DEFS.map(c => (
          <label key={c.key} className={`opt${c.fixed ? ' fixed' : ''}`}>
            <input
              type="checkbox"
              checked={!!cols[c.key] || !!c.fixed}
              disabled={!!c.fixed}
              onChange={(e) => setCols(prev => ({ ...prev, [c.key]: e.target.checked }))}
            />
            <span>{c.label}</span>
            {c.fixed && <span className="pin">Fixed</span>}
          </label>
        ))}
      </div>
      <div className="grp">
        <div className="gh"><span>Page Sections</span></div>
        {SEC_DEFS.map(s => (
          <label key={s.key} className="opt">
            <input
              type="checkbox"
              checked={!!cols[s.key]}
              onChange={(e) => setCols(prev => ({ ...prev, [s.key]: e.target.checked }))}
            />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="ed-prod">

      {/* ── Top bar ── */}
      <div className="ed-hd">
        <div className="ed-title">
          <h1>Products</h1>
          <div className="sub"><b>{totalSku}</b> items · {categories.length} categor{categories.length === 1 ? 'y' : 'ies'}</div>
        </div>
        <div className="ed-ctrl">
          <div className="ed-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search name, barcode, HSN"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
            />
          </div>

          <Dropdown trigger={['click']} placement="bottomRight" dropdownRender={() => customizePopoverContent}>
            <button className="ed-cols-btn">
              <SettingOutlined /> Customize
              <span className="badge">{visibleColCount} / {COL_DEFS.length}</span>
            </button>
          </Dropdown>

          <span className="ed-divider" />
          <button className="ed-cta ghost" onClick={() => navigate('/stock-movement')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12H3M10 5l-7 7 7 7M14 19l7-7-7-7"/></svg>
            Stock Movement
          </button>
          <button className="ed-cta" onClick={() => openForm()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
            New Item
          </button>
          <button className="ed-cta ghost" onClick={handleExport}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export
          </button>
        </div>
      </div>

      {/* ── KPI cards ── */}
      {cols.hero && (
        <div className="ed-hero">
          <div className="ed-hero-row">
            <div className="ed-kpi value">
              <div className="txt">
                <div className="k">Stock Value · On Hand</div>
                <div className="v">₹ {fmtMoney(stockValue)}</div>
                <div className="s">at purchase cost · {totalSku} SKUs</div>
              </div>
            </div>
            <div className="ed-kpi low">
              <div className="txt">
                <div className="k">Low Stock</div>
                <div className="v">{lowCount} items</div>
                <div className="s">at or below reorder level</div>
              </div>
            </div>
            <div className="ed-kpi out">
              <div className="txt">
                <div className="k">Out of Stock</div>
                <div className="v">{outCount} items</div>
                <div className="s">zero on hand · reorder urgent</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Filter chips + Category multi-select ── */}
      <div className="ed-filter">
        <span className="ed-filter-lbl">Filter</span>
        <button className={`ed-lens${!filters.stock_status ? ' on' : ''}`} onClick={() => setFilters(f => ({ ...f, stock_status: null }))}>
          All <span className="n">{totalSku}</span>
        </button>
        <button className={`ed-lens${filters.stock_status === 'in' ? ' on' : ''}`} onClick={() => setFilters(f => ({ ...f, stock_status: 'in' }))}>
          In Stock <span className="n">{inCount}</span>
        </button>
        <button className={`ed-lens warn${filters.stock_status === 'low' ? ' on' : ''}`} onClick={() => setFilters(f => ({ ...f, stock_status: 'low' }))}>
          Low <span className="n">{lowCount}</span>
        </button>
        <button className={`ed-lens danger${filters.stock_status === 'out' ? ' on' : ''}`} onClick={() => setFilters(f => ({ ...f, stock_status: 'out' }))}>
          Out <span className="n">{outCount}</span>
        </button>
        <button className={`ed-lens${filters.stock_status === 'top' ? ' on' : ''}`} onClick={() => setFilters(f => ({ ...f, stock_status: 'top' }))}>
          Top Selling <span className="n">{topCount}</span>
        </button>
        <button className={`ed-lens danger${filters.stock_status === 'dead' ? ' on' : ''}`} onClick={() => setFilters(f => ({ ...f, stock_status: 'dead' }))}>
          Dead Stock <span className="n">{deadCount}</span>
        </button>

        <span className="ed-divider" />

        <Select
          mode="multiple"
          allowClear
          placeholder="All categories"
          style={{ minWidth: 220, maxWidth: 420 }}
          value={filters.category_id || []}
          onChange={(v) => setFilters(f => ({ ...f, category_id: (v && v.length) ? v : null }))}
          options={categories.map(c => ({ value: c.category_id, label: c.category_name }))}
          showSearch
          optionFilterProp="label"
          maxTagCount="responsive"
        />
      </div>

      {/* ── Table ──
          Cursor + multi-select live in useListSelection (above) so
          the bottom strip operates on the cursored / selected rows.
          Single click only moves the cursor; double-click opens
          Stock Movement (the page's "Open" / F1 action). */}
      <div className="ed-list-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="product_id"
          scroll={{ x: 1400 }}
          summaryCells={cols.totalRow ? summaryCells : undefined}
          summaryColSpan={cols.totalRow ? summaryColSpan : undefined}
          controlledCursorIdx={sel.cursorIdx}
          controlledSelectedSet={sel.selectedSet}
          onCursorMove={sel.setCursor}
          onShiftClickRow={sel.extendTo}
          onCtrlClickRow={sel.toggleRow}
          onRow={(record) => ({
            onDoubleClick: () => record?.product_id && navigate(`/stock-movement/${record.product_id}`),
            style: record && record.product_id ? { cursor: 'pointer' } : undefined,
          })}
        />
      </div>

      {/* ── Bottom action strip — F1 Stock Movement is the primary
          row action (replaces the per-row arrow icon). F2 Edit opens
          the form modal. F3 New opens an empty form modal. F4 Find
          focuses search. F10 Export pulls the current filtered set
          to Excel. No F8 — products don't have a destructive action
          on this list (deactivation isn't exposed here). */}
      <ActionStrip
        info={isMulti ? `${selectionCount} selected` : null}
        actions={[
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: isMulti || !single,
            onAction: () => single && openForm(single),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: () => openForm(),
          },
          {
            id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus(),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => refresh?.(),
          },
          {
            id: 'export', key: 'F10', label: 'Export',
            onAction: () => handleExport(),
          },
          {
            id: 'open', key: 'F1', label: 'Stock Movement', tone: 'primary',
            disabled: isMulti || !single,
            onAction: () => single && navigate(`/stock-movement/${single.product_id}`),
          },
        ]}
      />

      {/* ── Add / Edit Product — uses the shared EntityFormModal shell.
       *  Keeps the existing Antd Form for state + validation (Form.Item
       *  rules, form.validateFields, form.setFieldsValue all unchanged
       *  so handleSubmit / openForm and the colour-sync flow work as
       *  before). The shell owns the chrome (header / sections / footer /
       *  F1/F5/F8/Esc bindings); each Form.Item is wrapped in an
       *  EntityFormModal.Field so the labels render in the spec style
       *  and validation errors surface inline.
       *
       *  Form wraps EntityFormModal (not the other way around) so the
       *  shell sees Sections as direct children — that's what drives
       *  the Alt+1..9 anchor count. EntityFormModal renders into a
       *  portal but the Antd Form context flows through React tree, so
       *  Form.Item children inside the portal still register with this
       *  form instance. */}
      <Form form={form} layout="vertical" size="middle" component={false}>
        <EntityFormModal
          open={formVisible}
          onClose={() => setFormVisible(false)}
          title={editing ? 'Edit Product' : 'Add Product'}
          subtitle={editing ? editing.product_name : 'New SKU · creates one inventory record'}
          entityIcon="P"
          entityTone="accent"
          saving={formLoading}
          onSave={handleSubmit}
          onSaveAndClose={handleSubmit}
          onReset={() => {
            if (editing) {
              // In edit mode, reset = re-hydrate from the saved row.
              openForm(editing);
            } else {
              form.resetFields();
              form.setFieldsValue({ opening_stock_date: dayjs() });
              setColorState({ color_mode: 'none', color_label: '', colors: [] });
            }
          }}
          width={720}
        >

          <EntityFormModal.Section label="Identifiers">
            <EntityFormModal.Field label="Product Name" required span="full">
              <Form.Item name="product_name" rules={[{ required: true, message: 'Required' }]} noStyle>
                <Input className="efm-input" autoFocus={!editing} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Category" required>
              <Form.Item name="category_id" rules={[{ required: true, message: 'Required' }]} noStyle>
                <Select className="efm-select-antd" placeholder="Select category" showSearch optionFilterProp="children">
                  {categories.map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
                </Select>
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Barcode" help="Leave blank to auto-generate">
              <Form.Item name="barcode" noStyle>
                <Input className="efm-input" placeholder="Auto-generate" prefix={<BarcodeOutlined />} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Size">
              <Form.Item name="size_value" noStyle>
                <Input className="efm-input" placeholder="S / M / L / XL" />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Article No">
              <Form.Item name="article_number" noStyle>
                <Input className="efm-input" />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="HSN Code">
              <Form.Item name="hsn_code" noStyle>
                <Input className="efm-input" />
              </Form.Item>
            </EntityFormModal.Field>
          </EntityFormModal.Section>

          <EntityFormModal.Section label="Pricing">
            <EntityFormModal.Field label="Purchase Rate" required>
              <Form.Item name="purchase_rate" rules={[{ required: true }]} noStyle>
                <InputNumber className="efm-input" min={0} prefix="₹" onChange={marginChanged} controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Margin %">
              <Form.Item name="margin_percentage" noStyle>
                <InputNumber className="efm-input" min={0} suffix="%" onChange={marginChanged} controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Sale Rate" required>
              <Form.Item name="sale_rate" rules={[{ required: true }]} noStyle>
                <InputNumber className="efm-input" min={0} prefix="₹" controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="MRP">
              <Form.Item name="mrp" noStyle>
                <InputNumber className="efm-input" min={0} prefix="₹" controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="GST %">
              <Form.Item name="gst_rate" noStyle>
                <InputNumber className="efm-input" min={0} suffix="%" controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            {/* Audit GST-C4 — MRP / tax-inclusive toggle. Tick for products
                where the price printed on the box already includes GST
                (pharmacy, FMCG, packaged goods). When ticked, bills auto-fill
                from MRP and reverse-compute the taxable base so the customer
                pays exactly the MRP. */}
            <EntityFormModal.Field
              label="Rate includes GST"
              help="Tick for MRP-printed items (medicines, FMCG, packaged goods) — bill uses MRP as the rate"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 }}>
                <Form.Item name="is_tax_inclusive" valuePropName="checked" initialValue={false} noStyle>
                  <Switch size="small" />
                </Form.Item>
                <Form.Item shouldUpdate={(p, c) => p.is_tax_inclusive !== c.is_tax_inclusive} noStyle>
                  {() => (
                    <span style={{ fontSize: 12, opacity: 0.75 }}>
                      {form.getFieldValue('is_tax_inclusive')
                        ? 'MRP mode — bill uses MRP, taxable reverse-computed'
                        : 'B2B mode — bill uses sale rate, GST added on top'}
                    </span>
                  )}
                </Form.Item>
              </div>
            </EntityFormModal.Field>
          </EntityFormModal.Section>

          <EntityFormModal.Section label="Inventory">
            <EntityFormModal.Field label="Unit of Measurement" help="GSTN canonical UQC — used in GSTR-1 HSN summary">
              <Form.Item name="unit_of_measurement" initialValue="PCS" noStyle>
                <Select className="efm-select-antd" showSearch optionFilterProp="children">
                  {uqcList.map(u => (
                    <Select.Option key={u.code} value={u.code}>{u.code} — {u.label}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Pcs / Box">
              <Form.Item name="quantity_per_box" noStyle>
                <InputNumber className="efm-input" min={1} controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Min Stock" help="Triggers low-stock alert">
              <Form.Item name="minimum_stock_level" noStyle>
                <InputNumber className="efm-input" min={0} controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Reorder Level">
              <Form.Item name="reorder_level" noStyle>
                <InputNumber className="efm-input" min={0} controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            {batchTrackingEnabled && (
              <EntityFormModal.Field
                label="Track by Batch"
                span="full"
                help={editing && editing.is_batch_tracked
                  ? 'Once stock movements exist on a batch-tracked product, the toggle is locked. Move all batch stock to zero before disabling.'
                  : 'Each unit can be grouped into a batch with mfg / expiry. Batch picker appears on purchases, sales, returns, and transfers.'}
              >
                <Form.Item name="is_batch_tracked" valuePropName="checked" noStyle>
                  <Switch checkedChildren="ON" unCheckedChildren="OFF" />
                </Form.Item>
              </EntityFormModal.Field>
            )}

            {/* Audit H6 — per-product costing override. 'Inherit' uses the
                company default set in Settings → Defaults. Override only
                when this specific item should diverge from the policy. */}
            <EntityFormModal.Field
              label="Costing Method"
              span="full"
              help="How COGS is calculated when this item is sold. 'Inherit' (default) follows the company-wide setting in Settings → Defaults. Override to force a specific method for this SKU."
            >
              <Form.Item name="costing_method" noStyle initialValue="inherit">
                <Select
                  options={[
                    { value: 'inherit',      label: 'Inherit (use company default)' },
                    { value: 'weighted_avg', label: 'Weighted Average' },
                    { value: 'fifo',         label: 'FIFO (First-In, First-Out)' },
                  ]}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </EntityFormModal.Field>
          </EntityFormModal.Section>

          {(singleColorEnabled || multiColorEnabled) && (
            <EntityFormModal.Section label="Colors">
              <div style={{ gridColumn: '1 / -1' }}>
                <ProductColorsPanel
                  value={colorState}
                  onChange={setColorState}
                  productId={editing?.product_id || null}
                  singleEnabled={!!singleColorEnabled}
                  multiEnabled={!!multiColorEnabled}
                />
              </div>
            </EntityFormModal.Section>
          )}

          <EntityFormModal.Section label="Opening Stock">
            <EntityFormModal.Field label="Opening Qty" help="Leave blank or 0 if none">
              <Form.Item name="opening_stock" noStyle>
                <InputNumber className="efm-input" min={0} placeholder="0" precision={2} controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="Rate / Unit">
              <Form.Item name="opening_stock_rate" noStyle>
                <InputNumber className="efm-input" min={0} prefix="₹" placeholder="Purchase rate" precision={2} controls={false} />
              </Form.Item>
            </EntityFormModal.Field>

            <EntityFormModal.Field label="As of Date" span="full">
              <Form.Item name="opening_stock_date" noStyle>
                <DatePicker className="efm-input" style={{ width: '100%', height: 32 }} format="DD/MM/YYYY" />
              </Form.Item>
            </EntityFormModal.Field>
          </EntityFormModal.Section>

        </EntityFormModal>
      </Form>
    </div>
  );
}
