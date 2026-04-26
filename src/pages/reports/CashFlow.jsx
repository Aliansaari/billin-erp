// ── Cash Flow Statement ────────────────────────────────────────────────
//
// Three sections — Operating, Investing, Financing — derived from the
// other-side classification of every cash/bank-touching voucher in
// the period. Reconciliation panel at the bottom: Opening + Net = Closing
// (paisa-exact).

import React, { useEffect, useState } from 'react';
import { Card, Table, Typography, Space, Button, Alert, DatePicker, Select, message, Statistic, Row, Col, Tag } from 'antd';
import { PrinterOutlined, FileExcelOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI, settingsAPI } from '../../api';

const { Title, Text } = Typography;
const fmt = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy')   return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'last_fy')   return [dayjs(fyStart).subtract(1, 'year'), dayjs(fyEnd).subtract(1, 'year')];
  if (key === 'this_q')    return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month')return [today.startOf('month'), today.endOf('month')];
  return null;
}

export default function CashFlow() {
  const [data, setData]   = useState(null);
  const [loading, setLd]  = useState(true);
  const [fyStart, setFyS] = useState(null);
  const [fyEnd, setFyE]   = useState(null);
  const [preset, setPr]   = useState('this_fy');
  const [from, setFrom]   = useState(null);
  const [to, setTo]       = useState(null);

  useEffect(() => {
    settingsAPI.getSystem().then(({ data: s }) => {
      const sys = s?.data || s || {};
      if (sys.financial_year_start) setFyS(sys.financial_year_start.slice(0, 10));
      if (sys.financial_year_end)   setFyE(sys.financial_year_end.slice(0, 10));
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!fyStart || !fyEnd || preset === 'custom') return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); }
  }, [preset, fyStart, fyEnd]);
  useEffect(() => {
    if (!from || !to) return;
    setLd(true);
    reportAPI.cashFlow({ from_date: from, to_date: to })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Cash Flow'))
      .finally(() => setLd(false));
  }, [from, to]);

  const t = data?.totals || {};
  const recon = data?.reconciliation || {};

  const sectionCols = [
    { title: 'Date',  dataIndex: 'entry_date',   key: 'd', width: 120 },
    { title: 'Voucher', dataIndex: 'entry_number', key: 'v', width: 180 },
    { title: 'Other side', dataIndex: 'contra_label', key: 'c', ellipsis: true },
    { title: 'Cash impact', dataIndex: 'cash_impact', key: 'a', align: 'right', width: 160,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', color: v >= 0 ? '#52c41a' : '#ff4d4f' }}>
        {v >= 0 ? '+' : '−'} ₹ {fmt(Math.abs(v))}
      </span> },
  ];

  const renderSection = (title, rows = [], total = 0) => (
    <Card size="small" style={{ marginBottom: 12 }}
      title={<b>{title}</b>}
      extra={<span style={{ fontFamily: 'Geist Mono, monospace', color: total >= 0 ? '#52c41a' : '#ff4d4f' }}>
        Net: {total >= 0 ? '+' : '−'} ₹ {fmt(Math.abs(total))}
      </span>}>
      {rows.length === 0
        ? <Text type="secondary">No activity in this period.</Text>
        : <Table size="small" pagination={false} columns={sectionCols} rowKey="entry_number" dataSource={rows} />}
    </Card>
  );

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>Cash Flow Statement</Title>
          <Space wrap>
            <Select value={preset} onChange={setPr} style={{ width: 140 }}
              options={[
                { value: 'this_fy', label: 'This FY' },
                { value: 'last_fy', label: 'Last FY' },
                { value: 'this_q', label: 'This Quarter' },
                { value: 'this_month', label: 'This Month' },
                { value: 'custom', label: 'Custom Range' },
              ]} />
            <DatePicker.RangePicker
              value={from && to ? [dayjs(from), dayjs(to)] : null}
              onChange={(v) => { setPr('custom'); setFrom(v?.[0]?.format('YYYY-MM-DD') || null); setTo(v?.[1]?.format('YYYY-MM-DD') || null); }}
              format="YYYY-MM-DD" />
            <Button icon={<ReloadOutlined />} onClick={() => { setLd(true); reportAPI.cashFlow({ from_date: from, to_date: to }).then((r) => setData(r.data)).finally(() => setLd(false)); }}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileExcelOutlined />} onClick={() => exportXls(data)}>Excel</Button>
          </Space>
        </Space>

        {data && !recon.balanced && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }}
            message="Cash flow attribution does not match cash balance change"
            description={`Attributed: ₹${fmt(recon.attributed_change)}, Computed: ₹${fmt(recon.computed_change)}, Difference: ₹${fmt((recon.attributed_change || 0) - (recon.computed_change || 0))}.`} />
        )}

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}><Card size="small"><Statistic title="Operating" prefix="₹" value={fmt(t.operating)} valueStyle={{ fontFamily: 'Geist Mono, monospace', color: (t.operating || 0) >= 0 ? '#52c41a' : '#ff4d4f' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Investing" prefix="₹" value={fmt(t.investing)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Financing" prefix="₹" value={fmt(t.financing)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Net Change in Cash" prefix="₹" value={fmt(t.net_change)} valueStyle={{ fontFamily: 'Geist Mono, monospace', color: (t.net_change || 0) >= 0 ? '#52c41a' : '#ff4d4f' }} /></Card></Col>
        </Row>

        {renderSection('Operating Activities', data?.sections?.operating, t.operating || 0)}
        {renderSection('Investing Activities', data?.sections?.investing, t.investing || 0)}
        {renderSection('Financing Activities', data?.sections?.financing, t.financing || 0)}

        <Card size="small" style={{ background: 'var(--surface-2)' }} title={<b>Cash Reconciliation</b>}>
          <Row gutter={16}>
            <Col span={6}><Statistic title="Opening Cash + Bank" prefix="₹" value={fmt(recon.opening)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Col>
            <Col span={6}><Statistic title="+ Net Change" prefix="₹" value={fmt(recon.computed_change)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Col>
            <Col span={6}><Statistic title="= Closing Cash + Bank" prefix="₹" value={fmt(recon.closing)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Col>
            <Col span={6}>
              <Tag color={recon.balanced ? 'green' : 'red'} style={{ fontFamily: 'Geist Mono, monospace' }}>
                {recon.balanced ? 'Reconciled' : `Drift ₹ ${fmt((recon.attributed_change || 0) - (recon.computed_change || 0))}`}
              </Tag>
            </Col>
          </Row>
        </Card>
      </Card>
    </div>
  );
}

async function exportXls(data) {
  if (!data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash Flow');
  ws.addRow(['Period', `${data.period?.from} to ${data.period?.to}`]);
  ws.addRow([]);
  for (const [name, key] of [['Operating', 'operating'], ['Investing', 'investing'], ['Financing', 'financing']]) {
    ws.addRow([name]);
    ws.addRow(['Date', 'Voucher', 'Other side', 'Cash impact']);
    for (const r of (data.sections?.[key] || [])) {
      ws.addRow([r.entry_date, r.entry_number, r.contra_label, Number(r.cash_impact)]);
    }
    ws.addRow(['', '', `${name} net`, Number(data.totals?.[key] || 0)]);
    ws.addRow([]);
  }
  ws.addRow(['Net Change', '', '', Number(data.totals?.net_change || 0)]);
  ws.addRow(['Opening Cash + Bank', '', '', Number(data.reconciliation?.opening || 0)]);
  ws.addRow(['Closing Cash + Bank', '', '', Number(data.reconciliation?.closing || 0)]);
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = `cash-flow-${data.period?.from}-to-${data.period?.to}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
