// ── Cheque action modals ─────────────────────────────────────────
//
// Co-located in one file because each modal is small (one or two
// fields) and the four flow together as the cheque lifecycle. Keeping
// them grouped means the register page can wire up "open the right
// modal" without an import-per-action.
//
// Modals exported:
//   • DepositModal — INWARD only, PENDING → DEPOSITED
//   • ClearModal   — flag flip; OUTWARD-PDC additionally posts a
//                    voucher
//   • BounceModal  — terminal sad path; reverses every voucher
//                    posted on the cheque, optionally posts bank
//                    charges
//   • CancelModal  — terminal void; same reversal as bounce, no
//                    bank-charge post
//
// All four render through the shared EntityFormModal shell so the
// chrome / F-key vocabulary matches every other entity form. The
// ChequeHeader shows "what cheque are we acting on" in the modal's
// subtitle plus a Section callout — the operator never confuses two
// open modals.

import React, { useEffect, useState } from 'react';
import { Form, DatePicker, InputNumber, Input, Select, message } from 'antd';
import dayjs from 'dayjs';
import { chequeAPI, bankAPI } from '../../api';
import EntityFormModal from '../../components/EntityFormModal';
import { inrFormatter, inrParser } from '../../utils/indianFormat';

const fmtRupees = (v) => {
  const n = Number(v) || 0;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// Subtitle helper — the same string slots into every action modal so
// the operator sees "from {party} · #{number} · ₹{amount}" without us
// having to repeat the JSX.
const chequeSubtitle = (cheque) => {
  if (!cheque) return null;
  const dir = cheque.direction === 'INWARD' ? 'From' : 'To';
  const party = cheque.party?.party_name || '—';
  return `${dir} ${party} · #${cheque.cheque_number} · ${fmtRupees(cheque.amount)}`;
};

// Header callout block — used inside the first Section of each modal.
function ChequeHeaderCallout({ cheque }) {
  if (!cheque) return null;
  return (
    <div className="efm-callout" style={{ gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 12.5 }}>{cheque.party?.party_name || '—'}</span>
          <span style={{ marginLeft: 8, color: 'var(--fg-tertiary)' }}>
            #{cheque.cheque_number} · {dayjs(cheque.cheque_date).format('DD MMM YYYY')}
          </span>
        </div>
        <div style={{ fontWeight: 700, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          {fmtRupees(cheque.amount)}
        </div>
      </div>
    </div>
  );
}

// ── Deposit modal ──────────────────────────────────────────────────
export function DepositModal({ open, onClose, onSaved, cheque }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [banks, setBanks]   = useState([]);
  const [dirty, setDirty]   = useState(false);

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    bankAPI.list({ include_inactive: false })
      .then((r) => setBanks(r.data?.banks || []))
      .catch(() => setBanks([]));
    form.setFieldsValue({
      bank_ledger_id: cheque?.bank_ledger_id || undefined,
      deposit_date:   dayjs(),
    });
  }, [open, cheque, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { message.warning('Pick a bank and a date'); return; }
    setSaving(true);
    try {
      await chequeAPI.deposit(cheque.cheque_id, {
        bank_ledger_id: v.bank_ledger_id,
        deposit_date:   v.deposit_date ? v.deposit_date.format('YYYY-MM-DD') : null,
      });
      message.success('Cheque deposited');
      setDirty(false);
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to deposit');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    form.setFieldsValue({
      bank_ledger_id: cheque?.bank_ledger_id || undefined,
      deposit_date:   dayjs(),
    });
    setDirty(false);
  };

  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      preserve={false}
      component={false}
      onValuesChange={() => setDirty(true)}
    >
      <EntityFormModal
        open={open}
        onClose={onClose}
        title="Deposit Cheque"
        subtitle={chequeSubtitle(cheque)}
        entityIcon="↓"
        entityTone="info"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAndClose={handleSave}
        onReset={handleReset}
        width={500}
      >
        <EntityFormModal.Section label="Deposit">
          <ChequeHeaderCallout cheque={cheque} />

          <EntityFormModal.Field label="Deposit To" required span="full">
            <Form.Item
              name="bank_ledger_id"
              rules={[{ required: true, message: 'Pick the destination bank' }]}
              noStyle
            >
              <Select
                className="efm-select-antd"
                showSearch
                placeholder="Select bank…"
                optionFilterProp="label"
                options={banks.map((b) => ({
                  value: b.ledger_id,
                  label: b.name + (b.is_overdraft ? ' (OD)' : ''),
                }))}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="Deposit Date" required span="full">
            <Form.Item
              name="deposit_date"
              rules={[{ required: true, message: 'Pick a deposit date' }]}
              noStyle
            >
              <DatePicker className="efm-input" style={{ width: '100%' }} format="DD MMM YYYY" allowClear={false} />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        <EntityFormModal.Section label="Will Post">
          <div className="efm-preview" style={{ gridColumn: '1 / -1' }}>
            <div className="leg">
              <span className="dr">Dr</span> Bank · <b>{fmtRupees(cheque?.amount)}</b>
            </div>
            <div style={{ marginLeft: 14, marginTop: 2 }} className="leg">
              <span className="cr">Cr</span> Cheques in Hand · <b>{fmtRupees(cheque?.amount)}</b>
            </div>
          </div>
        </EntityFormModal.Section>
      </EntityFormModal>
    </Form>
  );
}

