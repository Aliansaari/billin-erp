import React, { useEffect, useState } from 'react';
import { Card, Select, Button, Tag, Typography, Input, message } from 'antd';
import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { reportAPI, categoryAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';

const { Title } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export default function StockReportPage() {
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({
    search: '',
    category_id: null,
    stock_status: null,
  });
  // Debounced search — server-side search is mandatory under
  // virtualization (the client can't filter rows it hasn't loaded).
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 220);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ── Virtualized data layer ────────────────────────────────────────
  const { rows, totalCount, summary, ensureChunk, loading } = useVirtualizedReport({
    fetcher: (params) => reportAPI.getStockReport(params),
    filters,
    chunkSize: 200,
  });

  useEffect(() => { loadCategories(); }, []);

  const loadCategories = async () => {
    try {
      const { data } = await categoryAPI.getAllFlat();
      setCategories(data);
    } catch (e) { /* ignore */ }
  };

  const handleExport = async () => {
    try {
      const res = await reportAPI.exportStockReport(filters);
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      a.download = `stock_report_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      message.error('Export failed');
    }
  };

  const columns = [
    { title: 'Barcode', dataIndex: 'barcode', width: 120, key: 'barcode' },
    { title: 'Product', dataIndex: 'product_name', width: 200, key: 'product' },
    { title: 'Category', dataIndex: ['Category', 'category_name'], width: 130, key: 'cat' },
    { title: 'Size', dataIndex: 'size_value', width: 70, align: 'center', key: 'size' },
    {
      title: 'Current Stock', dataIndex: 'current_stock', width: 110, align: 'right', key: 'stk',
      render: (v, r) => {
        const color = v <= 0 ? 'red' : v <= r.minimum_stock_level ? 'orange' : 'green';
        return <Tag color={color}>{v}</Tag>;
      },
    },
    { title: 'Min Stock', dataIndex: 'minimum_stock_level', width: 90, align: 'right', key: 'min' },
    { title: 'Purchase Rate', dataIndex: 'purchase_rate', width: 120, align: 'right', render: fmt, key: 'pur' },
    { title: 'Sale Rate', dataIndex: 'sale_rate', width: 120, align: 'right', render: fmt, key: 'sale' },
    {
      title: 'Stock Value', width: 130, align: 'right', key: 'val',
      render: (_, r) => fmt(parseFloat(r.current_stock || 0) * parseFloat(r.purchase_rate || 0)),
    },
  ];

  const potentialProfit = parseFloat(summary.total_sale_value || 0) - parseFloat(summary.total_purchase_value || 0);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Stock Report</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            {totalCount} product{totalCount === 1 ? '' : 's'}
          </span>
        </div>
        <Button icon={<DownloadOutlined />} onClick={handleExport} style={{ height: 38 }}>Export Excel</Button>
      </div>

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Filter Bar */}
        <div className="erp-filter-bar">
          <Input placeholder="Search product / barcode..." prefix={<SearchOutlined />}
            style={{ width: 220, height: 34 }} allowClear
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)} />
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
            <span className="erp-summary-stat-value" style={{ color: '#D97706' }}>{fmt(summary.total_purchase_value)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#ecfdf5' }}>
            <span className="erp-summary-stat-label">Sale Value</span>
            <span className="erp-summary-stat-value" style={{ color: '#059669' }}>{fmt(summary.total_sale_value)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: potentialProfit >= 0 ? '#f0fdf4' : '#fef2f2' }}>
            <span className="erp-summary-stat-label">Potential Profit</span>
            <span className="erp-summary-stat-value" style={{ color: potentialProfit >= 0 ? '#16a34a' : '#dc2626' }}>{fmt(potentialProfit)}</span>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <VirtualReportTable
            columns={columns}
            rows={rows}
            totalCount={totalCount}
            ensureChunk={ensureChunk}
            loading={loading}
            rowKey="product_id"
            scroll={{ x: 1100 }}
          />
        </div>
      </Card>
    </div>
  );
}
