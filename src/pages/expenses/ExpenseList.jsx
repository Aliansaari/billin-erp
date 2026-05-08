// ── Expense Voucher List ───────────────────────────────────────────
//
// Paginated table of expense vouchers in the current FY (filterable by
// date range, payment mode, vendor, expense head, search). Same layout
// posture as PaymentList — page header + filter bar + virtualised
// table + bottom action strip.
//
// Cancelled vouchers are excluded by default; an "Include cancelled"
// chip in the filter bar surfaces them with a strikethrough row.
//
// Cursor-driven actions:
//   F1 Open       — navigate to /expenses/edit/:id
//   F3 New        — /expenses/new
//   F5 Refresh
//   F8 Cancel     — single-row + multi-row reverse-and-mark-cancelled
//   F6 Report     — /expenses/report

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Tag, Typography, message, Card, Space, DatePicker,
  Select, Modal, Input, Tooltip, Table,
} from 'antd';
import { PlusOutlined, BarChartOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { expenseAPI, partyAPI, ledgerAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';

const { Title, Text } = Typography;

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupee = (v) => '₹ ' + fmt(v);

const MODE_TONE = {
  Cash:   { color: 'green',   label: 'Cash' },
  Bank:   { color: 'blue',    label: 'Bank' },
  Credit: { color: 'volcano', label: 'Credit' },
};

export default function ExpenseList() {
  const { fyStart, fyEnd } = useFinancialYear();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [filters, setFilters] = useState(() => ({
    from_date:         searchParams.get('from_date') || fyStart,
    to_date:           searchParams.get('to_date')   || fyEnd,
    payment_mode:      searchParams.get('payment_mode') || null,
    party_id:          searchParams.get('party_id') ? Number(searchParams.get('party_id')) : null,
    expense_ledger_id: searchParams.get('expense_ledger_id') ? Number(searchParams.get('expense_ledger_id')) : null,
    search:            '',
    include_cancelled: false,
  }));

  const [rows, setRows]           = useState([]);
  const [total, setTotal]         = useState(0);
  const [sumTotal, setSumTotal]   = useState(0);
  const [loading, setLoading]     = useState(false);
  const [page, setPage]           = useState(1);
  const [pageSize, setPageSize]   = useState(50);

  const [parties, setParties]   = useState([]);
  const [ledgers, setLedgers]   = useState([]);

  // Refresh rows on filter / page change.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        from_date: filters.from_date || undefined,
        to_date:   filters.to_date   || undefined,
        payment_mode: filters.payment_mode || undefined,
        party_id:     filters.party_id || undefined,
        expense_ledger_id: filters.expense_ledger_id || undefined,
        search: filters.search.trim() || undefined,
        include_cancelled: filters.include_cancelled ? 'true' : undefined,
        page, limit: pageSize,
      };
      const res = await expenseAPI.list(params);
      setRows(res.data.data || []);
      setTotal(Number(res.data.total) || 0);
      setSumTotal(Number(res.data.sum_total) || 0);
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to load expenses.');
    }
    setLoading(false);
  }, [filters, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  // Initial fetch of filter dropdowns.
  useEffect(() => {
    partyAPI.getAll({ limit: 5000 }).then((r) => {
      setParties((r.data?.data || []).filter((p) => p.is_active !== false && !p.is_system_cash));
    }).catch(() => {});
    ledgerAPI.listAccounts().then((r) => {
      setLedgers((r.data?.data || []).filter((l) => l.ledger_group === 'Expenses' && l.is_active !== false));
    }).catch(() => {});
  }, []);

  // Selection model.
  const sel = useListSelection({ totalCount: rows.length, rows });
  const single = sel.activeRow;
  const isMulti = sel.selectionCount > 1;
  const singleCancelled = single?.is_cancelled;

  const handleCancel = useCallback((toCancel) => {
    const cancellable = (toCancel || []).filter((r) => r && !r.is_cancelled);
    if (cancellable.length === 0) {
      message.info('Nothing to cancel — selection is already cancelled.');
      return;
    }
    let reason = '';
    Modal.confirm({
      title: cancellable.length === 1
        ? `Cancel expense ${cancellable[0].voucher_number}?`
        : `Cancel ${cancellable.length} expense vouchers?`,
      content: (
        <div>
          <p>Each voucher will be reversed (mirror Dr/Cr posted) and marked cancelled. Originals stay for audit.</p>
          <Input.TextArea rows={2} placeholder="Reason (optional)" onChange={(e) => { reason = e.target.value; }} />
        </div>
      ),
      okText: cancellable.length === 1 ? 'Cancel voucher' : `Cancel ${cancellable.length}`,
      okButtonProps: { danger: true },
      cancelText: 'Go back',
      onOk: async () => {
        let ok = 0, fail = 0;
        for (const r of cancellable) {
          try { await expenseAPI.cancel(r.expense_id, reason); ok++; }
          catch { fail++; }
        }
        load();
        if (fail === 0) message.success(`Cancelled ${ok} voucher${ok === 1 ? '' : 's'}.`);
        else message.warning(`${ok} cancelled, ${fail} failed.`);
      },
    });
  }, [load]);

  const columns = useMemo(() => [
    { title: 'Date', dataIndex: 'voucher_date', width: 105, key: 'date',
      render: (v) => dayjs(v).format('DD/MM/YYYY') },
    { title: 'Voucher #', dataIndex: 'voucher_number', width: 200, key: 'no',
      render: (v, r) => r.is_cancelled
        ? <Text delete style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>{v}</Text>
        : <span style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12, fontWeight: 600 }}>{v}</span> },
    { title: 'Mode', dataIndex: 'payment_mode', width: 100, key: 'mode',
      render: (m) => {
        const t = MODE_TONE[m] || { color: 'default', label: m };
        return <Tag color={t.color} style={{ margin: 0 }}>{t.label}</Tag>;
      } },
    { title: 'Vendor / Bank', key: 'who', width: 220, ellipsis: true,
      render: (_, r) => {
        if (r.payment_mode === 'Bank' && r.bank) return r.bank.ledger_name;
        if (r.party) return r.party.party_name;
        return <span style={{ color: 'var(--fg-tertiary, #9ca3af)' }}>—</span>;
      } },
    { title: 'Heads', key: 'heads', ellipsis: true,
      render: (_, r) => {
        const items = r.items || [];
        if (items.length === 0) return <span style={{ color: 'var(--fg-tertiary, #9ca3af)' }}>—</span>;
        const head = items[0]?.expenseLedger?.ledger_name || '—';
        const more = items.length > 1 ? ` +${items.length - 1} more` : '';
        return <span style={{ fontSize: 13 }}>{head}<span style={{ color: '#9ca3af', fontSize: 11 }}>{more}</span></span>;
      } },
    { title: 'Ref / Bill', dataIndex: 'reference_number', width: 130, key: 'ref',
      render: (v) => v || <span style={{ color: 'var(--fg-tertiary, #9ca3af)' }}>—</span> },
    { title: 'Subtotal', dataIndex: 'sub_total', width: 110, align: 'right', key: 'sub',
      render: (v) => <span style={{ fontFamily: 'Geist Mono, monospace' }}>{fmt(v)}</span> },
    { title: 'GST', key: 'gst', width: 100, align: 'right',
      render: (_, r) => {
        const g = (Number(r.cgst_amount) || 0) + (Number(r.sgst_amount) || 0) + (Number(r.igst_amount) || 0);
        return <span style={{ fontFamily: 'Geist Mono, monospace', color: g > 0 ? 'inherit' : '#9ca3af' }}>{g > 0 ? fmt(g) : '—'}</span>;
      } },
    { title: 'Total', dataIndex: 'total_amount', width: 130, align: 'right', key: 'total',
      render: (v, r) => (
        <strong style={{ fontFamily: 'Geist Mono, monospace', color: r.is_cancelled ? '#9ca3af' : '#dc2626' }}>
          {rupee(v)}
        </strong>
      ) },
    { title: '', key: 'state', width: 110, align: 'center', fixed: 'right',
      render: (_, r) => {
        if (r.is_cancelled) return <Tag color="default" style={{ margin: 0 }}>Cancelled</Tag>;
        const unpaid = (Number(r.total_amount) || 0) - (Number(r.paid_amount) || 0);
        if (unpaid > 0.005) return <Tag color="orange" style={{ margin: 0 }}>Payable {rupee(unpaid)}</Tag>;
        return null;
      } },
  ], []);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page header */}
      <div className="erp-page-header" style={{
        padding: '12px 20px', background: 'var(--bg-panel, #fff)',
        borderBottom: '1px solid var(--border, #f0f0f0)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <Title level={3} style={{ margin: 0, fontWeight: 700 }}>Expenses</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {total} voucher{total === 1 ? '' : 's'} · Total spend {rupee(sumTotal)}
          </Text>
        </div>
        <Space>
          <Button icon={<BarChartOutlined />} onClick={() => navigate('/expenses/report')}
            style={{ height: 38, fontWeight: 500 }}>
            Report
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/expenses/new')}
            style={{ height: 38, fontWeight: 500 }}>
            New Expense
          </Button>
        </Space>
      </div>

      <Card
        bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: 0, border: 'none' }}
      >
        {/* Filter bar */}
        <div className="erp-filter-bar" style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border, #f0f0f0)',
          display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        }}>
          <DatePicker.RangePicker
            format="DD-MM-YYYY"
            style={{ height: 34 }}
            value={[filters.from_date ? dayjs(filters.from_date) : null, filters.to_date ? dayjs(filters.to_date) : null]}
            onChange={(v) => {
              setFilters((f) => ({ ...f,
                from_date: v?.[0]?.format('YYYY-MM-DD') || null,
                to_date:   v?.[1]?.format('YYYY-MM-DD') || null,
              }));
              setPage(1);
            }}
          />
          <Select
            placeholder="All modes" allowClear
            style={{ width: 140, height: 34 }}
            value={filters.payment_mode}
            onChange={(v) => { setFilters((f) => ({ ...f, payment_mode: v || null })); setPage(1); }}
            options={[
              { value: 'Cash',   label: 'Cash' },
              { value: 'Bank',   label: 'Bank' },
              { value: 'Credit', label: 'Credit' },
            ]}
          />
          <Select
            placeholder="All vendors" allowClear showSearch optionFilterProp="label"
            style={{ width: 220, height: 34 }}
            value={filters.party_id}
            onChange={(v) => { setFilters((f) => ({ ...f, party_id: v || null })); setPage(1); }}
            options={parties.map((p) => ({ value: p.party_id, label: p.party_name }))}
          />
          <Select
            placeholder="All expense heads" allowClear showSearch optionFilterProp="label"
            style={{ width: 240, height: 34 }}
            value={filters.expense_ledger_id}
            onChange={(v) => { setFilters((f) => ({ ...f, expense_ledger_id: v || null })); setPage(1); }}
            options={ledgers.map((l) => ({ value: l.ledger_id, label: l.ledger_name }))}
          />
          <Input.Search
            placeholder="Search voucher # / ref / narration"
            allowClear
            style={{ width: 280, height: 34 }}
            onSearch={(v) => { setFilters((f) => ({ ...f, search: v })); setPage(1); }}
          />
          <Tooltip title="Show cancelled vouchers in the list">
            <Button
              size="middle"
              type={filters.include_cancelled ? 'primary' : 'default'}
              ghost={filters.include_cancelled}
              onClick={() => { setFilters((f) => ({ ...f, include_cancelled: !f.include_cancelled })); setPage(1); }}
              style={{ height: 34 }}
            >
              {filters.include_cancelled ? '✓ Cancelled shown' : 'Show cancelled'}
            </Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={load} style={{ height: 34 }}>Refresh</Button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px' }}>
          {/* Standard antd Table — payment-list uses VirtualReportTable
              for 99k-row scrolling, but expenses are typically a few
              thousand max so paginated antd works fine and we keep the
              implementation small. */}
          <AntTable
            columns={columns}
            rows={rows}
            loading={loading}
            sel={sel}
            page={page} pageSize={pageSize} total={total}
            onPageChange={(p, s) => { setPage(p); setPageSize(s); }}
            onOpen={(r) => r && !r.is_cancelled && navigate(`/expenses/edit/${r.expense_id}`)}
          />
        </div>
      </Card>

      <ActionStrip
        info={isMulti ? `${sel.selectionCount} selected` : null}
        actions={[
          { id: 'new',     key: 'F3', label: 'New',     onAction: () => navigate('/expenses/new') },
          { id: 'refresh', key: 'F5', label: 'Refresh', onAction: load },
          { id: 'report',  key: 'F6', label: 'Report',  onAction: () => navigate('/expenses/report') },
          { id: 'cancel',  key: 'F8', label: 'Cancel', tone: 'danger',
            disabled: !sel.activeRow,
            onAction: () => handleCancel(isMulti ? sel.selectedRows : [single]) },
          { id: 'open',    key: 'F1', label: 'Open', tone: 'primary',
            disabled: isMulti || !single || singleCancelled,
            onAction: () => single && navigate(`/expenses/edit/${single.expense_id}`) },
        ]}
      />
    </div>
  );
}