// ── Clear modal ────────────────────────────────────────────────────
export function ClearModal({ open, onClose, onSaved, cheque }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty]   = useState(false);

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    form.setFieldsValue({ clearance_date: dayjs() });
  }, [open, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { message.warning('Pick a clearance date'); return; }
    setSaving(true);
    try {
      await chequeAPI.clear(cheque.cheque_id, {
        clearance_date: v.clearance_date ? v.clearance_date.format('YYYY-MM-DD') : null,
      });
      message.success('Cheque cleared');
      setDirty(false);
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to clear');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    form.setFieldsValue({ clearance_date: dayjs() });
    setDirty(false);
  };

  // Outward PDCs post a voucher on clear; everything else just flips
  // the flag. The callout below explains which case the operator's in.
  const isOutwardPdc = cheque?.direction === 'OUTWARD' && cheque?.is_pdc;

  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      preserve={false}
      component={false}
      onValuesChange={() => setDirty(true)}
    >
      <EntityFormModal
        open={open}
        onClose={onClose}
        title="Mark as Cleared"
        subtitle={chequeSubtitle(cheque)}
        entityIcon="✓"
        entityTone="success"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAndClose={handleSave}
        onReset={handleReset}
        width={500}
      >
        <EntityFormModal.Section label="Clearance">
          <ChequeHeaderCallout cheque={cheque} />

          <EntityFormModal.Field
            label="Clearance Date"
            required
            span="full"
            help={cheque?.direction === 'INWARD'
              ? 'Date the bank credited your account.'
              : 'Date the supplier presented the cheque to your bank.'}
          >
            <Form.Item
              name="clearance_date"
              rules={[{ required: true, message: 'Pick a clearance date' }]}
              noStyle
            >
              <DatePicker className="efm-input" style={{ width: '100%' }} format="DD MMM YYYY" allowClear={false} />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        <EntityFormModal.Section label={isOutwardPdc ? 'Will Post' : 'No New Voucher'}>
          {isOutwardPdc ? (
            <div className="efm-preview" style={{ gridColumn: '1 / -1' }}>
              <div className="leg">
                <span className="dr">Dr</span> Cheques Issued (PDC) · <b>{fmtRupees(cheque?.amount)}</b>
              </div>
              <div style={{ marginLeft: 14, marginTop: 2 }} className="leg">
                <span className="cr">Cr</span> {cheque?.bank?.ledger_name || 'Bank'} · <b>{fmtRupees(cheque?.amount)}</b>
              </div>
            </div>
          ) : (
            <div className="efm-callout" style={{ gridColumn: '1 / -1' }}>
              The financial impact was already recorded earlier in the cheque's lifecycle. This action just records the bookkeeper's confirmation.
            </div>
          )}
        </EntityFormModal.Section>
      </EntityFormModal>
    </Form>
  );
}

