import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Tag, Typography, message, DatePicker, Select,
  Modal, Descriptions, Divider, Dropdown, Table,
} from 'antd';
import {
  PlusOutlined, SearchOutlined,
  WarningOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { purchaseAPI, settingsAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument, exportBillPDF, shareBillViaWhatsApp } from '../../services/printer';
import BarcodePrintModal from '../../components/BarcodePrintModal';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import useListSelection from '../../hooks/useListSelection';
import VirtualReportTable from '../../components/VirtualReportTable';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../../styles/bill-list.css';

// Purchases don't carry a return amount — just items / GST / discount.
const PURCHASE_OPTIONAL_COLS = [
  { key: 'time',     label: 'Time' },
  { key: 'godown',   label: 'Godown' },
  { key: 'phone',    label: 'Phone' },
  { key: 'gstin',    label: 'GSTIN' },
  { key: 'supplierBill', label: 'Supplier bill #' },
  { key: 'items',    label: 'Items (count)' },
  { key: 'pieces',   label: 'Pieces' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
];
// Toggleable page sections (not data columns) — currently just the
// sticky bottom "Total (N bills)" strip. Default on.
const PURCHASE_SECTIONS = [
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
// v6 promotes the godown badge to its own toggleable column. Existing
// v5 users inherit `godown: true` via DEFAULT_COLS spread on first read.
const COLS_STORAGE_KEY = 'purchaseList_cols_v6';
const DEFAULT_COLS = {
  time: true, godown: true, phone: true, gstin: false, supplierBill: true,
  items: true, pieces: true,
  gst: false, discount: false,
  totalRow: true,
};

const { Text } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtShort = (v) => {
  const n = parseFloat(v || 0);
  if (n === 0) return '₹ 0';
  return `₹ ${Math.round(n).toLocaleString('en-IN')}`;
};

// ── View Modal ─────────────────────────────────────────────────────────────────
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
  const totalGst = cgst + sgst + igst;
  const discount = parseFloat(bill.discount_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);
  const roundOff = parseFloat(bill.round_off || 0);

  const itemColumns = [
    { title: '#', width: 40, render: (_, __, i) => i + 1 },
    { title: 'Product', dataIndex: 'product_name' },
    { title: 'Barcode', dataIndex: 'barcode', width: 110, render: v => <Text style={{ fontSize: 11 }}>{v}</Text> },
    { title: 'Size', dataIndex: 'size', width: 70 },
    { title: 'Qty', dataIndex: 'quantity', width: 65, align: 'right' },
    { title: 'Rate', dataIndex: 'purchase_rate', width: 90, align: 'right', render: v => `₹${parseFloat(v || 0).toFixed(2)}` },
    { title: 'Amount', width: 100, align: 'right',
      render: (_, r) => `₹${(parseFloat(r.quantity || 0) * parseFloat(r.purchase_rate || 0)).toFixed(2)}` },
  ];

  return (
    <Modal open onCancel={onClose} width={960} footer={null}
      title={<span style={{ fontWeight: 700 }}>Purchase Bill — {bill.bill_number}</span>}
      styles={{ body: { padding: '16px 24px' } }}>

      <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Bill No">{bill.bill_number}</Descriptions.Item>
        <Descriptions.Item label="Date">{dayjs(bill.bill_date).format('DD-MMM-YYYY')}</Descriptions.Item>
        <Descriptions.Item label="Supplier">{
          (() => {
            const n = bill.supplier?.party_name;
            const isCash = !n || bill.supplier?.is_system_cash;
            const w = String(bill.walk_in_name || '').trim();
            return isCash ? `Cash${w ? ` — ${w}` : ''}` : n;
          })()
        }</Descriptions.Item>
        <Descriptions.Item label="Status">
          <Tag color={bill.payment_status === 'Paid' ? 'green' : bill.payment_status === 'Partial' ? 'orange' : 'red'}>
            {bill.payment_status}
          </Tag>
        </Descriptions.Item>
        {bill.supplier_bill_number && (
          <Descriptions.Item label="Supplier Bill No" span={2}>{bill.supplier_bill_number}</Descriptions.Item>
        )}
        {bill.remarks && (<Descriptions.Item label="Remarks" span={2}>{bill.remarks}</Descriptions.Item>)}
      </Descriptions>

      <Table columns={itemColumns} dataSource={items} rowKey="purchase_bill_item_id"
        pagination={false} size="small" scroll={{ x: 600 }} />

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
          {totalGst === 0 && parseFloat(bill.gst_amount || 0) > 0 && (<SummaryRow label="GST" value={fmt(bill.gst_amount)} />)}
          {roundOff !== 0 && (<SummaryRow label="Round Off" value={roundOff.toFixed(2)} />)}
          <SummaryRow label="Total" value={fmt(bill.total_amount)} bold borderTop />
          <SummaryRow label="Paid" value={fmt(bill.paid_amount)} color="#16a34a" />
          <SummaryRow label="Balance Due" value={fmt(bill.balance_amount)}
            color={balance > 0 ? '#dc2626' : '#16a34a'} bold borderTop />
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
export default function PurchaseList() {
  const { fyStart, fyEnd } = useFinancialYear();
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState({ search: '', payment_status: null, from_date: fyStart, to_date: fyEnd });
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(f => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [viewBill, setViewBill]     = useState(null);
  const [barcodeModal, setBarcodeModal] = useState({ visible: false, bill: null });
  const [companyName, setCompanyName] = useState('');

  // Search input ref so the F4 = Find action can focus it from the strip.
  const searchInputRef = useRef(null);

  // ── Virtualized data layer ────────────────────────────────────────
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => purchaseAPI.getAll(params),
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
  // Optional columns only — sections (totalRow) excluded from the badge.
  const visibleOptionalCount = PURCHASE_OPTIONAL_COLS.filter((c) => cols[c.key]).length;

  const navigate = useNavigate();

  useEffect(() => {
    settingsAPI.getSystem().then(({ data }) => setCompanyName(data?.data?.company_name || '')).catch(() => {});
  }, []);

  const fetchBill = useCallback(async (id) => {
    try {
      const { data } = await purchaseAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load bill');
      return null;
    }
  }, []);

  const handleView  = async (id) => { const b = await fetchBill(id); if (b) setViewBill(b); };
  const handlePrint = (id) => printDocument({ docType: 'purchase', id });
  const handleEdit  = (id) => navigate(`/purchase/edit/${id}`);

  const handleBarcode = async (id) => {
    const bill = await fetchBill(id);
    if (!bill) return;
    const printItems = (bill.items || []).map(it => ({
      barcode: it.barcode, product_name: it.product_name, size: it.size,
      article_number: it.article_number, mrp: it.mrp,
      sale_rate: it.sale_rate, purchase_rate: it.purchase_rate,
      margin_percentage: it.margin_percentage,
      quantity: it.quantity, quantity_per_box: it.quantity_per_box || 1,
    }));
    setBarcodeModal({ visible: true, bill: { ...bill, printItems } });
  };

  const handleExportPDF = (bill) => exportBillPDF({ docType: 'purchase', bill });
  const handleWhatsApp  = (bill) => shareBillViaWhatsApp({ docType: 'purchase', bill });
  const handleRecordPayment = (bill) => {
    navigate('/payment/new', { state: { preselect: { party_id: bill.supplier?.party_id, bill_id: bill.purchase_bill_id } } });
  };

  // ── Selection model — cursor + multi-select.
  const sel = useListSelection({ totalCount, rows });
  const activeRow      = sel.activeRow;
  const selectedRows   = sel.selectedRows;
  const selectionCount = sel.selectionCount;
  const isMulti        = selectionCount > 1;
  const single         = !isMulti ? activeRow : null;
  const singleCancelled  = single?.is_cancelled;
  const singleHasBalance = single ? parseFloat(single.balance_amount || 0) > 0.01 : false;
  // Phone derived from supplier mobile_1, gating the WhatsApp action.
  // Mirrors SalesList.singlePhone — bare digits only; the printer service
  // strips formatting + adds country code.
  const singlePhone = (() => {
    if (!single) return null;
    const m = single.supplier?.mobile_1;
    return m && !/^TLY/i.test(m) ? m : null;
  })();

  // Bulk-cancel — confirm once, run cancellations serially, summarize at
  // the end. Avoids drowning the user in N error popups on a partial fail.
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
            await purchaseAPI.cancel(r.purchase_bill_id);
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

  // KPI values from server-aggregated `summary` so they reflect the
  // full filtered set, not just what's been scrolled into view.
  const totalAmount = parseFloat(summary?.total_amount || 0);
  const paid        = parseFloat(summary?.total_paid || 0);
  const outstanding = parseFloat(summary?.total_balance || 0);
  const openBills   = summary?.open_count || 0;
  const billCount   = summary?.count || totalCount;
  const avg         = billCount > 0 ? totalAmount / billCount : 0;
  const paidPct        = totalAmount > 0 ? (paid / totalAmount) * 100 : 0;
  const outstandingPct = totalAmount > 0 ? (outstanding / totalAmount) * 100 : 0;

  const columns = [
    {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => <span className="sr-n">{String(idx + 1).padStart(2, '0')}</span>,
    },
    {
      // Bill # cell is now pure — the godown badge moved to its own
      // toggleable column (key='godown') so it can be shown/hidden
      // via the Customize popover.
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
        const timeSource = r.createdAt || r.created_date || null;
        const t = timeSource ? dayjs(timeSource) : null;
        return t
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{t.format('h:mm a')}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    {
      // Supplier column is single-line now (just the party name). The
      // mobile / supplier-bill sub-line moved to its own optional
      // `phone` column below — toggleable via the Customize popover.
      key: 'sup', title: 'Supplier', dataIndex: ['supplier', 'party_name'], width: 200,
      render: (v, r) => {
        const isSystemCash = !!r.supplier?.is_system_cash;
        const isCash = !v || isSystemCash;
        return (
          <span className={`bill-sup${isCash ? ' cash' : ''}`}>
            {isCash ? 'Cash' : v}
          </span>
        );
      },
    },
    cols.phone && {
      // Phone column — pure mobile number from the supplier master.
      // Cash purchases without a saved phone show a dash; the walk-in
      // name (if any) lives in the View modal of the bill.
      key: 'phone', title: 'Phone', width: 130,
      render: (_, r) => {
        const m = r.supplier?.mobile_1;
        return m
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>{m}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    cols.gstin && {
      // GSTIN column — supplier's tax ID. Useful for compliance reports
      // and verifying the right business is being paid. Off by default;
      // operators turn it on when they need it on-screen.
      key: 'gstin', title: 'GSTIN', width: 160,
      render: (_, r) => {
        const g = r.supplier?.gstin;
        return g
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }}>{g}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    cols.supplierBill && {
      // Supplier's invoice number — the reference printed on the
      // physical bill the supplier handed over. Sits in its own
      // column so phone and supplier-bill don't compete for space.
      key: 'supplierBill', title: 'Supplier bill #', width: 140,
      render: (_, r) => {
        const sb = r.supplier_bill_number;
        return sb
          ? <span style={{ fontSize: 12, color: 'var(--fg-secondary)', fontVariantNumeric: 'tabular-nums' }}>{sb}</span>
          : <span style={{ color: 'var(--fg-tertiary)' }}>{'—'}</span>;
      },
    },
    cols.items && {
      // Items count only — pcs total moved to its own optional
      // `pieces` column below to keep the row single-line.
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
    // (Per-row actions column removed — all bill actions live in the
    // bottom ActionStrip and operate on the cursored / selected rows.)
  ].filter(Boolean);

  // Bottom Total strip — driven by server-aggregated `summary`. Same
  // colSpan-merge pattern as SalesList: leading non-aggregable columns
  // merge into one cell holding the "Total (N bills)" label.
  const SUMMABLE_KEYS = new Set(['total', 'paid', 'balance', 'gst', 'discount']);
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

      <div className="blist-hd">
        <div className="blist-title">
          <h1>Purchase Bills</h1>
        </div>
        <div className="blist-ctrl">
          <div className="blist-search">
            <SearchOutlined />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search bill no or supplier"
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
                {PURCHASE_OPTIONAL_COLS.map(c => (
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
                {PURCHASE_SECTIONS.map(s => (
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
                <label className="opt"><span>Bill · Date · Supplier</span><span className="pin">Pinned</span></label>
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
          <button className="blist-cta ghost" onClick={() => navigate('/payment/new')}>
            <PlusOutlined /> Payment
          </button>
          <button className="blist-cta" onClick={() => navigate('/purchase/new')}>
            <PlusOutlined /> New Purchase
          </button>
        </div>
      </div>

      <div className="blist-kpi">
        <div className="kpi-card total">
          <div className="kpi-text">
            <div className="k">Total Purchase · This View</div>
            <div className="v">{fmt(totalAmount)}</div>
            <div className="sub">{billCount} bills · avg {fmtShort(avg)}</div>
          </div>
        </div>
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Paid</div>
            <div className="v">{fmt(paid)}</div>
            <div className="sub">of {fmtShort(totalAmount)} bought</div>
          </div>
          <Ring pct={paidPct} tone="ok" />
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Outstanding</div>
            <div className="v">{fmt(outstanding)}</div>
            <div className="sub">across {openBills} open bills</div>
          </div>
          <Ring pct={outstandingPct} tone="bad" />
        </div>
      </div>

      <div className="blist-wrap">
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="purchase_bill_id"
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
            onDoubleClick: () => record?.purchase_bill_id && handleView(record.purchase_bill_id),
          })}
        />
      </div>

      {/* ── Bottom action strip — same layout as Sales List with
          purchase-specific tweaks: F6 = record Payment (money out),
          F7 = print Barcode labels (purchase-only), no WhatsApp.
          Strip handlers act on the cursored row (single) or the
          selected set (multi). */}
      <ActionStrip
        info={isMulti ? `${selectionCount} selected` : null}
        actions={[
          // Visual order matches the bill forms / SalesList: utility
          // and content keys on the left, destructive F8 + primary F1
          // on the right.
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: isMulti || !single || singleCancelled,
            onAction: () => single && handleEdit(single.purchase_bill_id),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: () => navigate('/purchase/new'),
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
            id: 'payment', key: 'F6', label: 'Payment',
            disabled: isMulti || !single || singleCancelled || !singleHasBalance,
            onAction: () => single && handleRecordPayment(single),
          },
          {
            id: 'barcodes', key: 'F7', label: 'Barcodes',
            disabled: isMulti || !single || singleCancelled,
            onAction: () => single && handleBarcode(single.purchase_bill_id),
            title: 'Print barcode labels for items in this bill',
          },
          {
            id: 'print', key: 'F9', label: 'Print',
            disabled: isMulti || !single,
            onAction: () => single && handlePrint(single.purchase_bill_id),
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
            title: 'Share this purchase bill PDF with the supplier',
          },
          {
            id: 'cancel', key: 'F8', label: 'Cancel', tone: 'danger',
            disabled: !activeRow,
            onAction: () => handleBulkCancel(isMulti ? selectedRows : [single]),
          },
          {
            id: 'open', key: 'F1', label: 'Open', tone: 'primary',
            disabled: isMulti || !single,
            onAction: () => single && handleView(single.purchase_bill_id),
          },
        ]}
      />

      <ViewModal bill={viewBill} onClose={() => setViewBill(null)} />

      <BarcodePrintModal
        visible={barcodeModal.visible}
        onClose={() => setBarcodeModal({ visible: false, bill: null })}
        billNumber={barcodeModal.bill?.bill_number}
        items={barcodeModal.bill?.printItems || []}
        initialCompany={companyName}
      />
    </div>
  );
}
