/**
 * CustomerInsightSettings.jsx
 *
 * Settings page for toggling which sections appear in the F8 Customer
 * Insight Panel. Follows the same layout / form pattern as ModuleSettings.
 */

import React, { useEffect, useState } from 'react';
import { Form, Switch, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { settingsAPI } from '../../api';
import { refreshSystemSettings } from '../../hooks/useSystemSettings';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';
import './CustomerInsightSettings.css';

/* ── Reusable toggle row (same pattern as ModuleSettings) ─────────────────── */

function ToggleRow({ name, label, desc }) {
  return (
    <div className="ms-row">
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">
        <Form.Item name={name} valuePropName="checked" noStyle>
          <Switch />
        </Form.Item>
      </div>
    </div>
  );
}

/* ── Page component ───────────────────────────────────────────────────────── */

export default function CustomerInsightSettings() {
  const navigate  = useNavigate();
  const [form]    = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);

  useEffect(() => { loadSettings(); }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const { data } = await settingsAPI.getSystem();
      // Handle both { data: settings } and bare settings shapes
      const s = (data && data.data) ? data.data : data;
      if (!s) throw new Error('No settings returned');
      form.setFieldsValue({
        insight_show_fy_metrics:      s.insight_show_fy_metrics      ?? true,
        insight_show_alltime_metrics: s.insight_show_alltime_metrics ?? true,
        insight_show_profit:          s.insight_show_profit          ?? true,
        insight_show_behavior:        s.insight_show_behavior        ?? true,
        insight_show_top_products:    s.insight_show_top_products    ?? true,
        insight_show_bill_stats:      s.insight_show_bill_stats      ?? true,
        insight_show_pay_time:        s.insight_show_pay_time        ?? true,
        insight_show_lifetime_profit: s.insight_show_lifetime_profit ?? true,
      });
    } catch (err) {
      console.error('CustomerInsightSettings load error:', err);
      message.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (values) => {
    setSaving(true);
    try {
      await settingsAPI.updateSystem(values);
      await refreshSystemSettings().catch(() => {});
      message.success('Insight panel settings saved');
    } catch (err) {
      console.error('CustomerInsightSettings save error:', err);
      message.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Party Insight Panel</h1>
        <p className="ms-page-sub">
          Control which sections appear when you press <kbd>F8</kbd> on a customer
          (Sales) or a supplier (Purchase). Save via <kbd>F1</kbd>.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Form form={form} onFinish={handleSave} disabled={loading}>

            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Party Insight Panel (F8)</h2>
                <p className="ms-section-desc">
                  Each toggle shows or hides one section of the insight panel —
                  applied to both the customer (Sales) and supplier (Purchase)
                  views. Profit-based sections only appear for customers, since
                  margin isn't attributed to a supplier. Hiding sections you don't
                  need keeps the panel fast and focused.
                </p>
              </div>

              <div className="cis-section-header">Financial Year</div>
              <ToggleRow
                name="insight_show_fy_metrics"
                label="Current Year (FY) metrics"
                desc="Bills count, revenue, average bill, discounts for the current financial year."
              />
              <ToggleRow
                name="insight_show_profit"
                label="Profit &amp; margin"
                desc="Gross profit and margin % derived from COGS (requires cost data on items). Shown inside the FY section."
              />

              <div className="cis-section-header" style={{ marginTop: 16 }}>All Time</div>
              <ToggleRow
                name="insight_show_alltime_metrics"
                label="All-time metrics"
                desc="Lifetime bills and revenue / spend totals."
              />
              <ToggleRow
                name="insight_show_lifetime_profit"
                label="Lifetime profit &amp; margin"
                desc="All-time gross profit and margin % across every bill (customers only). Shown inside the All-Time section."
              />
              <ToggleRow
                name="insight_show_bill_stats"
                label="Bill statistics"
                desc="Largest / smallest bill amounts and payment status breakdown (Paid / Partial / Unpaid)."
              />

              <div className="cis-section-header" style={{ marginTop: 16 }}>Behavior &amp; Products</div>
              <ToggleRow
                name="insight_show_behavior"
                label="Visit / purchase behavior"
                desc="Last visit, frequency, preferred payment mode."
              />
              <ToggleRow
                name="insight_show_pay_time"
                label="Average pay time"
                desc="Average days a bill takes to be fully settled (how long the customer takes to pay, or how long you take to pay the supplier)."
              />
              <ToggleRow
                name="insight_show_top_products"
                label="Top products"
                desc="Top 5 products by value this party has traded."
              />
            </section>

          </Form>
        </div>
      </div>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/settings'),
          },
          {
            id: 'save', key: 'F1', label: 'Save', tone: 'primary',
            disabled: saving || loading,
            onAction: () => form.submit(),
          },
        ]}
      />
    </div>
  );
}
