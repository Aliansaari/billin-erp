import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Tag, Typography, message, DatePicker, Select,
  Modal, Descriptions, Divider, Dropdown, Table,
} from 'antd';
import {
  PlusOutlined, SearchOutlined,
  SettingOutlined, FileTextOutlined, LinkOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { purchaseReturnAPI, settingsAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument, exportBillPDF, shareBillViaWhatsApp } from '../../services/printer';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../../styles/bill-list.css';
import './return-list.css';

/* ════════════════════════════════════════════════════════════════════════════
 *  PurchaseReturnList — virtualized list with editorial visual treatment
 *  preserved via column renders. Mirrors SalesReturnList on the supplier side.
 *    · bill_number     → return_number (PR-xxxx)
 *    · payment_status  → refund_status (Refunded / Partial / Pending)
 *    · paid_amount     → refund_amount (cash supplier paid back to us)
 *    · balance_amount  → debit still owed TO US by the supplier
 *    · total_amount    → debit-note value (supplier owes us this)
 * ═══════════════════════════════════════════════════════════════════════════ */

const OPTIONAL_COLS = [
  { key: 'time',     label: 'Time' },
  { key: 'godown',   label: 'Godown' },
  { key: 'phone',    label: 'Phone' },
  { key: 'gstin',    label: 'GSTIN' },
  { key: 'ref',      label: 'Reference bill' },
  { key: 'mode',     label: 'Return mode' },
  { key: 'reason',   label: 'Reason' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
];
const SECTIONS = [
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
// v5 promotes the godown badge to its own toggleable column. Existing
// v4 users inherit `godown: true` via DEFAULT_COLS spread on first read.
const COLS_STORAGE_KEY = 'purchaseReturnList_cols_v5';
const DEFAULT_COLS = {
  time: true, godown: true, phone: true, gstin: false, ref: true, mode: true,
  reason: false, gst: false, discount: false,
  totalRow: true,
};

const { Text } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtShort = (v) => {
  const n = parseFloat(v || 0);
  if (n === 0) return '₹ 0';
  return `₹ ${Math.round(n).toLocaleString('en-IN')}`;
};

function SummaryRow({ label, value, color, bold, borderTop }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '5px 0', borderTop: borderTop ? '1px solid var(--border)' : undefined,
      fontWeight: bold ? 700 : 400, fontSize: bold ? 14 : 13, color: color || undefined,
    }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

function ViewModal({ bill, onClose }) {
  if (!bill) return null;
  const items = bill.items || [];
  const cgst = parseFloat(bill.cgst_amount || 0);
  const sgst = parseFloat(bill.sgst_amount || 0);
  const igst = parseFloat(bill.igst_amount || 0);
  const discount = parseFloat(bill.discount_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);
  const roundOff = parseFloat(bill.round_off || 0);

  const itemColumns = [
    { title: '#', width: 40, render: (_, __, i) => i + 1 },
    { title: 'Product', dataIndex: 'product_name' },
    { title: 'Barcode', dataIndex: 'barcode', width: 110, render: v => <Text style={{ fontSize: 11 }}>{v}</Text> },
    { title: 'Size', dataIndex: 'size', width: 70 },
    { title: 'Qty', dataIndex: 'quantity', width: 65, align: 'right' },
    { title: 'Rate', dataIndex: 'rate', width: 90, align: 'right', render: v => `₹${parseFloat(v || 0).toFixed(2)}` },
    { title: 'Amount', dataIndex: 'total_amount', width: 100, align: 'right', render: v => `₹${parseFloat(v || 0).toFixed(2)}` },
  ];

  return (
    <Modal open onCancel={onClose} width={960} footer={null}
      title={<span style={{ fontWeight: 700 }}>Purchase Return — {bill.return_number}</span>}
      styles={{ body: { padding: '16px 24px' } }}>

      <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Return No">{bill.return_number}</Descriptions.Item>
        <Descriptions.Item label="Date">{dayjs(bill.return_date).format('DD-MMM-YYYY')}</Descriptions.Item>
        <Descriptions.Item label="Supplier">{bill.supplier?.party_name || '—'}</Descriptions.Item>
        <Descriptions.Item label="Mode">
          <Tag color={bill.return_mode === 'Amount' ? 'purple' : 'blue'}>{bill.return_mode}</Tag>
        </Descriptions.Item>
        {bill.reference_bill_number && (
          <Descriptions.Item label="Against bill" span={2}>
            <span style={{ fontWeight: 600 }}>{bill.reference_bill_number}</span>
          </Descriptions.Item>
        )}
        {bill.reason && <Descriptions.Item label="Reason" span={2}>{bill.reason}</Descriptions.Item>}
        <Descriptions.Item label="Status">
          <Tag color={bill.refund_status === 'Refunded' ? 'green' : bill.refund_status === 'Partial' ? 'orange' : 'red'}>
            {bill.refund_status}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Refund mode">{bill.refund_method}</Descriptions.Item>
        {bill.remarks && <Descriptions.Item label="Remarks" span={2}>{bill.remarks}</Descriptions.Item>}
      </Descriptions>

      {bill.return_mode !== 'Amount' && (
        <Table columns={itemColumns} dataSource={items} rowKey="item_id"
          pagination={false} size="small" scroll={{ x: 600 }} />
      )}

      <Divider style={{ margin: '12px 0' }} />

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ width: 300 }}>
          <SummaryRow label="Sub Total" value={fmt(bill.sub_total)} />
          {discount > 0 && (
            <SummaryRow label={`Discount${bill.discount_percentage > 0 ? ` (${bill.discount_percentage}%)` : ''}`}
              value={`- ${fmt(discount)}`} color="#d97706" />
          )}
          {igst > 0 && (<SummaryRow label={`IGST${bill.igst_pct > 0 ? ` (${bill.igst_pct}%)` : ''}`} value={fmt(igst)} />)}
          {cgst > 0 && (<SummaryRow label={`CGST${bill.cgst_pct > 0 ? ` (${bill.cgst_pct}%)` : ''}`} value={fmt(cgst)} />)}
          {sgst > 0 && (<SummaryRow label={`SGST${bill.sgst_pct > 0 ? ` (${bill.sgst_pct}%)` : ''}`} value={fmt(sgst)} />)}
          {roundOff !== 0 && (<SummaryRow label="Round Off" value={roundOff.toFixed(2)} />)}
          <SummaryRow label="Debit Total" value={fmt(bill.total_amount)} bold borderTop />
          <SummaryRow label="Refunded" value={fmt(bill.refund_amount)} color="var(--success)" />
          <SummaryRow label="Debit pending" value={fmt(balance)}
            color={balance > 0 ? 'var(--danger)' : 'var(--success)'} bold borderTop />
        </div>
      </div>
    </Modal>
  );
}

function Ring({ pct, tone = 'ok' }) {
  const C = 138.23;
  const p = Math.max(0, Math.min(100, pct));
  const offset = C * (1 - p / 100);
  return (
    <div className="kpi-ring" aria-label={`${Math.round(p)}%`}>
      <svg viewBox="0 0 56 56">
        <circle className="track" cx="28" cy="28" r="22" fill="none" strokeWidth="3.5"/>
        <circle className={tone === 'bad' ? 'fill-bad' : 'fill-ok'}
          cx="28" cy="28" r="22" fill="none" strokeWidth="3.5"
          strokeDasharray={C} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 28 28)"/>
      </svg>
      <span className="label">{Math.round(p)}%</span>
    </div>
  );
}

