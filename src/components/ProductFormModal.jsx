// ── ProductFormModal ──────────────────────────────────────────────────
//
// Reused by Inventory → Products → Add AND the +Add Product shortcut on
// the Purchase form's entry row. Same fields, same /products POST, same
// onSaved contract — only the chrome changed (Phase 2 of the create-form
// unification work — uses the shared EntityFormModal shell).
//
// Props (unchanged from the previous Antd-Modal version):
//   open       — boolean, controlled
//   onCancel   — close without saving
//   onSaved    — called with the freshly-created product after save
//   defaultName — optional, pre-fills product_name (e.g. text the
//                 operator was typing in the picker before clicking +Add)

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import dayjs from 'dayjs';
import { DatePicker, message } from 'antd';
import { productAPI, categoryAPI, settingsAPI } from '../api';
import EntityFormModal from './EntityFormModal';

const { Section, Field } = EntityFormModal;

const EMPTY = {
  barcode: '',
  category_id: undefined,
  product_name: '',
  size_value: '',
  article_number: '',
  hsn_code: '',
  gst_rate: '',
  unit_of_measurement: 'PCS',
  quantity_per_box: '',
  minimum_stock_level: '',
  reorder_level: '',
  purchase_rate: '',
  margin_percentage: '',
  sale_rate: '',
  mrp: '',
  is_batch_tracked: false,
  opening_stock: '',
  opening_stock_rate: '',
  opening_stock_date: dayjs(),
};

// Required fields for client-side validation. Empty string + null +
// undefined all count as "missing" — server validates again on POST so
// this is purely for fast inline feedback.
const REQUIRED = {
  category_id:    'Category is required',
  product_name:   'Product Name is required',
  purchase_rate:  'Purchase Rate is required',
  sale_rate:      'Sale Rate is required',
};

const UNITS = ['PCS', 'KG', 'METER', 'LITER', 'BOX', 'DOZEN'];

