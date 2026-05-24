import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  message, DatePicker, Select,
  Modal, Dropdown, Table,
} from 'antd';
import {
  PlusOutlined, SearchOutlined,
  SettingOutlined, FileTextOutlined, LinkOutlined,
  PrinterOutlined, FilePdfOutlined, WhatsAppOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesReturnAPI, settingsAPI } from '../../api';
import { printDocument, exportBillPDF, shareBillViaWhatsApp } from '../../services/printer';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../../styles/bill-list.css';
import '../sales/sales-view-modal.css';
import './return-list.css';

/* ════════════════════════════════════════════════════════════════════════════
 *  SalesReturnList — virtualized list with editorial visual treatment
 *  preserved via column renders. Mirrors SalesList's structure with return
 *  semantics:
 *    · bill_number     → return_number (SR-xxxx)
 *    · payment_status  → refund_status (Refunded / Partial / Pending)
 *    · paid_amount     → refund_amount (cash paid back to customer)
 *    · balance_amount  → credit still owed to the customer
 *    · total_amount    → credit note value (we owe this to the customer)
 * ═══════════════════════════════════════════════════════════════════════════ */

const OPTIONAL_COLS = [
  { key: 'time',     label: 'Time' },
  { key: 'godown',   label: 'Godown' },
  { key: 'mobile',   label: 'Mobile' },
  { key: 'gstin',    label: 'GSTIN' },
  { key: 'ref',      label: 'Reference bill' },
  { key: 'mode',     label: 'Return mode' },
  { key: 'reason',   label: 'Reason' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
];
// Toggleable page sections (not data columns).
const SECTIONS = [
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
// v5 promotes the godown badge to its own toggleable column. Existing
// v4 users inherit `godown: true` via DEFAULT_COLS spread on first read.
const COLS_STORAGE_KEY = 'salesReturnList_cols_v5';
const DEFAULT_COLS = {
  time: true, godown: true, mobile: true, gstin: false, ref: true, mode: true,
  reason: false, gst: false, discount: false,
  totalRow: true,
};

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtShort = (v) => {
  const n = parseFloat(v || 0);
  if (n === 0) return '₹ 0';
  return `₹ ${Math.round(n).toLocaleString('en-IN')}`;
};

// ── View Modal — editorial layout matching SalesList ───────────────────────────

const statusTone = (s) =>
  s === 'Refunded' ? { fg: '#34D399', bg: 'rgba(52, 211, 153, 0.12)', br: 'rgba(52, 211, 153, 0.28)' }
: s === 'Partial'  ? { fg: '#F59E0B', bg: 'rgba(245, 158, 11, 0.12)', br: 'rgba(245, 158, 11, 0.28)' }
                   : { fg: '#EF4444', bg: 'rgba(239, 68, 68, 0.12)', br: 'rgba(239, 68, 68, 0.28)' };

function MetaRow({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 16, padding: '7px 0', alignItems: 'baseline' }}>
      <span style={{
        flex: '0 0 120px', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--fg-tertiary)', fontWeight: 500,
      }}>{label}</span>
      <span style={{ fontSize: 13.5, color: 'var(--fg-primary)', fontWeight: 500 }}>{children}</span>
    </div>
  );
}

function SummaryRow({ label, value, color, bold, borderTop }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: bold ? '8px 0 6px' : '5px 0',
      borderTop: borderTop ? '1px solid var(--border)' : undefined,
      fontWeight: bold ? 700 : 500, fontSize: bold ? 14 : 13,
      color: color || (bold ? 'var(--fg-primary)' : 'var(--fg-secondary)'),
      fontVariantNumeric: 'tabular-nums',
    }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

