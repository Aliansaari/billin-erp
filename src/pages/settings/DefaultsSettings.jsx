import React, { useEffect, useState } from 'react';
import { Form, Input, InputNumber, Radio, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { settingsAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

/**
 * DefaultsSettings — "how the app behaves by default" knobs.
 *
 * Lives next to Features in the Settings hub. Holds the
 * company-wide configuration that's neither a feature toggle
 * (Features) nor a destructive action (Backup & Recovery): default
 * product mode, GST calculation, bill numbering prefixes,
 * aging-bucket thresholds, and due-day display modes.
 *
 * Reads from settingsAPI.getSystem() / .updateSystem() — same
 * endpoint the Features page uses, but writes only its own subset
 * so the two pages don't clobber each other's fields.
 */
export default function DefaultsSettings() {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);

  useEffect(() => { loadSettings(); }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const { data } = await settingsAPI.getSystem();
      const s = (data && data.data) ? data.data : data;
      if (!s) throw new Error('No settings returned');
      form.setFieldsValue({
        default_product_mode:    s.default_product_mode || 'variant',
        gst_mode:                localStorage.getItem('gst_mode') || 'product',
        sales_bill_prefix:       s.sales_bill_prefix    || '',
        purchase_bill_prefix:    s.purchase_bill_prefix || '',
        sale_due_days_mode:      localStorage.getItem('sale_due_days_mode')     || 'bill_date',
        purchase_due_days_mode:  localStorage.getItem('purchase_due_days_mode') || 'bill_date',
        aging_bucket_1_days:     s.aging_bucket_1_days ?? 30,
        aging_bucket_2_days:     s.aging_bucket_2_days ?? 60,
        aging_bucket_3_days:     s.aging_bucket_3_days ?? 90,
        // Audit H6 — company-wide default for Cost of Goods Sold.
        cogs_method:             s.cogs_method || 'weighted_avg',
      });
    } catch (error) {
      console.error('DefaultsSettings load error:', error);
      message.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (values) => {
    setSaving(true);
    try {
      // Display preferences live in localStorage (no DB column).
      localStorage.setItem('sale_due_days_mode',     values.sale_due_days_mode     || 'bill_date');
      localStorage.setItem('purchase_due_days_mode', values.purchase_due_days_mode || 'bill_date');
      localStorage.setItem('gst_mode',               values.gst_mode               || 'product');

      // Everything else is on the SystemSettings model.
      const { sale_due_days_mode, purchase_due_days_mode, gst_mode, ...dbValues } = values;
      if (dbValues.sales_bill_prefix)    dbValues.sales_bill_prefix    = dbValues.sales_bill_prefix.trim().toUpperCase();
      if (dbValues.purchase_bill_prefix) dbValues.purchase_bill_prefix = dbValues.purchase_bill_prefix.trim().toUpperCase();

      // Enforce strictly-increasing aging thresholds so Watchful < Chase < Critical.
      const b1 = Math.max(1,      parseInt(dbValues.aging_bucket_1_days, 10) || 30);
      const b2 = Math.max(b1 + 1, parseInt(dbValues.aging_bucket_2_days, 10) || 60);
      const b3 = Math.max(b2 + 1, parseInt(dbValues.aging_bucket_3_days, 10) || 90);
      dbValues.aging_bucket_1_days = b1;
      dbValues.aging_bucket_2_days = b2;
      dbValues.aging_bucket_3_days = b3;

      await settingsAPI.updateSystem(dbValues);
      message.success('Defaults saved');
    } catch (error) {
      console.error('DefaultsSettings save error:', error);
      message.error('Failed to save defaults');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Defaults</h1>
        <p className="ms-page-sub">
          How the app behaves by default — product mode, GST calculation, document numbering, and aging.
          Save together via <kbd>F1</kbd>.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Form form={form} onFinish={handleSave} disabled={loading}>

            {/* ── Product mode + GST ── */}
            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Behaviour</h2>
                <p className="ms-section-desc">
                  Master defaults for new products and how tax is applied on bills.
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

              {/* Audit H6 — company-wide Cost of Goods Sold method. Per-product
                  override is on the Product form; this is the default that
                  inheriting products follow. Change only at the start of a
                  financial year, after a clean stock-take. */}
              <div className="ms-row-stacked">
                <div className="ms-row-label">Cost of Goods Sold method (default)</div>
                <div className="ms-row-desc">
                  Drives how COGS is calculated when items are sold. Each product can override this in its own form;
                  most products should be set to "Inherit" so they follow this default.
                  <br/><b>Important:</b> change this at the start of a financial year after a stock-take — flipping mid-period
                  produces mixed-method P&L that's hard to audit.
                </div>
                <div className="ms-row-stacked-control" style={{ marginTop: 10 }}>
                  <Form.Item name="cogs_method" noStyle>
                    <Radio.Group>
                      <Radio value="weighted_avg">
                        <span style={{ fontWeight: 500 }}>Weighted Average</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>
                          One running average cost per product, recomputed on every purchase. Smooths rate changes — simple, fast, fine for most steady-price businesses. This is the safe default.
                        </div>
                      </Radio>
                      <Radio value="fifo">
                        <span style={{ fontWeight: 500 }}>FIFO (First-In, First-Out)</span>
                        <div className="ms-row-desc" style={{ marginLeft: 24 }}>
                          Sales consume the oldest purchase lots first; each sale's cost is the exact rate of the consumed lot. Matches accounting standard AS-2 (India) and produces audit-clean inventory valuations. Best for rate-volatile businesses (textiles, electronics, commodities).
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
                  How "Due Days" is shown on Payment / Receipt windows and how unpaid bills bucket on the Customers / Suppliers page.
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
