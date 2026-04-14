import React, { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Tag, Typography, message, Card, Space, Input,
  DatePicker, Select, Popconfirm, Tooltip, Modal, Descriptions, Divider,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, EditOutlined, StopOutlined,
  EyeOutlined, PrinterOutlined, BarcodeOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { purchaseAPI, settingsAPI } from '../../api';
import BarcodePrintModal from '../../components/BarcodePrintModal';

const { Title, Text } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

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
  .sub{text-align:center;font-size:11px;color:#555;margin-bottom:10px}
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
function ViewModal({ bill, onClose }) {
  if (!bill) return null;
  const items = bill.items || [];

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
    <Modal open onCancel={onClose} width={900} footer={null}
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
      </Descriptions>

      <Table columns={itemColumns} dataSource={items} rowKey="purchase_bill_item_id"
        pagination={false} size="small" scroll={{ x: 600 }} />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
          {[
            ['Sub Total', fmt(bill.sub_total)],
            bill.discount_amount > 0 && ['Discount', `- ${fmt(bill.discount_amount)}`],
            bill.gst_amount > 0 && ['GST', fmt(bill.gst_amount)],
            bill.round_off && ['Round Off', parseFloat(bill.round_off).toFixed(2)],
          ].filter(Boolean).map(([label, val]) => (
            <tr key={label}><td style={{ padding: '2px 12px' }}>{label}</td><td style={{ textAlign: 'right' }}>{val}</td></tr>
          ))}
          <tr style={{ fontWeight: 700, fontSize: 14, borderTop: '2px solid #111' }}>
            <td style={{ padding: '4px 12px' }}>Total</td><td style={{ textAlign: 'right' }}>{fmt(bill.total_amount)}</td>
          </tr>
          <tr><td style={{ padding: '2px 12px', color: '#16a34a' }}>Paid</td><td style={{ textAlign: 'right', color: '#16a34a' }}>{fmt(bill.paid_amount)}</td></tr>
          <tr><td style={{ padding: '2px 12px', color: bill.balance_amount > 0 ? '#dc2626' : '#16a34a' }}>Balance</td>
            <td style={{ textAlign: 'right', fontWeight: 700, color: bill.balance_amount > 0 ? '#dc2626' : '#16a34a' }}>{fmt(bill.balance_amount)}</td></tr>
        </table>
      </div>
    </Modal>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function PurchaseList() {
  const [bills, setBills]         = useState([]);
  const [loading, setLoading]     = useState(false);
  const [total, setTotal] = useState(0);
  const [filters, setFilters]     = useState({ search: '', payment_status: null, from_date: null, to_date: null });
  const [viewBill, setViewBill]   = useState(null);
  const [barcodeModal, setBarcodeModal] = useState({ visible: false, bill: null });
  const [actionLoading, setActionLoading] = useState({});
  const [companyName, setCompanyName] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    loadBills();
    settingsAPI.getSystem().then(({ data }) => setCompanyName(data?.data?.company_name || '')).catch(() => {});
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
    try { await purchaseAPI.cancel(id); message.success('Bill cancelled'); loadBills(); }
    catch (e) { message.error('Failed to cancel'); }
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

  const handleView = async (id) => {
    const bill = await fetchBill(id);
    if (bill) setViewBill(bill);
  };

  const handlePrint = async (id) => {
    const bill = await fetchBill(id);
    if (bill) printBill(bill, companyName);
  };

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

  const columns = [
    { title: 'Bill No', dataIndex: 'bill_number', width: 150,
      render: (v) => <span style={{ fontWeight: 600, }}>{v}</span> },
    { title: 'Date', dataIndex: 'bill_date', width: 110, render: (v) => dayjs(v).format('DD-MMM-YYYY') },
    { title: 'Supplier', dataIndex: ['supplier', 'party_name'], width: 180 },
    { title: 'Total', dataIndex: 'total_amount', width: 120, align: 'right', render: fmt },
    { title: 'Paid', dataIndex: 'paid_amount', width: 120, align: 'right', render: fmt },
    { title: 'Balance', dataIndex: 'balance_amount', width: 120, align: 'right',
      render: (v) => <span style={{ color: v > 0 ? '#ff4d4f' : '#52c41a' }}>{fmt(v)}</span> },
    { title: 'Status', dataIndex: 'payment_status', width: 90,
      render: (s) => <Tag color={s === 'Paid' ? 'green' : s === 'Partial' ? 'orange' : 'red'}>{s}</Tag> },
    { title: 'Actions', width: 240, render: (_, r) => {
      const id = r.purchase_bill_id;
      const busy = actionLoading[id];
      return (
        <Space size={6}>
          <Tooltip title="View">
            <Button icon={<EyeOutlined />} loading={busy}
              onClick={() => handleView(id)} />
          </Tooltip>
          <Tooltip title="Print">
            <Button icon={<PrinterOutlined />} loading={busy}
              onClick={() => handlePrint(id)} />
          </Tooltip>
          <Tooltip title="Barcode Print">
            <Button icon={<BarcodeOutlined />} loading={busy}
              onClick={() => handleBarcode(id)}
              style={{ color: '#4F46E5', borderColor: '#4F46E5' }} />
          </Tooltip>
          <Tooltip title="Edit">
            <Button type="primary" icon={<EditOutlined />}
              onClick={() => navigate(`/purchase/edit/${id}`)}
              style={{ background: '#4F46E5', borderColor: '#4F46E5' }} />
          </Tooltip>
          <Popconfirm title="Cancel this bill?" onConfirm={() => handleCancel(id)}>
            <Tooltip title="Cancel">
              <Button icon={<StopOutlined />} danger />
            </Tooltip>
          </Popconfirm>
        </Space>
      );
    }},
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Page Header */}
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Purchase Bills</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{total} bills total</span>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/purchase/new')}
          style={{ height: 38, fontWeight: 500 }}>
          New Purchase
        </Button>
      </div>

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Filter Bar */}
        <div className="erp-filter-bar" style={{ flexShrink: 0 }}>
          <Input placeholder="Search bill no / supplier..." prefix={<SearchOutlined />}
            style={{ width: 220, height: 34 }}
            onChange={(e) => setFilters(f => ({ ...f, search: e.target.value }))} allowClear />
          <DatePicker.RangePicker format="DD-MM-YYYY" style={{ height: 34 }}
            onChange={(v) => setFilters(f => ({ ...f, from_date: v?.[0]?.format('YYYY-MM-DD'), to_date: v?.[1]?.format('YYYY-MM-DD') }))} />
          <Select placeholder="All Statuses" style={{ width: 130, height: 34 }} allowClear
            onChange={(v) => setFilters(f => ({ ...f, payment_status: v }))}>
            <Select.Option value="Paid">Paid</Select.Option>
            <Select.Option value="Partial">Partial</Select.Option>
            <Select.Option value="Unpaid">Unpaid</Select.Option>
          </Select>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          <Table columns={columns} dataSource={bills} rowKey="purchase_bill_id" loading={loading}
            size="small" scroll={{ x: 1100 }} pagination={false} />
        </div>

      </Card>

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
