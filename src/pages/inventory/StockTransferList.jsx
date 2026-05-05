import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Table, Button, Tag, Input, Select, DatePicker, Modal, message, Tooltip } from 'antd';
import {
  SwapOutlined, PlusOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { stockTransferAPI, godownAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
// Editorial report skin (same .rpt-page-hd / .rpt-kpis / .rpt-filter /
// .rpt-tbl-wrap classes Sales Report / Day Book / Trial Balance use,
// living in src/styles/global.css). Pulls in all theme-aware tinted KPI
// gradients, sticky header / KPI / table / footer layout, and the
// uppercase column headers — no per-page CSS needed.
import './stock-transfer-form.css';

/*
 * Stock Transfers — list view (editorial report skin).
 *
 * Behavioural surface kept identical to the prior list:
 *   • Filters: from_godown_id, to_godown_id, status, date range, search
 *   • Per-row actions: Edit / View / Submit / Receive / Cancel
 *   • KPIs derived from currently-loaded rows (so they reflect filters)
 *   • Footer totals: count, qty, value
 *
 * Visual layer aligned to .rpt-* primitives so the page looks like a
 * sibling of Sales Report — same header rhythm, same KPI card shape,
 * same chip-driven status filter, same scrolling table panel.
 *
 * Period chips (This FY / Last FY / This Q / This Month / Custom) are
 * UI conveniences over the existing date range filter — they pre-fill
 * the range and don't introduce any new server param.
 */

const STATUS_TONE = {
  'Draft':      { color: 'default', desc: 'Items entered, no stock movement yet',         tone: 'neutral' },
  'In-Transit': { color: 'orange',  desc: 'Stock deducted from source; awaiting receipt', tone: 'warning' },
  'Received':   { color: 'green',   desc: 'Stock arrived at destination',                 tone: 'success' },
  'Cancelled':  { color: 'red',     desc: 'Reversed; no stock impact remaining',          tone: 'danger'  },
};

const fmtN     = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (v) => `₹ ${Math.round(parseFloat(v || 0)).toLocaleString('en-IN')}`;

// Period preset → date range. Indian FY (Apr–Mar). Used by the chip
// strip in the header to set filters.range without changing the server
// contract — server still consumes start_date / end_date as today.
function presetRange(preset, today = dayjs()) {
  const fyStart = today.month() < 3 ? today.subtract(1, 'year').month(3).date(1) : today.month(3).date(1);
  const fyEnd   = fyStart.add(1, 'year').subtract(1, 'day');
  switch (preset) {
    case 'this_fy':    return [fyStart.startOf('day'), fyEnd.endOf('day')];
    case 'last_fy':    return [fyStart.subtract(1, 'year'), fyStart.subtract(1, 'day')];
    case 'this_q': {
      const m = today.month(); const qStart = today.month(m - (m % 3)).date(1);
      return [qStart.startOf('day'), qStart.add(3, 'month').subtract(1, 'day').endOf('day')];
    }
    case 'this_month': return [today.startOf('month'), today.endOf('month')];
    default:           return null;
  }
}

export default function StockTransferList() {
  const nav = useNavigate();
  const [rows, setRows]         = useState([]);
  const [godowns, setGodowns]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [busy, setBusy]         = useState({});
  const [preset, setPreset]     = useState('this_fy');
  const [filters, setFilters]   = useState(() => ({
    from_godown_id: undefined,
    to_godown_id:   undefined,
    status:         undefined,
    range:          presetRange('this_fy'),
    q:              '',
  }));

  // Fold preset → range whenever preset changes (except 'custom', where
  // the operator drives the range picker directly).
  useEffect(() => {
    if (preset === 'custom') return;
    const r = presetRange(preset);
    if (r) setFilters((f) => ({ ...f, range: r }));
  }, [preset]);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.from_godown_id) params.from_godown_id = filters.from_godown_id;
      if (filters.to_godown_id)   params.to_godown_id   = filters.to_godown_id;
      if (filters.status)         params.status         = filters.status;
      if (filters.range?.[0])     params.start_date     = filters.range[0].format('YYYY-MM-DD');
      if (filters.range?.[1])     params.end_date       = filters.range[1].format('YYYY-MM-DD');
      if (filters.q)              params.q              = filters.q.trim();
      const { data } = await stockTransferAPI.getAll(params);
      setRows(data || []);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load transfers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    godownAPI.getAll().then(({ data }) => setGodowns(data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters]);

  // Search input ref so the F4 = Find action can focus it from the strip.
  const searchInputRef = useRef(null);

  const setBusyRow = (id, val) => setBusy((b) => ({ ...b, [id]: val }));

  const onSubmit = async (row) => {
    setBusyRow(row.transfer_id, true);
    try {
      await stockTransferAPI.submit(row.transfer_id);
      message.success(`${row.transfer_number} submitted (In-Transit)`);
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Submit failed');
    } finally { setBusyRow(row.transfer_id, false); }
  };
  const onReceive = async (row) => {
    setBusyRow(row.transfer_id, true);
    try {
      await stockTransferAPI.receive(row.transfer_id);
      message.success(`${row.transfer_number} received`);
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Receive failed');
    } finally { setBusyRow(row.transfer_id, false); }
  };
  const onCancel = async (row) => {
    setBusyRow(row.transfer_id, true);
    try {
      await stockTransferAPI.cancel(row.transfer_id, 'Cancelled from list');
      message.success(`${row.transfer_number} cancelled`);
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Cancel failed');
    } finally { setBusyRow(row.transfer_id, false); }
  };

  // ── Selection model — cursor + multi-select.
  // Plain Antd Table here (not VRT). Cursor IS selection; the strip
  // operates on whatever row the cursor is on.
  const sel = useListSelection({ totalCount: rows.length, rows });
  const single        = sel.activeRow;
  const isDraft       = single?.status === 'Draft';
  const isInTransit   = single?.status === 'In-Transit';
  const isOpen        = isDraft || isInTransit;

  // Cancel with confirm — single-row only since each cancel restores
  // stock at the source godown when it was already submitted.
  const cancelCursor = useCallback(() => {
    if (!single) return;
    Modal.confirm({
      title: `Cancel ${single.transfer_number}?`,
      content: isInTransit
        ? 'Stock at the source godown will be restored.'
        : 'No stock has moved — this just marks the transfer cancelled.',
      okText: 'Cancel transfer', okButtonProps: { danger: true },
      cancelText: 'Keep it',
      onOk: () => onCancel(single),
    });
  }, [single, isInTransit]);

  // Scroll-follow the cursor — Antd Table's sticky thead means
  // browser scrollIntoView won't account for header height. Hand-roll
  // the math (same approach as PartyListView).
  useEffect(() => {
    if (sel.cursorIdx == null || !single) return;
    const scroller = document.querySelector('.stf-tbl-card .ant-table-body');
    if (!scroller) return;
    const row = scroller.querySelector(`[data-row-key="${single.transfer_id}"]`);
    if (!row) return;
    const thead = document.querySelector('.stf-tbl-card .ant-table-thead');
    const headH = thead ? thead.offsetHeight : 0;
    const rowRect = row.getBoundingClientRect();
    const scRect  = scroller.getBoundingClientRect();
    const rowTop = rowRect.top    - scRect.top;
    const rowBot = rowRect.bottom - scRect.top;
    if (rowTop < headH) scroller.scrollTop -= (headH - rowTop);
    else if (rowBot > scRect.height) scroller.scrollTop += (rowBot - scRect.height);
  }, [sel.cursorIdx, single]);

  // KPI rollups — derived from the currently-loaded rows so the cards
  // reflect the active filter (rather than always showing all-time
  // counts, which would be misleading next to a filtered table).
  const kpis = useMemo(() => {
    const k = { total: rows.length, draft: 0, inTransit: 0, received: 0, cancelled: 0, totalQty: 0, totalValue: 0 };
    rows.forEach((r) => {
      if (r.status === 'Draft')      k.draft++;
      if (r.status === 'In-Transit') k.inTransit++;
      if (r.status === 'Received')   k.received++;
      if (r.status === 'Cancelled')  k.cancelled++;
      k.totalQty   += parseFloat(r.total_quantity || 0);
      k.totalValue += parseFloat(r.total_value || 0);
    });
    return k;
  }, [rows]);

  // Sub-line under the title. "{n} transfers · FY 2026-27" for FY
  // presets, plain count for custom ranges.
  const subLabel = useMemo(() => {
    if (preset === 'this_fy' && filters.range?.[0]) {
      const y1 = filters.range[0].year(); return `FY ${y1}-${String(y1 + 1).slice(2)}`;
    }
    if (preset === 'last_fy' && filters.range?.[0]) {
      const y1 = filters.range[0].year(); return `FY ${y1}-${String(y1 + 1).slice(2)}`;
    }
    if (preset === 'this_q' && filters.range?.[0])    return `Q${Math.floor(filters.range[0].month() / 3) + 1} ${filters.range[0].year()}`;
    if (preset === 'this_month' && filters.range?.[0]) return filters.range[0].format('MMM YYYY');
    if (filters.range?.[0])                            return `${filters.range[0].format('DD MMM YY')} – ${filters.range[1].format('DD MMM YY')}`;
    return '';
  }, [preset, filters.range]);

  const columns = useMemo(() => [
    {
      title: 'SR', key: 'sr', width: 56, align: 'center',
      render: (_, __, idx) => <span style={{ color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>,
    },
    {
      title: 'Transfer #', dataIndex: 'transfer_number', width: 130,
      render: (v) => <span className="rpt-bill-no">{v}</span>,
    },
    {
      title: 'Date', dataIndex: 'transfer_date', width: 110,
      render: (v) => <span style={{ color: 'var(--fg-secondary)' }}>{v ? dayjs(v).format('DD/MM/YYYY') : '—'}</span>,
    },
    {
      title: 'From → To', key: 'route',
      render: (_, r) => (
        <div className="stf-route">
          <div className="stf-route-side">
            <span className="stf-route-code">{r.fromGodown?.code || '—'}</span>
            <span className="stf-route-name">{r.fromGodown?.name || ''}</span>
          </div>
          <SwapOutlined className="stf-route-arrow" />
          <div className="stf-route-side">
            <span className="stf-route-code">{r.toGodown?.code || '—'}</span>
            <span className="stf-route-name">{r.toGodown?.name || ''}</span>
          </div>
        </div>
      ),
    },
    {
      title: 'Items', dataIndex: 'total_quantity', width: 110, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtN(v)}</span>,
    },
    {
      title: 'Value', dataIndex: 'total_value', width: 150, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtInt(v)}</span>,
    },
    {
      title: 'Status', dataIndex: 'status', width: 130,
      render: (s) => {
        const t = STATUS_TONE[s] || { tone: 'neutral', desc: '' };
        return <Tooltip title={t.desc}><span className={`rpt-pill type-${t.tone}`}>{s}</span></Tooltip>;
      },
    },
    // (Per-row actions column removed — Submit / Receive / Cancel /
    // Edit / View all moved to the bottom ActionStrip and operate on
    // the cursored row.)
  ], []); // eslint-disable-line

  // Status-chip filter — same dot-pill UI as Sales Report's Unpaid /
  // Partial / Paid chips, ours map to the four lifecycle states.
  const statusChips = ['Draft', 'In-Transit', 'Received', 'Cancelled'];

  return (
    <div className="report-editorial stf-list" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── HEADER ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Stock Transfers</h1>
          <div className="rpt-sub">
            <b>{kpis.total}</b> {kpis.total === 1 ? 'transfer' : 'transfers'}
            {subLabel && <><span className="sep">·</span>{subLabel}</>}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <div className="rpt-period">
            {[
              { v: 'this_fy',    l: 'This FY' },
              { v: 'last_fy',    l: 'Last FY' },
              { v: 'this_q',     l: 'This Q' },
              { v: 'this_month', l: 'This Month' },
              { v: 'custom',     l: 'Custom' },
            ].map((p) => (
              <button key={p.v} className={preset === p.v ? 'on' : ''} onClick={() => setPreset(p.v)}>{p.l}</button>
            ))}
          </div>
          <DatePicker.RangePicker
            format="DD/MM/YYYY" className="rpt-date"
            allowClear={false}
            value={filters.range}
            onChange={(v) => {
              setPreset('custom');
              setFilters((f) => ({ ...f, range: v }));
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={load} className="rpt-btn">Refresh</Button>
          <Button icon={<PlusOutlined />} type="primary" onClick={() => nav('/stock-transfer/new')} className="rpt-btn">
            New Transfer
          </Button>
        </div>
      </div>

      {/* ─── KPI STRIP ─── */}
      <div className="rpt-kpis">
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Total Value</div>
          <div className="rpt-kpi-v">{fmtMoney(kpis.totalValue)}</div>
        </div>
        <div className="rpt-kpi tone-neutral">
          <div className="rpt-kpi-k">Total Quantity</div>
          <div className="rpt-kpi-v">{fmtN(kpis.totalQty)}</div>
        </div>
        <div className="rpt-kpi tone-neutral">
          <div className="rpt-kpi-k">Drafts</div>
          <div className="rpt-kpi-v">{kpis.draft}</div>
        </div>
        <div className="rpt-kpi tone-warning">
          <div className="rpt-kpi-k">In Transit</div>
          <div className="rpt-kpi-v">{kpis.inTransit}</div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Received</div>
          <div className="rpt-kpi-v">{kpis.received}</div>
        </div>
        <div className="rpt-kpi tone-danger">
          <div className="rpt-kpi-k">Cancelled</div>
          <div className="rpt-kpi-v">{kpis.cancelled}</div>
        </div>
      </div>

      {/* ─── FILTER BAR — search + status chips + godown selects ─── */}
      <div className="rpt-filter">
        <Input
          ref={searchInputRef}
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder="Search transfer #"
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          allowClear
        />
        <span className="rpt-sep" />
        {statusChips.map((s) => {
          const t = STATUS_TONE[s];
          return (
            <button
              key={s}
              className={`rpt-chip ${filters.status === s ? 'on' : ''}`}
              onClick={() => setFilters((f) => ({ ...f, status: f.status === s ? undefined : s }))}
            >
              <span className={`rpt-dot tone-${t.tone}`} />{s}
            </button>
          );
        })}
        <span className="rpt-sep" />
        <Select
          allowClear placeholder="From godown"
          value={filters.from_godown_id}
          onChange={(v) => setFilters((f) => ({ ...f, from_godown_id: v }))}
          options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
          style={{ minWidth: 180 }}
          size="middle"
        />
        <SwapOutlined style={{ color: 'var(--fg-tertiary)' }} />
        <Select
          allowClear placeholder="To godown"
          value={filters.to_godown_id}
          onChange={(v) => setFilters((f) => ({ ...f, to_godown_id: v }))}
          options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
          style={{ minWidth: 180 }}
          size="middle"
        />
      </div>

      {/* ─── TABLE ─── */}
      {/* Layout discipline: the .stf-tbl-card is the bounded box that
       *  fills the rest of the page. Inside it, the AntD table body
       *  scrolls vertically (its own ant-table-body owns the overflow
       *  via the .rpt-tbl !important rule from global.css), the
       *  ant-table thead is sticky at the top, and our hand-rolled
       *  .stf-tbl-foot below — outside the AntD table — pins to the
       *  bottom of the card so totals stay visible while rows scroll. */}
      <div className="rpt-tbl-wrap">
        <div className="rpt-tbl report-table-scroll stf-tbl-card">
          <Table
            rowKey="transfer_id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            pagination={false}
            size="middle"
            scroll={{ x: 1100 }}
            sticky
            rowClassName={(_record, index) => {
              if (sel.cursorIdx === index)        return 'vrt-row-active';
              if (sel.selectedSet.has(index))     return 'vrt-row-multi';
              return '';
            }}
            onRow={(record, index) => ({
              onClick: (e) => {
                if (e.shiftKey)               { sel.extendTo(index); }
                else if (e.ctrlKey || e.metaKey) { sel.toggleRow(index); }
                else                             { sel.setCursor(index); }
              },
              onDoubleClick: () => record?.transfer_id && nav(`/stock-transfer/edit/${record.transfer_id}`),
            })}
            locale={{ emptyText: (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                <SwapOutlined style={{ fontSize: 32, opacity: 0.4 }} />
                <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600, color: 'var(--fg-secondary)' }}>No transfers in this period</div>
                <div style={{ fontSize: 12 }}>Try widening the date range or clearing filters.</div>
              </div>
            ) }}
          />
          {rows.length > 0 && (
            <div className="stf-tbl-foot">
              <span className="stf-tbl-foot-lbl">Total ({rows.length})</span>
              <span className="stf-tbl-foot-spacer" />
              <span className="stf-tbl-foot-val">{fmtN(kpis.totalQty)}</span>
              <span className="stf-tbl-foot-val money">{fmtInt(kpis.totalValue)}</span>
              <span className="stf-tbl-foot-pad" />
              <span className="stf-tbl-foot-pad" />
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom action strip — F-keys are status-aware:
          F2 Edit only enabled for Draft (read-only otherwise);
          F6 Submit only enabled for Draft (promotes to In-Transit);
          F7 Receive only enabled for In-Transit (promotes to Received);
          F8 Cancel only enabled while open (Draft or In-Transit). */}
      <ActionStrip
        actions={[
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: !single || !isDraft,
            onAction: () => single && nav(`/stock-transfer/edit/${single.transfer_id}`),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: () => nav('/stock-transfer/new'),
          },
          {
            id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus?.(),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => load(),
          },
          {
            id: 'submit', key: 'F6', label: 'Submit',
            disabled: !single || !isDraft || !!busy[single?.transfer_id],
            onAction: () => single && onSubmit(single),
            title: 'Submit — deduct from source, move to In-Transit',
          },
          {
            id: 'receive', key: 'F7', label: 'Receive',
            disabled: !single || !isInTransit || !!busy[single?.transfer_id],
            onAction: () => single && onReceive(single),
            title: 'Mark Received — add to destination godown',
          },
          {
            id: 'cancel', key: 'F8', label: 'Cancel', tone: 'danger',
            disabled: !single || !isOpen || !!busy[single?.transfer_id],
            onAction: cancelCursor,
          },
          {
            id: 'open', key: 'F1', label: isDraft ? 'Edit' : 'Open', tone: 'primary',
            disabled: !single,
            onAction: () => single && nav(`/stock-transfer/edit/${single.transfer_id}`),
          },
        ]}
      />
    </div>
  );
}
