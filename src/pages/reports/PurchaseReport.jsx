import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Table, Card, DatePicker, Select, Button, Tag, Typography, Space, message, Spin, Alert, Checkbox, Popover } from 'antd';
import { DownloadOutlined, SettingOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI, partyAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';

const { Title } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const PAGE_SIZE = 200;

// Optional columns the user can toggle. supplier_bill_no is unique to
// the purchase side (and matters for ITC matching).
const OPTIONAL_COLS = [
  { key: 'gstin',         label: 'GSTIN' },
  { key: 'state',         label: 'State' },
  { key: 'supplier_bill', label: 'Supplier bill no' },
  { key: 'cgst',          label: 'CGST' },
  { key: 'sgst',          label: 'SGST' },
  { key: 'igst',          label: 'IGST' },
  { key: 'cess',          label: 'Cess' },
];
const COLS_STORAGE_KEY = 'purchaseReport_cols_v1';
const DEFAULT_COLS = { gstin: false, state: false, supplier_bill: false, cgst: false, sgst: false, igst: false, cess: false };

function presetRange(key, fyStart, fyEnd) {
  const today = dayjs();
  if (key === 'this_fy'    && fyStart && fyEnd) return [dayjs(fyStart), dayjs(fyEnd)];
  if (key === 'last_fy'    && fyStart && fyEnd) return [dayjs(fyStart).subtract(1, 'year'), dayjs(fyEnd).subtract(1, 'year')];
  if (key === 'this_q')     return [today.startOf('quarter'), today.endOf('quarter')];
  if (key === 'this_month') return [today.startOf('month'), today.endOf('month')];
  return null;
}

export default function PurchaseReport() {
  const { fyStart, fyEnd } = useFinancialYear();
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0); // full filtered count across all pages
  const [summary, setSummary] = useState({});
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [serverPage, setServerPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  // Defaults to the company FY for consistency with every other
  // period selector. Falls back to current month on first install.
  const [filters, setFilters] = useState({
    from_date: fyStart || dayjs().startOf('month').format('YYYY-MM-DD'),
    to_date:   fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD'),
    supplier_id: null,
    payment_status: null,
  });
  const [preset, setPreset] = useState('this_fy');
  const [reconciliation, setReconciliation] = useState(null);
  const [colsVisible, setColsVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  const loaderRef = useRef(null);

  useEffect(() => {
    if (preset === 'custom') return;
    const r = presetRange(preset, fyStart, fyEnd);
    if (r) {
      const from = r[0].format('YYYY-MM-DD');
      const to   = r[1].format('YYYY-MM-DD');
      if (from !== filters.from_date || to !== filters.to_date) {
        setFilters((f) => ({ ...f, from_date: from, to_date: to }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, fyStart, fyEnd]);

  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(colsVisible)); } catch {}
  }, [colsVisible]);

  useEffect(() => {
    loadSuppliers();
  }, []);

  useEffect(() => {
    loadFirstPage();
  }, [filters]);

  const loadSuppliers = async () => {
    try {
      const { data } = await partyAPI.getSuppliers();
      setSuppliers(data.data || data);
    } catch (e) { /* ignore */ }
  };

  const loadFirstPage = async () => {
    setLoading(true);
    setData([]);
    setServerPage(1);
    setHasMore(true);
    try {
      // Paginate. Summary totals come from backend aggregate over the full
      // filtered dataset, so numbers stay correct as the user scrolls.
      const res = await reportAPI.getPurchaseReport({ ...filters, page: 1, limit: PAGE_SIZE });
      setData(res.data.data || []);
      setTotalCount(res.data.total || 0);
      setSummary(res.data.summary || {});
      setReconciliation(res.data.reconciliation || null);
      setHasMore((res.data.data || []).length < (res.data.total || 0));
    } catch (e) {
      message.error('Failed to load purchase report');
    }
    setLoading(false);
  };

  const loadNextPage = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return;
    setLoadingMore(true);
    const next = serverPage + 1;
    try {
      const res = await reportAPI.getPurchaseReport({ ...filters, page: next, limit: PAGE_SIZE });
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
      // Honor on-screen filters (date, supplier, payment status) — server streams
      // the full filtered dataset. Old call dumped every purchase ever entered.
      const res = await reportAPI.exportPurchaseReport(filters);
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      const from = filters.from_date || 'all';
      const to   = filters.to_date   || 'now';
      a.download = `purchase_report_${from}_to_${to}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      message.error('Export failed');
    }
  };

  // rowGST = CGST + SGST + IGST + Cess (no single gst_amount column on PurchaseBill;
  // sum the components so the row-level GST cell shows real data instead of ₹0.)
  const rowGST = (r) => parseFloat(r.cgst_amount || 0) + parseFloat(r.sgst_amount || 0)
                       + parseFloat(r.igst_amount || 0) + parseFloat(r.cess_amount || 0);

  const columns = useMemo(() => {
    const cols = [
      { title: 'Bill No', dataIndex: 'bill_number', width: 130 },
      { title: 'Date', dataIndex: 'bill_date', width: 110, render: (v) => dayjs(v).format('DD-MMM-YYYY') },
      { title: 'Supplier', dataIndex: ['supplier', 'party_name'], width: 180 },
    ];
    if (colsVisible.supplier_bill) cols.push({ title: 'Supp. Bill No', dataIndex: 'supplier_bill_number', width: 140,
      render: (v) => v || '—' });
    if (colsVisible.gstin) cols.push({ title: 'GSTIN', dataIndex: ['supplier', 'gstin'], width: 150,
      render: (v) => v ? <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</Tag> : '—' });
    if (colsVisible.state) cols.push({ title: 'State', dataIndex: ['supplier', 'state'], width: 130, render: (v) => v || '—' });
    cols.push(
      { title: 'Items', dataIndex: 'total_items', width: 70, align: 'center' },
      { title: 'Sub Total', dataIndex: 'sub_total', width: 120, align: 'right', render: fmt },
      { title: 'Discount', dataIndex: 'discount_amount', width: 100, align: 'right', render: fmt },
    );
    if (colsVisible.cgst) cols.push({ title: 'CGST', dataIndex: 'cgst_amount', width: 90, align: 'right', render: fmt });
    if (colsVisible.sgst) cols.push({ title: 'SGST', dataIndex: 'sgst_amount', width: 90, align: 'right', render: fmt });
    if (colsVisible.igst) cols.push({ title: 'IGST', dataIndex: 'igst_amount', width: 90, align: 'right', render: fmt });
    if (colsVisible.cess) cols.push({ title: 'Cess', dataIndex: 'cess_amount', width: 90, align: 'right', render: fmt });
    cols.push(
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
    );
    return cols;
  }, [colsVisible]);

  const colsPickerContent = (
    <div style={{ minWidth: 200 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Optional columns</div>
      {OPTIONAL_COLS.map((c) => (
        <div key={c.key} style={{ padding: '4px 0' }}>
          <Checkbox checked={colsVisible[c.key]} onChange={(e) => setColsVisible((v) => ({ ...v, [c.key]: e.target.checked }))}>
            {c.label}
          </Checkbox>
        </div>
      ))}
    </div>
  );

  const fmt2 = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Purchase Report</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            {totalCount} bill{totalCount === 1 ? '' : 's'}
            {data.length < totalCount ? ` · showing ${data.length}` : ''}
          </span>
        </div>
        <Space>
          <Popover content={colsPickerContent} title="Columns" trigger="click" placement="bottomRight">
            <Button icon={<SettingOutlined />} style={{ height: 38 }}>Columns</Button>
          </Popover>
          <Button icon={<DownloadOutlined />} onClick={handleExport} style={{ height: 38 }}>Export Excel</Button>
        </Space>
      </div>

      {reconciliation && !reconciliation.balanced && (
        <Alert type="warning" showIcon style={{ margin: '0 20px' }}
          message="Purchase ledger does not reconcile to bills"
          description={
            <div style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
              <div>{reconciliation.ledger_name} net Dr: <b>₹{fmt(reconciliation.ledger_net_debit).replace('₹ ', '')}</b></div>
              <div>vs bills: sub ₹{fmt(reconciliation.register_taxable).replace('₹ ', '')} − disc ₹{fmt(reconciliation.register_discount).replace('₹ ', '')} + freight ₹{fmt(reconciliation.register_freight).replace('₹ ', '')} + other ₹{fmt(reconciliation.register_other).replace('₹ ', '')} = <b>₹{fmt(reconciliation.register_net_to_ledger).replace('₹ ', '')}</b></div>
              <div>Difference: <b style={{ color: '#ff4d4f' }}>{fmt(reconciliation.difference)}</b></div>
            </div>
          }
        />
      )}

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Filter Bar */}
        <div className="erp-filter-bar">
          <Select value={preset} onChange={setPreset} style={{ width: 140, height: 34 }}
            options={[
              { value: 'this_fy',    label: 'This FY' },
              { value: 'last_fy',    label: 'Last FY' },
              { value: 'this_q',     label: 'This Quarter' },
              { value: 'this_month', label: 'This Month' },
              { value: 'custom',     label: 'Custom' },
            ]} />
          <DatePicker.RangePicker
            format="DD-MMM-YYYY" style={{ height: 34 }}
            allowClear={false}
            value={[dayjs(filters.from_date), dayjs(filters.to_date)]}
            onChange={(v) => {
              setPreset('custom');
              const from = v?.[0]?.format('YYYY-MM-DD') || fyStart || dayjs().startOf('month').format('YYYY-MM-DD');
              const to   = v?.[1]?.format('YYYY-MM-DD') || fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD');
              setFilters((f) => ({ ...f, from_date: from, to_date: to }));
            }}
          />
          <Select placeholder="All Suppliers" style={{ width: 180, height: 34 }} allowClear showSearch optionFilterProp="children"
            onChange={(v) => setFilters((f) => ({ ...f, supplier_id: v }))}>
            {suppliers.map((s) => (
              <Select.Option key={s.party_id} value={s.party_id}>{s.party_name}</Select.Option>
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
          <div className="erp-summary-stat" style={{ background: '#eef2ff' }}>
            <span className="erp-summary-stat-label">Total Purchases</span>
            <span className="erp-summary-stat-value" style={{ color: '#4F46E5' }}>{fmt2(summary.total_amount)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#fffbeb' }}>
            <span className="erp-summary-stat-label">Total GST</span>
            <span className="erp-summary-stat-value" style={{ color: '#D97706' }}>{fmt2(summary.total_gst)}</span>
          </div>
          <div className="erp-summary-stat" style={{ background: '#ecfdf5' }}>
            <span className="erp-summary-stat-label">Total Discount</span>
            <span className="erp-summary-stat-value" style={{ color: '#059669' }}>{fmt2(summary.total_discount)}</span>
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
            rowKey="purchase_bill_id"
            loading={loading}
            size="small"
            scroll={{ x: 1300 }}
            pagination={false}
            summary={() => {
              if (data.length === 0) return null;
              const totalForCol = (c) => {
                if (c.dataIndex === 'sub_total')         return fmt(summary.total_sub);
                if (c.dataIndex === 'discount_amount')   return fmt(summary.total_discount);
                if (c.dataIndex === 'cgst_amount')       return fmt(summary.total_cgst);
                if (c.dataIndex === 'sgst_amount')       return fmt(summary.total_sgst);
                if (c.dataIndex === 'igst_amount')       return fmt(summary.total_igst);
                if (c.dataIndex === 'cess_amount')       return fmt(summary.total_cess);
                if (c.title === 'GST')                   return fmt(summary.total_gst);
                if (c.dataIndex === 'total_amount')      return fmt(summary.total_amount);
                if (c.dataIndex === 'paid_amount')       return fmt(summary.total_paid);
                if (c.dataIndex === 'balance_amount')    return fmt(summary.total_balance);
                return null;
              };
              return (
                <Table.Summary fixed>
                  <Table.Summary.Row style={{ background: '#fafafa', fontWeight: 'bold' }}>
                    {columns.map((c, i) => {
                      if (i === 0) return (
                        <Table.Summary.Cell key="label" index={0} colSpan={3}>
                          Total (all {totalCount})
                        </Table.Summary.Cell>
                      );
                      if (i === 1 || i === 2) return null;
                      const v = totalForCol(c);
                      return (
                        <Table.Summary.Cell key={i} index={i} align={c.align || 'left'}>
                          {v}
                        </Table.Summary.Cell>
                      );
                    })}
                  </Table.Summary.Row>
                </Table.Summary>
              );
            }}
          />
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
