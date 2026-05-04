import React, { useEffect, useMemo, useState } from 'react';
import { Table, Button, Tag, Input, Select, Tooltip, message, Empty } from 'antd';
import {
  ClockCircleOutlined, ReloadOutlined, SearchOutlined, EyeOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { batchAPI, productAPI, godownAPI, settingsAPI } from '../../api';
// Same editorial-report skin (.report-editorial / .rpt-page-hd /
// .rpt-kpis / .rpt-filter / .rpt-tbl) the Sales Report and Batches list
// use. Bucket chips below mirror the Bills Receivable bucket-chip
// pattern.
import '../inventory/stock-transfer-form.css';

/*
 * Expiry Report — bucketed view across all batches with `expiry_date`
 * tracking, plus a "no expiry" group. Operator-priority sort: oldest
 * expiry / most expired on top.
 *
 * Buckets:
 *   expired  — past due, hot-list value
 *   0_30     — within 30 days
 *   31_60    — within 31-60 days
 *   61_90    — within 61-90 days
 *   91_plus  — beyond 90 days (low concern)
 *   no_expiry — batch row with no expiry_date set
 *
 * Bucket chips are multi-select; default selection is all-on so the
 * operator sees the full landscape and narrows down by toggling chips.
 *
 * When the global toggle is OFF, the report renders the same Empty
 * placeholder as the Batches list (point operator to Settings).
 */

const BUCKETS = [
  { key: 'expired',   label: 'Expired',     tone: 'danger',  ageMin: -Infinity, ageMax: -1 },
  { key: '0_30',      label: '0-30 days',   tone: 'warning', ageMin: 0,  ageMax: 30 },
  { key: '31_60',     label: '31-60 days',  tone: 'warning', ageMin: 31, ageMax: 60 },
  { key: '61_90',     label: '61-90 days',  tone: 'info',    ageMin: 61, ageMax: 90 },
  { key: '91_plus',   label: '91+ days',    tone: 'success', ageMin: 91, ageMax: Infinity },
  { key: 'no_expiry', label: 'No expiry',   tone: 'neutral' },
];

const fmtN     = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (v) => `₹ ${Math.round(parseFloat(v || 0)).toLocaleString('en-IN')}`;

export default function ExpiryReport() {
  const nav = useNavigate();
  const [rows, setRows]       = useState([]);
  const [summary, setSummary] = useState({ total: 0, values: {} });
  const [alertDays, setAlertDays] = useState(30);
  const [batchOn, setBatchOn] = useState(true);
  const [godowns, setGodowns] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    product_id: undefined,
    godown_id:  undefined,
    buckets:    BUCKETS.map((b) => b.key),  // all on by default
    q:          '',
  });

  const load = async () => {
    if (!batchOn) return;
    setLoading(true);
    try {
      const params = {};
      if (filters.product_id)       params.product_id = filters.product_id;
      if (filters.godown_id)        params.godown_id  = filters.godown_id;
      if (filters.buckets?.length)  params.bucket     = filters.buckets.join(',');
      const { data } = await batchAPI.expiryReport(params);
      let result = data?.data || [];
      // Client-side text filter — the API doesn't take q for the expiry
      // report, but the filter feels natural in the search box anyway.
      if (filters.q) {
        const q = filters.q.toLowerCase();
        result = result.filter((r) =>
          (r.batch_number || '').toLowerCase().includes(q)
          || (r.product_name || '').toLowerCase().includes(q));
      }
      setRows(result);
      setSummary(data?.summary || { total: 0, values: {} });
      setAlertDays(data?.alert_days || 30);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load expiry report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    settingsAPI.getSystem().then(({ data }) => setBatchOn(!!data?.data?.batch_tracking_enabled)).catch(() => {});
    godownAPI.getAll().then(({ data }) => setGodowns(data || [])).catch(() => {});
    productAPI.search('', { is_batch_tracked: true, limit: 200 })
      .then(({ data }) => setProducts(data?.data || data || []))
      .catch(() => {});
  }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters, batchOn]);

  const columns = useMemo(() => [
    {
      title: 'SR', key: 'sr', width: 56, align: 'center',
      render: (_, __, idx) => <span style={{ color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>,
    },
    {
      title: 'Batch #', dataIndex: 'batch_number', width: 160,
      render: (v, r) => (
        <Tooltip title="Open batch detail">
          <a onClick={() => nav(`/inventory/batches/${r.batch_id}`)} className="rpt-bill-no" style={{ cursor: 'pointer' }}>
            {v}
          </a>
        </Tooltip>
      ),
    },
    {
      title: 'Product', dataIndex: 'product_name',
      render: (v, r) => (
        <div>
          <span style={{ fontWeight: 600 }}>{v || '—'}</span>
          {r.category_name && (
            <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 2 }}>{r.category_name}</div>
          )}
        </div>
      ),
    },
    {
      title: 'Mfg Date', dataIndex: 'manufacture_date', width: 110,
      render: (v) => v ? dayjs(v).format('DD/MM/YY') : '—',
    },
    {
      title: 'Expiry', dataIndex: 'expiry_date', width: 110,
      render: (v) => v ? dayjs(v).format('DD/MM/YY') : '—',
    },
    {
      title: 'Days', dataIndex: 'days_to_expiry', width: 100, align: 'right',
      render: (v) => {
        if (v == null) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        const tone = v < 0 ? 'var(--danger)' : v <= alertDays ? 'var(--warning)' : 'var(--fg-secondary)';
        return (
          <span style={{ color: tone, fontWeight: v < 0 || v <= alertDays ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>
            {v < 0 ? `−${Math.abs(v)}d` : `${v}d`}
          </span>
        );
      },
    },
    {
      title: 'Stock', dataIndex: 'total_stock', width: 110, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtN(v)}</span>,
    },
    {
      title: 'Value', dataIndex: 'stock_value', width: 140, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtInt(v)}</span>,
    },
    {
      title: 'Bucket', dataIndex: 'bucket', width: 130,
      render: (v) => {
        const b = BUCKETS.find((x) => x.key === v);
        return b ? <span className={`rpt-pill type-${b.tone}`}>{b.label}</span> : <span>{v}</span>;
      },
    },
  ], [alertDays, nav]);

  if (!batchOn) {
    return (
      <div className="report-editorial stf-list" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="rpt-page-hd">
          <div className="rpt-title">
            <h1>Expiry Report</h1>
            <div className="rpt-sub">Batch-level expiry roll-up · enable batch tracking to see this report.</div>
          </div>
        </div>
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 32 }}>
          <Empty
            image={<ClockCircleOutlined style={{ fontSize: 64, color: 'var(--fg-tertiary)' }} />}
            description={
              <div style={{ maxWidth: 420, textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg-primary)', marginBottom: 8 }}>Batch tracking is turned off</div>
                <div style={{ fontSize: 13, color: 'var(--fg-secondary)', lineHeight: 1.6 }}>
                  Enable batch tracking in <b>Settings → Modules</b>, then re-open this report.
                </div>
              </div>
            }
          >
            <Button type="primary" onClick={() => nav('/settings/system')}>Open Settings</Button>
          </Empty>
        </div>
      </div>
    );
  }

  // KPI roll-ups: counts + values per bucket. Computed off the API
  // summary (full-set) rather than the displayed rows so the tiles
  // reflect the global landscape regardless of bucket-chip selection.
  const tile = (key) => ({ count: summary[key] || 0, value: summary.values?.[key] || 0 });
  const expiredTile = tile('expired');
  const tile030    = tile('0_30');
  const tileNoExp  = tile('no_expiry');
  const totalExpiryTracked = (summary.expired || 0) + (summary['0_30'] || 0) + (summary['31_60'] || 0)
    + (summary['61_90'] || 0) + (summary['91_plus'] || 0);

  return (
    <div className="report-editorial stf-list" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── HEADER ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Expiry Report</h1>
          <div className="rpt-sub">
            <b>{summary.total || 0}</b> {summary.total === 1 ? 'batch' : 'batches'}
            <span className="sep">·</span>alert window <b>{alertDays}d</b>
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <Button icon={<ReloadOutlined />} onClick={load} className="rpt-btn">Refresh</Button>
        </div>
      </div>

      {/* ─── KPI STRIP ─── */}
      <div className="rpt-kpis">
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">With Expiry Tracking</div>
          <div className="rpt-kpi-v">{totalExpiryTracked}</div>
        </div>
        <div className="rpt-kpi tone-danger">
          <div className="rpt-kpi-k">Expired</div>
          <div className="rpt-kpi-v">{expiredTile.count}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            Value: {fmtMoney(expiredTile.value)}
          </div>
        </div>
        <div className="rpt-kpi tone-warning">
          <div className="rpt-kpi-k">Expiring within 30d</div>
          <div className="rpt-kpi-v">{tile030.count}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            Value: {fmtMoney(tile030.value)}
          </div>
        </div>
        <div className="rpt-kpi tone-neutral">
          <div className="rpt-kpi-k">No Expiry Set</div>
          <div className="rpt-kpi-v">{tileNoExp.count}</div>
        </div>
      </div>

      {/* ─── FILTER BAR ─── */}
      <div className="rpt-filter">
        <Input
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder="Search batch # or product name"
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          allowClear
        />
        <span className="rpt-sep" />
        {BUCKETS.map((b) => {
          const on = filters.buckets.includes(b.key);
          return (
            <button
              key={b.key}
              className={`rpt-chip ${on ? 'on' : ''}`}
              onClick={() => setFilters((f) => ({
                ...f,
                buckets: on ? f.buckets.filter((x) => x !== b.key) : [...f.buckets, b.key],
              }))}
            >
              <span className={`rpt-dot tone-${b.tone}`} />{b.label}
            </button>
          );
        })}
        <span className="rpt-sep" />
        <Select
          allowClear placeholder="Product"
          value={filters.product_id}
          onChange={(v) => setFilters((f) => ({ ...f, product_id: v }))}
          options={products.map((p) => ({ value: p.product_id, label: p.product_name }))}
          showSearch
          filterOption={(input, opt) => !input || (opt.label || '').toLowerCase().includes(input.toLowerCase())}
          style={{ minWidth: 220 }}
          size="middle"
        />
        <Select
          allowClear placeholder="Godown"
          value={filters.godown_id}
          onChange={(v) => setFilters((f) => ({ ...f, godown_id: v }))}
          options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
          style={{ minWidth: 200 }}
          size="middle"
        />
      </div>

      {/* ─── TABLE ─── */}
      <div className="rpt-tbl-wrap">
        <div className="rpt-tbl report-table-scroll stf-tbl-card">
          <Table
            rowKey="batch_id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            size="middle"
            scroll={{ x: 1100 }}
            sticky
            locale={{ emptyText: (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                <ClockCircleOutlined style={{ fontSize: 32, opacity: 0.4 }} />
                <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600, color: 'var(--fg-secondary)' }}>No batches in selected buckets</div>
                <div style={{ fontSize: 12 }}>Toggle bucket chips above to widen the view.</div>
              </div>
            ) }}
          />
          {rows.length > 0 && (
            <div className="stf-tbl-foot">
              <span className="stf-tbl-foot-lbl">Total ({rows.length})</span>
              <span className="stf-tbl-foot-spacer" />
              <span className="stf-tbl-foot-val">{fmtN(rows.reduce((s, r) => s + parseFloat(r.total_stock || 0), 0))}</span>
              <span className="stf-tbl-foot-val money">{fmtInt(rows.reduce((s, r) => s + parseFloat(r.stock_value || 0), 0))}</span>
              <span className="stf-tbl-foot-pad" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
