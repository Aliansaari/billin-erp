import React from 'react';
import { Form, Input, Radio } from 'antd';
import {
  SettingsPage, Section, ToggleRow, ControlRow, ChoiceRow, Choice, LinkRow,
  useSystemSlice, SaveStrip,
} from './settingsKit';

/**
 * Sales Bill — everything that changes how the sale window behaves.
 *
 * Gathers the switches an operator looks for while billing, which used to
 * be split between Features and Defaults: amount-only mode, repeat-scan
 * merging, selling past zero stock, the bill-number prefix, how GST is
 * worked out, and how due days read on receipts.
 *
 * GST mode and the due-days display are this computer's preferences
 * (localStorage, as before); the rest is company-wide.
 */
const read = (s) => ({
  enable_amount_only_billing: s.enable_amount_only_billing ?? true,
  merge_repeat_scans_enabled: !!s.merge_repeat_scans_enabled,
  allow_negative_stock:       !!s.allow_negative_stock,
  sales_bill_prefix:          s.sales_bill_prefix || '',
  gst_mode:                   localStorage.getItem('gst_mode') || 'product',
  sale_due_days_mode:         localStorage.getItem('sale_due_days_mode') || 'bill_date',
  parcel_tag_on_sale_form:    s.parcel_tag_on_sale_form !== false,
});

const write = (v) => {
  localStorage.setItem('gst_mode',           v.gst_mode || 'product');
  localStorage.setItem('sale_due_days_mode', v.sale_due_days_mode || 'bill_date');
  return {
    enable_amount_only_billing: !!v.enable_amount_only_billing,
    merge_repeat_scans_enabled: !!v.merge_repeat_scans_enabled,
    allow_negative_stock:       !!v.allow_negative_stock,
    sales_bill_prefix:          (v.sales_bill_prefix || '').trim().toUpperCase(),
    parcel_tag_on_sale_form:    v.parcel_tag_on_sale_form !== false,
  };
};

export default function SalesBillSettings() {
  const [form] = Form.useForm();
  const { loading, saving, save, raw } = useSystemSlice(form, { read, write, savedText: 'Sales Bill settings saved' });
  const multiColorOn = !!raw?.multi_color_enabled;
  const shownPrefix = (Form.useWatch('sales_bill_prefix', form) || '').trim().toUpperCase();

  return (
    <SettingsPage
      title="Sales Bill"
      sub={<>How the sale window behaves while you bill. Save with <kbd>F1</kbd>.</>}
      strip={<SaveStrip form={form} loading={loading} saving={saving} />}
    >
      <Form form={form} onFinish={save} disabled={loading}>
        <Section title="While billing">
          <ToggleRow name="merge_repeat_scans_enabled" label="Merge repeat scans"
                     disabled={multiColorOn}
                     desc={multiColorOn
                       ? 'Locked off while Multi-color stock is on (Stock & Products), because merging different colours would break per-colour stock.'
                       : 'Scanning the same barcode again adds to the quantity of the line already on the bill. Off: every scan is its own line.'} />
          <ToggleRow name="enable_amount_only_billing" label="Amount-only billing"
                     desc="Adds an Itemised / Amount-only switch on the sale window, for service or on-account bills with no items." />
          <ToggleRow name="parcel_tag_on_sale_form" label="Parcel label button"
                     desc="The box button beside Add customer that prints 10 × 10 cm carton labels. Design and options: Parcel Labels." />
          <ToggleRow name="allow_negative_stock" label="Sell when stock runs out"
                     desc="On: a sale still saves when it takes stock below zero (shown in red). Off: the sale is blocked. Also known as allow negative stock." />
        </Section>

        <Section title="Bill number">
          <ControlRow label="Sales bill prefix"
                      desc={<>Put in front of every new sale bill number. {shownPrefix
                        ? <>Next bill looks like <b>{shownPrefix}-0001</b>.</>
                        : <>Blank: plain numbers like <b>0001</b>.</>}</>}>
            <Form.Item name="sales_bill_prefix" noStyle>
              <Input placeholder="INV" maxLength={10} style={{ width: 150, textTransform: 'uppercase' }} />
            </Form.Item>
          </ControlRow>
        </Section>

        <Section title="Tax and due days" desc="These two apply to this computer only.">
          <ChoiceRow label="GST calculation mode" desc="How GST is worked out on a sale bill.">
            <Form.Item name="gst_mode" noStyle>
              <Radio.Group>
                <Radio value="product"><Choice title="Product-wise" note="Each product carries its own GST rate; CGST, SGST and IGST are worked out from the lines." /></Radio>
                <Radio value="bill"><Choice title="Bill-wise" note="Type CGST %, SGST % and IGST % once for the whole bill total." /></Radio>
              </Radio.Group>
            </Form.Item>
          </ChoiceRow>
          <ChoiceRow label="Due days on receipts" desc="What the Due Days column counts from when you take a payment against sale bills.">
            <Form.Item name="sale_due_days_mode" noStyle>
              <Radio.Group>
                <Radio value="bill_date"><Choice title="From bill date" note="Age of the bill: days since it was made." /></Radio>
                <Radio value="due_date"><Choice title="From due date" note={'Shows "Overdue 5 days" or "Due in 3 days".'} /></Radio>
              </Radio.Group>
            </Form.Item>
          </ChoiceRow>
        </Section>

        <Section title="Related">
          <LinkRow to="/settings/print" label="Print Templates" desc="What the printed sale bill looks like." />
          <LinkRow to="/settings/salesmen" label="Salesmen" desc="Staff you can credit on a bill." />
          <LinkRow to="/settings/customer-insight" label="Party Insight" desc="The F8 panel with a customer's history." />
          <LinkRow to="/settings/membership" label="Membership" desc="Loyalty points and plans on the sale bill." />
        </Section>
      </Form>
    </SettingsPage>
  );
}
