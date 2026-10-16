import React from 'react';
import { Form, Input, InputNumber, Radio } from 'antd';
import { getPref, setPref, clearPref } from '../../store/prefSync';
import {
  SettingsPage, Section, ControlRow, ChoiceRow, Choice, LinkRow,
  useSystemSlice, SaveStrip,
} from './settingsKit';

/**
 * Purchase Bill — how the purchase window behaves.
 *
 * The bill-number prefix (company-wide), the fixed margin that the MG%
 * pin sets (this user's preference, follows the login: pbf_pin_margin),
 * and how due days read on payments (this computer).
 */
const read = (s) => {
  const pin = parseFloat(getPref('pbf_pin_margin', null));
  return {
    purchase_bill_prefix:   s.purchase_bill_prefix || '',
    pin_margin:             pin > 0 ? pin : null,
    purchase_due_days_mode: localStorage.getItem('purchase_due_days_mode') || 'bill_date',
  };
};

const write = (v) => {
  localStorage.setItem('purchase_due_days_mode', v.purchase_due_days_mode || 'bill_date');
  const pin = parseFloat(v.pin_margin);
  if (pin > 0) setPref('pbf_pin_margin', pin); else clearPref('pbf_pin_margin');
  return { purchase_bill_prefix: (v.purchase_bill_prefix || '').trim().toUpperCase() };
};

export default function PurchaseBillSettings() {
  const [form] = Form.useForm();
  const { loading, saving, save, raw } = useSystemSlice(form, { read, write, savedText: 'Purchase Bill settings saved' });
  const prefix = (Form.useWatch('purchase_bill_prefix', form) || '').trim().toUpperCase();
  const singleMode = raw?.default_product_mode === 'single';

  return (
    <SettingsPage
      title="Purchase Bill"
      sub={<>How the purchase window behaves while you enter stock. Save with <kbd>F1</kbd>.</>}
      strip={<SaveStrip form={form} loading={loading} saving={saving} />}
    >
      <Form form={form} onFinish={save} disabled={loading}>
        <Section title="While entering items">
          <ControlRow
            label="Fixed margin (MG%)"
            desc={singleMode
              ? 'Used only when new products are set to Variant (Stock & Products). Your products in Single mode keep their own margin.'
              : <>Every new item gets this margin and its sale rate is worked out for you. Products already in your list keep their own margin. Blank: off. In the purchase window, press <b>P</b> in MG% to set or clear it.</>}>
            <Form.Item name="pin_margin" noStyle>
              <InputNumber min={0} max={1000} step={1} placeholder="Off" addonAfter="%" style={{ width: 130 }} />
            </Form.Item>
          </ControlRow>
        </Section>

        <Section title="Bill number">
          <ControlRow label="Purchase bill prefix"
                      desc={<>Put in front of every new purchase bill number. {prefix
                        ? <>Next bill looks like <b>{prefix}-0001</b>.</>
                        : <>Blank: plain numbers like <b>0001</b>.</>}</>}>
            <Form.Item name="purchase_bill_prefix" noStyle>
              <Input placeholder="PUR" maxLength={10} style={{ width: 150, textTransform: 'uppercase' }} />
            </Form.Item>
          </ControlRow>
        </Section>

        <Section title="Due days" desc="Applies to this computer only.">
          <ChoiceRow label="Due days on payments" desc="What the Due Days column counts from when you pay a supplier against purchase bills.">
            <Form.Item name="purchase_due_days_mode" noStyle>
              <Radio.Group>
                <Radio value="bill_date"><Choice title="From bill date" note="Age of the bill: days since it was made." /></Radio>
                <Radio value="due_date"><Choice title="From due date" note={'Shows "Overdue 5 days" or "Due in 3 days".'} /></Radio>
              </Radio.Group>
            </Form.Item>
          </ChoiceRow>
        </Section>

        <Section title="Related">
          <LinkRow to="/settings/stock" label="Stock & Products" desc="Variant or single product, cost method, batches and colours." />
          <LinkRow to="/settings/barcode" label="Barcode Labels" desc="The labels you print for new stock." />
        </Section>
      </Form>
    </SettingsPage>
  );
}