// Tiny wrapper around AntD Table that hooks the row-click + cursor
// state into useListSelection. Kept inline because the only consumer
// is this page and it's simple enough.
function AntTable({ columns, rows, loading, sel, page, pageSize, total, onPageChange, onOpen }) {
  return (
    <Table
      rowKey="expense_id"
      columns={columns}
      dataSource={rows}
      loading={loading}
      size="small"
      sticky
      scroll={{ x: 1200 }}
      pagination={{
        current: page, pageSize, total,
        showSizeChanger: true,
        pageSizeOptions: [25, 50, 100, 200],
        onChange: onPageChange,
      }}
      rowClassName={(r, idx) => {
        const cls = [];
        if (r.is_cancelled) cls.push('erp-row-cancelled');
        if (sel.cursorIdx === idx) cls.push('vrt-row-active');
        else if (sel.selectedSet.has(idx)) cls.push('vrt-row-multi');
        return cls.join(' ');
      }}
      onRow={(record, idx) => ({
        onClick: (e) => {
          if (e.shiftKey)               sel.extendTo(idx);
          else if (e.ctrlKey || e.metaKey) sel.toggleRow(idx);
          else                              sel.setCursor(idx);
        },
        onDoubleClick: () => onOpen(record),
      })}
    />
  );
}
