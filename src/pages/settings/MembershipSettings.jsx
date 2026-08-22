import React, { useEffect, useRef, useState } from 'react';
import { Form, Switch, InputNumber, Select, Button, message } from 'antd';
import { TagsOutlined, UsergroupAddOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { settingsAPI } from '../../api';
import { refreshSystemSettings } from '../../hooks/useSystemSettings';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './ModuleSettings.css';

/* Row primitives — mirror the Features page so the visual rhythm is uniform. */
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
function SelectRow({ name, label, desc, options }) {
  return (
    <div className="ms-row">
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">
        <Form.Item name={name} noStyle>
          <Select options={options} style={{ width: 200 }} />
        </Form.Item>
      </div>
    </div>
  );
}

/*
 * Settings → Membership.
 *
 * The loyalty module's own home (no longer buried under Features). Master
 * switch + billing/points/reminder behaviour, plus quick links to where the
 * tiers (and their earn rates) are defined and where existing customers are
 * enrolled in bulk.
 */
export default function MembershipSettings() {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [on, setOn] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await settingsAPI.getSystem();
      const s = (data && data.data) ? data.data : data;
      form.setFieldsValue({
        membership_enabled:               !!s.membership_enabled,
        membership_no_source:             s.membership_no_source || 'mobile',
        membership_auto_discount_enabled: !!s.membership_auto_discount_enabled,
        membership_points_enabled:        !!s.membership_points_enabled,
        membership_redeem_enabled:        !!s.membership_redeem_enabled,
        membership_redeem_value_per_point: s.membership_redeem_value_per_point ?? 1,
        membership_points_min_redeem:     s.membership_points_min_redeem ?? 0,
        membership_points_expiry_months:  s.membership_points_expiry_months ?? 0,
        membership_show_sales_panel:       s.membership_show_sales_panel ?? true,
        membership_remind_expiry:         !!s.membership_remind_expiry,
        membership_expiry_reminder_days:  s.membership_expiry_reminder_days ?? 7,
        membership_remind_birthday:       !!s.membership_remind_birthday,
      });
      setOn(!!s.membership_enabled);
      loadedRef.current = true;   // enable auto-save only after initial load
    } catch (e) {
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
      message.success('Membership settings saved');
    } catch (e) {
      message.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // AUTO-SAVE: every change on this page persists on its own (debounced), so
  // no toggle or field can be "lost" by forgetting to press Save. This is why
  // turning membership on now always sticks. F1 still forces an immediate save.
  const saveTimer = useRef(null);
  const loadedRef = useRef(false);
  const autoSave = (allValues) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await settingsAPI.updateSystem(allValues);
        await refreshSystemSettings().catch(() => {});
      } catch (e) {
        message.error('Could not save membership settings — please try again');
      } finally {
        setSaving(false);
      }
    }, 500);
  };
  const onValuesChange = (changed, all) => {
    if (Object.prototype.hasOwnProperty.call(changed, 'membership_enabled')) {
      setOn(!!changed.membership_enabled);
    }
    // Ignore the programmatic setFieldsValue during initial load.
    if (loadedRef.current) autoSave(all);
  };

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header">
        <h1 className="ms-page-title">Membership</h1>
        <p className="ms-page-sub">
          Loyalty membership for your customers — cards, tier discounts, points, and reminders. Save via <kbd>F1</kbd>.
        </p>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <Form form={form} onFinish={handleSave} onValuesChange={onValuesChange} disabled={loading}>

            <section className="ms-section">
              <div className="ms-section-head">
                <h2 className="ms-section-title">Loyalty module</h2>
                <p className="ms-section-desc">The master switch. OFF hides every membership surface across the app.</p>
              </div>
              <ToggleRow name="membership_enabled" label="Enable membership"
                         desc="Applies immediately when flipped. Adds the Members list under Parties, an enrolment card on the customer details popup, and the Plans section below."
                         onChange={setOn} />
            </section>

            {on && (
              <>
                {/* Plans & earn rates — the answer to "where do I set how many
                    points a purchase earns". Each plan carries its own earn
                    rate + discount, so tiers can differ. */}
                <section className="ms-section">
                  <div className="ms-section-head">
                    <h2 className="ms-section-title">Plans &amp; earn rates</h2>
                    <p className="ms-section-desc">
                      Each membership plan (tier) defines its own <b>discount %</b> and <b>how many points members earn per ₹100 spent</b>.
                      Create your tiers — e.g. “Silver 1 pt/₹100”, “Gold 2 pts/₹100” — here.
                    </p>
                  </div>
                  <div className="ms-row">
                    <div>
                      <div className="ms-row-label">Membership plans</div>
                      <div className="ms-row-desc">Add tiers and set each one’s discount and points-per-₹100 earn rate.</div>
                    </div>
                    <div className="ms-row-control">
                      <Button icon={<TagsOutlined />} onClick={() => navigate('/settings/membership-plans')}>
                        Manage plans
                      </Button>
                    </div>
                  </div>
                  <div className="ms-row">
                    <div>
                      <div className="ms-row-label">Existing customers</div>
                      <div className="ms-row-desc">Bulk-enrol customers you already have — optionally seeding points from their past purchases.</div>
                    </div>
                    <div className="ms-row-control">
                      <Button icon={<UsergroupAddOutlined />} onClick={() => navigate('/members?bulk=1')}>
                        Enrol existing customers
                      </Button>
                    </div>
                  </div>
                </section>

                <section className="ms-section">
                  <div className="ms-section-head">
                    <h2 className="ms-section-title">Cards</h2>
                  </div>
                  <SelectRow name="membership_no_source" label="Card number default"
                             desc="What a new member's card number is pre-filled with. You can always edit it per customer."
                             options={[
                               { value: 'mobile', label: 'Customer mobile number' },
                               { value: 'manual', label: 'Type it manually' },
                               { value: 'auto',   label: 'Auto-generate' },
                             ]} />
                </section>

                <section className="ms-section">
                  <div className="ms-section-head">
                    <h2 className="ms-section-title">Billing &amp; points</h2>
                    <p className="ms-section-desc">How membership behaves on the sales bill. None of these change your existing money or tax math.</p>
                  </div>
                  <ToggleRow name="membership_show_sales_panel" label="Show member panel on the sales bill"
                             desc="When an active member is selected on a sale, show a panel beside the totals with their tier, points, discount and a redeem box. Off hides the panel (discounts/points still work)." />
                  <ToggleRow name="membership_auto_discount_enabled" label="Auto-apply tier discount"
                             desc="On a new sales bill, pre-fill the bill discount % with the member's tier discount. Never overrides a discount you typed, and never changes a saved bill." />
                  <ToggleRow name="membership_points_enabled" label="Earn loyalty points"
                             desc="A completed sale earns the member points at their plan's rate (points per ₹100). Recorded in an auditable ledger and reversed automatically if the bill is cancelled." />
                  <ToggleRow name="membership_redeem_enabled" label="Allow points redemption"
                             desc="Let a member spend points on a sale. The rupee value is applied as a bill discount and the points are deducted in the same transaction — never one without the other." />
                  <NumberRow name="membership_redeem_value_per_point" label="Value per point (₹)"
                             desc="How many rupees one point is worth when redeemed." min={0} suffix="₹" />
                  <NumberRow name="membership_points_min_redeem" label="Minimum points to redeem"
                             desc="A member must hold at least this many points before redeeming (0 = no minimum)." min={0} suffix="pts" />
                  <NumberRow name="membership_points_expiry_months" label="Points expire after"
                             desc="Points lapse after this many months with no earning or spending — any activity resets the clock. Set 0 for lifetime points (never expire)." min={0} suffix="months" />
                </section>

                <section className="ms-section">
                  <div className="ms-section-head">
                    <h2 className="ms-section-title">Reminders</h2>
                    <p className="ms-section-desc">Opt-in outreach lists in the Membership report. Nothing is auto-sent — you click to open a pre-filled WhatsApp chat.</p>
                  </div>
                  <ToggleRow name="membership_remind_expiry" label="Expiry reminders"
                             desc="Show an 'expiring soon' list in the report with a one-click WhatsApp reminder." />
                  <NumberRow name="membership_expiry_reminder_days" label="Remind within"
                             desc="A membership counts as 'expiring soon' this many days before its expiry date." min={1} suffix="days" />
                  <ToggleRow name="membership_remind_birthday" label="Birthday reminders"
                             desc="Show today's member birthdays in the report with a one-click WhatsApp greeting. Add a birth date when enrolling a member." />
                </section>
              </>
            )}

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
