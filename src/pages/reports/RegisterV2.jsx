// ── Sales / Purchase Register (Phase R3) ───────────────────────────────
//
// Bill-by-bill listing for a chosen period. Same layout for both —
// `kind` prop ('sales' | 'purchase') swaps the data source, columns,
// and party label. No pagination — registers are intended to be the
// audit/reconciliation view of the period.

import React, { useEffect, useState } from 'react';
import { Card, Table, Typography, Space, Button, Alert, DatePicker, Select, message, Statistic, Row, Col, Tag } from 'antd';
import { PrinterOutlined, FileExcelOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI, settingsAPI } from '../../api';

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

export default function RegisterV2({ kind = 'sales' }) {
  const isSales = kind === 'sales';
  const navigate = useNavigate();
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
    const api = isSales ? reportAPI.salesRegister : reportAPI.purchaseRegister;
    api({ from_date: from, to_date: to })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load register'))
      .finally(() => setLd(false));
  }, [from, to, kind]);

  const totals = data?.totals || {};
  const numCol = (val) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmt(val)}</span>;

  const cols = [
    { title: 'Date', dataIndex: 'bill_date', key: 'd', width: 110, fixed: 'left' },
    { title: 'Bill No', dataIndex: 'bill_number', key: 'n', width: 130, fixed: 'left',
      render: (v, row) => (
        <a onClick={() => navigate(isSales ? `/sale/edit/${row.sales_bill_id}` : `/purchase/edit/${row.purchase_bill_id}`)}>
          {v}
        </a>
      ),
    },
    { title: isSales ? 'Customer' : 'Supplier',
      dataIndex: isSales ? 'customer_name' : 'supplier_name', key: 'p', width: 220 },
    { title: 'GSTIN', dataIndex: 'gstin', key: 'g', width: 150,
      render: (v) => v ? <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</Tag> : '—' },
    { title: 'Taxable',  dataIndex: 'taxable',  key: 't',  align: 'right', width: 110, render: numCol },
    { title: 'Discount', dataIndex: 'discount', key: 'di', align: 'right', width: 100, render: numCol },
    { title: 'CGST',     dataIndex: 'cgst',     key: 'cg', align: 'right', width: 90,  render: numCol },
    { title: 'SGST',     dataIndex: 'sgst',     key: 'sg', align: 'right', width: 90,  render: numCol },
    { title: 'IGST',     dataIndex: 'igst',     key: 'ig', align: 'right', width: 90,  render: numCol },
    { title: 'Total',    dataIndex: 'total',    key: 'tt', align: 'right', width: 120,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>₹ {fmt(v)}</span> },
    { title: 'Paid',     dataIndex: 'paid',     key: 'pd', align: 'right', width: 110, render: numCol },
    { title: 'Balance',  dataIndex: 'balance',  key: 'b',  align: 'right', width: 110,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', color: v > 0 ? '#ff4d4f' : undefined }}>{fmt(v)}</span> },
    { title: 'Status', dataIndex: 'status', key: 's', width: 90,
      render: (v) => <Tag color={v === 'Paid' ? 'green' : v === 'Partial' ? 'orange' : 'red'}>{v}</Tag> },
  ];

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>
            {isSales ? 'Sales Register' : 'Purchase Register'}
          </Title>
          <Space wrap>
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
            <Button icon={<ReloadOutlined />} onClick={() => {
              if (!from || !to) return;
              setLd(true);
              const api = isSales ? reportAPI.salesRegister : reportAPI.purchaseRegister;
              api({ from_date: from, to_date: to }).then((r) => setData(r.data)).finally(() => setLd(false));
            }}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileExcelOutlined />} onClick={() => exportXls(data, isSales)}>Excel</Button>
          </Space>
        </Space>

        {data && data.reconciliation && !data.reconciliation.balanced && (() => {
          const r = data.reconciliation;
          const ledgerNet = isSales ? r.ledger_net_credit : r.ledger_net_debit;
          const side = isSales ? 'Cr' : 'Dr';
          return (
            <Alert type="warning" showIcon style={{ marginBottom: 16 }}
              message={`${isSales ? 'Sales' : 'Purchase'} ledger does not reconcile to register`}
              description={
                <div style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
                  <div>{r.ledger_name} net {side}: <b>₹{fmt(ledgerNet)}</b></div>
                  <div>vs register: sub ₹{fmt(r.register_taxable)} − disc ₹{fmt(r.register_discount)} + freight ₹{fmt(r.register_freight)} + other ₹{fmt(r.register_other)} = <b>₹{fmt(r.register_net_to_ledger)}</b></div>
                  <div>Difference: <b style={{ color: '#ff4d4f' }}>₹{fmt(r.difference)}</b></div>
                  <div style={{ marginTop: 8, fontFamily: 'inherit', fontSize: 13, color: 'var(--fg-secondary, #aaa)' }}>
                    Likely causes: manual JV against the {r.ledger_name} that bypasses billing, or an amount-mode bill with a sub_total/total_amount mismatch.
                  </div>
                </div>
              }
            />
          );
        })()}

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}><Card size="small"><Statistic title="Bills" value={totals.bills_count || 0} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Taxable" prefix="₹" value={fmt(totals.taxable)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="GST" prefix="₹" value={fmt((totals.cgst || 0) + (totals.sgst || 0) + (totals.igst || 0) + (totals.cess || 0))} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} /></Card></Col>
          <Col span={6}><Card size="small"><Statistic title="Total" prefix="₹" value={fmt(totals.total)} valueStyle={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }} /></Card></Col>
        </Row>

        <Table size="small" pagination={{ pageSize: 50, showSizeChanger: true }}
          columns={cols} rowKey={isSales ? 'sales_bill_id' : 'purchase_bill_id'}
          dataSource={data?.bills || []} loading={loading}
          scroll={{ x: 1500 }}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={4}><b>Period totals</b></Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">{numCol(totals.taxable)}</Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">{numCol(totals.discount)}</Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">{numCol(totals.cgst)}</Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right">{numCol(totals.sgst)}</Table.Summary.Cell>
              <Table.Summary.Cell index={8} align="right">{numCol(totals.igst)}</Table.Summary.Cell>
              <Table.Summary.Cell index={9} align="right"><span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>₹ {fmt(totals.total)}</span></Table.Summary.Cell>
              <Table.Summary.Cell index={10} align="right">{numCol(totals.paid)}</Table.Summary.Cell>
              <Table.Summary.Cell index={11} align="right">{numCol(totals.balance)}</Table.Summary.Cell>
              <Table.Summary.Cell index={12} />
            </Table.Summary.Row>
          )}
        />
      </Card>
    </div>
  );
}

