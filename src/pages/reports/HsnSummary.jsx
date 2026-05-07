// ── HSN Summary (Phase R3) ─────────────────────────────────────────────
//
// Aggregates sales (or purchase) line items by HSN code over a period.
// Required for GSTR-1 Table 12 / GSTR-9. Lines without an HSN code roll
// up under "(no HSN)" so user can spot products that need cleanup.

import React, { useEffect, useState } from 'react';
import { Card, Table, Typography, Space, Button, DatePicker, Select, message, Statistic, Row, Col, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';

const { Title } = Typography;
const fmt = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy')    return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'last_fy')    return [dayjs(fyStart).subtract(1, 'year'), dayjs(fyEnd).subtract(1, 'year')];
  if (key === 'this_q')     return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'), today.endOf('month')];
  return null;
}

export default function HsnSummary() {
  const navigate = useNavigate();
  const [data, setData]  = useState(null);
  const [loading, setLd] = useState(true);
  const [direction, setDir] = useState('sales');
  const [preset, setPr]  = useState('this_fy');
  const [from, setFrom]  = useState(null);
  const [to, setTo]      = useState(null);
  const { fyStart, fyEnd } = useFinancialYear();
  const { openDate } = useDatePopup();
  const refresh = () => {
    if (!from || !to) return;
    setLd(true);
    reportAPI.hsnSummary({ from_date: from, to_date: to, direction })
      .then((r) => setData(r.data)).finally(() => setLd(false));
  };
  useEffect(() => {
    if (!fyStart || !fyEnd || preset === 'custom') return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); }
  }, [preset, fyStart, fyEnd]);
  useEffect(() => {
    if (!from || !to) return;
    setLd(true);
    reportAPI.hsnSummary({ from_date: from, to_date: to, direction })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load HSN'))
      .finally(() => setLd(false));
  }, [from, to, direction]);

  const totals = data?.totals || {};
  const numCol = (val) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmt(val)}</span>;

  const cols = [
    { title: 'HSN',     dataIndex: 'hsn_code',  key: 'h', width: 130,
      render: (v) => <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</Tag> },
    { title: 'UQC',     dataIndex: 'unit_type', key: 'u', width: 80 },
    { title: 'Qty',     dataIndex: 'quantity',  key: 'q', align: 'right', width: 100, render: numCol },
    { title: 'GST %',   dataIndex: 'gst_rate',  key: 'g', align: 'right', width: 80,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{Number(v).toFixed(2)}</span> },
    { title: 'Taxable', dataIndex: 'taxable',   key: 'tx', align: 'right', width: 130, render: numCol },
    { title: 'CGST',    dataIndex: 'cgst',      key: 'c', align: 'right', width: 110, render: numCol },
    { title: 'SGST',    dataIndex: 'sgst',      key: 's', align: 'right', width: 110, render: numCol },
    { title: 'IGST',    dataIndex: 'igst',      key: 'i', align: 'right', width: 110, render: numCol },
    { title: 'Cess',    dataIndex: 'cess',      key: 'ce', align: 'right', width: 100, render: numCol },
    { title: 'Total',   dataIndex: 'total',     key: 't', align: 'right', width: 130,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>₹ {fmt(v)}</span> },
  ];

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>HSN Summary</Title>
          <Space wrap>
            <Select value={direction} onChange={setDir} style={{ width: 130 }}
              options={[
                { value: 'sales', label: 'Sales' },
                { value: 'purchase', label: 'Purchase' },
              ]} />
            <Select value={preset} onChange={setPr} style={{ width: 140 }}
              options={[
                { value: 'this_fy', label: 'This FY' },
                { value: 'last_fy', label: 'Last FY' },
                { value: 'this_q', label: 'This Quarter' },
                { value: 'this_month', label: 'This Month' },
                { value: 'custom', label: 'Custom' },
              ]} />
            {preset === 'custom' && (
              <DatePicker.RangePicker
                value={from && to ? [dayjs(from), dayjs(to)] : null}
                onChange={(r) => { if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); } }} />
            )}
            <Button icon={<ReloadOutlined />} onClick={refresh}>Refresh</Button>
            {/* Print + Excel moved to the bottom strip (F9 / F10). */}
          </Space>
        </Space>

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}><Card size="small"><Statistic title="HSN codes" value={totals.hsn_count || 0} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Total Qty" value={fmt(totals.quantity)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Taxable" prefix="₹" value={fmt(totals.taxable)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="GST" prefix="₹" value={fmt((totals.cgst || 0) + (totals.sgst || 0) + (totals.igst || 0) + (totals.cess || 0))} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
        </Row>

        <Table size="small" pagination={{ pageSize: 100 }} columns={cols}
          rowKey="hsn_code" dataSource={data?.hsn || []} loading={loading}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={2}><b>TOTAL</b></Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">{numCol(totals.quantity)}</Table.Summary.Cell>
              <Table.Summary.Cell index={3} />
              <Table.Summary.Cell index={4} align="right">{numCol(totals.taxable)}</Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">{numCol(totals.cgst)}</Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">{numCol(totals.sgst)}</Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right">{numCol(totals.igst)}</Table.Summary.Cell>
              <Table.Summary.Cell index={8} align="right">{numCol(totals.cess)}</Table.Summary.Cell>
              <Table.Summary.Cell index={9} align="right"><span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>₹ {fmt(totals.total)}</span></Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      </Card>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/reports') },
          { id: 'period', key: 'F2', label: 'Period',
            onAction: () => openDate({
              mode: 'range', title: 'Period',
              value: from && to ? [dayjs(from), dayjs(to)] : null,
              onConfirm: ([f, t]) => {
                setPr('custom');
                setFrom(f.format('YYYY-MM-DD'));
                setTo(t.format('YYYY-MM-DD'));
              },
            }) },
          { id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => refresh() },
          { id: 'print', key: 'F9', label: 'Print',
            onAction: () => window.print() },
          { id: 'export', key: 'F10', label: 'Export',
            onAction: () => exportXls(data, direction) },
        ]}
      />
    </div>
  );
}

async function exportXls(data, direction) {
  if (!data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('HSN Summary');
  ws.columns = [
    { header: 'HSN', key: 'h', width: 14 },
    { header: 'UQC', key: 'u', width: 10 },
    { header: 'Qty', key: 'q', width: 12 },
    { header: 'GST %', key: 'g', width: 8 },
    { header: 'Taxable', key: 'tx', width: 14 },
    { header: 'CGST', key: 'c', width: 12 },
    { header: 'SGST', key: 's', width: 12 },
    { header: 'IGST', key: 'i', width: 12 },
    { header: 'Cess', key: 'ce', width: 10 },
    { header: 'Total', key: 't', width: 14 },
  ];
  for (const r of (data.hsn || [])) {
    ws.addRow({
      h: r.hsn_code, u: r.unit_type, q: r.quantity, g: r.gst_rate,
      tx: r.taxable, c: r.cgst, s: r.sgst, i: r.igst, ce: r.cess, t: r.total,
    });
  }
  const t = data.totals || {};
  ws.addRow({});
  ws.addRow({ h: 'TOTAL', q: t.quantity, tx: t.taxable, c: t.cgst,
    s: t.sgst, i: t.igst, ce: t.cess, t: t.total });
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `hsn-summary-${direction}-${data.from}_to_${data.to}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
