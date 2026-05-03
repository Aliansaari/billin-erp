// ── Add / Edit Bank Account modal ──────────────────────────────────
//
// Single modal for both create and edit (the difference is the prop
// `bank` — null = create, an object = edit).
//
// Form fields:
//   • Bank Name (required, unique server-side)
//   • Account Type — Bank Account (asset) | Bank OD A/c (liability).
//     Re-classifying after entries are posted is server-rejected, so
//     we disable the toggle in edit mode if txn_count > 0.
//   • Opening Balance (default 0)
//   • Opening Balance Type — Dr (asset positive) / Cr (liability or OD).
//     Auto-flips to Cr when account type is OD, since you can't have a
//     positive Dr opening on a liability account in any real workflow.
//
// On save the parent's onSaved callback fires with the new/updated bank;
// the parent typically refetches the list and closes the modal.

import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Radio, message } from 'antd';
import { BankOutlined } from '@ant-design/icons';
import { bankAPI } from '../../api';

const SUB_GROUPS = [
  { value: 'Bank Accounts', label: 'Bank Account', sublabel: 'Asset · current account / savings' },
  { value: 'Bank OD A/c',   label: 'Bank OD A/c',  sublabel: 'Liability · overdraft / cash credit' },
];

export default function BankAccountModal({ open, onClose, onSaved, bank }) {
  const isEdit = !!bank;
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  // Re-classifying account type after entries are posted is server-
  // rejected. Disable the radio in that case so the operator doesn't
  // hit a wall — the help-text below explains why.
  const lockType = isEdit && (bank?.txn_count || 0) > 0;

  useEffect(() => {
    if (!open) return;
    if (isEdit) {
      form.setFieldsValue({
        name:                 bank.name,
        sub_group:            bank.sub_group,
        opening_balance:      bank.opening_balance ?? 0,
        opening_balance_type: bank.opening_balance_type ?? 'Debit',
      });
    } else {
      form.setFieldsValue({
        name:                 '',
        sub_group:            'Bank Accounts',
        opening_balance:      0,
        opening_balance_type: 'Debit',
      });
    }
  }, [open, isEdit, bank, form]);

  const handleSubGroupChange = (e) => {
    // OD accounts are liabilities — the conventional opening type is Cr.
    // Snap automatically so the operator doesn't have to think about
    // it. They can still flip back manually if they really want.
    const next = e.target.value;
    if (next === 'Bank OD A/c') {
      form.setFieldValue('opening_balance_type', 'Credit');
    } else {
      form.setFieldValue('opening_balance_type', 'Debit');
    }
  };

  const handleSave = async () => {
    let vals;
    try { vals = await form.validateFields(); }
    catch { return; /* AntD already showed inline errors */ }

    setSaving(true);
    try {
      if (isEdit) {
        const { data } = await bankAPI.update(bank.ledger_id, vals);
        message.success(`"${data.name}" updated`);
        onSaved?.(data);
      } else {
        const { data } = await bankAPI.create(vals);
        message.success(`"${data.name}" added`);
        onSaved?.(data);
      }
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || `Failed to ${isEdit ? 'update' : 'create'} bank`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <BankOutlined style={{ color: '#4F46E5' }} />
          {isEdit ? 'Edit Bank Account' : 'Add Bank Account'}
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText={isEdit ? 'Save changes' : 'Add bank'}
      confirmLoading={saving}
      destroyOnClose
      width={520}
    >
      <Form form={form} layout="vertical" requiredMark={false} preserve={false}>
        <Form.Item
          name="name"
          label="Bank name"
          rules={[
            { required: true, message: 'Bank name is required' },
            { max: 100, message: 'Max 100 characters' },
            { whitespace: true, message: 'Bank name is required' },
          ]}
          extra={isEdit ? null : 'e.g. "HDFC – Current A/c", "ICICI Savings"'}
        >
          <Input placeholder="HDFC – Current A/c" autoFocus={!isEdit} maxLength={100} />
        </Form.Item>

        <Form.Item
          name="sub_group"
          label="Account type"
          rules={[{ required: true }]}
          extra={lockType
            ? 'Locked — entries already posted to this bank. Type can\'t change without corrupting the Trial Balance.'
            : null}
        >
          <Radio.Group onChange={handleSubGroupChange} disabled={lockType}>
            {SUB_GROUPS.map((s) => (
              <Radio.Button key={s.value} value={s.value} style={{ height: 'auto', padding: '6px 14px' }}>
                <div style={{ fontWeight: 600 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: '#6B7280', fontWeight: 400, marginTop: 1 }}>
                  {s.sublabel}
                </div>
              </Radio.Button>
            ))}
          </Radio.Group>
        </Form.Item>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12 }}>
          <Form.Item
            name="opening_balance"
            label="Opening balance"
            rules={[{ type: 'number', min: 0, message: 'Cannot be negative — flip Dr/Cr instead' }]}
            extra="Balance as of the day this account opens in your books."
          >
            <InputNumber
              keyboard={false}
              min={0}
              step={1000}
              style={{ width: '100%' }}
              placeholder="0"
              formatter={(v) => v != null && v !== '' ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
              parser={(v) => v.replace(/₹\s?|,/g, '')}
            />
          </Form.Item>

          <Form.Item
            name="opening_balance_type"
            label="Type"
            rules={[{ required: true }]}
          >
            <Radio.Group>
              <Radio.Button value="Debit">Dr</Radio.Button>
              <Radio.Button value="Credit">Cr</Radio.Button>
            </Radio.Group>
          </Form.Item>
        </div>

        <div style={{
          padding: '10px 12px',
          borderRadius: 6,
          background: '#F9FAFB',
          border: '1px solid #E5E7EB',
          fontSize: 12,
          color: '#6B7280',
          lineHeight: 1.5,
        }}>
          {isEdit ? (
            <>Editing rebalances the opening leg.  Live entries on this bank are unaffected — only the seed Dr/Cr changes.</>
          ) : (
            <>The new bank ledger is wired into double-entry posting automatically.
            It'll show up in the Bank → Accounts list, in the Reconciliation page,
            and as a pickable destination in Payment / Receipt / Sales Bill forms.</>
          )}
        </div>
      </Form>
    </Modal>
  );
}
