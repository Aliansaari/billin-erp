// ── Godown Transfer Register ────────────────────────────────────────────
//
// Date-windowed list of stock transfers, grouped/filterable by from/to
// godown and status. Same data as the Inventory → Stock Transfers list
// but framed as a report so it sits alongside the inventory reports an
// operator reviews monthly.
//
// Server contract (operationalReportsController.transferRegister):
//   { from, to, transfers: [...], totals: { count, total_quantity,
//     total_value, by_status: {Draft|In-Transit|Received|Cancelled: n} } }

import React, { useEffect, useState } from 'react';
import { Card, Table, Typography, Space, Button, DatePicker, Select, message, Statistic, Row, Col, Tag, Tooltip } from 'antd';
import { PrinterOutlined, ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI, godownAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';

const { Title } = Typography;
const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_TONE = {
  'Draft':      'default',
  'In-Transit': 'orange',
  'Received':   'green',
  'Cancelled':  'red',
};

function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy')    return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'this_q')     return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'), today.endOf('month')];
  if (key === 'last_30')    return [today.subtract(30, 'day'), today];
  return null;
}

export default function GodownTransferRegister() {
  const nav = useNavigate();
  const { fyStart, fyEnd } = useFinancialYear();
  const [data, setData]   = useState(null);
  const [loading, setLd]  = useState(true);
  const [preset, setPr]   = useState('this_fy');
  const [from, setFrom]   = useState(null);
  const [to, setTo]       = useState(null);
  const [godowns, setGodowns]       = useState([]);
  const [fromGodown, setFromGodown] = useState();
  const [toGodown,   setToGodown]   = useState();
  const [status, setStatus]         = useState();

  useEffect(() => {
    godownAPI.getAll().then(({ data }) => setGodowns(data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!fyStart || !fyEnd || preset === 'custom') return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); }
  }, [preset, fyStart, fyEnd]);

  const load = () => {
    if (!from || !to) return;
    setLd(true);
    reportAPI.transferRegister({
      from_date: from, to_date: to,
      ...(fromGodown ? { from_godown_id: fromGodown } : {}),
      ...(toGodown   ? { to_godown_id: toGodown }     : {}),
      ...(status     ? { status }                     : {}),
    })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Transfer Register'))
      .finally(() => setLd(false));
  };
  useEffect(load, [from, to, fromGodown, toGodown, status]); // eslint-disable-line

  const transfers = data?.transfers || [];
  const totals = data?.totals || {};
  const byStatus = totals.by_status || {};

  const cols = [
    {
      title: 'Transfer #', dataIndex: 'transfer_number', width: 130,
      render: (v, r) => (
        <a onClick={() => nav(`/stock-transfer/edit/${r.transfer_id}`)}
           style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>{v}</a>
      ),
    },
    {
      title: 'Date', dataIndex: 'transfer_date', width: 120,
      render: (v) => v ? dayjs(v).format('DD MMM YYYY') : '—',
    },
    {
      title: 'From → To', key: 'route',
      render: (_, r) => (
        <Space size={6} style={{ whiteSpace: 'nowrap' }}>
          <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>{r.from_code}</span>
          <SwapOutlined style={{ color: 'var(--fg-tertiary, #9ca3af)' }} />
          <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>{r.to_code}</span>
          <Tooltip title={`${r.from_name} → ${r.to_name}`}>
            <span style={{ color: 'var(--fg-tertiary, #9ca3af)', fontSize: 12 }}>
              {r.from_name} → {r.to_name}
            </span>
          </Tooltip>
        </Space>
      ),
    },
    { title: 'Items', dataIndex: 'item_count', width: 80, align: 'right' },
    { title: 'Qty', dataIndex: 'total_quantity', width: 100, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmtN(v)}</span> },
    { title: 'Value', dataIndex: 'total_value', width: 130, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtN(v)}</span> },
    {
      title: 'Status', dataIndex: 'status', width: 120,
      render: (s) => <Tag color={STATUS_TONE[s] || 'default'} style={{ fontWeight: 600 }}>{s}</Tag>,
    },
    { title: 'Notes', dataIndex: 'notes', render: (v) => v || '—', ellipsis: true },
  ];

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>
            <SwapOutlined style={{ marginRight: 8 }} /> Godown Transfer Register
          </Title>
          <Space wrap>
            <Select value={preset} onChange={setPr} style={{ width: 140 }}
              options={[
                { value: 'this_fy', label: 'This FY' },
                { value: 'this_q', label: 'This Quarter' },
                { value: 'this_month', label: 'This Month' },
                { value: 'last_30', label: 'Last 30 days' },
                { value: 'custom', label: 'Custom' },
              ]} />
            {preset === 'custom' && (
              <DatePicker.RangePicker
                value={from && to ? [dayjs(from), dayjs(to)] : null}
                onChange={(r) => { if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); } }} />
            )}
            <Select allowClear placeholder="From godown" value={fromGodown} onChange={setFromGodown} style={{ minWidth: 170 }}
              options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))} />
            <Select allowClear placeholder="To godown" value={toGodown} onChange={setToGodown} style={{ minWidth: 170 }}
              options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))} />
            <Select allowClear placeholder="Status" value={status} onChange={setStatus} style={{ width: 140 }}
              options={['Draft', 'In-Transit', 'Received', 'Cancelled'].map((s) => ({ value: s, label: s }))} />
            <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
          </Space>
        </Space>

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}><Card size="small"><Statistic title="Transfers" value={totals.count || 0} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Total Qty"
            value={fmtN(totals.total_quantity)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Total Value" prefix="₹"
            value={fmtN(totals.total_value)} valueStyle={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }} /></Card></Col>
          <Col span={6}>
            <Card size="small">
              <div style={{ fontSize: 12, color: 'var(--fg-secondary, #6b7280)', marginBottom: 6 }}>By status</div>
              <Space size={6} wrap>
                {Object.entries(byStatus).map(([s, n]) => (
                  <Tag key={s} color={STATUS_TONE[s] || 'default'}>{s}: <b>{n}</b></Tag>
                ))}
                {Object.keys(byStatus).length === 0 && <span style={{ color: 'var(--fg-tertiary)' }}>—</span>}
              </Space>
            </Card>
          </Col>
        </Row>

        <Table
          rowKey="transfer_id"
          loading={loading}
          dataSource={transfers}
          columns={cols}
          pagination={false}
          size="middle"
        />
      </Card>
    </div>
  );
}
