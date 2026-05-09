// ── EntityFormModalDemo ────────────────────────────────────────────
//
// Throwaway preview page for the new EntityFormModal shell. Wires the
// component to dummy state so a developer can navigate to /dev/efm and
// poke at the modal before any real form is migrated. Lives in
// src/pages/dev/ so it's clearly out of the production surface area.
//
// Three buttons launch three example forms (Product, Customer,
// Category) — same shapes the v1 mockup showed, now backed by real
// React. Esc / F1 / F5 / F8 should all work; dirty-state confirm
// fires when at least one field has been changed.

import React, { useState, useMemo } from 'react';
import EntityFormModal from '../../components/EntityFormModal';

const { Section, Field } = EntityFormModal;

const PRODUCT_INITIAL = {
  name: '',
  category: '',
  size: '',
  article: '',
  barcode: '',
  hsn: '',
  cost: '',
  margin: '',
  sale: '',
  mrp: '',
  gst: '',
  opening: '',
  minLevel: '',
  pcsBox: '',
};
const CUSTOMER_INITIAL = {
  name: '',
  mobile: '',
  altMobile: '',
  gst: '',
  address: '',
  city: '',
  pin: '',
  state: '',
  country: 'India',
  allowCredit: 'Yes',
  limit: '',
  days: '',
};
const CATEGORY_INITIAL = {
  name: '',
  description: '',
  status: 'Active',
  sort: '',
};

