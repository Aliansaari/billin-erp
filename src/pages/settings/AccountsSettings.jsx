import React from 'react';
import { Form, InputNumber } from 'antd';
import {
  SettingsPage, Section, ToggleRow, ChoiceRow, LinkRow,
  useSystemSlice, SaveStrip,
} from './settingsKit';

/**
 * Tax & Accounts — GST, back-dated entries, how overdue bills are
 * bucketed, and the audit trail.
 */
const read = (s) => ({
  gst_enabled:             !!s.gst_enabled,
  allow_backdated_entries: s.allow_backdated_entries !== false,
  aging_bucket_1_days:     s.aging_bucket_1_days ?? 30,
  aging_bucket_2_days:     s.aging_bucket_2_days ?? 60,
  aging_bucket_3_days:     s.aging_bucket_3_days ?? 90,
  audit_trail_enabled:     !!s.audit_trail_enabled,
});

const write = (v) => {
  // Thresholds must climb: Not yet due < Watchful < Chase (< Critical).
  const b1 = Math.max(1,      parseInt(v.aging_bucket_1_days, 10) || 30);
  const b2 = Math.max(b1 + 1, parseInt(v.aging_bucket_2_days, 10) || 60);
  const b3 = Math.max(b2 + 1, parseInt(v.aging_bucket_3_days, 10) || 90);
  return {
    gst_enabled:             !!v.gst_enabled,
    allow_backdated_entries: !!v.allow_backdated_entries,
    aging_bucket_1_days: b1, aging_bucket_2_days: b2, aging_bucket_3_days: b3,
    audit_trail_enabled:     !!v.audit_trail_enabled,
  };
};

export default function AccountsSettings() {
  const [form] = Form.useForm();
  const { loading, saving, save } = useSystemSlice(form, { read, write, savedText: 'Tax & Accounts settings saved' });

  return (
    <SettingsPage
      title="Tax & Accounts"
      sub={<>GST, entry dates, overdue buckets and the change history. Save with <kbd>F1</kbd>.</>}
      strip={<SaveStrip form={form} loading={loading} saving={saving} />}
    >
      <Form form={form} onFinish={save} disabled={loading}>
        <Section title="Tax">
          <ToggleRow name="gst_enabled" label="GST"
                     desc="Work out GST on bills and show it in reports. How it is worked out on a sale is set in Sales Bill." />
        </Section>

        <Section title="Entries">
          <ToggleRow name="allow_backdated_entries" label="Allow back-dated entries"
                     desc="On: bills, payments, vouchers and EMIs can be dated before today, for roles allowed to (Users & Roles). Off: everyone is held to today or later." />
          <ToggleRow name="audit_trail_enabled" label="Audit trail"
                     desc="Keep a record of every change to bills and master records." />
        </Section>

        <Section title="Overdue buckets"
                 desc="How unpaid bills are grouped on the Customers and Suppliers pages, by days past the due date.">
          <ChoiceRow label="Bucket limits" desc="Beyond the last limit a bill is Critical. Default 30 / 60 / 90.">
            <div className="ms-aging-grid">
              <Form.Item name="aging_bucket_1_days" label="Not yet due" layout="vertical">
                <InputNumber min={1} max={365} addonAfter="days" />
              </Form.Item>
              <Form.Item name="aging_bucket_2_days" label="Watchful" layout="vertical">
                <InputNumber min={2} max={365} addonAfter="days" />
              </Form.Item>
              <Form.Item name="aging_bucket_3_days" label="Chase" layout="vertical">
                <InputNumber min={3} max={720} addonAfter="days" />
              </Form.Item>
            </div>
          </ChoiceRow>
        </Section>

        <Section title="Related">
          <LinkRow to="/settings/financial-year" label="Financial Year" desc="Year dates and compliance locks." />
          <LinkRow to="/settings/users" label="Users & Roles" desc="Who may enter back-dated bills." />
        </Section>
      </Form>
    </SettingsPage>
  );
}