async function exportXls(data, isSales) {
  if (!data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(isSales ? 'Sales Register' : 'Purchase Register');
  ws.columns = [
    { header: 'Date', key: 'd', width: 12 },
    { header: 'Bill No', key: 'n', width: 18 },
    { header: isSales ? 'Customer' : 'Supplier', key: 'p', width: 32 },
    { header: 'GSTIN', key: 'g', width: 18 },
    { header: 'State', key: 'st', width: 14 },
    { header: 'Taxable', key: 'tx', width: 12 },
    { header: 'Discount', key: 'di', width: 12 },
    { header: 'CGST', key: 'cg', width: 10 },
    { header: 'SGST', key: 'sg', width: 10 },
    { header: 'IGST', key: 'ig', width: 10 },
    { header: 'Cess', key: 'ce', width: 10 },
    { header: 'Total', key: 'tt', width: 14 },
    { header: 'Paid', key: 'pd', width: 12 },
    { header: 'Balance', key: 'b', width: 12 },
    { header: 'Status', key: 's', width: 10 },
  ];
  for (const r of (data.bills || [])) {
    ws.addRow({
      d: r.bill_date, n: r.bill_number, p: isSales ? r.customer_name : r.supplier_name,
      g: r.gstin, st: r.state, tx: r.taxable, di: r.discount, cg: r.cgst,
      sg: r.sgst, ig: r.igst, ce: r.cess, tt: r.total, pd: r.paid,
      b: r.balance, s: r.status,
    });
  }
  const t = data.totals || {};
  ws.addRow({});
  ws.addRow({ p: 'TOTAL', tx: t.taxable, di: t.discount, cg: t.cgst,
    sg: t.sgst, ig: t.igst, ce: t.cess, tt: t.total, pd: t.paid, b: t.balance });
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `${isSales ? 'sales' : 'purchase'}-register-${data.from}_to_${data.to}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
