import React, { useEffect, useState } from 'react';
import { Form, Switch, Button, Input, InputNumber, message, Radio, Modal, Checkbox, Alert } from 'antd';
import { DeleteOutlined, WarningOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { settingsAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

/* ── Reusable row primitives — keep the visual rhythm uniform ── */

function ToggleRow({ name, label, desc, onChange }) {
  return (
    <div className="ms-row">
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">
        <Form.Item name={name} valuePropName="checked" noStyle>
          <Switch onChange={onChange} />
        </Form.Item>
      </div>
    </div>
  );
}

function NumberRow({ name, label, desc, min = 0, suffix }) {
  return (
    <div className="ms-row">
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">
        <Form.Item name={name} noStyle>
          <InputNumber min={min} addonAfter={suffix} style={{ width: 140 }} />
        </Form.Item>
      </div>
    </div>
  );
}

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
  const navigate = useNavigate();
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
        default_product_mode:    s.default_product_mode || 'variant',
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
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Modules</h1>
        <p className="ms-page-sub">
          Toggle features, set defaults, and manage data lifecycle. Changes save together via {''}
          <kbd>F1</kbd>.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Form form={form} onFinish={handleSave} disabled={loading}>

            {/* ── Features ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Features</h2>
                <p className="ms-section-desc">
                  Master toggles for modules and capabilities. Off here = hidden across the app.
                </p>
              </div>
              <ToggleRow name="gst_enabled" label="GST"
                         desc="Run GST calculations on invoices and reports." />
              <ToggleRow name="low_stock_alert_enabled" label="Stock alerts"
                         desc="Notify when stock falls below the per-product minimum." />
              <ToggleRow name="allow_negative_stock" label="Allow negative stock"
                         desc="ON — sales pass even if quantity goes below zero (shown in red). OFF — block the sale." />
              <ToggleRow name="enable_amount_only_billing" label="Amount-only billing"
                         desc="Adds an Itemised / Amount-only mode toggle on the Sales Bill form for service or on-account bills." />
              <ToggleRow name="multi_warehouse_enabled" label="Multi-warehouse"
                         desc="Track stock across multiple godowns." />
              <ToggleRow name="audit_trail_enabled" label="Audit trail"
                         desc="Record every change to bills and master records." />
              <ToggleRow name="batch_tracking_enabled" label="Batch tracking"
                         desc="Group identical units into batches with their own dates, quantities, and optional expiry. Per-product opt-in on the Product form."
                         onChange={setBatchTrackingOn} />

              {batchTrackingOn && (
                <div className="ms-nested">
                  <NumberRow name="batch_expiry_alert_days" label="Default expiry alert"
                             desc="Batches within this many days of expiry get flagged on the picker and Expiry Report."
                             min={1} suffix="days" />
                  <ToggleRow name="block_expired_sales" label="Block sales of expired batches"
                             desc="ON — refuse to save a sale line drawing from an expired batch. OFF — allow (typical wholesale)." />
                  <ToggleRow name="allow_zero_stock_batches" label="Allow zero-stock batches"
                             desc="ON — pre-register a batch before stock arrives. OFF — batches only via purchase bill." />
                </div>
              )}
            </section>

            {/* ── Defaults ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Defaults</h2>
                <p className="ms-section-desc">
                  Behaviour the app uses unless an individual record overrides it.
                </p>
              </div>

              <div className="ms-row-stacked">
                <div className="ms-row-label">Default product mode (new products only)</div>
                <div className="ms-row-desc">
                  Existing products keep their mode permanently — flipping this won't reshape your catalog.
                </div>
                <div className="ms-row-stacked-control" style={{ marginTop: 10 }}>
                  <Form.Item name="default_product_mode" noStyle>
                    <Radio.Group>
                      <Radio value="variant">
                        <span style={{ fontWeight: 500 }}>Variant</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>
                          A purchase at a different MRP / rate / size auto-creates a new variant. Best for textiles, garments — each combination is its own SKU.
                        </div>
                      </Radio>
                      <Radio value="single">
                        <span style={{ fontWeight: 500 }}>Single Product (Tally-style)</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>
                          One product, many purchase prices over time. Cost tracked as weighted average. Best for FMCG, hardware, pharma. Required for batch tracking.
                        </div>
                      </Radio>
                    </Radio.Group>
                  </Form.Item>
                </div>
              </div>

              <div className="ms-row-stacked">
                <div className="ms-row-label">GST calculation mode</div>
                <div className="ms-row-desc">How GST is applied on sales bills.</div>
                <div className="ms-row-stacked-control" style={{ marginTop: 10 }}>
                  <Form.Item name="gst_mode" noStyle>
                    <Radio.Group>
                      <Radio value="product">
                        <span style={{ fontWeight: 500 }}>Product-wise</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>
                          Each product carries its own GST rate; CGST/SGST/IGST auto-calculated from line items.
                        </div>
                      </Radio>
                      <Radio value="bill">
                        <span style={{ fontWeight: 500 }}>Bill-wise</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>
                          Enter CGST%, SGST%, IGST% manually on the whole bill total.
                        </div>
                      </Radio>
                    </Radio.Group>
                  </Form.Item>
                </div>
              </div>
            </section>

            {/* ── Bill numbering ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Bill numbering</h2>
                <p className="ms-section-desc">
                  Prefix prepended to auto-generated bill numbers. Leave blank for plain numbers like 0001, 0002…
                </p>
              </div>
              <div className="ms-prefix-grid">
                <Form.Item name="sales_bill_prefix" label="Sales prefix"
                           extra={<span className="ms-row-desc">e.g. <b>INV</b> → <b>INV-0001</b></span>}
                           style={{ marginBottom: 0 }}>
                  <Input placeholder="INV" maxLength={10}
                         style={{ textTransform: 'uppercase' }}
                         onChange={(e) => (e.target.value = e.target.value.toUpperCase())} />
                </Form.Item>
                <Form.Item name="purchase_bill_prefix" label="Purchase prefix"
                           extra={<span className="ms-row-desc">e.g. <b>PUR</b> → <b>PUR-0001</b></span>}
                           style={{ marginBottom: 0 }}>
                  <Input placeholder="PUR" maxLength={10}
                         style={{ textTransform: 'uppercase' }}
                         onChange={(e) => (e.target.value = e.target.value.toUpperCase())} />
                </Form.Item>
              </div>
            </section>

            {/* ── Aging & due dates ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Aging &amp; due dates</h2>
                <p className="ms-section-desc">
                  Defines how "Due Days" is shown on Payment / Receipt windows and how unpaid bills bucket on the Customers / Suppliers page.
                </p>
              </div>

              <div className="ms-row-stacked">
                <div className="ms-row-label">Sales bills (Receipt entry)</div>
                <div className="ms-row-stacked-control">
                  <Form.Item name="sale_due_days_mode" noStyle>
                    <Radio.Group>
                      <Radio value="bill_date">
                        <span style={{ fontWeight: 500 }}>From bill date</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>Age of bill — days since creation.</div>
                      </Radio>
                      <Radio value="due_date">
                        <span style={{ fontWeight: 500 }}>From due date</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>"Overdue X days" past due, or "Due in X days" upcoming.</div>
                      </Radio>
                    </Radio.Group>
                  </Form.Item>
                </div>
              </div>

              <div className="ms-row-stacked">
                <div className="ms-row-label">Purchase bills (Payment entry)</div>
                <div className="ms-row-stacked-control">
                  <Form.Item name="purchase_due_days_mode" noStyle>
                    <Radio.Group>
                      <Radio value="bill_date">
                        <span style={{ fontWeight: 500 }}>From bill date</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>Age of bill — days since creation.</div>
                      </Radio>
                      <Radio value="due_date">
                        <span style={{ fontWeight: 500 }}>From due date</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>"Overdue X days" past due, or "Due in X days" upcoming.</div>
                      </Radio>
                    </Radio.Group>
                  </Form.Item>
                </div>
              </div>

              <div className="ms-row-stacked">
                <div className="ms-row-label">Aging buckets</div>
                <div className="ms-row-desc">
                  Days past a bill's due date for each bucket. Default 30 / 60 / 90.
                </div>
                <div className="ms-aging-grid">
                  <Form.Item name="aging_bucket_1_days" label="Not yet due"
                             extra={<span className="ms-row-desc">0 – N days past due</span>}>
                    <InputNumber min={1} max={365} addonAfter="days" />
                  </Form.Item>
                  <Form.Item name="aging_bucket_2_days" label="Watchful"
                             extra={<span className="ms-row-desc">First → second threshold</span>}>
                    <InputNumber min={2} max={365} addonAfter="days" />
                  </Form.Item>
                  <Form.Item name="aging_bucket_3_days" label="Chase"
                             extra={<span className="ms-row-desc">Beyond is Critical</span>}>
                    <InputNumber min={3} max={720} addonAfter="days" />
                  </Form.Item>
                </div>
              </div>
            </section>

            {/* ── Danger zone ── */}
            <section className="ms-section ms-danger">
              <div className="ms-section-head">
                <h2 className="ms-section-title">
                  <WarningOutlined /> Danger zone
                </h2>
                <p className="ms-section-desc">
                  Permanent destructive actions. Take a backup before proceeding.
                </p>
              </div>
              <div className="ms-row">
                <div>
                  <div className="ms-row-label">Clean / reset data</div>
                  <div className="ms-row-desc">
                    Delete sales, purchases, payments, products, parties, and more — by category, with admin password confirmation.
                  </div>
                </div>
                <div className="ms-row-control">
                  <Button danger icon={<DeleteOutlined />} onClick={() => setCleanupOpen(true)}>
                    Clean / reset…
                  </Button>
                </div>
              </div>
            </section>

          </Form>
        </div>
      </div>

      <CleanupModal open={cleanupOpen} onClose={() => setCleanupOpen(false)} />

      <ActionStrip
        actions={[
          { id: 'back', key: 'Esc', label: 'Back', onAction: () => navigate('/settings') },
          { id: 'save', key: 'F1', label: 'Save', tone: 'primary',
            disabled: saving || loading, onAction: () => form.submit() },
        ]}
      />
    </div>
  );
}
