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
// Each accepts `cheque` (the row), `open`, `onClose`, `onSaved`.

import React, { useEffect, useState } from 'react';
import { Modal, Form, DatePicker, InputNumber, Input, Select, Alert, message } from 'antd';
import {
  WalletOutlined, CheckCircleOutlined, WarningOutlined, StopOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { chequeAPI, bankAPI } from '../../api';

const fmtRupees = (v) => {
  const n = Number(v) || 0;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// Header strip used by every action modal. Shows "what cheque are we
// acting on" so the operator never confuses two open modals.
function ChequeHeader({ cheque }) {
  if (!cheque) return null;
  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--bg-muted)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 8,
      marginBottom: 14,
      fontSize: 12.5,
      color: 'var(--fg-secondary)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--fg-tertiary)', marginBottom: 4 }}>
        {cheque.direction === 'INWARD' ? 'Inward · Received from' : 'Outward · Issued to'}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div>
          <span style={{ fontWeight: 700, color: 'var(--fg-primary)', fontSize: 14 }}>
            {cheque.party?.party_name || '—'}
          </span>
          <span style={{ marginLeft: 8, color: 'var(--fg-tertiary)' }}>
            #{cheque.cheque_number} · {dayjs(cheque.cheque_date).format('DD MMM YYYY')}
          </span>
        </div>
        <div style={{ fontWeight: 700, color: 'var(--fg-primary)', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
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

  useEffect(() => {
    if (!open) return;
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
    catch { return; }
    setSaving(true);
    try {
      await chequeAPI.deposit(cheque.cheque_id, {
        bank_ledger_id: v.bank_ledger_id,
        deposit_date:   v.deposit_date ? v.deposit_date.format('YYYY-MM-DD') : null,
      });
      message.success('Cheque deposited');
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to deposit');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <WalletOutlined style={{ color: '#4F46E5' }} />
          Deposit cheque
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText="Deposit"
      confirmLoading={saving}
      destroyOnClose
      width={500}
    >
      <ChequeHeader cheque={cheque} />
      <Form form={form} layout="vertical" requiredMark={false} preserve={false}>
        <Form.Item
          name="bank_ledger_id"
          label="Deposit to bank"
          rules={[{ required: true, message: 'Pick the destination bank' }]}
        >
          <Select
            showSearch
            placeholder="Select bank…"
            optionFilterProp="label"
            options={banks.map((b) => ({
              value: b.ledger_id,
              label: b.name + (b.is_overdraft ? ' (OD)' : ''),
            }))}
          />
        </Form.Item>

        <Form.Item
          name="deposit_date"
          label="Deposit date"
          rules={[{ required: true, message: 'Pick a deposit date' }]}
        >
          <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" allowClear={false} />
        </Form.Item>

        <Alert
          type="info"
          showIcon
          message="Will post"
          description={
            <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
              Dr <b>Bank</b> {fmtRupees(cheque?.amount)}<br />
              Cr <b>Cheques in Hand</b> {fmtRupees(cheque?.amount)}
            </div>
          }
          style={{ marginTop: 4 }}
        />
      </Form>
    </Modal>
  );
}

// ── Clear modal ────────────────────────────────────────────────────
export function ClearModal({ open, onClose, onSaved, cheque }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ clearance_date: dayjs() });
  }, [open, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { return; }
    setSaving(true);
    try {
      await chequeAPI.clear(cheque.cheque_id, {
        clearance_date: v.clearance_date ? v.clearance_date.format('YYYY-MM-DD') : null,
      });
      message.success('Cheque cleared');
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to clear');
    } finally {
      setSaving(false);
    }
  };

  // Outward PDCs post a voucher on clear; everything else just flips
  // the flag. The alert below explains which case the operator's in.
  const isOutwardPdc = cheque?.direction === 'OUTWARD' && cheque?.is_pdc;

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <CheckCircleOutlined style={{ color: '#10B981' }} />
          Mark as cleared
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText="Mark cleared"
      okButtonProps={{ style: { background: '#10B981', borderColor: '#10B981' } }}
      confirmLoading={saving}
      destroyOnClose
      width={500}
    >
      <ChequeHeader cheque={cheque} />
      <Form form={form} layout="vertical" requiredMark={false} preserve={false}>
        <Form.Item
          name="clearance_date"
          label="Clearance date"
          rules={[{ required: true, message: 'Pick a clearance date' }]}
          extra={cheque?.direction === 'INWARD'
            ? 'Date the bank credited your account.'
            : 'Date the supplier presented the cheque to your bank.'}
        >
          <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" allowClear={false} />
        </Form.Item>

        {isOutwardPdc ? (
          <Alert
            type="info"
            showIcon
            message="Will post"
            description={
              <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
                Dr <b>Cheques Issued (PDC)</b> {fmtRupees(cheque?.amount)}<br />
                Cr <b>{cheque?.bank?.ledger_name || 'Bank'}</b> {fmtRupees(cheque?.amount)}
              </div>
            }
          />
        ) : (
          <Alert
            type="info"
            showIcon
            message="No new voucher"
            description="The financial impact was already recorded earlier in the cheque's lifecycle. This action just records the bookkeeper's confirmation."
          />
        )}
      </Form>
    </Modal>
  );
}

