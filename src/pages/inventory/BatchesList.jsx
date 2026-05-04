import React, { useEffect, useMemo, useState } from 'react';
import { Table, Button, Tag, Input, Select, Tooltip, message, Empty } from 'antd';
import {
  AppstoreOutlined, ReloadOutlined, SearchOutlined, EyeOutlined,
  ClockCircleOutlined, CheckCircleOutlined, WarningOutlined, CloseCircleOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { batchAPI, productAPI, godownAPI, settingsAPI } from '../../api';
// Same editorial-report skin Stock Transfers list / Sales Report use —
// .report-editorial wrapper, .rpt-page-hd / .rpt-kpis / .rpt-filter /
// .rpt-tbl primitives. Plus the .stf-list scoped paint (action buttons,
// table card layout) that ships with the form CSS file.
import './stock-transfer-form.css';

/*
 * Batches list — every batch in the system, with on-hand totals, status,
 * and per-batch value. Routes to /inventory/batches/:id on row click.
 *
 * Status taxonomy (from server):
 *   expired         — has expiry < today           (red, hot-list)
 *   expiring_soon   — expiry within alert window   (orange)
 *   active          — has stock, not expiring soon (green)
 *   out_of_stock    — no stock anywhere            (neutral)
 *
 * Default sort puts expired first, then expiring_soon, then active —
 * matches the Commit-5 spec's operator priority (act on expired stock
 * before it loses value).
 *
 * When the global toggle is OFF, the page renders an Empty placeholder
 * pointing the operator to Settings → Modules.
 */

const STATUS_TONE = {
  expired:       { tone: 'danger',  label: 'Expired',       desc: 'Past expiry — operator hot-list' },
  expiring_soon: { tone: 'warning', label: 'Expiring Soon', desc: 'Within alert window' },
  active:        { tone: 'success', label: 'Active',        desc: 'In stock, not expiring soon' },
  out_of_stock:  { tone: 'neutral', label: 'Out of Stock',  desc: 'No on-hand at any godown' },
};

const fmtN     = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (v) => `₹ ${Math.round(parseFloat(v || 0)).toLocaleString('en-IN')}`;

export default function BatchesList() {
  const nav = useNavigate();
  const [rows, setRows]               = useState([]);
  const [summary, setSummary]         = useState({ total: 0, active: 0, expiring_soon: 0, expired: 0, out_of_stock: 0, expired_value: 0 });
  const [alertDays, setAlertDays]     = useState(30);
  const [godowns, setGodowns]         = useState([]);
  const [products, setProducts]       = useState([]);
  const [loading, setLoading]         = useState(false);
  const [batchTrackingOn, setBatchOn] = useState(true);
  const [filters, setFilters]         = useState({
    product_id: undefined,
    godown_id:  undefined,
    statuses:   [],     // multi-select chips: expired / expiring_soon / active / out_of_stock
    q:          '',
  });

  const load = async () => {
    if (!batchTrackingOn) return;
    setLoading(true);
    try {
      const params = {};
      if (filters.product_id)        params.product_id = filters.product_id;
      if (filters.godown_id)         params.godown_id  = filters.godown_id;
      if (filters.statuses?.length)  params.status     = filters.statuses.join(',');
      if (filters.q)                 params.q          = filters.q.trim();
      const { data } = await batchAPI.list(params);
      setRows(data?.data || []);
      setSummary(data?.summary || { total: 0, active: 0, expiring_soon: 0, expired: 0, out_of_stock: 0, expired_value: 0 });
      setAlertDays(data?.alert_days || 30);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load batches');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    settingsAPI.getSystem().then(({ data }) => {
      setBatchOn(!!data?.data?.batch_tracking_enabled);
    }).catch(() => {});
    godownAPI.getAll().then(({ data }) => setGodowns(data || [])).catch(() => {});
    productAPI.search('', { is_batch_tracked: true, limit: 200 })
      .then(({ data }) => setProducts(data?.data || data || []))
      .catch(() => {});
  }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters, batchTrackingOn]);

  // Sub-line under the title: "{count} batches · alert {N}d"
  const subLabel = useMemo(() => {
    const parts = [];
    if (summary.total)         parts.push(`${summary.total} ${summary.total === 1 ? 'batch' : 'batches'}`);
    if (alertDays)             parts.push(`alert window ${alertDays}d`);
    return parts.join(' · ');
  }, [summary.total, alertDays]);

  const columns = useMemo(() => [
    {
      title: 'SR', key: 'sr', width: 56, align: 'center',
      render: (_, __, idx) => <span style={{ color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>,
    },
    {
      title: 'Batch #', dataIndex: 'batch_number', width: 160,
      render: (v) => <span className="rpt-bill-no">{v}</span>,
    },
    {
      title: 'Product', dataIndex: 'product_name',
      render: (v, r) => (
        <div>
          <span style={{ fontWeight: 600, color: 'var(--fg-primary)' }}>{v || '—'}</span>
          {r.category_name && (
            <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 2 }}>
              {r.category_name}
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Mfg Date', dataIndex: 'manufacture_date', width: 110,
      render: (v) => <span style={{ color: 'var(--fg-secondary)' }}>{v ? dayjs(v).format('DD/MM/YYYY') : '—'}</span>,
    },
    {
      title: 'Expiry', dataIndex: 'expiry_date', width: 130,
      render: (v, r) => {
        if (!v) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        const d = r.days_to_expiry;
        const isExpired = d != null && d < 0;
        const isSoon    = d != null && d >= 0 && d <= alertDays;
        const tone = isExpired ? 'var(--danger)' : isSoon ? 'var(--warning)' : 'var(--fg-secondary)';
        return (
          <div style={{ color: tone, fontWeight: isExpired || isSoon ? 600 : 500 }}>
            <div>{dayjs(v).format('DD/MM/YYYY')}</div>
            {d != null && (
              <div style={{ fontSize: 10, opacity: 0.85 }}>
                {isExpired ? `${Math.abs(d)}d ago` : `${d}d left`}
              </div>
            )}
          </div>
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
      title: 'Status', dataIndex: 'status', width: 140,
      render: (s) => {
        const t = STATUS_TONE[s] || STATUS_TONE.active;
        return <Tooltip title={t.desc}><span className={`rpt-pill type-${t.tone}`}>{t.label}</span></Tooltip>;
      },
    },
    {
      title: '', key: 'go', width: 56, align: 'right', fixed: 'right',
      render: (_, r) => (
        <Tooltip title="View detail">
          <button className="abtn" onClick={() => nav(`/inventory/batches/${r.batch_id}`)} aria-label="View">
            <EyeOutlined />
          </button>
        </Tooltip>
      ),
    },
  ], [alertDays, nav]);

  // Status-chip filter — multi-select, mirrors the Bills Receivable
  // bucket-chip pattern. Clicking a chip toggles its membership in
  // filters.statuses; multiple chips are AND-combined inside the
  // server's status filter (it accepts comma-separated values).
  const statusChips = ['expired', 'expiring_soon', 'active', 'out_of_stock'];

  // Module-OFF placeholder: batch tracking is a paid/optional feature
  // that the operator opts in to from Settings. Without it, no batches
  // exist anywhere and an empty list would mislead. Render a clear
  // "Enable batch tracking" prompt instead.
  if (!batchTrackingOn) {
    return (
      <div className="report-editorial stf-list" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="rpt-page-hd">
          <div className="rpt-title">
            <h1>Batches</h1>
            <div className="rpt-sub">Per-lot inventory tracking with FEFO/FIFO picking and expiry alerts.</div>
          </div>
        </div>
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 32 }}>
          <Empty
            image={<AppstoreOutlined style={{ fontSize: 64, color: 'var(--fg-tertiary)' }} />}
            description={
              <div style={{ maxWidth: 420, textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg-primary)', marginBottom: 8 }}>
                  Batch tracking is turned off
                </div>
                <div style={{ fontSize: 13, color: 'var(--fg-secondary)', lineHeight: 1.6 }}>
                  Enable batch tracking in <b>Settings → Modules</b> to track stock per lot, capture mfg / expiry dates, and use FEFO / FIFO picking on the sales counter.
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

  return (
    <div className="report-editorial stf-list" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── HEADER ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Batches</h1>
          <div className="rpt-sub">{subLabel || 'No batches yet.'}</div>
        </div>
        <div className="rpt-hd-ctrl">
          <Button icon={<ReloadOutlined />} onClick={load} className="rpt-btn">Refresh</Button>
        </div>
      </div>

      {/* ─── KPI STRIP ─── */}
      <div className="rpt-kpis">
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Total Batches</div>
          <div className="rpt-kpi-v">{summary.total}</div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Active</div>
          <div className="rpt-kpi-v">{summary.active}</div>
        </div>
        <div className="rpt-kpi tone-warning">
          <div className="rpt-kpi-k">Expiring Soon ({alertDays}d)</div>
          <div className="rpt-kpi-v">{summary.expiring_soon}</div>
        </div>
        <div className="rpt-kpi tone-danger">
          <div className="rpt-kpi-k">Expired w/ Stock</div>
          <div className="rpt-kpi-v">{summary.expired}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            Value: {fmtMoney(summary.expired_value)}
          </div>
        </div>
        <div className="rpt-kpi tone-neutral">
          <div className="rpt-kpi-k">Out of Stock</div>
          <div className="rpt-kpi-v">{summary.out_of_stock}</div>
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
        {statusChips.map((s) => {
          const t = STATUS_TONE[s];
          const on = filters.statuses.includes(s);
          return (
            <button
              key={s}
              className={`rpt-chip ${on ? 'on' : ''}`}
              onClick={() => setFilters((f) => ({
                ...f,
                statuses: on ? f.statuses.filter((x) => x !== s) : [...f.statuses, s],
              }))}
            >
              <span className={`rpt-dot tone-${t.tone}`} />{t.label}
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
            onRow={(r) => ({ onClick: () => nav(`/inventory/batches/${r.batch_id}`), style: { cursor: 'pointer' } })}
            locale={{ emptyText: (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                <AppstoreOutlined style={{ fontSize: 32, opacity: 0.4 }} />
                <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600, color: 'var(--fg-secondary)' }}>No batches yet</div>
                <div style={{ fontSize: 12 }}>Create batches via purchase bills for batch-tracked products.</div>
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
              <span className="stf-tbl-foot-pad" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
