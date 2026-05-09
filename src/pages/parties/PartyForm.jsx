// ── PartyForm ─────────────────────────────────────────────────────────
//
// Customer / Supplier create + edit. Public API (props) unchanged from
// the previous Antd-Modal version — every existing call site keeps
// working without a wiring change. Only the chrome moved to the shared
// EntityFormModal shell as part of the create-form unification work.
//
// Props:
//   visible        — boolean, controlled
//   onCancel       — close without saving
//   onSubmit       — called with the validated values payload
//   onDeleted      — called with the deleted party_id after a hard
//                    delete (or after the operator chose "deactivate"
//                    on the canDeactivate fallback). Required only for
//                    edit mode.
//   initialValues  — when present, the form goes into edit mode
//   partyType      — 'Customer' | 'Supplier' | 'Both'
//   loading        — outer save spinner

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { Modal, message } from 'antd';
import { DeleteOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { partyAPI } from '../../api';
import EntityFormModal from '../../components/EntityFormModal';

const { Section, Field } = EntityFormModal;
const { confirm } = Modal;

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim',
  'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal', 'Delhi', 'Jammu & Kashmir', 'Ladakh',
];

const STATUS_OPTIONS = ['Regular', 'Priority', 'VIP', 'Blacklist'];
const OB_TYPES = ['Receivable', 'Payable'];

const EMPTY = {
  party_name: '',
  display_name: '',
  mobile_1: '',
  mobile_2: '',
  email: '',
  address_line_1: '',
  address_line_2: '',
  city: '',
  state: '',
  pincode: '',
  gstin: '',
  pan_number: '',
  aadhar_number: '',
  credit_allowed: false,
  credit_limit: '',
  credit_days: '',
  interest_rate: '',
  party_status: 'Regular',
  opening_balance: '',
  opening_balance_type: 'Receivable',
  party_type: 'Customer',
};

// Tone per partyType so the header chip matches the entity colour.
// Customer = success (green), Supplier = warning (amber), Both = info.
const TONE = { Customer: 'success', Supplier: 'warning', Both: 'info' };
const ICON = { Customer: 'C', Supplier: 'S', Both: 'P' };

