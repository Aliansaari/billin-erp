import React, { useEffect, useState } from 'react';
import { Card, Form, Switch, Select, Button, Input, InputNumber, Typography, Row, Col, Divider, message, Radio, Modal, Checkbox, Alert } from 'antd';
import { SaveOutlined, SettingOutlined, CloudServerOutlined, CalendarOutlined, NumberOutlined, DeleteOutlined, WarningOutlined, FieldTimeOutlined, TagsOutlined } from '@ant-design/icons';
import { settingsAPI } from '../../api';

const { Title, Text } = Typography;

const CLEANUP_ITEMS = [
  {
    key: 'sales',
    label: 'Sales Bills & Items',
    desc: 'All sales invoices, line items, and customer balances will be reset to zero.',
    color: '#10b981',
  },
  {
    key: 'purchases',
    label: 'Purchase Bills & Items',
    desc: 'All purchase invoices, line items, and supplier balances will be reset to zero.',
    color: '#3b82f6',
  },
  {
    key: 'sales_returns',
    label: 'Sales Returns',
    desc: 'All sales return notes and their stock movements will be deleted (sales bills kept).',
    color: '#14b8a6',
  },
  {
    key: 'purchase_returns',
    label: 'Purchase Returns',
    desc: 'All purchase return notes and their stock movements will be deleted (purchase bills kept).',
    color: '#0ea5e9',
  },
  {
    key: 'payments',
    label: 'Payments & Receipts',
    desc: 'All payment and receipt entries will be deleted.',
    color: '#f59e0b',
  },
  {
    key: 'journal_vouchers',
    label: 'Journal Vouchers',
    desc: 'All manual journal vouchers and their ledger entries will be deleted (opening-balance JVs are tied to parties and stay).',
    color: '#a855f7',
  },
  {
    key: 'stock_ledger',
    label: 'Stock History (Ledger)',
    desc: 'All stock movement entries will be deleted and product stock quantities reset to 0.',
    color: '#8b5cf6',
  },
  {
    key: 'products',
    label: 'Products',
    desc: 'All products and their entire stock history will be permanently deleted.',
    color: '#ef4444',
  },
  {
    key: 'parties',
    label: 'Parties (Customers & Suppliers)',
    desc: 'All parties and all their linked bills, payments will be deleted.',
    color: '#f97316',
  },
  {
    key: 'categories',
    label: 'Categories',
    desc: 'All product categories will be deleted (products will be uncategorised).',
    color: '#6366f1',
  },
];

