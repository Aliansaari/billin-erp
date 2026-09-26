import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Table, Button, Select, Tooltip, message, Segmented, Input } from 'antd';
import {
  ReloadOutlined, SearchOutlined, TeamOutlined, PhoneOutlined,
  FileExcelOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
// Same editorial-report skin (.report-editorial / .rpt-page-hd /
// .rpt-kpis / .rpt-filter / .rpt-tbl) the Expiry and Sales reports use.
import '../inventory/stock-transfer-form.css';

/*
 * Party Lapse — "who stopped trading with us".
 *
 * Outstanding and Aging both answer questions about money already
 * owed. Neither answers the question that comes first: a supplier who
 * quietly stops sending goods, or a customer who stops walking in,
 * appears in no existing report until the sales figures have already
 * moved. This report surfaces that gap directly.
 *
 * Two directions off one endpoint:
 *   suppliers → purchase_bills   ("who stopped supplying me")
 *   customers → sales_bills      ("who stopped buying from me")
 *
 * Buckets are days since the party's last bill. `depth` (bills per
 * year) is shown alongside because a lapsed DEEP relationship is a
 * materially bigger loss than a lapsed one-off, and sorting purely by
 * value hides that.
 */

const BUCKETS = [
  { key: 'active',   label: 'Active (0-90d)',  tone: 'success' },
  { key: 'slipping', label: 'Slipping (3-6m)', tone: 'warning' },
  { key: 'lapsed',   label: 'Lapsed (6-12m)',  tone: 'danger'  },
  { key: 'lost',     label: 'Lost (12m+)',     tone: 'neutral' },
];

const DEPTHS = [
  { key: 'deep',       label: 'Deep (12+/yr)' },
  { key: 'regular',    label: 'Regular (5-11)' },
  { key: 'occasional', label: 'Occasional (2-4)' },
  { key: 'one_off',    label: 'One-off' },
];

const DEPTH_META = {
  deep:       { label: 'Deep',       tone: 'success' },
  regular:    { label: 'Regular',    tone: 'accent'  },
  occasional: { label: 'Occasional', tone: 'warning' },
  one_off:    { label: 'One-off',    tone: 'neutral' },
};

const LOOKBACKS = [
  { value: 365,  label: 'Last 1 year' },
  { value: 730,  label: 'Last 2 years' },
  { value: 1095, label: 'Last 3 years' },
  { value: 1825, label: 'Last 5 years' },
];

const fmtInt = (v) => `₹ ${Math.round(parseFloat(v || 0)).toLocaleString('en-IN')}`;

// Days quiet → a short human label. Past a year the exact day count
// stops being useful, so it rolls up to months.
function quietLabel(d) {
  if (d == null) return '—';
  if (d <= 60) return `${d}d`;
  const m = Math.floor(d / 30);
  return `${m}m`;
}

export default function PartyLapseReport() {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Direction is URL-backed so the two views are separately
  // bookmarkable and the Reports Hub can deep-link either one.
  const direction = searchParams.get('direction') === 'customer' ? 'customer' : 'supplier';
  const isSupplier = direction === 'supplier';

  const [rows, setRows]       = useState([]);
  const [summary, setSummary] = useState({});
  const [atRisk, setAtRisk]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({
    buckets:  ['slipping', 'lapsed', 'lost'],  // the ones that need action
    depths:   DEPTHS.map((d) => d.key),
    lookback: 730,
    q:        '',
  });
  const searchInputRef = useRef(null);

  // One param builder for both the on-screen load and the XLSX export,
  // so an exported sheet always matches what the operator is looking at.
  const buildParams = () => {
    const params = { direction, lookback_days: filters.lookback, sort: 'value_desc' };
    if (filters.buckets.length && filters.buckets.length < BUCKETS.length) {
      params.bucket = filters.buckets.join(',');
    }
    if (filters.depths.length && filters.depths.length < DEPTHS.length) {
      params.depth = filters.depths.join(',');
    }
    if (filters.q) params.search = filters.q;
    return params;
  };

  const exportExcel = async () => {
    if (!rows.length) { message.info('Nothing to export'); return; }
    setExporting(true);
    try {
      const res = await reportAPI.exportPartyLapse(buildParams());
      const url = window.URL.createObjectURL(new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${isSupplier ? 'suppliers' : 'customers'}_stopped_${dayjs().format('YYYY-MM-DD')}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      message.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await reportAPI.partyLapse(buildParams());
      setRows(data?.rows || []);
      setSummary(data?.summary || {});
      setAtRisk(data?.trade_at_risk || 0);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [direction, filters]);

  const setDirection = (d) => {
    const next = new URLSearchParams(searchParams);
    next.set('direction', d);
    setSearchParams(next, { replace: true });
  };

  const openParty = (partyId) => {
    const route = isSupplier ? '/reports/supplier-statement' : '/reports/customer-statement';
    nav(`${route}?id=${partyId}`);
  };

  const columns = useMemo(() => [
    {
      title: 'SR', key: 'sr', width: 52, align: 'center',
      render: (_, __, idx) => (
        <span style={{ color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>
      ),
    },
    {
      title: isSupplier ? 'Supplier' : 'Customer', dataIndex: 'party_name',
      render: (v, r) => (
        <div>
          <Tooltip title="Open statement">
            <a onClick={() => openParty(r.party_id)} className="rpt-bill-no" style={{ cursor: 'pointer', fontWeight: 600 }}>
              {v || '—'}
            </a>
          </Tooltip>
          {(r.mobile_1 || r.city) && (
            <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 2 }}>
              {r.mobile_1 && <><PhoneOutlined style={{ fontSize: 10 }} /> {r.mobile_1}</>}
              {r.mobile_1 && r.city ? ' · ' : ''}
              {r.city || ''}
            </div>
          )}
        </div>
      ),
    },
    {
      title: isSupplier ? 'Last supply' : 'Last purchase', dataIndex: 'last_bill', width: 118,
      render: (v) => (v ? dayjs(v).format('DD/MM/YY') : '—'),
    },
    {
      title: 'Quiet', dataIndex: 'days_quiet', width: 88, align: 'right',
      render: (v, r) => {
        const tone = r.bucket === 'lost' ? 'var(--fg-tertiary)'
          : r.bucket === 'lapsed' ? 'var(--danger)'
            : r.bucket === 'slipping' ? 'var(--warning)' : 'var(--fg-secondary)';
        return (
          <span style={{ color: tone, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {quietLabel(v)}
          </span>
        );
      },
    },
    {
      title: 'Bills', dataIndex: 'bills', width: 74, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>,
    },
    {
      title: isSupplier ? 'Purchased' : 'Bought', dataIndex: 'value', width: 140, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtInt(v)}</span>,
    },
    {
      title: 'Avg bill', dataIndex: 'avg_bill', width: 118, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtInt(v)}</span>,
    },
    {
      title: 'Depth', dataIndex: 'depth', width: 118,
      render: (v, r) => {
        const m = DEPTH_META[v] || DEPTH_META.one_off;
        return (
          <Tooltip title={`${r.bills_per_year} bills per year over the window`}>
            <span className={`rpt-pill type-${m.tone}`}>{m.label}</span>
          </Tooltip>
        );
      },
    },
    {
      // Context only — the party-level balance, never a sum of bill
      // balances. Sign convention differs by direction, so the label
      // is rendered rather than left for the reader to infer.
      title: 'Balance', dataIndex: 'current_balance', width: 150, align: 'right',
      render: (v) => {
        const n = parseFloat(v || 0);
        if (!n) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        const youOwe = n < 0;
        return (
          <div style={{ lineHeight: 1.25 }}>
            <span style={{
              fontVariantNumeric: 'tabular-nums', fontWeight: 700,
              color: youOwe ? 'var(--danger)' : 'var(--fg-primary)',
            }}>
              {fmtInt(Math.abs(n))}
            </span>
            <div style={{ fontSize: 10, color: 'var(--fg-tertiary)' }}>
              {youOwe ? 'you owe' : 'owes you'}
            </div>
          </div>
        );
      },
    },
  ], [isSupplier, nav]);

  const tile = (k) => summary[k] || { count: 0, value: 0 };

  return (
    <div className="report-editorial stf-list" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── HEADER ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Who Stopped Trading</h1>
          <div className="rpt-sub">
            {isSupplier
              ? 'Suppliers who have stopped sending goods'
              : 'Customers who have stopped buying'}
            <span className="sep">·</span>
            <b>{rows.length}</b> shown
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <Segmented
            value={direction}
            onChange={setDirection}
            options={[
              { label: 'Suppliers', value: 'supplier' },
              { label: 'Customers', value: 'customer' },
            ]}
          />
          <Button
            icon={<FileExcelOutlined />}
            onClick={exportExcel}
            loading={exporting}
            className="rpt-btn"
          >
            Export
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load} className="rpt-btn">Refresh</Button>
        </div>
      </div>

      {/* ─── KPI STRIP ─── */}
      <div className="rpt-kpis">
        <div className="rpt-kpi tone-danger">
          <div className="rpt-kpi-k">{isSupplier ? 'Supply At Risk' : 'Trade At Risk'}</div>
          <div className="rpt-kpi-v">{fmtInt(atRisk)}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            quiet more than 90 days
          </div>
        </div>
        <div className="rpt-kpi tone-warning">
          <div className="rpt-kpi-k">Slipping (3-6m)</div>
          <div className="rpt-kpi-v">{tile('slipping').count}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            {fmtInt(tile('slipping').value)}
          </div>
        </div>
        <div className="rpt-kpi tone-danger">
          <div className="rpt-kpi-k">Lapsed (6-12m)</div>
          <div className="rpt-kpi-v">{tile('lapsed').count}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            {fmtInt(tile('lapsed').value)}
          </div>
        </div>
        <div className="rpt-kpi tone-neutral">
          <div className="rpt-kpi-k">Lost (12m+)</div>
          <div className="rpt-kpi-v">{tile('lost').count}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            {fmtInt(tile('lost').value)}
          </div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Still Active</div>
          <div className="rpt-kpi-v">{tile('active').count}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            {fmtInt(tile('active').value)}
          </div>
        </div>
      </div>

      {/* ─── FILTER BAR ─── */}
      <div className="rpt-filter">
        <Input
          ref={searchInputRef}
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder={isSupplier ? 'Search supplier or mobile' : 'Search customer or mobile'}
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
          mode="multiple"
          maxTagCount="responsive"
          placeholder="Relationship depth"
          value={filters.depths}
          onChange={(v) => setFilters((f) => ({ ...f, depths: v }))}
          options={DEPTHS.map((d) => ({ value: d.key, label: d.label }))}
          style={{ minWidth: 200 }}
          size="middle"
        />
        <Select
          value={filters.lookback}
          onChange={(v) => setFilters((f) => ({ ...f, lookback: v }))}
          options={LOOKBACKS}
          style={{ minWidth: 150 }}
          size="middle"
        />
      </div>

      {/* ─── TABLE ─── */}
      <div className="rpt-tbl-wrap">
        <div className="rpt-tbl report-table-scroll stf-tbl-card">
          <Table
            rowKey="party_id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            size="middle"
            scroll={{ x: 1100 }}
            sticky
            locale={{ emptyText: (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                <TeamOutlined style={{ fontSize: 32, opacity: 0.4 }} />
                <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600, color: 'var(--fg-secondary)' }}>
                  Nobody in the selected buckets
                </div>
                <div style={{ fontSize: 12 }}>Toggle the chips above to widen the view.</div>
              </div>
            ) }}
          />
          {rows.length > 0 && (
            <div className="stf-tbl-foot">
              <span className="stf-tbl-foot-lbl">Total ({rows.length})</span>
              <span className="stf-tbl-foot-spacer" />
              <span className="stf-tbl-foot-val money">
                {fmtInt(rows.reduce((s, r) => s + parseFloat(r.value || 0), 0))}
              </span>
              <span className="stf-tbl-foot-pad" />
            </div>
          )}
        </div>
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: () => nav('/reports') },
          { id: 'find', key: 'F4', label: 'Find', onAction: () => searchInputRef.current?.focus?.() },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: () => load() },
          {
            id: 'flip', key: 'F6', label: isSupplier ? 'Customers' : 'Suppliers',
            onAction: () => setDirection(isSupplier ? 'customer' : 'supplier'),
          },
          { id: 'export', key: 'F7', label: 'Export', onAction: () => exportExcel() },
          { id: 'print', key: 'F9', label: 'Print', onAction: () => window.print() },
        ]}
      />
    </div>
  );
}
