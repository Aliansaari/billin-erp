import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Table, Tag, Typography, message, DatePicker, Select, Tooltip,
  Modal, Descriptions, Divider, Dropdown,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, EyeOutlined, StopOutlined,
  PrinterOutlined, EditOutlined, MoreOutlined,
  CopyOutlined, AppstoreOutlined, FileTextOutlined, LinkOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { salesReturnAPI, settingsAPI } from '../../api';
import { useFinancialYear } from '../../hooks/useFinancialYear';
import { printDocument } from '../../services/printer';
import '../../styles/bill-list.css';
import './return-list.css';

/* ════════════════════════════════════════════════════════════════════════════
 *  SalesReturnList — editorial view matching SalesList / PurchaseList exactly,
 *  with return semantics substituted throughout:
 *
 *    · bill_number        → return_number (SR-xxxx)
 *    · payment_status     → refund_status (Refunded / Partial / Pending)
 *    · paid_amount        → refund_amount (cash paid back to customer)
 *    · balance_amount     → credit still owed to the customer
 *    · total_amount       → credit note value (we owe this to the customer)
 *
 *  KPI cards reframe "Received" → "Refunded" (ring = pct paid back) and
 *  "Outstanding" → "Credit pending" (ring = pct still owed to customers).
 *
 *  Reuses bill-list.css unchanged so theme tokens (light/dark · editorial
 *  warm/classic) stay consistent across every list page. return-list.css
 *  adds only the delta classes (mode pill, ref/reason columns).
 * ═══════════════════════════════════════════════════════════════════════════ */

const OPTIONAL_COLS = [
  { key: 'ref',      label: 'Reference bill' },
  { key: 'mode',     label: 'Return mode' },
  { key: 'reason',   label: 'Reason' },
  { key: 'gst',      label: 'GST amount' },
  { key: 'discount', label: 'Discount' },
];
const COLS_STORAGE_KEY = 'salesReturnList_cols_v1';
const DEFAULT_COLS = { ref: true, mode: true, reason: false, gst: false, discount: false };

const { Text } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtShort = (v) => {
  const n = parseFloat(v || 0);
  if (n === 0) return '₹ 0';
  return `₹ ${Math.round(n).toLocaleString('en-IN')}`;
};