function CleanupModal({ open, onClose }) {
  const [selected, setSelected] = useState([]);
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const reset = () => { setSelected([]); setConfirmText(''); setPassword(''); };

  const handleClose = () => { reset(); onClose(); };

  const toggleAll = (checked) => setSelected(checked ? CLEANUP_ITEMS.map(i => i.key) : []);

  const toggle = (key) =>
    setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

  const handleDelete = async () => {
    if (selected.length === 0) return message.warning('Select at least one category');
    if (confirmText !== 'DELETE') return message.error('Type DELETE to confirm');
    if (!password) return message.error('Enter your admin password to confirm');
    setLoading(true);
    try {
      await settingsAPI.cleanupData({
        categories: selected,
        confirmation: confirmText,
        password,
      });
      message.success('Selected data deleted successfully');
      handleClose();
    } catch (e) {
      message.error(e.response?.data?.error || 'Cleanup failed');
    }
    setLoading(false);
  };

  const allSelected = selected.length === CLEANUP_ITEMS.length;

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      width={620}
      title={
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <WarningOutlined style={{ color:'#ef4444', fontSize:20 }}/>
          <span style={{ color:'#ef4444', fontWeight:700, fontSize:16 }}>Clean / Reset Data</span>
        </div>
      }
      footer={null}
      destroyOnClose
    >
      <Alert
        type="error"
        showIcon
        message="This action is permanent and cannot be undone."
        description="Deleted data cannot be recovered. Make sure you have a backup before proceeding."
        style={{ marginBottom:20 }}
      />

      {/* Select All */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <span style={{ fontWeight:600, color:'#374151', fontSize:13 }}>Select data to delete:</span>
        <button
          onClick={() => toggleAll(!allSelected)}
          style={{ background:'none', border:'1px solid #e5e7eb', borderRadius:6, padding:'4px 12px', cursor:'pointer', fontSize:12, color:'#6b7280', fontWeight:500 }}
        >
          {allSelected ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      {/* Checkboxes */}
      <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:24 }}>
        {CLEANUP_ITEMS.map(item => {
          const checked = selected.includes(item.key);
          return (
            <div
              key={item.key}
              onClick={() => toggle(item.key)}
              style={{
                display:'flex', alignItems:'flex-start', gap:12,
                padding:'12px 14px', borderRadius:8, cursor:'pointer',
                border: checked ? `1.5px solid ${item.color}` : '1.5px solid #e5e7eb',
                background: checked ? `${item.color}10` : '#fafafa',
                transition:'all .15s',
              }}
            >
              <Checkbox checked={checked} style={{ marginTop:2, flexShrink:0 }} onChange={() => toggle(item.key)}/>
              <div>
                <div style={{ fontWeight:600, fontSize:13, color: checked ? item.color : '#374151' }}>{item.label}</div>
                <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>{item.desc}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Confirmation */}
      <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:8, padding:'14px 16px', marginBottom:20 }}>
        <div style={{ fontSize:13, color:'#7f1d1d', fontWeight:500, marginBottom:8 }}>
          Type <strong>DELETE</strong> below to confirm permanent deletion of{' '}
          <strong>{selected.length === 0 ? 'nothing selected' : selected.length === CLEANUP_ITEMS.length ? 'ALL data' : `${selected.length} category${selected.length > 1 ? 's' : ''}`}</strong>:
        </div>
        <Input
          value={confirmText}
          onChange={e => setConfirmText(e.target.value.toUpperCase())}
          placeholder="Type DELETE here"
          style={{ fontFamily:'monospace', fontWeight:700, letterSpacing:2, marginBottom:12 }}
          status={confirmText && confirmText !== 'DELETE' ? 'error' : ''}
        />
        <div style={{ fontSize:13, color:'#7f1d1d', fontWeight:500, marginBottom:8 }}>
          Re-enter your admin password:
        </div>
        <Input.Password
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Your admin password"
          autoComplete="current-password"
        />
      </div>

      {/* Action buttons */}
      <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          danger type="primary"
          icon={<DeleteOutlined/>}
          loading={loading}
          disabled={selected.length === 0 || confirmText !== 'DELETE' || !password}
          onClick={handleDelete}
        >
          Delete Selected Data
        </Button>
      </div>
    </Modal>
  );
}