// ── Bounce modal ──────────────────────────────────────────────────
export function BounceModal({ open, onClose, onSaved, cheque }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      bounce_date:    dayjs(),
      bounce_reason:  '',
      bounce_charges: 0,
    });
  }, [open, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { return; }
    setSaving(true);
    try {
      await chequeAPI.bounce(cheque.cheque_id, {
        bounce_date:    v.bounce_date ? v.bounce_date.format('YYYY-MM-DD') : null,
        bounce_reason:  v.bounce_reason || null,
        bounce_charges: Number(v.bounce_charges) || 0,
      });
      message.success('Cheque marked bounced');
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to bounce');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <WarningOutlined style={{ color: '#EF4444' }} />
          Mark as bounced
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText="Mark bounced"
      okButtonProps={{ danger: true }}
      confirmLoading={saving}
      destroyOnClose
      width={520}
    >
      <ChequeHeader cheque={cheque} />
      <Alert
        type="warning"
        showIcon
        message="Will reverse every voucher posted for this cheque."
        description={
          cheque?.direction === 'INWARD' && cheque?.status === 'DEPOSITED'
            ? `Reverses Bank Dr / Cheques in Hand Cr (deposit) and Cheques in Hand Dr / ${cheque?.party?.party_name || 'Customer'} Cr (receipt). The receivable comes back on the customer.`
            : cheque?.direction === 'INWARD'
              ? `Reverses Cheques in Hand Dr / ${cheque?.party?.party_name || 'Customer'} Cr (receipt). The receivable comes back on the customer.`
              : `Reverses ${cheque?.party?.party_name || 'Supplier'} Dr / Bank Cr (issue). The payable comes back to the supplier.`
        }
        style={{ marginBottom: 12 }}
      />
      <Form form={form} layout="vertical" requiredMark={false} preserve={false}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item
            name="bounce_date"
            label="Bounce date"
            rules={[{ required: true, message: 'Pick a date' }]}
          >
            <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" allowClear={false} />
          </Form.Item>

          <Form.Item
            name="bounce_charges"
            label="Bank charges (optional)"
            extra="Posted as expense to Cheque Bounce Charges."
          >
            <InputNumber
              keyboard={false}
              min={0}
              step={50}
              style={{ width: '100%' }}
              placeholder="0.00"
              formatter={(v) => v != null && v !== '' ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
              parser={(v) => v.replace(/₹\s?|,/g, '')}
            />
          </Form.Item>
        </div>

        <Form.Item name="bounce_reason" label="Reason">
          <Input
            placeholder="Insufficient funds / Signature mismatch / Stop payment …"
            maxLength={255}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ── Cancel modal ──────────────────────────────────────────────────
export function CancelModal({ open, onClose, onSaved, cheque }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
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
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to cancel');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <StopOutlined style={{ color: '#EF4444' }} />
          Cancel cheque
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText="Cancel cheque"
      okButtonProps={{ danger: true }}
      confirmLoading={saving}
      destroyOnClose
      width={500}
    >
      <ChequeHeader cheque={cheque} />
      <Alert
        type="warning"
        showIcon
        message="Voids the cheque and reverses every voucher posted for it."
        description="Use this when the cheque was recorded by mistake or the customer asked for it back. For real-world bounces, use the Bounce action so bank charges can be captured."
        style={{ marginBottom: 12 }}
      />
      <Form form={form} layout="vertical" requiredMark={false} preserve={false}>
        <Form.Item name="reason" label="Reason (optional)">
          <Input.TextArea
            rows={2}
            placeholder="e.g. Recorded by mistake, customer took the cheque back, …"
            maxLength={255}
            showCount
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
