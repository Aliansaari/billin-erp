// ── Record EMI modal ───────────────────────────────────────────────
//
// One-click EMI posting. Pre-fills the principal/interest split from
// the next-due row in the amortization schedule, lets the operator
// override (in case of partial pre-payment / catch-up of multiple
// missed EMIs), then POSTs to /api/loans/:id/emi which posts the
// proper double-entry voucher:
//
//   For TAKEN:   Loan Dr (principal) + Interest Expense Dr (interest)
//                / Bank Cr (total)
//   For GIVEN:   Bank Dr (total) / Loan Cr (principal) + Interest Income Cr
//
// Renders inside the shared EntityFormModal shell — F1 Save / F5 Reset
// / F8 Save & Close / Esc Cancel like every other entity form.

import React, { useEffect, useState } from 'react';
import { Form, DatePicker, InputNumber, Input, Radio, message } from 'antd';
import { WalletOutlined, BankOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { loanAPI } from '../../api';
import BankLedgerSelect from '../../components/BankLedgerSelect';
import EntityFormModal from '../../components/EntityFormModal';
import { inrFormatter, inrParser } from '../../utils/indianFormat';

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function RecordEMIModal({ open, onClose, onSaved, loan }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [schedule, setSchedule] = useState(null);
  // Cash vs bank for the cash leg. Defaults to Bank — most operators
  // pay EMIs from a bank account. Switch to Cash for operators who
  // physically hand over money or receive cash repayments.
  const [payMode, setPayMode] = useState('Bank');
  const [bankLedgerId, setBankLedgerId] = useState(null);
  const [dirty, setDirty] = useState(false);

  // Pull the schedule when modal opens to compute the pre-fill values.
  useEffect(() => {
    if (!open || !loan) return;
    let cancelled = false;
    setDirty(false);
    setPayMode('Bank');
    setBankLedgerId(null);
    loanAPI.schedule(loan.ledger_id)
      .then((r) => {
        if (cancelled) return;
        setSchedule(r.data);
        // Find the first unpaid EMI = paid_count'th index in the array.
        const next = (r.data.schedule || [])[r.data.paid_count];
        if (next) {
          form.setFieldsValue({
            date:      dayjs(next.due_date),
            total:     next.emi,
            principal: next.principal,
            interest:  next.interest,
          });
        } else {
          form.setFieldsValue({ date: dayjs(), total: 0, principal: 0, interest: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Fall back to whatever we know without the schedule.
          form.setFieldsValue({ date: dayjs(), total: 0, principal: 0, interest: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [open, loan, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { message.warning('Fix the highlighted fields and try again'); return; }

    const total = (Number(v.principal) || 0) + (Number(v.interest) || 0);
    if (total <= 0) {
      message.warning('Principal + interest must be > 0');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        date:      v.date.format('YYYY-MM-DD'),
        principal: Number(v.principal) || 0,
        interest:  Number(v.interest)  || 0,
        narration: v.narration || null,
      };
      if (payMode === 'Cash') {
        payload.use_cash = true;
      } else {
        payload.bank_ledger_id = bankLedgerId || null;
      }
      await loanAPI.recordEmi(loan.ledger_id, payload);
      message.success(`EMI recorded — ₹${fmtN(total)} ${payMode === 'Cash' ? 'cash' : 'via bank'}`);
      setDirty(false);
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to record EMI');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!schedule) return;
    const next = (schedule.schedule || [])[schedule.paid_count];
    if (next) {
      form.setFieldsValue({
        date:      dayjs(next.due_date),
        total:     next.emi,
        principal: next.principal,
        interest:  next.interest,
        narration: null,
      });
    }
    setPayMode('Bank');
    setBankLedgerId(null);
    setDirty(false);
  };

  // ── Total ⇄ principal/interest auto-split ───────────────────────────
  // The interest for a period is fixed by the outstanding × monthly rate, so
  // it's the anchor; whatever the operator types as the Total goes:
  //   principal = total − interest   (the part that pays down the loan)
  // Editing any one field keeps the other two consistent. Programmatic
  // setFieldsValue doesn't re-fire onChange, so there's no feedback loop.
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const onTotalChange = (val) => {
    const intr = Number(form.getFieldValue('interest')) || 0;
    form.setFieldsValue({ principal: Math.max(0, r2((Number(val) || 0) - intr)) });
  };
  const onInterestChange = (val) => {
    const total = Number(form.getFieldValue('total')) || 0;
    form.setFieldsValue({ principal: Math.max(0, r2(total - (Number(val) || 0))) });
  };
  const onPrincipalChange = (val) => {
    const intr = Number(form.getFieldValue('interest')) || 0;
    form.setFieldsValue({ total: r2((Number(val) || 0) + intr) });
  };

  if (!loan) return null;
  const isTaken = loan.loan_type === 'taken';
  const next = schedule?.schedule?.[schedule.paid_count];
  const remaining = (schedule?.total_count || loan.emi_total) - (schedule?.paid_count || loan.emi_count || 0);

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
        title="Record EMI"
        subtitle={loan.name}
        entityIcon="₹"
        entityTone="success"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAndClose={handleSave}
        onReset={handleReset}
        width={520}
      >
        <EntityFormModal.Section label="Schedule">
          <div className="efm-callout" style={{ gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>EMI <b>#{(schedule?.paid_count || 0) + 1}</b> of <b>{schedule?.total_count || loan.emi_total}</b></span>
              <span style={{ color: 'var(--fg-tertiary)' }}>{remaining} remaining</span>
            </div>
            {next && (
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--fg-tertiary)' }}>
                Scheduled for <b>{dayjs(next.due_date).format('DD MMM YYYY')}</b>
                {' · '}EMI <b>₹{fmtN(next.emi)}</b>
                {' '}(principal <b>₹{fmtN(next.principal)}</b> + interest <b>₹{fmtN(next.interest)}</b>)
              </div>
            )}
          </div>

          <EntityFormModal.Field
            label={isTaken ? 'Payment Date' : 'Receipt Date'}
            required
            span="full"
          >
            <Form.Item name="date" rules={[{ required: true, message: 'Required' }]} noStyle>
              <DatePicker className="efm-input" style={{ width: '100%' }} format="DD-MM-YYYY" allowClear={false} />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        <EntityFormModal.Section label="EMI Amount">
          <EntityFormModal.Field
            label="Total EMI"
            help="Type the full EMI — principal & interest split below fills in automatically."
            span="full"
          >
            <Form.Item
              name="total"
              rules={[{ type: 'number', min: 0, message: 'Cannot be negative' }]}
              noStyle
            >
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={0}
                step={100}
                style={{ width: '100%' }}
                controls={false}
                onChange={onTotalChange}
                formatter={(v) => v != null && v !== '' ? inrFormatter(v) : ''}
                parser={(v) => v.replace(/₹\s?|,/g, '')}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label="Principal Portion"
            help={isTaken ? 'Reduces loan balance' : 'Reduces what they owe'}
          >
            <Form.Item
              name="principal"
              rules={[{ type: 'number', min: 0, message: 'Cannot be negative' }]}
              noStyle
            >
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={0}
                step={100}
                style={{ width: '100%' }}
                controls={false}
                onChange={onPrincipalChange}
                formatter={(v) => v != null && v !== '' ? inrFormatter(v) : ''}
                parser={(v) => v.replace(/₹\s?|,/g, '')}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label="Interest Portion"
            help={isTaken ? 'Posts to Interest Expense' : 'Posts to Interest Income'}
          >
            <Form.Item
              name="interest"
              rules={[{ type: 'number', min: 0, message: 'Cannot be negative' }]}
              noStyle
            >
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={0}
                step={100}
                style={{ width: '100%' }}
                controls={false}
                onChange={onInterestChange}
                formatter={(v) => v != null && v !== '' ? inrFormatter(v) : ''}
                parser={(v) => v.replace(/₹\s?|,/g, '')}
              />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        <EntityFormModal.Section label="Method">
          <EntityFormModal.Field
            label={isTaken ? 'Pay via' : 'Receive in'}
            span={payMode === 'Bank' ? 'half' : 'full'}
          >
            <Radio.Group
              value={payMode}
              onChange={(e) => { setPayMode(e.target.value); setDirty(true); }}
              style={{ width: '100%', display: 'flex' }}
            >
              <Radio.Button value="Cash" style={{ flex: 1, textAlign: 'center' }}>
                <WalletOutlined /> Cash
              </Radio.Button>
              <Radio.Button value="Bank" style={{ flex: 1, textAlign: 'center' }}>
                <BankOutlined /> Bank
              </Radio.Button>
            </Radio.Group>
          </EntityFormModal.Field>

          {/* Bank picker — only when Bank mode selected. Cash uses the
              system Cash ledger automatically (resolved server-side). */}
          {payMode === 'Bank' && (
            <EntityFormModal.Field label={isTaken ? 'From bank' : 'To bank'}>
              <BankLedgerSelect
                value={bankLedgerId}
                onChange={(v) => { setBankLedgerId(v); setDirty(true); }}
                mode="Cheque"
                style={{ width: '100%' }}
              />
            </EntityFormModal.Field>
          )}

          <EntityFormModal.Field label="Narration" span="full">
            <Form.Item name="narration" noStyle>
              <Input
                className="efm-input"
                placeholder={`EMI ${isTaken ? 'paid' : 'received'} — auto-generated if blank`}
                maxLength={200}
              />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>
      </EntityFormModal>
    </Form>
  );
}
