import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Table, Tag, Typography, message, DatePicker, Select, Tooltip,
  Modal, Descriptions, Divider, Dropdown,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, EyeOutlined, StopOutlined,
  PrinterOutlined, EditOutlined, MoreOutlined,
  DollarOutlined, BarcodeOutlined, WarningOutlined, AppstoreOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { purchaseAPI, settingsAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument } from '../../services/printer';
import BarcodePrintModal from '../../components/BarcodePrintModal';
import '../../styles/bill-list.css';

// Purchases don't carry a return amount — just items / GST / discount.
const PURCHASE_OPTIONAL_COLS = [
  { key: 'items',    label: 'Items (count · pcs)' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
];
const COLS_STORAGE_KEY = 'purchaseList_cols_v1';
const DEFAULT_COLS = { items: true, gst: false, discount: false };

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
      <td style="text-align:right">₹${parseFloat(it.purchase_rate || 0).toFixed(2)}</td>
      <td style="text-align:right">₹${(parseFloat(it.quantity || 0) * parseFloat(it.purchase_rate || 0)).toFixed(2)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Purchase Bill</title>
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
  <h2>${companyName || 'Purchase Bill'}</h2>
  <div class="title">PURCHASE BILL</div>
  <div class="meta">
    <div>
      <b>Bill No:</b> ${bill.bill_number}<br>
      <b>Date:</b> ${dayjs(bill.bill_date).format('DD-MMM-YYYY')}<br>
      ${bill.supplier_bill_number ? `<b>Supplier Bill:</b> ${bill.supplier_bill_number}<br>` : ''}
    </div>
    <div style="text-align:right">
      <b>Supplier:</b> ${bill.supplier?.party_name || ''}<br>
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
    <div>Receiver's Signature: _______________</div>
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
        <Descriptions.Item label="Supplier">{bill.supplier?.party_name}</Descriptions.Item>
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
  const [bills, setBills]           = useState([]);
  const [loading, setLoading]       = useState(false);
  const [total, setTotal]           = useState(0);
  // Date defaults to the company FY (consistent with every other
  // period selector). User can clear/override.
  const [filters, setFilters]       = useState({ search: '', payment_status: null, from_date: fyStart, to_date: fyEnd });
  const [viewBill, setViewBill]     = useState(null);
  const [barcodeModal, setBarcodeModal] = useState({ visible: false, bill: null });
  const [actionLoading, setActionLoading] = useState({});
  const [companyName, setCompanyName] = useState('');
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
      const { data } = await purchaseAPI.getAll({ ...filters, page: 1, limit: 10000 });
      setBills(data.data);
      setTotal(data.total);
    } catch (e) { message.error('Failed to load'); }
    setLoading(false);
  };

  const handleCancel = async (id) => {
    try {
      await purchaseAPI.cancel(id);
      message.success('Bill cancelled successfully');
      loadBills();
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
  // Route through unified printer service — uses user's default Purchase profile.
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

  // KPIs
  const kpis = useMemo(() => {
    const active = bills.filter(b => !b.is_cancelled);
    const totalAmount = active.reduce((s, b) => s + parseFloat(b.total_amount || 0), 0);
    const paid = active.reduce((s, b) => s + parseFloat(b.paid_amount || 0), 0);
    const outstanding = active.reduce((s, b) => s + parseFloat(b.balance_amount || 0), 0);
    const openBills = active.filter(b => parseFloat(b.balance_amount || 0) > 0.01).length;
    const avg = active.length > 0 ? totalAmount / active.length : 0;
    return { totalAmount, paid, outstanding, openBills, count: active.length, avg };
  }, [bills]);

  const paidPct = kpis.totalAmount > 0 ? (kpis.paid / kpis.totalAmount) * 100 : 0;
  const outstandingPct = kpis.totalAmount > 0 ? (kpis.outstanding / kpis.totalAmount) * 100 : 0;

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

      <div className="blist-hd">
        <div className="blist-title">
          <h1>Purchase Bills</h1>
          <div className="sub"><b>{total}</b> bills total</div>
        </div>
        <div className="blist-ctrl">
          <div className="blist-search">
            <SearchOutlined />
            <input
              type="text"
              placeholder="Search bill no or supplier"
              value={filters.search}
              onChange={(e) => setFilters(f => ({ ...f, search: e.target.value }))}
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
                <div className="mh" style={{ paddingBottom: 2 }}>Always shown</div>
                <label className="opt"><span>Bill · Date · Supplier</span><span className="pin">Pinned</span></label>
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
            <div className="v">{fmt(kpis.totalAmount)}</div>
            <div className="sub">{kpis.count} bills · avg {fmtShort(kpis.avg)}</div>
          </div>
        </div>
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Paid</div>
            <div className="v">{fmt(kpis.paid)}</div>
            <div className="sub">of {fmtShort(kpis.totalAmount)} bought</div>
          </div>
          <Ring pct={paidPct} tone="ok" />
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Outstanding</div>
            <div className="v">{fmt(kpis.outstanding)}</div>
            <div className="sub">across {kpis.openBills} open bills</div>
          </div>
          <Ring pct={outstandingPct} tone="bad" />
        </div>
      </div>

      <div className="blist-wrap">
        <div className="blist">

          <div className="brow head">
            <div className="c-sr">#</div>
            <div className="c-bill">Bill #</div>
            <div className="c-date">Date · Time</div>
            <div className="c-cust">Supplier</div>
            {cols.items    && <div className="c-items">Items</div>}
            <div className="c-total">Total</div>
            {cols.gst      && <div className="c-gst">GST</div>}
            {cols.discount && <div className="c-discount">Discount</div>}
            <div className="c-paid">Paid</div>
            <div className="c-bal">Balance</div>
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
                  key={bill.purchase_bill_id}
                  bill={bill}
                  index={i}
                  cols={cols}
                  actionLoading={!!actionLoading[bill.purchase_bill_id]}
                  onView={() => handleView(bill.purchase_bill_id)}
                  onPrint={() => handlePrint(bill.purchase_bill_id)}
                  onEdit={() => handleEdit(bill.purchase_bill_id)}
                  onCancel={() => handleCancel(bill.purchase_bill_id)}
                  onPayment={() => handleRecordPayment(bill)}
                  onBarcode={() => handleBarcode(bill.purchase_bill_id)}
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

// ── Row component ─────────────────────────────────────────────────────────────
function BillRow({ bill, index, cols, actionLoading, onView, onPrint, onEdit, onCancel, onPayment, onBarcode }) {
  const cancelled = !!bill.is_cancelled;
  const total = parseFloat(bill.total_amount || 0);
  const paid = parseFloat(bill.paid_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);

  const itemCount = bill._item_count ?? bill.items?.length ?? null;
  const pcsTotal = bill._pcs_total ?? (bill.items
    ? bill.items.reduce((s, it) => s + parseFloat(it.quantity || 0), 0)
    : null);

  const billDate = bill.bill_date ? dayjs(bill.bill_date) : null;
  const timeSource = bill.createdAt || bill.created_date || bill.bill_date;
  const billTime = timeSource ? dayjs(timeSource) : null;
  const isSameDay = billDate && billTime && billDate.isSame(billTime, 'day');

  const supplierName = bill.supplier?.party_name;
  const supplierPhone = bill.supplier?.mobile_1;

  const gstAmt = parseFloat(bill.gst_amount || 0) ||
                 (parseFloat(bill.cgst_amount || 0) + parseFloat(bill.sgst_amount || 0) + parseFloat(bill.igst_amount || 0));
  const discAmt = parseFloat(bill.discount_amount || 0);

  const openBill = !cancelled && balance > 0.01;

  // Hover cluster shows View + Barcode only. Everything else — Print, Record
  // Payment, Edit, Cancel — lives under ⋯ to keep the row calm.
  const moreMenu = {
    items: [
      ...(openBill ? [{
        key: 'payment', icon: <DollarOutlined />, label: 'Record payment',
        onClick: onPayment,
      }, { type: 'divider' }] : []),
      { key: 'print', icon: <PrinterOutlined />, label: 'Print',  onClick: onPrint },
      { key: 'edit',  icon: <EditOutlined />,    label: 'Edit',   onClick: onEdit, disabled: cancelled },
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
        <div className="stk">
          <span className="m">{supplierName || '—'}</span>
          <span className="s">{supplierPhone || (bill.supplier_bill_number ? `Supplier bill ${bill.supplier_bill_number}` : '—')}</span>
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
            <Tooltip title="Print barcodes">
              <button
                className="abtn"
                onClick={(e) => { e.stopPropagation(); onBarcode(); }}
                disabled={actionLoading || cancelled}
              >
                <BarcodeOutlined />
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
