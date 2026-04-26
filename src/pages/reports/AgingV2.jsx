// ── Receivables / Payables Aging (Phase R2) ───────────────────────────
//
// Bill-level granularity. Buckets 0-30 / 31-60 / 61-90 / 90+ days from
// bill_date relative to as_of_date. Cross-reconciles to the Sundry
// Debtors / Creditors total in the Trial Balance for the same as-of
// — drift surfaces as a banner.
//
// Used twice — `kind` prop is 'receivable' (default route /reports/
// receivables-aging) or 'payable' (/reports/payables-aging).

import React, { useEffect, useState } from 'react';
import { Card, Table, Typography, Space, Button, Alert, DatePicker, Select, message, Statistic, Row, Col, Tag } from 'antd';
import { PrinterOutlined, FileExcelOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';

const { Title, Text } = Typography;
const fmt = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function AgingV2({ kind = 'receivable' }) {
  const navigate = useNavigate();
  const [data, setData]  = useState(null);
  const [asOf, setAsOf]  = useState(dayjs().format('YYYY-MM-DD'));
  const [sort, setSort]  = useState('amount_desc');
  const [loading, setLd] = useState(true);

  const isRecv = kind === 'receivable';

  useEffect(() => {
    setLd(true);
    const api = isRecv ? reportAPI.receivablesAging : reportAPI.payablesAging;
    api({ as_of_date: asOf })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Aging'))
      .finally(() => setLd(false));
  }, [asOf, kind]);

  const totals = data?.totals || { buckets: {} };
  const recon = data?.reconciliation || {};

  const sorted = (() => {
    const arr = (data?.parties || []).slice();
    if (sort === 'amount_desc')   arr.sort((a, b) => b.total - a.total);
    if (sort === 'oldest_first')  arr.sort((a, b) => b.oldest_days - a.oldest_days);
    if (sort === 'alphabetical')  arr.sort((a, b) => String(a.party_name).localeCompare(String(b.party_name)));
    return arr;
  })();

  const cols = [
    { title: 'Party', dataIndex: 'party_name', key: 'p',
      render: (v, row) => <a onClick={() => navigate(`/reports/party-ledger?party_id=${row.party_id}`)}>{v}</a> },
    { title: 'Bills', dataIndex: 'bills_count', key: 'b', width: 70, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</span> },
    { title: 'Oldest', dataIndex: 'oldest_days', key: 'o', width: 90, align: 'right',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v} d</span> },
    { title: '0–30',  dataIndex: ['buckets', '0_30'],   key: 'b1', align: 'right', width: 130,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v > 0 ? `₹ ${fmt(v)}` : '—'}</span> },
    { title: '31–60', dataIndex: ['buckets', '31_60'],  key: 'b2', align: 'right', width: 130,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v > 0 ? `₹ ${fmt(v)}` : '—'}</span> },
    { title: '61–90', dataIndex: ['buckets', '61_90'],  key: 'b3', align: 'right', width: 130,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{v > 0 ? `₹ ${fmt(v)}` : '—'}</span> },
    { title: '90+',   dataIndex: ['buckets', 'over_90'], key: 'b4', align: 'right', width: 130,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', color: v > 0 ? '#ff4d4f' : undefined }}>{v > 0 ? `₹ ${fmt(v)}` : '—'}</span> },
    { title: 'Total', dataIndex: 'total', key: 't', align: 'right', width: 150,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace', fontWeight: 600 }}>₹ {fmt(v)}</span> },
  ];

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>{isRecv ? 'Receivables Aging' : 'Payables Aging'}</Title>
          <Space wrap>
            <DatePicker value={dayjs(asOf)} onChange={(d) => d && setAsOf(d.format('YYYY-MM-DD'))} />
            <Select value={sort} onChange={setSort} style={{ width: 160 }}
              options={[
                { value: 'amount_desc',  label: 'Amount desc' },
                { value: 'oldest_first', label: 'Oldest first' },
                { value: 'alphabetical', label: 'A–Z' },
              ]} />
            <Button icon={<ReloadOutlined />} onClick={() => { setLd(true); (isRecv ? reportAPI.receivablesAging : reportAPI.payablesAging)({ as_of_date: asOf }).then((r) => setData(r.data)).finally(() => setLd(false)); }}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileExcelOutlined />} onClick={() => exportXls(data, isRecv)}>Excel</Button>
          </Space>
        </Space>

        {data && !recon.balanced && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }}
            message={`${isRecv ? 'Receivables' : 'Payables'} do not reconcile to ledger`}
            description={`Bill outstanding total: ₹${fmt(recon.bill_outstanding_total)}; ${recon.sub_group} ledger total: ₹${fmt(recon.ledger_group_total)}; Difference: ₹${fmt(recon.difference)}.`} />
        )}

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title={`Total ${isRecv ? 'Receivables' : 'Payables'}`} prefix="₹" value={fmt(totals.total)} valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title={`# of parties with ${isRecv ? 'dues' : 'payables'}`} value={totals.parties_count || 0} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="Oldest Outstanding" value={`${totals.oldest_days || 0} days`} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="Total Bills" value={totals.bills_count || 0} />
            </Card>
          </Col>
        </Row>

        <Card size="small" style={{ marginBottom: 12 }} title={<b>Bucket Totals</b>}>
          <Space size="large" wrap>
            <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>0–30: ₹{fmt(totals.buckets['0_30'])}</Tag>
            <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>31–60: ₹{fmt(totals.buckets['31_60'])}</Tag>
            <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>61–90: ₹{fmt(totals.buckets['61_90'])}</Tag>
            <Tag color={totals.buckets['over_90'] > 0 ? 'red' : 'default'} style={{ fontFamily: 'Geist Mono, monospace' }}>90+: ₹{fmt(totals.buckets['over_90'])}</Tag>
          </Space>
        </Card>

        {sorted.length === 0 && !loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-tertiary, #888)' }}>
            No outstanding {isRecv ? 'receivables' : 'payables'} as of {asOf}.
          </div>
        ) : (
          <Table size="small" pagination={{ pageSize: 50 }} columns={cols}
            rowKey="party_id" dataSource={sorted} loading={loading} />
        )}
      </Card>
    </div>
  );
}

