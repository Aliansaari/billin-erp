import React, { useEffect, useState } from 'react';
import { Table, Card, DatePicker, Select, Button, Tag, Typography, Space, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI, partyAPI, dataAPI } from '../../api';

const { Title } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export default function SalesReport() {
  const [data, setData] = useState([]);
  const [summary, setSummary] = useState({});
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    from_date: dayjs().startOf('month').format('YYYY-MM-DD'),
    to_date: dayjs().endOf('month').format('YYYY-MM-DD'),
    customer_id: null,
    payment_status: null,
  });

  useEffect(() => {
    loadCustomers();
  }, []);

  useEffect(() => {
    loadData();
  }, [filters]);

  const loadCustomers = async () => {
    try {
      const { data } = await partyAPI.getCustomers();
      setCustomers(data.data || data);
    } catch (e) { /* ignore */ }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await reportAPI.getSalesReport(filters);
      setData(res.data.data);
      setSummary(res.data.summary || {});
    } catch (e) {
      message.error('Failed to load sales report');
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const res = await dataAPI.exportExcel('sales');
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `sales_report_${dayjs().format('YYYY-MM-DD')}.xlsx`;
      a.click();
    } catch (e) {
      message.error('Export failed');
    }
  };

  const columns = [
    { title: 'Bill No', dataIndex: 'bill_number', width: 130 },
    { title: 'Date', dataIndex: 'bill_date', width: 110, render: (v) => dayjs(v).format('DD-MMM-YYYY') },
    { title: 'Customer', dataIndex: ['customer', 'party_name'], width: 180, render: (v) => v || 'Cash Sale' },
    { title: 'Items', dataIndex: 'item_count', width: 70, align: 'center' },
    { title: 'Sub Total', dataIndex: 'sub_total', width: 120, align: 'right', render: fmt },
    { title: 'Discount', dataIndex: 'discount_amount', width: 100, align: 'right', render: fmt },
    { title: 'GST', dataIndex: 'gst_amount', width: 100, align: 'right', render: fmt },
    { title: 'Total', dataIndex: 'total_amount', width: 120, align: 'right', render: (v) => <strong>{fmt(v)}</strong> },
    { title: 'Paid', dataIndex: 'paid_amount', width: 110, align: 'right', render: fmt },
    {
      title: 'Balance', dataIndex: 'balance_amount', width: 110, align: 'right',
      render: (v) => <span style={{ color: v > 0 ? '#ff4d4f' : '#52c41a' }}>{fmt(v)}</span>,
    },
    {
      title: 'Status', dataIndex: 'payment_status', width: 90,
      render: (s) => <Tag color={s === 'Paid' ? 'green' : s === 'Partial' ? 'orange' : 'red'}>{s}</Tag>,
    },
  ];

  const fmt2 = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Sales Report</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{data.length} bills</span>
        </div>
        <Button icon={<DownloadOutlined />} onClick={handleExport} style={{ height: 38 }}>Export Excel</Button>
      </div>

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Filter Bar */}
        <div className="erp-filter-bar">
          <DatePicker.RangePicker
            format="DD-MMM-YYYY" style={{ height: 34 }}
            defaultValue={[dayjs().startOf('month'), dayjs().endOf('month')]}
            onChange={(v) => setFilters((f) => ({
              ...f,
              from_date: v?.[0]?.format('YYYY-MM-DD') || null,
              to_date: v?.[1]?.format('YYYY-MM-DD') || null,
            }))}
          />
          <Select placeholder="All Customers" style={{ width: 180, height: 34 }} allowClear showSearch optionFilterProp="children"
            onChange={(v) => setFilters((f) => ({ ...f, customer_id: v }))}>
            {customers.map((c) => (
              <Select.Option key={c.party_id} value={c.party_id}>{c.party_name}</Select.Option>
            ))}
          </Select>
          <Select placeholder="All Statuses" style={{ width: 130, height: 34 }} allowClear
            onChange={(v) => setFilters((f) => ({ ...f, payment_status: v }))}>
            <Select.Option value="Paid">Paid</Select.Option>
            <Select.Option value="Partial">Partial</Select.Option>
            <Select.Option value="Unpaid">Unpaid</Select.Option>
          </Select>
        </div>

        {/* Summary Bar */}
        <div className="erp-summary-bar">
          <div className="erp-summary-stat" style={{ background: '#ecfdf5' }}>
            <span className="erp-summary-stat-label">Total Sales</span>
            <span className="erp-summary-stat-value" style={{ color: '#059669' }}>{fmt2(summary.total_amount)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#eef2ff' }}>
            <span className="erp-summary-stat-label">Total GST</span>
            <span className="erp-summary-stat-value" style={{ color: '#4F46E5' }}>{fmt2(summary.total_gst)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#fffbeb' }}>
            <span className="erp-summary-stat-label">Total Discount</span>
            <span className="erp-summary-stat-value" style={{ color: '#D97706' }}>{fmt2(summary.total_discount)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#f0fdf4' }}>
            <span className="erp-summary-stat-label">Total Paid</span>
            <span className="erp-summary-stat-value" style={{ color: '#16a34a' }}>{fmt2(summary.total_paid)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#fef2f2' }}>
            <span className="erp-summary-stat-label">Total Balance</span>
            <span className="erp-summary-stat-value" style={{ color: '#dc2626' }}>{fmt2(summary.total_balance)}</span>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          <Table
            columns={columns}
            dataSource={data}
            rowKey="sales_bill_id"
            loading={loading}
            size="small"
            scroll={{ x: 1300 }}
            pagination={false}
            summary={() =>
              data.length > 0 ? (
                <Table.Summary fixed>
                  <Table.Summary.Row style={{ background: '#fafafa', fontWeight: 'bold' }}>
                    <Table.Summary.Cell index={0} colSpan={4}>Total</Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right">{fmt(data.reduce((s, r) => s + parseFloat(r.sub_total || 0), 0))}</Table.Summary.Cell>
                    <Table.Summary.Cell index={5} align="right">{fmt(data.reduce((s, r) => s + parseFloat(r.discount_amount || 0), 0))}</Table.Summary.Cell>
                    <Table.Summary.Cell index={6} align="right">{fmt(data.reduce((s, r) => s + parseFloat(r.gst_amount || 0), 0))}</Table.Summary.Cell>
                    <Table.Summary.Cell index={7} align="right">{fmt(data.reduce((s, r) => s + parseFloat(r.total_amount || 0), 0))}</Table.Summary.Cell>
                    <Table.Summary.Cell index={8} align="right">{fmt(data.reduce((s, r) => s + parseFloat(r.paid_amount || 0), 0))}</Table.Summary.Cell>
                    <Table.Summary.Cell index={9} align="right">{fmt(data.reduce((s, r) => s + parseFloat(r.balance_amount || 0), 0))}</Table.Summary.Cell>
                    <Table.Summary.Cell index={10} />
                  </Table.Summary.Row>
                </Table.Summary>
              ) : null
            }
          />
        </div>
      </Card>
    </div>
  );
}
