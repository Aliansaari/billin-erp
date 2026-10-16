import React from 'react';
import { Form, Radio } from 'antd';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import {
  SettingsPage, Section, ToggleRow, NumberRow, ChoiceRow, Choice, LinkRow,
  useSystemSlice, SaveStrip,
} from './settingsKit';

/**
 * Stock & Products — how products are set up and how stock is counted.
 *
 * Default product mode, cost of goods sold method, stock alerts,
 * godowns, batches and colours. (Selling past zero stock lives on the
 * Sales Bill page, where it bites.)
 */
const read = (s) => ({
  default_product_mode:     s.default_product_mode || 'variant',
  cogs_method:              s.cogs_method || 'weighted_avg',
  low_stock_alert_enabled:  !!s.low_stock_alert_enabled,
  multi_warehouse_enabled:  !!s.multi_warehouse_enabled,
  batch_tracking_enabled:   !!s.batch_tracking_enabled,
  batch_expiry_alert_days:  s.batch_expiry_alert_days ?? 30,
  block_expired_sales:      !!s.block_expired_sales,
  allow_zero_stock_batches: s.allow_zero_stock_batches ?? true,
  single_color_enabled:     !!s.single_color_enabled,
  multi_color_enabled:      !!s.multi_color_enabled,
});

const write = (v) => ({ ...v });

export default function StockSettings() {
  const [form] = Form.useForm();
  const { loading, saving, save } = useSystemSlice(form, {
    read, write, savedText: 'Stock & Products settings saved',
  });
  const batchOn = Form.useWatch('batch_tracking_enabled', form);
  const warehouseOn = Form.useWatch('multi_warehouse_enabled', form);
  const sys = useSystemSettings();

  return (
    <SettingsPage
      title="Stock & Products"
      sub={<>How new products are set up and how stock is counted. Save with <kbd>F1</kbd>.</>}
      strip={<SaveStrip form={form} loading={loading} saving={saving} />}
    >
      <Form form={form} onFinish={save} disabled={loading}>
        <Section title="New products">
          <ChoiceRow label="Default product mode"
                     desc="For new products only. Products you already have keep their mode.">
            <Form.Item name="default_product_mode" noStyle>
              <Radio.Group>
                <Radio value="variant"><Choice title="Variant"
                  note="A purchase at a different MRP, rate or size makes a new variant. Best for garments and textiles, where each combination is its own item." /></Radio>
                <Radio value="single"><Choice title="Single product"
                  note="One product, many purchase prices over time, costed at the average. Best for FMCG, hardware and pharma. Needed for batch tracking." /></Radio>
              </Radio.Group>
            </Form.Item>
          </ChoiceRow>
          <ChoiceRow label="Cost of goods sold method"
                     desc="How the cost of an item is worked out when it sells. A product can override this in its own form. Change it only at the start of a financial year, after a stock count.">
            <Form.Item name="cogs_method" noStyle>
              <Radio.Group>
                <Radio value="weighted_avg"><Choice title="Weighted average"
                  note="One running average cost per product, updated on every purchase. Simple, and right for most shops." /></Radio>
                <Radio value="fifo"><Choice title="FIFO (first in, first out)"
                  note="Sales use up the oldest purchases first, each at its own rate. Matches AS-2; best when purchase rates swing." /></Radio>
              </Radio.Group>
            </Form.Item>
          </ChoiceRow>
        </Section>

        <Section title="Stock">
          <ToggleRow name="low_stock_alert_enabled" label="Stock alerts"
                     desc="Tell me when a product falls below its minimum stock." />
          <ToggleRow name="multi_warehouse_enabled" label="Multi-warehouse"
                     desc="Keep stock in more than one godown and move it between them." />
          {(warehouseOn || sys?.multi_warehouse_enabled) && (
            <LinkRow to="/settings/godowns" label="Godowns" desc="Add and name your godowns." />
          )}
        </Section>

        <Section title="Batches and expiry">
          <ToggleRow name="batch_tracking_enabled" label="Batch tracking"
                     desc="Group stock into batches with their own dates, quantity and optional expiry. Turn it on per product in the product form." />
          {batchOn && (
            <div className="ms-nested">
              <NumberRow name="batch_expiry_alert_days" label="Expiry alert"
                         desc="Batches this close to expiry are flagged on the picker and the Expiry Report."
                         min={1} suffix="days" />
              <ToggleRow name="block_expired_sales" label="Block expired batches on sale"
                         desc="On: a sale line from an expired batch won't save. Off: allowed (common in wholesale)." />
              <ToggleRow name="allow_zero_stock_batches" label="Allow zero-stock batches"
                         desc="On: make a batch before its stock arrives. Off: batches come only from purchase bills." />
            </div>
          )}
        </Section>

        <Section title="Colours">
          <ToggleRow name="single_color_enabled" label="Single color label"
                     desc="An optional Color field on the product, for filters and reports. A product uses either this or multi-color stock." />
          <ToggleRow name="multi_color_enabled" label="Multi-color stock"
                     desc="Count stock per colour for products that come in several. Color box on purchase, colour list on sale. Turn it on per product." />
        </Section>
      </Form>
    </SettingsPage>
  );
}
