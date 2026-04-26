// ── Trial Balance ──────────────────────────────────────────────────────
//
// One row per ledger account with closing Dr or Cr balance for the
// selected period. Grouped by ledger_group → sub_group. Total Dr must
// equal Total Cr to the paisa; mismatches show as a red banner.
//
// Click any ledger row → drills into the existing party-ledger view
// (for party ledgers) or a synthetic ledger-detail view filtered to
// the same period for system ledgers.

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Table, Tag, Typography, Space, Button, Alert, DatePicker, Select, message, Statistic, Row, Col } from 'antd';
import { PrinterOutlined, FileExcelOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI, settingsAPI } from '../../api';

const { Title, Text } = Typography;

const fmtINR = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCount = (v) => Number(v || 0).toLocaleString('en-IN');

// Quick preset → [from, to] dayjs pair, computed against the firm's FY.
function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy')   return [dayjs(fyStart),         dayjs(fyEnd)];
  if (key === 'last_fy')   return [dayjs(fyStart).subtract(1, 'year'), dayjs(fyEnd).subtract(1, 'year')];
  if (key === 'this_q')    return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month')return [today.startOf('month'),   today.endOf('month')];
  return null;  // custom
}

export default function TrialBalance() {
  const navigate = useNavigate();
  const [data, setData]     = useState(null);
  const [loading, setLoad]  = useState(true);
  const [fyStart, setFyS]   = useState(null);
  const [fyEnd, setFyE]     = useState(null);
  const [preset, setPreset] = useState('this_fy');
  const [from, setFrom]     = useState(null);
  const [to, setTo]         = useState(null);

  // Bootstrap with the firm's FY then snap to "This FY" by default.
  useEffect(() => {
    settingsAPI.getSystem().then(({ data: s }) => {
      const sys = s?.data || s || {};
      if (sys.financial_year_start) setFyS(sys.financial_year_start.slice(0, 10));
      if (sys.financial_year_end)   setFyE(sys.financial_year_end.slice(0, 10));
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!fyStart || !fyEnd) return;
    if (preset === 'custom') return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) { setFrom(r[0].format('YYYY-MM-DD')); setTo(r[1].format('YYYY-MM-DD')); }
  }, [preset, fyStart, fyEnd]);

  useEffect(() => {
    if (!from || !to) return;
    setLoad(true);
    reportAPI.trialBalance({ from_date: from, to_date: to })
      .then((r) => setData(r.data))
      .catch((e) => message.error(e.response?.data?.error || 'Failed to load Trial Balance'))
      .finally(() => setLoad(false));
  }, [from, to]);

  const grouped = useMemo(() => {
    if (!data?.ledgers) return [];
    const buckets = new Map();
    for (const r of data.ledgers) {
      const key = `${r.ledger_group} · ${r.sub_group || '(Uncategorised)'}`;
      if (!buckets.has(key)) buckets.set(key, { key, ledger_group: r.ledger_group, sub_group: r.sub_group, rows: [], dr: 0, cr: 0 });
      const b = buckets.get(key);
      b.rows.push(r);
      b.dr += Number(r.debit) || 0;
      b.cr += Number(r.credit) || 0;
    }
    return [...buckets.values()];
  }, [data]);

  const handleRowClick = (row) => {
    if (row.is_party_ledger && row.party_id) {
      navigate(`/reports/party-ledger?party_id=${row.party_id}&from=${from}&to=${to}`);
    } else {
      // System ledger drilldown — use existing PartyLedger view in
      // ledger-account mode (it already accepts an account filter).
      navigate(`/reports/party-ledger?ledger_id=${row.ledger_id}&from=${from}&to=${to}`);
    }
  };

  const columns = [
    { title: 'Account', dataIndex: 'ledger_name', key: 'name',
      render: (v, row) => (
        <a onClick={() => handleRowClick(row)}>
          {v}{' '}
          {row.is_party_ledger && <Tag color="blue" style={{ marginLeft: 4 }}>Party</Tag>}
        </a>
      ),
    },
    { title: 'Debit',  dataIndex: 'debit',  key: 'dr', align: 'right', width: 160,
      render: (v) => v > 0 ? <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtINR(v)}</span> : '—' },
    { title: 'Credit', dataIndex: 'credit', key: 'cr', align: 'right', width: 160,
      render: (v) => v > 0 ? <span style={{ fontFamily: 'Geist Mono, monospace' }}>₹ {fmtINR(v)}</span> : '—' },
  ];

  const t = data?.totals || {};
  return (
    <div>
      <Card>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap' }}>
          <Title level={4} style={{ margin: 0 }}>Trial Balance</Title>
          <Space wrap>
            <Select value={preset} onChange={setPreset} style={{ width: 140 }}
              options={[
                { value: 'this_fy',    label: 'This FY' },
                { value: 'last_fy',    label: 'Last FY' },
                { value: 'this_q',     label: 'This Quarter' },
                { value: 'this_month', label: 'This Month' },
                { value: 'custom',     label: 'Custom Range' },
              ]} />
            <DatePicker.RangePicker
              value={from && to ? [dayjs(from), dayjs(to)] : null}
              onChange={(v) => { setPreset('custom'); setFrom(v?.[0]?.format('YYYY-MM-DD') || null); setTo(v?.[1]?.format('YYYY-MM-DD') || null); }}
              format="YYYY-MM-DD"
            />
            <Button icon={<ReloadOutlined />} onClick={() => { if (from && to) { setLoad(true); reportAPI.trialBalance({ from_date: from, to_date: to }).then((r) => setData(r.data)).finally(() => setLoad(false)); } }}>Refresh</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
            <Button icon={<FileExcelOutlined />} onClick={() => exportExcel(data)}>Excel</Button>
          </Space>
        </Space>

        {data && !t.balanced && (
          <Alert type="error" showIcon style={{ marginBottom: 16 }}
            message="Trial balance does not balance"
            description={`Debits and credits differ by ₹${fmtINR(t.difference)}. Run Reconciliation in Settings → Ledger Integrity.`}
            action={<Button size="small" onClick={() => navigate('/accounts/integrity')}>Open Integrity</Button>}
          />
        )}

        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title="Total Debits" prefix="₹" value={fmtINR(t.debit)}
                valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="Total Credits" prefix="₹" value={fmtINR(t.credit)}
                valueStyle={{ fontFamily: 'Geist Mono, monospace' }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="# Accounts" value={fmtCount(t.accounts_count)} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" style={{ borderColor: t.balanced ? '#52c41a' : '#ff4d4f' }}>
              <Statistic title="Difference (must be 0)" prefix="₹" value={fmtINR(t.difference)}
                valueStyle={{
                  color: t.balanced ? '#52c41a' : '#ff4d4f',
                  fontFamily: 'Geist Mono, monospace',
                }} />
            </Card>
          </Col>
        </Row>

        {grouped.length === 0 && !loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-tertiary, #888)' }}>
            No ledger activity in this period.
          </div>
        ) : (
          grouped.map((g) => (
            <Card key={g.key} size="small" style={{ marginBottom: 12 }}
              title={<span><b>{g.ledger_group}</b> <Text type="secondary">· {g.sub_group || '(Uncategorised)'}</Text></span>}
              extra={
                <Space size="large">
                  <span style={{ fontFamily: 'Geist Mono, monospace' }}>Dr ₹{fmtINR(g.dr)}</span>
                  <span style={{ fontFamily: 'Geist Mono, monospace' }}>Cr ₹{fmtINR(g.cr)}</span>
                </Space>
              }>
              <Table size="small" pagination={false} columns={columns} rowKey="ledger_id"
                dataSource={g.rows} showHeader={false} />
            </Card>
          ))
        )}
      </Card>
    </div>
  );
}

async function exportExcel(data) {
  if (!data?.ledgers) return;
  // Lazy-load exceljs to keep the initial bundle small.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Trial Balance');
  ws.columns = [
    { header: 'Group',    key: 'g',   width: 16 },
    { header: 'Sub-group',key: 'sg',  width: 24 },
    { header: 'Account',  key: 'n',   width: 36 },
    { header: 'Debit',    key: 'dr',  width: 18 },
    { header: 'Credit',   key: 'cr',  width: 18 },
  ];
  for (const r of data.ledgers) {
    ws.addRow({ g: r.ledger_group, sg: r.sub_group || '', n: r.ledger_name, dr: r.debit || '', cr: r.credit || '' });
  }
  const t = data.totals || {};
  ws.addRow({});
  ws.addRow({ n: 'TOTAL', dr: t.debit || 0, cr: t.credit || 0 });
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = `trial-balance-${data.period?.from}-to-${data.period?.to}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
