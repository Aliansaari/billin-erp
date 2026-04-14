import React, { useEffect, useState } from 'react';
import { Table, Button, Tag, Typography, message, Card, Space, DatePicker, Select, Popconfirm, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { paymentAPI } from '../../api';

const { Title } = Typography;

export default function PaymentList() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [filters, setFilters] = useState({ transaction_type: null, from_date: null, to_date: null });
  const navigate = useNavigate();

  useEffect(() => { loadData(); }, [filters]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await paymentAPI.getAll({ ...filters, page: 1, limit: 99999 });
      setData(res.data.data);
    } catch (e) { message.error('Failed to load'); }
    setLoading(false);
  };

  const handleDelete = async (id) => {
    setDeletingId(id);
    try {
      await paymentAPI.cancel(id);
      message.success('Transaction cancelled successfully');
      loadData();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to cancel');
    } finally { setDeletingId(null); }
  };

  const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  const columns = [
    { title: 'Txn No', dataIndex: 'transaction_number', width: 130,
      render: (v) => <span style={{ fontSize: 12 }}>{v}</span> },
    { title: 'Type', dataIndex: 'transaction_type', width: 90,
      render: (t) => <Tag color={t === 'Receipt' ? 'green' : 'volcano'}>{t}</Tag> },
    { title: 'Date', dataIndex: 'transaction_date', width: 110,
      render: (v) => dayjs(v).format('DD/MM/YYYY') },
    { title: 'Party', dataIndex: ['party', 'party_name'], width: 180, ellipsis: true },
    { title: 'Amount', dataIndex: 'total_amount', width: 120, align: 'right',
      render: (v, r) => (
        <span style={{ fontWeight: 700, color: r.transaction_type === 'Receipt' ? '#059669' : '#dc2626' }}>
          {fmt(v)}
        </span>
      )},
    { title: 'Mode', dataIndex: 'splits', width: 160,
      render: (splits) => splits?.map(s => <Tag key={s.split_id} style={{ fontSize: 11 }}>{s.payment_mode}: {fmt(s.amount)}</Tag>) },
    { title: 'Remarks', dataIndex: 'remarks', width: 180, ellipsis: true,
      render: (v) => <span style={{ fontSize: 12, color: '#6b7280' }}>{v || '—'}</span> },
    {
      title: '', width: 60, align: 'center', fixed: 'right',
      render: (_, record) => record.is_cancelled ? (
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
      ),
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Payments & Receipts</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{data.length} transactions total</span>
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
            onChange={(v) => setFilters(f => ({ ...f, from_date: v?.[0]?.format('YYYY-MM-DD'), to_date: v?.[1]?.format('YYYY-MM-DD') }))} />
          <Select placeholder="All Types" style={{ width: 130, height: 34 }} allowClear
            onChange={(v) => setFilters(f => ({ ...f, transaction_type: v }))}>
            <Select.Option value="Payment">Payment</Select.Option>
            <Select.Option value="Receipt">Receipt</Select.Option>
          </Select>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          <Table
            columns={columns}
            dataSource={data}
            rowKey="transaction_id"
            loading={loading}
            size="small"
            scroll={{ x: 1000 }}
            rowClassName={(r) => r.is_cancelled ? 'erp-row-cancelled' : ''}
            pagination={false}
          />
        </div>
      </Card>
    </div>
  );
}