// ── Bounce modal ──────────────────────────────────────────────────
export function BounceModal({ open, onClose, onSaved, cheque }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty]   = useState(false);

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    form.setFieldsValue({
      bounce_date:    dayjs(),
      bounce_reason:  '',
      bounce_charges: 0,
    });
  }, [open, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { message.warning('Fix the highlighted fields'); return; }
    setSaving(true);
    try {
      await chequeAPI.bounce(cheque.cheque_id, {
        bounce_date:    v.bounce_date ? v.bounce_date.format('YYYY-MM-DD') : null,
        bounce_reason:  v.bounce_reason || null,
        bounce_charges: Number(v.bounce_charges) || 0,
      });
      message.success('Cheque marked bounced');
      setDirty(false);
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to bounce');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    form.setFieldsValue({
      bounce_date:    dayjs(),
      bounce_reason:  '',
      bounce_charges: 0,
    });
    setDirty(false);
  };

  const reversalDescription = cheque?.direction === 'INWARD' && cheque?.status === 'DEPOSITED'
    ? `Reverses Bank Dr / Cheques in Hand Cr (deposit) and Cheques in Hand Dr / ${cheque?.party?.party_name || 'Customer'} Cr (receipt). The receivable comes back on the customer.`
    : cheque?.direction === 'INWARD'
      ? `Reverses Cheques in Hand Dr / ${cheque?.party?.party_name || 'Customer'} Cr (receipt). The receivable comes back on the customer.`
      : `Reverses ${cheque?.party?.party_name || 'Supplier'} Dr / Bank Cr (issue). The payable comes back to the supplier.`;

  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      preserve={false}
      component={false}
      onValuesChange={() => setDirty(true)}
    >
      <EntityFormModal
        open={open}
        onClose={onClose}
        title="Mark as Bounced"
        subtitle={chequeSubtitle(cheque)}
        entityIcon="!"
        entityTone="danger"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAndClose={handleSave}
        onReset={handleReset}
        width={520}
      >
        <EntityFormModal.Section label="Bounce">
          <ChequeHeaderCallout cheque={cheque} />

          <div className="efm-callout danger" style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>Will reverse every voucher posted for this cheque</div>
            {reversalDescription}
          </div>

          <EntityFormModal.Field label="Bounce Date" required>
            <Form.Item
              name="bounce_date"
              rules={[{ required: true, message: 'Required' }]}
              noStyle
            >
              <DatePicker className="efm-input" style={{ width: '100%' }} format="DD MMM YYYY" allowClear={false} />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label="Bank Charges"
            help="Posted as expense to Cheque Bounce Charges"
          >
            <Form.Item name="bounce_charges" noStyle>
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={0}
                step={50}
                style={{ width: '100%' }}
                controls={false}
                placeholder="0.00"
                formatter={(v) => v != null && v !== '' ? inrFormatter(v) : ''}
                parser={(v) => v.replace(/₹\s?|,/g, '')}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="Reason" span="full">
            <Form.Item name="bounce_reason" noStyle>
              <Input
                className="efm-input"
                placeholder="Insufficient funds / Signature mismatch / Stop payment …"
                maxLength={255}
              />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>
      </EntityFormModal>
    </Form>
  );
}

// ── Cancel modal ──────────────────────────────────────────────────
export function CancelModal({ open, onClose, onSaved, cheque }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty]   = useState(false);

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    form.setFieldsValue({ reason: '' });
  }, [open, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { return; }
    setSaving(true);
    try {
      await chequeAPI.cancel(cheque.cheque_id, {
        reason: v.reason || null,
      });
      message.success('Cheque cancelled');
      setDirty(false);
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to cancel');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    form.setFieldsValue({ reason: '' });
    setDirty(false);
  };

  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      preserve={false}
      component={false}
      onValuesChange={() => setDirty(true)}
    >
      <EntityFormModal
        open={open}
        onClose={onClose}
        title="Cancel Cheque"
        subtitle={chequeSubtitle(cheque)}
        entityIcon="×"
        entityTone="danger"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAndClose={handleSave}
        onReset={handleReset}
        width={500}
      >
        <EntityFormModal.Section label="Cancel">
          <ChequeHeaderCallout cheque={cheque} />

          <div className="efm-callout danger" style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>Voids the cheque and reverses every voucher posted for it</div>
            Use this when the cheque was recorded by mistake or the customer asked for it back. For real-world bounces, use the Bounce action so bank charges can be captured.
          </div>

          <EntityFormModal.Field label="Reason" span="full">
            <Form.Item name="reason" noStyle>
              <Input.TextArea
                rows={2}
                placeholder="e.g. Recorded by mistake, customer took the cheque back, …"
                maxLength={255}
                showCount
              />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>
      </EntityFormModal>
    </Form>
  );
}
