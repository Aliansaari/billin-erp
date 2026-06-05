// ── Payments & Receipts list ───────────────────────────────────────
//
// Editorial v2 — adopts the shared `blist-page` chrome from Sales /
// Purchase lists so the visual identity is consistent across all
// transaction lists. Reads ALL surface colors from the theme tokens
// in src/theme/themes.css so dark mode works without per-page tweaks.
//
// Layout:
//   blist-page → blist-hd (title + filters + CTAs)
//             → blist-kpi (3 cards: Received / Paid / Net flow)
//             → blist-wrap (VirtualReportTable)
//             → ActionStrip (F-key actions)
//
// KPI numbers come from the server's `summary` aggregate so they
// reflect the FULL filtered set (99k+ rows safe), not just whatever
// chunk the virtualiser has loaded.

import React, { useCallback, useEffect, useState } from 'react';
import { Tag, message, DatePicker, Select, Modal, Tooltip, Dropdown } from 'antd';
import { PlusOutlined, LinkOutlined, SwapOutlined, SettingOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { paymentAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument, shareBillViaWhatsApp, whatsappReady } from '../../services/printer';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../../styles/bill-list.css';

// Optional columns the user can toggle via the Customize popover.
// Mode + remarks default ON to preserve the previous list shape; time
// and phone are off by default (the FY-wide default view stays compact).
const PAYMENT_OPTIONAL_COLS = [
  { key: 'time',    label: 'Time' },
  { key: 'phone',   label: 'Party phone' },
  { key: 'mode',    label: 'Payment mode' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'billref', label: 'From-bill badge (Txn No cell)' },
];
// Toggleable page sections — sticky bottom Total row driven by the
// server-aggregated `summary`. Default ON; switching off only hides
// the row, the KPI cards above stay accurate.
const PAYMENT_SECTIONS = [
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
const COLS_STORAGE_KEY = 'paymentList_cols_v1';
const DEFAULT_COLS = {
  time:     false,
  phone:    false,
  mode:     true,
  remarks:  true,
  billref:  true,
  totalRow: true,
};

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtShort = (v) => {
  const n = parseFloat(v || 0);
  if (n === 0) return '₹ 0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}₹ ${Math.round(abs).toLocaleString('en-IN')}`;
};

// Per-mode chip styling — one row per enum value in
// enum_payment_splits_payment_mode (Cash / Card / UPI / Cheque /
// Bank Transfer / Credit) plus 'NEFT' / 'RTGS' as common synonyms a
// user might type into the (free-text) bill payment_method column.
// Lookup falls back to 'default' (grey) for anything unrecognised, so
// surfacing a new mode never crashes the cell.
const MODE_STYLE = {
  'Cash':           { color: 'green',  label: 'Cash' },
  'Bank Transfer':  { color: 'blue',   label: 'Bank Transfer' },
  'Bank':           { color: 'blue',   label: 'Bank' },
  'NEFT':           { color: 'blue',   label: 'NEFT' },
  'RTGS':           { color: 'blue',   label: 'RTGS' },
  'IMPS':           { color: 'blue',   label: 'IMPS' },
  'Cheque':         { color: 'gold',   label: 'Cheque' },
  'UPI':            { color: 'purple', label: 'UPI' },
  'Card':           { color: 'cyan',   label: 'Card' },
  'Credit':         { color: 'default', label: 'Credit' },
  'Mixed':          { color: 'default', label: 'Mixed' },
};
function ModeChip({ method, splits }) {
  // 1. The denormalised payment_method column is the source of truth
  //    when populated (auto-receipts, manual-create with the new
  //    column). Renders as a single coloured chip.
  // 2. Fallback: legacy rows with NULL payment_method but split data
  //    derive the mode from splits — single split → its mode; multi
  //    splits with distinct modes → 'Mixed'.
  // 3. Fallback²: nothing at all → render an em-dash.
  let mode = method;
  if (!mode && Array.isArray(splits) && splits.length > 0) {
    const distinct = [...new Set(splits.map((s) => s.payment_mode).filter(Boolean))];
    mode = distinct.length === 1 ? distinct[0] : 'Mixed';
  }
  if (!mode) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
  const style = MODE_STYLE[mode] || { color: 'default', label: mode };
  return <Tag color={style.color} style={{ fontSize: 11, fontWeight: 500, margin: 0 }}>{style.label}</Tag>;
}

export default function PaymentList() {
  const { fyStart, fyEnd } = useFinancialYear();
  const navigate = useNavigate();
  // URL-driven initial filters — lets other pages (e.g. Cash Flow
  // Summary's Sundry Debtors / Creditors drill) deep-link into a
  // pre-filtered Payments list. Read once on mount; subsequent user
  // interactions live in `filters` state. Accepted params:
  //   ?transaction_type=Receipt|Payment
  //   ?source=manual|auto_from_bill
  //   ?from_date=YYYY-MM-DD
  //   ?to_date=YYYY-MM-DD
  // Falls back to FY-wide defaults when params are absent.
  const [searchParams] = useSearchParams();
  // Default to company FY for consistency. `source` filter (added in
  // R8 Phase 2) lets the user view manual-entered receipts/payments
  // separately from auto-generated bill-side ones.
  const [filters, setFilters] = useState(() => {
    const tt = searchParams.get('transaction_type');
    const validTT = (tt === 'Receipt' || tt === 'Payment') ? tt : null;
    const src = searchParams.get('source');
    const validSrc = (src === 'manual' || src === 'auto_from_bill') ? src : null;
    return {
      transaction_type: validTT,
      source:           validSrc,
      from_date:        searchParams.get('from_date') || dayjs().format('YYYY-MM-DD'),
      to_date:          searchParams.get('to_date')   || dayjs().format('YYYY-MM-DD'),
    };
  });

  // ── Virtualized data layer ────────────────────────────────────────
  // Server endpoint already returns { total, page, data, summary }. Hook
  // holds a sparse Map of chunks so the user can scroll all 99,999+ rows
  // without front-loading them. `summary` is server-aggregated over the
  // FULL filtered set (not just the current chunk) — feeds the KPIs.
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => paymentAPI.getAll(params),
    filters,
    chunkSize: 200,
  });

  // ── Customize popover (column + section toggles) ────────────────
  // Mirror SalesList / PurchaseList: persisted to localStorage so
  // power users keep their layout across sessions. The badge on the
  // Customize chip counts only optional COLUMNS that are visible —
  // sections (totalRow) live on a separate row of the popover.
  const [cols, setCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(cols)); } catch {}
  }, [cols]);
  // Optional columns only — sections (totalRow) excluded from the badge.
  const visibleOptionalCount = PAYMENT_OPTIONAL_COLS.filter((c) => cols[c.key]).length;

  // ── Selection model ─────────────────────────────────────────────
  const sel = useListSelection({ totalCount, rows });
  const activeRow      = sel.activeRow;
  const selectedRows   = sel.selectedRows;
  const selectionCount = sel.selectionCount;
  const isMulti        = selectionCount > 1;
  const single         = !isMulti ? activeRow : null;
  const singleCancelled = single?.is_cancelled;

  // ── KPI values from server-aggregated `summary` ──────────────────
  const totalReceived = parseFloat(summary?.total_received || 0);
  const totalPaid     = parseFloat(summary?.total_paid     || 0);
  const netFlow       = totalReceived - totalPaid;
  const cReceived     = Number(summary?.count_received || 0);
  const cPaid         = Number(summary?.count_paid     || 0);

  const handlePrint = (record) => printDocument({
    docType: record.transaction_type === 'Receipt' ? 'receipt' : 'payment',
    id: record.transaction_id,
  });
  const docTypeOf = (r) => (r.transaction_type === 'Receipt' ? 'receipt' : 'payment');
  const handleWhatsApp = (r) => shareBillViaWhatsApp({ docType: docTypeOf(r), id: r.transaction_id });
  // Bulk send selected receipts/payments on WhatsApp (paced, queued).
  const handleBulkWhatsApp = async (rows) => {
    if (!(await whatsappReady())) {
      message.warning('Connect WhatsApp first (Settings → WhatsApp) to send in bulk.');
      return;
    }
    const list = (rows || []).filter((r) => r && !r.is_cancelled && r.party?.mobile_1);
    if (!list.length) { message.warning('No selected entries have a party phone number.'); return; }
    message.info(`Queuing ${list.length} on WhatsApp…`);
    let ok = 0;
    for (const r of list) {
      try { await shareBillViaWhatsApp({ docType: docTypeOf(r), id: r.transaction_id, silent: true, noFallback: true }); ok++; } catch { /* skip */ }
    }
    message.success(`Queued ${ok} on WhatsApp — delivering with safe pacing.`);
  };

  // Bulk-cancel — confirm once, run cancels serially, summary at end.
  const handleBulkCancel = useCallback((rowsToCancel) => {
    const cancellable = rowsToCancel.filter(r => r && !r.is_cancelled);
    if (cancellable.length === 0) {
      message.info('Nothing to cancel — selection is already cancelled.');
      return;
    }
    Modal.confirm({
      title: cancellable.length === 1
        ? `Cancel ${cancellable[0].transaction_type.toLowerCase()} ${cancellable[0].transaction_number}?`
        : `Cancel ${cancellable.length} transactions?`,
      content: 'This reverses the payment and updates each party balance.',
      okText: cancellable.length === 1 ? 'Yes, Cancel' : `Cancel ${cancellable.length}`,
      okButtonProps: { danger: true },
      cancelText: 'No',
      onOk: async () => {
        let ok = 0, fail = 0;
        for (const r of cancellable) {
          try { await paymentAPI.cancel(r.transaction_id); ok++; }
          catch { fail++; }
        }
        refresh();
        if (fail === 0) message.success(`Cancelled ${ok} transaction${ok === 1 ? '' : 's'}.`);
        else message.warning(`${ok} cancelled, ${fail} failed.`);
      },
    });
  }, [refresh]);

  const columns = [
    { title: 'Txn No', dataIndex: 'transaction_number', width: 180, key: 'txn_no',
      // Auto-receipts get a "📎 From bill" badge linking to the source
      // bill. Manual rows render plain. Bill-deep-link via the existing
      // /sale/edit and /purchase/edit routes. Badge can be hidden via
      // Customize → "From-bill badge" for a denser cell.
      render: (v, r) => (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--fg-primary)', fontWeight: 500 }}>{v}</span>
          {cols.billref && r.source === 'auto_from_bill' && r.source_bill_id && (
            <Tooltip title={`Auto-generated from ${r.transaction_type === 'Receipt' ? 'sales' : 'purchase'} bill ${r.reference_bill_number || r.source_bill_id}. Click to open.`}>
              <Tag
                color="blue"
                style={{ fontSize: 10, cursor: 'pointer', margin: 0 }}
                icon={<LinkOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  const path = r.transaction_type === 'Receipt'
                    ? `/sale/edit/${r.source_bill_id}`
                    : `/purchase/edit/${r.source_bill_id}`;
                  navigate(path);
                }}
              >
                From bill
              </Tag>
            </Tooltip>
          )}
        </span>
      ) },
    { title: 'Type', dataIndex: 'transaction_type', width: 90, key: 'type',
      render: (t) => <Tag color={t === 'Receipt' ? 'green' : 'volcano'} style={{ margin: 0 }}>{t}</Tag> },
    { title: 'Date', dataIndex: 'transaction_date', width: 110, key: 'date',
      render: (v) => <span style={{ color: 'var(--fg-secondary)' }}>{dayjs(v).format('DD/MM/YYYY')}</span> },
    // Optional: time of entry — sourced from createdAt (when the row
    // was inserted), since `transaction_date` is a date-only column
    // and doesn't carry a clock value.
    cols.time && {
      key: 'time', title: 'Time', width: 90,
      render: (_v, r) => {
        const ts = r.createdAt || r.created_at || null;
        return ts
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>{dayjs(ts).format('h:mm a')}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      },
    },
    { title: 'Party', dataIndex: ['party', 'party_name'], width: 200, key: 'party', ellipsis: true,
      render: (v) => <span style={{ color: 'var(--fg-primary)' }}>{v || '—'}</span> },
    // Optional: phone column — pure mobile from party master. Empty
    // for cash-counter receipts where no party is linked.
    cols.phone && {
      key: 'phone', title: 'Phone', width: 130,
      render: (_v, r) => {
        const m = r.party?.mobile_1;
        return m
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>{m}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      },
    },
    // Mode column — sourced from payments_receipts.payment_method
    // (denormalised by auto-receipt sync + manual create from splits).
    // Falls back to deriving from splits[] for legacy rows where the
    // column is still NULL. Coloured chip per mode; see MODE_STYLE.
    cols.mode && { title: 'Mode', width: 110, key: 'mode',
      render: (_v, r) => <ModeChip method={r.payment_method} splits={r.splits} /> },
    { title: 'Amount', dataIndex: 'total_amount', width: 130, align: 'right', key: 'amount',
      render: (v, r) => (
        <span style={{
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color: r.transaction_type === 'Receipt' ? 'var(--success)' : 'var(--danger)',
        }}>
          {fmt(v)}
        </span>
      )},
    cols.remarks && { title: 'Remarks', dataIndex: 'remarks', width: 200, ellipsis: true, key: 'remarks',
      render: (v) => <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{v || '—'}</span> },
    // Cancelled chip stays inline; the row's actions move to the
    // bottom ActionStrip and operate on the cursored row.
    {
      title: '', width: 100, align: 'center', fixed: 'right', key: 'state',
      render: (_, record) => record.is_cancelled
        ? <Tag color="default" style={{ fontSize: 10, margin: 0 }}>Cancelled</Tag>
        : null,
    },
  ].filter(Boolean);

  // ── Sticky bottom Total row (when cols.totalRow is on) ───────────
  // Aggregates from the server-aggregated `summary` so the totals
  // reflect the FULL filtered set, not just whatever's loaded into
  // the virtualizer. Same colSpan-merge pattern as SalesList /
  // PurchaseList: the leading non-aggregable columns merge into one
  // cell holding the "Total (N transactions)" label, and the Amount
  // column carries the net (Receipts − Payments) total in the colour
  // matching the sign.
  const SUMMABLE_KEYS = new Set(['amount']);
  const firstAggIdx = (() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  })();
  const totalForKey = (k) => {
    if (k !== 'amount') return null;
    const net = totalReceived - totalPaid;
    const sign = net < 0 ? '-' : '';
    return (
      <strong style={{
        fontVariantNumeric: 'tabular-nums',
        color: net >= 0 ? 'var(--success)' : 'var(--danger)',
      }}>
        {sign}{fmt(Math.abs(net))}
      </strong>
    );
  };
  const summaryCells = (col, idx) => {
    if (idx === 0) {
      if (totalCount === 0) return null;
      return (
        <span style={{ color: 'var(--fg-secondary)', fontWeight: 600 }}>
          {`Total (${totalCount.toLocaleString('en-IN')} txn${totalCount === 1 ? '' : 's'})`}
          <span style={{ color: 'var(--fg-tertiary)', fontWeight: 400, marginLeft: 8 }}>
            · in {fmtShort(totalReceived)} · out {fmtShort(totalPaid)}
          </span>
        </span>
      );
    }
    if (idx > 0 && idx < firstAggIdx) return null;
    return totalForKey(col.key);
  };
  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  return (
    <div className="blist-page">
      {/* ── Header: title + filters + CTAs ────────────────────── */}
      <div className="blist-hd">
        <div className="blist-title">
          <h1>Payments &amp; Receipts</h1>
          <div className="sub">
            <b>{totalCount.toLocaleString('en-IN')}</b> transactions
            {cReceived > 0 && <> · <b>{cReceived.toLocaleString('en-IN')}</b> receipts</>}
            {cPaid > 0     && <> · <b>{cPaid.toLocaleString('en-IN')}</b> payments</>}
          </div>
        </div>
        <div className="blist-ctrl">
          <DatePicker.RangePicker
            size="middle" format="DD MMM"
            placeholder={['From', 'To']}
            value={[filters.from_date ? dayjs(filters.from_date) : null, filters.to_date ? dayjs(filters.to_date) : null]}
            onChange={(v) => setFilters(f => ({
              ...f,
              from_date: v?.[0]?.format('YYYY-MM-DD') || null,
              to_date:   v?.[1]?.format('YYYY-MM-DD') || null,
            }))}
            style={{ height: 34, width: 220 }}
          />
          <Select
            placeholder="All types" allowClear
            style={{ width: 130, height: 34 }}
            value={filters.transaction_type}
            onChange={(v) => setFilters(f => ({ ...f, transaction_type: v || null }))}
            options={[
              { value: 'Receipt', label: 'Receipts' },
              { value: 'Payment', label: 'Payments' },
            ]}
          />
          <Select
            placeholder="All sources" allowClear
            style={{ width: 170, height: 34 }}
            value={filters.source}
            onChange={(v) => setFilters(f => ({ ...f, source: v || null }))}
            options={[
              { value: 'manual',         label: 'Manual entry' },
              { value: 'auto_from_bill', label: 'Auto from bill' },
            ]}
          />
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            dropdownRender={() => (
              <div className="cols-menu" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.12)' }}>
                <div className="mh">Optional columns</div>
                {PAYMENT_OPTIONAL_COLS.map(c => (
                  <label key={c.key} className="opt">
                    <input
                      type="checkbox"
                      checked={!!cols[c.key]}
                      onChange={(e) => setCols(prev => ({ ...prev, [c.key]: e.target.checked }))}
                    />
                    {c.label}
                  </label>
                ))}
                <div className="sep" />
                <div className="mh">Sections</div>
                {PAYMENT_SECTIONS.map(s => (
                  <label key={s.key} className="opt">
                    <input
                      type="checkbox"
                      checked={!!cols[s.key]}
                      onChange={(e) => setCols(prev => ({ ...prev, [s.key]: e.target.checked }))}
                    />
                    {s.label}
                  </label>
                ))}
                <div className="sep" />
                <div className="mh" style={{ paddingBottom: 2 }}>Always shown</div>
                <label className="opt"><span>Txn No · Type · Date · Party · Amount</span><span className="pin">Pinned</span></label>
              </div>
            )}
          >
            <button className={`blist-chip${visibleOptionalCount > 0 ? ' on' : ''}`}>
              <SettingOutlined /> Customize
              {visibleOptionalCount > 0 && <span className="col-count">{visibleOptionalCount}</span>}
            </button>
          </Dropdown>
          <span className="blist-divider"></span>
          <button className="blist-cta ghost" onClick={() => navigate('/payment/new')}>
            <PlusOutlined /> Make Payment
          </button>
          <button className="blist-cta" onClick={() => navigate('/receipt/new')}>
            <PlusOutlined /> Receive Payment
          </button>
        </div>
      </div>

      {/* ── KPI strip ──────────────────────────────────────────── */}
      <div className="blist-kpi">
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Total Received · This View</div>
            <div className="v">{fmt(totalReceived)}</div>
            <div className="sub">
              {cReceived > 0
                ? `across ${cReceived.toLocaleString('en-IN')} receipt${cReceived === 1 ? '' : 's'}`
                : 'no receipts in range'}
            </div>
          </div>
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Total Paid · This View</div>
            <div className="v">{fmt(totalPaid)}</div>
            <div className="sub">
              {cPaid > 0
                ? `across ${cPaid.toLocaleString('en-IN')} payment${cPaid === 1 ? '' : 's'}`
                : 'no payments in range'}
            </div>
          </div>
        </div>
        <div className={`kpi-card ${netFlow >= 0 ? 'received' : 'outstanding'}`}>
          <div className="kpi-text">
            <div className="k">
              <SwapOutlined style={{ marginRight: 4 }} />
              Net Cash Flow
            </div>
            <div className="v">{netFlow >= 0 ? fmt(netFlow) : `- ${fmt(Math.abs(netFlow))}`}</div>
            <div className="sub">
              {netFlow >= 0 ? 'inflow exceeds outflow' : 'outflow exceeds inflow'}
              {' · net of '}{fmtShort(totalReceived + totalPaid)} moved
            </div>
          </div>
        </div>
      </div>

      {/* ── Virtualised table ─────────────────────────────────── */}
      <div className="blist-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="transaction_id"
          scroll={{ x: 1100 }}
          rowClassName={(r) => r && r.is_cancelled ? 'erp-row-cancelled' : ''}
          summaryCells={cols.totalRow ? summaryCells : undefined}
          summaryColSpan={cols.totalRow ? summaryColSpan : undefined}
          controlledCursorIdx={sel.cursorIdx}
          controlledSelectedSet={sel.selectedSet}
          onCursorMove={sel.setCursor}
          onShiftClickRow={sel.extendTo}
          onCtrlClickRow={sel.toggleRow}
          onRow={(record) => ({
            onDoubleClick: () => record?.transaction_id && !record.is_cancelled && handlePrint(record),
          })}
        />
      </div>

      {/* ── Bottom action strip — F1 Print is the primary action
          (this list has no view modal; the voucher-print IS the
          "view"). F3 = New Payment, F6 = New Receipt (F6 is the
          universal "money-in" key across the app). F8 cancels with
          multi-bulk confirm. */}
      <ActionStrip
        info={isMulti ? `${selectionCount} selected` : null}
        actions={[
          // Visual order: nav keys on the left, destructive F8 +
          // primary F1 on the right (matches forms + other lists).
          {
            id: 'new-payment', key: 'F3', label: 'New Payment',
            onAction: () => navigate('/payment/new'),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => refresh(),
          },
          {
            id: 'new-receipt', key: 'F6', label: 'New Receipt',
            onAction: () => navigate('/receipt/new'),
          },
          // Edit — opens the entry form in edit mode. Backend's PUT
          // endpoint (audit C4) does atomic cancel-then-recreate so the
          // edit is safe even though it generates a new transaction
          // number. Auto-receipts and cancelled rows can't be edited.
          {
            id: 'edit', key: 'F4', label: 'Edit',
            disabled: isMulti || !single || singleCancelled || single?.source === 'auto_from_bill',
            onAction: () => {
              if (!single) return;
              const path = single.transaction_type === 'Receipt'
                ? `/receipt/edit/${single.transaction_id}`
                : `/payment/edit/${single.transaction_id}`;
              navigate(path);
            },
          },
          {
            id: 'whatsapp', key: 'F7', label: isMulti ? 'WhatsApp selected' : 'WhatsApp',
            disabled: isMulti
              ? !selectedRows.some((r) => r && !r.is_cancelled && r.party?.mobile_1)
              : (!single || singleCancelled || !single?.party?.mobile_1),
            onAction: () => (isMulti ? handleBulkWhatsApp(selectedRows) : (single && handleWhatsApp(single))),
          },
          {
            id: 'cancel', key: 'F8', label: 'Cancel', tone: 'danger',
            disabled: !activeRow,
            onAction: () => handleBulkCancel(isMulti ? selectedRows : [single]),
          },
          {
            id: 'print', key: 'F1', label: 'Print Voucher', tone: 'primary',
            disabled: isMulti || !single || singleCancelled,
            onAction: () => single && handlePrint(single),
          },
        ]}
      />
    </div>
  );
}