export default function ModuleSettings() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  // Mirror of the global batch toggle so the conditional batch-tracking card
  // appears/disappears as the operator flicks the switch — without waiting
  // for a save round-trip. Ant Form.useWatch could do this, but a piece of
  // local state keeps the render cheap and the wiring obvious.
  const [batchTrackingOn, setBatchTrackingOn] = useState(false);

  useEffect(() => { loadSettings(); }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const { data } = await settingsAPI.getSystem();
      // handle both response shapes: { data: settings } and bare settings object
      const s = (data && data.data) ? data.data : data;
      if (!s) throw new Error('No settings returned');
      form.setFieldsValue({
        gst_enabled:             !!s.gst_enabled,
        low_stock_alert_enabled: !!s.low_stock_alert_enabled,
        allow_negative_stock:    !!s.allow_negative_stock,
        // Default ON (?? true) so installs without the column in the
        // settings response don't surprise the operator with the toggle off.
        enable_amount_only_billing: s.enable_amount_only_billing ?? true,
        multi_warehouse_enabled: !!s.multi_warehouse_enabled,
        audit_trail_enabled:     !!s.audit_trail_enabled,
        batch_tracking_enabled:  !!s.batch_tracking_enabled,
        batch_expiry_alert_days: s.batch_expiry_alert_days ?? 30,
        block_expired_sales:     !!s.block_expired_sales,
        allow_zero_stock_batches: s.allow_zero_stock_batches ?? true,
        backup_frequency:        s.backup_frequency || 'Daily',
        sale_due_days_mode:      localStorage.getItem('sale_due_days_mode')  || 'bill_date',
        purchase_due_days_mode:  localStorage.getItem('purchase_due_days_mode') || 'bill_date',
        gst_mode:                localStorage.getItem('gst_mode') || 'product',
        sales_bill_prefix:       s.sales_bill_prefix    || '',
        purchase_bill_prefix:    s.purchase_bill_prefix || '',
        aging_bucket_1_days:     s.aging_bucket_1_days ?? 30,
        aging_bucket_2_days:     s.aging_bucket_2_days ?? 60,
        aging_bucket_3_days:     s.aging_bucket_3_days ?? 90,
      });
      setBatchTrackingOn(!!s.batch_tracking_enabled);
    } catch (error) {
      console.error('ModuleSettings load error:', error);
      message.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (values) => {
    setSaving(true);
    try {
      // Save due days modes to localStorage (UI preference, no DB column needed)
      localStorage.setItem('sale_due_days_mode',     values.sale_due_days_mode     || 'bill_date');
      localStorage.setItem('purchase_due_days_mode', values.purchase_due_days_mode || 'bill_date');
      localStorage.setItem('gst_mode',               values.gst_mode               || 'product');

      // Save everything else to the DB (only fields that exist in the model)
      const { sale_due_days_mode, purchase_due_days_mode, gst_mode, ...dbValues } = values;
      // Sanitise prefix: uppercase, strip spaces
      if (dbValues.sales_bill_prefix)    dbValues.sales_bill_prefix    = dbValues.sales_bill_prefix.trim().toUpperCase();
      if (dbValues.purchase_bill_prefix) dbValues.purchase_bill_prefix = dbValues.purchase_bill_prefix.trim().toUpperCase();
      // Enforce strictly-increasing aging bucket thresholds so Watchful < Chase < Critical.
      const b1 = Math.max(1,      parseInt(dbValues.aging_bucket_1_days, 10) || 30);
      const b2 = Math.max(b1 + 1, parseInt(dbValues.aging_bucket_2_days, 10) || 60);
      const b3 = Math.max(b2 + 1, parseInt(dbValues.aging_bucket_3_days, 10) || 90);
      dbValues.aging_bucket_1_days = b1;
      dbValues.aging_bucket_2_days = b2;
      dbValues.aging_bucket_3_days = b3;
      await settingsAPI.updateSystem(dbValues);
      message.success('Settings saved successfully');
    } catch (error) {
      console.error('ModuleSettings save error:', error);
      message.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Title level={3}>Module Settings</Title>
      <Form form={form} layout="vertical" onFinish={handleSave}>
        <Row gutter={16}>
          <Col xs={24} lg={12}>
            <Card loading={loading} title={<><SettingOutlined /> Module Toggles</>}>
              <Form.Item name="gst_enabled" label="Enable GST" valuePropName="checked">
                <Switch checkedChildren="ON" unCheckedChildren="OFF" />
              </Form.Item>
              <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
                Enable GST calculations on invoices and reports
              </Text>

              <Form.Item name="low_stock_alert_enabled" label="Enable Stock Alerts" valuePropName="checked">
                <Switch checkedChildren="ON" unCheckedChildren="OFF" />
              </Form.Item>
              <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
                Get notified when stock falls below minimum level
              </Text>

              <Form.Item name="allow_negative_stock" label="Allow Negative Stock" valuePropName="checked">
                <Switch checkedChildren="ON" unCheckedChildren="OFF" />
              </Form.Item>
              <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
                When ON — sales can proceed even if stock goes below zero (stock shown in red). When OFF — sales are blocked if quantity would go negative.
              </Text>

              <Form.Item name="enable_amount_only_billing" label="Enable Amount-only Billing" valuePropName="checked">
                <Switch checkedChildren="ON" unCheckedChildren="OFF" />
              </Form.Item>
              <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
                When ON — the Sales Bill form shows a Mode toggle (Itemised / Amount only) so operators can record service or on-account bills without itemising. When OFF — only itemised bills are creatable.
              </Text>

              <Form.Item name="multi_warehouse_enabled" label="Enable Multi-Warehouse" valuePropName="checked">
                <Switch checkedChildren="ON" unCheckedChildren="OFF" />
              </Form.Item>
              <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
                Manage stock across multiple warehouse locations
              </Text>

              <Form.Item name="audit_trail_enabled" label="Enable Audit Trail" valuePropName="checked">
                <Switch checkedChildren="ON" unCheckedChildren="OFF" />
              </Form.Item>
              <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
                Track all changes made to bills and records
              </Text>

              <Form.Item name="batch_tracking_enabled" label="Enable Batch Tracking" valuePropName="checked">
                <Switch
                  checkedChildren="ON"
                  unCheckedChildren="OFF"
                  onChange={setBatchTrackingOn}
                />
              </Form.Item>
              <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 0 }}>
                Group identical units into batches with their own dates, quantities, and optional expiry. Toggle individual products into batch mode from the Product form. Existing data is preserved if turned OFF later.
              </Text>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card loading={loading} title={<><CloudServerOutlined /> Backup Settings</>}>
              <Form.Item name="backup_frequency" label="Backup Frequency">
                <Select placeholder="Select frequency">
                  <Select.Option value="Hourly">Hourly</Select.Option>
                  <Select.Option value="Daily">Daily</Select.Option>
                  <Select.Option value="Weekly">Weekly</Select.Option>
                  <Select.Option value="Manual">Manual</Select.Option>
                </Select>
              </Form.Item>
            </Card>
          </Col>
        </Row>

        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col xs={24} lg={12}>
            <Card loading={loading} title={<><CalendarOutlined /> Due Days Display</>}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                Choose how "Due Days" is calculated in the Payment &amp; Receipt windows.
              </Text>

              <Form.Item name="sale_due_days_mode" label="Sales Bills (Receipt Entry)">
                <Radio.Group>
                  <Radio value="bill_date" style={{ display: 'block', marginBottom: 8 }}>
                    <span style={{ fontWeight: 500 }}>From Bill Date</span>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      Shows age of bill — how many days since the bill was created
                    </div>
                  </Radio>
                  <Radio value="due_date" style={{ display: 'block' }}>
                    <span style={{ fontWeight: 500 }}>From Due Date</span>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      Shows "Overdue X days" if past due date, or "Due in X days" if upcoming
                    </div>
                  </Radio>
                </Radio.Group>
              </Form.Item>

              <Divider style={{ margin: '12px 0' }} />

              <Form.Item name="purchase_due_days_mode" label="Purchase Bills (Payment Entry)">
                <Radio.Group>
                  <Radio value="bill_date" style={{ display: 'block', marginBottom: 8 }}>
                    <span style={{ fontWeight: 500 }}>From Bill Date</span>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      Shows age of bill — how many days since the bill was created
                    </div>
                  </Radio>
                  <Radio value="due_date" style={{ display: 'block' }}>
                    <span style={{ fontWeight: 500 }}>From Due Date</span>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      Shows "Overdue X days" if past due date, or "Due in X days" if upcoming
                    </div>
                  </Radio>
                </Radio.Group>
              </Form.Item>
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card loading={loading} title={<><FieldTimeOutlined /> Aging Buckets</>}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                Set how many days past a bill's due date (bill date + party's credit days) moves it into each bucket on the Customers / Suppliers page. Defaults mirror the classic 30 / 60 / 90 split.
              </Text>

              <Form.Item
                name="aging_bucket_1_days"
                label="Not yet due — up to"
                extra={<span style={{ fontSize: 12, color: '#6b7280' }}>Bills aged 0 – <b>N</b> days past due</span>}
              >
                <InputNumber min={1} max={365} style={{ width: 160 }} addonAfter="days" />
              </Form.Item>

              <Form.Item
                name="aging_bucket_2_days"
                label="Watchful — up to"
                extra={<span style={{ fontSize: 12, color: '#6b7280' }}>Between the first and second threshold</span>}
              >
                <InputNumber min={2} max={365} style={{ width: 160 }} addonAfter="days" />
              </Form.Item>

              <Form.Item
                name="aging_bucket_3_days"
                label="Chase — up to"
                style={{ marginBottom: 0 }}
                extra={<span style={{ fontSize: 12, color: '#6b7280' }}>Bills aged beyond this threshold are marked <b>Critical</b></span>}
              >
                <InputNumber min={3} max={720} style={{ width: 160 }} addonAfter="days" />
              </Form.Item>
            </Card>
          </Col>
        </Row>

        {batchTrackingOn && (
          <Row gutter={16} style={{ marginTop: 16 }}>
            <Col xs={24} lg={12}>
              <Card loading={loading} title={<><TagsOutlined /> Batch Tracking</>}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                  Active when individual products are flipped to batch mode on the Product form. The settings below tune expiry alerts and sale-of-expired behaviour.
                </Text>

                <Form.Item
                  name="batch_expiry_alert_days"
                  label="Default expiry alert"
                  extra={<span style={{ fontSize: 12, color: '#6b7280' }}>Batches within this many days of expiry are flagged with an amber chip on the picker and Expiry Report</span>}
                >
                  <InputNumber min={1} max={365} style={{ width: 160 }} addonAfter="days" />
                </Form.Item>

                <Form.Item name="block_expired_sales" label="Block sales of expired batches" valuePropName="checked">
                  <Switch checkedChildren="ON" unCheckedChildren="OFF" />
                </Form.Item>
                <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 16 }}>
                  When ON — the sales bill refuses to save a line that draws from an expired batch. When OFF — operators can deliberately sell aged stock at a discount (typical wholesale behaviour).
                </Text>

                <Form.Item name="allow_zero_stock_batches" label="Allow zero-stock batches" valuePropName="checked" style={{ marginBottom: 0 }}>
                  <Switch checkedChildren="ON" unCheckedChildren="OFF" />
                </Form.Item>
                <Text type="secondary" style={{ display: 'block', marginTop: -16, marginBottom: 0 }}>
                  When ON — operators can pre-register a batch (e.g. an upcoming shipment) before any stock arrives. When OFF — batches can only be created via a purchase bill.
                </Text>
              </Card>
            </Col>
          </Row>
        )}

        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col xs={24} lg={12}>
            <Card loading={loading} title={<><SettingOutlined /> GST Calculation Mode</>}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                Choose how GST is applied on sales bills.
              </Text>
              <Form.Item name="gst_mode" label="GST Mode">
                <Radio.Group>
                  <Radio value="product" style={{ display: 'block', marginBottom: 8 }}>
                    <span style={{ fontWeight: 500 }}>Product-wise GST</span>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      Each product carries its own GST rate — CGST/SGST/IGST % are auto-calculated from items
                    </div>
                  </Radio>
                  <Radio value="bill" style={{ display: 'block' }}>
                    <span style={{ fontWeight: 500 }}>Bill-wise GST</span>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      Enter CGST%, SGST%, IGST% manually on the whole bill total
                    </div>
                  </Radio>
                </Radio.Group>
              </Form.Item>
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card loading={loading} title={<><NumberOutlined /> Bill Number Prefix</>}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                Set a prefix for auto-generated bill numbers. Leave blank for plain numbers like <code>0001</code>, <code>0002</code>…
              </Text>

              <Form.Item
                name="sales_bill_prefix"
                label="Sales Bill Prefix"
                extra={<span style={{ fontSize: 12, color: '#6b7280' }}>e.g. <b>INV</b> → <b>INV-0001</b> &nbsp;|&nbsp; blank → <b>0001</b></span>}
              >
                <Input
                  placeholder="e.g. INV or SAL (leave blank for 0001)"
                  maxLength={10}
                  style={{ textTransform: 'uppercase', width: 220 }}
                  onChange={e => e.target.value = e.target.value.toUpperCase()}
                />
              </Form.Item>

              <Form.Item
                name="purchase_bill_prefix"
                label="Purchase Bill Prefix"
                style={{ marginBottom: 0 }}
                extra={<span style={{ fontSize: 12, color: '#6b7280' }}>e.g. <b>PUR</b> → <b>PUR-0001</b> &nbsp;|&nbsp; blank → <b>0001</b></span>}
              >
                <Input
                  placeholder="e.g. PUR or GRN (leave blank for 0001)"
                  maxLength={10}
                  style={{ textTransform: 'uppercase', width: 220 }}
                  onChange={e => e.target.value = e.target.value.toUpperCase()}
                />
              </Form.Item>
            </Card>
          </Col>
        </Row>

        <div style={{ marginTop: 16 }}>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
            Save Changes
          </Button>
        </div>
      </Form>

      {/* Danger Zone */}
      <div style={{ marginTop: 32, border: '1.5px solid #fecaca', borderRadius: 10, padding: '20px 24px', background: '#fff5f5' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <WarningOutlined style={{ color: '#ef4444', fontSize: 18 }} />
              <span style={{ fontWeight: 700, fontSize: 15, color: '#b91c1c' }}>Danger Zone</span>
            </div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              Permanently delete selected data from the software. This cannot be undone.
            </div>
          </div>
          <Button
            danger
            icon={<DeleteOutlined />}
            onClick={() => setCleanupOpen(true)}
            style={{ fontWeight: 600 }}
          >
            Clean / Reset Data
          </Button>
        </div>
      </div>

      <CleanupModal open={cleanupOpen} onClose={() => setCleanupOpen(false)} />
    </div>
  );
}
