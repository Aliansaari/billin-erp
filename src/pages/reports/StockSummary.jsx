// ── Stock Summary (Phase R3) ───────────────────────────────────────────
//
// Per-product opening / in / out / closing for the period. Pulls from
// stock_ledger so figures tie to ledger movements regardless of any
// drift in products.current_stock. Closing × purchase_rate gives the
// stock value that reconciles with BalanceSheet's Stock Value tile.

import React, { useEffect, useState } from 'react';
import { Card, Table, Typography, Space, Button, DatePicker, Select, Input, message, Statistic, Row, Col, Tag } from 'antd';
import { PrinterOutlined, FileExcelOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI, godownAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';

const { Title } = Typography;
const fmt = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQ = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy')    return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'this_q')     return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'), today.endOf('month')];
  return null;
}

export default function StockSummary() {
  const [data, setData]  = useState(null);
  const [loading, setLd] = useState(true);
  const [preset, setPr]  = useState('this_fy');
  const [from, setFrom]  = useState(null);
  const [to, setTo]      = useState(null);
  const { fyStart, fyEnd } = useFinancialYear();
  const [search, setSearch] = useState('');
  // Optional godown scope. undefined = all godowns (default behaviour);
  // a numeric id restricts In/Out/Opening/Closing to movements at that
  // godown only. The server applies the filter to stock_ledger.godown_id.
  const [godownId, setGodownId] = useState();
  const [godowns,  setGodowns]  = useState([]);
  useEffect(() => {
    godownAPI.getAll().then(({ data }) => setGodowns((data || []).filter((g) => g.is_active))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!fyStart || !fyEnd || preset === 'custom') return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); }
  }, [preset, fyStart, fyEnd]);
  useEffect(() => {
    if (!from || !to) return;
    setLd(true);
    reportAPI.stockSummary({ from_date: from, to_date: to, ...(godownId ? { godown_id: godownId } : {}) })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Stock Summary'))
      .finally(() => setLd(false));
  }, [from, to, godownId]);

  const totals = data?.totals || {};
  const products = (data?.products || []).filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (p.product_name || '').toLowerCase().includes(q)
        || (p.barcode || '').toLowerCase().includes(q)
        || (p.hsn_code || '').toLowerCase().includes(q);
  });

  const numCol = (val) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmtQ(val)}</span>;

  const cols = [
    { title: 'Product', dataIndex: 'product_name', key: 'p', fixed: 'left', width: 250 },
    { title: 'Barcode', dataIndex: 'barcode', key: 'b', width: 130,
      render: (v) => v ? <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</Tag> : '—' },
    { title: 'HSN', dataIndex: 'hsn_code', key: 'h', width: 110,
      render: (v) => v ? <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</span> : '—' },
    { title: 'Unit', dataIndex: 'unit', key: 'u', width: 70 },
    { title: 'Opening',  dataIndex: 'opening_qty',   key: 'o',  align: 'right', width: 100, render: numCol },
    { title: 'In',       dataIndex: 'in_qty',        key: 'in', align: 'right', width: 90,  render: numCol },
    { title: 'Out',      dataIndex: 'out_qty',       key: 'out', align: 'right', width: 90, render: numCol },
    { title: 'Closing',  dataIndex: 'closing_qty',   key: 'c',  align: 'right', width: 100,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', color: v < 0 ? '#ff4d4f' : v === 0 ? 'var(--fg-tertiary, #888)' : undefined, fontWeight: 600 }}>{fmtQ(v)}</span> },
    { title: 'Rate (₹)', dataIndex: 'purchase_rate', key: 'r', align: 'right', width: 100, render: numCol },
    { title: 'Value (₹)', dataIndex: 'closing_value', key: 'v', align: 'right', width: 130,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>₹ {fmt(v)}</span> },
  ];

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>Stock Summary</Title>
          <Space wrap>
            <Input prefix={<SearchOutlined />} placeholder="Search product / barcode / HSN" value={search}
              onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} allowClear />
            <Select
              allowClear placeholder="All godowns"
              value={godownId} onChange={setGodownId} style={{ width: 180 }}
              options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))}
            />
            <Select value={preset} onChange={setPr} style={{ width: 140 }}
              options={[
                { value: 'this_fy', label: 'This FY' },
                { value: 'this_q', label: 'This Quarter' },
                { value: 'this_month', label: 'This Month' },
                { value: 'custom', label: 'Custom' },
              ]} />
            {preset === 'custom' && (
              <DatePicker.RangePicker
                value={from && to ? [dayjs(from), dayjs(to)] : null}
                onChange={(r) => { if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); } }} />
            )}
            <Button icon={<ReloadOutlined />} onClick={() => {
              if (!from || !to) return;
              setLd(true);
              reportAPI.stockSummary({ from_date: from, to_date: to, ...(godownId ? { godown_id: godownId } : {}) })
                .then((r) => setData(r.data)).finally(() => setLd(false));
            }}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileExcelOutlined />} onClick={() => exportXls(data)}>Excel</Button>
          </Space>
        </Space>

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}><Card size="small"><Statistic title="Products" value={totals.products_count || 0} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Movement In (qty)" value={fmtQ(totals.in_qty)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Movement Out (qty)" value={fmtQ(totals.out_qty)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Closing Stock Value" prefix="₹" value={fmt(totals.closing_value)} valueStyle={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }} /></Card></Col>
        </Row>

        <Table size="small" pagination={{ pageSize: 100, showSizeChanger: true }}
          columns={cols} rowKey="product_id" dataSource={products} loading={loading}
          scroll={{ x: 1200 }} />
      </Card>
    </div>
  );
}

async function exportXls(data) {
  if (!data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stock Summary');
  ws.columns = [
    { header: 'Product', key: 'p', width: 32 },
    { header: 'Barcode', key: 'b', width: 14 },
    { header: 'HSN', key: 'h', width: 12 },
    { header: 'Category', key: 'cat', width: 18 },
    { header: 'Unit', key: 'u', width: 8 },
    { header: 'Opening', key: 'o', width: 10 },
    { header: 'In', key: 'in', width: 10 },
    { header: 'Out', key: 'out', width: 10 },
    { header: 'Closing', key: 'c', width: 10 },
    { header: 'Rate', key: 'r', width: 12 },
    { header: 'Value (₹)', key: 'v', width: 14 },
  ];
  for (const p of (data.products || [])) {
    ws.addRow({
      p: p.product_name, b: p.barcode, h: p.hsn_code, cat: p.category_name,
      u: p.unit, o: p.opening_qty, in: p.in_qty, out: p.out_qty,
      c: p.closing_qty, r: p.purchase_rate, v: p.closing_value,
    });
  }
  const t = data.totals || {};
  ws.addRow({});
  ws.addRow({ p: 'TOTAL', o: t.opening_qty, in: t.in_qty, out: t.out_qty,
    c: t.closing_qty, v: t.closing_value });
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `stock-summary-${data.from}_to_${data.to}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
