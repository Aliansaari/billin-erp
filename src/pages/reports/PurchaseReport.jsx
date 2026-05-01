import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Table, DatePicker, Select, Button, Tag, message, Spin, Checkbox, Popover, Input } from 'antd';
import { DownloadOutlined, SettingOutlined, PrinterOutlined, SearchOutlined, CloseOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { reportAPI, partyAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';

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

// KPI cards user can pick from the Customize popover. Semantic tones map to
// theme CSS vars so tiles re-skin automatically when switching Classic↔Modern.
const ALL_KPIS = [
  { key: 'purchases',   label: 'Total Purchases', tone: 'accent',  default: true,
    value: (s) => `₹ ${parseFloat(s.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'gst',         label: 'Total GST',       tone: 'warning', default: true,
    value: (s) => `₹ ${parseFloat(s.total_gst || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'discount',    label: 'Total Discount',  tone: 'success', default: true,
    value: (s) => `₹ ${parseFloat(s.total_discount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'paid',        label: 'Total Paid',      tone: 'success', default: true,
    value: (s) => `₹ ${parseFloat(s.total_paid || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'balance',     label: 'Total Balance',   tone: 'danger',  default: true,
    value: (s) => `₹ ${parseFloat(s.total_balance || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'sub_total',   label: 'Taxable Value',   tone: 'info',    default: false,
    value: (s) => `₹ ${parseFloat(s.total_sub || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` },
  { key: 'bill_count',  label: 'Bill Count',      tone: 'neutral', default: false,
    value: (_s, count) => String(count || 0) },
];
const KPIS_STORAGE_KEY = 'purchaseReport_kpis_v1';
const DEFAULT_KPIS = ALL_KPIS.reduce((o, k) => ({ ...o, [k.key]: k.default }), {});

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
    search: '',
  });
  const [reconDismissed, setReconDismissed] = useState(false);
  const [preset, setPreset] = useState('this_fy');
  const [reconciliation, setReconciliation] = useState(null);
  const [colsVisible, setColsVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  const [kpisVisible, setKpisVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KPIS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_KPIS, ...saved } : DEFAULT_KPIS;
    } catch { return DEFAULT_KPIS; }
  });
  const loaderRef = useRef(null);
  const scrollRef = useRef(null);

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
    try { localStorage.setItem(KPIS_STORAGE_KEY, JSON.stringify(kpisVisible)); } catch {}
  }, [kpisVisible]);

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
      { root: scrollRef.current || null, threshold: 0.1 }
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
    bill_no:       { title: 'Bill No',      dataIndex: 'bill_number', width: 130,
                     render: (v) => <span className="rpt-bill-no">{v}</span> },
    date:          { title: 'Date',         dataIndex: 'bill_date',   width: 110, render: (v) => dayjs(v).format('DD/MM/YYYY') },
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
                     render: (v) => v ? dayjs(v).format('DD/MM/YYYY') : '—' },
    overdue_days:  { title: 'Overdue',      width: 90, align: 'right',
                     render: (_, r) => {
                       const d = rowOverdueDays(r);
                       if (d === null) return '—';
                       return <span style={{ color: d > 30 ? '#dc2626' : d > 0 ? '#d97706' : undefined, fontFamily: 'Geist Mono, monospace' }}>{d > 0 ? `${d} d` : '—'}</span>;
                     } },
    status:        { title: 'Status',       dataIndex: 'payment_status', width: 90,
                     render: (s) => <span className={`rpt-pill ${s === 'Paid' ? 'paid' : s === 'Partial' ? 'partial' : 'unpaid'}`}>{s}</span> },
  }), []);

  const columns = useMemo(() => {
    return ALL_COLS.filter((c) => colsVisible[c.key]).map((c) => ({ key: c.key, ...COL_SPECS[c.key] }));
  }, [colsVisible, COL_SPECS]);

  const customizePopoverContent = (
    <div style={{ width: 360, maxHeight: '70vh', overflowY: 'auto' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-secondary, #6b7280)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>KPI Cards</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 14 }}>
        {ALL_KPIS.map((k) => (
          <div key={k.key}>
            <Checkbox checked={!!kpisVisible[k.key]} onChange={(e) => setKpisVisible((v) => ({ ...v, [k.key]: e.target.checked }))}>
              {k.label}
            </Checkbox>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-secondary, #6b7280)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Columns</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
        {ALL_COLS.map((c) => (
          <div key={c.key}>
            <Checkbox checked={!!colsVisible[c.key]} onChange={(e) => setColsVisible((v) => ({ ...v, [c.key]: e.target.checked }))}>
              {c.label}
            </Checkbox>
          </div>
        ))}
      </div>
    </div>
  );

  const fyLabel = fyStart ? `FY ${dayjs(fyStart).format('YYYY')}-${dayjs(fyEnd).format('YY')}` : '';
  const handlePrint = () => window.print();

  return (
    <div className="report-editorial" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="rpt-page-hd">
        <div className="rpt-title">
          <h1>Purchase Report</h1>
          <div className="rpt-sub">
            <b>{totalCount}</b> bill{totalCount === 1 ? '' : 's'}
            {fyLabel && <><span className="sep">·</span>{fyLabel}</>}
            {data.length < totalCount && <><span className="sep">·</span>showing <b>{data.length}</b></>}
          </div>
        </div>
        <div className="rpt-hd-ctrl">
          <div className="rpt-period">
            {[
              { v: 'this_fy', l: 'This FY' },
              { v: 'last_fy', l: 'Last FY' },
              { v: 'this_q', l: 'This Q' },
              { v: 'this_month', l: 'This Month' },
              { v: 'custom', l: 'Custom' },
            ].map((p) => (
              <button key={p.v} className={preset === p.v ? 'on' : ''} onClick={() => setPreset(p.v)}>{p.l}</button>
            ))}
          </div>
          <DatePicker.RangePicker
            format="DD/MM/YYYY" className="rpt-date"
            allowClear={false}
            value={[dayjs(filters.from_date), dayjs(filters.to_date)]}
            onChange={(v) => {
              setPreset('custom');
              const from = v?.[0]?.format('YYYY-MM-DD') || fyStart || dayjs().startOf('month').format('YYYY-MM-DD');
              const to   = v?.[1]?.format('YYYY-MM-DD') || fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD');
              setFilters((f) => ({ ...f, from_date: from, to_date: to }));
            }}
          />
          <Popover content={customizePopoverContent} title="Customize" trigger="click" placement="bottomRight">
            <Button icon={<SettingOutlined />} className="rpt-btn">Customize</Button>
          </Popover>
          <Button icon={<DownloadOutlined />} onClick={handleExport} className="rpt-btn">Excel</Button>
          <Button icon={<PrinterOutlined />} onClick={handlePrint} className="rpt-btn">Print</Button>
        </div>
      </div>

      {ALL_KPIS.some((k) => kpisVisible[k.key]) && (
        <div className="rpt-kpis">
          {ALL_KPIS.filter((k) => kpisVisible[k.key]).map((k) => {
            const tone = typeof k.tone === 'function' ? k.tone(summary) : k.tone;
            return (
              <div key={k.key} className={`rpt-kpi tone-${tone}`}>
                <div className="rpt-kpi-k">{k.label}</div>
                <div className="rpt-kpi-v">{k.value(summary, totalCount)}</div>
              </div>
            );
          })}
        </div>
      )}

      {reconciliation && !reconciliation.balanced && !reconDismissed && (
        <div className="rpt-recon warn">
          <div className="rpt-recon-ic"><WarningOutlined /></div>
          <div className="rpt-recon-body">
            <div className="rpt-recon-title">Purchase ledger does not reconcile to bill aggregate</div>
            <div className="rpt-recon-formula">
              {reconciliation.ledger_name} net Dr <b>{fmt(reconciliation.ledger_net_debit)}</b> vs bills:
              {' '}sub <b>{fmt(reconciliation.register_taxable)}</b>
              {' '}− discount <b>{fmt(reconciliation.register_discount)}</b>
              {' '}+ freight <b>{fmt(reconciliation.register_freight)}</b>
              {' '}+ other <b>{fmt(reconciliation.register_other)}</b>
              <span className="delta"> → {fmt(reconciliation.difference)} drift</span>
            </div>
          </div>
          <button className="rpt-recon-x" onClick={() => setReconDismissed(true)} aria-label="Dismiss"><CloseOutlined /></button>
        </div>
      )}

      <div className="rpt-filter">
        <Input
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder="Search bill no, supplier, GSTIN, or supplier-bill…"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          allowClear
        />
        <span className="rpt-sep" />
        {[
          { v: 'Unpaid',  d: 'unpaid'  },
          { v: 'Partial', d: 'partial' },
          { v: 'Paid',    d: 'paid'    },
        ].map((s) => (
          <button key={s.v}
            className={`rpt-chip ${filters.payment_status === s.v ? 'on' : ''}`}
            onClick={() => setFilters((f) => ({ ...f, payment_status: f.payment_status === s.v ? null : s.v }))}>
            <span className={`rpt-dot ${s.d}`} />{s.v}
          </button>
        ))}
      </div>

      <div className="rpt-tbl-wrap">
        <div ref={scrollRef} className="report-table-scroll rpt-tbl">
          <Table
            columns={columns}
            dataSource={(filters.search ? data.filter((r) => {
              const q = filters.search.toLowerCase();
              return (r.bill_number || '').toLowerCase().includes(q)
                  || (r.supplier?.party_name || '').toLowerCase().includes(q)
                  || (r.supplier_bill_number || '').toLowerCase().includes(q)
                  || String(r.total_amount || '').includes(q);
            }) : data)}
            rowKey="purchase_bill_id"
            loading={loading}
            size="small"
            scroll={{ x: 1300 }}
            sticky={{ offsetHeader: 0, offsetSummary: 0 }}
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
              {loadingMore ? <Spin size="small" /> : <span style={{ color: 'var(--fg-secondary)', fontSize: 12 }}>Scroll for more…</span>}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