function ViewModal({ bill, onClose, onPrint, onExportPDF, onWhatsApp }) {
  if (!bill) return null;
  const items = bill.items || [];
  const cgst = parseFloat(bill.cgst_amount || 0);
  const sgst = parseFloat(bill.sgst_amount || 0);
  const igst = parseFloat(bill.igst_amount || 0);
  const totalGst = cgst + sgst + igst;
  const discount = parseFloat(bill.discount_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);
  const roundOff = parseFloat(bill.round_off || 0);

  const tone = statusTone(bill.refund_status);

  const itemColumns = [
    { title: '#', width: 36, render: (_, __, i) => i + 1 },
    { title: 'Product', dataIndex: 'product_name', ellipsis: true },
    { title: 'Barcode', dataIndex: 'barcode', width: 110,
      render: v => v ? <span style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11.5 }}>{v}</span> : <span style={{ color: 'var(--fg-tertiary)' }}>—</span> },
    { title: 'Size', dataIndex: 'size', width: 70, render: v => v || <span style={{ color: 'var(--fg-tertiary)' }}>—</span> },
    { title: 'Qty', dataIndex: 'quantity', width: 70, align: 'right',
      render: v => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{parseFloat(v || 0).toFixed(2)}</span> },
    { title: 'Rate', dataIndex: 'rate', width: 100, align: 'right',
      render: v => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</span> },
    { title: 'Amount', width: 110, align: 'right',
      render: (_, r) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
        {fmt(parseFloat(r.quantity || 0) * parseFloat(r.rate || 0))}
      </span> },
  ];

  // Hero — when credit pending shows the balance, when settled shows full total
  const heroIsBalance = balance > 0.005;
  const heroLabel = heroIsBalance ? 'Credit Pending' : 'Fully Refunded';
  const heroValue = heroIsBalance ? balance : parseFloat(bill.total_amount || 0);
  const heroColor = heroIsBalance ? '#EF4444' : '#34D399';
  const heroBg    = heroIsBalance ? 'rgba(239, 68, 68, 0.08)' : 'rgba(52, 211, 153, 0.08)';
  const heroBr    = heroIsBalance ? 'rgba(239, 68, 68, 0.22)' : 'rgba(52, 211, 153, 0.22)';

  const titleBlock = (
    <div className="erp-bill-title">
      <div className="erp-bill-title-text">
        <span className="erp-bill-title-eyebrow">Sales Return</span>
        <span className="erp-bill-title-number">#{bill.return_number}</span>
        <span className="erp-bill-title-pill" style={{
          color: tone.fg, background: tone.bg, border: `1px solid ${tone.br}`,
        }}>
          <span className="erp-bill-title-pill-dot" style={{ background: tone.fg }} />
          {bill.refund_status}
        </span>
      </div>
      <span className="erp-bill-title-date">
        {dayjs(bill.return_date).format('DD MMM YYYY')}
      </span>
    </div>
  );

  return (
    <Modal open onCancel={onClose} width={1000} footer={null}
      title={titleBlock}
      className="erp-bill-view"
      styles={{ body: { padding: 0 } }}>

      <div className="erp-bill-shell">

        <div className="erp-bill-meta">
          <MetaRow label="Customer">{bill.customer?.party_name || 'Cash'}</MetaRow>
          {bill.reference_bill_number && <MetaRow label="Against Bill">{bill.reference_bill_number}</MetaRow>}
          {bill.return_mode && <MetaRow label="Return Mode">{bill.return_mode}</MetaRow>}
          {bill.refund_method && <MetaRow label="Refund Method">{bill.refund_method}</MetaRow>}
          {bill.reason && <MetaRow label="Reason">{bill.reason}</MetaRow>}
          {bill.remarks && <MetaRow label="Remarks">{bill.remarks}</MetaRow>}
        </div>

        {bill.return_mode !== 'Amount' && (
          <>
            <div className="erp-bill-items-head">
              <span className="erp-bill-microlabel">Items · {items.length}</span>
              {items.length > 8 && (
                <span className="erp-bill-microhint">scroll for more ↓</span>
              )}
            </div>
            <div className="erp-bill-items-scroll">
              <Table columns={itemColumns} dataSource={items} rowKey="item_id"
                pagination={false} size="small" scroll={{ x: 600 }} />
            </div>
          </>
        )}

        <div className="erp-bill-summary">
          <div className="erp-bill-hero" style={{
            background: heroBg, borderColor: heroBr,
          }}>
            <div className="erp-bill-hero-label">{heroLabel}</div>
            <div className="erp-bill-hero-amount" style={{ color: heroColor }}>
              {fmt(heroValue)}
            </div>
            {heroIsBalance && (
              <div className="erp-bill-hero-sub">
                of <strong>{fmt(bill.total_amount)}</strong>
                <span className="erp-bill-hero-sub-sep">·</span>
                <span style={{ color: '#34D399' }}>{fmt(bill.refund_amount)} refunded</span>
              </div>
            )}
            <div className="erp-bill-hero-actions">
              <button type="button" className="erp-bill-hero-btn"
                onClick={() => onPrint?.(bill.sales_return_id)}
                title="Print credit note">
                <PrinterOutlined /> Print
              </button>
              <button type="button" className="erp-bill-hero-btn"
                onClick={() => onExportPDF?.(bill)}
                title="Export PDF">
                <FilePdfOutlined /> PDF
              </button>
              <button type="button" className="erp-bill-hero-btn"
                onClick={() => onWhatsApp?.(bill)}
                title="Share via WhatsApp">
                <WhatsAppOutlined /> Share
              </button>
            </div>
          </div>

          <div className="erp-bill-breakdown">
            <SummaryRow label="Sub Total" value={fmt(bill.sub_total)} />
            {discount > 0 && (
              <SummaryRow label={`Discount${bill.discount_percentage > 0 ? ` (${bill.discount_percentage}%)` : ''}`}
                value={`- ${fmt(discount)}`} color="#d97706" />
            )}
            {igst > 0 && (<SummaryRow label={`IGST${bill.igst_pct > 0 ? ` (${bill.igst_pct}%)` : ''}`} value={fmt(igst)} />)}
            {cgst > 0 && (<SummaryRow label={`CGST${bill.cgst_pct > 0 ? ` (${bill.cgst_pct}%)` : ''}`} value={fmt(cgst)} />)}
            {sgst > 0 && (<SummaryRow label={`SGST${bill.sgst_pct > 0 ? ` (${bill.sgst_pct}%)` : ''}`} value={fmt(sgst)} />)}
            {totalGst === 0 && parseFloat(bill.gst_amount || 0) > 0 && (<SummaryRow label="GST" value={fmt(bill.gst_amount)} />)}
            {roundOff !== 0 && (<SummaryRow label="Round Off" value={roundOff.toFixed(2)} />)}
            <SummaryRow label="Credit Total" value={fmt(bill.total_amount)} bold borderTop />
            <SummaryRow label="Refunded" value={fmt(bill.refund_amount)} color="#34D399" />
            <SummaryRow label="Credit Pending" value={fmt(balance)}
              color={balance > 0 ? '#EF4444' : '#34D399'} bold borderTop />
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Circular ring ──────────────────────────────────────────────────────────────
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

// ── Main list ──────────────────────────────────────────────────────────────────
export default function SalesReturnList() {
  const [searchInput, setSearchInput] = useState('');
  const today = dayjs().format('YYYY-MM-DD');
  const [filters, setFilters] = useState({ search: '', refund_status: null, from_date: today, to_date: today });
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(f => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [viewBill, setViewBill]       = useState(null);
  const [companyName, setCompanyName] = useState('');

  // Search input ref so the F4 = Find action can focus it from the strip.
  const searchInputRef = useRef(null);

  // Virtualized data layer — server returns paginated chunks + summary.
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => salesReturnAPI.getAll(params),
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
      const { data } = await salesReturnAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load return');
      return null;
    }
  }, []);

  const handleView      = async (id) => { const b = await fetchBill(id); if (b) setViewBill(b); };
  const handlePrint     = (id) => printDocument({ docType: 'sales_return', id });
  const handleEdit      = (id) => navigate(`/sales-return/edit/${id}`);
  const handleExportPDF = (bill) => exportBillPDF({ docType: 'sales_return', bill });
  const handleWhatsApp  = (bill) => shareBillViaWhatsApp({ docType: 'sales_return', bill });

  // Selection model — cursor + multi-select.
  const sel = useListSelection({ totalCount, rows });
  const activeRow      = sel.activeRow;
  const selectedRows   = sel.selectedRows;
  const selectionCount = sel.selectionCount;
  const isMulti        = selectionCount > 1;
  const single         = !isMulti ? activeRow : null;
  const singleCancelled = single?.is_cancelled;
  // Phone derived from the credit note's customer mobile_1.
  const singlePhone = (() => {
    if (!single || single.customer?.is_system_cash) return null;
    const m = single.customer?.mobile_1;
    return m && !/^TLY/i.test(m) ? m : null;
  })();

  // Bulk-cancel — confirm once, run cancellations serially, summarize at
  // the end. Preserves the existing single-cancel error semantics for
  // 1-row cancels (the API response carries the reason inline anyway).
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
      content: 'Cancelling reverses customer credit, removes the stock-ledger Sales Return rows, and pulls the returned stock back out of inventory.',
      okText: cancellable.length === 1 ? 'Cancel this return' : `Cancel ${cancellable.length} returns`,
      okButtonProps: { danger: true },
      cancelText: 'Keep them',
      onOk: async () => {
        let ok = 0, fail = 0;
        const failures = [];
        for (const r of cancellable) {
          try {
            await salesReturnAPI.cancel(r.sales_return_id);
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

  // KPI values from server-aggregated summary so they reflect the full
  // filtered set, not just chunks the user has scrolled past.
  const totalAmount = parseFloat(summary?.total_amount || 0);
  const refunded    = parseFloat(summary?.total_refund || 0);
  const pending     = parseFloat(summary?.total_pending || 0);
  const openCredits = summary?.open_count || 0;
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
      // Single-line Customer name. Mobile moved to its own optional
      // `mobile` column below — toggleable via Customize.
      key: 'cust', title: 'Customer', dataIndex: ['customer', 'party_name'], width: 200,
      render: (v) => <span className="bill-cust">{v || '—'}</span>,
    },
    cols.mobile && {
      key: 'mobile', title: 'Mobile', width: 130,
      render: (_, r) => {
        const m = r.customer?.mobile_1;
        return m
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>{m}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    cols.gstin && {
      key: 'gstin', title: 'GSTIN', width: 160,
      render: (_, r) => {
        const g = r.customer?.gstin;
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
          <h1>Sales Returns</h1>
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
                <label className="opt"><span>Return # · Date · Customer</span><span className="pin">Pinned</span></label>
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
          <button className="blist-cta" onClick={() => navigate('/sales-return/new')}>
            <PlusOutlined /> New Return <span className="blist-cta-kbd">F3</span>
          </button>
        </div>
      </div>

      <div className="blist-kpi">
        <div className="kpi-card total">
          <div className="kpi-text">
            <div className="k">Total Returns · This View</div>
            <div className="v">{fmt(totalAmount)}</div>
            <div className="sub">{returnCount} returns · avg {fmtShort(avg)}</div>
          </div>
        </div>
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Refunded</div>
            <div className="v">{fmt(refunded)}</div>
            <div className="sub">of {fmtShort(totalAmount)} credited</div>
          </div>
          <Ring pct={refundedPct} tone="ok" />
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Credit Pending</div>
            <div className="v">{fmt(pending)}</div>
            <div className="sub">from {openCredits} open credit note{openCredits === 1 ? '' : 's'}</div>
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
          rowKey="sales_return_id"
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
            onDoubleClick: () => record?.sales_return_id && handleView(record.sales_return_id),
          })}
        />
      </div>

      {/* ── Bottom action strip — all return actions on F-keys.
          Returns don't have receipt/payment/whatsapp slots so F6/F7
          are absent. F8 cancels (with bulk-confirm). */}
      <ActionStrip
        info={isMulti ? `${selectionCount} selected` : null}
        actions={[
          // Visual order: utility on the left, destructive F8 + primary
          // F1 on the right (matches forms + SalesList convention).
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: isMulti || !single || singleCancelled,
            onAction: () => single && handleEdit(single.sales_return_id),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: () => navigate('/sales-return/new'),
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
            onAction: () => single && handlePrint(single.sales_return_id),
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
            title: 'Share this credit note PDF with the customer',
          },
          {
            id: 'cancel', key: 'F8', label: 'Cancel', tone: 'danger',
            disabled: !activeRow,
            onAction: () => handleBulkCancel(isMulti ? selectedRows : [single]),
          },
          {
            id: 'open', key: 'F1', label: 'Open', tone: 'primary',
            disabled: isMulti || !single,
            onAction: () => single && handleView(single.sales_return_id),
          },
        ]}
      />

      <ViewModal bill={viewBill} onClose={() => setViewBill(null)}
        onPrint={handlePrint} onExportPDF={handleExportPDF} onWhatsApp={handleWhatsApp} />
    </div>
  );
}