export default function EntityFormModalDemo() {
  const [which, setWhich] = useState(null);  // 'product' | 'customer' | 'category' | null
  const [form, setForm] = useState({});
  const [initial, setInitial] = useState({});
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => {
    return Object.keys(initial).some((k) => (form[k] || '') !== (initial[k] || ''));
  }, [form, initial]);

  const open = (kind) => {
    const init = kind === 'product' ? PRODUCT_INITIAL
               : kind === 'customer' ? CUSTOMER_INITIAL
               : CATEGORY_INITIAL;
    setInitial(init);
    setForm(init);
    setWhich(kind);
  };

  const close = () => setWhich(null);

  const handleSave = async () => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 600));
    // Pretend we saved — print the payload to the console for verification.
    // eslint-disable-next-line no-console
    console.log('[EFM demo] saved', which, form);
    setSaving(false);
    setInitial(form);   // mark clean
  };
  const handleSaveAndClose = async () => {
    await handleSave();
    close();
  };
  const handleReset = () => setForm(initial);

  const set = (k) => (e) =>
    setForm((p) => ({ ...p, [k]: e?.target ? e.target.value : e }));

  return (
    <div style={{ padding: 32, height: '100%', overflow: 'auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--fg-primary)' }}>
        EntityFormModal — preview
      </h1>
      <p style={{ fontSize: 13, color: 'var(--fg-secondary)', maxWidth: 640, lineHeight: 1.55, marginTop: 8 }}>
        Phase 1 shell preview. Each button below opens the same shell with
        different children. Try <kbd style={kbdStyle}>F1</kbd> save · <kbd
        style={kbdStyle}>F5</kbd> reset · <kbd style={kbdStyle}>F8</kbd> save
        & close · <kbd style={kbdStyle}>Esc</kbd> cancel (twice if dirty) ·
        <kbd style={kbdStyle}>Alt+1..3</kbd> jump section (Product only).
      </p>

      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <button onClick={() => open('product')} style={btn}>Add Product</button>
        <button onClick={() => open('customer')} style={btn}>Add Customer</button>
        <button onClick={() => open('category')} style={btn}>Add Category</button>
      </div>

      {/* ── Product form ─────────────────────────────────────── */}
      {which === 'product' && (
        <EntityFormModal
          open
          onClose={close}
          title="Add Product"
          subtitle="New SKU · creates one inventory record"
          entityIcon="P"
          entityTone="accent"
          dirty={dirty}
          saving={saving}
          onSave={handleSave}
          onSaveAndClose={handleSaveAndClose}
          onReset={handleReset}
          width={540}
        >
          <Section label="Identifiers">
            <Field label="Product Name" required span="full">
              <input className="efm-input" placeholder="e.g. Banarasi Silk Saree"
                value={form.name || ''} onChange={set('name')} autoFocus />
            </Field>
            <Field label="Category" required help="⌘K picker · + new">
              <select className="efm-select" value={form.category || ''} onChange={set('category')}>
                <option value="">—</option>
                <option>Sarees</option>
                <option>Cotton Fabric</option>
                <option>Synthetic</option>
              </select>
            </Field>
            <Field label="Barcode">
              <input className="efm-input" placeholder="auto-generated if blank"
                value={form.barcode || ''} onChange={set('barcode')} />
            </Field>
            <Field label="Size">
              <input className="efm-input" placeholder="e.g. M / 38 / 100ml"
                value={form.size || ''} onChange={set('size')} />
            </Field>
            <Field label="Article #">
              <input className="efm-input" value={form.article || ''} onChange={set('article')} />
            </Field>
          </Section>

          <Section label="Pricing">
            <Field label="Purchase Rate" required>
              <div className="efm-suffix">
                <input className="efm-input" placeholder="0.00" value={form.cost || ''} onChange={set('cost')} />
                <span className="efm-suffix-unit">₹</span>
              </div>
            </Field>
            <Field label="Margin %">
              <div className="efm-suffix">
                <input className="efm-input" placeholder="0" value={form.margin || ''} onChange={set('margin')} />
                <span className="efm-suffix-unit">%</span>
              </div>
            </Field>
            <Field label="Sale Rate">
              <div className="efm-suffix">
                <input className="efm-input" placeholder="auto" value={form.sale || ''} onChange={set('sale')} />
                <span className="efm-suffix-unit">₹</span>
              </div>
            </Field>
            <Field label="MRP">
              <div className="efm-suffix">
                <input className="efm-input" placeholder="0.00" value={form.mrp || ''} onChange={set('mrp')} />
                <span className="efm-suffix-unit">₹</span>
              </div>
            </Field>
            <Field label="GST %">
              <select className="efm-select" value={form.gst || ''} onChange={set('gst')}>
                <option value="">—</option>
                <option>0%</option><option>5%</option><option>12%</option><option>18%</option><option>28%</option>
              </select>
            </Field>
            <Field label="HSN Code">
              <input className="efm-input" placeholder="6207" value={form.hsn || ''} onChange={set('hsn')} />
            </Field>
          </Section>

          <Section label="Inventory">
            <Field label="Opening Stock">
              <input className="efm-input" placeholder="0" value={form.opening || ''} onChange={set('opening')} />
            </Field>
            <Field label="Min Level" help="Triggers low-stock alert">
              <input className="efm-input" placeholder="0" value={form.minLevel || ''} onChange={set('minLevel')} />
            </Field>
            <Field label="Pcs / Box">
              <input className="efm-input" placeholder="1" value={form.pcsBox || ''} onChange={set('pcsBox')} />
            </Field>
          </Section>
        </EntityFormModal>
      )}

      {/* ── Customer form ────────────────────────────────────── */}
      {which === 'customer' && (
        <EntityFormModal
          open
          onClose={close}
          title="Add Customer"
          subtitle="Walk-in or credit account"
          entityIcon="C"
          entityTone="success"
          dirty={dirty}
          saving={saving}
          onSave={handleSave}
          onSaveAndClose={handleSaveAndClose}
          onReset={handleReset}
        >
          <Section label="Identity">
            <Field label="Party Name" required span="full">
              <input className="efm-input" placeholder="e.g. Bharat Wholesale"
                value={form.name || ''} onChange={set('name')} autoFocus />
            </Field>
            <Field label="Mobile" required>
              <input className="efm-input" placeholder="+91 XXXXX XXXXX"
                value={form.mobile || ''} onChange={set('mobile')} />
            </Field>
            <Field label="Alt. Mobile">
              <input className="efm-input" value={form.altMobile || ''} onChange={set('altMobile')} />
            </Field>
            <Field label="GST Number" span="full" help="Optional · 15 chars · validated on save">
              <input className="efm-input" placeholder="22AAAAA0000A1Z5"
                style={{ fontFamily: 'Geist Mono, JetBrains Mono, monospace' }}
                value={form.gst || ''} onChange={set('gst')} />
            </Field>
          </Section>

          <Section label="Address">
            <Field label="Address Line" span="full">
              <input className="efm-input" value={form.address || ''} onChange={set('address')} />
            </Field>
            <Field label="City">
              <input className="efm-input" value={form.city || ''} onChange={set('city')} />
            </Field>
            <Field label="PIN Code">
              <input className="efm-input" placeholder="6 digits" value={form.pin || ''} onChange={set('pin')} />
            </Field>
            <Field label="State">
              <select className="efm-select" value={form.state || ''} onChange={set('state')}>
                <option value="">—</option>
                <option>Maharashtra</option>
                <option>Karnataka</option>
              </select>
            </Field>
            <Field label="Country">
              <input className="efm-input" value={form.country || 'India'} onChange={set('country')} />
            </Field>
          </Section>

          <Section label="Credit">
            <Field label="Allow Credit">
              <div className="efm-pills">
                <button type="button" className={form.allowCredit === 'Yes' ? 'on' : ''}
                  onClick={() => set('allowCredit')('Yes')}>Yes</button>
                <button type="button" className={form.allowCredit === 'No' ? 'on' : ''}
                  onClick={() => set('allowCredit')('No')}>No</button>
              </div>
            </Field>
            <Field label="Credit Limit">
              <div className="efm-suffix">
                <input className="efm-input" placeholder="0" value={form.limit || ''} onChange={set('limit')} />
                <span className="efm-suffix-unit">₹</span>
              </div>
            </Field>
            <Field label="Credit Days">
              <input className="efm-input" placeholder="0" value={form.days || ''} onChange={set('days')} />
            </Field>
          </Section>
        </EntityFormModal>
      )}

      {/* ── Category form ────────────────────────────────────── */}
      {which === 'category' && (
        <EntityFormModal
          open
          onClose={close}
          title="Add Category"
          subtitle="Top-level inventory grouping"
          entityIcon="⌘"
          entityTone="warning"
          dirty={dirty}
          saving={saving}
          onSave={handleSave}
          onSaveAndClose={handleSaveAndClose}
          onReset={handleReset}
          width={460}
        >
          <Section label="Category">
            <Field label="Category Name" required span="full"
              help="Used in product master + reports drill-down">
              <input className="efm-input" placeholder="e.g. Sarees"
                value={form.name || ''} onChange={set('name')} autoFocus />
            </Field>
            <Field label="Description" span="full">
              <textarea className="efm-textarea" placeholder="Internal notes (optional)"
                value={form.description || ''} onChange={set('description')} />
            </Field>
            <Field label="Status">
              <div className="efm-pills">
                <button type="button" className={form.status === 'Active' ? 'on' : ''}
                  onClick={() => set('status')('Active')}>Active</button>
                <button type="button" className={form.status === 'Inactive' ? 'on' : ''}
                  onClick={() => set('status')('Inactive')}>Inactive</button>
              </div>
            </Field>
            <Field label="Sort Order" help="Lower numbers float up">
              <input className="efm-input" placeholder="0" value={form.sort || ''} onChange={set('sort')} />
            </Field>
          </Section>
        </EntityFormModal>
      )}

    </div>
  );
}

const btn = {
  height: 36,
  padding: '0 18px',
  background: 'var(--accent)',
  color: 'var(--fg-inverse, #fff)',
  border: 0,
  borderRadius: 4,
  font: '600 13px/1 inherit',
  cursor: 'pointer',
  letterSpacing: '0.02em',
};
const kbdStyle = {
  display: 'inline-block',
  padding: '1px 5px',
  background: 'var(--bg-muted)',
  border: '1px solid var(--border)',
  borderRadius: 3,
  font: '600 10.5px/1 Geist Mono, JetBrains Mono, monospace',
  color: 'var(--fg-secondary)',
  margin: '0 1px',
};