async function exportXls(data, isRecv) {
  if (!data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(isRecv ? 'Receivables Aging' : 'Payables Aging');
  ws.columns = [
    { header: 'Party', key: 'p', width: 32 },
    { header: 'Mobile', key: 'm', width: 14 },
    { header: 'GSTIN', key: 'g', width: 18 },
    { header: 'Bills', key: 'bn', width: 7 },
    { header: 'Oldest (days)', key: 'o', width: 12 },
    { header: '0-30', key: 'b1', width: 14 },
    { header: '31-60', key: 'b2', width: 14 },
    { header: '61-90', key: 'b3', width: 14 },
    { header: '90+', key: 'b4', width: 14 },
    { header: 'Total', key: 't', width: 14 },
  ];
  for (const p of (data.parties || [])) {
    ws.addRow({
      p: p.party_name, m: p.mobile_1, g: p.gstin, bn: p.bills_count,
      o: p.oldest_days,
      b1: p.buckets['0_30'], b2: p.buckets['31_60'],
      b3: p.buckets['61_90'], b4: p.buckets['over_90'],
      t: p.total,
    });
  }
  const t = data.totals || { buckets: {} };
  ws.addRow({});
  ws.addRow({ p: 'TOTAL', bn: t.bills_count,
    b1: t.buckets['0_30'], b2: t.buckets['31_60'], b3: t.buckets['61_90'], b4: t.buckets['over_90'],
    t: t.total });
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `${isRecv ? 'receivables' : 'payables'}-aging-${data.as_of}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
