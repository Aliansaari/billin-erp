// ── Stock by Color (master) ────────────────────────────────────────────
//
// One row per multi-color product with aggregate per-color counts. The
// operator's purchase-decision view: scan a list of products, see which
// have at least one short color, drill in to see exactly which colors.
//
// Layout discipline mirrors Fast & Slow Stock (and the other rpt-*
// reports): an outer .sbc-page flex column, sticky .rpt-page-hd at the
// top, .rpt-kpis strip, tabs-style filter row, and a flex:1 table band
// holding the virtualized list. All chrome is inherited from
// src/styles/global.css's .rpt-* family so the page reads as a sibling
// of Cash Flow, Fund Flow, Bills Outstanding, etc.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Input, Modal, Checkbox, Button } from 'antd';
import {
  SearchOutlined, ReloadOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { reportAPI, categoryAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../inventory/stock-report.css';      // reuse .sbf-cust-* + .sbf-cols-* classes

const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtR = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Column registry — `required` flags pin the four anchors (#, Product,
// Colors, Total Stock) so the operator can't toggle them off and end up
// with a useless table. Order in this array drives render order. The
// `group` field drives the section breakdown in the Customize modal.
const COL_DEFS = [
  { key: 'sr',     label: 'Sr No',         required: true,  group: 'Identifiers' },
  { key: 'bc',     label: 'Barcode',                         group: 'Identifiers' },
  { key: 'cat',    label: 'Category',                        group: 'Identifiers' },
  { key: 'prod',   label: 'Product',       required: true,  group: 'Identifiers' },
  { key: 'size',   label: 'Size',                            group: 'Identifiers' },
  { key: 'art',    label: 'Article',                         group: 'Identifiers' },
  { key: 'colors', label: 'Colors',        required: true,  group: 'Quantity' },
  { key: 'stk',    label: 'Total Stock',   required: true,  group: 'Quantity' },
  { key: 'short',  label: 'Short',                           group: 'Quantity' },
  { key: 'pur',    label: 'Pur. Rate',                       group: 'Pricing & Value' },
  { key: 'val',    label: 'Stock Value',                     group: 'Pricing & Value' },
];
const DEFAULT_PREFS = Object.fromEntries(COL_DEFS.map(c => [c.key, true]));
const LS_KEY = 'sbc-visible-cols-v1';
const loadPrefs = () => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const saved = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...saved };
  } catch {
    return DEFAULT_PREFS;
  }
};

