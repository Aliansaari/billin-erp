import React, { useEffect, useState, useCallback } from 'react';
import {
  Tag, Typography, message, DatePicker, Select, Tooltip,
  Modal, Descriptions, Divider, Dropdown, Table,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, EyeOutlined, StopOutlined,
  PrinterOutlined, EditOutlined, MoreOutlined,
  DollarOutlined, BarcodeOutlined, WarningOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { purchaseAPI, settingsAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument } from '../../services/printer';
import BarcodePrintModal from '../../components/BarcodePrintModal';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';
import '../../styles/bill-list.css';

// Purchases don't carry a return amount — just items / GST / discount.
const PURCHASE_OPTIONAL_COLS = [
  { key: 'time',     label: 'Time' },
  { key: 'items',    label: 'Items (count · pcs)' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
];
// Toggleable page sections (not data columns) — currently just the
// sticky bottom "Total (N bills)" strip. Default on.
const PURCHASE_SECTIONS = [
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
// v3 introduces the `totalRow` section toggle.
const COLS_STORAGE_KEY = 'purchaseList_cols_v3';
const DEFAULT_COLS = {
  time: true, items: true, gst: false, discount: false,
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
  const [actionLoading, setActionLoading] = useState({});
  const [companyName, setCompanyName] = useState('');

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

  const handleCancel = async (id) => {
    try {
      await purchaseAPI.cancel(id);
      message.success('Bill cancelled successfully');
      refresh();
    } catch (e) {
      const reason = e.response?.data?.error || 'Failed to cancel bill';
      const isPaymentBlock = reason.toLowerCase().includes('payment');
      const tip = isPaymentBlock
        ? '💡 Go to Payments, find the listed payment(s) and cancel them. Then come back to cancel this bill.'
        : '💡 To reverse this purchase, create a Purchase Return instead. This keeps your stock and ledger accurate.';
      Modal.error({
        title: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <WarningOutlined style={{ color: '#ef4444', fontSize: 20 }} />
            <span style={{ color: '#ef4444', fontWeight: 700 }}>Cannot Cancel Bill</span>
          </div>
        ),
        icon: null, width: 480,
        content: (
          <div style={{ marginTop: 8 }}>
            <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:8, padding:'12px 16px', marginBottom:12 }}>
              <div style={{ fontSize:13, color:'#7f1d1d', lineHeight:1.6 }}>{reason}</div>
            </div>
            <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:'10px 14px', fontSize:12, color:'#1e40af', lineHeight:1.6 }}>{tip}</div>
          </div>
        ),
        okText: 'Got it', okButtonProps: { danger: true },
      });
    }
  };

  const fetchBill = useCallback(async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: true }));
    try {
      const { data } = await purchaseAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load bill');
      return null;
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: false }));
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
      quantity: it.quantity, quantity_per_box: it.quantity_per_box || 1,
    }));
    setBarcodeModal({ visible: true, bill: { ...bill, printItems } });
  };

  const handleRecordPayment = (bill) => {
    navigate('/payment/new', { state: { preselect: { party_id: bill.supplier?.party_id, bill_id: bill.purchase_bill_id } } });
  };

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
      key: 'bill', title: 'Bill #', dataIndex: 'bill_number', width: 130,
      render: (v, r) => (
        <span className="bill-no">
          {v}
          {r.godown && (
            <span title={`Godown: ${r.godown.name}`} style={{
              marginLeft: 6, padding: '1px 5px', fontSize: 10, fontWeight: 600,
              border: '1px solid var(--border, #e5e7eb)', borderRadius: 4,
              color: 'var(--fg-secondary, #6b7280)', background: 'var(--bg-subtle, #f9fafb)',
              fontFamily: 'var(--font-mono, monospace)', verticalAlign: 'middle',
            }}>{r.godown.code}</span>
          )}
        </span>
      ),
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
      key: 'sup', title: 'Supplier', dataIndex: ['supplier', 'party_name'], width: 220,
      render: (v, r) => {
        const isSystemCash = !!r.supplier?.is_system_cash;
        const isCash = !v || isSystemCash;
        const walkInName = String(r.walk_in_name || '').trim();
        const rawPhone = r.supplier?.mobile_1;
        const supplierPhone = isCash ? null : rawPhone;
        const secondary = isCash
          ? (walkInName || (r.supplier_bill_number ? `Supplier bill ${r.supplier_bill_number}` : 'Walk-in'))
          : (supplierPhone || (r.supplier_bill_number ? `Supplier bill ${r.supplier_bill_number}` : null));
        return (
          <div className={`stk${isCash ? ' cash' : ''}`}>
            <span className="m">{isCash ? 'Cash' : v}</span>
            <span className="s">{secondary || '—'}</span>
          </div>
        );
      },
    },
    cols.items && {
      key: 'items', title: 'Items', width: 90, align: 'right',
      render: (_, r) => {
        const itemCount = r._item_count ?? r.items?.length ?? null;
        const pcsTotal = r._pcs_total ?? (r.items ? r.items.reduce((s, it) => s + parseFloat(it.quantity || 0), 0) : null);
        return (
          <div className="stk">
            <span className="m">{itemCount != null ? itemCount : '—'}</span>
            <span className="s">{pcsTotal != null ? `${pcsTotal} pcs` : ' '}</span>
          </div>
        );
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
    {
      key: 'actions', title: '', width: 130, align: 'center', fixed: 'right',
      render: (_, r) => {
        const cancelled = !!r.is_cancelled;
        const balance = parseFloat(r.balance_amount || 0);
        const openBill = !cancelled && balance > 0.01;
        const moreMenu = {
          items: [
            ...(openBill ? [{
              key: 'payment', icon: <DollarOutlined />, label: 'Record payment',
              onClick: () => handleRecordPayment(r),
            }, { type: 'divider' }] : []),
            { key: 'print', icon: <PrinterOutlined />, label: 'Print', onClick: () => handlePrint(r.purchase_bill_id) },
            { key: 'edit',  icon: <EditOutlined />,    label: 'Edit',  onClick: () => handleEdit(r.purchase_bill_id), disabled: cancelled },
            { type: 'divider' },
            {
              key: 'cancel', icon: <StopOutlined />,
              label: cancelled ? 'Already cancelled' : 'Cancel bill',
              danger: true, disabled: cancelled,
              onClick: () => {
                Modal.confirm({
                  title: `Cancel bill ${r.bill_number}?`,
                  content: 'Cancelling is permanent. Stock and ledger entries will be reversed.',
                  okText: 'Cancel this bill', okButtonProps: { danger: true },
                  cancelText: 'Keep it',
                  onOk: () => handleCancel(r.purchase_bill_id),
                });
              },
            },
          ],
        };
        const isLoading = !!actionLoading[r.purchase_bill_id];
        // Override the legacy `.act-box .group { opacity:0 }` hover-reveal —
        // it depended on `.brow.data:hover` which no longer matches inside
        // an Antd table cell. Actions are always visible in this layout.
        const groupStyle = { justifyContent: 'center', opacity: 1, transform: 'none', pointerEvents: 'auto' };
        return (
          <div className="act-box">
            <div className="group" style={groupStyle}>
              <Tooltip title="View">
                <button className="abtn" onClick={(e) => { e.stopPropagation(); handleView(r.purchase_bill_id); }} disabled={isLoading}>
                  <EyeOutlined />
                </button>
              </Tooltip>
              <Tooltip title="Print barcodes">
                <button className="abtn" onClick={(e) => { e.stopPropagation(); handleBarcode(r.purchase_bill_id); }} disabled={isLoading || cancelled}>
                  <BarcodeOutlined />
                </button>
              </Tooltip>
              <Dropdown menu={moreMenu} trigger={['click']} placement="bottomRight">
                <button className="abtn" onClick={(e) => e.stopPropagation()} disabled={isLoading}>
                  <MoreOutlined />
                </button>
              </Dropdown>
            </div>
          </div>
        );
      },
    },
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
          <div className="sub"><b>{totalCount}</b> bills total</div>
        </div>
        <div className="blist-ctrl">
          <div className="blist-search">
            <SearchOutlined />
            <input
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
        />
      </div>

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
