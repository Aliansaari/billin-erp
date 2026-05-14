// ── Add / Edit Bank Account modal ──────────────────────────────────
//
// Single modal for both create and edit (the difference is the prop
// `bank` — null = create, an object = edit). Renders inside the shared
// EntityFormModal shell so the chrome / F-key vocabulary / dirty-state
// confirm matches every other entity form in the app.
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
import { Form, Input, InputNumber, Radio, message } from 'antd';
import { bankAPI } from '../../api';
import EntityFormModal from '../../components/EntityFormModal';
import { inrFormatter, inrParser } from '../../utils/indianFormat';

const SUB_GROUPS = [
  { value: 'Bank Accounts', label: 'Bank Account', sublabel: 'Asset · current account / savings' },
  { value: 'Bank OD A/c',   label: 'Bank OD A/c',  sublabel: 'Liability · overdraft / cash credit' },
];

export default function BankAccountModal({ open, onClose, onSaved, bank }) {
  const isEdit = !!bank;
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty]   = useState(false);

  // Re-classifying account type after entries are posted is server-
  // rejected. Disable the radio in that case so the operator doesn't
  // hit a wall — the help-text below explains why.
  const lockType = isEdit && (bank?.txn_count || 0) > 0;

  const initialValues = () => isEdit
    ? {
        name:                 bank.name,
        sub_group:            bank.sub_group,
        opening_balance:      bank.opening_balance ?? 0,
        opening_balance_type: bank.opening_balance_type ?? 'Debit',
      }
    : {
        name:                 '',
        sub_group:            'Bank Accounts',
        opening_balance:      0,
        opening_balance_type: 'Debit',
      };

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue(initialValues());
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    catch { message.warning('Fix the highlighted fields and try again'); return; }

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
      setDirty(false);
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || `Failed to ${isEdit ? 'update' : 'create'} bank`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    form.setFieldsValue(initialValues());
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
        title={isEdit ? 'Edit Bank Account' : 'Add Bank Account'}
        subtitle={isEdit ? bank?.name : 'New bank ledger · wired into double-entry posting'}
        entityIcon="B"
        entityTone="info"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAndClose={handleSave}
        onReset={handleReset}
        width={520}
      >
        <EntityFormModal.Section label="Identity">
          <EntityFormModal.Field
            label="Bank Name"
            required
            span="full"
            help={isEdit ? null : 'e.g. "HDFC – Current A/c", "ICICI Savings"'}
          >
            <Form.Item
              name="name"
              rules={[
                { required: true, message: 'Bank name is required' },
                { max: 100, message: 'Max 100 characters' },
                { whitespace: true, message: 'Bank name is required' },
              ]}
              noStyle
            >
              <Input className="efm-input" placeholder="HDFC – Current A/c" autoFocus={!isEdit} maxLength={100} />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label="Account Type"
            required
            span="full"
            help={lockType
              ? "Locked — entries already posted to this bank. Type can't change without corrupting the Trial Balance."
              : 'Asset (regular) vs Liability (overdraft). Drives the sign convention.'}
          >
            <Form.Item name="sub_group" rules={[{ required: true }]} noStyle>
              <Radio.Group
                onChange={handleSubGroupChange}
                disabled={lockType}
                style={{ display: 'flex', gap: 0, width: '100%' }}
              >
                {SUB_GROUPS.map((s) => (
                  <Radio.Button
                    key={s.value}
                    value={s.value}
                    style={{ height: 'auto', padding: '8px 14px', flex: 1, textAlign: 'left' }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{s.label}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--fg-tertiary)', fontWeight: 400, marginTop: 1 }}>
                      {s.sublabel}
                    </div>
                  </Radio.Button>
                ))}
              </Radio.Group>
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        <EntityFormModal.Section label="Opening Balance">
          <EntityFormModal.Field
            label="Opening Balance"
            help="Balance as of the day this account opens in your books."
          >
            <Form.Item
              name="opening_balance"
              rules={[{ type: 'number', min: 0, message: 'Cannot be negative — flip Dr/Cr instead' }]}
              noStyle
            >
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={0}
                step={1000}
                style={{ width: '100%' }}
                placeholder="0"
                controls={false}
                formatter={(v) => v != null && v !== '' ? inrFormatter(v) : ''}
                parser={(v) => v.replace(/₹\s?|,/g, '')}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="Type" required>
            <Form.Item name="opening_balance_type" rules={[{ required: true }]} noStyle>
              <Radio.Group style={{ width: '100%', display: 'flex' }}>
                <Radio.Button value="Debit"  style={{ flex: 1, textAlign: 'center' }}>Dr</Radio.Button>
                <Radio.Button value="Credit" style={{ flex: 1, textAlign: 'center' }}>Cr</Radio.Button>
              </Radio.Group>
            </Form.Item>
          </EntityFormModal.Field>

          <div className="efm-callout" style={{ gridColumn: '1 / -1' }}>
            {isEdit ? (
              <>Editing rebalances the opening leg. Live entries on this bank are unaffected — only the seed Dr/Cr changes.</>
            ) : (
              <>The new bank ledger is wired into double-entry posting automatically.
              It'll show up in the Bank → Accounts list, in the Reconciliation page,
              and as a pickable destination in Payment / Receipt / Sales Bill forms.</>
            )}
          </div>
        </EntityFormModal.Section>
      </EntityFormModal>
    </Form>
  );
}
