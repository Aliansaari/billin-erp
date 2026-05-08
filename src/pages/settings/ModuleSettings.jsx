import React, { useEffect, useState } from 'react';
import { Form, Switch, InputNumber, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { settingsAPI } from '../../api';
import { refreshSystemSettings } from '../../hooks/useSystemSettings';
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

export default function ModuleSettings() {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
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
      await settingsAPI.updateSystem(values);
      // Invalidate the shared system-settings cache so consumers
      // (sidebar, settings rail, every bill form) re-render with the
      // new flag values immediately, no reload required.
      await refreshSystemSettings().catch(() => {});
      message.success('Features saved');
    } catch (error) {
      console.error('FeaturesSettings save error:', error);
      message.error('Failed to save features');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Features</h1>
        <p className="ms-page-sub">
          Master toggles for modules and capabilities. OFF here = the feature is hidden across the app.
          Save via <kbd>F1</kbd>.
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

          </Form>
        </div>
      </div>

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
