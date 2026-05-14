import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  message, DatePicker, Select,
  Modal, Dropdown, Table,
} from 'antd';
import {
  PlusOutlined, SearchOutlined,
  SettingOutlined, PauseCircleOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesAPI, salesDraftAPI, settingsAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument, exportBillPDF, shareBillViaWhatsApp } from '../../services/printer';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../../styles/bill-list.css';
// Pulled in solely for the `.sbf-drafts-*` editorial drafts-modal
// classes so the Drafts dialog here matches the SalesBillForm version.
import './sales-bill-form.css';

// Optional columns the user can toggle via the Customize popover. Keys
// match the state shape persisted to localStorage.
const SALES_OPTIONAL_COLS = [
  { key: 'time',     label: 'Time' },
  { key: 'godown',   label: 'Godown' },
  { key: 'mobile',   label: 'Mobile' },
  { key: 'gstin',    label: 'GSTIN' },
  { key: 'items',    label: 'Items (count)' },
  { key: 'pieces',   label: 'Pieces' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
  { key: 'return',   label: 'Return amount' },
];
// Toggleable page sections (not data columns) — currently just the
// sticky bottom "Total (N bills)" strip. Default on. Stored alongside
// the column prefs so the Customize popover can show both groups.
const SALES_SECTIONS = [
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
// v6 promotes the godown badge (previously rendered inline next to the
// bill number) to its own toggleable column. Existing v5 users inherit
// `godown: true` via the DEFAULT_COLS spread on first read, so the
// info they used to see stays visible.
const COLS_STORAGE_KEY = 'salesList_cols_v6';
const DEFAULT_COLS = {
  time: true, godown: true, mobile: true, gstin: false,
  items: true, pieces: true,
  gst: false, discount: false, return: false,
  totalRow: true,
};

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtShort = (v) => {
  const n = parseFloat(v || 0);
  if (n === 0) return '₹ 0';
  return `₹ ${Math.round(n).toLocaleString('en-IN')}`;
};

/* ── View Modal ───────────────────────────────────────────────────────────────
 * Read-only bill viewer, opened on F1 / row-click in the Sales list.
 *
 * Rewritten 2026-05-14: replaced the AntD <Descriptions> grid + generic
 * <Table> chrome with a custom layout that reads as native ERP chrome.
 * The previous version mis-named the item rate field ('sale_rate'), so
 * every line showed Rate ₹0.00 even when the bill subtotal was non-zero
 * — the actual model field is `rate` (see server/models/SalesBillItem.js
 * line 50). Fixed below alongside the visual rework.
 * ────────────────────────────────────────────────────────────────────────── */

const statusTone = (s) =>
  s === 'Paid'    ? { fg: '#34D399', bg: 'rgba(52, 211, 153, 0.12)', br: 'rgba(52, 211, 153, 0.28)' }
: s === 'Partial' ? { fg: '#F59E0B', bg: 'rgba(245, 158, 11, 0.12)', br: 'rgba(245, 158, 11, 0.28)' }
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

function ViewModal({ bill, onClose }) {
  if (!bill) return null;
  const items = bill.items || [];
  const cgst = parseFloat(bill.cgst_amount || 0);
  const sgst = parseFloat(bill.sgst_amount || 0);
  const igst = parseFloat(bill.igst_amount || 0);
  const totalGst = cgst + sgst + igst;
  const discount = parseFloat(bill.discount_amount || 0);
  const returnAmt = parseFloat(bill.return_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);
  const roundOff = parseFloat(bill.round_off || 0);

  const customerLabel = (() => {
    const n = bill.customer?.party_name;
    const isCash = !n || bill.customer?.is_system_cash;
    const w = String(bill.walk_in_name || '').trim();
    return isCash ? `Cash${w ? ` — ${w}` : ''}` : n;
  })();

  const tone = statusTone(bill.payment_status);

  // Item table — the data bug fix lives here. Rate now reads `r.rate`
  // (was `r.sale_rate`, which doesn't exist on the model). Amount uses
  // the same field so the row maths can't drift from what's stored.
  const itemColumns = [
    { title: '#', width: 36, render: (_, __, i) => i + 1 },
    { title: 'Product', dataIndex: 'product_name', ellipsis: true },
    { title: 'Barcode', dataIndex: 'barcode', width: 110,
      render: v => v ? <span style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11.5 }}>{v}</span> : <span style={{ color: 'var(--fg-tertiary)' }}>—</span> },
    { title: 'Size',  dataIndex: 'size',  width: 70, render: v => v || <span style={{ color: 'var(--fg-tertiary)' }}>—</span> },
    { title: 'Qty',   dataIndex: 'quantity', width: 70, align: 'right',
      render: v => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{parseFloat(v || 0).toFixed(2)}</span> },
    { title: 'Rate',  dataIndex: 'rate',     width: 100, align: 'right',
      render: v => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</span> },
    { title: 'Amount', width: 110, align: 'right',
      render: (_, r) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
        {fmt(parseFloat(r.quantity || 0) * parseFloat(r.rate || 0))}
      </span> },
  ];

  // Title block — bill number with the status tag inline, plus the date
  // pinned right. Replaces the previous plain "Sales Bill — 1027" string
  // so the modal header carries the same context the list row does.
  const titleBlock = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em' }}>
        Sales Bill <span style={{ color: 'var(--fg-tertiary)', fontWeight: 500 }}>#</span>{bill.bill_number}
      </span>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '2px 9px', borderRadius: 6,
        fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
        color: tone.fg, background: tone.bg, border: `1px solid ${tone.br}`,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: tone.fg }} />
        {bill.payment_status}
      </span>
      <span style={{
        marginLeft: 'auto', fontSize: 12.5, color: 'var(--fg-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {dayjs(bill.bill_date).format('DD MMM YYYY')}
      </span>
    </div>
  );

  return (
    <Modal open onCancel={onClose} width={920} footer={null}
      title={titleBlock}
      styles={{ body: { padding: '8px 24px 20px' } }}>

      {/* Meta block — replaces the AntD Descriptions grid. Reads as a
          two-column label/value list with uppercase micro labels, same
          rhythm the rest of the app's detail surfaces use. */}
      <div style={{ padding: '6px 0 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <MetaRow label="Customer">{customerLabel}</MetaRow>
        {bill.payment_method && <MetaRow label="Payment Method">{bill.payment_method}</MetaRow>}
        {bill.remarks && <MetaRow label="Remarks">{bill.remarks}</MetaRow>}
      </div>

      {/* Items table — tabular-nums on every right-aligned column so the
          rupee figures line up on the decimal. Bold amount column so the
          eye lands on the line totals first. */}
      <div className="erp-view-items" style={{ margin: '14px 0 4px' }}>
        <div style={{
          fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--fg-tertiary)', fontWeight: 500, marginBottom: 6,
        }}>Items · {items.length}</div>
        <Table columns={itemColumns} dataSource={items} rowKey="sales_bill_item_id"
          pagination={false} size="small" scroll={{ x: 600 }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <div style={{ width: 320 }}>
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
          <SummaryRow label="Total" value={fmt(bill.total_amount)} bold borderTop />
          {returnAmt > 0 && (<SummaryRow label="Return Amount" value={`- ${fmt(returnAmt)}`} color="#7c3aed" />)}
          <SummaryRow label="Paid" value={fmt(bill.paid_amount)} color="#16a34a" />
          <SummaryRow label="Balance Due" value={fmt(bill.balance_amount)}
            color={balance > 0 ? '#dc2626' : '#16a34a'} bold borderTop />
        </div>
      </div>
    </Modal>
  );
}

// ── Circular progress ring (for KPI cards) ─────────────────────────────────────
function Ring({ pct, tone = 'ok' }) {
  // r=22 → circumference = 2πr ≈ 138.23
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
export default function SalesList() {
  const { fyStart, fyEnd } = useFinancialYear();
  // `searchInput` is the raw value in the box — updates on every keystroke
  // so the caret doesn't lag. `filters.search` is the debounced value that
  // actually hits the API.
  const [searchInput, setSearchInput] = useState('');
  // Date defaults to the company FY — same as every other period selector.
  const [filters, setFilters] = useState({ search: '', payment_status: null, from_date: fyStart, to_date: fyEnd });
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(f => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [viewBill, setViewBill]     = useState(null);
  const [companyName, setCompanyName] = useState('');

  // Search input ref so the F4 = Find action can focus it from the strip.
  const searchInputRef = useRef(null);

  // ── Virtualized data layer. Server returns paginated chunks +
  // summary aggregates for the full filtered set — KPIs and footer
  // totals stay accurate as the user scrolls because they read from
  // `summary`, not from the loaded chunks.
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => salesAPI.getAll(params),
    filters,
    chunkSize: 200,
  });

  // Drafts (held bills) — separate fetch from sales_bills, never affects
  // counts/totals. Modal opens on click of the Drafts pill.
  const [drafts, setDrafts] = useState([]);
  const [draftsModalOpen, setDraftsModalOpen] = useState(false);
  const loadDrafts = useCallback(async () => {
    try {
      const { data } = await salesDraftAPI.list();
      setDrafts(data?.data || []);
    } catch { /* silent — drafts pill just shows 0 */ }
  }, []);
  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  // Column visibility — persisted so user's choice survives reload.
  const [cols, setCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLS, ...saved } : DEFAULT_COLS;
    } catch { return DEFAULT_COLS; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(cols)); } catch {}
  }, [cols]);
  // Count of toggled-on optional COLUMNS only — sections (e.g. totalRow)
  // are excluded so the badge on the Customize button reflects column
  // additions, not page sections.
  const visibleOptionalCount = SALES_OPTIONAL_COLS.filter((c) => cols[c.key]).length;

  const navigate = useNavigate();

  useEffect(() => {
    settingsAPI.getSystem().then(({ data }) => setCompanyName(data?.data?.company_name || '')).catch(() => {});
  }, []);

  const fetchBill = useCallback(async (id) => {
    try {
      const { data } = await salesAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load bill');
      return null;
    }
  }, []);

  const handleView      = async (id) => { const b = await fetchBill(id); if (b) setViewBill(b); };
  const handlePrint     = (id)   => printDocument({ docType: 'sales', id });
  const handleEdit      = (id)   => navigate(`/sale/edit/${id}`);
  const handleExportPDF = (bill) => exportBillPDF({ docType: 'sales', bill });
  const handleWhatsApp  = (bill) => shareBillViaWhatsApp({ docType: 'sales', bill });
  const handleRecordReceipt = (bill) => {
    // Pre-select this customer + bill when opening receipt entry. Use the
    // bill's own customer_id FK — the included customer object only has
    // party_name/mobile_1 for the list view, so customer.party_id is undefined
    // and would send a null preselect that ReceiptEntry can't act on.
    navigate('/receipt/new', {
      state: {
        preselect: {
          party_id: bill.customer_id ?? bill.customer?.party_id,
          bill_id:  bill.sales_bill_id,
        },
      },
    });
  };

  // ── Selection model — cursor + multi-select ───────────────────────
  // Cursor IS selection: arrow nav moves cursor and that row is selected.
  // Shift+arrows / Shift+Click extend a range. Ctrl+Click toggles. Ctrl+A
  // selects all. The action strip below operates on whatever's selected.
  const sel = useListSelection({ totalCount, rows });
  const activeRow      = sel.activeRow;
  const selectedRows   = sel.selectedRows;
  const selectionCount = sel.selectionCount;
  const isMulti        = selectionCount > 1;
  // Convenience: when user has 1 row cursored, this is it; for multi
  // operations, work off selectedRows.
  const single = !isMulti ? activeRow : null;
  const singleCancelled = single?.is_cancelled;
  const singleHasBalance = single ? parseFloat(single.balance_amount || 0) > 0.01 : false;
  const singlePhone = (() => {
    if (!single || single.customer?.is_system_cash) return null;
    const m = single.customer?.mobile_1;
    return m && !/^TLY/i.test(m) ? m : null;
  })();

  // Bulk-cancel — confirms once, then runs the cancellations serially
  // (parallel would slam the API and the per-bill error semantics already
  // run sequentially server-side anyway). We don't surface per-bill error
  // modals; instead we show a summary at the end so the user isn't
  // drowned in N popups.
  const handleBulkCancel = useCallback((rowsToCancel) => {
    const cancellable = rowsToCancel.filter(r => r && !r.is_cancelled);
    if (cancellable.length === 0) {
      message.info('Nothing to cancel — selection is already cancelled.');
      return;
    }
    Modal.confirm({
      title: cancellable.length === 1
        ? `Cancel bill ${cancellable[0].bill_number}?`
        : `Cancel ${cancellable.length} bills?`,
      content: 'Cancelling is permanent. Stock and ledger entries will be reversed for each bill.',
      okText: cancellable.length === 1 ? 'Cancel this bill' : `Cancel ${cancellable.length} bills`,
      okButtonProps: { danger: true },
      cancelText: 'Keep them',
      onOk: async () => {
        let ok = 0, fail = 0;
        const failures = [];
        for (const r of cancellable) {
          try {
            await salesAPI.cancel(r.sales_bill_id);
            ok++;
          } catch (e) {
            fail++;
            failures.push(`${r.bill_number}: ${e.response?.data?.error || 'failed'}`);
          }
        }
        refresh();
        if (fail === 0) message.success(`Cancelled ${ok} bill${ok === 1 ? '' : 's'}.`);
        else {
          message.warning(`${ok} cancelled, ${fail} failed.`);
          if (failures.length <= 3) failures.forEach(f => message.error(f));
        }
      },
    });
  }, [refresh]);

  // KPI values come from server-aggregated `summary` so they reflect the
  // full filtered set, not just what's been scrolled into view.
  const totalAmount = parseFloat(summary?.total_amount || 0);
  const received    = parseFloat(summary?.total_paid || 0);
  const outstanding = parseFloat(summary?.total_balance || 0);
  const openBills   = summary?.open_count || 0;
  const billCount   = summary?.count || totalCount;
  const avg         = billCount > 0 ? totalAmount / billCount : 0;
  const receivedPct    = totalAmount > 0 ? (received / totalAmount) * 100 : 0;
  const outstandingPct = totalAmount > 0 ? (outstanding / totalAmount) * 100 : 0;

  // ── Antd columns — render funcs preserve the editorial visual
  // treatment (dual-line cells, status pills, Settled/Voided tags,
  // colored amounts). Only the action group migrates from
  // hover-overlay to a fixed-right column.
  const columns = [
    {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => <span className="sr-n">{String(idx + 1).padStart(2, '0')}</span>,
    },
    {
      // Bill # cell is now pure — the godown badge moved to its own
      // toggleable column (key='godown') so it can be shown/hidden via
      // the Customize popover without crowding the bill number.
      key: 'bill', title: 'Bill #', dataIndex: 'bill_number', width: 130,
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
      key: 'date', title: 'Date', dataIndex: 'bill_date', width: 120,
      render: (v) => v ? dayjs(v).format('DD MMM YYYY') : '—',
    },
    cols.time && {
      key: 'time', title: 'Time', width: 90,
      render: (_v, r) => {
        // Prefer createdAt (when the bill was actually entered) so
        // back-dated bills still show the entry time.
        const timeSource = r.createdAt || r.created_date || null;
        const t = timeSource ? dayjs(timeSource) : null;
        return t
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{t.format('h:mm a')}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    {
      // Customer column is now single-line (just the party name) so the
      // row height stays compact. The previous mobile/GSTIN/walk-in
      // sub-line moved to its own optional `mobile` column below — the
      // operator toggles via the Customize popover.
      key: 'cust', title: 'Customer', dataIndex: ['customer', 'party_name'], width: 200,
      render: (v, r) => {
        const isSystemCash = !!r.customer?.is_system_cash;
        const isCash = !v || isSystemCash;
        return (
          <span className={`bill-cust${isCash ? ' cash' : ''}`}>
            {isCash ? 'Cash' : v}
          </span>
        );
      },
    },
    cols.mobile && {
      // Mobile column — pure mobile number. TLY-prefixed mobiles from
      // Tally imports are filtered out (those are placeholder strings,
      // not real numbers). Cash sales without a saved mobile show a
      // dash; the walk-in name (if any) lives in the View modal.
      key: 'mobile', title: 'Mobile', width: 130,
      render: (_, r) => {
        const rawMobile = r.customer?.mobile_1;
        const cleanMobile = rawMobile && !/^TLY/i.test(rawMobile) ? rawMobile : null;
        return cleanMobile
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>{cleanMobile}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    cols.gstin && {
      // GSTIN column — pure tax ID. Useful for compliance reports and
      // for confirming the right business is being billed. Off by
      // default since most daily ops don't need it on-screen.
      key: 'gstin', title: 'GSTIN', width: 160,
      render: (_, r) => {
        const g = r.customer?.gstin;
        return g
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }}>{g}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    cols.items && {
      // Items count only — pcs total moved to its own optional `pieces`
      // column below. Single-line cell keeps the row compact.
      key: 'items', title: 'Items', width: 70, align: 'right',
      render: (_, r) => {
        const itemCount = r._item_count ?? r.items?.length ?? null;
        return (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {itemCount != null ? itemCount : '—'}
          </span>
        );
      },
    },
    cols.pieces && {
      key: 'pieces', title: 'Pieces', width: 80, align: 'right',
      render: (_, r) => {
        const pcsTotal = r._pcs_total ?? (r.items ? r.items.reduce((s, it) => s + parseFloat(it.quantity || 0), 0) : null);
        return pcsTotal != null
          ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-secondary)' }}>{pcsTotal}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
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
      key: 'gst', title: 'GST', dataIndex: 'gst_amount', width: 100, align: 'right',
      render: (v, r) => {
        const amt = parseFloat(v || 0) ||
                    (parseFloat(r.cgst_amount || 0) + parseFloat(r.sgst_amount || 0) + parseFloat(r.igst_amount || 0));
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
      key: 'paid', title: 'Paid', dataIndex: 'paid_amount', width: 110, align: 'right',
      render: (v) => parseFloat(v || 0) > 0.01
        ? <span className="amt paid"><span className="rs">₹</span>{Math.round(parseFloat(v)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>,
    },
    {
      key: 'balance', title: 'Balance', dataIndex: 'balance_amount', width: 130, align: 'right',
      render: (v, r) => {
        const balance = parseFloat(v || 0);
        if (r.is_cancelled) return <span className="voided-tag">Voided</span>;
        if (balance < 0.01) return <span className="settled-tag">Settled</span>;
        return <span className="amt due"><span className="rs">₹</span>{Math.round(balance).toLocaleString('en-IN')}</span>;
      },
    },
    cols.return && {
      key: 'return', title: 'Return', dataIndex: 'return_amount', width: 100, align: 'right',
      render: (v) => parseFloat(v || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(v)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>,
    },
    // (Per-row actions column removed — all bill actions live in the
    // bottom ActionStrip and operate on the cursored / selected rows.)
  ].filter(Boolean);

  // Bottom Total strip — driven by server-aggregated `summary` so the
  // numbers reflect the entire filtered set, not just the chunks the
  // user has scrolled past. Toggled by the `Total row` section in the
  // Customize popover. Same colSpan-merge pattern as Sales Report:
  // leading non-aggregable columns merge into one cell holding the
  // "Total (N bills)" label.
  const SUMMABLE_KEYS = new Set(['total', 'paid', 'balance', 'gst', 'discount', 'return']);
  const firstAggIdx = (() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  })();
  const totalForKey = (k) => {
    switch (k) {
      case 'total':    return <strong><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_amount   || 0)).toLocaleString('en-IN')}</strong>;
      case 'paid':     return <span className="amt paid"><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_paid    || 0)).toLocaleString('en-IN')}</span>;
      case 'balance':  return <span className="amt due"><span className="rs">₹</span>{Math.round(parseFloat(summary?.total_balance || 0)).toLocaleString('en-IN')}</span>;
      case 'gst':      return parseFloat(summary?.total_gst      || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(summary.total_gst)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>;
      case 'discount': return parseFloat(summary?.total_discount || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(summary.total_discount)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>;
      case 'return':   return parseFloat(summary?.total_return   || 0) > 0.01
        ? <span className="amt"><span className="rs">₹</span>{Math.round(parseFloat(summary.total_return)).toLocaleString('en-IN')}</span>
        : <span className="amt zero">—</span>;
      default:         return null;
    }
  };
  const summaryCells = (col, idx) => {
    if (idx === 0) return totalCount > 0 ? `Total (${totalCount} bill${totalCount === 1 ? '' : 's'})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;
    return totalForKey(col.key);
  };
  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  return (
    <div className="blist-page">

      {/* Top bar — title + search + date + status + CTAs */}
      <div className="blist-hd">
        <div className="blist-title">
          <h1>Sales Bills</h1>
        </div>
        <div className="blist-ctrl">
          <div className="blist-search">
            <SearchOutlined />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search bill no or customer"
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
            onChange={(v) => setFilters(f => ({ ...f, payment_status: v }))}
            options={[
              { value: 'Paid',    label: 'Paid' },
              { value: 'Partial', label: 'Partial' },
              { value: 'Unpaid',  label: 'Unpaid' },
            ]}
          />
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            dropdownRender={() => (
              <div className="cols-menu" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.12)' }}>
                <div className="mh">Optional columns</div>
                {SALES_OPTIONAL_COLS.map(c => (
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
                {SALES_SECTIONS.map(s => (
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
                <label className="opt"><span>Bill · Date · Customer</span><span className="pin">Pinned</span></label>
                <label className="opt"><span>Total · Paid · Balance</span><span className="pin">Pinned</span></label>
              </div>
            )}
          >
            <button className={`blist-chip${visibleOptionalCount > 0 ? ' on' : ''}`}>
              <SettingOutlined /> Customize
              {visibleOptionalCount > 0 && <span className="col-count">{visibleOptionalCount}</span>}
            </button>
          </Dropdown>
          <span className="blist-divider"></span>
          {drafts.length > 0 && (
            <button className="blist-cta ghost" onClick={() => setDraftsModalOpen(true)}
                    title="View held bills">
              <PauseCircleOutlined /> Drafts
              <span style={{
                marginLeft: 6,
                padding: '0 7px',
                background: 'var(--accent-primary, #E26A4C)',
                color: '#fff',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                lineHeight: '18px',
                display: 'inline-block',
              }}>{drafts.length}</span>
            </button>
          )}
          <button className="blist-cta ghost" onClick={() => navigate('/receipt/new')}>
            <PlusOutlined /> Receipt
          </button>
          <button className="blist-cta" onClick={() => navigate('/sale/new')}>
            <PlusOutlined /> New Sale
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="blist-kpi">
        <div className="kpi-card total">
          <div className="kpi-text">
            <div className="k">Total Sale · This View</div>
            <div className="v">{fmt(totalAmount)}</div>
            <div className="sub">{billCount} bills · avg {fmtShort(avg)}</div>
          </div>
        </div>
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Received</div>
            <div className="v">{fmt(received)}</div>
            <div className="sub">of {fmtShort(totalAmount)} sold</div>
          </div>
          <Ring pct={receivedPct} tone="ok" />
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Outstanding</div>
            <div className="v">{fmt(outstanding)}</div>
            <div className="sub">from {openBills} open bills</div>
          </div>
          <Ring pct={outstandingPct} tone="bad" />
        </div>
      </div>

      {/* Bill list — virtualized table; row treatment preserved via column renders.
          Cursor + multi-select are owned by useListSelection (above) and passed
          as controlled props; VRT is purely visual. Double-click a row to open
          the View modal — single click only moves the cursor. */}
      <div className="blist-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="sales_bill_id"
          scroll={{ x: 1100 }}
          rowClassName={(r) => r && r.is_cancelled ? 'blist-row-cancelled' : ''}
          summaryCells={cols.totalRow ? summaryCells : undefined}
          summaryColSpan={cols.totalRow ? summaryColSpan : undefined}
          controlledCursorIdx={sel.cursorIdx}
          controlledSelectedSet={sel.selectedSet}
          onCursorMove={sel.setCursor}
          onShiftClickRow={sel.extendTo}
          onCtrlClickRow={sel.toggleRow}
          onRow={(record) => ({
            onDoubleClick: () => record?.sales_bill_id && handleView(record.sales_bill_id),
          })}
        />
      </div>

      {/* ── Bottom action strip — all bill actions live here.
          Strip handlers act on the cursored row (single) or the
          selected set (multi). Buttons auto-disable when the action
          can't apply to the current selection. */}
      <ActionStrip
        info={isMulti ? `${selectionCount} selected` : null}
        actions={[
          // Visual order: utility / nav keys on the left, destructive
          // F8 + primary F1 on the right — matches the convention used
          // by the bill forms and Tally Prime (Esc on the left, primary
          // action on the right of the button group).
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: isMulti || !single || singleCancelled,
            onAction: () => single && handleEdit(single.sales_bill_id),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: () => navigate('/sale/new'),
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
            id: 'receipt', key: 'F6', label: 'Receipt',
            disabled: isMulti || !single || singleCancelled || !singleHasBalance,
            onAction: () => single && handleRecordReceipt(single),
          },
          {
            id: 'whatsapp', key: 'F7', label: 'WhatsApp',
            disabled: isMulti || !single || singleCancelled || !singlePhone,
            onAction: () => single && handleWhatsApp(single),
          },
          {
            id: 'print', key: 'F9', label: 'Print',
            disabled: isMulti || !single,
            onAction: () => single && handlePrint(single.sales_bill_id),
          },
          {
            id: 'export', key: 'F10', label: 'Export PDF',
            disabled: isMulti || !single,
            onAction: () => single && handleExportPDF(single),
          },
          {
            id: 'cancel', key: 'F8', label: 'Cancel', tone: 'danger',
            disabled: !activeRow,
            onAction: () => handleBulkCancel(isMulti ? selectedRows : [single]),
          },
          {
            id: 'open', key: 'F1', label: 'Open', tone: 'primary',
            disabled: isMulti || !single,
            onAction: () => single && handleView(single.sales_bill_id),
          },
        ]}
      />

      <ViewModal bill={viewBill} onClose={() => setViewBill(null)} />

      {/* Drafts modal — same editorial layout as the SalesBillForm
          drafts panel so the operator sees a consistent UI whether
          they open the dialog from the bill form (mid-bill) or from
          the bill list. Reuses the `.sbf-drafts-*` classes from
          sales-bill-form.css. */}
      <Modal
        open={draftsModalOpen}
        onCancel={() => setDraftsModalOpen(false)}
        title={
          <div className="sbf-drafts-title">
            <span className="sbf-chip">Drafts</span>
            <span className="sbf-drafts-count">{drafts.length} held</span>
          </div>
        }
        footer={null}
        width="min(96vw, 1100px)"
        className="sbf-drafts-modal"
        styles={{ body: { padding: 0 } }}
      >
        {drafts.length === 0 ? (
          <div className="sbf-drafts-empty">
            <div className="sbf-drafts-empty-icon">📋</div>
            <div className="sbf-drafts-empty-main">No drafts held</div>
          </div>
        ) : (
          <div className="sbf-drafts-table">
            <div className="sbf-drafts-thead">
              <span className="c-date">Date</span>
              <span className="c-cust">Customer</span>
              <span className="c-qty">Qty</span>
              <span className="c-tot">Total</span>
              <span className="c-user">User</span>
              <span className="c-sm">Salesman</span>
              <span className="c-act"></span>
            </div>
            <div className="sbf-drafts-tbody">
              {drafts.map((d) => {
                const isAmount = d.payload?.bill_mode === 'amount';
                const totalQty = isAmount
                  ? null
                  : (d.payload?.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0);
                const dateObj = dayjs(d.created_date);
                return (
                  <div
                    key={d.draft_id}
                    className="sbf-drafts-tr"
                    onDoubleClick={() => {
                      setDraftsModalOpen(false);
                      navigate('/sale/new', { state: { recallDraft: d.draft_id } });
                    }}
                  >
                    <span className="c-date">
                      <span className="c-date-d">{dateObj.format('DD MMM YYYY')}</span>
                      <span className="c-date-t">{dateObj.format('HH:mm')}</span>
                    </span>
                    <span className="c-cust">
                      {d.customer?.party_name || <span className="walk-in">Walk-in</span>}
                      {isAmount && <span className="sbf-drafts-mode-tag amount">Amount</span>}
                    </span>
                    <span className="c-qty">
                      {isAmount ? '—' : (totalQty % 1 === 0 ? totalQty : totalQty.toFixed(1))}
                    </span>
                    <span className="c-tot">
                      ₹{parseFloat(d.total_preview || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                    <span className="c-user">{d.creator?.username || '—'}</span>
                    <span className="c-sm">{d.payload?.salesman_name || '—'}</span>
                    <span className="c-act">
                      <button
                        className="sbf-drafts-btn recall"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDraftsModalOpen(false);
                          navigate('/sale/new', { state: { recallDraft: d.draft_id } });
                        }}
                      >
                        <span className="sbf-drafts-btn-ico" aria-hidden>↩</span>
                        <span>Recall</span>
                      </button>
                      <button
                        className="sbf-drafts-btn discard"
                        title="Discard draft"
                        onClick={(e) => {
                          e.stopPropagation();
                          Modal.confirm({
                            title: `Discard ${d.draft_number}?`,
                            content: 'This permanently deletes the draft. Cannot be undone.',
                            okText: 'Discard', okType: 'danger',
                            onOk: async () => {
                              try {
                                await salesDraftAPI.delete(d.draft_id);
                                await loadDrafts();
                                message.success(`${d.draft_number} discarded`);
                              } catch (err) {
                                message.error('Failed to discard: ' + (err.response?.data?.error || err.message));
                              }
                            },
                          });
                        }}
                      >
                        Discard
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
