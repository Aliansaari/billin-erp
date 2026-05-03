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
// The modal is intentionally lightweight — most of the time the
// operator just clicks "Record" and the defaults are correct.

import React, { useEffect, useState } from 'react';
import { Modal, Form, DatePicker, InputNumber, Input, Radio, message } from 'antd';
import { DollarOutlined, WalletOutlined, BankOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { loanAPI } from '../../api';
import BankLedgerSelect from '../../components/BankLedgerSelect';

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

  // Pull the schedule when modal opens to compute the pre-fill values.
  useEffect(() => {
    if (!open || !loan) return;
    let cancelled = false;
    loanAPI.schedule(loan.ledger_id)
      .then((r) => {
        if (cancelled) return;
        setSchedule(r.data);
        // Find the first unpaid EMI = paid_count'th index in the array.
        const next = (r.data.schedule || [])[r.data.paid_count];
        if (next) {
          form.setFieldsValue({
            date:      dayjs(next.due_date),
            principal: next.principal,
            interest:  next.interest,
          });
        } else {
          form.setFieldsValue({ date: dayjs(), principal: 0, interest: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Fall back to whatever we know without the schedule.
          form.setFieldsValue({ date: dayjs(), principal: 0, interest: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [open, loan, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { return; }

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
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to record EMI');
    } finally {
      setSaving(false);
    }
  };

  if (!loan) return null;
  const isTaken = loan.loan_type === 'taken';
  const next = schedule?.schedule?.[schedule.paid_count];
  const remaining = (schedule?.total_count || loan.emi_total) - (schedule?.paid_count || loan.emi_count || 0);

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <DollarOutlined style={{ color: '#10B981' }} />
          Record EMI · {loan.name}
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText={`Record ${isTaken ? 'payment' : 'receipt'}`}
      confirmLoading={saving}
      destroyOnClose
      width={520}
    >
      {/* Context summary */}
      <div style={{
        padding: '10px 14px', borderRadius: 8, marginBottom: 14,
        background: 'linear-gradient(135deg, rgba(79,70,229,0.05), #FFFFFF 60%)',
        border: '1px solid #E5E7EB',
        fontSize: 12.5, color: '#374151',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span>EMI <b>#{(schedule?.paid_count || 0) + 1}</b> of <b>{schedule?.total_count || loan.emi_total}</b></span>
          <span style={{ color: '#6B7280' }}>{remaining} remaining</span>
        </div>
        {next && (
          <div style={{ marginTop: 6, fontSize: 12, color: '#6B7280' }}>
            Scheduled for <b>{dayjs(next.due_date).format('DD MMM YYYY')}</b>
            {' · '}EMI <b>₹{fmtN(next.emi)}</b>
            {' '}(principal <b>₹{fmtN(next.principal)}</b> + interest <b>₹{fmtN(next.interest)}</b>)
          </div>
        )}
      </div>

      <Form form={form} layout="vertical" requiredMark={false} preserve={false}>
        <Form.Item
          name="date"
          label={isTaken ? 'Payment date' : 'Receipt date'}
          rules={[{ required: true, message: 'Required' }]}
        >
          <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
        </Form.Item>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item
            name="principal"
            label="Principal portion"
            rules={[{ type: 'number', min: 0, message: 'Cannot be negative' }]}
            extra={isTaken ? 'Reduces loan balance' : 'Reduces what they owe'}
          >
            <InputNumber
              keyboard={false} min={0} step={100} style={{ width: '100%' }}
              formatter={(v) => v != null && v !== '' ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
              parser={(v) => v.replace(/₹\s?|,/g, '')}
            />
          </Form.Item>
          <Form.Item
            name="interest"
            label="Interest portion"
            rules={[{ type: 'number', min: 0, message: 'Cannot be negative' }]}
            extra={isTaken ? 'Posts to Interest Expense' : 'Posts to Interest Income'}
          >
            <InputNumber
              keyboard={false} min={0} step={100} style={{ width: '100%' }}
              formatter={(v) => v != null && v !== '' ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
              parser={(v) => v.replace(/₹\s?|,/g, '')}
            />
          </Form.Item>
        </div>

        <Form.Item label={isTaken ? 'Pay via' : 'Receive in'}>
          <Radio.Group value={payMode} onChange={(e) => setPayMode(e.target.value)} buttonStyle="solid">
            <Radio.Button value="Cash" style={{ width: 120, textAlign: 'center' }}>
              <WalletOutlined /> Cash
            </Radio.Button>
            <Radio.Button value="Bank" style={{ width: 120, textAlign: 'center' }}>
              <BankOutlined /> Bank
            </Radio.Button>
          </Radio.Group>
        </Form.Item>

        {/* Bank picker — only when Bank mode selected. Cash uses the
            system Cash ledger automatically (resolved server-side). */}
        {payMode === 'Bank' && (
          <Form.Item label={isTaken ? 'Paid from bank' : 'Received in bank'}>
            <BankLedgerSelect
              value={bankLedgerId}
              onChange={setBankLedgerId}
              mode="Cheque"
              style={{ width: '100%' }}
            />
          </Form.Item>
        )}

        <Form.Item name="narration" label="Narration (optional)">
          <Input placeholder={`EMI ${isTaken ? 'paid' : 'received'} — auto-generated if blank`} maxLength={200} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
