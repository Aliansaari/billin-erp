// ── Bills Outstanding (Receivable / Payable) ─────────────────────────
//
// Bill-LEVEL outstanding list. Sibling to the existing Aging Report
// (which is party-level). One implementation parameterised by `side`
// — Bills Receivable and Bills Payable are the same shape mirrored
// across customer/supplier; sharing avoids two-file drift.
//
// Pairs with /api/reports/bills-receivable + /api/reports/bills-payable
// in billsOutstandingController.js. Server returns paginated chunks
// matching the useVirtualizedReport contract: { data, total, summary,
// reconciliation, filter_meta, bucket_labels, allocation_complete }.
//
// What's on the page (top → bottom):
//   1. Toolbar    — title, comparative-style preset chips for buckets,
//                   group-by selector, column-picker, exports.
//   2. Banners    — reconciliation drift (if any), allocation-incomplete
//                   warning (if FIFO Receipt→Bill not wired).
//   3. KPI tiles  — total outstanding, # bills, # parties, overdue amt,
//                   avg days overdue, oldest days. Click a tile to apply
//                   the matching filter.
//   4. Filter bar — as-of date, party multi-select, bucket chips,
//                   amount range, search, advanced disclosure.
//   5. Table      — VirtualReportTable with default + toggleable cols,
//                   sticky header + summary, bill-level rows.
//
// Filters round-trip through the URL (every filter is a query param)
// so a copy-paste of the URL reproduces the view.
//
// Ledger drill-down convention (matches Sales/Purchase Reports):
//   View Bill          → /sale/edit/:id   |  /purchase/edit/:id
//   View Party Ledger  → /reports/party-ledger?party_id=&from=&to=
//   Record Receipt     → /receipt/new with state.preselect
//   Record Payment     → /payment/new with state.preselect

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Tag, Button, Input, DatePicker, Select, Tooltip, Popover, Checkbox, message, Dropdown, Space } from 'antd';
import {
  DownloadOutlined, SettingOutlined, SearchOutlined, ReloadOutlined,
  CloseOutlined, WarningOutlined, CheckCircleOutlined, EllipsisOutlined,
  PrinterOutlined, WhatsAppOutlined, FilterOutlined, GroupOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { reportAPI, partyAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';
import './bills-outstanding.css';

// ─── Format helpers ──────────────────────────────────────────────────
const fmtINR = (v) => {
  const n = Number(v) || 0;
  return '₹ ' + n.toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
};
const fmtDate = (v) => v ? dayjs(v).format('DD/MM/YYYY') : '—';

// Bucket key from overdue_days. Server bounds default 30/60/90; rather
// than fetching them again here we read from the bucket_labels meta
// the server returns and infer bounds from the labels (cheap, exact).
function bucketFromOverdue(days, bounds) {
  if (days <= 0)   return 'current';
  if (days <= bounds.b1) return 'b1';
  if (days <= bounds.b2) return 'b2';
  if (days <= bounds.b3) return 'b3';
  return 'b4';
}
function inferBoundsFromLabels(labels) {
  // Labels look like "1–30", "31–60", "61–90", "90+". Parse the upper
  // ends to recover b1/b2/b3 without an extra round-trip.
  const parse = (s) => {
    const m = String(s).match(/(\d+)\D+(\d+)/);
    return m ? parseInt(m[2], 10) : null;
  };
  return {
    b1: parse(labels?.b1) || 30,
    b2: parse(labels?.b2) || 60,
    b3: parse(labels?.b3) || 90,
  };
}

// ─── Per-side configuration ──────────────────────────────────────────
//
// Receivable / Payable differ only in three places: title, sub-group
// label on the reconciliation banner, and the "Record Receipt" vs
// "Record Payment" routing. Capture them in a tiny config so the body
// is one component instead of two.
const SIDE = {
  receivable: {
    title:           'Bills Receivable',
    partyLabel:      'Customer',
    partyTypeQuery:  'Customer',
    fetcher:         (p) => reportAPI.billsReceivable(p),
    exporter:        (p) => reportAPI.exportBillsReceivable(p),
    billRoute:       (id) => `/sale/edit/${id}`,
    receiptLabel:    'Record Receipt',
    receiptRoute:    '/receipt/new',
    subGroupName:    'Sundry Debtors',
    csvBaseName:     'bills_receivable',
  },
  payable: {
    title:           'Bills Payable',
    partyLabel:      'Supplier',
    partyTypeQuery:  'Supplier',
    fetcher:         (p) => reportAPI.billsPayable(p),
    exporter:        (p) => reportAPI.exportBillsPayable(p),
    billRoute:       (id) => `/purchase/edit/${id}`,
    receiptLabel:    'Record Payment',
    receiptRoute:    '/payment/new',
    subGroupName:    'Sundry Creditors',
    csvBaseName:     'bills_payable',
  },
};

// ─── Default visible columns + column registry ───────────────────────
const DEFAULT_COLS = {
  bill_no: true, bill_date: true, party_name: true, due_date: true,
  overdue: true, bill_amount: true, paid_amount: true, outstanding: true,
  bucket: true,
  // Optional — off by default
  party_gstin: false, party_city: false, party_state: false,
  party_mobile: false, party_credit_limit: false, party_credit_days: false,
  salesman: false, notes: false, created_by: false,
};

const COLS_KEY = 'erp_bills_outstanding_cols';

export default function BillsOutstanding({ side }) {
  const cfg = SIDE[side];
  if (!cfg) throw new Error(`BillsOutstanding: unknown side "${side}"`);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Filter state — every value is URL-shareable ──────────────────
  // Initial values come from the URL on first render; subsequent
  // changes flush back into the URL via setSearchParams (replace, not
  // push, so the browser back stack stays clean).
  const initialFromUrl = (key, fallback = '') =>
    (searchParams.get(key) ?? fallback);
  const initialArrayFromUrl = (key) =>
    (searchParams.get(key) || '').split(',').filter(Boolean);

  const [asOf, setAsOf] = useState(() => {
    const q = initialFromUrl('as_of');
    return q && dayjs(q).isValid() ? q : dayjs().format('YYYY-MM-DD');
  });
  const [partyIds, setPartyIds]     = useState(() => initialArrayFromUrl('party_ids').map((s) => parseInt(s, 10)).filter(Number.isFinite));
  const [buckets, setBuckets]       = useState(() => initialArrayFromUrl('buckets'));
  const [cities, setCities]         = useState(() => initialArrayFromUrl('cities'));
  const [credit, setCredit]         = useState(() => initialFromUrl('credit') || 'all');
  const [minAmount, setMinAmount]   = useState(() => initialFromUrl('min_amount'));
  const [maxAmount, setMaxAmount]   = useState(() => initialFromUrl('max_amount'));
  const [showZero, setShowZero]     = useState(() => initialFromUrl('show_zero') === 'true');
  const [groupBy, setGroupBy]       = useState(() => initialFromUrl('group_by') || 'none');
  const [sort, setSort]             = useState(() => initialFromUrl('sort') || 'outstanding');
  const [dir, setDir]               = useState(() => initialFromUrl('dir') || 'desc');
  const [searchInput, setSearchInput] = useState(() => initialFromUrl('search'));
  const [search, setSearch]         = useState(() => initialFromUrl('search'));   // debounced

  // Debounce free-text search so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Banner dismissal — per-session only (no localStorage). The
  // allocation-incomplete banner is a real limitation, not a noise
  // notification, so we don't permanently silence it.
  const [allocBannerDismissed, setAllocBannerDismissed] = useState(false);
  const [reconBannerDismissed, setReconBannerDismissed] = useState(false);
  const [advancedOpen, setAdvancedOpen]                 = useState(false);

  // Column-picker state — persisted, same pattern as Sales Report.
  const [colsVisible, setColsVisible] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_KEY, JSON.stringify(colsVisible)); } catch {}
  }, [colsVisible]);

  // Party-search options for the multi-select. Loaded once per side
  // (Customer vs Supplier) and cached on the component for the session.
  const [partyOptions, setPartyOptions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    partyAPI.getAll({ party_type: cfg.partyTypeQuery, limit: 5000 })
      .then((r) => {
        if (cancelled) return;
        const list = r?.data?.data || r?.data || [];
        setPartyOptions(list.map((p) => ({
          value: p.party_id,
          label: p.party_name + (p.city ? ` · ${p.city}` : ''),
        })));
      })
      .catch(() => { /* surface via the empty state if needed */ });
    return () => { cancelled = true; };
  }, [cfg.partyTypeQuery]);

  // ── URL sync ──────────────────────────────────────────────────────
  // Round-trip every filter into the URL (replace, not push). The
  // useSearchParams hook owns the browser URL; we just write to it.
  useEffect(() => {
    const next = {};
    if (asOf)            next.as_of = asOf;
    if (partyIds.length) next.party_ids = partyIds.join(',');
    if (buckets.length)  next.buckets = buckets.join(',');
    if (cities.length)   next.cities = cities.join(',');
    if (credit !== 'all') next.credit = credit;
    if (minAmount)       next.min_amount = String(minAmount);
    if (maxAmount)       next.max_amount = String(maxAmount);
    if (showZero)        next.show_zero = 'true';
    if (groupBy !== 'none') next.group_by = groupBy;
    if (sort !== 'outstanding') next.sort = sort;
    if (dir !== 'desc')  next.dir = dir;
    if (search)          next.search = search;
    setSearchParams(next, { replace: true });
  }, [asOf, partyIds, buckets, cities, credit, minAmount, maxAmount, showZero, groupBy, sort, dir, search, setSearchParams]);

  // ── Server filters object — passed to the virtualization hook ────
  const filters = useMemo(() => ({
    as_of: asOf,
    party_ids: partyIds.length ? partyIds.join(',') : undefined,
    buckets:   buckets.length   ? buckets.join(',')   : undefined,
    cities:    cities.length    ? cities.join(',')    : undefined,
    credit:    credit !== 'all' ? credit : undefined,
    min_amount: minAmount || undefined,
    max_amount: maxAmount || undefined,
    show_zero: showZero ? 'true' : undefined,
    group_by:  groupBy !== 'none' ? groupBy : undefined,
    sort, dir,
    search:    search || undefined,
  }), [asOf, partyIds, buckets, cities, credit, minAmount, maxAmount, showZero, groupBy, sort, dir, search]);

  // ── Virtualized data layer ───────────────────────────────────────
  const { rows, totalCount, summary, meta, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: cfg.fetcher,
    filters,
    chunkSize: 200,
  });
  const reconciliation     = meta?.reconciliation || null;
  const allocationComplete = meta?.allocation_complete ?? true;
  const bucketLabels       = meta?.bucket_labels || { current: 'Not Due', b1: '1–30', b2: '31–60', b3: '61–90', b4: '90+' };
  const filterMeta         = meta?.filter_meta || { distinct_cities: [], distinct_states: [] };
  const bucketBounds       = useMemo(() => inferBoundsFromLabels(bucketLabels), [bucketLabels]);

  // Update URL preset when sort header is clicked.
  const onSort = useCallback((key) => {
    if (sort === key) {
      setDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSort(key); setDir('desc');
    }
  }, [sort]);

  // Per-row drill actions.
  const drillBill         = useCallback((row) => navigate(cfg.billRoute(row.bill_id)), [navigate, cfg]);
  const drillPartyLedger  = useCallback((row) => {
    const qs = new URLSearchParams({
      party_id: String(row.party_id),
      from: dayjs(row.bill_date).format('YYYY-MM-DD'),
      to:   asOf,
    });
    navigate(`/reports/party-ledger?${qs.toString()}`);
  }, [navigate, asOf]);
  const drillRecord       = useCallback((row) => {
    navigate(cfg.receiptRoute, {
      state: {
        preselect: {
          party_id: row.party_id,
          bill_id: row.bill_id,
        },
      },
    });
  }, [navigate, cfg]);
  const copyBillNo        = useCallback((row) => {
    if (!row?.bill_number) return;
    navigator.clipboard?.writeText(row.bill_number);
    message.success(`Copied ${row.bill_number}`);
  }, []);

  // ── Column registry ──────────────────────────────────────────────
  const COL_SPECS = useMemo(() => ({
    bill_no:     { title: 'Bill No', dataIndex: 'bill_number', width: 130, sorter: true,
                   render: (v, row) => (
                     <Tooltip title="Click to view bill">
                       <a className="bo-bill-link" onClick={(e) => { e.stopPropagation(); drillBill(row); }}>
                         {v}
                       </a>
                     </Tooltip>
                   ) },
    bill_date:   { title: 'Bill Date', dataIndex: 'bill_date', width: 110, sorter: true,
                   render: (v) => fmtDate(v) },
    party_name:  { title: cfg.partyLabel, dataIndex: 'party_name', width: 180, sorter: true,
                   render: (v, row) => (
                     <a className="bo-party-link" onClick={(e) => { e.stopPropagation(); drillPartyLedger(row); }}>
                       {v}
                     </a>
                   ) },
    due_date:    { title: 'Due Date', dataIndex: 'effective_due_date', width: 110, sorter: true,
                   render: (v) => fmtDate(v) },
    overdue:     { title: 'Days Overdue', dataIndex: 'overdue_days', width: 120, align: 'right', sorter: true,
                   render: (v) => {
                     const n = Number(v) || 0;
                     if (n === 0) return <span className="bo-due-soon">Not due</span>;
                     return <span className={n > 60 ? 'bo-overdue-bad' : n > 30 ? 'bo-overdue-mid' : 'bo-overdue-mild'}>{n}d</span>;
                   } },
    bill_amount: { title: 'Bill Amount', dataIndex: 'bill_amount', width: 130, align: 'right', sorter: true,
                   render: (v) => <span className="bo-num">{fmtINR(v)}</span> },
    paid_amount: { title: 'Paid', dataIndex: 'paid_amount', width: 120, align: 'right', sorter: true,
                   render: (v) => <span className="bo-num bo-num-muted">{fmtINR(v)}</span> },
    outstanding: { title: 'Outstanding', dataIndex: 'outstanding', width: 140, align: 'right', sorter: true,
                   render: (v) => <span className="bo-num bo-num-strong">{fmtINR(v)}</span> },
    bucket:      { title: 'Bucket', width: 110,
                   render: (_v, row) => {
                     const k = bucketFromOverdue(row.overdue_days, bucketBounds);
                     return <Tag className={`bo-bucket bo-bucket-${k}`}>{bucketLabels[k]}</Tag>;
                   } },
    // Optional columns
    party_gstin:        { title: 'GSTIN', dataIndex: 'party_gstin', width: 150, render: (v) => v ? <span className="bo-mono">{v}</span> : '—' },
    party_city:         { title: 'City',  dataIndex: 'party_city', width: 110, render: (v) => v || '—' },
    party_state:        { title: 'State', dataIndex: 'party_state', width: 130, render: (v) => v || '—' },
    party_mobile:       { title: 'Mobile', dataIndex: 'party_mobile', width: 120, render: (v) => v ? <span className="bo-mono">{v}</span> : '—' },
    party_credit_days:  { title: 'Credit Days', dataIndex: 'party_credit_days', width: 100, align: 'right', render: (v) => Number(v) || '—' },
    party_credit_limit: { title: 'Credit Limit', dataIndex: 'party_credit_limit', width: 130, align: 'right',
                          render: (v, row) => {
                            const n = Number(v) || 0;
                            if (!n) return '—';
                            const over = Number(row.outstanding) > n;
                            return <span className={over ? 'bo-over-limit' : ''}>{fmtINR(n)}</span>;
                          } },
    salesman:           { title: 'Salesperson', dataIndex: 'salesman_name', width: 140, render: (v) => v || '—' },
    notes:              { title: 'Notes', dataIndex: 'remarks', width: 200, ellipsis: true, render: (v) => v || '—' },
    created_by:         { title: 'Created By', dataIndex: 'created_by_name', width: 140, render: (v) => v || '—' },
  }), [bucketBounds, bucketLabels, drillBill, drillPartyLedger, cfg]);

  const COL_ORDER = [
    'bill_no', 'bill_date', 'party_name', 'due_date', 'overdue',
    'bill_amount', 'paid_amount', 'outstanding', 'bucket',
    'party_gstin', 'party_city', 'party_state', 'party_mobile',
    'party_credit_days', 'party_credit_limit',
    'salesman', 'notes', 'created_by',
  ];
  // Per-row action menu — appended as the right-most column.
  const ACTION_COL = useMemo(() => ({
    title: '',
    width: 48,
    fixed: 'right',
    render: (_v, row) => row && !row.__loading ? (
      <Dropdown
        menu={{
          items: [
            { key: 'view',     label: 'View Bill',          onClick: () => drillBill(row) },
            { key: 'ledger',   label: 'View Party Ledger',  onClick: () => drillPartyLedger(row) },
            { key: 'record',   label: cfg.receiptLabel,     onClick: () => drillRecord(row) },
            { type: 'divider' },
            { key: 'copy',     label: 'Copy bill no',       onClick: () => copyBillNo(row) },
            { key: 'remind',   label: 'Send Reminder',      disabled: true, onClick: () => message.info('Coming soon') },
          ],
        }}
        trigger={['click']}
        placement="bottomRight"
      >
        <Button type="text" size="small" icon={<EllipsisOutlined />} onClick={(e) => e.stopPropagation()} />
      </Dropdown>
    ) : null,
  }), [drillBill, drillPartyLedger, drillRecord, copyBillNo, cfg]);

  const tableColumns = useMemo(() => {
    const visibleKeys = COL_ORDER.filter((k) => colsVisible[k]);
    const cols = visibleKeys.map((k) => ({ key: k, ...COL_SPECS[k] }));
    cols.push({ key: 'actions', ...ACTION_COL });
    return cols;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsVisible, COL_SPECS, ACTION_COL]);

  // Column-toggle popover content.
  const colPickerContent = (
    <div className="bo-col-picker">
      {COL_ORDER.map((k) => (
        <div key={k}>
          <Checkbox
            checked={!!colsVisible[k]}
            onChange={(e) => setColsVisible((c) => ({ ...c, [k]: e.target.checked }))}
          >
            {COL_SPECS[k]?.title || k}
          </Checkbox>
        </div>
      ))}
    </div>
  );

  // Summary row content — totals over the FULL filtered set (from
  // server's summary block). Rendered inside the VirtualReportTable's
  // sticky bottom strip.
  const summaryCells = useCallback((col) => {
    if (col.key === 'bill_no')     return <strong>Total ({summary.bill_count || 0})</strong>;
    if (col.key === 'party_name')  return <span className="bo-num-muted">{summary.party_count || 0} parties</span>;
    if (col.key === 'bill_amount') return null;   // bill amount sum isn't meaningful when bills are partially paid
    if (col.key === 'paid_amount') return null;
    if (col.key === 'outstanding') return <span className="bo-num bo-num-strong">{fmtINR(summary.total_outstanding)}</span>;
    return null;
  }, [summary]);

  // KPI tile click → apply filter.
  const kpiClickOverdue   = useCallback(() => setBuckets(['b1', 'b2', 'b3', 'b4']), []);
  const kpiClickAll       = useCallback(() => { setBuckets([]); setPartyIds([]); setCities([]); setCredit('all'); setMinAmount(''); setMaxAmount(''); }, []);

  const handleExportExcel = useCallback(async () => {
    try {
      const res = await cfg.exporter(filters);
      const url = window.URL.createObjectURL(new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${cfg.csvBaseName}_${asOf}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      message.error('Export failed');
    }
  }, [cfg, filters, asOf]);

  const handleWhatsApp = useCallback(() => {
    const lines = [
      `*${cfg.title}* — as on ${dayjs(asOf).format('DD-MMM-YY')}`,
      `Total Outstanding: ${fmtINR(summary.total_outstanding)}`,
      `Bills: ${summary.bill_count || 0} · Parties: ${summary.party_count || 0}`,
      `Overdue: ${fmtINR(summary.overdue_amount)} · Avg ${summary.avg_days_overdue || 0} days`,
    ].join('\n');
    window.open(`https://wa.me/?text=${encodeURIComponent(lines)}`, '_blank', 'noopener,noreferrer');
  }, [cfg, asOf, summary]);

  // Reconciliation-banner content (tooltip body).
  const reconTooltip = reconciliation ? (
    <div className="bo-recon-tt">
      <div><b>{reconciliation.sub_group}</b> reconciliation as of {asOf}</div>
      <div>bill outstanding: {fmtINR(reconciliation.bill_outstanding)}</div>
      <div>+ paid_in_bills: {fmtINR(reconciliation.paid_in_bills)}</div>
      <div>− unallocated_receipts: {fmtINR(reconciliation.unallocated_receipts)}</div>
      <div>− returns_offset: {fmtINR(reconciliation.returns_offset)}</div>
      <div>+ opening_dr − opening_cr: {fmtINR(reconciliation.opening_dr - reconciliation.opening_cr)}</div>
      <div>= expected: {fmtINR(reconciliation.expected_ledger_outstanding)}</div>
      <div>vs ledger: {fmtINR(reconciliation.ledger_outstanding)}</div>
      <div><b>diff: {fmtINR(reconciliation.difference)}</b></div>
    </div>
  ) : null;

  return (
    <div className="bo-page">
      {/* ── Title bar ─────────────────────────────────────────────── */}
      <div className="bo-hd">
        <div className="bo-title">
          <h1>{cfg.title}</h1>
          <span className="bo-as-of">as on {dayjs(asOf).format('D MMM YYYY')}</span>
        </div>
        <div className="bo-actions">
          <Select
            size="small" value={groupBy} onChange={setGroupBy}
            style={{ width: 160 }}
            prefix={<GroupOutlined />}
            options={[
              { value: 'none',   label: 'No grouping' },
              { value: 'party',  label: `Group by ${cfg.partyLabel}` },
              { value: 'bucket', label: 'Group by Bucket' },
              { value: 'city',   label: 'Group by City' },
            ]}
          />
          <Popover content={colPickerContent} title="Columns" trigger="click" placement="bottomRight">
            <Button size="small" icon={<SettingOutlined />}>Columns</Button>
          </Popover>
          <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>Refresh</Button>
          <Button size="small" icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>
          <Button size="small" icon={<WhatsAppOutlined />} onClick={handleWhatsApp}>WhatsApp</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleExportExcel} type="primary">Excel</Button>
        </div>
      </div>

      {/* ── Banners ─────────────────────────────────────────────────
        Allocation-incomplete (orange) — informational, dismissible
        per session. Not silenced permanently because the limitation
        is real until FIFO Receipt→Bill is fully wired.
      */}
      {!allocationComplete && !allocBannerDismissed && (
        <div className="bo-banner bo-banner-warn">
          <WarningOutlined />
          <span>
            Bill-level allocation incomplete — outstanding shown is
            <code> sales_bills.balance_amount</code> as a proxy. Some receipts
            may not be FIFO-allocated to specific bills.
          </span>
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => setAllocBannerDismissed(true)} />
        </div>
      )}

      {/* Reconciliation drift (amber) */}
      {reconciliation && !reconciliation.balanced && !reconBannerDismissed && (
        <Tooltip title={reconTooltip} placement="bottom">
          <div className="bo-banner bo-banner-warn">
            <WarningOutlined />
            <span>
              Drift vs <b>{reconciliation.sub_group}</b> ledger: <b>{fmtINR(Math.abs(reconciliation.difference))}</b>
              {' '}— see breakdown on hover. Run <a onClick={() => navigate('/accounts/integrity')}>Books Reconciliation</a>.
            </span>
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={(e) => { e.stopPropagation(); setReconBannerDismissed(true); }} />
          </div>
        </Tooltip>
      )}
      {reconciliation && reconciliation.balanced && (
        <Tooltip title={reconTooltip} placement="bottom">
          <div className="bo-banner bo-banner-ok">
            <CheckCircleOutlined />
            <span>Reconciled with <b>{reconciliation.sub_group}</b> ledger (paisa-exact).</span>
          </div>
        </Tooltip>
      )}

      {/* ── KPI tiles ───────────────────────────────────────────────
        Click a tile to apply the matching filter. Tiles read from the
        server-computed `summary` (over the FULL filtered set, not just
        the visible page).
      */}
      <div className="bo-kpis">
        <div className="bo-kpi" onClick={kpiClickAll} title="Click to clear filters">
          <div className="bo-kpi-label">Total Outstanding</div>
          <div className="bo-kpi-value bo-kpi-strong">{fmtINR(summary.total_outstanding)}</div>
        </div>
        <div className="bo-kpi">
          <div className="bo-kpi-label">Bills</div>
          <div className="bo-kpi-value">{summary.bill_count || 0}</div>
        </div>
        <div className="bo-kpi">
          <div className="bo-kpi-label">Parties</div>
          <div className="bo-kpi-value">{summary.party_count || 0}</div>
        </div>
        <div className={'bo-kpi bo-kpi-clickable' + (buckets.length > 0 && buckets.every((b) => b !== 'current') ? ' bo-kpi-active' : '')} onClick={kpiClickOverdue} title="Show only overdue buckets">
          <div className="bo-kpi-label">Overdue Amount</div>
          <div className="bo-kpi-value bo-kpi-warn">{fmtINR(summary.overdue_amount)}</div>
        </div>
        <div className="bo-kpi">
          <div className="bo-kpi-label">Avg Days Overdue</div>
          <div className="bo-kpi-value">{summary.avg_days_overdue || 0}</div>
        </div>
        <div className="bo-kpi">
          <div className="bo-kpi-label">Oldest (days)</div>
          <div className="bo-kpi-value">{summary.oldest_days || 0}</div>
        </div>
      </div>

      {/* ── Filter bar ───────────────────────────────────────────── */}
      <div className="bo-filterbar">
        <Space size={8} wrap>
          <DatePicker
            size="small"
            value={asOf ? dayjs(asOf) : null}
            onChange={(d) => setAsOf(d ? d.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'))}
            allowClear={false}
            format="DD MMM YYYY"
            style={{ width: 150 }}
          />
          <Select
            size="small"
            mode="multiple"
            placeholder={`Filter by ${cfg.partyLabel}`}
            value={partyIds}
            onChange={setPartyIds}
            options={partyOptions}
            optionFilterProp="label"
            allowClear
            maxTagCount="responsive"
            style={{ minWidth: 220, maxWidth: 360 }}
          />
          {/* Bucket chips — multi-select */}
          <div className="bo-chips">
            {['current', 'b1', 'b2', 'b3', 'b4'].map((k) => (
              <button
                key={k}
                className={'bo-chip' + (buckets.includes(k) ? ' bo-chip-on' : '')}
                onClick={() => setBuckets((bs) => bs.includes(k) ? bs.filter((x) => x !== k) : [...bs, k])}
              >
                {bucketLabels[k]}
              </button>
            ))}
          </div>
          <Input
            size="small"
            allowClear
            placeholder="Min ₹"
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            style={{ width: 100 }}
          />
          <Input
            size="small"
            allowClear
            placeholder="Max ₹"
            value={maxAmount}
            onChange={(e) => setMaxAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            style={{ width: 100 }}
          />
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Search bill no, party, notes…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ width: 240 }}
          />
          <Button
            size="small"
            type={advancedOpen ? 'primary' : 'default'}
            icon={<FilterOutlined />}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            Advanced
          </Button>
        </Space>
        {advancedOpen && (
          <div className="bo-filterbar-adv">
            <Space size={8} wrap>
              <Select
                size="small" mode="multiple" placeholder="City"
                value={cities} onChange={setCities}
                options={filterMeta.distinct_cities.map((c) => ({ value: c, label: c }))}
                allowClear style={{ minWidth: 160, maxWidth: 240 }}
              />
              <Select
                size="small" value={credit} onChange={setCredit}
                style={{ width: 160 }}
                options={[
                  { value: 'all',    label: 'Any credit limit' },
                  { value: 'over',   label: 'Over Limit' },
                  { value: 'within', label: 'Within Limit' },
                  { value: 'none',   label: 'No Limit set' },
                ]}
              />
              <Checkbox checked={showZero} onChange={(e) => setShowZero(e.target.checked)}>
                Show zero-balance
              </Checkbox>
            </Space>
          </div>
        )}
      </div>

      {/* ── Virtualized table ──────────────────────────────────────── */}
      <div className="bo-tablewrap">
        {totalCount === 0 && !loading ? (
          <div className="bo-empty">
            {(partyIds.length || buckets.length || cities.length || minAmount || maxAmount || search)
              ? (
                <>
                  <div>No bills match these filters.</div>
                  <Button size="small" onClick={kpiClickAll} style={{ marginTop: 8 }}>Clear Filters</Button>
                </>
              )
              : <div>All bills are paid. ✓</div>}
          </div>
        ) : (
          <VirtualReportTable
            columns={tableColumns}
            rows={rows}
            totalCount={totalCount}
            ensureChunk={ensureChunk}
            loading={loading}
            rowKey={(r) => r.bill_id}
            scroll={{ x: tableColumns.reduce((s, c) => s + (c.width || 100), 0) }}
            summaryCells={summaryCells}
            onHeaderRow={(col) => ({
              onClick: () => col.sorter && onSort(col.key === 'overdue' ? 'overdue' : col.dataIndex || col.key),
              style:   col.sorter ? { cursor: 'pointer' } : undefined,
            })}
          />
        )}
      </div>
    </div>
  );
}
