import React, { useEffect, useMemo, useState } from 'react';
import { Table, Button, Tag, message, Spin, Tooltip } from 'antd';
import {
  ArrowLeftOutlined, AppstoreOutlined, ReloadOutlined,
  ClockCircleOutlined, DollarOutlined, InboxOutlined, FileTextOutlined,
  PrinterOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { batchAPI } from '../../api';
import './stock-transfer-form.css';

/*
 * Batch detail — header + per-godown stock + ledger movement filtered to
 * this batch + distinct bills touched. Same editorial-report skin used
 * across the list pages, with three stacked card sections inside the
 * scroll body. The movement section is the centerpiece — every receipt
 * / sale / return / transfer that touched this lot, in chronological
 * order, with a running balance per row.
 *
 * Routes here from BatchesList row click and from any future "view this
 * lot" link (e.g. an item line on a sales bill).
 */

const STATUS_TONE = {
  expired:       { tone: 'danger',  label: 'Expired',       desc: 'Past expiry — operator hot-list' },
  expiring_soon: { tone: 'warning', label: 'Expiring Soon', desc: 'Within alert window' },
  active:        { tone: 'success', label: 'Active',        desc: 'In stock, not expiring soon' },
  out_of_stock:  { tone: 'neutral', label: 'Out of Stock',  desc: 'No on-hand at any godown' },
};

const TX_TONE = {
  'Purchase':         'success',
  'Sales':            'warning',
  'Sales Return':     'success',
  'Purchase Return':  'warning',
  'Stock Transfer':   'info',
  'Stock Adjustment': 'neutral',
  'Opening Stock':    'neutral',
};

const fmtN     = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BatchDetail() {
  const nav  = useNavigate();
  const { batch_id: batchId } = useParams();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const { data: payload } = await batchAPI.getById(batchId);
      setData(payload);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Failed to load batch');
      nav('/inventory/batches');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [batchId]);

  const movementColumns = useMemo(() => [
    {
      title: 'Date', dataIndex: 'transaction_date', width: 110,
      render: (v) => v ? dayjs(v).format('DD/MM/YYYY') : '—',
    },
    {
      title: 'Type', dataIndex: 'transaction_type', width: 150,
      render: (v) => <span className={`rpt-pill type-${TX_TONE[v] || 'neutral'}`}>{v}</span>,
    },
    {
      title: 'Reference', dataIndex: 'reference_number', width: 140,
      render: (v) => v ? <span className="rpt-bill-no">{v}</span> : '—',
    },
    {
      title: 'Godown', dataIndex: 'godown_name', width: 140,
      render: (v, r) => v ? <span>{v}<span style={{ color: 'var(--fg-tertiary)', marginLeft: 6, fontSize: 11 }}>{r.godown_code}</span></span> : '—',
    },
    {
      title: 'In', dataIndex: 'quantity_in', width: 90, align: 'right',
      render: (v) => parseFloat(v || 0) > 0
        ? <span style={{ color: 'var(--success)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>+{fmtN(v)}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    {
      title: 'Out', dataIndex: 'quantity_out', width: 90, align: 'right',
      render: (v) => parseFloat(v || 0) > 0
        ? <span style={{ color: 'var(--danger)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>−{fmtN(v)}</span>
        : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>,
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 100, align: 'right',
      render: (v) => parseFloat(v || 0) > 0
        ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-secondary)' }}>₹ {fmtN(v)}</span>
        : '—',
    },
    {
      title: 'Balance', dataIndex: 'running_balance', width: 110, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtN(v)}</span>,
    },
    {
      title: 'Remarks', dataIndex: 'remarks',
      render: (v) => v ? <span style={{ color: 'var(--fg-tertiary)', fontSize: 12 }}>{v}</span> : '—',
    },
  ], []);

  const godownColumns = useMemo(() => [
    {
      title: 'Godown', dataIndex: 'godown_name',
      render: (v, r) => (
        <div>
          <span style={{ fontWeight: 600 }}>{v}</span>
          <span style={{ color: 'var(--fg-tertiary)', marginLeft: 6, fontSize: 11 }}>{r.godown_code}</span>
        </div>
      ),
    },
    {
      title: 'Stock', dataIndex: 'current_stock', width: 140, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtN(v)}</span>,
    },
    {
      title: 'Value', dataIndex: 'value', width: 160, align: 'right',
      render: (v) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtMoney(v)}</span>,
    },
  ], []);

  const billsColumns = useMemo(() => [
    {
      title: 'Date', dataIndex: 'transaction_date', width: 110,
      render: (v) => v ? dayjs(v).format('DD/MM/YYYY') : '—',
    },
    {
      title: 'Bill #', dataIndex: 'reference_number', width: 140,
      render: (v) => v ? <span className="rpt-bill-no">{v}</span> : '—',
    },
    {
      title: 'Type', dataIndex: 'transaction_type', width: 150,
      render: (v) => <span className={`rpt-pill type-${TX_TONE[v] || 'neutral'}`}>{v}</span>,
    },
    {
      title: 'Net Qty', key: 'net_qty', width: 100, align: 'right',
      render: (_, r) => {
        const net = parseFloat(r.qty_in || 0) - parseFloat(r.qty_out || 0);
        const tone = net > 0 ? 'var(--success)' : net < 0 ? 'var(--danger)' : 'var(--fg-tertiary)';
        return <span style={{ color: tone, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{net > 0 ? '+' : ''}{fmtN(net)}</span>;
      },
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 100, align: 'right',
      render: (v) => parseFloat(v || 0) > 0 ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>₹ {fmtN(v)}</span> : '—',
    },
  ], []);

  if (loading || !data) {
    return (
      <div style={{ padding: 32, height: '100%', display: 'grid', placeItems: 'center' }}>
        <Spin tip="Loading batch..." />
      </div>
    );
  }

  const b = data.batch;
  const t = STATUS_TONE[b.status] || STATUS_TONE.active;

  return (
    <div className="report-editorial stf-list" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── HEADER ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title" style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => nav('/inventory/batches')}>Back</Button>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <AppstoreOutlined style={{ color: 'var(--accent)' }} />
              {b.batch_number}
              <span className={`rpt-pill type-${t.tone}`} style={{ marginLeft: 4 }}>{t.label}</span>
            </h1>
            <div className="rpt-sub">
              <b>{b.product_name}</b>
              {b.manufacture_date && <><span className="sep">·</span>Mfd {dayjs(b.manufacture_date).format('DD MMM YY')}</>}
              {b.expiry_date      && <><span className="sep">·</span>Exp {dayjs(b.expiry_date).format('DD MMM YY')}</>}
              {b.notes            && <><span className="sep">·</span><i>{b.notes}</i></>}
            </div>
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <Button icon={<ReloadOutlined />} onClick={load} className="rpt-btn">Refresh</Button>
          <Tooltip title="Print Batch Card — coming soon">
            <Button icon={<PrinterOutlined />} className="rpt-btn"
              onClick={() => message.info('Print Batch Card — coming soon')}>
              Print
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* ─── KPI STRIP ─── */}
      <div className="rpt-kpis">
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Stock on Hand</div>
          <div className="rpt-kpi-v">{fmtN(b.total_stock)}</div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Stock Value</div>
          <div className="rpt-kpi-v">{fmtMoney(b.total_value)}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-tertiary)', marginTop: 4 }}>
            @ ₹{fmtN(b.purchase_rate)} per unit
          </div>
        </div>
        <div className={`rpt-kpi tone-${b.days_to_expiry == null ? 'neutral' : b.days_to_expiry < 0 ? 'danger' : b.days_to_expiry <= data.alert_days ? 'warning' : 'info'}`}>
          <div className="rpt-kpi-k">Days to Expiry</div>
          <div className="rpt-kpi-v">
            {b.days_to_expiry == null ? '—' : b.days_to_expiry < 0 ? `Expired ${Math.abs(b.days_to_expiry)}d ago` : `${b.days_to_expiry}d`}
          </div>
        </div>
        <div className="rpt-kpi tone-neutral">
          <div className="rpt-kpi-k">Bills Touched</div>
          <div className="rpt-kpi-v">{b.bills_count}</div>
        </div>
      </div>

      {/* ─── BODY (scrolls) ─── */}
      <div className="rpt-tbl-wrap" style={{ overflow: 'auto', display: 'block' }}>
        {/* Stock by Godown */}
        <div className="bd-section">
          <div className="bd-section-hd">
            <InboxOutlined style={{ color: 'var(--accent)' }} />
            <span className="bd-section-title">Stock by Godown</span>
            <span className="bd-section-sub">{data.stock_by_godown.length} {data.stock_by_godown.length === 1 ? 'godown' : 'godowns'} hold this batch</span>
          </div>
          <Table
            rowKey={(r) => `${r.godown_id}`}
            dataSource={data.stock_by_godown}
            columns={godownColumns}
            pagination={false}
            size="small"
            locale={{ emptyText: 'No stock at any godown — batch fully drained or never received' }}
          />
        </div>

        {/* Movement */}
        <div className="bd-section">
          <div className="bd-section-hd">
            <ClockCircleOutlined style={{ color: 'var(--accent)' }} />
            <span className="bd-section-title">Movement</span>
            <span className="bd-section-sub">{data.movement.length} {data.movement.length === 1 ? 'transaction' : 'transactions'} · running balance per row</span>
          </div>
          <Table
            rowKey="ledger_id"
            dataSource={data.movement}
            columns={movementColumns}
            pagination={false}
            size="small"
            scroll={{ x: 1100 }}
            locale={{ emptyText: 'No movement yet' }}
          />
        </div>

        {/* Bills Touched */}
        <div className="bd-section">
          <div className="bd-section-hd">
            <FileTextOutlined style={{ color: 'var(--accent)' }} />
            <span className="bd-section-title">Bills Touched</span>
            <span className="bd-section-sub">{data.bills_touched.length} distinct {data.bills_touched.length === 1 ? 'bill' : 'bills'}</span>
          </div>
          <Table
            rowKey={(r) => `${r.transaction_type}-${r.reference_id}`}
            dataSource={data.bills_touched}
            columns={billsColumns}
            pagination={false}
            size="small"
            locale={{ emptyText: 'No bills reference this batch' }}
          />
        </div>
      </div>
    </div>
  );
}
