import React, { useCallback, useState } from 'react';
import { Button, Tag, Typography, message, Card, Space, DatePicker, Select, Modal, Tooltip } from 'antd';
import { PlusOutlined, LinkOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { paymentAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument } from '../../services/printer';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';

const { Title } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

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
  if (!mode) return <span style={{ color: '#9ca3af' }}>—</span>;
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
      from_date:        searchParams.get('from_date') || fyStart,
      to_date:          searchParams.get('to_date')   || fyEnd,
    };
  });

  // ── Virtualized data layer ────────────────────────────────────────
  // Server endpoint already returns { total, page, data }. Hook holds
  // a sparse Map of chunks so the user can scroll all 99,999+ rows
  // without front-loading them. `refresh()` invalidates the cache and
  // re-fetches the first chunk after a cancel.
  const { rows, totalCount, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => paymentAPI.getAll(params),
    filters,
    chunkSize: 200,
  });

  // ── Selection model ─────────────────────────────────────────────
  const sel = useListSelection({ totalCount, rows });
  const activeRow      = sel.activeRow;
  const selectedRows   = sel.selectedRows;
  const selectionCount = sel.selectionCount;
  const isMulti        = selectionCount > 1;
  const single         = !isMulti ? activeRow : null;
  const singleCancelled = single?.is_cancelled;

  const handlePrint = (record) => printDocument({
    docType: record.transaction_type === 'Receipt' ? 'receipt' : 'payment',
    id: record.transaction_id,
  });

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
      // /sale/edit and /purchase/edit routes.
      render: (v, r) => (
        <Space size={4} style={{ alignItems: 'center' }}>
          <span style={{ fontSize: 12 }}>{v}</span>
          {r.source === 'auto_from_bill' && r.source_bill_id && (
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
        </Space>
      ) },
    { title: 'Type', dataIndex: 'transaction_type', width: 90, key: 'type',
      render: (t) => <Tag color={t === 'Receipt' ? 'green' : 'volcano'}>{t}</Tag> },
    { title: 'Date', dataIndex: 'transaction_date', width: 110, key: 'date',
      render: (v) => dayjs(v).format('DD/MM/YYYY') },
    { title: 'Party', dataIndex: ['party', 'party_name'], width: 180, key: 'party', ellipsis: true },
    // Mode column — sourced from payments_receipts.payment_method
    // (denormalised by auto-receipt sync + manual create from splits).
    // Falls back to deriving from splits[] for legacy rows where the
    // column is still NULL. Coloured chip per mode; see MODE_STYLE.
    { title: 'Mode', width: 110, key: 'mode',
      render: (_v, r) => <ModeChip method={r.payment_method} splits={r.splits} /> },
    { title: 'Amount', dataIndex: 'total_amount', width: 120, align: 'right', key: 'amount',
      render: (v, r) => (
        <span style={{ fontWeight: 700, color: r.transaction_type === 'Receipt' ? '#059669' : '#dc2626' }}>
          {fmt(v)}
        </span>
      )},
    { title: 'Remarks', dataIndex: 'remarks', width: 180, ellipsis: true, key: 'remarks',
      render: (v) => <span style={{ fontSize: 12, color: '#6b7280' }}>{v || '—'}</span> },
    // Cancelled chip stays inline; the row's actions move to the
    // bottom ActionStrip and operate on the cursored row.
    {
      title: '', width: 90, align: 'center', fixed: 'right', key: 'state',
      render: (_, record) => record.is_cancelled
        ? <Tag color="default" style={{ fontSize: 10, margin: 0 }}>Cancelled</Tag>
        : null,
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Payments & Receipts</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{totalCount} transactions total</span>
        </div>
        <Space>
          <Button icon={<PlusOutlined />} onClick={() => navigate('/payment/new')}
            style={{ height: 38, fontWeight: 500 }}>
            Make Payment
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/receipt/new')}
            style={{ height: 38, fontWeight: 500 }}>
            Receive Payment
          </Button>
        </Space>
      </div>

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Filter Bar */}
        <div className="erp-filter-bar" style={{ flexShrink: 0 }}>
          <DatePicker.RangePicker format="DD-MM-YYYY" style={{ height: 34 }}
            value={[filters.from_date ? dayjs(filters.from_date) : null, filters.to_date ? dayjs(filters.to_date) : null]}
            onChange={(v) => setFilters(f => ({ ...f, from_date: v?.[0]?.format('YYYY-MM-DD'), to_date: v?.[1]?.format('YYYY-MM-DD') }))} />
          <Select placeholder="All Types" style={{ width: 130, height: 34 }} allowClear
            onChange={(v) => setFilters(f => ({ ...f, transaction_type: v }))}>
            <Select.Option value="Payment">Payment</Select.Option>
            <Select.Option value="Receipt">Receipt</Select.Option>
          </Select>
          <Select placeholder="All Sources" style={{ width: 170, height: 34 }} allowClear
            value={filters.source}
            onChange={(v) => setFilters(f => ({ ...f, source: v }))}>
            <Select.Option value="manual">Manual entry</Select.Option>
            <Select.Option value="auto_from_bill">Auto from bill</Select.Option>
          </Select>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <VirtualReportTable
            columns={columns}
            rows={rows}
            totalCount={totalCount}
            ensureChunk={ensureChunk}
            loading={loading}
            rowKey="transaction_id"
            scroll={{ x: 1000 }}
            rowClassName={(r) => r && r.is_cancelled ? 'erp-row-cancelled' : ''}
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
      </Card>

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
