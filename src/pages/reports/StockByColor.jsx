// ── Stock by Color (master) ────────────────────────────────────────────
//
// One row per multi-color product with aggregate per-color counts. The
// operator's purchase-decision view: scan a list of products, see which
// have at least one short color, drill in to see exactly which colors.
//
// Mirror of /inventory/stock-report's structure (sr-* CSS classes +
// VirtualReportTable + KPI strip + chip filter row) so this page feels
// native alongside the other inventory reports rather than being a
// stylistic outlier.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from 'antd';
import {
  SearchOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { reportAPI, categoryAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../inventory/stock-report.css';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) =>    parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtL = (v) => {
  const n = parseFloat(v || 0);
  if (Math.abs(n) >= 10000000) return `₹ ${(n / 10000000).toFixed(2)} Cr`;
  if (Math.abs(n) >= 100000)   return `₹ ${(n / 100000).toFixed(2)} L`;
  return fmt(n);
};

export default function StockByColor() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');                  // debounced
  const [categoryId, setCategoryId] = useState(null);
  const [status, setStatus] = useState(null);                // null | 'short' | 'ok'
  const [categories, setCategories] = useState([]);
  const searchInputRef = useRef(null);

  // Debounce the search input — same pattern as Stock Report.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    categoryAPI.getAll({ limit: 500 })
      .then((r) => setCategories(r.data?.data || r.data || []))
      .catch(() => setCategories([]));
  }, []);

  // Filters → server query. Stays JSON-stable so the virtualizer doesn't
  // re-cache on every render.
  const filters = useMemo(() => ({
    ...(search ? { search } : {}),
    ...(categoryId ? { category_id: categoryId } : {}),
    ...(status ? { status } : {}),
  }), [search, categoryId, status]);

  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: ({ page, limit, ...f }) => reportAPI.stockByColor({ page, limit, ...f }),
    filters,
    chunkSize: 200,
  });

  // ── Columns — mirror Stock Report's render style ─────────────────
  const columns = useMemo(() => [
    {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => <span className="sr-sr-num">{idx + 1}</span>,
    },
    {
      key: 'bc', title: 'Barcode', dataIndex: 'barcode', width: 130,
      render: (v) => v ? <span className="sr-bc">{v}</span> : <span className="sr-amt muted">—</span>,
    },
    {
      key: 'cat', title: 'Category', dataIndex: 'category_name', width: 160,
      render: (v) => <span className="sr-cat">{v || '—'}</span>,
    },
    {
      key: 'prod', title: 'Product', dataIndex: 'product_name', width: 240, fixed: 'left',
      render: (v) => <span className="sr-prod-name">{v}</span>,
    },
    {
      key: 'size', title: 'Size', dataIndex: 'size_value', width: 80, align: 'center',
      render: (v) => v ? <span className="sr-size-pill">{v}</span> : <span className="sr-amt muted">—</span>,
    },
    {
      key: 'art', title: 'Article', dataIndex: 'article_number', width: 110,
      render: (v) => v ? <span className="sr-art">{v}</span> : <span className="sr-amt muted">—</span>,
    },
    {
      key: 'colors', title: 'Colors', dataIndex: 'color_count', width: 90, align: 'center',
      render: (v, r) => (
        <span
          className="sbc-colors-pill"
          title={r.is_short ? 'Some colors short — click to drill in' : 'Click to see colors'}
        >
          {v} {v === 1 ? 'color' : 'colors'}
        </span>
      ),
    },
    {
      key: 'stk', title: 'Total Stock', dataIndex: 'total_stock', width: 110, align: 'right',
      render: (v, r) => {
        const cls = r.out_count > 0 ? 'out' : (r.low_count > 0 ? 'low' : 'ok');
        return <span className={`sr-stk ${cls}`}>{fmtN(v)}</span>;
      },
    },
    {
      key: 'short', title: 'Short', width: 110, align: 'center',
      render: (_, r) => {
        if (r.out_count === 0 && r.low_count === 0) {
          return <span className="sr-amt muted">—</span>;
        }
        const parts = [];
        if (r.out_count > 0) parts.push(<span key="o" className="sbc-tag sbc-tag-out">{r.out_count} out</span>);
        if (r.low_count > 0) parts.push(<span key="l" className="sbc-tag sbc-tag-low">{r.low_count} low</span>);
        return <span style={{ display: 'inline-flex', gap: 4 }}>{parts}</span>;
      },
    },
    {
      key: 'pur', title: 'Pur. Rate', dataIndex: 'purchase_rate', width: 110, align: 'right',
      render: (v) => <span className="sr-amt"><span className="rs">₹</span>{fmtN(v)}</span>,
    },
    {
      key: 'val', title: 'Stock Value', dataIndex: 'stock_value', width: 130, align: 'right',
      render: (v) => <span className="sr-amt"><span className="rs">₹</span>{fmtN(v)}</span>,
    },
  ], []);

  const rowClassName = (r) => {
    if (!r || r.__loading) return '';
    if (r.out_count > 0) return 'sr-row-out';
    return '';
  };

  return (
    <div className="sr-page">
      {/* ── HEADER ─────────────────────────────────────────────── */}
      <div className="sr-hd">
        <div className="sr-title">
          <h1>Stock by Color</h1>
        </div>
        <div className="sr-ctrls">
          <div className="sr-search">
            <SearchOutlined />
            <input
              ref={searchInputRef}
              placeholder="Search product, barcode, article…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Select
            placeholder="All Categories"
            style={{ width: 180 }}
            allowClear
            value={categoryId}
            onChange={(v) => setCategoryId(v ?? null)}
            options={categories.map(c => ({ value: c.category_id, label: c.category_name }))}
          />
          <button className="sr-btn" onClick={() => refresh()} title="Refresh">
            <ReloadOutlined /> Refresh
          </button>
        </div>
      </div>

      {/* ── KPI STRIP ─────────────────────────────────────────── */}
      <div className="sr-kpis">
        <div
          className={`sr-kpi tot${status === null ? ' active' : ''}`}
          onClick={() => setStatus(null)}
        >
          <div className="sr-kpi-k">Total Products</div>
          <div className="sr-kpi-v">{summary?.total_count ?? totalCount ?? 0}</div>
          <div className="sr-kpi-sub">multi-color tracked</div>
        </div>
        <div className="sr-kpi value-tone">
          <div className="sr-kpi-k">Total Qty</div>
          <div className="sr-kpi-v">{fmtN(summary?.total_qty ?? 0)}</div>
          <div className="sr-kpi-sub">all colors combined</div>
        </div>
        <div
          className={`sr-kpi low-tone${status === 'short' ? ' active' : ''}`}
          onClick={() => setStatus(status === 'short' ? null : 'short')}
        >
          <div className="sr-kpi-k">Short Items</div>
          <div className="sr-kpi-v">{(summary?.short_out_count ?? 0) + (summary?.short_low_count ?? 0)}</div>
          <div className="sr-kpi-sub">
            {summary?.short_out_count ?? 0} out · {summary?.short_low_count ?? 0} low
          </div>
        </div>
        <div
          className={`sr-kpi sale-tone${status === 'ok' ? ' active' : ''}`}
          onClick={() => setStatus(status === 'ok' ? null : 'ok')}
        >
          <div className="sr-kpi-k">All Colors OK</div>
          <div className="sr-kpi-v">{summary?.ok_count ?? 0}</div>
          <div className="sr-kpi-sub">no shortages</div>
        </div>
      </div>

      {/* ── FILTER CHIPS ──────────────────────────────────────── */}
      <div className="sr-filters">
        <span
          className={`sr-chip${status === null ? ' on' : ''}`}
          onClick={() => setStatus(null)}
        ><span className="dot"></span>All</span>
        <span
          className={`sr-chip${status === 'short' ? ' on' : ''}`}
          onClick={() => setStatus(status === 'short' ? null : 'short')}
        ><span className="dot out"></span>Short</span>
        <span
          className={`sr-chip${status === 'ok' ? ' on' : ''}`}
          onClick={() => setStatus(status === 'ok' ? null : 'ok')}
        ><span className="dot ok"></span>OK</span>
      </div>

      {/* ── TABLE ─────────────────────────────────────────────── */}
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
          onRow={(record) => ({
            onClick: () => record?.product_id && navigate(`/reports/stock-by-color/${record.product_id}`),
            style: record?.product_id ? { cursor: 'pointer' } : {},
          })}
        />
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/reports') },
          { id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => refresh() },
        ]}
      />

      {/* Page-local styles so we don't pollute the global stock-report.css.
          The colors-pill / short-tag visual matches the existing chip
          + size-pill aesthetic so the new column reads native. */}
      <style>{`
        .sbc-colors-pill {
          display: inline-block;
          padding: 2px 10px;
          border-radius: 999px;
          background: var(--bg-muted, #f1f5f9);
          color: var(--fg-primary);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.01em;
        }
        .sbc-tag {
          display: inline-block;
          padding: 1px 6px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .sbc-tag-out { background: rgba(220, 38, 38, 0.12); color: var(--danger); }
        .sbc-tag-low { background: rgba(217, 119, 6, 0.14);  color: var(--warning); }
      `}</style>
    </div>
  );
}