// ── Credit note printer (iframe) ───────────────────────────────────────────────
function printReturn(bill, companyName) {
  const items = bill.items || [];
  const rows = items.map((it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${it.product_name || ''}</td>
      <td>${it.barcode || ''}</td>
      <td>${it.size || ''}</td>
      <td style="text-align:right">${parseFloat(it.quantity || 0)}</td>
      <td style="text-align:right">₹${parseFloat(it.rate || 0).toFixed(2)}</td>
      <td style="text-align:right">₹${parseFloat(it.total_amount || 0).toFixed(2)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Return</title>
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
  .totals table{width:240px}
  .totals td{border:none;padding:2px 6px}
  .totals .grand{font-weight:700;font-size:13px;border-top:2px solid #000}
  .footer{margin-top:24px;display:flex;justify-content:space-between;font-size:11px}
</style></head>
<body>
  <h2>${companyName || 'Sales Return'}</h2>
  <div class="title">SALES RETURN · CREDIT NOTE</div>
  <div class="meta">
    <div>
      <b>Return No:</b> ${bill.return_number}<br>
      <b>Date:</b> ${dayjs(bill.return_date).format('DD-MMM-YYYY')}<br>
      ${bill.reference_bill_number ? `<b>Against Bill:</b> ${bill.reference_bill_number}<br>` : ''}
    </div>
    <div style="text-align:right">
      <b>Customer:</b> ${bill.customer?.party_name || '—'}<br>
      <b>Status:</b> ${bill.refund_status}<br>
      <b>Mode:</b> ${bill.return_mode}<br>
    </div>
  </div>
  ${bill.return_mode === 'Amount' ? '' : `<table>
    <thead><tr><th>#</th><th>Product</th><th>Barcode</th><th>Size</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
  <div class="totals"><table>
    <tr><td>Sub Total</td><td style="text-align:right">${fmt(bill.sub_total)}</td></tr>
    ${bill.discount_amount > 0 ? `<tr><td>Discount</td><td style="text-align:right">- ${fmt(bill.discount_amount)}</td></tr>` : ''}
    ${parseFloat(bill.cgst_amount||0) > 0 ? `<tr><td>CGST</td><td style="text-align:right">${fmt(bill.cgst_amount)}</td></tr>` : ''}
    ${parseFloat(bill.sgst_amount||0) > 0 ? `<tr><td>SGST</td><td style="text-align:right">${fmt(bill.sgst_amount)}</td></tr>` : ''}
    ${parseFloat(bill.igst_amount||0) > 0 ? `<tr><td>IGST</td><td style="text-align:right">${fmt(bill.igst_amount)}</td></tr>` : ''}
    ${parseFloat(bill.round_off||0) !== 0 ? `<tr><td>Round Off</td><td style="text-align:right">${parseFloat(bill.round_off).toFixed(2)}</td></tr>` : ''}
    <tr class="grand"><td>Credit Total</td><td style="text-align:right">${fmt(bill.total_amount)}</td></tr>
    <tr><td>Refunded</td><td style="text-align:right">${fmt(bill.refund_amount)}</td></tr>
    <tr><td><b>Credit Pending</b></td><td style="text-align:right"><b>${fmt(bill.balance_amount)}</b></td></tr>
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
      title={<span style={{ fontWeight: 700 }}>Sales Return — {bill.return_number}</span>}
      styles={{ body: { padding: '16px 24px' } }}>

      <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Return No">{bill.return_number}</Descriptions.Item>
        <Descriptions.Item label="Date">{dayjs(bill.return_date).format('DD-MMM-YYYY')}</Descriptions.Item>
        <Descriptions.Item label="Customer">{bill.customer?.party_name || '—'}</Descriptions.Item>
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
          <SummaryRow label="Credit Total" value={fmt(bill.total_amount)} bold borderTop />
          <SummaryRow label="Refunded" value={fmt(bill.refund_amount)} color="var(--success)" />
          <SummaryRow label="Credit pending" value={fmt(balance)}
            color={balance > 0 ? 'var(--danger)' : 'var(--success)'} bold borderTop />
        </div>
      </div>
    </Modal>
  );
}

// ── Circular progress ring (same as SalesList) ────────────────────────────────
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
  const { fyStart, fyEnd } = useFinancialYear();
  const [bills, setBills]             = useState([]);
  const [loading, setLoading]         = useState(false);
  const [total, setTotal]             = useState(0);
  const [filters, setFilters]         = useState({ search: '', refund_status: null, from_date: fyStart, to_date: fyEnd });
  const [viewBill, setViewBill]       = useState(null);
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
      const { data } = await salesReturnAPI.getAll({ ...filters, page: 1, limit: 10000 });
      setBills(data.data);
      setTotal(data.total);
    } catch (e) { message.error('Failed to load'); }
    setLoading(false);
  };

  const handleCancel = async (id) => {
    try {
      await salesReturnAPI.cancel(id);
      message.success('Return cancelled');
      loadBills();
    } catch (e) {
      Modal.error({
        title: 'Cannot cancel return', icon: null, width: 500,
        content: (
          <div style={{ paddingTop: 8 }}>
            <div style={{ background:'#fef2f2', border:'1px solid #fca5a5', borderRadius:8, padding:'12px 16px', marginBottom:12, color:'#7f1d1d', fontSize:13, lineHeight:1.6 }}>
              {e.response?.data?.error || 'Failed to cancel'}
            </div>
            <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:'10px 14px', fontSize:12, color:'#1e40af', lineHeight:1.6 }}>
              💡 Cancelling restores the returned stock and reverses the customer credit.
            </div>
          </div>
        ),
        okText: 'Got it', okButtonProps: { danger: true },
      });
    }
  };

  const fetchBill = useCallback(async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: true }));
    try {
      const { data } = await salesReturnAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load return');
      return null;
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: false }));
    }
  }, []);

  const handleView  = async (id) => { const b = await fetchBill(id); if (b) setViewBill(b); };
  const handlePrint = (id) => printDocument({ docType: 'sales_return', id });
  const handleEdit  = (id) => navigate(`/sales-return/edit/${id}`);

  // KPI computation — cancelled returns excluded so numbers reflect the live
  // ledger (a cancelled credit note has no balance-sheet impact).
  const kpis = useMemo(() => {
    const active = bills.filter(b => !b.is_cancelled);
    const totalAmount = active.reduce((s, b) => s + parseFloat(b.total_amount    || 0), 0);
    const refunded    = active.reduce((s, b) => s + parseFloat(b.refund_amount   || 0), 0);
    const pending     = active.reduce((s, b) => s + parseFloat(b.balance_amount  || 0), 0);
    const openCredits = active.filter(b => parseFloat(b.balance_amount || 0) > 0.01).length;
    const avg = active.length > 0 ? totalAmount / active.length : 0;
    return { totalAmount, refunded, pending, openCredits, count: active.length, avg };
  }, [bills]);

  const refundedPct = kpis.totalAmount > 0 ? (kpis.refunded / kpis.totalAmount) * 100 : 0;
  const pendingPct  = kpis.totalAmount > 0 ? (kpis.pending  / kpis.totalAmount) * 100 : 0;

  const pageTotals = useMemo(() => {
    const active = bills.filter(b => !b.is_cancelled);
    return {
      total:   active.reduce((s, b) => s + parseFloat(b.total_amount    || 0), 0),
      refund:  active.reduce((s, b) => s + parseFloat(b.refund_amount   || 0), 0),
      pending: active.reduce((s, b) => s + parseFloat(b.balance_amount  || 0), 0),
    };
  }, [bills]);

  return (
    <div className="blist-page rlist-page">

      {/* Top bar */}
      <div className="blist-hd">
        <div className="blist-title">
          <h1>Sales Returns</h1>
          <div className="sub"><b>{total}</b> credit note{total === 1 ? '' : 's'}</div>
        </div>
        <div className="blist-ctrl">
          <div className="blist-search">
            <SearchOutlined />
            <input
              type="text"
              placeholder="Search return no or ref bill"
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
                <div className="mh" style={{ paddingBottom: 2 }}>Always shown</div>
                <label className="opt"><span>Return # · Date · Customer</span><span className="pin">Pinned</span></label>
                <label className="opt"><span>Total · Refunded · Pending</span><span className="pin">Pinned</span></label>
              </div>
            )}
          >
            <button className={`blist-chip${visibleOptionalCount > 0 ? ' on' : ''}`}>
              <AppstoreOutlined /> Columns
              {visibleOptionalCount > 0 && <span className="col-count">{visibleOptionalCount}</span>}
            </button>
          </Dropdown>
          <span className="blist-divider"></span>
          <button className="blist-cta" onClick={() => navigate('/sales-return/new')}>
            <PlusOutlined /> New Return
          </button>
        </div>
      </div>

      {/* KPI cards — same 3-card layout as SalesList, relabelled */}
      <div className="blist-kpi">
        <div className="kpi-card total">
          <div className="kpi-text">
            <div className="k">Total Returns · This View</div>
            <div className="v">{fmt(kpis.totalAmount)}</div>
            <div className="sub">{kpis.count} returns · avg {fmtShort(kpis.avg)}</div>
          </div>
        </div>
        <div className="kpi-card received">
          <div className="kpi-text">
            <div className="k">Refunded</div>
            <div className="v">{fmt(kpis.refunded)}</div>
            <div className="sub">of {fmtShort(kpis.totalAmount)} credited</div>
          </div>
          <Ring pct={refundedPct} tone="ok" />
        </div>
        <div className="kpi-card outstanding">
          <div className="kpi-text">
            <div className="k">Credit Pending</div>
            <div className="v">{fmt(kpis.pending)}</div>
            <div className="sub">from {kpis.openCredits} open credit note{kpis.openCredits === 1 ? '' : 's'}</div>
          </div>
          <Ring pct={pendingPct} tone="bad" />
        </div>
      </div>

      {/* List — sticky header, internal scroll, footer totals */}
      <div className="blist-wrap">
        <div className="blist">

          <div className="brow head">
            <div className="c-sr">#</div>
            <div className="c-bill">Return #</div>
            <div className="c-date">Date</div>
            <div className="c-cust">Customer</div>
            {cols.ref      && <div className="c-ref">Ref bill</div>}
            {cols.mode     && <div className="c-mode">Mode</div>}
            {cols.reason   && <div className="c-reason">Reason</div>}
            <div className="c-total">Total</div>
            {cols.gst      && <div className="c-gst">GST</div>}
            {cols.discount && <div className="c-discount">Discount</div>}
            <div className="c-paid">Refunded</div>
            <div className="c-bal">Pending</div>
            <div className="c-act"></div>
          </div>

          <div className="bscroll">
            {loading ? (
              <div className="brow empty">Loading returns…</div>
            ) : bills.length === 0 ? (
              <div className="brow empty">No returns match the current filters.</div>
            ) : (
              bills.map((bill, i) => (
                <ReturnRow
                  key={bill.sales_return_id}
                  bill={bill}
                  index={i}
                  cols={cols}
                  actionLoading={!!actionLoading[bill.sales_return_id]}
                  onView={() => handleView(bill.sales_return_id)}
                  onPrint={() => handlePrint(bill.sales_return_id)}
                  onEdit={() => handleEdit(bill.sales_return_id)}
                  onCancel={() => handleCancel(bill.sales_return_id)}
                />
              ))
            )}
          </div>

          <div className="bfoot">
            <span>Shown: <b>{bills.length} of {total}</b></span>
            <span>Page credit: <b>{fmt(pageTotals.total)}</b></span>
            <span>Refunded: <b style={{ color: 'var(--success)' }}>{fmt(pageTotals.refund)}</b></span>
            <span>Pending: <b style={{ color: 'var(--danger)' }}>{fmt(pageTotals.pending)}</b></span>
          </div>
        </div>
      </div>

      <ViewModal bill={viewBill} onClose={() => setViewBill(null)} />
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────────────
function ReturnRow({ bill, index, cols, actionLoading, onView, onPrint, onEdit, onCancel }) {
  const cancelled = !!bill.is_cancelled;
  const total     = parseFloat(bill.total_amount    || 0);
  const refunded  = parseFloat(bill.refund_amount   || 0);
  const pending   = parseFloat(bill.balance_amount  || 0);

  const billDate = bill.return_date ? dayjs(bill.return_date) : null;

  const customerName  = bill.customer?.party_name;
  const customerPhone = bill.customer?.mobile_1;

  const gstAmt  = parseFloat(bill.cgst_amount || 0) + parseFloat(bill.sgst_amount || 0) + parseFloat(bill.igst_amount || 0);
  const discAmt = parseFloat(bill.discount_amount || 0);

  const moreMenu = {
    items: [
      { key: 'edit',  icon: <EditOutlined />, label: 'Edit return', onClick: onEdit, disabled: cancelled },
      { key: 'dup',   icon: <CopyOutlined />, label: 'Duplicate to new return', onClick: onEdit, disabled: cancelled },
      { type: 'divider' },
      {
        key: 'cancel',
        icon: <StopOutlined />,
        label: cancelled ? 'Already cancelled' : 'Cancel return',
        danger: true, disabled: cancelled,
        onClick: () => {
          Modal.confirm({
            title: `Cancel return ${bill.return_number}?`,
            content: 'Cancelling reverses the customer credit, removes the stock-ledger "Sales Return" row, and pulls the returned stock back out of inventory.',
            okText: 'Cancel this return', okButtonProps: { danger: true },
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
      <div className="c-bill">
        <span className="bill-no">{bill.return_number}</span>
        {bill.godown && (
          <span title={`Godown: ${bill.godown.name}`} style={{
            marginLeft: 6, padding: '1px 5px', fontSize: 10, fontWeight: 600,
            border: '1px solid var(--border, #e5e7eb)', borderRadius: 4,
            color: 'var(--fg-secondary, #6b7280)', background: 'var(--bg-subtle, #f9fafb)',
            fontFamily: 'var(--font-mono, monospace)', verticalAlign: 'middle',
          }}>{bill.godown.code}</span>
        )}
      </div>

      <div className="c-date">
        <div className="stk">
          <span className="m">{billDate ? billDate.format('DD MMM YYYY') : '—'}</span>
          <span className="s">{billDate ? billDate.format('dddd') : '\u00A0'}</span>
        </div>
      </div>

      <div className="c-cust">
        <div className="stk">
          <span className="m">{customerName || '—'}</span>
          <span className="s">{customerPhone || '\u00A0'}</span>
        </div>
      </div>

      {cols.ref && (
        <div className="c-ref">
          {bill.reference_bill_number ? (
            <div className="stk">
              <span className="m ref-num"><LinkOutlined /> {bill.reference_bill_number}</span>
              <span className="s">Linked invoice</span>
            </div>
          ) : (
            <span className="amt zero" style={{ fontStyle: 'italic' }}>Standalone</span>
          )}
        </div>
      )}

      {cols.mode && (
        <div className="c-mode">
          <span className={`mode-pill mode-${bill.return_mode?.toLowerCase() || 'items'}`}>
            {bill.return_mode === 'Amount' ? <FileTextOutlined /> : null}
            {bill.return_mode}
          </span>
        </div>
      )}

      {cols.reason && (
        <div className="c-reason">
          <span className="reason-text" title={bill.reason || ''}>{bill.reason || '—'}</span>
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
        {refunded > 0.01 ? (
          <span className="amt paid"><span className="rs">₹</span>{Math.round(refunded).toLocaleString('en-IN')}</span>
        ) : (
          <span className="amt zero">—</span>
        )}
      </div>

      <div className="c-bal">
        {cancelled ? (
          <span className="voided-tag">Voided</span>
        ) : pending < 0.01 ? (
          <span className="settled-tag">Settled</span>
        ) : (
          <span className="amt due"><span className="rs">₹</span>{Math.round(pending).toLocaleString('en-IN')}</span>
        )}
      </div>

      <div className="c-act">
        <div className="act-box">
          <div className="group">
            <Tooltip title="View">
              <button className="abtn" onClick={(e) => { e.stopPropagation(); onView(); }} disabled={actionLoading}>
                <EyeOutlined />
              </button>
            </Tooltip>
            <Tooltip title="Print">
              <button className="abtn" onClick={(e) => { e.stopPropagation(); onPrint(); }} disabled={actionLoading}>
                <PrinterOutlined />
              </button>
            </Tooltip>
            <Dropdown menu={moreMenu} trigger={['click']} placement="bottomRight">
              <button className="abtn" onClick={(e) => e.stopPropagation()} disabled={actionLoading}>
                <MoreOutlined />
              </button>
            </Dropdown>
          </div>
        </div>
      </div>
    </div>
  );
}