export default function ProductFormModal({ open, onCancel, onSaved, defaultName }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [categories, setCategories] = useState([]);
  const [batchTrackingEnabled, setBatchTrackingEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initial, setInitial] = useState(EMPTY);

  // Load categories + batch-tracking flag every time the modal opens.
  // Cheap to refetch and a Settings change in another tab should
  // surface here on next open.
  useEffect(() => {
    if (!open) return;
    categoryAPI.getAllFlat().then(({ data }) => setCategories(data || [])).catch(() => {});
    settingsAPI.getSystem().then(({ data }) => {
      const s = (data && data.data) ? data.data : data;
      setBatchTrackingEnabled(!!s?.batch_tracking_enabled);
    }).catch(() => {});
    const fresh = { ...EMPTY, product_name: defaultName || '', opening_stock_date: dayjs() };
    setForm(fresh);
    setInitial(fresh);
    setErrors({});
  }, [open, defaultName]);

  // Dirty detection — compare current state to the snapshot taken on
  // open. Drives the Esc-confirm ribbon in the shell.
  const dirty = useMemo(() => {
    const keys = Object.keys(initial);
    return keys.some((k) => {
      const a = form[k], b = initial[k];
      if (k === 'opening_stock_date') {
        // dayjs objects — compare ISO strings.
        return (a?.toISOString?.() || '') !== (b?.toISOString?.() || '');
      }
      return (a == null ? '' : String(a)) !== (b == null ? '' : String(b));
    });
  }, [form, initial]);

  const set = useCallback((k) => (e) => {
    const v = e?.target ? e.target.value : e;
    setForm((p) => ({ ...p, [k]: v }));
    // Clear that field's error as soon as the operator edits it.
    if (errors[k]) setErrors((er) => { const x = { ...er }; delete x[k]; return x; });
  }, [errors]);

  // Auto-derive sale rate from purchase × (1 + margin/100) when either
  // moves. Operator can still type sale_rate manually after — the next
  // change to purchase/margin will overwrite, matching the previous
  // form's behaviour.
  const recalcSale = useCallback((nextForm) => {
    const pr = parseFloat(nextForm.purchase_rate) || 0;
    const mg = parseFloat(nextForm.margin_percentage) || 0;
    if (pr > 0) {
      return { ...nextForm, sale_rate: +(pr * (1 + mg / 100)).toFixed(2) };
    }
    return nextForm;
  }, []);

  const setPurchase = (e) => setForm((p) => recalcSale({ ...p, purchase_rate: e?.target ? e.target.value : e }));
  const setMargin   = (e) => setForm((p) => recalcSale({ ...p, margin_percentage: e?.target ? e.target.value : e }));

  // ── Save ────────────────────────────────────────────────────────
  const validate = useCallback(() => {
    const next = {};
    Object.keys(REQUIRED).forEach((k) => {
      const v = form[k];
      if (v == null || v === '') next[k] = REQUIRED[k];
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [form]);

  const handleSave = useCallback(async () => {
    if (!validate()) {
      message.warning('Fix the highlighted fields and try again');
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form };
      if (payload.opening_stock_date && typeof payload.opening_stock_date.format === 'function') {
        payload.opening_stock_date = payload.opening_stock_date.format('YYYY-MM-DD');
      }
      // Numeric coercion — server expects numbers, not strings.
      ['gst_rate', 'quantity_per_box', 'minimum_stock_level', 'reorder_level',
       'purchase_rate', 'margin_percentage', 'sale_rate', 'mrp',
       'opening_stock', 'opening_stock_rate'].forEach((k) => {
        if (payload[k] === '' || payload[k] == null) delete payload[k];
        else payload[k] = parseFloat(payload[k]);
      });
      const { data } = await productAPI.create(payload);
      // productAPI.create returns either the product directly or
      // { existing: true, product } if name+size+article+qpb matched.
      const product = data?.product || data;
      message.success(`Product added — Barcode: ${product?.barcode || ''}`);
      onSaved && onSaved(product);
    } catch (e) {
      message.error(e?.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [form, validate, onSaved]);

  const handleSaveAndClose = useCallback(async () => {
    await handleSave();
    // onSaved already closes the modal in the consumer (sets
    // addProductModalOpen=false), so no extra onCancel call needed.
  }, [handleSave]);

  const handleReset = useCallback(() => {
    setForm({ ...EMPTY, product_name: defaultName || '', opening_stock_date: dayjs() });
    setErrors({});
  }, [defaultName]);

  return (
    <EntityFormModal
      open={open}
      onClose={onCancel}
      title="Add Product"
      subtitle="New SKU · creates one inventory record"
      entityIcon="P"
      entityTone="accent"
      dirty={dirty}
      saving={saving}
      onSave={handleSave}
      onSaveAndClose={handleSaveAndClose}
      onReset={handleReset}
      width={680}
    >

      {/* ── 1. Identifiers ─────────────────────────────────────── */}
      <Section label="Identifiers">
        <Field label="Product Name" required span="full" error={errors.product_name}>
          <input
            className={`efm-input${errors.product_name ? ' has-error' : ''}`}
            placeholder="e.g. Banarasi Silk Saree"
            value={form.product_name}
            onChange={set('product_name')}
            autoFocus
          />
        </Field>

        <Field label="Category" required error={errors.category_id}>
          <select
            className={`efm-select${errors.category_id ? ' has-error' : ''}`}
            value={form.category_id ?? ''}
            onChange={(e) => set('category_id')(e.target.value ? parseInt(e.target.value, 10) : undefined)}
          >
            <option value="">— Select category —</option>
            {categories.map((c) => (
              <option key={c.category_id} value={c.category_id}>{c.category_name}</option>
            ))}
          </select>
        </Field>

        <Field label="Barcode" help="Leave blank to auto-generate">
          <input
            className="efm-input"
            placeholder="Auto-generate"
            value={form.barcode}
            onChange={set('barcode')}
          />
        </Field>

        <Field label="Size">
          <input className="efm-input" placeholder="S / M / L / XL"
            value={form.size_value} onChange={set('size_value')} />
        </Field>

        <Field label="Article No">
          <input className="efm-input" value={form.article_number} onChange={set('article_number')} />
        </Field>

        <Field label="HSN Code">
          <input className="efm-input" value={form.hsn_code} onChange={set('hsn_code')} />
        </Field>
      </Section>

      {/* ── 2. Pricing ─────────────────────────────────────────── */}
      <Section label="Pricing">
        <Field label="Purchase Rate" required error={errors.purchase_rate}>
          <div className="efm-suffix">
            <input
              className={`efm-input${errors.purchase_rate ? ' has-error' : ''}`}
              placeholder="0.00"
              type="number" min="0" step="0.01"
              value={form.purchase_rate}
              onChange={setPurchase}
            />
            <span className="efm-suffix-unit">₹</span>
          </div>
        </Field>

        <Field label="Margin %">
          <div className="efm-suffix">
            <input className="efm-input" placeholder="0"
              type="number" min="0" step="0.01"
              value={form.margin_percentage}
              onChange={setMargin} />
            <span className="efm-suffix-unit">%</span>
          </div>
        </Field>

        <Field label="Sale Rate" required error={errors.sale_rate}>
          <div className="efm-suffix">
            <input
              className={`efm-input${errors.sale_rate ? ' has-error' : ''}`}
              placeholder="0.00"
              type="number" min="0" step="0.01"
              value={form.sale_rate}
              onChange={set('sale_rate')}
            />
            <span className="efm-suffix-unit">₹</span>
          </div>
        </Field>

        <Field label="MRP">
          <div className="efm-suffix">
            <input className="efm-input" placeholder="0.00"
              type="number" min="0" step="0.01"
              value={form.mrp}
              onChange={set('mrp')} />
            <span className="efm-suffix-unit">₹</span>
          </div>
        </Field>

        <Field label="GST %">
          <div className="efm-suffix">
            <input className="efm-input" placeholder="0"
              type="number" min="0" step="0.01"
              value={form.gst_rate}
              onChange={set('gst_rate')} />
            <span className="efm-suffix-unit">%</span>
          </div>
        </Field>
      </Section>

      {/* ── 3. Inventory ───────────────────────────────────────── */}
      <Section label="Inventory">
        <Field label="Unit of Measurement">
          <select className="efm-select" value={form.unit_of_measurement} onChange={set('unit_of_measurement')}>
            {UNITS.map((u) => <option key={u}>{u}</option>)}
          </select>
        </Field>

        <Field label="Pcs / Box">
          <input className="efm-input" placeholder="1"
            type="number" min="1" step="1"
            value={form.quantity_per_box}
            onChange={set('quantity_per_box')} />
        </Field>

        <Field label="Min Stock" help="Triggers low-stock alert">
          <input className="efm-input" placeholder="0"
            type="number" min="0" step="1"
            value={form.minimum_stock_level}
            onChange={set('minimum_stock_level')} />
        </Field>

        <Field label="Reorder Level">
          <input className="efm-input" placeholder="0"
            type="number" min="0" step="1"
            value={form.reorder_level}
            onChange={set('reorder_level')} />
        </Field>

        {batchTrackingEnabled && (
          <Field
            label="Track by batch"
            span="full"
            help="Each unit can be grouped into a batch with mfg / expiry. Batch picker appears on purchases, sales, returns, and transfers."
          >
            <div className="efm-pills" role="tablist">
              <button
                type="button"
                className={form.is_batch_tracked ? 'on' : ''}
                onClick={() => set('is_batch_tracked')(true)}
              >On</button>
              <button
                type="button"
                className={!form.is_batch_tracked ? 'on' : ''}
                onClick={() => set('is_batch_tracked')(false)}
              >Off</button>
            </div>
          </Field>
        )}
      </Section>

      {/* ── 4. Opening Stock ───────────────────────────────────── */}
      <Section label="Opening Stock">
        <Field label="Opening Qty" help="Leave blank or 0 if no opening stock">
          <input className="efm-input" placeholder="0"
            type="number" min="0" step="0.01"
            value={form.opening_stock}
            onChange={set('opening_stock')} />
        </Field>

        <Field label="Rate / Unit">
          <div className="efm-suffix">
            <input className="efm-input" placeholder="Purchase rate"
              type="number" min="0" step="0.01"
              value={form.opening_stock_rate}
              onChange={set('opening_stock_rate')} />
            <span className="efm-suffix-unit">₹</span>
          </div>
        </Field>

        <Field label="As of Date" span="full">
          <DatePicker
            style={{ width: '100%', height: 32 }}
            format="DD/MM/YYYY"
            value={form.opening_stock_date}
            onChange={(v) => setForm((p) => ({ ...p, opening_stock_date: v }))}
          />
        </Field>
      </Section>

    </EntityFormModal>
  );
}
