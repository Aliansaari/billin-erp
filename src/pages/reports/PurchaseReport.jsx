import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Table, Card, DatePicker, Select, Button, Tag, Typography, Space, message, Spin, Alert, Checkbox, Popover } from 'antd';
import { DownloadOutlined, SettingOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI, partyAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';

const { Title } = Typography;

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const PAGE_SIZE = 200;

// Every column toggleable. `default: true` ships visible. supplier_bill
// is unique to purchase (matters for ITC matching against supplier's
// own document number).
const ALL_COLS = [
  { key: 'bill_no',       label: 'Bill No',          default: true  },
  { key: 'date',          label: 'Date',             default: true  },
  { key: 'supplier',      label: 'Supplier',         default: true  },
  { key: 'gstin',         label: 'GSTIN',            default: false },
  { key: 'state',         label: 'State',            default: false },
  { key: 'city',          label: 'City',             default: false },
  { key: 'supplier_bill', label: 'Supplier bill no', default: false },
  { key: 'items',         label: 'Items count',      default: true  },
  { key: 'sub_total',     label: 'Sub Total',        default: true  },
  { key: 'discount',      label: 'Discount',         default: true  },
  { key: 'cgst',          label: 'CGST',             default: false },
  { key: 'sgst',          label: 'SGST',             default: false },
  { key: 'igst',          label: 'IGST',             default: false },
  { key: 'cess',          label: 'Cess',             default: false },
  { key: 'gst',           label: 'GST (combined)',   default: true  },
  { key: 'total',         label: 'Total',            default: true  },
  { key: 'paid',          label: 'Paid',             default: true  },
  { key: 'balance',       label: 'Balance',          default: true  },
  { key: 'payment_mode',  label: 'Payment mode',     default: false },
  { key: 'due_date',      label: 'Due date',         default: false },
  { key: 'overdue_days',  label: 'Days overdue',     default: false },
  { key: 'status',        label: 'Status',           default: true  },
];
const COLS_STORAGE_KEY = 'purchaseReport_cols_v2';
const DEFAULT_COLS = ALL_COLS.reduce((o, c) => ({ ...o, [c.key]: c.default }), {});

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

  const rowGST = (r) => parseFloat(r.cgst_amount || 0) + parseFloat(r.sgst_amount || 0)
                       + parseFloat(r.igst_amount || 0) + parseFloat(r.cess_amount || 0);
  const rowOverdueDays = (r) => {
    if (parseFloat(r.balance_amount || 0) <= 0) return null;
    const billDate = dayjs(r.bill_date);
    const dueDate = r.due_date
      ? dayjs(r.due_date)
      : billDate.add(parseInt(r.supplier?.credit_days, 10) || 0, 'day');
    const diff = dayjs().diff(dueDate, 'day');
    return diff > 0 ? diff : 0;
  };

  const COL_SPECS = useMemo(() => ({
    bill_no:       { title: 'Bill No',      dataIndex: 'bill_number', width: 130 },
    date:          { title: 'Date',         dataIndex: 'bill_date',   width: 110, render: (v) => dayjs(v).format('DD-MMM-YYYY') },
    supplier:      { title: 'Supplier',     dataIndex: ['supplier', 'party_name'], width: 180 },
    gstin:         { title: 'GSTIN',        dataIndex: ['supplier', 'gstin'], width: 150,
                     render: (v) => v ? <Tag style={{ fontFamily: 'Geist Mono, monospace' }}>{v}</Tag> : '—' },
    state:         { title: 'State',        dataIndex: ['supplier', 'state'], width: 130, render: (v) => v || '—' },
    city:          { title: 'City',         dataIndex: ['supplier', 'city'],  width: 130, render: (v) => v || '—' },
    supplier_bill: { title: 'Supp. Bill',   dataIndex: 'supplier_bill_number', width: 140, render: (v) => v || '—' },
    items:         { title: 'Items',        dataIndex: 'total_items', width: 70, align: 'center' },
    sub_total:     { title: 'Sub Total',    dataIndex: 'sub_total', width: 120, align: 'right', render: fmt },
    discount:      { title: 'Discount',     dataIndex: 'discount_amount', width: 100, align: 'right', render: fmt },
    cgst:          { title: 'CGST',         dataIndex: 'cgst_amount', width: 90, align: 'right', render: fmt },
    sgst:          { title: 'SGST',         dataIndex: 'sgst_amount', width: 90, align: 'right', render: fmt },
    igst:          { title: 'IGST',         dataIndex: 'igst_amount', width: 90, align: 'right', render: fmt },
    cess:          { title: 'Cess',         dataIndex: 'cess_amount', width: 90, align: 'right', render: fmt },
    gst:           { title: 'GST',          width: 100, align: 'right', render: (_, r) => fmt(rowGST(r)) },
    total:         { title: 'Total',        dataIndex: 'total_amount', width: 120, align: 'right',
                     render: (v) => <strong>{fmt(v)}</strong> },
    paid:          { title: 'Paid',         dataIndex: 'paid_amount', width: 110, align: 'right', render: fmt },
    balance:       { title: 'Balance',      dataIndex: 'balance_amount', width: 110, align: 'right',
                     render: (v) => <span style={{ color: v > 0 ? '#ff4d4f' : '#52c41a' }}>{fmt(v)}</span> },
    payment_mode:  { title: 'Mode',         dataIndex: 'payment_method', width: 100,
                     render: (v) => v ? <Tag>{v}</Tag> : '—' },
    due_date:      { title: 'Due',          dataIndex: 'due_date', width: 110,
                     render: (v) => v ? dayjs(v).format('DD-MMM-YYYY') : '—' },
    overdue_days:  { title: 'Overdue',      width: 90, align: 'right',
                     render: (_, r) => {
                       const d = rowOverdueDays(r);
                       if (d === null) return '—';
                       return <span style={{ color: d > 30 ? '#dc2626' : d > 0 ? '#d97706' : undefined, fontFamily: 'Geist Mono, monospace' }}>{d > 0 ? `${d} d` : '—'}</span>;
                     } },
    status:        { title: 'Status',       dataIndex: 'payment_status', width: 90,
                     render: (s) => <Tag color={s === 'Paid' ? 'green' : s === 'Partial' ? 'orange' : 'red'}>{s}</Tag> },
  }), []);

  const columns = useMemo(() => {
    return ALL_COLS.filter((c) => colsVisible[c.key]).map((c) => ({ key: c.key, ...COL_SPECS[c.key] }));
  }, [colsVisible, COL_SPECS]);

  const colsPickerContent = (
    <div style={{ minWidth: 320, maxWidth: 360, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
      {ALL_COLS.map((c) => (
        <div key={c.key}>
          <Checkbox checked={!!colsVisible[c.key]} onChange={(e) => setColsVisible((v) => ({ ...v, [c.key]: e.target.checked }))}>
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
              const totalForKey = (k) => {
                switch (k) {
                  case 'sub_total': return fmt(summary.total_sub);
                  case 'discount':  return fmt(summary.total_discount);
                  case 'cgst':      return fmt(summary.total_cgst);
                  case 'sgst':      return fmt(summary.total_sgst);
                  case 'igst':      return fmt(summary.total_igst);
                  case 'cess':      return fmt(summary.total_cess);
                  case 'gst':       return fmt(summary.total_gst);
                  case 'total':     return fmt(summary.total_amount);
                  case 'paid':      return fmt(summary.total_paid);
                  case 'balance':   return fmt(summary.total_balance);
                  default:          return null;
                }
              };
              return (
                <Table.Summary fixed>
                  <Table.Summary.Row style={{ background: '#fafafa', fontWeight: 'bold' }}>
                    {columns.map((c, i) => (
                      <Table.Summary.Cell key={c.key || i} index={i} align={c.align || 'left'}>
                        {i === 0 ? `Total (${totalCount})` : totalForKey(c.key)}
                      </Table.Summary.Cell>
                    ))}
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