export default function PurchaseReturnList() {
  const { fyStart, fyEnd } = useFinancialYear();
  const [searchInput, setSearchInput] = useState('');
  const today = dayjs().format('YYYY-MM-DD');
  const [filters, setFilters] = useState({ search: '', refund_status: null, from_date: today, to_date: today });
  const prevDatesRef = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(f => {
        if (f.search === searchInput) return f;
        if (searchInput && !f.search) {
          prevDatesRef.current = { from_date: f.from_date, to_date: f.to_date };
          return { ...f, search: searchInput, from_date: fyStart, to_date: fyEnd };
        }
        if (!searchInput && f.search) {
          const prev = prevDatesRef.current || { from_date: today, to_date: today };
          prevDatesRef.current = null;
          return { ...f, search: '', ...prev };
        }
        return { ...f, search: searchInput };
      });
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput, fyStart, fyEnd, today]);

  const [viewBill, setViewBill]       = useState(null);
  const [companyName, setCompanyName] = useState('');

  // Search input ref so the F4 = Find action can focus it from the strip.
  const searchInputRef = useRef(null);

  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => purchaseReturnAPI.getAll(params),
    filters,
    chunkSize: 200,
  });

  const [cols, setCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(cols)); } catch {}
  }, [cols]);
  const visibleOptionalCount = OPTIONAL_COLS.filter((c) => cols[c.key]).length;

  const navigate = useNavigate();

  useEffect(() => {
    settingsAPI.getSystem().then(({ data }) => setCompanyName(data?.data?.company_name || '')).catch(() => {});
  }, []);

  const fetchBill = useCallback(async (id) => {
    try {
      const { data } = await purchaseReturnAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load return');
      return null;
    }
  }, []);

  const handleView      = async (id) => { const b = await fetchBill(id); if (b) setViewBill(b); };
  const handlePrint     = (id) => printDocument({ docType: 'purchase_return', id });
  const handleEdit      = (id) => navigate(`/purchase-return/edit/${id}`);
  const handleExportPDF = (bill) => exportBillPDF({ docType: 'purchase_return', bill });
  const handleWhatsApp  = (bill) => shareBillViaWhatsApp({ docType: 'purchase_return', bill });

  // Selection model — cursor + multi-select.
  const sel = useListSelection({ totalCount, rows });
  const activeRow      = sel.activeRow;
  const selectedRows   = sel.selectedRows;
  const selectionCount = sel.selectionCount;
  const isMulti        = selectionCount > 1;
  const single         = !isMulti ? activeRow : null;
  const singleCancelled = single?.is_cancelled;
  // Phone derived from supplier mobile_1.
  const singlePhone = (() => {
    if (!single) return null;
    const m = single.supplier?.mobile_1;
    return m && !/^TLY/i.test(m) ? m : null;
  })();

  // Bulk-cancel — confirm once, run cancellations serially, summarize at end.
  const handleBulkCancel = useCallback((rowsToCancel) => {
    const cancellable = rowsToCancel.filter(r => r && !r.is_cancelled);
    if (cancellable.length === 0) {
      message.info('Nothing to cancel — selection is already cancelled.');
      return;
    }
    Modal.confirm({
      title: cancellable.length === 1
        ? `Cancel return ${cancellable[0].return_number}?`
        : `Cancel ${cancellable.length} returns?`,
      content: 'Cancelling reverses supplier debit, removes the stock-ledger Purchase Return rows, and pulls the returned stock back into inventory.',
      okText: cancellable.length === 1 ? 'Cancel this return' : `Cancel ${cancellable.length} returns`,
      okButtonProps: { danger: true },
      cancelText: 'Keep them',
      onOk: async () => {
        let ok = 0, fail = 0;
        const failures = [];
        for (const r of cancellable) {
          try {
            await purchaseReturnAPI.cancel(r.purchase_return_id);
            ok++;
          } catch (e) {
            fail++;
            failures.push(`${r.return_number}: ${e.response?.data?.error || 'failed'}`);
          }
        }
        refresh();
        if (fail === 0) message.success(`Cancelled ${ok} return${ok === 1 ? '' : 's'}.`);
        else {
          message.warning(`${ok} cancelled, ${fail} failed.`);
          if (failures.length <= 3) failures.forEach(f => message.error(f));
        }
      },
    });
  }, [refresh]);

  const totalAmount = parseFloat(summary?.total_amount || 0);
  const refunded    = parseFloat(summary?.total_refund || 0);
  const pending     = parseFloat(summary?.total_pending || 0);
  const openDebits  = summary?.open_count || 0;
  const returnCount = summary?.count || totalCount;
  const avg         = returnCount > 0 ? totalAmount / returnCount : 0;
  const refundedPct = totalAmount > 0 ? (refunded / totalAmount) * 100 : 0;
  const pendingPct  = totalAmount > 0 ? (pending  / totalAmount) * 100 : 0;

  const columns = [
    {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => <span className="sr-n">{String(idx + 1).padStart(2, '0')}</span>,
    },
    {
      // Return # cell is now pure — godown moved to its own toggleable column.
      key: 'bill', title: 'Return #', dataIndex: 'return_number', width: 130,
      render: (v) => <span className="bill-no">{v}</span>,
    },
    cols.godown && {
      key: 'godown', title: 'Godown', width: 110,
      render: (_, r) => r.godown
        ? (
          <span title={`Godown: ${r.godown.name}`} style={{
            display: 'inline-block', padding: '1px 6px',
            fontSize: 11, fontWeight: 600,
            border: '1px solid var(--border, #e5e7eb)', borderRadius: 4,
            color: 'var(--fg-secondary, #6b7280)', background: 'var(--bg-subtle, #f9fafb)',
            fontFamily: 'var(--font-mono, monospace)',
          }}>{r.godown.code}</span>
        )
        : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>,
    },
    {
      key: 'date', title: 'Date', dataIndex: 'return_date', width: 120,
      render: (v) => v ? dayjs(v).format('DD MMM YYYY') : '—',
    },
    cols.time && {
      key: 'time', title: 'Time', width: 90,
      render: (_v, r) => {
        const timeSource = r.createdAt || r.created_date || null;
        const t = timeSource ? dayjs(timeSource) : null;
        return t
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{t.format('h:mm a')}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    {
      // Single-line Supplier name. Mobile moved to its own optional
      // `phone` column below — toggleable via Customize.
      key: 'sup', title: 'Supplier', dataIndex: ['supplier', 'party_name'], width: 200,
      render: (v) => <span className="bill-sup">{v || '—'}</span>,
    },
    cols.phone && {
      key: 'phone', title: 'Phone', width: 130,
      render: (_, r) => {
        const m = r.supplier?.mobile_1;
        return m
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>{m}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    cols.gstin && {
      key: 'gstin', title: 'GSTIN', width: 160,
      render: (_, r) => {
        const g = r.supplier?.gstin;
        return g
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }}>{g}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    cols.ref && {
      key: 'ref', title: 'Ref bill', dataIndex: 'reference_bill_number', width: 160,
      render: (v) => v
        ? <div className="stk">
            <span className="m ref-num"><LinkOutlined /> {v}</span>
            <span className="s">Linked invoice</span>
          </div>
        : <span className="amt zero" style={{ fontStyle: 'italic' }}>Standalone</span>,
    },
    cols.mode && {
      key: 'mode', title: 'Mode', dataIndex: 'return_mode', width: 110,
      render: (v) => (
        <span className={`mode-pill mode-${(v || 'items').toLowerCase()}`}>
          {v === 'Amount' ? <FileTextOutlined /> : null}
          {v}
        </span>
      ),
    },
    cols.reason && {
      key: 'reason', title: 'Reason', dataIndex: 'reason', width: 200,
      render: (v) => <span className="reason-text" title={v || ''}>{v || '—'}</span>,
    },
    {
      key: 'total', title: 'Total', dataIndex: 'total_amount', width: 120, align: 'right',
      render: (v, r) => (
        <span className={`amt${r.is_cancelled ? ' muted' : ''}`}>
          <span className="rs">₹</span>{Math.round(parseFloat(v || 0)).toLocaleString('en-IN')}
        </span>
      ),
    },
    cols.gst && {
      key: 'gst', title: 'GST', width: 100, align: 'right',
      render: (_, r) => {
        const amt = parseFloat(r.cgst_amount || 0) + parseFloat(r.sgst_amount || 0) + parseFloat(r.igst_amount || 0);
        return amt > 0.01
          ? <span className="amt"><span className="rs">₹</span>{Math.round(amt).toLocaleString('en-IN')}</span>
          : <span className="amt zero">—</span>;
      },
    },
    cols.discount && {
      key: 'discount', title: 'Discount', dataIndex: 'discount_amount', width: 110, align: 'right',
      render: (v) => parseFloat(v || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(v)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>,
    },
    {
      key: 'refunded', title: 'Refunded', dataIndex: 'refund_amount', width: 110, align: 'right',
      render: (v) => parseFloat(v || 0) > 0.01
        ? <span className="amt paid"><span className="rs">₹</span>{Math.round(parseFloat(v)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>,
    },
    {
      key: 'pending', title: 'Pending', dataIndex: 'balance_amount', width: 130, align: 'right',
      render: (v, r) => {
        const balance = parseFloat(v || 0);
        if (r.is_cancelled) return <span className="voided-tag">Voided</span>;
        if (balance < 0.01) return <span className="settled-tag">Settled</span>;
        return <span className="amt due"><span className="rs">₹</span>{Math.round(balance).toLocaleString('en-IN')}</span>;
      },
    },
    // (Per-row actions column removed — all return actions live in the
    // bottom ActionStrip and operate on the cursored / selected rows.)
  ].filter(Boolean);

  // Bottom Total strip — driven by server-aggregated summary.
  const SUMMABLE_KEYS = new Set(['total', 'refunded', 'pending', 'gst', 'discount']);
  const firstAggIdx = (() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  })();
  const totalForKey = (k) => {
    switch (k) {
      case 'total':    return <strong><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_amount  || 0)).toLocaleString('en-IN')}</strong>;
      case 'refunded': return <span className="amt paid"><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_refund || 0)).toLocaleString('en-IN')}</span>;
      case 'pending':  return <span className="amt due"><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_pending || 0)).toLocaleString('en-IN')}</span>;
      case 'gst':      return parseFloat(summary?.total_gst      || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(summary.total_gst)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>;
      case 'discount': return parseFloat(summary?.total_discount || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(summary.total_discount)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>;
      default:         return null;
    }
  };
  const summaryCells = (col, idx) => {
    if (idx === 0) return totalCount > 0 ? `Total (${totalCount} return${totalCount === 1 ? '' : 's'})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;
    return totalForKey(col.key);
  };
  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  return (
    <div className="blist-page rlist-page">

      <div className="blist-hd">
        <div className="blist-title">
          <h1>Purchase Returns</h1>
        </div>
        <div className="blist-ctrl">
          <div className="blist-search">
            <SearchOutlined />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search return no or ref bill"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <DatePicker.RangePicker
            size="middle" format="DD MMM"
            placeholder={['From', 'To']}
            value={[filters.from_date ? dayjs(filters.from_date) : null, filters.to_date ? dayjs(filters.to_date) : null]}
            onChange={(v) => setFilters(f => ({
              ...f,
              from_date: v?.[0]?.format('YYYY-MM-DD') || null,
              to_date:   v?.[1]?.format('YYYY-MM-DD') || null,
            }))}
            style={{ height: 34, width: 220 }}
          />
          <Select
            placeholder="All statuses" allowClear
            style={{ width: 130, height: 34 }}
            onChange={(v) => setFilters(f => ({ ...f, refund_status: v }))}
            options={[
              { value: 'Refunded', label: 'Refunded' },
              { value: 'Partial',  label: 'Partial'  },
              { value: 'Pending',  label: 'Pending'  },
            ]}
          />
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            dropdownRender={() => (
              <div className="cols-menu" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.12)' }}>
                <div className="mh">Optional columns</div>
                {OPTIONAL_COLS.map(c => (
                  <label key={c.key} className="opt">
                    <input
                      type="checkbox"
                      checked={!!cols[c.key]}
                      onChange={(e) => setCols(prev => ({ ...prev, [c.key]: e.target.checked }))}
                    />
                    {c.label}
                  </label>
                ))}
                <div className="sep" />
                <div className="mh">Sections</div>
                {SECTIONS.map(s => (
                  <label key={s.key} className="opt">
                    <input
                      type="checkbox"
                      checked={!!cols[s.key]}
                      onChange={(e) => setCols(prev => ({ ...prev, [s.key]: e.target.checked }))}
                    />
                    {s.label}
                  </label>
                ))}
                <div className="sep" />
                <div className="mh" style={{ paddingBottom: 2 }}>Always shown</div>
                <label className="opt"><span>Return # · Date · Supplier</span><span className="pin">Pinned</span></label>
                <label className="opt"><span>Total · Refunded · Pending</span><span className="pin">Pinned</span></label>
              </div>
            )}
          >
            <button className={`blist-chip${visibleOptionalCount > 0 ? ' on' : ''}`}>
              <SettingOutlined /> Customize
              {visibleOptionalCount > 0 && <span className="col-count">{visibleOptionalCount}</span>}
            </button>
          </Dropdown>
          <span className="blist-divider"></span>
          <button className="blist-cta" onClick={() => navigate('/purchase-return/new')}>
            <PlusOutlined /> New Return
          </button>
        </div>
      </div>

      <div className="blist-kpi">
        <div className="kpi-card total">
          <div className="kpi-text">
            <div className="k">Total Debits · This View</div>
            <div className="v">{fmt(totalAmount)}</div>
            <div className="sub">{returnCount} returns · avg {fmtShort(avg)}</div>
          </div>
        </div>
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Refunded</div>
            <div className="v">{fmt(refunded)}</div>
            <div className="sub">of {fmtShort(totalAmount)} debited</div>
          </div>
          <Ring pct={refundedPct} tone="ok" />
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Debit Pending</div>
            <div className="v">{fmt(pending)}</div>
            <div className="sub">from {openDebits} open debit note{openDebits === 1 ? '' : 's'}</div>
          </div>
          <Ring pct={pendingPct} tone="bad" />
        </div>
      </div>

      <div className="blist-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="purchase_return_id"
          scroll={{ x: 1200 }}
          rowClassName={(r) => r && r.is_cancelled ? 'blist-row-cancelled' : ''}
          summaryCells={cols.totalRow ? summaryCells : undefined}
          summaryColSpan={cols.totalRow ? summaryColSpan : undefined}
          controlledCursorIdx={sel.cursorIdx}
          controlledSelectedSet={sel.selectedSet}
          onCursorMove={sel.setCursor}
          onShiftClickRow={sel.extendTo}
          onCtrlClickRow={sel.toggleRow}
          onRow={(record) => ({
            onDoubleClick: () => record?.purchase_return_id && handleView(record.purchase_return_id),
          })}
        />
      </div>

      {/* ── Bottom action strip — same as SalesReturnList. */}
      <ActionStrip
        info={isMulti ? `${selectionCount} selected` : null}
        actions={[
          // Visual order: utility on the left, destructive F8 + primary
          // F1 on the right (matches forms + SalesList convention).
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: isMulti || !single || singleCancelled,
            onAction: () => single && handleEdit(single.purchase_return_id),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: () => navigate('/purchase-return/new'),
          },
          {
            id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus(),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => refresh(),
          },
          {
            id: 'print', key: 'F9', label: 'Print',
            disabled: isMulti || !single,
            onAction: () => single && handlePrint(single.purchase_return_id),
          },
          {
            id: 'export', key: 'F10', label: 'Export PDF',
            disabled: isMulti || !single,
            onAction: () => single && handleExportPDF(single),
          },
          {
            id: 'whatsapp', key: 'F11', label: 'WhatsApp',
            disabled: isMulti || !single || singleCancelled || !singlePhone,
            onAction: () => single && handleWhatsApp(single),
            title: 'Share this debit note PDF with the supplier',
          },
          {
            id: 'cancel', key: 'F8', label: 'Cancel', tone: 'danger',
            disabled: !activeRow,
            onAction: () => handleBulkCancel(isMulti ? selectedRows : [single]),
          },
          {
            id: 'open', key: 'F1', label: 'Open', tone: 'primary',
            disabled: isMulti || !single,
            onAction: () => single && handleView(single.purchase_return_id),
          },
        ]}
      />

      <ViewModal bill={viewBill} onClose={() => setViewBill(null)} />
    </div>
  );
}
