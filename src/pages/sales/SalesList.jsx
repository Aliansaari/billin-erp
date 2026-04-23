import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Table, Tag, Typography, message, DatePicker, Select, Tooltip,
  Modal, Descriptions, Divider, Dropdown,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, EyeOutlined, StopOutlined,
  PrinterOutlined, EditOutlined, MoreOutlined,
  DollarOutlined, CopyOutlined, AppstoreOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesAPI, settingsAPI } from '../../api';
import { printDocument } from '../../services/printer';
import '../../styles/bill-list.css';

// Optional columns the user can toggle via the Columns picker. Keys match
// the state shape persisted to localStorage.
const SALES_OPTIONAL_COLS = [
  { key: 'items',    label: 'Items (count · pcs)' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
  { key: 'return',   label: 'Return amount' },
];
const COLS_STORAGE_KEY = 'salesList_cols_v1';
const DEFAULT_COLS = { items: true, gst: false, discount: false, return: false };

const { Text } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtShort = (v) => {
  const n = parseFloat(v || 0);
  if (n === 0) return '₹ 0';
  return `₹ ${Math.round(n).toLocaleString('en-IN')}`;
};

// ── Invoice printer (iframe) ───────────────────────────────────────────────────
function printBill(bill, companyName) {
  const items = bill.items || [];
  const rows = items.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${it.product_name || ''}</td>
      <td>${it.barcode || ''}</td>
      <td>${it.size || ''}</td>
      <td style="text-align:right">${parseFloat(it.quantity || 0)}</td>
      <td style="text-align:right">₹${parseFloat(it.sale_rate || 0).toFixed(2)}</td>
      <td style="text-align:right">₹${(parseFloat(it.quantity || 0) * parseFloat(it.sale_rate || 0)).toFixed(2)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Bill</title>
<style>
  @page{margin:12mm}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:12px;color:#111}
  h2{font-size:18px;text-align:center;margin-bottom:2px}
  .title{text-align:center;font-size:14px;font-weight:700;letter-spacing:1px;
    border-top:2px solid #000;border-bottom:2px solid #000;padding:4px 0;margin:8px 0}
  .meta{display:flex;justify-content:space-between;margin-bottom:10px}
  .meta div{line-height:1.8}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{background:#f3f4f6;padding:5px 6px;border:1px solid #ddd;font-size:11px;text-align:left}
  td{padding:4px 6px;border:1px solid #ddd;font-size:11px}
  .totals{margin-top:12px;display:flex;justify-content:flex-end}
  .totals table{width:220px}
  .totals td{border:none;padding:2px 6px}
  .totals .grand{font-weight:700;font-size:13px;border-top:2px solid #000}
  .footer{margin-top:24px;display:flex;justify-content:space-between;font-size:11px}
</style></head>
<body>
  <h2>${companyName || 'Sales Bill'}</h2>
  <div class="title">SALES BILL / INVOICE</div>
  <div class="meta">
    <div>
      <b>Bill No:</b> ${bill.bill_number}<br>
      <b>Date:</b> ${dayjs(bill.bill_date).format('DD-MMM-YYYY')}<br>
    </div>
    <div style="text-align:right">
      <b>Customer:</b> ${bill.customer?.party_name || 'Cash Sale'}<br>
      <b>Status:</b> ${bill.payment_status}<br>
    </div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Product</th><th>Barcode</th><th>Size</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals"><table>
    <tr><td>Sub Total</td><td style="text-align:right">${fmt(bill.sub_total)}</td></tr>
    ${bill.discount_amount > 0 ? `<tr><td>Discount</td><td style="text-align:right">- ${fmt(bill.discount_amount)}</td></tr>` : ''}
    ${bill.gst_amount > 0 ? `<tr><td>GST</td><td style="text-align:right">${fmt(bill.gst_amount)}</td></tr>` : ''}
    ${bill.round_off ? `<tr><td>Round Off</td><td style="text-align:right">${parseFloat(bill.round_off).toFixed(2)}</td></tr>` : ''}
    <tr class="grand"><td>Total</td><td style="text-align:right">${fmt(bill.total_amount)}</td></tr>
    <tr><td>Paid</td><td style="text-align:right">${fmt(bill.paid_amount)}</td></tr>
    <tr><td><b>Balance</b></td><td style="text-align:right"><b>${fmt(bill.balance_amount)}</b></td></tr>
  </table></div>
  <div class="footer">
    <div>Customer Signature: _______________</div>
    <div>Authorised Signature: _______________</div>
  </div>
</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;border:none;visibility:hidden;';
  document.body.appendChild(iframe);
  iframe.contentDocument.open();
  iframe.contentDocument.write(html);
  iframe.contentDocument.close();
  setTimeout(() => {
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (_) {}
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }, 400);
}

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
  const returnAmt = parseFloat(bill.return_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);
  const roundOff = parseFloat(bill.round_off || 0);

  const itemColumns = [
    { title: '#', width: 40, render: (_, __, i) => i + 1 },
    { title: 'Product', dataIndex: 'product_name' },
    { title: 'Barcode', dataIndex: 'barcode', width: 110, render: v => <Text style={{ fontSize: 11 }}>{v}</Text> },
    { title: 'Size', dataIndex: 'size', width: 70 },
    { title: 'Qty', dataIndex: 'quantity', width: 65, align: 'right' },
    { title: 'Rate', dataIndex: 'sale_rate', width: 90, align: 'right',
      render: v => `₹${parseFloat(v || 0).toFixed(2)}` },
    { title: 'Amount', width: 100, align: 'right',
      render: (_, r) => `₹${(parseFloat(r.quantity || 0) * parseFloat(r.sale_rate || 0)).toFixed(2)}` },
  ];

  return (
    <Modal open onCancel={onClose} width={960} footer={null}
      title={<span style={{ fontWeight: 700 }}>Sales Bill — {bill.bill_number}</span>}
      styles={{ body: { padding: '16px 24px' } }}>

      <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Bill No">{bill.bill_number}</Descriptions.Item>
        <Descriptions.Item label="Date">{dayjs(bill.bill_date).format('DD-MMM-YYYY')}</Descriptions.Item>
        <Descriptions.Item label="Customer">{bill.customer?.party_name || 'Cash Sale'}</Descriptions.Item>
        <Descriptions.Item label="Status">
          <Tag color={bill.payment_status === 'Paid' ? 'green' : bill.payment_status === 'Partial' ? 'orange' : 'red'}>
            {bill.payment_status}
          </Tag>
        </Descriptions.Item>
        {bill.payment_method && (
          <Descriptions.Item label="Payment Method">{bill.payment_method}</Descriptions.Item>
        )}
        {bill.remarks && (
          <Descriptions.Item label="Remarks" span={bill.payment_method ? 1 : 2}>{bill.remarks}</Descriptions.Item>
        )}
      </Descriptions>

      <Table columns={itemColumns} dataSource={items} rowKey="sales_bill_item_id"
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
  const [bills, setBills]           = useState([]);
  const [loading, setLoading]       = useState(false);
  const [total, setTotal]           = useState(0);
  const [filters, setFilters]       = useState({ search: '', payment_status: null, from_date: null, to_date: null });
  const [viewBill, setViewBill]     = useState(null);
  const [actionLoading, setActionLoading] = useState({});
  const [companyName, setCompanyName] = useState('');
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
  const visibleOptionalCount = Object.values(cols).filter(Boolean).length;

  const navigate = useNavigate();

  useEffect(() => {
    loadBills();
    settingsAPI.getSystem().then(({ data }) => setCompanyName(data?.data?.company_name || '')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const loadBills = async () => {
    setLoading(true);
    try {
      const { data } = await salesAPI.getAll({ ...filters, page: 1, limit: 10000 });
      setBills(data.data);
      setTotal(data.total);
    } catch (e) { message.error('Failed to load'); }
    setLoading(false);
  };

  const handleCancel = async (id) => {
    try {
      await salesAPI.cancel(id);
      message.success('Bill cancelled');
      loadBills();
    } catch (e) {
      const reason = e.response?.data?.error || 'Failed to cancel bill';
      const isReceiptBlock = reason.toLowerCase().includes('receipt');
      const tip = isReceiptBlock
        ? '💡 Go to Receipts, find the listed receipt(s) and cancel them. Then come back to cancel this bill.'
        : '💡 To reverse this sale, consider creating a Sales Return to keep your ledger accurate.';
      Modal.error({
        title: 'Cannot Cancel Bill', icon: null, width: 500,
        content: (
          <div style={{ paddingTop: 8 }}>
            <div style={{ background:'#fef2f2', border:'1px solid #fca5a5', borderRadius:8, padding:'12px 16px', marginBottom:12, color:'#7f1d1d', fontSize:13, lineHeight:1.6 }}>{reason}</div>
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
      const { data } = await salesAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load bill');
      return null;
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: false }));
    }
  }, []);

  const handleView  = async (id) => { const b = await fetchBill(id); if (b) setViewBill(b); };
  // Route through the new unified printer service so the user-configured
  // default profile for Sales Invoice (Settings → Print Settings) is used.
  // Falls back to a built-in A4 template on a fresh install.
  const handlePrint = (id) => printDocument({ docType: 'sales', id });
  const handleEdit  = (id) => navigate(`/sale/edit/${id}`);
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

  // ── KPI computation (excludes cancelled bills) ──
  const kpis = useMemo(() => {
    const active = bills.filter(b => !b.is_cancelled);
    const totalAmount = active.reduce((s, b) => s + parseFloat(b.total_amount || 0), 0);
    const received = active.reduce((s, b) => s + parseFloat(b.paid_amount || 0), 0);
    const outstanding = active.reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0);
    const openBills = active.filter(b => parseFloat(b.balance_amount || 0) > 0.01).length;
    const avg = active.length > 0 ? totalAmount / active.length : 0;
    return { totalAmount, received, outstanding, openBills, count: active.length, avg };
  }, [bills]);

  const receivedPct = kpis.totalAmount > 0 ? (kpis.received / kpis.totalAmount) * 100 : 0;
  const outstandingPct = kpis.totalAmount > 0 ? (kpis.outstanding / kpis.totalAmount) * 100 : 0;

  // ── Page totals (what's currently shown after filters) ──
  const pageTotals = useMemo(() => {
    const active = bills.filter(b => !b.is_cancelled);
    return {
      total: active.reduce((s, b) => s + parseFloat(b.total_amount || 0), 0),
      paid:  active.reduce((s, b) => s + parseFloat(b.paid_amount  || 0), 0),
      bal:   active.reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0),
    };
  }, [bills]);

  return (
    <div className="blist-page">

      {/* Top bar — title + search + date + status + CTAs */}
      <div className="blist-hd">
        <div className="blist-title">
          <h1>Sales Bills</h1>
          <div className="sub"><b>{total}</b> bills total</div>
        </div>
        <div className="blist-ctrl">
          <div className="blist-search">
            <SearchOutlined />
            <input
              type="text"
              placeholder="Search bill no or customer"
              value={filters.search}
              onChange={(e) => setFilters(f => ({ ...f, search: e.target.value }))}
            />
          </div>
          <DatePicker.RangePicker
            size="middle" format="DD MMM"
            placeholder={['From', 'To']}
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
                <div className="mh" style={{ paddingBottom: 2 }}>Always shown</div>
                <label className="opt"><span>Bill · Date · Customer</span><span className="pin">Pinned</span></label>
                <label className="opt"><span>Total · Paid · Balance</span><span className="pin">Pinned</span></label>
              </div>
            )}
          >
            <button className={`blist-chip${visibleOptionalCount > 0 ? ' on' : ''}`}>
              <AppstoreOutlined /> Columns
              {visibleOptionalCount > 0 && <span className="col-count">{visibleOptionalCount}</span>}
            </button>
          </Dropdown>
          <span className="blist-divider"></span>
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
            <div className="v">{fmt(kpis.totalAmount)}</div>
            <div className="sub">{kpis.count} bills · avg {fmtShort(kpis.avg)}</div>
          </div>
        </div>
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Received</div>
            <div className="v">{fmt(kpis.received)}</div>
            <div className="sub">of {fmtShort(kpis.totalAmount)} sold</div>
          </div>
          <Ring pct={receivedPct} tone="ok" />
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Outstanding</div>
            <div className="v">{fmt(kpis.outstanding)}</div>
            <div className="sub">from {kpis.openBills} open bills</div>
          </div>
          <Ring pct={outstandingPct} tone="bad" />
        </div>
      </div>

      {/* Bill list — fixed chrome, internal scroll */}
      <div className="blist-wrap">
        <div className="blist">

          <div className="brow head">
            <div className="c-sr">#</div>
            <div className="c-bill">Bill #</div>
            <div className="c-date">Date · Time</div>
            <div className="c-cust">Customer</div>
            {cols.items    && <div className="c-items">Items</div>}
            <div className="c-total">Total</div>
            {cols.gst      && <div className="c-gst">GST</div>}
            {cols.discount && <div className="c-discount">Discount</div>}
            <div className="c-paid">Paid</div>
            <div className="c-bal">Balance</div>
            {cols.return   && <div className="c-return">Return</div>}
            <div className="c-act"></div>
          </div>

          <div className="bscroll">
            {loading ? (
              <div className="brow empty">Loading bills…</div>
            ) : bills.length === 0 ? (
              <div className="brow empty">No bills match the current filters.</div>
            ) : (
              bills.map((bill, i) => (
                <BillRow
                  key={bill.sales_bill_id}
                  bill={bill}
                  index={i}
                  cols={cols}
                  actionLoading={!!actionLoading[bill.sales_bill_id]}
                  onView={() => handleView(bill.sales_bill_id)}
                  onPrint={() => handlePrint(bill.sales_bill_id)}
                  onEdit={() => handleEdit(bill.sales_bill_id)}
                  onCancel={() => handleCancel(bill.sales_bill_id)}
                  onReceipt={() => handleRecordReceipt(bill)}
                />
              ))
            )}
          </div>

          <div className="bfoot">
            <span>Shown: <b>{bills.length} of {total}</b></span>
            <span>Page total: <b>{fmt(pageTotals.total)}</b></span>
            <span>Paid: <b style={{ color: 'var(--success)' }}>{fmt(pageTotals.paid)}</b></span>
            <span>Balance: <b style={{ color: 'var(--danger)' }}>{fmt(pageTotals.bal)}</b></span>
          </div>
        </div>
      </div>

      <ViewModal bill={viewBill} onClose={() => setViewBill(null)} />
    </div>
  );
}

// ── Row component ─────────────────────────────────────────────────────────────
function BillRow({ bill, index, cols, actionLoading, onView, onPrint, onEdit, onCancel, onReceipt }) {
  const cancelled = !!bill.is_cancelled;
  const total = parseFloat(bill.total_amount || 0);
  const paid = parseFloat(bill.paid_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);

  // Item count + total pieces come pre-computed from the list endpoint
  // (_item_count / _pcs_total). Fall back to counting loaded items if
  // the bill object happens to have them (e.g. after a detail fetch).
  const itemCount = bill._item_count ?? bill.items?.length ?? null;
  const pcsTotal = bill._pcs_total ?? (bill.items
    ? bill.items.reduce((s, it) => s + parseFloat(it.quantity || 0), 0)
    : null);

  const billDate = bill.bill_date ? dayjs(bill.bill_date) : null;
  const timeSource = bill.createdAt || bill.created_date || bill.bill_date;
  const billTime = timeSource ? dayjs(timeSource) : null;
  const isSameDay = billDate && billTime && billDate.isSame(billTime, 'day');

  const customerName = bill.customer?.party_name;
  const customerPhone = bill.customer?.mobile_1;
  const isCash = !customerName;

  // Optional amounts
  const gstAmt = parseFloat(bill.gst_amount || 0) ||
                 (parseFloat(bill.cgst_amount || 0) + parseFloat(bill.sgst_amount || 0) + parseFloat(bill.igst_amount || 0));
  const discAmt = parseFloat(bill.discount_amount || 0);
  const retAmt = parseFloat(bill.return_amount || 0);

  const openBill = !cancelled && balance > 0.01;

  // Menu items — the longer-tail actions live here. Record Receipt is in
  // this menu (no longer the primary hover button) so the row's hover
  // cluster stays quiet: just View + Print.
  const moreMenu = {
    items: [
      ...(openBill ? [{
        key: 'receipt', icon: <DollarOutlined />, label: 'Record receipt',
        onClick: onReceipt,
      }, { type: 'divider' }] : []),
      { key: 'edit',  icon: <EditOutlined />,    label: 'Edit',   onClick: onEdit, disabled: cancelled },
      { key: 'dup',   icon: <CopyOutlined />,    label: 'Duplicate to new sale', onClick: onEdit, disabled: cancelled },
      { type: 'divider' },
      {
        key: 'cancel',
        icon: <StopOutlined />,
        label: cancelled ? 'Already cancelled' : 'Cancel bill',
        danger: true, disabled: cancelled,
        onClick: () => {
          Modal.confirm({
            title: `Cancel bill ${bill.bill_number}?`,
            content: 'Cancelling is permanent. Stock and ledger entries will be reversed.',
            okText: 'Cancel this bill', okButtonProps: { danger: true },
            cancelText: 'Keep it',
            onOk: onCancel,
          });
        },
      },
    ],
  };

  return (
    <div className={`brow data${cancelled ? ' cancelled' : ''}`}>
      <div className="c-sr"><span className="sr-n">{String(index + 1).padStart(2, '0')}</span></div>
      <div className="c-bill"><span className="bill-no">{bill.bill_number}</span></div>

      <div className="c-date">
        <div className="stk">
          <span className="m">{billDate ? billDate.format('DD MMM YYYY') : '—'}</span>
          {billTime && isSameDay
            ? <span className="s">{billTime.format('h:mm a')}</span>
            : <span className="s">&nbsp;</span>}
        </div>
      </div>

      <div className="c-cust">
        <div className={`stk${isCash ? ' cash' : ''}`}>
          <span className="m">{customerName || 'Cash Sale'}</span>
          <span className="s">{customerPhone || (isCash ? 'Walk-in' : '—')}</span>
        </div>
      </div>

      {cols.items && (
        <div className="c-items">
          <div className="stk">
            <span className="m">{itemCount != null ? itemCount : '—'}</span>
            <span className="s">{pcsTotal != null ? `${pcsTotal} pcs` : '\u00A0'}</span>
          </div>
        </div>
      )}

      <div className="c-total">
        <span className={`amt${cancelled ? ' muted' : ''}`}>
          <span className="rs">₹</span>{Math.round(total).toLocaleString('en-IN')}
        </span>
      </div>

      {cols.gst && (
        <div className="c-gst">
          {gstAmt > 0.01
            ? <span className="amt"><span className="rs">₹</span>{Math.round(gstAmt).toLocaleString('en-IN')}</span>
            : <span className="amt zero">—</span>}
        </div>
      )}

      {cols.discount && (
        <div className="c-discount">
          {discAmt > 0.01
            ? <span className="amt"><span className="rs">₹</span>{Math.round(discAmt).toLocaleString('en-IN')}</span>
            : <span className="amt zero">—</span>}
        </div>
      )}

      <div className="c-paid">
        {paid > 0.01 ? (
          <span className="amt paid"><span className="rs">₹</span>{Math.round(paid).toLocaleString('en-IN')}</span>
        ) : (
          <span className="amt zero">—</span>
        )}
      </div>

      <div className="c-bal">
        {cancelled ? (
          <span className="voided-tag">Voided</span>
        ) : balance < 0.01 ? (
          <span className="settled-tag">Settled</span>
        ) : (
          <span className="amt due"><span className="rs">₹</span>{Math.round(balance).toLocaleString('en-IN')}</span>
        )}
      </div>

      {cols.return && (
        <div className="c-return">
          {retAmt > 0.01
            ? <span className="amt"><span className="rs">₹</span>{Math.round(retAmt).toLocaleString('en-IN')}</span>
            : <span className="amt zero">—</span>}
        </div>
      )}

      <div className="c-act">
        <div className="act-box">
          <div className="group">
            <Tooltip title="View">
              <button
                className="abtn"
                onClick={(e) => { e.stopPropagation(); onView(); }}
                disabled={actionLoading}
              >
                <EyeOutlined />
              </button>
            </Tooltip>
            <Tooltip title="Print">
              <button
                className="abtn"
                onClick={(e) => { e.stopPropagation(); onPrint(); }}
                disabled={actionLoading}
              >
                <PrinterOutlined />
              </button>
            </Tooltip>
            <Dropdown menu={moreMenu} trigger={['click']} placement="bottomRight">
              <button
                className="abtn"
                onClick={(e) => e.stopPropagation()}
                disabled={actionLoading}
              >
                <MoreOutlined />
              </button>
            </Dropdown>
          </div>
        </div>
      </div>
    </div>
  );
}
