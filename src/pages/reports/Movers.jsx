// ── Fast / Slow Movers (Phase R3) ──────────────────────────────────────
//
// Two parallel tables: top N by qty sold (Fast) and bottom N by qty
// sold (Slow). "Slow" excludes products that didn't move at all over
// the period — those surface as a separate "dead stock" tile so the
// user can distinguish "moved a little" from "didn't move".

import React, { useEffect, useState } from 'react';
import { Card, Table, Typography, Space, Button, DatePicker, Select, message, Statistic, Row, Col } from 'antd';
import { PrinterOutlined, FileExcelOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI, settingsAPI } from '../../api';

const { Title } = Typography;
const fmt = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQ = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy')    return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'this_q')     return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'), today.endOf('month')];
  if (key === 'last_30')    return [today.subtract(30, 'day'), today];
  if (key === 'last_90')    return [today.subtract(90, 'day'), today];
  return null;
}

export default function Movers() {
  const [data, setData]  = useState(null);
  const [loading, setLd] = useState(true);
  const [preset, setPr]  = useState('last_30');
  const [from, setFrom]  = useState(null);
  const [to, setTo]      = useState(null);
  const [limit, setLimit]= useState(20);
  const [fyStart, setFyS] = useState(null);
  const [fyEnd, setFyE] = useState(null);

  useEffect(() => {
    settingsAPI.getSystem().then(({ data: s }) => {
      const sys = s?.data || s || {};
      if (sys.financial_year_start) setFyS(sys.financial_year_start.slice(0, 10));
      if (sys.financial_year_end)   setFyE(sys.financial_year_end.slice(0, 10));
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (preset === 'custom') return;
    if ((preset === 'this_fy' || preset === 'this_q' || preset === 'this_month') && (!fyStart || !fyEnd)) return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); }
  }, [preset, fyStart, fyEnd]);
  useEffect(() => {
    if (!from || !to) return;
    setLd(true);
    reportAPI.movers({ from_date: from, to_date: to, limit })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Movers'))
      .finally(() => setLd(false));
  }, [from, to, limit]);

  const totals = data?.totals || {};
  const numCol = (val) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmtQ(val)}</span>;

  const baseCols = [
    { title: '#', key: 'rk', width: 50, render: (_, __, i) => i + 1 },
    { title: 'Product', dataIndex: 'product_name', key: 'p' },
    { title: 'Category', dataIndex: 'category_name', key: 'c', width: 130, render: (v) => v || '—' },
    { title: 'Bills', dataIndex: 'bills_touched', key: 'b', width: 70, align: 'right', render: numCol },
    { title: 'Qty sold', dataIndex: 'qty_sold', key: 'q', width: 100, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>{fmtQ(v)}</span> },
    { title: 'Revenue', dataIndex: 'revenue', key: 'r', width: 130, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmt(v)}</span> },
    { title: 'Gross Profit', dataIndex: 'gross_profit', key: 'gp', width: 130, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', color: v < 0 ? '#ff4d4f' : v > 0 ? '#52c41a' : undefined }}>₹ {fmt(v)}</span> },
  ];

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>Fast & Slow Movers</Title>
          <Space wrap>
            <Select value={preset} onChange={setPr} style={{ width: 150 }}
              options={[
                { value: 'last_30', label: 'Last 30 days' },
                { value: 'last_90', label: 'Last 90 days' },
                { value: 'this_month', label: 'This Month' },
                { value: 'this_q', label: 'This Quarter' },
                { value: 'this_fy', label: 'This FY' },
                { value: 'custom', label: 'Custom' },
              ]} />
            {preset === 'custom' && (
              <DatePicker.RangePicker
                value={from && to ? [dayjs(from), dayjs(to)] : null}
                onChange={(r) => { if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); } }} />
            )}
            <Select value={limit} onChange={setLimit} style={{ width: 110 }}
              options={[10, 20, 50, 100].map((n) => ({ value: n, label: `Top ${n}` }))} />
            <Button icon={<ReloadOutlined />} onClick={() => {
              if (!from || !to) return;
              setLd(true);
              reportAPI.movers({ from_date: from, to_date: to, limit }).then((r) => setData(r.data)).finally(() => setLd(false));
            }}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileExcelOutlined />} onClick={() => exportXls(data)}>Excel</Button>
          </Space>
        </Space>

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}><Card size="small"><Statistic title="Active products" value={totals.products_active || 0} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Products that moved" value={totals.products_moved || 0} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Dead stock (no movement)" value={totals.dead_stock_count || 0}
            valueStyle={{ color: (totals.dead_stock_count || 0) > 0 ? '#ff4d4f' : undefined }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Period revenue" prefix="₹" value={fmt(totals.revenue)}
            valueStyle={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }} /></Card></Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Card size="small" title={<b>🔥 Fast Movers (top {limit})</b>}>
              <Table size="small" pagination={false} columns={baseCols}
                rowKey="product_id" dataSource={data?.fast || []} loading={loading} />
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" title={<b>🐌 Slow Movers (bottom {limit}, excl. zero-sales)</b>}>
              <Table size="small" pagination={false} columns={baseCols}
                rowKey="product_id" dataSource={data?.slow || []} loading={loading} />
            </Card>
          </Col>
        </Row>
      </Card>
    </div>
  );
}

async function exportXls(data) {
  if (!data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const cols = [
    { header: 'Rank', key: 'rk', width: 6 },
    { header: 'Product', key: 'p', width: 32 },
    { header: 'Category', key: 'c', width: 18 },
    { header: 'Bills', key: 'b', width: 8 },
    { header: 'Qty sold', key: 'q', width: 12 },
    { header: 'Revenue', key: 'r', width: 14 },
    { header: 'COGS', key: 'cg', width: 14 },
    { header: 'Gross Profit', key: 'gp', width: 14 },
  ];
  for (const [name, list] of [['Fast Movers', data.fast || []], ['Slow Movers', data.slow || []]]) {
    const ws = wb.addWorksheet(name);
    ws.columns = cols;
    list.forEach((r, i) => {
      ws.addRow({
        rk: i + 1, p: r.product_name, c: r.category_name,
        b: r.bills_touched, q: r.qty_sold, r: r.revenue,
        cg: r.cogs, gp: r.gross_profit,
      });
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `movers-${data.from}_to_${data.to}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
