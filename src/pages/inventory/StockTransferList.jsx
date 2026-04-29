import React, { useEffect, useMemo, useState } from 'react';
import { Table, Button, Tag, Space, Input, Select, DatePicker, Popconfirm, message, Tooltip } from 'antd';
import { SwapOutlined, PlusOutlined, EyeOutlined, SendOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { stockTransferAPI, godownAPI } from '../../api';

/*
 * Stock Transfers — list view.
 *
 * Lists godown-to-godown movements. Status drives the available actions:
 *   Draft        → Submit (deduct source) | Cancel | Edit
 *   In-Transit   → Receive (add destination) | Cancel
 *   Received     → View only (terminal)
 *   Cancelled    → View only (terminal)
 *
 * Filters: from godown, to godown, status, date range, free-text on
 * transfer number. All forwarded as query params; server applies
 * allowed_godowns scoping (a transfer is visible if either side touches
 * an allowed godown).
 */

const STATUS_TONE = {
  'Draft':      { color: 'default', desc: 'Items entered, no stock movement yet' },
  'In-Transit': { color: 'orange',  desc: 'Stock deducted from source; awaiting receipt' },
  'Received':   { color: 'green',   desc: 'Stock arrived at destination' },
  'Cancelled':  { color: 'red',     desc: 'Reversed; no stock impact remaining' },
};

const fmtN = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function StockTransferList() {
  const nav = useNavigate();
  const [rows, setRows]         = useState([]);
  const [godowns, setGodowns]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [busy, setBusy]         = useState({});  // per-row busy state for submit/receive/cancel
  const [filters, setFilters]   = useState({
    from_godown_id: undefined,
    to_godown_id:   undefined,
    status:         undefined,
    range:          null,
    q:              '',
  });

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

  const columns = useMemo(() => [
    {
      title: 'Transfer #', dataIndex: 'transfer_number', width: 130,
      render: (v) => <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>{v}</span>,
    },
    {
      title: 'Date', dataIndex: 'transfer_date', width: 120,
      render: (v) => v ? dayjs(v).format('DD MMM YYYY') : '—',
    },
    {
      title: 'From → To', key: 'route', width: 280,
      render: (_, r) => (
        <Space size={8} style={{ whiteSpace: 'nowrap' }}>
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>{r.fromGodown?.code || '—'}</span>
          <SwapOutlined style={{ color: 'var(--fg-tertiary, #9ca3af)' }} />
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>{r.toGodown?.code || '—'}</span>
          <span style={{ color: 'var(--fg-tertiary, #9ca3af)', fontSize: 12 }}>
            ({r.fromGodown?.name} → {r.toGodown?.name})
          </span>
        </Space>
      ),
    },
    {
      title: 'Qty', dataIndex: 'total_quantity', width: 90, align: 'right',
      render: (v) => fmtN(v),
    },
    {
      title: 'Value', dataIndex: 'total_value', width: 120, align: 'right',
      render: (v) => `₹ ${fmtN(v)}`,
    },
    {
      title: 'Status', dataIndex: 'status', width: 130,
      render: (s) => {
        const t = STATUS_TONE[s] || { color: 'default' };
        return <Tooltip title={t.desc}><Tag color={t.color} style={{ fontWeight: 600 }}>{s}</Tag></Tooltip>;
      },
    },
    {
      title: 'Actions', key: 'actions', width: 320, align: 'right',
      render: (_, r) => {
        const b = !!busy[r.transfer_id];
        return (
          <Space size={4}>
            <Button size="small" icon={<EyeOutlined />} onClick={() => nav(`/stock-transfer/edit/${r.transfer_id}`)}>
              {r.status === 'Draft' ? 'Edit' : 'View'}
            </Button>
            {r.status === 'Draft' && (
              <Tooltip title="Deduct from source godown — moves to In-Transit">
                <Button size="small" type="primary" loading={b} icon={<SendOutlined />} onClick={() => onSubmit(r)}>
                  Submit
                </Button>
              </Tooltip>
            )}
            {r.status === 'In-Transit' && (
              <Tooltip title="Add to destination godown — moves to Received">
                <Button size="small" type="primary" loading={b} icon={<CheckCircleOutlined />} onClick={() => onReceive(r)}>
                  Receive
                </Button>
              </Tooltip>
            )}
            {(r.status === 'Draft' || r.status === 'In-Transit') && (
              <Popconfirm
                title={`Cancel ${r.transfer_number}?`}
                description={r.status === 'In-Transit'
                  ? 'Stock at the source will be restored.'
                  : 'No stock has moved — this just marks it cancelled.'}
                okText="Cancel transfer" okButtonProps={{ danger: true }}
                onConfirm={() => onCancel(r)}
              >
                <Button size="small" danger loading={b} icon={<CloseCircleOutlined />}>Cancel</Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ], [busy, nav]); // eslint-disable-line

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <SwapOutlined /> Stock Transfers
        </h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/stock-transfer/new')}>
          New Transfer
        </Button>
      </div>

      <p style={{ color: 'var(--fg-secondary, #6b7280)', marginTop: 0, marginBottom: 14, fontSize: 13 }}>
        Move inventory between godowns. Transfers do not affect books — same legal entity, no GST, no party balance.
      </p>

      {/* Filter strip — godown / status / date range / search */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Select
          allowClear placeholder="From godown"
          value={filters.from_godown_id}
          onChange={(v) => setFilters((f) => ({ ...f, from_godown_id: v }))}
          options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
          style={{ minWidth: 180 }}
        />
        <Select
          allowClear placeholder="To godown"
          value={filters.to_godown_id}
          onChange={(v) => setFilters((f) => ({ ...f, to_godown_id: v }))}
          options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
          style={{ minWidth: 180 }}
        />
        <Select
          allowClear placeholder="Status"
          value={filters.status}
          onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
          options={['Draft','In-Transit','Received','Cancelled'].map((s) => ({ value: s, label: s }))}
          style={{ minWidth: 140 }}
        />
        <DatePicker.RangePicker
          value={filters.range} onChange={(r) => setFilters((f) => ({ ...f, range: r }))}
          format="DD-MM-YYYY" style={{ minWidth: 240 }}
        />
        <Input.Search
          allowClear placeholder="Search transfer #" style={{ maxWidth: 240 }}
          onSearch={(v) => setFilters((f) => ({ ...f, q: v }))}
          onChange={(e) => !e.target.value && setFilters((f) => ({ ...f, q: '' }))}
        />
      </div>

      <Table
        rowKey="transfer_id"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={false}
        size="middle"
        style={{ background: 'var(--bg-elevated, white)' }}
      />

      <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 12, color: 'var(--fg-secondary)' }}>
        <span>{rows.length} transfer(s)</span>
        <span>Total qty: <b>{fmtN(rows.reduce((s, r) => s + parseFloat(r.total_quantity || 0), 0))}</b></span>
        <span>Total value: <b>₹ {fmtN(rows.reduce((s, r) => s + parseFloat(r.total_value || 0), 0))}</b></span>
      </div>
    </div>
  );
}
