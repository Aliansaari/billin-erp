import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DatePicker, Button, Tag, message, Checkbox, Popover, Input } from 'antd';
import { SettingOutlined, SearchOutlined, CloseOutlined, WarningOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import { useDatePopup } from '../../components/keyboard/DatePopup';

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// Every column toggleable. `default: true` ships visible. supplier_bill
// is unique to purchase (matters for ITC matching against supplier's
// own document number).
const ALL_COLS = [
  { key: 'sr_no',         label: 'Sr No',            default: true  },
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
  // URL search params — when reached via a P&L drill-down on
  // Purchase Account, `?from=YYYY-MM-DD&to=…` carries the source
  // report's window so the period stays consistent.
  const [searchParams] = useSearchParams();
  const initialFrom = (() => {
    const q = searchParams.get('from');
    return q && dayjs(q).isValid() ? q : null;
  })();
  const initialTo = (() => {
    const q = searchParams.get('to');
    return q && dayjs(q).isValid() ? q : null;
  })();

  // Defaults to the company FY for consistency with every other
  // period selector. Falls back to current month on first install.
  const [filters, setFilters] = useState({
    from_date: initialFrom || fyStart || dayjs().startOf('month').format('YYYY-MM-DD'),
    to_date:   initialTo   || fyEnd   || dayjs().endOf('month').format('YYYY-MM-DD'),
    supplier_id: null,
    payment_status: null,
    search: '',
  });
  // Local search input — debounced into filters.search so we don't fire
  // a server request on every keystroke. Server-side search is
  // mandatory under virtualization (the client can't filter rows it
  // hasn't loaded).
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 220);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [reconDismissed, setReconDismissed] = useState(false);
  // If reached via drill-down with explicit dates, show 'Custom range'
  // in the picker so the label reads honestly.
  const [preset, setPreset] = useState(initialFrom && initialTo ? 'custom' : 'this_fy');
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

  // ── Virtualized data layer ────────────────────────────────────────
  // The hook owns chunked fetching, in-flight dedupe, sparse rows,
  // and meta passthrough (for the reconciliation banner).
  const { rows, totalCount, summary, meta, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => reportAPI.getPurchaseReport(params),
    filters,
    chunkSize: 200,
  });
  const reconciliation = meta?.reconciliation || null;

  // Cursor + multi-select for the bills table; F-keys live in the
  // bottom ActionStrip and operate on the cursored row.
  const navigate = useNavigate();
  const sel = useListSelection({ totalCount, rows });
  const single = sel.activeRow;
  const searchInputRef = useRef(null);
  const { openDate } = useDatePopup();

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

  const handleExport = async () => {
    try {
      // Honor on-screen filters (date, supplier, payment status) — server streams
      // the full filtered dataset.
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
    // Sr No is purely positional — driven by row index, no backing field.
    // The summary row's "Total (count)" label colSpans to start here.
    sr_no:         { title: 'Sr',          width: 56, align: 'center',
                     render: (_v, _row, idx) => <span style={{ color: 'var(--fg-tertiary)', fontFamily: 'Geist Mono, monospace' }}>{idx + 1}</span> },
    bill_no:       { title: 'Bill No',      dataIndex: 'bill_number', width: 130,
                     render: (v) => <span className="rpt-bill-no">{v}</span> },
    date:          { title: 'Date',         dataIndex: 'bill_date',   width: 110, render: (v) => dayjs(v).format('DD/MM/YYYY') },
    supplier:      { title: 'Supplier',     dataIndex: ['supplier', 'party_name'], width: 180,
                     render: (v, row) => {
                       const isCash = row?.supplier?.is_system_cash || !v;
                       const w = String(row?.walk_in_name || '').trim();
                       return isCash ? (w ? `Cash — ${w}` : 'Cash') : v;
                     } },
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

  // Per-column summary content + colSpan. Same pattern as SalesReport:
  // the leading non-aggregable columns (Sr/Bill No/Date/Supplier/etc.)
  // merge into one wide cell holding the "Total (N)" label, and each
  // numeric column carries its own server-aggregated value.
  const SUMMABLE_KEYS = useMemo(() => new Set([
    'sub_total', 'discount', 'cgst', 'sgst', 'igst', 'cess', 'gst',
    'total', 'paid', 'balance',
  ]), []);

  const firstAggIdx = useMemo(() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  }, [columns, SUMMABLE_KEYS]);

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

  const summaryCells = (col, idx) => {
    if (idx === 0) return totalCount > 0 ? `Total (${totalCount})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;          // merged into idx 0
    return totalForKey(col.key);
  };

  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  // Shared `.cols-menu` markup so the global customize-menu styles
  // (styles/global.css) drive the look — pill rows + accent rail when
  // checked. Functional state untouched.
  const customizePopoverContent = (
    <div className="cols-menu" style={{ width: 280, maxHeight: '70vh', overflowY: 'auto' }}>
      <div className="grp">
        <div className="mh">KPI Cards</div>
        {ALL_KPIS.map((k) => (
          <label key={k.key} className="opt">
            <input
              type="checkbox"
              checked={!!kpisVisible[k.key]}
              onChange={(e) => setKpisVisible((v) => ({ ...v, [k.key]: e.target.checked }))}
            />
            <span>{k.label}</span>
          </label>
        ))}
      </div>
      <div className="grp">
        <div className="mh">Columns</div>
        {ALL_COLS.map((c) => (
          <label key={c.key} className="opt">
            <input
              type="checkbox"
              checked={!!colsVisible[c.key]}
              onChange={(e) => setColsVisible((v) => ({ ...v, [c.key]: e.target.checked }))}
            />
            <span>{c.label}</span>
          </label>
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
          {/* Excel + Print moved to the bottom strip (F10 / F9). */}
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
          ref={searchInputRef}
          className="rpt-search"
          prefix={<SearchOutlined />}
          placeholder="Search bill no, supplier, GSTIN, or supplier-bill…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
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
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="purchase_bill_id"
          scroll={{ x: 1300 }}
          summaryCells={summaryCells}
          summaryColSpan={summaryColSpan}
          controlledCursorIdx={sel.cursorIdx}
          controlledSelectedSet={sel.selectedSet}
          onCursorMove={sel.setCursor}
          onShiftClickRow={sel.extendTo}
          onCtrlClickRow={sel.toggleRow}
          onRow={(record) => ({
            onDoubleClick: () => record?.purchase_bill_id && navigate(`/purchase/edit/${record.purchase_bill_id}`),
          })}
        />
      </div>

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/reports') },
          { id: 'period', key: 'F2', label: 'Period',
            onAction: () => openDate({
              mode: 'range', title: 'Period',
              value: [dayjs(filters.from_date), dayjs(filters.to_date)],
              onConfirm: ([from, to]) => {
                setPreset('custom');
                setFilters((f) => ({
                  ...f,
                  from_date: from.format('YYYY-MM-DD'),
                  to_date:   to.format('YYYY-MM-DD'),
                }));
              },
            }) },
          { id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus?.() },
          { id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => refresh?.() },
          { id: 'print', key: 'F9', label: 'Print',
            onAction: () => handlePrint() },
          { id: 'export', key: 'F10', label: 'Export',
            onAction: () => handleExport() },
          { id: 'drill', key: 'F1', label: 'Open Bill', tone: 'primary',
            disabled: !single,
            onAction: () => single && navigate(`/purchase/edit/${single.purchase_bill_id}`) },
        ]}
      />
    </div>
  );
}
