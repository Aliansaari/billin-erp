// ── Balance Sheet ──────────────────────────────────────────────────────
//
// As-of-date snapshot. Liabilities (incl. Capital + Net Profit) on left,
// Assets on right. Identity Σ Assets = Σ Liabilities holds when the
// underlying ledger_entries are balanced; mismatches surface as a
// banner. Stock-in-Hand value (from products) is shown as an
// informational tile but NOT included in the balance check.

import React, { useEffect, useState } from 'react';
import { Card, Table, Typography, Space, Button, Alert, DatePicker, message, Statistic, Row, Col } from 'antd';
import { PrinterOutlined, FileExcelOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';

const { Title, Text } = Typography;
const fmtINR = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function BalanceSheet() {
  const navigate = useNavigate();
  const { fyEnd } = useFinancialYear();
  const [data, setData]    = useState(null);
  // As-of date defaults to the configured FY end (the natural snapshot
  // point for a Balance Sheet). Falls back to today on first install
  // before settings are loaded.
  const [asOf, setAsOf]    = useState(fyEnd || dayjs().format('YYYY-MM-DD'));
  const [userPicked, setUserPicked] = useState(false);
  const [loading, setLoad] = useState(true);

  // If FY arrives after first render (cold-start fetch) and the user
  // hasn't manually picked a date yet, snap to fyEnd.
  useEffect(() => {
    if (fyEnd && !userPicked) setAsOf(fyEnd);
  }, [fyEnd, userPicked]);

  useEffect(() => {
    setLoad(true);
    reportAPI.balanceSheet({ to_date: asOf })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Balance Sheet'))
      .finally(() => setLoad(false));
  }, [asOf]);

  const t = data?.totals || {};
  const lia = data?.liabilities;
  const ast = data?.assets;
  const pl = data?.pl;

  const subGroupCols = [
    { title: 'Account', dataIndex: 'ledger_name', key: 'n' },
    { title: '', dataIndex: 'amount', key: 'a', align: 'right', width: 140,
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtINR(v)}</span> },
  ];

  const renderColumn = (title, totalLabel, total, subGroups, extras = []) => (
    <Card size="small" title={<b>{title}</b>}
      extra={<span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtINR(total)}</span>}>
      {(subGroups || []).map((sg) => (
        <div key={sg.sub_group} style={{ marginBottom: 12 }}>
          <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text strong>{sg.sub_group}</Text>
            <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtINR(sg.total)}</span>
          </Space>
          <Table size="small" pagination={false} showHeader={false}
            columns={subGroupCols} rowKey="ledger_id" dataSource={sg.rows} />
        </div>
      ))}
      {extras.map((x, i) => (
        <Space key={i} style={{ width: '100%', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--surface-3, #333)' }}>
          <Text strong>{x.label}</Text>
          <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtINR(x.amount)}</span>
        </Space>
      ))}
      <Space style={{ width: '100%', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '2px solid var(--surface-2, #444)' }}>
        <Text strong>{totalLabel}</Text>
        <span style={{ fontFamily: 'Geist Mono, monospace', fontSize: 16 }}>₹ {fmtINR(total)}</span>
      </Space>
    </Card>
  );

  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>Balance Sheet</Title>
          <Space wrap>
            <DatePicker value={dayjs(asOf)} onChange={(d) => { if (d) { setAsOf(d.format('YYYY-MM-DD')); setUserPicked(true); } }} format="YYYY-MM-DD" />
            <Button icon={<ReloadOutlined />} onClick={() => { setLoad(true); reportAPI.balanceSheet({ to_date: asOf }).then((r) => setData(r.data)).finally(() => setLoad(false)); }}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileExcelOutlined />} onClick={() => exportExcel(data, asOf)}>Excel</Button>
          </Space>
        </Space>

        {data && !t.balanced && (
          <Alert type="error" showIcon style={{ marginBottom: 16 }}
            message="Balance sheet does not balance"
            description={`Total Assets and Total Liabilities differ by ₹${fmtINR(t.difference)}. Run Reconciliation in Settings → Ledger Integrity.`}
            action={<Button size="small" onClick={() => navigate('/accounts/integrity')}>Open Integrity</Button>}
          />
        )}

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title="As Of" value={asOf} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="Total Assets" prefix="₹" value={fmtINR(t.total_assets)}
                valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="Total Liabilities" prefix="₹" value={fmtINR(t.total_liabilities)}
                valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="Stock Value (informational)" prefix="₹" value={fmtINR(data?.stock_value)}
                valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
            </Card>
          </Col>
        </Row>

        {data && pl && (
          <Card size="small" style={{ marginBottom: 16, background: 'var(--surface-2)' }}>
            <Space size="large" wrap>
              <Text>Period Income: <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtINR(pl.income)}</span></Text>
              <Text>Period Expense: <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtINR(pl.expense)}</span></Text>
              <Text strong style={{ color: pl.net >= 0 ? '#52c41a' : '#ff4d4f' }}>
                Net {pl.net >= 0 ? 'Profit' : 'Loss'}: ₹ {fmtINR(Math.abs(pl.net))}
              </Text>
            </Space>
          </Card>
        )}

        {data && (
          <Row gutter={16}>
            <Col xs={24} md={12}>
              {renderColumn(
                'Liabilities',
                'Total Liabilities',
                lia?.total,
                [...(lia?.sub_groups || []), ...(lia?.capital_sub_groups || [])],
                lia?.net_profit > 0
                  ? [{ label: 'Net Profit (current period)', amount: lia.net_profit }]
                  : [],
              )}
            </Col>
            <Col xs={24} md={12}>
              {renderColumn(
                'Assets',
                'Total Assets',
                ast?.total,
                ast?.sub_groups,
                ast?.net_loss > 0
                  ? [{ label: 'Net Loss (current period)', amount: ast.net_loss }]
                  : [],
              )}
            </Col>
          </Row>
        )}
      </Card>
    </div>
  );
}

async function exportExcel(data, asOf) {
  if (!data) return;
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Balance Sheet');
  ws.addRow(['Balance Sheet · As of ' + asOf]);
  ws.addRow([]);
  ws.addRow(['Side', 'Sub-group', 'Account', 'Amount']);
  const dump = (side, sgs) => {
    for (const sg of sgs || []) {
      for (const r of sg.rows || []) {
        ws.addRow([side, sg.sub_group, r.ledger_name, Number(r.amount) || 0]);
      }
      ws.addRow([side, sg.sub_group + ' total', '', Number(sg.total) || 0]);
    }
  };
  dump('Liabilities', data.liabilities?.sub_groups);
  dump('Capital',     data.liabilities?.capital_sub_groups);
  if (data.liabilities?.net_profit > 0) {
    ws.addRow(['Liabilities', 'P&L', 'Net Profit', data.liabilities.net_profit]);
  }
  dump('Assets', data.assets?.sub_groups);
  if (data.assets?.net_loss > 0) {
    ws.addRow(['Assets', 'P&L', 'Net Loss', data.assets.net_loss]);
  }
  ws.addRow([]);
  ws.addRow(['', '', 'Total Liabilities', Number(data.totals?.total_liabilities) || 0]);
  ws.addRow(['', '', 'Total Assets',      Number(data.totals?.total_assets)      || 0]);
  ws.addRow(['', '', 'Stock Value (informational)', Number(data.stock_value)     || 0]);
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = `balance-sheet-${asOf}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
