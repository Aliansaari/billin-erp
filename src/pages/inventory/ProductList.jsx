import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Input, Button, Modal, Form, InputNumber, Select,
  Row, Col, Divider, message, DatePicker, Spin,
} from 'antd';
import { BarcodeOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { productAPI, categoryAPI, dataAPI } from '../../api';

dayjs.extend(relativeTime);
import '../../styles/editorial-product-list.css';

/*
 * ProductList — editorial redesign.
 *
 * Single full-width table (no split-view). Fifteen available columns in the
 * order the operator asked for — #, Category, Product, HSN, GST%, Barcode,
 * Stock, Total Purchased, Total Sold, Purchase, Sale, Margin, Health,
 * Runway, Value — plus Actions. Show/hide any column (except Product and
 * Actions) from the ☰ Columns menu; the menu also hides the KPI hero and
 * the filter chip bar. User choice persists in localStorage.
 *
 * "Total Purchased" / "Total Sold" / "Runway / Last Sold" show placeholders
 * until the product API exposes the underlying lifetime stats; the columns
 * exist so the UI is ready without a schema migration.
 *
 * Add/Edit keeps the existing AntD Modal with the full pricing + opening-
 * stock form — only the list chrome was redesigned.
 */

const PROD_LIMIT = 200;

const LS_COLS = 'ed-products-cols-v1';
const LS_SECS = 'ed-products-secs-v1';

// Columns the user can toggle. `fixed: true` means always visible (Product & Actions).
const COL_DEFS = [
  { key: 'sr',    label: 'Number',               default: true  },
  { key: 'cat',   label: 'Category',             default: true  },
  { key: 'prod',  label: 'Product',              default: true,  fixed: true },
  { key: 'hsn',   label: 'HSN Code',             default: false },
  { key: 'gst',   label: 'GST %',                default: false },
  { key: 'bc',    label: 'Barcode',              default: false },
  { key: 'stk',   label: 'Stock (On Hand)',      default: true  },
  { key: 'tpur',  label: 'Total Stock Purchased',default: true  },
  { key: 'tsale', label: 'Total Stock Sold',     default: true  },
  { key: 'pur',   label: 'Purchase Rate',        default: false },
  { key: 'sale',  label: 'Sale Rate',            default: true  },
  { key: 'mgn',   label: 'Margin',               default: true  },
  { key: 'hlt',   label: 'Health',               default: true  },
  { key: 'run',   label: 'Runway',               default: true  },
  { key: 'val',   label: 'Stock Value',          default: true  },
  { key: 'act',   label: 'Actions',              default: true,  fixed: true },
];
const SEC_DEFS = [
  { key: 'hero',   label: 'KPI Cards',  default: true },
  { key: 'filter', label: 'Filter Bar', default: true },
];
const DEFAULT_COLS = Object.fromEntries(COL_DEFS.map(c => [c.key, c.default]));
const DEFAULT_SECS = Object.fromEntries(SEC_DEFS.map(s => [s.key, s.default]));

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

function marginPct(p) {
  const pur = parseFloat(p.purchase_rate || 0);
  const sale = parseFloat(p.sale_rate || 0);
  if (!pur) return null;
  return ((sale - pur) / pur) * 100;
}

// Category dots — stable colour mapping by category name so the same
// category shows the same dot across reloads without a backend colour.
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

  /* ── list state ── */
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | in | low | out | top | dead
  const [catFilters, setCatFilters] = useState(() => new Set()); // empty Set = all categories
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const listEndRef = useRef(null);

  /* ── categories ── */
  const [categories, setCategories] = useState([]);

  /* ── columns / sections / category menu ── */
  const [cols, setCols] = useState(() => loadPrefs(LS_COLS, DEFAULT_COLS));
  const [secs, setSecs] = useState(() => loadPrefs(LS_SECS, DEFAULT_SECS));
  const [colsOpen, setColsOpen] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const colsWrapRef = useRef(null);
  const catWrapRef = useRef(null);

  /* ── form modal ── */
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => { localStorage.setItem(LS_COLS, JSON.stringify(cols)); }, [cols]);
  useEffect(() => { localStorage.setItem(LS_SECS, JSON.stringify(secs)); }, [secs]);

  /* ── load ── */
  useEffect(() => { loadCategories(); }, []);
  useEffect(() => {
    // Debounce the search input so every keystroke doesn't hit the API.
    // Status / category / sort filters are applied client-side over the
    // fetched page — no extra round trip needed when the user toggles them.
    const handle = setTimeout(() => loadProducts(1, true), search ? 220 : 0);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const loadCategories = async () => {
    try { const { data } = await categoryAPI.getAllFlat(); setCategories(data || []); }
    catch { /* ignore */ }
  };

  const loadProducts = async (pageArg = 1, reset = false) => {
    if (pageArg === 1) setLoading(true); else setLoadingMore(true);
    try {
      const params = { search, page: pageArg, limit: PROD_LIMIT, include_stats: 'true' };
      const { data } = await productAPI.getAll(params);
      const list = data.data || [];
      const tot  = data.total || 0;
      if (reset || pageArg === 1) {
        setProducts(list);
        setPage(1);
      } else {
        setProducts(prev => [...prev, ...list]);
        setPage(pageArg);
      }
      setTotal(tot);
    } catch { message.error('Failed to load products'); }
    if (pageArg === 1) setLoading(false); else setLoadingMore(false);
  };

  /* ── infinite scroll ── */
  const handleLoadMore = useCallback(() => {
    if (loadingMore || loading) return;
    if (products.length >= total) return;
    loadProducts(page + 1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMore, loading, products.length, total, page]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) handleLoadMore(); },
      { threshold: 0.1 }
    );
    if (listEndRef.current) observer.observe(listEndRef.current);
    return () => observer.disconnect();
  }, [handleLoadMore]);

  /* ── close dropdowns on outside click / Escape ── */
  useEffect(() => {
    if (!colsOpen && !catOpen) return;
    const close = (e) => {
      if (colsOpen && colsWrapRef.current && !colsWrapRef.current.contains(e.target)) setColsOpen(false);
      if (catOpen  && catWrapRef.current  && !catWrapRef.current.contains(e.target))  setCatOpen(false);
    };
    const esc = (e) => { if (e.key === 'Escape') { setColsOpen(false); setCatOpen(false); } };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
    };
  }, [colsOpen, catOpen]);

  /* Sort toggle — first click sets ASC, second flips to DESC, third clears */
  const toggleSort = useCallback((key) => {
    setSortKey(prev => (prev === key && sortDir === 'desc') ? null : key);
    setSortDir(prev => (sortKey === key ? (prev === 'asc' ? 'desc' : 'asc') : 'asc'));
  }, [sortKey, sortDir]);

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
    } else {
      form.resetFields();
      form.setFieldsValue({ opening_stock_date: dayjs() });
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
      if (editing) {
        await productAPI.update(editing.product_id, values);
        message.success('Product updated');
      } else {
        const { data } = await productAPI.create(values);
        message.success(`Product added — Barcode: ${data.barcode || data.product?.barcode}`);
      }
      setFormVisible(false);
      loadProducts(1, true);
    } catch (e) { message.error(e.response?.data?.error || 'Failed to save'); }
    setFormLoading(false);
  };

  const handleExport = async () => {
    try {
      const params = {};
      if (search) params.search = search;
      // Only the first selected category is forwarded — the server export
      // endpoint takes a single category_id. Users who want a multi-cat export
      // can broaden with no filter and slice locally in Excel.
      if (catFilters.size > 0) params.category_id = [...catFilters][0];
      if (statusFilter === 'low' || statusFilter === 'out') params.stock_status = statusFilter;
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

  /* ── derived: status counts + filtered+sorted list ── */
  const statusCounts = useMemo(() => {
    let inStock = 0, low = 0, out = 0, top = 0, dead = 0;
    const today = dayjs();
    for (const p of products) {
      const h = healthOf(p);
      if (h.kind === 'out') out++;
      else if (h.kind === 'low') low++;
      else inStock++;
      if (parseFloat(p.total_sold || 0) > 0) top++;
      const stale = !p.last_sold_at || today.diff(dayjs(p.last_sold_at), 'day') > 60;
      if (stale && parseFloat(p.current_stock || 0) > 0) dead++;
    }
    return { all: products.length, in: inStock, low, out, top, dead };
  }, [products]);

  const filtered = useMemo(() => {
    const today = dayjs();

    // 1. Filter
    let result = products.filter(p => {
      if (catFilters.size > 0 && !catFilters.has(p.category_id)) return false;
      if (statusFilter === 'all') return true;
      const h = healthOf(p);
      if (statusFilter === 'in')   return h.kind === 'ok';
      if (statusFilter === 'low')  return h.kind === 'low';
      if (statusFilter === 'out')  return h.kind === 'out';
      if (statusFilter === 'top')  return parseFloat(p.total_sold || 0) > 0;
      if (statusFilter === 'dead') {
        const stale = !p.last_sold_at || today.diff(dayjs(p.last_sold_at), 'day') > 60;
        return stale && parseFloat(p.current_stock || 0) > 0;
      }
      return true;
    });

    // 2. Sort — explicit user sort takes precedence; otherwise Top Selling
    //    implies "by total_sold desc" so the chip shows its name-sake order.
    const getters = {
      cat:   p => (p.Category?.category_name || categories.find(c => c.category_id === p.category_id)?.category_name || '').toLowerCase(),
      prod:  p => (p.product_name || '').toLowerCase(),
      hsn:   p => (p.hsn_code || '').toString().toLowerCase(),
      gst:   p => parseFloat(p.gst_rate || 0),
      stk:   p => parseFloat(p.current_stock || 0),
      tpur:  p => parseFloat(p.total_purchased || 0),
      tsale: p => parseFloat(p.total_sold || 0),
      pur:   p => parseFloat(p.purchase_rate || 0),
      sale:  p => parseFloat(p.sale_rate || 0),
      mgn:   p => marginPct(p) ?? -Infinity,
      hlt:   p => ({ out: 0, low: 1, ok: 2 }[healthOf(p).kind] ?? 3),
      run:   p => p.last_sold_at ? new Date(p.last_sold_at).getTime() : 0,
      val:   p => parseFloat(p.current_stock || 0) * parseFloat(p.purchase_rate || 0),
    };
    if (sortKey && getters[sortKey]) {
      const g = getters[sortKey];
      result = [...result].sort((a, b) => {
        const va = g(a), vb = g(b);
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    } else if (statusFilter === 'top') {
      result = [...result].sort((a, b) => parseFloat(b.total_sold || 0) - parseFloat(a.total_sold || 0));
    }

    return result;
  }, [products, statusFilter, catFilters, sortKey, sortDir, categories]);

  /* ── totals for hero cards ── */
  const heroStats = useMemo(() => {
    let value = 0, low = 0, out = 0;
    for (const p of products) {
      const stk = parseFloat(p.current_stock || 0);
      const pur = parseFloat(p.purchase_rate || 0);
      value += stk * pur;
      const h = healthOf(p);
      if (h.kind === 'low') low++;
      if (h.kind === 'out') out++;
    }
    return { value, low, out };
  }, [products]);

  /* ── page totals ── */
  const pageValue = useMemo(
    () => filtered.reduce((a, p) => a + parseFloat(p.current_stock || 0) * parseFloat(p.purchase_rate || 0), 0),
    [filtered]
  );

  const visibleColCount = useMemo(
    () => COL_DEFS.filter(c => cols[c.key] || c.fixed).length,
    [cols]
  );

  /* ── render helpers ── */
  const colClass = (key) => `ed-c-${key}${cols[key] || COL_DEFS.find(c => c.key === key)?.fixed ? '' : ' col-off'}`;

  const sortHeader = (key, label) => {
    const active = sortKey === key;
    return (
      <span
        data-sortable={key}
        className={active ? 'active' : ''}
        onClick={(e) => { e.stopPropagation(); toggleSort(key); }}
      >
        {label}
        <span className="sort-arrow">{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </span>
    );
  };

  return (
    <div className="ed-prod">

      {/* ── Top bar ── */}
      <div className="ed-hd">
        <div className="ed-title">
          <h1>Products</h1>
          <div className="sub"><b>{total}</b> items · {categories.length} categor{categories.length === 1 ? 'y' : 'ies'}</div>
        </div>
        <div className="ed-ctrl">
          <div className="ed-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
            <input
              type="text"
              placeholder="Search name, barcode, HSN"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div className="ed-cols-wrap" ref={colsWrapRef}>
            <button
              className={`ed-cols-btn${colsOpen ? ' open' : ''}`}
              onClick={(e) => { e.stopPropagation(); setColsOpen(v => !v); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
              Columns <span className="badge">{visibleColCount} / {COL_DEFS.length}</span>
            </button>
            {colsOpen && (
              <div className="ed-cols-menu open" role="menu">
                <div className="grp">
                  <div className="gh">
                    <span>Columns</span>
                    <button className="gh-reset" type="button"
                      onClick={() => { setCols({ ...DEFAULT_COLS }); setSecs({ ...DEFAULT_SECS }); }}>Reset</button>
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
                        checked={!!secs[s.key]}
                        onChange={(e) => setSecs(prev => ({ ...prev, [s.key]: e.target.checked }))}
                      />
                      <span>{s.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

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
      {secs.hero && (
        <div className="ed-hero">
          <div className="ed-hero-row">
            <div className="ed-kpi value">
              <div className="txt">
                <div className="k">Stock Value · On Hand</div>
                <div className="v">₹ {fmtMoney(heroStats.value)}</div>
                <div className="s">at purchase cost · {total} SKUs</div>
              </div>
            </div>
            <div className="ed-kpi low">
              <div className="txt">
                <div className="k">Low Stock</div>
                <div className="v">{heroStats.low} items</div>
                <div className="s">at or below reorder level</div>
              </div>
            </div>
            <div className="ed-kpi out">
              <div className="txt">
                <div className="k">Out of Stock</div>
                <div className="v">{heroStats.out} items</div>
                <div className="s">zero on hand · reorder urgent</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Filter chips + Categories dropdown ── */}
      {secs.filter && (
        <div className="ed-filter">
          <span className="ed-filter-lbl">Filter</span>
          <button className={`ed-lens${statusFilter === 'all' ? ' on' : ''}`} onClick={() => setStatusFilter('all')}>
            All <span className="n">{statusCounts.all}</span>
          </button>
          <button className={`ed-lens${statusFilter === 'in' ? ' on' : ''}`} onClick={() => setStatusFilter('in')}>
            In Stock <span className="n">{statusCounts.in}</span>
          </button>
          <button className={`ed-lens warn${statusFilter === 'low' ? ' on' : ''}`} onClick={() => setStatusFilter('low')}>
            Low <span className="n">{statusCounts.low}</span>
          </button>
          <button className={`ed-lens danger${statusFilter === 'out' ? ' on' : ''}`} onClick={() => setStatusFilter('out')}>
            Out <span className="n">{statusCounts.out}</span>
          </button>
          <button className={`ed-lens${statusFilter === 'top' ? ' on' : ''}`} onClick={() => setStatusFilter('top')}>
            Top Selling <span className="n">{statusCounts.top}</span>
          </button>
          <button className={`ed-lens danger${statusFilter === 'dead' ? ' on' : ''}`} onClick={() => setStatusFilter('dead')}>
            Dead Stock <span className="n">{statusCounts.dead}</span>
          </button>

          <span className="ed-divider" />

          {/* Categories: multi-select dropdown */}
          <div className="ed-cols-wrap" ref={catWrapRef}>
            <button
              className={`ed-cols-btn${catOpen ? ' open' : ''}${catFilters.size > 0 ? ' on' : ''}`}
              onClick={(e) => { e.stopPropagation(); setCatOpen(v => !v); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 7h-4l-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/></svg>
              {catFilters.size === 0 ? 'Categories' : `${catFilters.size} categor${catFilters.size === 1 ? 'y' : 'ies'}`}
              {catFilters.size > 0 && <span className="badge">{catFilters.size}</span>}
            </button>
            {catOpen && (
              <div className="ed-cols-menu open" role="menu">
                <div className="grp">
                  <div className="gh">
                    <span>Show categories</span>
                    <button className="gh-reset" type="button" onClick={() => setCatFilters(new Set())}>Clear</button>
                  </div>
                  <label className="opt">
                    <input
                      type="checkbox"
                      checked={catFilters.size === 0}
                      onChange={() => setCatFilters(new Set())}
                    />
                    <span>All categories</span>
                    <span className="pin">{categories.length}</span>
                  </label>
                  {categories.map(c => (
                    <label key={c.category_id} className="opt">
                      <input
                        type="checkbox"
                        checked={catFilters.has(c.category_id)}
                        onChange={(e) => {
                          setCatFilters(prev => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(c.category_id); else next.delete(c.category_id);
                            return next;
                          });
                        }}
                      />
                      <span>{c.category_name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Active sort indicator + clear */}
          {sortKey && (
            <button
              className="ed-lens"
              onClick={() => { setSortKey(null); setSortDir('asc'); }}
              title="Clear sort"
            >
              Sort: {COL_DEFS.find(c => c.key === sortKey)?.label || sortKey} {sortDir === 'asc' ? '↑' : '↓'} ✕
            </button>
          )}
        </div>
      )}

      {/* ── Table ── */}
      <div className="ed-list-wrap">
        <div className="ed-list">

          <div className="ed-row head">
            <div className={colClass('sr')}>#</div>
            <div className={colClass('cat')}>{sortHeader('cat', 'Category')}</div>
            <div className={colClass('prod')}>{sortHeader('prod', 'Product')}</div>
            <div className={colClass('hsn')}>{sortHeader('hsn', 'HSN')}</div>
            <div className={colClass('gst')}>{sortHeader('gst', 'GST %')}</div>
            <div className={colClass('bc')}>Barcode</div>
            <div className={colClass('stk')}>{sortHeader('stk', 'Stock')}</div>
            <div className={colClass('tpur')}>{sortHeader('tpur', 'Total Pur.')}</div>
            <div className={colClass('tsale')}>{sortHeader('tsale', 'Total Sold')}</div>
            <div className={colClass('pur')}>{sortHeader('pur', 'Purchase')}</div>
            <div className={colClass('sale')}>{sortHeader('sale', 'Sale')}</div>
            <div className={colClass('mgn')}>{sortHeader('mgn', 'Margin')}</div>
            <div className={colClass('hlt')}>{sortHeader('hlt', 'Health')}</div>
            <div className={colClass('run')}>{sortHeader('run', 'Last Sold')}</div>
            <div className={colClass('val')}>{sortHeader('val', 'Value')}</div>
            <div className={colClass('act')} />
          </div>

          <div className="ed-scroll">
            {loading ? (
              <div className="ed-empty"><Spin /></div>
            ) : filtered.length === 0 ? (
              <div className="ed-empty">
                {search ? `No products match "${search}"` : 'No products yet — click New Item to add one.'}
              </div>
            ) : (
              <>
                {filtered.map((p, idx) => {
                  const h = healthOf(p);
                  const m = marginPct(p);
                  const stockVal = parseFloat(p.current_stock || 0) * parseFloat(p.purchase_rate || 0);
                  const catName = p.Category?.category_name || categories.find(c => c.category_id === p.category_id)?.category_name || '—';
                  return (
                    <div
                      key={p.product_id}
                      className="ed-row data"
                      onClick={() => navigate(`/stock-movement/${p.product_id}`)}
                    >
                      <div className={colClass('sr')}>
                        <span className="sr-n">{String(idx + 1).padStart(2, '0')}</span>
                      </div>
                      <div className={colClass('cat')}>
                        <span className="cat-pill">
                          <span className="cat-dot" style={{ background: catColor(catName) }} />
                          {catName}
                        </span>
                      </div>
                      <div className={colClass('prod')}>
                        <span className="p-name">{p.product_name}</span>
                        {p.size_value && <span className="p-var">{p.size_value}</span>}
                      </div>
                      <div className={colClass('hsn')}>
                        <span className="mono">{p.hsn_code || '—'}</span>
                      </div>
                      <div className={colClass('gst')}>
                        <span className="gst-pct">{p.gst_rate != null ? `${p.gst_rate}%` : '—'}</span>
                      </div>
                      <div className={colClass('bc')}>
                        <span className="bc">{p.barcode || '—'}</span>
                      </div>
                      <div className={colClass('stk')}>
                        <span className={`qty-m${parseFloat(p.current_stock || 0) === 0 ? ' zero' : ''}`}>
                          {fmtQty(p.current_stock)}
                        </span>
                        <span className="qty-u">{p.unit_of_measurement || 'pcs'}</span>
                      </div>
                      <div className={colClass('tpur')}>
                        <span className="qty-m">{p.total_purchased != null ? fmtQty(p.total_purchased) : '—'}</span>
                        {p.total_purchased != null && <span className="qty-u">{p.unit_of_measurement || 'pcs'}</span>}
                      </div>
                      <div className={colClass('tsale')}>
                        <span className="qty-m">{p.total_sold != null ? fmtQty(p.total_sold) : '—'}</span>
                        {p.total_sold != null && <span className="qty-u">{p.unit_of_measurement || 'pcs'}</span>}
                      </div>
                      <div className={colClass('pur')}>
                        <span className="mon-m"><span className="rs">₹</span>{fmtMoney(p.purchase_rate)}</span>
                      </div>
                      <div className={colClass('sale')}>
                        <span className="mon-m"><span className="rs">₹</span>{fmtMoney(p.sale_rate)}</span>
                      </div>
                      <div className={colClass('mgn')}>
                        {m != null
                          ? <span className="mg-chip">{m >= 0 ? '+' : ''}{m.toFixed(0)}%</span>
                          : <span className="mg-chip muted">—</span>}
                      </div>
                      <div className={colClass('hlt')}>
                        <span className={`health ${h.kind}`}><span className="dot" />{h.label}</span>
                      </div>
                      <div className={colClass('run')}>
                        {p.last_sold_at ? (() => {
                          const days = dayjs().diff(dayjs(p.last_sold_at), 'day');
                          const cls = days > 60 ? 'urgent' : days > 14 ? 'soon' : 'calm';
                          const label = days === 0 ? 'today'
                                      : days === 1 ? 'yesterday'
                                      : days < 30  ? `${days}d ago`
                                      : days < 365 ? `${Math.round(days/30)}mo ago`
                                      :              `${Math.round(days/365)}y ago`;
                          return (
                            <>
                              <span className={`rw-m ${cls}`}>{label}</span>
                              <span className="rw-s">on {dayjs(p.last_sold_at).format('DD MMM YYYY')}</span>
                            </>
                          );
                        })() : (
                          <>
                            <span className="rw-m none">never sold</span>
                            <span className="rw-s">no sales yet</span>
                          </>
                        )}
                      </div>
                      <div className={colClass('val')}>
                        {stockVal > 0
                          ? <span className="mon-m"><span className="rs">₹</span>{fmtMoney(stockVal)}</span>
                          : <span className="mon-m zero">—</span>}
                      </div>
                      <div className={colClass('act')}>
                        <div className="act-box">
                          <div className="act-group">
                            <button
                              className="abtn primary"
                              data-tip="Stock movement"
                              onClick={(e) => { e.stopPropagation(); navigate(`/stock-movement/${p.product_id}`); }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M13 5l7 7-7 7"/></svg>
                            </button>
                            <button
                              className="abtn"
                              data-tip="Edit"
                              onClick={(e) => { e.stopPropagation(); openForm(p); }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={listEndRef} style={{ padding: 8, textAlign: 'center' }}>
                  {loadingMore
                    ? <Spin size="small" />
                    : products.length < total
                      ? <span style={{ fontSize: 12, color: 'var(--ed-fg-3)' }}>Scroll for more…</span>
                      : null}
                </div>
              </>
            )}
          </div>

          <div className="ed-foot">
            <span>Shown: <b>{filtered.length}{products.length < total ? ` of ${total}` : ''}</b></span>
            <span>Page value: <b>₹ {fmtMoney(pageValue)}</b></span>
            <span>Low: <b style={{ color: 'var(--ed-warn)' }}>{statusCounts.low}</b></span>
            <span>Out: <b style={{ color: 'var(--ed-danger)' }}>{statusCounts.out}</b></span>
          </div>
        </div>
      </div>

      {/* ── Add / Edit modal (unchanged AntD form) ── */}
      <Modal
        title={editing ? `Edit — ${editing.product_name}` : 'Add New Product'}
        open={formVisible}
        onCancel={() => setFormVisible(false)}
        onOk={handleSubmit}
        confirmLoading={formLoading}
        width={680}
        destroyOnClose
        okText={editing ? 'Update' : 'Add Product'}
      >
        <Form form={form} layout="vertical" size="middle">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="barcode" label="Barcode" help="Leave blank to auto-generate">
                <Input placeholder="Auto-generate" prefix={<BarcodeOutlined />} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="category_id" label="Category" rules={[{ required: true, message: 'Required' }]}>
                <Select placeholder="Select category" showSearch optionFilterProp="children">
                  {categories.map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="product_name" label="Product Name" rules={[{ required: true, message: 'Required' }]}>
                <Input placeholder="Product name" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}><Form.Item name="size_value" label="Size"><Input placeholder="S/M/L/XL" /></Form.Item></Col>
            <Col span={6}><Form.Item name="article_number" label="Article No"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item name="hsn_code" label="HSN Code"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item name="gst_rate" label="GST %"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="unit_of_measurement" label="Unit" initialValue="PCS">
                <Select>{['PCS','KG','METER','LITER','BOX','DOZEN'].map(u => <Select.Option key={u}>{u}</Select.Option>)}</Select>
              </Form.Item>
            </Col>
            <Col span={6}><Form.Item name="quantity_per_box" label="Qty/Box"><InputNumber style={{ width: '100%' }} min={1} /></Form.Item></Col>
            <Col span={6}><Form.Item name="minimum_stock_level" label="Min Stock"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item></Col>
            <Col span={6}><Form.Item name="reorder_level" label="Reorder Level"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item></Col>
          </Row>
          <Divider plain>Pricing</Divider>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="purchase_rate" label="Purchase Rate" rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} min={0} prefix="₹" onChange={marginChanged} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="margin_percentage" label="Margin %">
                <InputNumber style={{ width: '100%' }} min={0} suffix="%" onChange={marginChanged} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="sale_rate" label="Sale Rate" rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} min={0} prefix="₹" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="mrp" label="MRP">
                <InputNumber style={{ width: '100%' }} min={0} prefix="₹" />
              </Form.Item>
            </Col>
          </Row>

          <Divider plain><span style={{ color: 'var(--ed-accent)', fontWeight: 600 }}>Opening Stock</span></Divider>
          <div style={{ background: 'var(--ed-accent-s)', border: '1px solid var(--ed-accent-b)', borderRadius: 8, padding: '12px 16px' }}>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="opening_stock" label="Opening Qty" style={{ marginBottom: 0 }}>
                  <InputNumber style={{ width: '100%' }} min={0} placeholder="0" precision={2} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="opening_stock_rate" label="Rate / Unit" style={{ marginBottom: 0 }}>
                  <InputNumber style={{ width: '100%' }} min={0} prefix="₹" placeholder="Purchase rate" precision={2} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="opening_stock_date" label="As of Date" style={{ marginBottom: 0 }}>
                  <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
                </Form.Item>
              </Col>
            </Row>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ed-fg-3)' }}>
              Leave Opening Qty blank or 0 if no opening stock.
            </div>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
