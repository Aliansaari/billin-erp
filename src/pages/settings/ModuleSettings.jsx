import React, { useEffect, useState } from 'react';
import { Form, Switch, InputNumber, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { settingsAPI } from '../../api';
import { refreshSystemSettings } from '../../hooks/useSystemSettings';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

/* ── Reusable row primitives — keep the visual rhythm uniform ── */

function ToggleRow({ name, label, desc, onChange, disabled }) {
  return (
    <div className="ms-row" data-disabled={disabled || undefined}>
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">
        <Form.Item name={name} valuePropName="checked" noStyle>
          <Switch onChange={onChange} disabled={disabled} />
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
  // Live mirror of the multi-color toggle so the "Merge repeat scans"
  // switch disables/locks-off the moment the user flicks multi-color
  // ON, without waiting for a save round-trip. Mirrors the batch
  // tracking pattern below.
  const [multiColorOn, setMultiColorOn] = useState(false);

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
        // Color tracking — three independent module toggles. See the
        // ToggleRow descriptions below for the per-toggle semantics.
        single_color_enabled:        !!s.single_color_enabled,
        multi_color_enabled:         !!s.multi_color_enabled,
        merge_repeat_scans_enabled:  !!s.merge_repeat_scans_enabled,
        batch_tracking_enabled:  !!s.batch_tracking_enabled,
        batch_expiry_alert_days: s.batch_expiry_alert_days ?? 30,
        block_expired_sales:     !!s.block_expired_sales,
        allow_zero_stock_batches: s.allow_zero_stock_batches ?? true,
      });
      setBatchTrackingOn(!!s.batch_tracking_enabled);
      setMultiColorOn(!!s.multi_color_enabled);
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

            {/* ── Taxation ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Taxation</h2>
                <p className="ms-section-desc">
                  Tax computation on invoices and reports.
                </p>
              </div>
              <ToggleRow name="gst_enabled" label="GST"
                         desc="Run GST calculations on invoices and reports." />
            </section>

            {/* ── Billing & Sales ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Billing &amp; Sales</h2>
                <p className="ms-section-desc">
                  How the Sales Bill form behaves while you enter invoices.
                </p>
              </div>
              <ToggleRow name="enable_amount_only_billing" label="Amount-only billing"
                         desc="Adds an Itemised / Amount-only mode toggle on the Sales Bill form for service or on-account bills." />
              <ToggleRow name="merge_repeat_scans_enabled" label="Merge repeat scans"
                         disabled={multiColorOn}
                         desc={multiColorOn
                           ? 'Locked off while Multi-color stock is on — merging different-color picks across scans would break per-color tracking.'
                           : 'Sales form: same barcode scanned multiple times merges into one line with combined quantity. OFF = each scan is a separate line.'} />
            </section>

            {/* ── Inventory & Stock ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Inventory &amp; Stock</h2>
                <p className="ms-section-desc">
                  Stock control, warehousing, and batch / expiry tracking.
                </p>
              </div>
              <ToggleRow name="low_stock_alert_enabled" label="Stock alerts"
                         desc="Notify when stock falls below the per-product minimum." />
              <ToggleRow name="allow_negative_stock" label="Allow negative stock"
                         desc="ON — sales pass even if quantity goes below zero (shown in red). OFF — block the sale." />
              <ToggleRow name="multi_warehouse_enabled" label="Multi-warehouse"
                         desc="Track stock across multiple godowns." />
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

            {/* ── Product Variants ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Product Variants</h2>
                <p className="ms-section-desc">
                  Colour tracking for products that ship in more than one variant.
                </p>
              </div>
              <ToggleRow name="single_color_enabled" label="Single color label"
                         desc="Adds an optional Color text field on the product master. Pure metadata for filtering and reports. Mutually exclusive per-product with multi-color tracking." />
              <ToggleRow name="multi_color_enabled" label="Multi-color stock"
                         desc="Track per-color stock for products that come in multiple colors. Color box on purchase, color dropdown on sale. Per-product opt-in via the product form."
                         onChange={setMultiColorOn} />
            </section>

            {/* ── System & Audit ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">System &amp; Audit</h2>
                <p className="ms-section-desc">
                  Record-keeping and change history.
                </p>
              </div>
              <ToggleRow name="audit_trail_enabled" label="Audit trail"
                         desc="Record every change to bills and master records." />
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
