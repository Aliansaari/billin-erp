import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Table, Card, DatePicker, Select, Button, Tag, Typography, Space, message, Spin } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI, partyAPI } from '../../api';

const { Title } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// Rows per server request. Keep moderate so the first paint is fast; an
// IntersectionObserver pulls the next page when the user scrolls near the end.
const PAGE_SIZE = 200;

export default function SalesReport() {
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0); // full filtered count across all pages
  const [summary, setSummary] = useState({});
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [serverPage, setServerPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [filters, setFilters] = useState({
    from_date: dayjs().startOf('month').format('YYYY-MM-DD'),
    to_date: dayjs().endOf('month').format('YYYY-MM-DD'),
    customer_id: null,
    payment_status: null,
  });
  const loaderRef = useRef(null);

  useEffect(() => {
    loadCustomers();
  }, []);

  useEffect(() => {
    loadFirstPage();
  }, [filters]);

  const loadCustomers = async () => {
    try {
      const { data } = await partyAPI.getCustomers();
      setCustomers(data.data || data);
    } catch (e) { /* ignore */ }
  };

  const loadFirstPage = async () => {
    setLoading(true);
    setData([]);
    setServerPage(1);
    setHasMore(true);
    try {
      // Paginate so firms with years of bills (10k+) don't hit a 1000-row wall.
      // Summary comes from the backend aggregate (full filtered dataset) — it
      // stays accurate regardless of how many pages are currently materialized.
      const res = await reportAPI.getSalesReport({ ...filters, page: 1, limit: PAGE_SIZE });
      setData(res.data.data || []);
      setTotalCount(res.data.total || 0);
      setSummary(res.data.summary || {});
      setHasMore((res.data.data || []).length < (res.data.total || 0));
    } catch (e) {
      message.error('Failed to load sales report');
    }
    setLoading(false);
  };

  const loadNextPage = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return;
    setLoadingMore(true);
    const next = serverPage + 1;
    try {
      const res = await reportAPI.getSalesReport({ ...filters, page: next, limit: PAGE_SIZE });
      const rows = res.data.data || [];
      setData(prev => [...prev, ...rows]);
      setTotalCount(res.data.total || 0);
      setServerPage(next);
      setHasMore(next * PAGE_SIZE < (res.data.total || 0));
    } catch (e) {
      message.error('Failed to load more bills');
    }
    setLoadingMore(false);
  }, [loadingMore, hasMore, loading, serverPage, filters]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadNextPage(); },
      { threshold: 0.1 }
    );
    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [loadNextPage]);

  const handleExport = async () => {
    try {
      // Pass the SAME filters the table is using — server streams the full filtered
      // dataset (no pagination). Previously the Export button invoked the generic
      // "all sales ever" dump which ignored date/customer/status filters entirely.
      const res = await reportAPI.exportSalesReport(filters);
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      const from = filters.from_date || 'all';
      const to   = filters.to_date   || 'now';
      a.download = `sales_report_${from}_to_${to}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      message.error('Export failed');
    }
  };

  // rowGST = CGST + SGST + IGST + Cess (SalesBill stores these as separate columns,
  // there's no single gst_amount field — summing here gives the row-level tax.)
  const rowGST = (r) => parseFloat(r.cgst_amount || 0) + parseFloat(r.sgst_amount || 0)
                       + parseFloat(r.igst_amount || 0) + parseFloat(r.cess_amount || 0);

  const columns = [
    { title: 'Bill No', dataIndex: 'bill_number', width: 130 },
    { title: 'Date', dataIndex: 'bill_date', width: 110, render: (v) => dayjs(v).format('DD-MMM-YYYY') },
    { title: 'Customer', dataIndex: ['customer', 'party_name'], width: 180, render: (v) => v || 'Cash Sale' },
    { title: 'Items', dataIndex: 'total_items', width: 70, align: 'center' },
    { title: 'Sub Total', dataIndex: 'sub_total', width: 120, align: 'right', render: fmt },
    { title: 'Discount', dataIndex: 'discount_amount', width: 100, align: 'right', render: fmt },
    { title: 'GST', width: 100, align: 'right', render: (_, r) => fmt(rowGST(r)) },
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
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            {totalCount} bill{totalCount === 1 ? '' : 's'}
            {data.length < totalCount ? ` · showing ${data.length}` : ''}
          </span>
        </div>
        <Button icon={<DownloadOutlined />} onClick={handleExport} style={{ height: 38 }}>Export Excel</Button>
      </div>

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Filter Bar */}
        <div className="erp-filter-bar">
          <DatePicker.RangePicker
            format="DD-MMM-YYYY" style={{ height: 34 }}
            allowClear={false}
            defaultValue={[dayjs().startOf('month'), dayjs().endOf('month')]}
            onChange={(v) => {
              // Clearing the picker previously set both dates to null — the backend
              // then returned EVERY sales bill ever entered, which blew up the
              // browser and was almost never what the user intended. Lock the
              // picker to a required range (allowClear=false) and fall back to
              // the current month if the change handler still gets a null range.
              const from = v?.[0]?.format('YYYY-MM-DD') || dayjs().startOf('month').format('YYYY-MM-DD');
              const to   = v?.[1]?.format('YYYY-MM-DD') || dayjs().endOf('month').format('YYYY-MM-DD');
              setFilters((f) => ({ ...f, from_date: from, to_date: to }));
            }}
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
                    {/* Totals come from the backend summary (entire filtered range),
                        NOT from data.reduce — the latter would only sum the visible rows
                        and drift from the bill-count label whenever pagination truncates. */}
                    <Table.Summary.Cell index={0} colSpan={4}>Total (all {totalCount})</Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right">{fmt(summary.total_sub)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={5} align="right">{fmt(summary.total_discount)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={6} align="right">{fmt(summary.total_gst)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={7} align="right">{fmt(summary.total_amount)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={8} align="right">{fmt(summary.total_paid)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={9} align="right">{fmt(summary.total_balance)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={10} />
                  </Table.Summary.Row>
                </Table.Summary>
              ) : null
            }
          />
          {/* Infinite-scroll sentinel — when visible, fetch the next page. */}
          {hasMore && (
            <div ref={loaderRef} style={{ textAlign: 'center', padding: '12px 0' }}>
              {loadingMore ? <Spin size="small" /> : <span style={{ color: '#6b7280', fontSize: 12 }}>Scroll for more…</span>}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
