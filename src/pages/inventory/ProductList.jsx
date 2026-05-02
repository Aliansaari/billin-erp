import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Input, Button, Modal, Form, InputNumber, Select,
  Row, Col, Divider, message, DatePicker, Dropdown, Tooltip,
} from 'antd';
import { BarcodeOutlined, SettingOutlined, EditOutlined, ArrowRightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { productAPI, categoryAPI, dataAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';

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

function marginPct(p) {
  const pur = parseFloat(p.purchase_rate || 0);
  const sale = parseFloat(p.sale_rate || 0);
  if (!pur) return null;
  return ((sale - pur) / pur) * 100;
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

  /* ── data layer ── */
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => productAPI.getAll(params),
    filters,
    chunkSize: 200,
  });

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

  useEffect(() => { loadCategories(); }, []);

  const loadCategories = async () => {
    try { const { data } = await categoryAPI.getAllFlat(); setCategories(data || []); }
    catch { /* ignore */ }
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
      key: 'pur', title: 'Purchase', dataIndex: 'purchase_rate', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.purchase_rate || 0) - parseFloat(b.purchase_rate || 0),
      render: (v) => <span className="mon-m"><span className="rs">₹</span>{fmtMoney(v)}</span>,
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
      sorter: (a, b) =>
        (parseFloat(a.current_stock || 0) * parseFloat(a.purchase_rate || 0)) -
        (parseFloat(b.current_stock || 0) * parseFloat(b.purchase_rate || 0)),
      render: (_, p) => {
        const v = parseFloat(p.current_stock || 0) * parseFloat(p.purchase_rate || 0);
        return v > 0
          ? <span className="mon-m"><span className="rs">₹</span>{fmtMoney(v)}</span>
          : <span className="mon-m zero">—</span>;
      },
    },
    {
      key: 'act', title: '', width: 110, align: 'center', fixed: 'right',
      render: (_, p) => {
        const groupStyle = { display: 'inline-flex', gap: 4, opacity: 1, pointerEvents: 'auto' };
        return (
          <div style={groupStyle}>
            <Tooltip title="Stock movement">
              <button className="abtn primary" onClick={(e) => { e.stopPropagation(); navigate(`/stock-movement/${p.product_id}`); }}>
                <ArrowRightOutlined />
              </button>
            </Tooltip>
            <Tooltip title="Edit">
              <button className="abtn" onClick={(e) => { e.stopPropagation(); openForm(p); }}>
                <EditOutlined />
              </button>
            </Tooltip>
          </div>
        );
      },
    },
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
    <div className="cols-menu" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.12)', padding: 0 }}>
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

      {/* ── Table ── */}
      <div className="ed-list-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="product_id"
          scroll={{ x: 1400 }}
          onRow={(record) => ({
            onClick: () => { if (record && record.product_id) navigate(`/stock-movement/${record.product_id}`); },
            style: record && record.product_id ? { cursor: 'pointer' } : undefined,
          })}
          summaryCells={cols.totalRow ? summaryCells : undefined}
          summaryColSpan={cols.totalRow ? summaryColSpan : undefined}
          // ↑/↓ Home/End/PageUp/PageDown to move; Enter opens Stock
          // Movement for the active product (matches click behaviour);
          // Esc clears the cursor.
          keyboardNav
          persistKey="products"
          onRowEnter={(row) => row?.product_id && navigate(`/stock-movement/${row.product_id}`)}
        />
      </div>

      {/* ── Add / Edit modal — unchanged from the editorial version ── */}
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
