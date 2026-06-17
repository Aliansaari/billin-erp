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
  ReloadOutlined, SwapOutlined,
  FilePdfOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI, godownAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';

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

  // ── Exports ───────────────────────────────────────────────────────
  // Both generated client-side from the loaded data — no extra
  // round-trip, no extra backend endpoints. ExcelJS + jsPDF are
  // already in the bundle (Customer / Supplier Statement use them);
  // lazy-imported so the cold path doesn't pay for them.
  const filenameStem = () => {
    const f = from ? dayjs(from).format('YYYYMMDD') : '';
    const t = to   ? dayjs(to).format('YYYYMMDD')   : '';
    return `transfer-register-${f}_to_${t}`;
  };

  const onExcel = async () => {
    if (!transfers.length) { message.info('Nothing to export.'); return; }
    try {
      const ExcelJS = await import('exceljs').then(m => m.default || m);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Transfer Register');
      ws.addRow(['Transfer #', 'Date', 'From', 'To', 'Items', 'Qty', 'Value', 'Status', 'Notes']);
      ws.getRow(1).font = { bold: true };
      transfers.forEach(t => {
        ws.addRow([
          t.transfer_number,
          t.transfer_date ? dayjs(t.transfer_date).format('DD/MM/YYYY') : '',
          `${t.from_code} — ${t.from_name}`,
          `${t.to_code} — ${t.to_name}`,
          t.item_count || 0,
          parseFloat(t.total_quantity) || 0,
          parseFloat(t.total_value) || 0,
          t.status,
          t.notes || '',
        ]);
      });
      // Totals row at the bottom — same shape the on-screen Summary
      // produces, so the spreadsheet matches what was visible.
      ws.addRow([
        `Total (${transfers.length})`, '', '', '',
        transfers.reduce((s, r) => s + (parseInt(r.item_count, 10) || 0), 0),
        transfers.reduce((s, r) => s + (parseFloat(r.total_quantity) || 0), 0),
        transfers.reduce((s, r) => s + (parseFloat(r.total_value)    || 0), 0),
        '', '',
      ]).font = { bold: true };
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${filenameStem()}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      message.error('Excel export failed.');
    }
  };

  const onPdf = async () => {
    if (!transfers.length) { message.info('Nothing to export.'); return; }
    try {
      const { default: jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
      const company = window.__APP_COMPANY_NAME__ || 'Statement of Account';

      doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(0, 0, 0);
      doc.text(company, 40, 50);
      doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(80);
      doc.text('Godown Transfer Register', 40, 70);

      doc.setFontSize(9).setTextColor(120);
      doc.text(`Period: ${from || 'inception'} to ${to || 'today'}`, 40, 88);

      doc.autoTable({
        startY: 102,
        head: [['Transfer #', 'Date', 'From', 'To', 'Items', 'Qty', 'Value (₹)', 'Status', 'Notes']],
        body: transfers.map(t => [
          t.transfer_number,
          t.transfer_date ? dayjs(t.transfer_date).format('DD/MM/YY') : '',
          `${t.from_code} ${t.from_name ? '— ' + t.from_name : ''}`,
          `${t.to_code} ${t.to_name ? '— ' + t.to_name : ''}`,
          t.item_count || 0,
          fmtN(t.total_quantity),
          fmtN(t.total_value),
          t.status,
          t.notes || '',
        ]),
        foot: [[
          `Total (${transfers.length})`, '', '', '',
          transfers.reduce((s, r) => s + (parseInt(r.item_count, 10) || 0), 0),
          fmtN(transfers.reduce((s, r) => s + (parseFloat(r.total_quantity) || 0), 0)),
          fmtN(transfers.reduce((s, r) => s + (parseFloat(r.total_value)    || 0), 0)),
          '', '',
        ]],
        theme: 'grid',
        styles:     { fontSize: 8, cellPadding: 4, lineColor: [220, 220, 220], lineWidth: 0.4 },
        headStyles: { fillColor: [248, 245, 240], textColor: [70, 70, 70], fontStyle: 'bold', fontSize: 8 },
        footStyles: { fillColor: [248, 245, 240], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 9 },
        columnStyles: {
          0: { cellWidth: 70 },
          1: { cellWidth: 60 },
          2: { cellWidth: 'auto' },
          3: { cellWidth: 'auto' },
          4: { cellWidth: 40,  halign: 'right' },
          5: { cellWidth: 65,  halign: 'right' },
          6: { cellWidth: 75,  halign: 'right' },
          7: { cellWidth: 60 },
          8: { cellWidth: 'auto' },
        },
        margin: { left: 30, right: 30 },
      });

      const generatedAt = dayjs().format('DD MMM YYYY · HH:mm');
      const totalPages = doc.internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8).setTextColor(150);
        doc.text(`Generated ${generatedAt}`, 30, doc.internal.pageSize.getHeight() - 18);
        doc.text(
          `Page ${i} of ${totalPages}`,
          doc.internal.pageSize.getWidth() - 30,
          doc.internal.pageSize.getHeight() - 18,
          { align: 'right' },
        );
      }
      doc.save(`${filenameStem()}.pdf`);
    } catch (err) {
      console.error(err);
      message.error('PDF export failed.');
    }
  };

  const { openDate } = useDatePopup();

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
          <Button className="rpt-btn" icon={<FilePdfOutlined />}   onClick={onPdf}   disabled={!transfers.length}>PDF</Button>
          {/* Excel + Print moved to the bottom strip (F10 / F9). */}
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
            size="small"
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

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => nav('/reports') },
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
            onAction: () => load() },
          { id: 'print', key: 'F9', label: 'Print',
            onAction: () => window.print() },
          { id: 'export', key: 'F10', label: 'Export',
            onAction: () => onExcel(),
            disabled: !transfers.length },
        ]}
      />
    </div>
  );
}
