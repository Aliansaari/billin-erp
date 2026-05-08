// ── Expense Report ────────────────────────────────────────────────
//
// Three rollups against the same filter set:
//
//   • By head (expense ledger) — biggest spends first; click a row
//     to drill into that head's voucher list.
//   • By month (YYYY-MM)        — trailing 12 by default; bar chart-ish
//     visual with proportional fill.
//   • By party (vendor)         — top 50 spenders.
//
// Filters: date range, payment mode, vendor, expense head. All four
// flow into /api/expenses/summary in one round-trip.

import React, { useEffect, useMemo, useState } from 'react';
import { Card, DatePicker, Select, Typography, Space, Table, Tag, message, Statistic } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { expenseAPI, partyAPI, ledgerAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import ActionStrip from '../../components/keyboard/ActionStrip';

const { Title, Text } = Typography;

const MONO = 'Geist Mono, ui-monospace, monospace';
const fmt = (v) => parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupee = (v) => '₹ ' + fmt(v);

export default function ExpenseReport() {
  const navigate = useNavigate();
  const { fyStart, fyEnd } = useFinancialYear();

  const [filters, setFilters] = useState({
    from_date: fyStart, to_date: fyEnd,
    payment_mode: null, party_id: null, expense_ledger_id: null,
  });

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [parties, setParties] = useState([]);
  const [ledgers, setLedgers] = useState([]);

  useEffect(() => {
    partyAPI.getAll({ limit: 5000 }).then((r) => {
      setParties((r.data?.data || []).filter((p) => p.is_active !== false && !p.is_system_cash));
    }).catch(() => {});
    ledgerAPI.listAccounts().then((r) => {
      setLedgers((r.data?.data || []).filter((l) => l.ledger_group === 'Expenses' && l.is_active !== false));
    }).catch(() => {});
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const params = {
        from_date: filters.from_date || undefined,
        to_date:   filters.to_date   || undefined,
        payment_mode: filters.payment_mode || undefined,
        party_id:     filters.party_id || undefined,
        expense_ledger_id: filters.expense_ledger_id || undefined,
      };
      const res = await expenseAPI.summary(params);
      setData(res.data);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to load report.');
    }
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [JSON.stringify(filters)]);

  const totals = data?.totals || {};
  const byHead = data?.by_head || [];
  const byMonth = data?.by_month || [];
  const byParty = data?.by_party || [];

  const maxByMonth = useMemo(() => byMonth.reduce((m, r) => Math.max(m, Number(r.line_total) || 0), 0) || 1, [byMonth]);
  const maxByHead  = useMemo(() => byHead.reduce((m, r) => Math.max(m, Number(r.line_total) || 0), 0) || 1, [byHead]);
  const maxByParty = useMemo(() => byParty.reduce((m, r) => Math.max(m, Number(r.line_total) || 0), 0) || 1, [byParty]);

  const headCols = [
    { title: '#', key: 'rank', width: 50, render: (_, __, idx) => <span style={{ color: '#9ca3af' }}>{idx + 1}</span> },
    { title: 'Expense Head', dataIndex: 'ledger_name', key: 'ledger_name',
      render: (v, r) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 500 }}>{v}</span>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.sub_group}</Text>
        </Space>
      ) },
    { title: 'Vouchers', dataIndex: 'voucher_count', width: 100, align: 'right',
      render: (v) => <span style={{ fontFamily: MONO }}>{v}</span> },
    { title: 'Taxable', dataIndex: 'taxable_total', width: 130, align: 'right',
      render: (v) => <span style={{ fontFamily: MONO }}>{fmt(v)}</span> },
    { title: 'GST', dataIndex: 'gst_total', width: 110, align: 'right',
      render: (v) => Number(v) > 0
        ? <span style={{ fontFamily: MONO }}>{fmt(v)}</span>
        : <span style={{ color: '#9ca3af' }}>—</span> },
    { title: 'Total Spend', dataIndex: 'line_total', width: 200, align: 'right',
      render: (v) => (
        <Space size={8} style={{ width: '100%', justifyContent: 'flex-end' }}>
          <span style={{ flex: 1, height: 6, background: 'rgba(220,38,38,0.08)', borderRadius: 3, position: 'relative', maxWidth: 120 }}>
            <span style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${(Number(v) / maxByHead) * 100}%`,
              background: 'rgba(220,38,38,0.55)',
              borderRadius: 3,
            }} />
          </span>
          <strong style={{ fontFamily: MONO, color: '#dc2626' }}>{rupee(v)}</strong>
        </Space>
      ) },
  ];

  const partyCols = [
    { title: '#', key: 'rank', width: 50, render: (_, __, idx) => <span style={{ color: '#9ca3af' }}>{idx + 1}</span> },
    { title: 'Vendor', dataIndex: 'party_name', key: 'name',
      render: (v) => v || <span style={{ color: '#9ca3af' }}>(unassigned cash spend)</span> },
    { title: 'Vouchers', dataIndex: 'voucher_count', width: 100, align: 'right',
      render: (v) => <span style={{ fontFamily: MONO }}>{v}</span> },
    { title: 'Total Spend', dataIndex: 'line_total', width: 220, align: 'right',
      render: (v) => (
        <Space size={8} style={{ width: '100%', justifyContent: 'flex-end' }}>
          <span style={{ flex: 1, height: 6, background: 'rgba(2,132,199,0.08)', borderRadius: 3, position: 'relative', maxWidth: 140 }}>
            <span style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${(Number(v) / maxByParty) * 100}%`,
              background: 'rgba(2,132,199,0.55)',
              borderRadius: 3,
            }} />
          </span>
          <strong style={{ fontFamily: MONO, color: '#0369a1' }}>{rupee(v)}</strong>
        </Space>
      ) },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Card
        bordered={false}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 0 }}
        bodyStyle={{ padding: 24 }}
      >
        <Title level={4} style={{ margin: '0 0 12px' }}>Expense Report</Title>
        <Text type="secondary">Where the money is going — by head, by month, by vendor.</Text>

        {/* ── Filter bar ───────────────────────────────────────── */}
        <Space wrap style={{ marginTop: 16, marginBottom: 16 }}>
          <DatePicker.RangePicker
            format="DD-MM-YYYY"
            value={[filters.from_date ? dayjs(filters.from_date) : null, filters.to_date ? dayjs(filters.to_date) : null]}
            onChange={(v) => setFilters((f) => ({ ...f,
              from_date: v?.[0]?.format('YYYY-MM-DD') || null,
              to_date:   v?.[1]?.format('YYYY-MM-DD') || null,
            }))}
          />
          <Select
            placeholder="All modes" allowClear style={{ width: 140 }}
            value={filters.payment_mode}
            onChange={(v) => setFilters((f) => ({ ...f, payment_mode: v || null }))}
            options={[
              { value: 'Cash',   label: 'Cash' },
              { value: 'Bank',   label: 'Bank' },
              { value: 'Credit', label: 'Credit' },
            ]}
          />
          <Select
            placeholder="All vendors" allowClear showSearch optionFilterProp="label"
            style={{ width: 220 }}
            value={filters.party_id}
            onChange={(v) => setFilters((f) => ({ ...f, party_id: v || null }))}
            options={parties.map((p) => ({ value: p.party_id, label: p.party_name }))}
          />
          <Select
            placeholder="All expense heads" allowClear showSearch optionFilterProp="label"
            style={{ width: 240 }}
            value={filters.expense_ledger_id}
            onChange={(v) => setFilters((f) => ({ ...f, expense_ledger_id: v || null }))}
            options={ledgers.map((l) => ({ value: l.ledger_id, label: l.ledger_name }))}
          />
        </Space>

        {/* ── KPI strip ───────────────────────────────────────── */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12, marginBottom: 24,
        }}>
          <KpiCard label="Total Spend"   value={rupee(totals.line_total)}   tone="danger" />
          <KpiCard label="Vouchers"      value={fmt(totals.voucher_count).split('.')[0]} sub={`avg ${rupee((Number(totals.line_total) || 0) / Math.max(1, Number(totals.voucher_count) || 1))}`} />
          <KpiCard label="Taxable"       value={rupee(totals.taxable_total)} sub={`+ GST ${rupee(totals.gst_total)}`} />
          <KpiCard label="Paid"          value={rupee(totals.paid_total)}    tone="good" />
          <KpiCard label="Carry to Vendors" value={rupee(totals.unpaid_total)} tone={Number(totals.unpaid_total) > 0 ? 'warn' : 'muted'} />
        </div>

        {/* ── By head ─────────────────────────────────────────── */}
        <Title level={5} style={{ margin: '0 0 8px' }}>By expense head</Title>
        <Table
          rowKey="ledger_id"
          columns={headCols}
          dataSource={byHead}
          loading={loading}
          pagination={false}
          size="small"
          locale={{ emptyText: 'No expenses booked in this range.' }}
          onRow={(r) => ({ onClick: () => navigate(`/expenses?expense_ledger_id=${r.ledger_id}&from_date=${filters.from_date}&to_date=${filters.to_date}`),
            style: { cursor: 'pointer' } })}
        />

        {/* ── By month ────────────────────────────────────────── */}
        <Title level={5} style={{ margin: '24px 0 8px' }}>By month</Title>
        <div style={{ background: 'var(--bg-panel, #fff)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 12 }}>
          {byMonth.length === 0 ? (
            <Text type="secondary">No months in this range.</Text>
          ) : byMonth.map((m) => (
            <div key={m.month} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 130px', alignItems: 'center', gap: 12, padding: '6px 4px' }}>
              <span style={{ fontFamily: MONO }}>{m.month}</span>
              <span style={{ height: 8, background: 'rgba(220,38,38,0.08)', borderRadius: 4, position: 'relative' }}>
                <span style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${(Number(m.line_total) / maxByMonth) * 100}%`,
                  background: 'linear-gradient(90deg, rgba(220,38,38,0.45), rgba(220,38,38,0.7))',
                  borderRadius: 4,
                }} />
              </span>
              <Space size={6} style={{ justifyContent: 'flex-end' }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{m.voucher_count}v</Text>
                <strong style={{ fontFamily: MONO, color: '#dc2626' }}>{rupee(m.line_total)}</strong>
              </Space>
            </div>
          ))}
        </div>

        {/* ── By party ────────────────────────────────────────── */}
        <Title level={5} style={{ margin: '24px 0 8px' }}>By vendor (top 50)</Title>
        <Table
          rowKey={(r) => r.party_id ?? '__cash__'}
          columns={partyCols}
          dataSource={byParty}
          loading={loading}
          pagination={false}
          size="small"
          locale={{ emptyText: 'No vendor expenses in this range.' }}
          onRow={(r) => ({ onClick: () => r.party_id && navigate(`/expenses?party_id=${r.party_id}&from_date=${filters.from_date}&to_date=${filters.to_date}`),
            style: { cursor: r.party_id ? 'pointer' : 'default' } })}
        />
      </Card>

      <ActionStrip
        actions={[
          { id: 'back',    key: 'Esc', label: 'Back',    onAction: () => navigate('/expenses') },
          { id: 'refresh', key: 'F5',  label: 'Refresh', onAction: load },
          { id: 'new',     key: 'F3',  label: 'New Expense', onAction: () => navigate('/expenses/new') },
          { id: 'list',    key: 'F1',  label: 'Open List', tone: 'primary', onAction: () => navigate('/expenses') },
        ]}
      />
    </div>
  );
}

function KpiCard({ label, value, sub, tone = 'muted' }) {
  const colors = {
    good:   { c: '#059669', bg: 'rgba(5,150,105,0.06)' },
    warn:   { c: '#C58A2D', bg: 'rgba(197,138,45,0.06)' },
    danger: { c: '#dc2626', bg: 'rgba(220,38,38,0.06)' },
    muted:  { c: 'var(--fg-primary, #1f2937)', bg: 'var(--bg-panel, #fff)' },
  };
  const t = colors[tone] || colors.muted;
  return (
    <div style={{
      padding: 14,
      borderRadius: 10,
      border: '1px solid var(--border, #e5e7eb)',
      background: t.bg,
    }}>
      <div style={{ fontSize: 11, color: 'var(--fg-tertiary, #6b7280)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: t.c, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--fg-tertiary, #9ca3af)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}
