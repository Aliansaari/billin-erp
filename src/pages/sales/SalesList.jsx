import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  message, DatePicker, Select,
  Modal, Dropdown, Table,
} from 'antd';
import {
  PlusOutlined, SearchOutlined,
  SettingOutlined, PauseCircleOutlined,
  PrinterOutlined, WhatsAppOutlined, FilePdfOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesAPI, salesDraftAPI, settingsAPI } from '../../api';

import { printDocument, exportBillPDF, shareBillViaWhatsApp } from '../../services/printer';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../../styles/bill-list.css';
import './sales-view-modal.css';
// Pulled in solely for the `.sbf-drafts-*` editorial drafts-modal
// classes so the Drafts dialog here matches the SalesBillForm version.
import './sales-bill-form.css';

// Optional columns the user can toggle via the Customize popover. Keys
// match the state shape persisted to localStorage.
const SALES_OPTIONAL_COLS = [
  { key: 'time',             label: 'Time' },
  { key: 'godown',           label: 'Godown' },
  { key: 'mobile',           label: 'Mobile' },
  { key: 'gstin',            label: 'GSTIN' },
  { key: 'items',            label: 'Items (count)' },
  { key: 'pieces',           label: 'Pieces' },
  { key: 'gst',              label: 'GST amount' },
  { key: 'discount',         label: 'Discount' },
  { key: 'return',           label: 'Return amount' },
  { key: 'partyOutstanding', label: 'Party total outstanding' },
];
// Toggleable page sections (not data columns). Stored alongside column
// prefs so the Customize popover can show both groups in one place.
const SALES_SECTIONS = [
  { key: 'kpiCards', label: 'KPI summary cards' },
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
// v7 adds partyOutstanding column + kpiCards section toggle.
const COLS_STORAGE_KEY = 'salesList_cols_v7';
const DEFAULT_COLS = {
  time: true, godown: true, mobile: true, gstin: false,
  items: true, pieces: true,
  gst: false, discount: false, return: false,
  partyOutstanding: false,
  kpiCards: true, totalRow: true,
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

  // Title block — bill number is the hero, with the status pill inline
  // and the date pinned right. The "Sales Bill" label is uppercase
  // microtext so the number reads as the primary identifier, the way
  // an invoice's bill number usually does on paper. Accent underline
  // ties the title to the rest of the chrome.
  const titleBlock = (
    <div className="erp-bill-title">
      <div className="erp-bill-title-text">
        <span className="erp-bill-title-eyebrow">Sales Bill</span>
        <span className="erp-bill-title-number">#{bill.bill_number}</span>
        <span className="erp-bill-title-pill" style={{
          color: tone.fg, background: tone.bg, border: `1px solid ${tone.br}`,
        }}>
          <span className="erp-bill-title-pill-dot" style={{ background: tone.fg }} />
          {bill.payment_status}
        </span>
      </div>
      <span className="erp-bill-title-date">
        {dayjs(bill.bill_date).format('DD MMM YYYY')}
      </span>
    </div>
  );

  // The hero amount on the left of the summary section. When the bill is
  // settled (no balance), the hero shows the full Total. When it's still
  // open (Partial / Unpaid), the hero shows Balance Due — that's the
  // operator's primary question every time they open the viewer: "what
  // do I still need to collect?". Colour matches the urgency of that
  // answer (green when settled, red when due).
  const heroIsBalance = balance > 0.005;
  const heroLabel = heroIsBalance ? 'Balance Due' : 'Total Settled';
  const heroValue = heroIsBalance ? balance : parseFloat(bill.total_amount || 0);
  const heroColor = heroIsBalance ? '#EF4444' : '#34D399';
  const heroBg    = heroIsBalance ? 'rgba(239, 68, 68, 0.08)' : 'rgba(52, 211, 153, 0.08)';
  const heroBr    = heroIsBalance ? 'rgba(239, 68, 68, 0.22)' : 'rgba(52, 211, 153, 0.22)';

  return (
    <Modal open onCancel={onClose} width={1000} footer={null}
      title={titleBlock}
      className="erp-bill-view"
      /* Padding zeroed on the body so our internal flex column owns the
         spacing — needed because the inner Items section has to scroll
         independently of the (always-visible) meta header and summary
         footer. */
      styles={{ body: { padding: 0 } }}>

      {/* Inner shell: column laid out as [meta · scrollable items · sticky
          summary]. max-height keeps tall bills (29+ items, as in the
          screenshot that drove this rewrite) from running off the viewport
          — instead the items section gets its own scroll affordance and
          the totals stay anchored to the bottom edge of the modal. */}
      <div className="erp-bill-shell">

        {/* Meta block — never scrolls. */}
        <div className="erp-bill-meta">
          <MetaRow label="Customer">{customerLabel}</MetaRow>
          {bill.payment_method && <MetaRow label="Payment Method">{bill.payment_method}</MetaRow>}
          {bill.remarks && <MetaRow label="Remarks">{bill.remarks}</MetaRow>}
        </div>

        {/* Items header — always visible above the scrollable list. */}
        <div className="erp-bill-items-head">
          <span className="erp-bill-microlabel">Items · {items.length}</span>
          {items.length > 8 && (
            <span className="erp-bill-microhint">scroll for more ↓</span>
          )}
        </div>

        {/* Items table — the only thing that scrolls. flex: 1 + overflow:
            auto on the wrapper lets it absorb whatever vertical space the
            modal has left after meta + summary claim theirs. Compact rows
            (32 px) so a many-line bill stays scannable. */}
        <div className="erp-bill-items-scroll">
          <Table columns={itemColumns} dataSource={items} rowKey="sales_bill_item_id"
            pagination={false} size="small" scroll={{ x: 600 }} />
        </div>

        {/* Summary — sticks to the modal's bottom edge. Two-column layout:
            hero amount + actions on the left (operator's primary
            question — "what's still due?" or "this is settled"), full
            breakdown on the right. Subtle accent border on the hero
            card and a tinted backdrop on the whole footer mark it as a
            distinct zone from the scrolling items above. */}
        <div className="erp-bill-summary">
          {/* Hero card — fills what used to be empty space on the left.
              Color-coded by status: red bg when there's a balance due,
              green when settled. Big amount, action buttons below. */}
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
                <span style={{ color: '#34D399' }}>{fmt(bill.paid_amount)} paid</span>
              </div>
            )}
            {/* Quick actions — same handlers the list-row triple uses
                (printDocument / exportBillPDF / shareBillViaWhatsApp).
                Keeps the viewer self-sufficient: operator can act on
                the bill without dismissing the modal to reach the row. */}
            <div className="erp-bill-hero-actions">
              <button type="button" className="erp-bill-hero-btn"
                onClick={() => printDocument({ docType: 'sales', id: bill.sales_bill_id })}
                title="Print bill (F9)">
                <PrinterOutlined /> Print
              </button>
              <button type="button" className="erp-bill-hero-btn"
                onClick={() => exportBillPDF({ docType: 'sales', bill })}
                title="Export PDF (F10)">
                <FilePdfOutlined /> PDF
              </button>
              <button type="button" className="erp-bill-hero-btn"
                onClick={() => shareBillViaWhatsApp({ docType: 'sales', bill })}
                title="Share via WhatsApp (F7)">
                <WhatsAppOutlined /> Share
              </button>
            </div>
          </div>

          {/* Breakdown — every line that contributes to the Total, with
              a clear visual break before Total/Paid/Balance which are
              the bottom-line numbers. */}
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
            <SummaryRow label="Total" value={fmt(bill.total_amount)} bold borderTop />
            {returnAmt > 0 && (<SummaryRow label="Return Amount" value={`- ${fmt(returnAmt)}`} color="#7c3aed" />)}
            <SummaryRow label="Paid" value={fmt(bill.paid_amount)} color="#34D399" />
            <SummaryRow label="Balance Due" value={fmt(bill.balance_amount)}
              color={balance > 0 ? '#EF4444' : '#34D399'} bold borderTop />
          </div>
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
  // `searchInput` is the raw value in the box — updates on every keystroke
  // so the caret doesn't lag. `filters.search` is the debounced value that
  // actually hits the API.
  const [searchInput, setSearchInput] = useState('');
  const today = dayjs().format('YYYY-MM-DD');
  const [filters, setFilters] = useState({ search: '', payment_status: null, from_date: today, to_date: today });
  // Debounce the search input → filters.search. Dates stay untouched —
  // the user controls the date range independently via the date picker.
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
  const { rows, totalCount, summary, ensureChunk, loading, error, refresh } = useVirtualizedReport({
    fetcher: (params) => salesAPI.getAll(params),
    filters,
    chunkSize: 200,
  });
  // Surface search/filter API errors as a toast so they don't silently
  // swallow — the old data would stay on screen and look like "search
  // is not working" when it was really a server-side SQL failure.
  useEffect(() => {
    if (error) message.error('Failed to load bills: ' + (error.response?.data?.error || error.message || 'Unknown error'));
  }, [error]);

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
      // external imports are filtered out (those are placeholder strings,
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
    cols.partyOutstanding && {
      key: 'partyOutstanding', title: 'Party Dues', width: 130, align: 'right',
      render: (_, r) => {
        if (!r.customer_id || r.customer?.is_system_cash) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        const total = parseFloat(r.party_outstanding || 0);
        return total > 0.01
          ? <span className="amt due" title="Total outstanding across all bills for this customer"><span className="rs">₹</span>{Math.round(total).toLocaleString('en-IN')}</span>
          : <span className="settled-tag">Cleared</span>;
      },
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
            <PlusOutlined /> Receipt <span className="blist-cta-kbd">F6</span>
          </button>
          <button className="blist-cta" onClick={() => navigate('/sale/new')}>
            <PlusOutlined /> New Sale <span className="blist-cta-kbd">F3</span>
          </button>
        </div>
      </div>

      {/* KPI cards — hidden when operator turns off via Customize */}
      {cols.kpiCards && (
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
      )}

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
          // by the bill forms and common accounting software (Esc on the left, primary
          // action on the right of the button group).
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/'),
          },
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
