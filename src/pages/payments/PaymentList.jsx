import React, { useEffect, useState } from 'react';
import { Button, Tag, Typography, message, Card, Space, DatePicker, Select, Popconfirm, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, PrinterOutlined, LinkOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { paymentAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument } from '../../services/printer';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';

const { Title } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export default function PaymentList() {
  const { fyStart, fyEnd } = useFinancialYear();
  const [deletingId, setDeletingId] = useState(null);
  // Default to company FY for consistency. `source` filter (added in
  // R8 Phase 2) lets the user view manual-entered receipts/payments
  // separately from auto-generated bill-side ones.
  const [filters, setFilters] = useState({ transaction_type: null, source: null, from_date: fyStart, to_date: fyEnd });
  const navigate = useNavigate();

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

  const handleDelete = async (id) => {
    setDeletingId(id);
    try {
      await paymentAPI.cancel(id);
      message.success('Transaction cancelled successfully');
      refresh();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to cancel');
    } finally { setDeletingId(null); }
  };

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
    { title: 'Amount', dataIndex: 'total_amount', width: 120, align: 'right', key: 'amount',
      render: (v, r) => (
        <span style={{ fontWeight: 700, color: r.transaction_type === 'Receipt' ? '#059669' : '#dc2626' }}>
          {fmt(v)}
        </span>
      )},
    { title: 'Mode', dataIndex: 'splits', width: 160, key: 'mode',
      render: (splits) => splits?.map(s => <Tag key={s.split_id} style={{ fontSize: 11 }}>{s.payment_mode}: {fmt(s.amount)}</Tag>) },
    { title: 'Remarks', dataIndex: 'remarks', width: 180, ellipsis: true, key: 'remarks',
      render: (v) => <span style={{ fontSize: 12, color: '#6b7280' }}>{v || '—'}</span> },
    {
      title: '', width: 110, align: 'center', fixed: 'right', key: 'actions',
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title="Print voucher / receipt">
            <Button
              size="small"
              icon={<PrinterOutlined />}
              onClick={() => printDocument({
                docType: record.transaction_type === 'Receipt' ? 'receipt' : 'payment',
                id: record.transaction_id,
              })}
            />
          </Tooltip>
          {record.is_cancelled ? (
            <Tag color="default" style={{ fontSize: 10 }}>Cancelled</Tag>
          ) : (
            <Popconfirm
              title="Cancel this transaction?"
              description="This will reverse the payment and update party balance."
              okText="Yes, Cancel"
              okButtonProps={{ danger: true }}
              cancelText="No"
              onConfirm={() => handleDelete(record.transaction_id)}
            >
              <Tooltip title="Cancel transaction">
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  loading={deletingId === record.transaction_id}
                />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
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
          />
        </div>
      </Card>
    </div>
  );
}