export default function PartyForm({
  visible,
  onCancel,
  onSubmit,
  onDeleted,
  initialValues,
  partyType = 'Customer',
  loading,
}) {
  const isEdit = !!initialValues?.party_id;
  const [form, setForm] = useState(EMPTY);
  const [initial, setInitial] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Hydrate form on open / when initialValues change. Edit mode
  // pre-fills from the saved row; create mode resets to defaults
  // with party_type pinned to whichever entity the operator was
  // creating.
  useEffect(() => {
    if (!visible) return;
    const fresh = initialValues
      ? { ...EMPTY, ...initialValues, credit_allowed: !!initialValues.credit_allowed }
      : { ...EMPTY, party_type: partyType, party_status: 'Regular', credit_allowed: false };
    setForm(fresh);
    setInitial(fresh);
    setErrors({});
  }, [visible, initialValues, partyType]);

  const dirty = useMemo(() => {
    return Object.keys(initial).some((k) => {
      const a = form[k], b = initial[k];
      if (typeof a === 'boolean' || typeof b === 'boolean') return !!a !== !!b;
      return (a == null ? '' : String(a)) !== (b == null ? '' : String(b));
    });
  }, [form, initial]);

  const set = useCallback((k) => (e) => {
    const v = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setForm((p) => ({ ...p, [k]: v }));
    if (errors[k]) setErrors((er) => { const x = { ...er }; delete x[k]; return x; });
  }, [errors]);

  // Mirror server-side guards client-side so the operator gets fast
  // inline feedback. Server still validates on save.
  const validate = useCallback(() => {
    const next = {};
    const name = (form.party_name || '').trim();
    if (!name) next.party_name = 'Party Name is required';
    else if (name.length < 2) next.party_name = 'At least 2 characters';
    else if (/^\s*cash(\b|$)/i.test(name)) {
      next.party_name = 'Use the system Cash party — pick "Cash" from the dropdown for walk-ins.';
    }
    if (!(form.mobile_1 || '').trim()) next.mobile_1 = 'Mobile is required';
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) {
      next.email = 'Invalid email';
    }
    if (form.gstin && form.gstin.length > 0 && form.gstin.length !== 15) {
      next.gstin = 'GSTIN must be 15 characters';
    }
    if (form.pincode && form.pincode.length > 0 && !/^\d{6}$/.test(form.pincode)) {
      next.pincode = 'Pincode must be 6 digits';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [form]);

  const handleSave = useCallback(async () => {
    if (!validate()) {
      message.warning('Fix the highlighted fields and try again');
      return;
    }
    const payload = { ...form };
    // Numeric coercion — server expects numbers.
    ['credit_limit', 'credit_days', 'interest_rate', 'opening_balance'].forEach((k) => {
      if (payload[k] === '' || payload[k] == null) delete payload[k];
      else payload[k] = parseFloat(payload[k]);
    });
    onSubmit?.(payload);
  }, [form, validate, onSubmit]);

  const handleSaveAndClose = handleSave;

  const handleReset = useCallback(() => {
    setForm(initial);
    setErrors({});
  }, [initial]);

  // Delete with the canDeactivate fallback the original form had —
  // when a hard delete is blocked because the party has transactions,
  // offer to deactivate instead.
  const handleDelete = useCallback(() => {
    if (!isEdit) return;
    confirm({
      title: `Delete ${partyType}?`,
      icon: <ExclamationCircleOutlined style={{ color: '#dc2626' }} />,
      content: `Are you sure you want to permanently delete "${initialValues?.party_name}"? This cannot be undone.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        setDeleteLoading(true);
        try {
          await partyAPI.delete(initialValues.party_id);
          message.success(`${partyType} deleted`);
          onDeleted?.(initialValues.party_id);
        } catch (err) {
          const errData = err.response?.data;
          if (errData?.canDeactivate) {
            Modal.confirm({
              title: 'Cannot Delete — Has Transactions',
              icon: <ExclamationCircleOutlined style={{ color: '#f59e0b' }} />,
              content: (
                <div>
                  <p style={{ marginBottom: 8 }}>{errData.error}</p>
                  <p style={{ color: '#6b7280', fontSize: 13 }}>
                    Would you like to <strong>deactivate</strong> this {partyType.toLowerCase()} instead?
                    Inactive parties won't appear in transaction forms.
                  </p>
                </div>
              ),
              okText: `Deactivate ${partyType}`,
              okButtonProps: { style: { background: '#f59e0b', borderColor: '#f59e0b' } },
              cancelText: 'Cancel',
              onOk: async () => {
                await partyAPI.update(initialValues.party_id, { is_active: false });
                message.success(`${partyType} deactivated`);
                onDeleted?.(initialValues.party_id);
              },
            });
          } else {
            message.error(errData?.error || 'Failed to delete');
          }
        } finally {
          setDeleteLoading(false);
        }
      },
    });
  }, [isEdit, partyType, initialValues, onDeleted]);

  const upperOnInput = (k) => (e) => set(k)(e.target.value.toUpperCase());

  return (
    <EntityFormModal
      open={visible}
      onClose={onCancel}
      title={`${isEdit ? 'Edit' : 'Add'} ${partyType}`}
      subtitle={isEdit
        ? `Update ${initialValues?.party_name || partyType.toLowerCase()} details`
        : `New ${partyType.toLowerCase()} record`}
      entityIcon={ICON[partyType] || 'P'}
      entityTone={TONE[partyType] || 'accent'}
      dirty={dirty}
      saving={loading}
      onSave={handleSave}
      onSaveAndClose={handleSaveAndClose}
      onReset={handleReset}
      width={700}
      dangerAction={isEdit ? {
        label: `Delete ${partyType}`,
        onClick: handleDelete,
        loading: deleteLoading,
        icon: <DeleteOutlined />,
      } : undefined}
    >

      {/* ── 1. Identity ────────────────────────────────────────── */}
      <Section label="Identity">
        <Field label="Party Name" required error={errors.party_name}>
          <input
            className={`efm-input${errors.party_name ? ' has-error' : ''}`}
            value={form.party_name}
            onChange={set('party_name')}
            autoFocus
          />
        </Field>

        <Field label="Display Name" help="Optional · shown in pickers">
          <input className="efm-input" value={form.display_name} onChange={set('display_name')} />
        </Field>

        <Field label="Mobile 1" required error={errors.mobile_1}>
          <input
            className={`efm-input${errors.mobile_1 ? ' has-error' : ''}`}
            value={form.mobile_1}
            onChange={set('mobile_1')}
            maxLength={10}
            inputMode="numeric"
          />
        </Field>

        <Field label="Mobile 2">
          <input className="efm-input" value={form.mobile_2}
            onChange={set('mobile_2')} maxLength={10} inputMode="numeric" />
        </Field>

        <Field label="Email" span="full" error={errors.email}>
          <input
            className={`efm-input${errors.email ? ' has-error' : ''}`}
            type="email"
            value={form.email}
            onChange={set('email')}
          />
        </Field>
      </Section>

      {/* ── 2. Address ─────────────────────────────────────────── */}
      <Section label="Address">
        <Field label="Address Line 1" span="full">
          <input className="efm-input" value={form.address_line_1} onChange={set('address_line_1')} />
        </Field>

        <Field label="Address Line 2" span="full" help="Area / Landmark">
          <input className="efm-input" value={form.address_line_2} onChange={set('address_line_2')} />
        </Field>

        <Field label="City">
          <input className="efm-input" value={form.city} onChange={set('city')} />
        </Field>

        <Field label="State">
          <select className="efm-select" value={form.state || ''} onChange={set('state')}>
            <option value="">— Select —</option>
            {INDIAN_STATES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>

        <Field label="Pincode" error={errors.pincode}>
          <input
            className={`efm-input${errors.pincode ? ' has-error' : ''}`}
            value={form.pincode}
            onChange={set('pincode')}
            maxLength={6}
            inputMode="numeric"
          />
        </Field>
      </Section>

      {/* ── 3. Tax & Status ────────────────────────────────────── */}
      <Section label="Tax & Status">
        <Field label="GSTIN" error={errors.gstin}>
          <input
            className={`efm-input${errors.gstin ? ' has-error' : ''}`}
            value={form.gstin}
            onChange={upperOnInput('gstin')}
            maxLength={15}
            style={{ fontFamily: 'Geist Mono, JetBrains Mono, monospace', textTransform: 'uppercase' }}
          />
        </Field>

        <Field label="PAN Number">
          <input
            className="efm-input"
            value={form.pan_number}
            onChange={upperOnInput('pan_number')}
            maxLength={10}
            style={{ fontFamily: 'Geist Mono, JetBrains Mono, monospace', textTransform: 'uppercase' }}
          />
        </Field>

        <Field label="Aadhar Number">
          <input className="efm-input" value={form.aadhar_number}
            onChange={set('aadhar_number')} maxLength={12} inputMode="numeric" />
        </Field>

        <Field label="Status">
          <select className="efm-select" value={form.party_status} onChange={set('party_status')}>
            {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
      </Section>

      {/* ── 4. Credit & Opening Balance ────────────────────────── */}
      <Section label="Credit & Opening Balance">
        <Field label="Credit Allowed" span="full">
          <div className="efm-pills">
            <button type="button" className={form.credit_allowed ? 'on' : ''}
              onClick={() => set('credit_allowed')(true)}>Yes</button>
            <button type="button" className={!form.credit_allowed ? 'on' : ''}
              onClick={() => set('credit_allowed')(false)}>No</button>
          </div>
        </Field>

        <Field label="Credit Limit">
          <div className="efm-suffix">
            <input className="efm-input"
              type="number" min="0" step="0.01"
              value={form.credit_limit} onChange={set('credit_limit')} />
            <span className="efm-suffix-unit">₹</span>
          </div>
        </Field>

        <Field label="Credit Days">
          <input className="efm-input" type="number" min="0"
            value={form.credit_days} onChange={set('credit_days')} />
        </Field>

        <Field label="Interest Rate">
          <div className="efm-suffix">
            <input className="efm-input"
              type="number" min="0" max="100" step="0.01"
              value={form.interest_rate} onChange={set('interest_rate')} />
            <span className="efm-suffix-unit">%</span>
          </div>
        </Field>

        <Field label="Opening Balance">
          <div className="efm-suffix">
            <input className="efm-input"
              type="number" min="0" step="0.01"
              value={form.opening_balance} onChange={set('opening_balance')} />
            <span className="efm-suffix-unit">₹</span>
          </div>
        </Field>

        <Field label="Balance Type">
          <select className="efm-select" value={form.opening_balance_type} onChange={set('opening_balance_type')}>
            {OB_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
      </Section>

    </EntityFormModal>
  );
}
