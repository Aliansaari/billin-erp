import React, { useEffect, useState } from 'react';
import { Table, Card, Select, Button, Tag, Typography, Space, Input, message } from 'antd';
import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { reportAPI, categoryAPI, dataAPI } from '../../api';

const { Title } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export default function StockReportPage() {
  const [data, setData] = useState([]);
  const [summary, setSummary] = useState({});
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    search: '',
    category_id: null,
    stock_status: null,
  });

  useEffect(() => {
    loadCategories();
  }, []);

  useEffect(() => {
    loadData();
  }, [filters]);

  const loadCategories = async () => {
    try {
      const { data } = await categoryAPI.getAllFlat();
      setCategories(data);
    } catch (e) { /* ignore */ }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await reportAPI.getStockReport(filters);
      setData(res.data.data);
      setSummary(res.data.summary || {});
    } catch (e) {
      message.error('Failed to load stock report');
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const res = await dataAPI.exportExcel('products');
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock_report_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
    } catch (e) {
      message.error('Export failed');
    }
  };

  const columns = [
    { title: 'Barcode', dataIndex: 'barcode', width: 120 },
    { title: 'Product', dataIndex: 'product_name', width: 200 },
    { title: 'Category', dataIndex: ['Category', 'category_name'], width: 130 },
    { title: 'Size', dataIndex: 'size_value', width: 70, align: 'center' },
    {
      title: 'Current Stock', dataIndex: 'current_stock', width: 110, align: 'right',
      render: (v, r) => {
        const color = v <= 0 ? 'red' : v <= r.minimum_stock_level ? 'orange' : 'green';
        return <Tag color={color}>{v}</Tag>;
      },
    },
    { title: 'Min Stock', dataIndex: 'minimum_stock_level', width: 90, align: 'right' },
    { title: 'Purchase Rate', dataIndex: 'purchase_rate', width: 120, align: 'right', render: fmt },
    { title: 'Sale Rate', dataIndex: 'sale_rate', width: 120, align: 'right', render: fmt },
    {
      title: 'Stock Value', width: 130, align: 'right',
      render: (_, r) => fmt(parseFloat(r.current_stock || 0) * parseFloat(r.purchase_rate || 0)),
    },
  ];

  const potentialProfit = parseFloat(summary.total_sale_value || 0) - parseFloat(summary.total_purchase_value || 0);

  const fmt2 = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Stock Report</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{summary.total_items || 0} products</span>
        </div>
        <Button icon={<DownloadOutlined />} onClick={handleExport} style={{ height: 38 }}>Export Excel</Button>
      </div>

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Filter Bar */}
        <div className="erp-filter-bar">
          <Input placeholder="Search product / barcode..." prefix={<SearchOutlined />}
            style={{ width: 220, height: 34 }} allowClear
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
          <Select placeholder="All Categories" style={{ width: 160, height: 34 }} allowClear showSearch optionFilterProp="children"
            onChange={(v) => setFilters((f) => ({ ...f, category_id: v }))}>
            {categories.map((c) => (
              <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>
            ))}
          </Select>
          <Select placeholder="All Stock Levels" style={{ width: 150, height: 34 }} allowClear
            onChange={(v) => setFilters((f) => ({ ...f, stock_status: v }))}>
            <Select.Option value="low">Low Stock</Select.Option>
            <Select.Option value="out">Out of Stock</Select.Option>
          </Select>
        </div>

        {/* Summary Bar */}
        <div className="erp-summary-bar">
          <div className="erp-summary-stat" style={{ background: '#eef2ff' }}>
            <span className="erp-summary-stat-label">Total Products</span>
            <span className="erp-summary-stat-value" style={{ color: '#4F46E5' }}>{summary.total_items || 0}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#fffbeb' }}>
            <span className="erp-summary-stat-label">Purchase Value</span>
            <span className="erp-summary-stat-value" style={{ color: '#D97706' }}>{fmt2(summary.total_purchase_value)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#ecfdf5' }}>
            <span className="erp-summary-stat-label">Sale Value</span>
            <span className="erp-summary-stat-value" style={{ color: '#059669' }}>{fmt2(summary.total_sale_value)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: potentialProfit >= 0 ? '#f0fdf4' : '#fef2f2' }}>
            <span className="erp-summary-stat-label">Potential Profit</span>
            <span className="erp-summary-stat-value" style={{ color: potentialProfit >= 0 ? '#16a34a' : '#dc2626' }}>{fmt2(potentialProfit)}</span>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          <Table
            columns={columns}
            dataSource={data}
            rowKey="product_id"
            loading={loading}
            size="small"
            scroll={{ x: 1100 }}
            pagination={false}
          />
        </div>
      </Card>
    </div>
  );
}
