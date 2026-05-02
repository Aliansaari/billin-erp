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
//
// Chrome matches the rest of the editorial report family — same
// .rpt-page-hd / .rpt-period / .rpt-kpis / .rpt-tbl-wrap classes Sales
// Report and Day Book wear, so this report reads as part of the same
// app instead of a one-off.

import React, { useEffect, useMemo, useState } from 'react';
import { Table, Button, DatePicker, Select, Tag, Tooltip, message } from 'antd';
import {
  PrinterOutlined, ReloadOutlined, SwapOutlined, DownloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI, godownAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';

const fmtN = (v) =>
  Number(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Status pill tones — same accent vocabulary the rest of the editorial
// reports use (.rpt-pill colors). Keeps a transfer's state legible at
// a glance without relying on the raw AntD Tag palette.
const STATUS_PILL = {
  'Draft':      'rpt-pill type-neutral',
  'In-Transit': 'rpt-pill type-warning',
  'Received':   'rpt-pill type-success',
  'Cancelled':  'rpt-pill type-danger',
};

// Period preset registry — same labels every other report uses
// (matches Sales Report / Day Book / Trial Balance).
const PRESETS = (fyStart, fyEnd) => {
  const today = dayjs();
  return [
    { v: 'this_fy',    l: 'This FY',
      from: fyStart ? dayjs(fyStart) : today.month(3).startOf('month'),
      to:   fyEnd   ? dayjs(fyEnd)   : today },
    { v: 'this_q',     l: 'This Q',     from: today.startOf('quarter'), to: today.endOf('quarter') },
    { v: 'this_month', l: 'This Month', from: today.startOf('month'),   to: today.endOf('month')   },
    { v: 'last_30',    l: 'Last 30 days', from: today.subtract(30, 'day'), to: today },
    { v: 'custom',     l: 'Custom',     from: null, to: null },
  ];
};

export default function GodownTransferRegister() {
  const nav = useNavigate();
  const { fyStart, fyEnd } = useFinancialYear();

  const [data, setData]    = useState(null);
  const [loading, setLd]   = useState(true);
  const [preset, setPr]    = useState('this_fy');
  const [from, setFrom]    = useState(null);
  const [to,   setTo]      = useState(null);
  const [godowns, setGodowns]       = useState([]);
  const [fromGodown, setFromGodown] = useState();
  const [toGodown,   setToGodown]   = useState();
  const [status, setStatus]         = useState();

  useEffect(() => {
    godownAPI.getAll().then(({ data }) => setGodowns(data || [])).catch(() => {});
  }, []);

  // When a preset is picked (anything but Custom), recompute the
  // from/to dates. Custom leaves them alone — the user drives via
  // the RangePicker.
  useEffect(() => {
    if (!fyStart || !fyEnd || preset === 'custom') return;
    const hit = PRESETS(fyStart, fyEnd).find(p => p.v === preset);
    if (hit?.from && hit?.to) {
      setFrom(hit.from.format('YYYY-MM-DD'));
      setTo  (hit.to.format('YYYY-MM-DD'));
    }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [from, to, fromGodown, toGodown, status]);

  const transfers = data?.transfers || [];
  const totals    = data?.totals || {};
  const byStatus  = totals.by_status || {};

  // Active preset chip — derived, mirrors Sales Report's behavior.
  const activePreset = useMemo(() => {
    const prs = PRESETS(fyStart, fyEnd);
    const hit = prs.find(p =>
      ((p.from?.format('YYYY-MM-DD') || null) === (from || null)) &&
      ((p.to?.format('YYYY-MM-DD')   || null) === (to   || null))
    );
    return hit?.v || 'custom';
  }, [from, to, fyStart, fyEnd]);

  const cols = [
    {
      title: 'Transfer #', dataIndex: 'transfer_number', width: 130,
      render: (v, r) => (
        <a className="rpt-bill-no" onClick={() => nav(`/stock-transfer/edit/${r.transfer_id}`)}>{v}</a>
      ),
    },
    {
      title: 'Date', dataIndex: 'transfer_date', width: 120,
      render: (v) => v ? dayjs(v).format('DD MMM YYYY') : '—',
    },
    {
      title: 'From → To', key: 'route',
      render: (_, r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <b>{r.from_code}</b>
          <SwapOutlined style={{ color: 'var(--fg-tertiary)' }} />
          <b>{r.to_code}</b>
          <Tooltip title={`${r.from_name} → ${r.to_name}`}>
            <span style={{ color: 'var(--fg-tertiary)', fontSize: 12, marginLeft: 4 }}>
              {r.from_name} → {r.to_name}
            </span>
          </Tooltip>
        </span>
      ),
    },
    { title: 'Items', dataIndex: 'item_count', width: 80, align: 'right' },
    { title: 'Qty', dataIndex: 'total_quantity', width: 100, align: 'right',
      render: (v) => fmtN(v) },
    { title: 'Value', dataIndex: 'total_value', width: 130, align: 'right',
      render: (v) => `₹ ${fmtN(v)}` },
    {
      title: 'Status', dataIndex: 'status', width: 120,
      render: (s) => <span className={STATUS_PILL[s] || 'rpt-pill type-neutral'}>{s}</span>,
    },
    { title: 'Notes', dataIndex: 'notes', render: (v) => v || '—', ellipsis: true },
  ];

  return (
    <div className="report-editorial" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ─── Header — title + period preset chips + action buttons ─── */}
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Godown Transfer Register</h1>
          <div className="rpt-sub">
            <b>{transfers.length}</b> transfer{transfers.length === 1 ? '' : 's'}
            {from && to && <><span className="sep">·</span>{dayjs(from).format('DD MMM YY')} – {dayjs(to).format('DD MMM YY')}</>}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <div className="rpt-period">
            {PRESETS(fyStart, fyEnd).map(p => (
              <button
                key={p.v}
                className={activePreset === p.v ? 'on' : ''}
                onClick={() => {
                  setPr(p.v);
                  if (p.v !== 'custom' && p.from && p.to) {
                    setFrom(p.from.format('YYYY-MM-DD'));
                    setTo  (p.to.format('YYYY-MM-DD'));
                  }
                }}
              >
                {p.l}
              </button>
            ))}
          </div>
          <DatePicker.RangePicker
            className="rpt-date"
            allowClear={false}
            format="DD/MM/YYYY"
            value={from && to ? [dayjs(from), dayjs(to)] : null}
            onChange={(r) => {
              if (!r) return;
              setPr('custom');
              setFrom(r[0].format('YYYY-MM-DD'));
              setTo  (r[1].format('YYYY-MM-DD'));
            }}
          />
          <Button className="rpt-btn" icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
          <Button className="rpt-btn" icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
        </div>
      </div>

      {/* ─── KPI strip ─── */}
      <div className="rpt-kpis">
        <div className="rpt-kpi tone-info">
          <div className="rpt-kpi-k">Transfers</div>
          <div className="rpt-kpi-v">{totals.count || 0}</div>
        </div>
        <div className="rpt-kpi tone-neutral">
          <div className="rpt-kpi-k">Total Qty</div>
          <div className="rpt-kpi-v">{fmtN(totals.total_quantity)}</div>
        </div>
        <div className="rpt-kpi tone-accent">
          <div className="rpt-kpi-k">Total Value</div>
          <div className="rpt-kpi-v">₹ {fmtN(totals.total_value)}</div>
        </div>
        <div className="rpt-kpi tone-success">
          <div className="rpt-kpi-k">Received</div>
          <div className="rpt-kpi-v">{byStatus['Received'] || 0}</div>
        </div>
        <div className="rpt-kpi tone-warning">
          <div className="rpt-kpi-k">In-Transit</div>
          <div className="rpt-kpi-v">{byStatus['In-Transit'] || 0}</div>
        </div>
      </div>

      {/* ─── Filter bar — godown + status filters ───
          Inline-styled rather than a class — single use, no need for a
          named CSS rule. Padding matches the rest of the editorial
          page chrome (28px gutters). */}
      <div style={{
        flexShrink: 0,
        display: 'flex',
        gap: 10,
        padding: '12px 28px 0',
        flexWrap: 'wrap',
      }}>
        <Select allowClear placeholder="From godown" value={fromGodown} onChange={setFromGodown}
          style={{ minWidth: 180 }}
          options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))} />
        <Select allowClear placeholder="To godown" value={toGodown} onChange={setToGodown}
          style={{ minWidth: 180 }}
          options={godowns.map((g) => ({ value: g.godown_id, label: `${g.code} — ${g.name}` }))} />
        <Select allowClear placeholder="Status" value={status} onChange={setStatus}
          style={{ width: 150 }}
          options={['Draft', 'In-Transit', 'Received', 'Cancelled'].map((s) => ({ value: s, label: s }))} />
      </div>

      {/* ─── Table ─── */}
      <div className="rpt-tbl-wrap">
        <div className="rpt-tbl report-table-scroll" style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Table
            rowKey="transfer_id"
            loading={loading}
            dataSource={transfers}
            columns={cols}
            pagination={false}
            size="middle"
            scroll={{ y: 'calc(100vh - 360px)' }}
            summary={(pageData) => {
              if (!pageData?.length) return null;
              const sumQty = pageData.reduce((s, r) => s + (parseFloat(r.total_quantity) || 0), 0);
              const sumVal = pageData.reduce((s, r) => s + (parseFloat(r.total_value)    || 0), 0);
              return (
                <Table.Summary fixed>
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={3}><b>Total ({pageData.length})</b></Table.Summary.Cell>
                    <Table.Summary.Cell index={1} align="right">{pageData.reduce((s, r) => s + (parseInt(r.item_count, 10) || 0), 0)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={2} align="right">{fmtN(sumQty)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={3} align="right">₹ {fmtN(sumVal)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={4} colSpan={2} />
                  </Table.Summary.Row>
                </Table.Summary>
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}
