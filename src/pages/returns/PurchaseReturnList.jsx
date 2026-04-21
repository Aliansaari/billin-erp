import React, { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Tag, Typography, message, Card, Space, Input,
  DatePicker, Select, Popconfirm, Tooltip, Modal, Descriptions, Divider,
} from 'antd';
import {
  PlusOutlined, SearchOutlined, EyeOutlined, StopOutlined,
  PrinterOutlined, EditOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { purchaseReturnAPI, settingsAPI } from '../../api';

const { Title, Text } = Typography;
const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

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

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Purchase Return</title>
<style>
  @page{margin:12mm}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:12px;color:#111}
  h2{font-size:18px;text-align:center;margin-bottom:2px}
  .title{text-align:center;font-size:14px;font-weight:700;letter-spacing:1px;
    border-top:2px solid #B91C1C;border-bottom:2px solid #B91C1C;padding:4px 0;margin:8px 0;color:#B91C1C}
  .meta{display:flex;justify-content:space-between;margin-bottom:10px}
  .meta div{line-height:1.8}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{background:#fef2f2;padding:5px 6px;border:1px solid #fecaca;font-size:11px;text-align:left}
  td{padding:4px 6px;border:1px solid #fecaca;font-size:11px}
  .totals{margin-top:12px;display:flex;justify-content:flex-end}
  .totals table{width:260px}
  .totals td{border:none;padding:2px 6px}
  .totals .grand{font-weight:700;font-size:13px;border-top:2px solid #B91C1C;color:#B91C1C}
  .footer{margin-top:24px;display:flex;justify-content:space-between;font-size:11px}
</style></head>
<body>
  <h2>${companyName || 'Purchase Return'}</h2>
  <div class="title">PURCHASE RETURN / DEBIT NOTE</div>
  <div class="meta">
    <div>
      <b>Return No:</b> ${bill.return_number}<br>
      <b>Date:</b> ${dayjs(bill.return_date).format('DD-MMM-YYYY')}<br>
      ${bill.reference_bill_number ? `<b>Against Bill:</b> ${bill.reference_bill_number}<br>` : ''}
    </div>
    <div style="text-align:right">
      <b>Supplier:</b> ${bill.supplier?.party_name || '—'}<br>
      <b>Reason:</b> ${bill.reason || '—'}<br>
      <b>Mode:</b> ${bill.return_mode}<br>
    </div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Product</th><th>Barcode</th><th>Size</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals"><table>
    <tr><td>Sub Total</td><td style="text-align:right">${fmt(bill.sub_total)}</td></tr>
    ${bill.discount_amount > 0 ? `<tr><td>Discount</td><td style="text-align:right">- ${fmt(bill.discount_amount)}</td></tr>` : ''}
    ${parseFloat(bill.cgst_amount||0) > 0 ? `<tr><td>CGST</td><td style="text-align:right">${fmt(bill.cgst_amount)}</td></tr>` : ''}
    ${parseFloat(bill.sgst_amount||0) > 0 ? `<tr><td>SGST</td><td style="text-align:right">${fmt(bill.sgst_amount)}</td></tr>` : ''}
    ${parseFloat(bill.igst_amount||0) > 0 ? `<tr><td>IGST</td><td style="text-align:right">${fmt(bill.igst_amount)}</td></tr>` : ''}
    ${parseFloat(bill.round_off||0) !== 0 ? `<tr><td>Round Off</td><td style="text-align:right">${parseFloat(bill.round_off).toFixed(2)}</td></tr>` : ''}
    <tr class="grand"><td>Debit Total</td><td style="text-align:right">${fmt(bill.total_amount)}</td></tr>
    <tr><td>Refunded</td><td style="text-align:right">${fmt(bill.refund_amount)}</td></tr>
    <tr><td><b>Debit Pending</b></td><td style="text-align:right"><b>${fmt(bill.balance_amount)}</b></td></tr>
  </table></div>
  <div class="footer">
    <div>Supplier Signature: _______________</div>
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

function SummaryRow({ label, value, color, bold, borderTop }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '5px 0', borderTop: borderTop ? '1px solid #d9d9d9' : undefined,
      fontWeight: bold ? 700 : 400, fontSize: bold ? 14 : 13, color: color || undefined,
    }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

function ViewModal({ bill, onClose }) {
  if (!bill) return null;
  const items = bill.items || [];
  const cgst  = parseFloat(bill.cgst_amount || 0);
  const sgst  = parseFloat(bill.sgst_amount || 0);
  const igst  = parseFloat(bill.igst_amount || 0);
  const discount = parseFloat(bill.discount_amount || 0);
  const balance = parseFloat(bill.balance_amount || 0);
  const roundOff = parseFloat(bill.round_off || 0);

  const itemColumns = [
    { title: '#', width: 40, render: (_, __, i) => i + 1 },
    { title: 'Product', dataIndex: 'product_name' },
    { title: 'Barcode', dataIndex: 'barcode', width: 110, render: (v) => <Text style={{ fontSize: 11 }}>{v}</Text> },
    { title: 'Size', dataIndex: 'size', width: 70 },
    { title: 'Qty', dataIndex: 'quantity', width: 65, align: 'right' },
    { title: 'Rate', dataIndex: 'rate', width: 90, align: 'right', render: (v) => `₹${parseFloat(v || 0).toFixed(2)}` },
    { title: 'Amount', dataIndex: 'total_amount', width: 100, align: 'right', render: (v) => `₹${parseFloat(v || 0).toFixed(2)}` },
  ];

  return (
    <Modal open onCancel={onClose} width={960} footer={null}
      title={<span style={{ fontWeight: 700, color: '#B91C1C' }}>Purchase Return — {bill.return_number}</span>}
      styles={{ body: { padding: '16px 24px' } }}>

      <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Return No">{bill.return_number}</Descriptions.Item>
        <Descriptions.Item label="Date">{dayjs(bill.return_date).format('DD-MMM-YYYY')}</Descriptions.Item>
        <Descriptions.Item label="Supplier">{bill.supplier?.party_name || '—'}</Descriptions.Item>
        <Descriptions.Item label="Mode">
          <Tag color={bill.return_mode === 'Amount' ? 'purple' : 'red'}>{bill.return_mode}</Tag>
        </Descriptions.Item>
        {bill.reference_bill_number && (
          <Descriptions.Item label="Against Bill" span={2}>{bill.reference_bill_number}</Descriptions.Item>
        )}
        {bill.reason && <Descriptions.Item label="Reason" span={2}>{bill.reason}</Descriptions.Item>}
        <Descriptions.Item label="Status">
          <Tag color={bill.refund_status === 'Refunded' ? 'green' : bill.refund_status === 'Partial' ? 'orange' : 'red'}>
            {bill.refund_status}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Refund Mode">{bill.refund_method}</Descriptions.Item>
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
          {discount > 0 && <SummaryRow label={`Discount${bill.discount_percentage > 0 ? ` (${bill.discount_percentage}%)` : ''}`}
            value={`- ${fmt(discount)}`} color="#d97706" />}
          {cgst > 0 && <SummaryRow label={`CGST${bill.cgst_pct > 0 ? ` (${bill.cgst_pct}%)` : ''}`} value={fmt(cgst)} />}
          {sgst > 0 && <SummaryRow label={`SGST${bill.sgst_pct > 0 ? ` (${bill.sgst_pct}%)` : ''}`} value={fmt(sgst)} />}
          {igst > 0 && <SummaryRow label={`IGST${bill.igst_pct > 0 ? ` (${bill.igst_pct}%)` : ''}`} value={fmt(igst)} />}
          {roundOff !== 0 && <SummaryRow label="Round Off" value={roundOff.toFixed(2)} />}
          <SummaryRow label="Debit Total" value={fmt(bill.total_amount)} bold borderTop color="#B91C1C" />
          <SummaryRow label="Refunded" value={fmt(bill.refund_amount)} color="#16a34a" />
          <SummaryRow label="Debit Pending" value={fmt(balance)}
            color={balance > 0 ? '#dc2626' : '#16a34a'} bold borderTop />
        </div>
      </div>
    </Modal>
  );
}

export default function PurchaseReturnList() {
  const [bills, setBills]           = useState([]);
  const [loading, setLoading]       = useState(false);
  const [total, setTotal]           = useState(0);
  const [filters, setFilters]       = useState({ search: '', refund_status: null, from_date: null, to_date: null });
  const [viewBill, setViewBill]     = useState(null);
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
      const { data } = await purchaseReturnAPI.getAll({ ...filters, page: 1, limit: 10000 });
      setBills(data.data);
      setTotal(data.total);
    } catch (e) { message.error('Failed to load'); }
    setLoading(false);
  };

  const handleCancel = async (id) => {
    try {
      await purchaseReturnAPI.cancel(id);
      message.success('Return cancelled');
      loadBills();
    } catch (e) {
      Modal.error({
        title: 'Cannot cancel return',
        content: e.response?.data?.error || 'Failed to cancel',
      });
    }
  };

  const fetchBill = useCallback(async (id) => {
    setActionLoading((prev) => ({ ...prev, [id]: true }));
    try {
      const { data } = await purchaseReturnAPI.getById(id);
      return data;
    } catch {
      message.error('Failed to load return');
      return null;
    } finally {
      setActionLoading((prev) => ({ ...prev, [id]: false }));
    }
  }, []);

  const handleView = async (id) => { const b = await fetchBill(id); if (b) setViewBill(b); };
  const handlePrint = async (id) => { const b = await fetchBill(id); if (b) printReturn(b, companyName); };

  const columns = [
    { title: 'Return No', dataIndex: 'return_number', width: 150,
      render: (v) => <span style={{ fontWeight: 700, color: '#B91C1C' }}>{v}</span> },
    { title: 'Date', dataIndex: 'return_date', width: 110, render: (v) => dayjs(v).format('DD-MMM-YYYY') },
    { title: 'Supplier', dataIndex: ['supplier', 'party_name'], width: 180, render: (v) => v || '—' },
    { title: 'Ref. Bill', dataIndex: 'reference_bill_number', width: 140, render: (v) => v || '—' },
    { title: 'Mode', dataIndex: 'return_mode', width: 90,
      render: (v) => <Tag color={v === 'Amount' ? 'purple' : 'red'}>{v}</Tag> },
    { title: 'Total', dataIndex: 'total_amount', width: 120, align: 'right', render: fmt },
    { title: 'Refunded', dataIndex: 'refund_amount', width: 120, align: 'right', render: fmt },
    { title: 'Pending', dataIndex: 'balance_amount', width: 110, align: 'right',
      render: (v) => <span style={{ color: v > 0 ? '#ff4d4f' : '#52c41a' }}>{fmt(v)}</span> },
    { title: 'Status', dataIndex: 'refund_status', width: 100,
      render: (s) => <Tag color={s === 'Refunded' ? 'green' : s === 'Partial' ? 'orange' : 'red'}>{s}</Tag> },
    { title: 'Actions', width: 200, render: (_, r) => {
      const id = r.purchase_return_id;
      const busy = actionLoading[id];
      return (
        <Space size={6}>
          <Tooltip title="View"><Button icon={<EyeOutlined />} loading={busy} onClick={() => handleView(id)} /></Tooltip>
          <Tooltip title="Print"><Button icon={<PrinterOutlined />} loading={busy} onClick={() => handlePrint(id)} /></Tooltip>
          <Tooltip title="Edit">
            <Button type="primary" icon={<EditOutlined />}
              onClick={() => navigate(`/purchase-return/edit/${id}`)}
              style={{ background: '#B91C1C', borderColor: '#B91C1C' }} />
          </Tooltip>
          <Popconfirm title="Cancel this return?" onConfirm={() => handleCancel(id)}>
            <Tooltip title="Cancel"><Button icon={<StopOutlined />} danger /></Tooltip>
          </Popconfirm>
        </Space>
      );
    }},
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="erp-page-header" style={{ padding: '12px 20px', marginBottom: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div className="erp-page-header-title">
          <Title level={3} style={{ margin: 0, fontWeight: 700, color: '#1f2937' }}>Purchase Returns</Title>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{total} returns total</span>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/purchase-return/new')}
          style={{ height: 38, fontWeight: 500, background: '#B91C1C', borderColor: '#B91C1C' }}>
          New Return
        </Button>
      </div>

      <Card bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="erp-filter-bar" style={{ flexShrink: 0 }}>
          <Input placeholder="Search return no / bill..." prefix={<SearchOutlined />}
            style={{ width: 220, height: 34 }}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} allowClear />
          <DatePicker.RangePicker format="DD-MM-YYYY" style={{ height: 34 }}
            onChange={(v) => setFilters((f) => ({ ...f, from_date: v?.[0]?.format('YYYY-MM-DD'), to_date: v?.[1]?.format('YYYY-MM-DD') }))} />
          <Select placeholder="All Statuses" style={{ width: 130, height: 34 }} allowClear
            onChange={(v) => setFilters((f) => ({ ...f, refund_status: v }))}>
            <Select.Option value="Refunded">Refunded</Select.Option>
            <Select.Option value="Partial">Partial</Select.Option>
            <Select.Option value="Pending">Pending</Select.Option>
          </Select>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          <Table columns={columns} dataSource={bills} rowKey="purchase_return_id" loading={loading}
            size="small" scroll={{ x: 1200 }} pagination={false} />
        </div>
      </Card>

      <ViewModal bill={viewBill} onClose={() => setViewBill(null)} />
    </div>
  );
}