export default function StockByColor() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState(null);
  const [status, setStatus] = useState(null);            // null | 'short' | 'ok'
  const [categories, setCategories] = useState([]);
  // Column visibility — same shape as StockReport's prefs. Persists per
  // browser via localStorage so the operator's column choices stick.
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch {}
  }, [prefs]);
  // Customize-columns modal state — same vocabulary as Stock Report
  // (centered Modal with Reset / Done footer).
  const [colsModalOpen, setColsModalOpen] = useState(false);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    categoryAPI.getAll({ limit: 500 })
      .then((r) => setCategories(r.data?.data || r.data || []))
      .catch(() => setCategories([]));
  }, []);

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

  // Cell helpers — share styles with the rpt-* family via inline style
  // tokens (CSS vars resolve to whatever the active theme defines).
  const numCell = (v, opts = {}) => (
    <span style={{
      fontVariantNumeric: 'tabular-nums',
      fontWeight: opts.bold ? 700 : 600,
      color: opts.color || 'var(--fg-primary)',
    }}>{fmtN(v)}</span>
  );

  const columns = useMemo(() => [
    {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => (
        <span style={{ fontSize: 11, color: 'var(--fg-tertiary)', fontWeight: 600 }}>{idx + 1}</span>
      ),
    },
    {
      key: 'bc', title: 'Barcode', dataIndex: 'barcode', width: 140,
      render: (v) => v ? (
        <span style={{
          fontFamily: 'Geist Mono, monospace',
          fontSize: 11, fontWeight: 600,
          color: 'var(--fg-secondary)',
          background: 'var(--bg-muted)',
          padding: '2px 8px', borderRadius: 4,
        }}>{v}</span>
      ) : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    {
      key: 'cat', title: 'Category', dataIndex: 'category_name', width: 160,
      render: (v) => v
        ? <span style={{ fontSize: 12.5, color: 'var(--fg-secondary)' }}>{v}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    {
      key: 'prod', title: 'Product', dataIndex: 'product_name', width: 260, fixed: 'left',
      render: (v) => (
        <span style={{
          fontWeight: 600, fontSize: 13, color: 'var(--fg-primary)',
        }}>{v}</span>
      ),
    },
    {
      key: 'size', title: 'Size', dataIndex: 'size_value', width: 80, align: 'center',
      render: (v) => v ? (
        <span style={{
          fontSize: 11, fontWeight: 600,
          color: 'var(--fg-secondary)', background: 'var(--bg-muted)',
          padding: '2px 8px', borderRadius: 4,
        }}>{v}</span>
      ) : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    {
      key: 'art', title: 'Article', dataIndex: 'article_number', width: 110,
      render: (v) => v
        ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{v}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    {
      key: 'colors', title: 'Colors', dataIndex: 'color_count', width: 110, align: 'center',
      render: (v) => (
        <span style={{
          display: 'inline-block', padding: '3px 12px',
          borderRadius: 999, background: 'var(--accent-bg, rgba(99,102,241,.12))',
          color: 'var(--accent)', fontSize: 11, fontWeight: 700,
        }}>
          {v} {v === 1 ? 'color' : 'colors'}
        </span>
      ),
    },
    {
      key: 'stk', title: 'Total Stock', dataIndex: 'total_stock', width: 110, align: 'right',
      render: (v, r) => {
        const color = r.out_count > 0
          ? 'var(--danger)'
          : (r.low_count > 0 ? 'var(--warning)' : 'var(--success)');
        return numCell(v, { color, bold: true });
      },
    },
    {
      key: 'short', title: 'Short', width: 130, align: 'center',
      render: (_, r) => {
        if (r.out_count === 0 && r.low_count === 0) {
          return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        }
        return (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            {r.out_count > 0 && (
              <span style={{
                padding: '2px 8px', borderRadius: 4,
                background: 'rgba(220,38,38,.12)', color: 'var(--danger)',
                fontSize: 10, fontWeight: 700, letterSpacing: '.02em',
              }}>{r.out_count} out</span>
            )}
            {r.low_count > 0 && (
              <span style={{
                padding: '2px 8px', borderRadius: 4,
                background: 'rgba(217,119,6,.14)', color: 'var(--warning)',
                fontSize: 10, fontWeight: 700, letterSpacing: '.02em',
              }}>{r.low_count} low</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'pur', title: 'Pur. Rate', dataIndex: 'purchase_rate', width: 120, align: 'right',
      render: (v) => (
        <span style={{
          fontVariantNumeric: 'tabular-nums', color: 'var(--fg-secondary)', fontWeight: 500,
        }}>
          <span style={{ color: 'var(--fg-tertiary)', marginRight: 1 }}>₹</span>{fmtN(v)}
        </span>
      ),
    },
    {
      key: 'val', title: 'Stock Value', dataIndex: 'stock_value', width: 140, align: 'right',
      render: (v) => (
        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
          <span style={{ color: 'var(--fg-tertiary)', marginRight: 1, fontWeight: 500 }}>₹</span>{fmtN(v)}
        </span>
      ),
    },
  ], []);

  // Visibility filter — required columns always pass; optional ones gate
  // on `prefs[key]`. This sits between the column registry above and the
  // VirtualReportTable below so the customize modal's checkboxes drive
  // the actual rendered set.
  const visibleColumns = useMemo(
    () => columns.filter((c) => {
      const def = COL_DEFS.find((d) => d.key === c.key);
      return !def ? true : (def.required || !!prefs[c.key]);
    }),
    [columns, prefs],
  );

  const rowClassName = (r) => {
    if (!r || r.__loading) return '';
    if (r.out_count > 0) return 'sbc-row-out';
    if (r.low_count > 0) return 'sbc-row-low';
    return '';
  };

  const totalShort = (summary?.short_out_count ?? 0) + (summary?.short_low_count ?? 0);

  return (
    <div className="sbc-page">

      {/* ── Title strip — shared rpt-* design system ──────────── */}
      <header className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Stock by Color</h1>
          <div className="rpt-sub">
            <b>{summary?.total_count ?? totalCount ?? 0}</b> multi-color products
            {summary && (
              <>
                <span className="sep">·</span>
                <b>{fmtN(summary.total_qty)}</b> total qty
                <span className="sep">·</span>
                {totalShort > 0 ? (
                  <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                    {summary.short_out_count} out · {summary.short_low_count} low
                  </span>
                ) : (
                  <span style={{ color: 'var(--success)', fontWeight: 600 }}>all OK</span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="rpt-hd-ctrl">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Search product, barcode, article…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ width: 240, height: 34, borderRadius: 7 }}
          />
          <Select
            placeholder="All Categories"
            allowClear
            showSearch
            optionFilterProp="label"
            value={categoryId ?? undefined}
            onChange={(v) => setCategoryId(v ?? null)}
            style={{ width: 180, height: 34 }}
            options={categories.map((c) => ({ value: c.category_id, label: c.category_name }))}
          />
          {/* Match Fast & Slow Stock — Antd Button + .rpt-btn class so
           *  the icon spacing, height, and hover state line up with the
           *  rest of the rpt-* design system. The earlier raw <button
           *  className="rpt-btn ant-btn"> didn't pick up Antd's Button
           *  internals, leaving the buttons looking pale and inert. */}
          <Button className="rpt-btn" icon={<ReloadOutlined />} onClick={() => refresh()}>
            Refresh
          </Button>
          <Button
            className="rpt-btn"
            icon={<SettingOutlined />}
            onClick={() => setColsModalOpen(true)}
            title="Customize the report columns"
          >
            Customize
          </Button>
        </div>
      </header>

      {/* ── KPI strip — rpt-kpis with tone classes ──────────── */}
      <div className="rpt-kpis">
        <div
          className={`rpt-kpi tone-info${status === null ? ' active' : ''}`}
          onClick={() => setStatus(null)}
          style={{ cursor: 'pointer' }}
        >
          <div className="rpt-kpi-k">Total Products</div>
          <div className="rpt-kpi-v">{summary?.total_count ?? totalCount ?? 0}</div>
          <div className="rpt-kpi-sub">multi-color tracked</div>
        </div>
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Total Qty</div>
          <div className="rpt-kpi-v">{fmtN(summary?.total_qty ?? 0)}</div>
          <div className="rpt-kpi-sub">across all colors</div>
        </div>
        <div
          className={`rpt-kpi tone-warning${status === 'short' ? ' active' : ''}`}
          onClick={() => setStatus(status === 'short' ? null : 'short')}
          style={{ cursor: 'pointer' }}
        >
          <div className="rpt-kpi-k">Short Items</div>
          <div className="rpt-kpi-v">{totalShort}</div>
          <div className="rpt-kpi-sub">
            {summary?.short_out_count ?? 0} out · {summary?.short_low_count ?? 0} low
          </div>
        </div>
        <div
          className={`rpt-kpi tone-success${status === 'ok' ? ' active' : ''}`}
          onClick={() => setStatus(status === 'ok' ? null : 'ok')}
          style={{ cursor: 'pointer' }}
        >
          <div className="rpt-kpi-k">All Colors OK</div>
          <div className="rpt-kpi-v">{summary?.ok_count ?? 0}</div>
          <div className="rpt-kpi-sub">no shortages</div>
        </div>
      </div>

      {/* ── Tabs strip — same shape as Fast & Slow Stock's mv-tabs */}
      <div className="sbc-tabs">
        <button className={status === null ? 'on' : ''} onClick={() => setStatus(null)}>
          All <span className="count">{summary?.total_count ?? 0}</span>
        </button>
        <button className={status === 'short' ? 'on' : ''} onClick={() => setStatus(status === 'short' ? null : 'short')}>
          Short <span className="count">{totalShort}</span>
        </button>
        <button className={status === 'ok' ? 'on' : ''} onClick={() => setStatus(status === 'ok' ? null : 'ok')}>
          OK <span className="count">{summary?.ok_count ?? 0}</span>
        </button>
      </div>

      {/* ── Table band ─────────────────────────────────────── */}
      <div className="sbc-tbl-wrap">
        <VirtualReportTable
          columns={visibleColumns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="product_id"
          scroll={{ x: 1320 }}
          rowClassName={rowClassName}
          onRow={(record) => ({
            onClick: () => record?.product_id && navigate(`/reports/stock-by-color/${record.product_id}`),
            style: record?.product_id ? { cursor: 'pointer' } : {},
          })}
        />
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: () => navigate('/reports') },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: () => refresh() },
        ]}
      />

      {/* Customize columns modal — same UX as Stock Report and the
       *  Sales Bill form: centered Modal, dense rows with a 3px accent
       *  rail on the active state, internal scroll, Reset / Done
       *  footer. Required columns surface with a "Fixed" pin and a
       *  disabled checkbox so the operator can't break the table. */}
      <Modal
        open={colsModalOpen}
        onCancel={() => setColsModalOpen(false)}
        title="Customize columns"
        footer={
          <div className="sbf-cols-footer">
            <button
              type="button"
              className="sbf-cols-reset"
              onClick={() => {
                setPrefs(DEFAULT_PREFS);
                try { localStorage.removeItem(LS_KEY); } catch {}
              }}
            >
              Reset
            </button>
            <button
              type="button"
              className="sbf-cols-done"
              onClick={() => setColsModalOpen(false)}
            >
              Done
            </button>
          </div>
        }
        width={340}
        styles={{ body: { padding: 0 } }}
        className="sbf-cust-modal"
      >
        <div className="sbf-cust-list">
          {['Identifiers', 'Quantity', 'Pricing & Value'].map((groupLabel) => {
            const rows = COL_DEFS.filter((c) => c.group === groupLabel);
            if (!rows.length) return null;
            return (
              <div key={groupLabel} className="sbf-cust-group">
                <div className="sbf-cust-group-lbl">{groupLabel}</div>
                {rows.map((c) => {
                  const isOn = !!prefs[c.key] || !!c.required;
                  return (
                    <label
                      key={c.key}
                      className={`sbf-cust-row${isOn ? ' on' : ''}`}
                    >
                      <Checkbox
                        checked={isOn}
                        disabled={!!c.required}
                        onChange={(e) => setPrefs((p) => ({ ...p, [c.key]: e.target.checked }))}
                      />
                      <span className="sbf-cust-row-lbl">{c.label}</span>
                      {c.required && <span className="sbf-cust-row-pin">Fixed</span>}
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
      </Modal>

      {/* Page-level layout — mirrors mv-page in fast-slow-stock.css.
          Outer flex column, only the table band is flex:1, header /
          KPI / tabs / footer all flex-shrink:0. */}
      <style>{`
        .sbc-page {
          height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--bg-app);
          overflow: hidden;
          font-variant-numeric: tabular-nums;
        }
        .sbc-page .rpt-page-hd { flex-shrink: 0; }
        .sbc-page .rpt-kpis { flex-shrink: 0; padding-bottom: 14px; }

        .sbc-tabs {
          flex-shrink: 0;
          display: flex;
          gap: 4px;
          align-items: center;
          padding: 0 24px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-panel);
        }
        .sbc-tabs button {
          border: 0;
          background: transparent;
          padding: 12px 16px;
          font: inherit;
          font-size: 12.5px;
          font-weight: 500;
          color: var(--fg-secondary);
          cursor: pointer;
          position: relative;
          transition: color .12s;
        }
        .sbc-tabs button:hover { color: var(--fg-primary); }
        .sbc-tabs button.on {
          color: var(--accent);
          font-weight: 600;
        }
        .sbc-tabs button.on::after {
          content: '';
          position: absolute;
          left: 16px; right: 16px; bottom: -1px;
          height: 2px;
          background: var(--accent);
          border-radius: 2px 2px 0 0;
        }
        .sbc-tabs button .count {
          margin-left: 4px;
          color: var(--fg-tertiary);
          font-weight: 500;
          font-size: 11.5px;
        }
        .sbc-tabs button.on .count { color: var(--accent); }

        .sbc-tbl-wrap {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .sbc-tbl-wrap > * { flex: 1; min-height: 0; }

        .sbc-tbl-wrap .ant-table-tbody > tr.sbc-row-out > td {
          background: rgba(220, 38, 38, 0.04);
        }
        .sbc-tbl-wrap .ant-table-tbody > tr.sbc-row-out:hover > td {
          background: rgba(220, 38, 38, 0.07) !important;
        }
        .sbc-tbl-wrap .ant-table-tbody > tr.sbc-row-low > td {
          background: rgba(217, 119, 6, 0.04);
        }
        .sbc-tbl-wrap .ant-table-tbody > tr.sbc-row-low:hover > td {
          background: rgba(217, 119, 6, 0.07) !important;
        }
      `}</style>
    </div>
  );
}
