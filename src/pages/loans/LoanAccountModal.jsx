// ── Add / Edit Loan modal ─────────────────────────────────────────
//
// Single modal for both create and edit. The killer feature is the
// live EMI calculator strip that updates as the operator types
// principal / rate / tenure — so they can see the EMI before saving.
//
// Form fields:
//   • Loan Name (required, unique)
//   • Loan Type (Taken / Given) — toggle that decides Liability vs Asset
//   • Lender / Borrower (party picker, optional)
//   • Principal (required, > 0)
//   • Interest Rate (annual %, default 0)
//   • Tenure (months, required > 0)
//   • Disbursement Date (defaults today)
//   • First EMI Date (defaults disbursement + 1 month)
//   • EMI Amount (auto-calculated, manual override allowed)
//   • EMI Day (1-31, optional reminder hint)
//   • Notes (optional)
//
// Live preview strip:
//   ┌────────────────────────────────────────┐
//   │  EMI: ₹X · Total payable: ₹Y · Interest: ₹Z │
//   └────────────────────────────────────────┘

import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Form, Input, InputNumber, Radio, DatePicker, Select, message } from 'antd';
import { BankOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { loanAPI, partyAPI } from '../../api';

const fmtN = (v) => Number(v || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

// Standard amortization (mirrors server-side computeEmi). Used purely
// for the live preview; the server recomputes on save anyway.
function computeEmi(principal, annualPct, months) {
  const P = Number(principal) || 0;
  const n = Number(months) || 0;
  const annual = Number(annualPct) || 0;
  if (P <= 0 || n <= 0) return 0;
  if (annual === 0) return P / n;
  const r = annual / 12 / 100;
  const f = Math.pow(1 + r, n);
  return P * r * f / (f - 1);
}

export default function LoanAccountModal({ open, onClose, onSaved, loan }) {
  const isEdit = !!loan;
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [parties, setParties] = useState([]);

  // Watch the relevant fields so the EMI preview updates live.
  const loanType    = Form.useWatch('loan_type', form) || 'taken';
  const principal   = Form.useWatch('principal', form);
  const intRate     = Form.useWatch('interest_rate', form);
  const tenure      = Form.useWatch('tenure_months', form);
  const overrideEmi = Form.useWatch('emi_amount', form);

  const computedEmi = useMemo(
    () => computeEmi(principal, intRate, tenure),
    [principal, intRate, tenure],
  );
  const effectiveEmi = overrideEmi && overrideEmi > 0 ? Number(overrideEmi) : computedEmi;
  const totalPayable = effectiveEmi * (Number(tenure) || 0);
  const totalInterest = Math.max(0, totalPayable - (Number(principal) || 0));

  // Disable type/principal when entries posted (server enforces too,
  // but disabling at the UI keeps users from hitting a wall later).
  const lockTerms = isEdit && (loan?.txn_count || 0) > 0;

  useEffect(() => {
    if (!open) return;
    // Pull party list. Lenders are typically Suppliers; borrowers
    // typically Customers. Show both kinds — the operator picks.
    //
    // /api/parties returns { total, page, limit, data: rows }. Read
    // .data.data — using the wrong key would set parties to a wrapper
    // object, and the downstream parties.map(...) call would crash
    // and blank the page (the original "Add" crash).
    partyAPI.getAll({ limit: 5000 })
      .then((r) => {
        const arr = Array.isArray(r.data) ? r.data
                  : Array.isArray(r.data?.data) ? r.data.data
                  : Array.isArray(r.data?.parties) ? r.data.parties
                  : [];
        setParties(arr);
      })
      .catch(() => setParties([]));

    if (isEdit) {
      form.setFieldsValue({
        name:              loan.name,
        loan_type:         loan.loan_type,
        party_id:          loan.party_id || undefined,
        principal:         loan.principal,
        interest_rate:     loan.interest_rate,
        tenure_months:     loan.tenure_months,
        disbursement_date: loan.disbursement_date ? dayjs(loan.disbursement_date) : null,
        first_emi_date:    loan.first_emi_date    ? dayjs(loan.first_emi_date)    : null,
        emi_amount:        loan.emi_amount,
        emi_day:           loan.emi_day,
        notes:             loan.notes,
      });
    } else {
      const today = dayjs();
      form.setFieldsValue({
        loan_type:         'taken',
        principal:         null,
        interest_rate:     0,
        tenure_months:     null,
        disbursement_date: today,
        first_emi_date:    today.add(1, 'month'),
        emi_amount:        null,
        emi_day:           today.add(1, 'month').date(),
        notes:             '',
      });
    }
  }, [open, isEdit, loan, form]);

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { return; }

    const body = {
      name:              String(v.name || '').trim(),
      loan_type:         v.loan_type,
      party_id:          v.party_id || null,
      principal:         Number(v.principal) || 0,
      interest_rate:     Number(v.interest_rate) || 0,
      tenure_months:     Number(v.tenure_months) || 0,
      disbursement_date: v.disbursement_date ? v.disbursement_date.format('YYYY-MM-DD') : null,
      first_emi_date:    v.first_emi_date    ? v.first_emi_date.format('YYYY-MM-DD')    : null,
      emi_amount:        v.emi_amount ? Number(v.emi_amount) : null,
      emi_day:           v.emi_day || null,
      notes:             v.notes || null,
    };

    setSaving(true);
    try {
      if (isEdit) {
        await loanAPI.update(loan.ledger_id, body);
        message.success(`"${body.name}" updated`);
      } else {
        const { data } = await loanAPI.create(body);
        message.success(`"${data.name}" added — EMI ₹${fmtN(data.emi_amount)}`);
      }
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to save loan');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <BankOutlined style={{ color: '#4F46E5' }} />
          {isEdit ? 'Edit Loan' : 'Add Loan'}
        </span>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText={isEdit ? 'Save changes' : 'Add loan'}
      confirmLoading={saving}
      destroyOnClose
      width={680}
    >
      <Form form={form} layout="vertical" requiredMark={false} preserve={false}>

        {/* Type — top of form because it changes the labels on Party. */}
        <Form.Item
          name="loan_type"
          label="Loan type"
          rules={[{ required: true }]}
          extra={lockTerms ? 'Locked — entries already posted to this loan.' : null}
        >
          <Radio.Group disabled={lockTerms}>
            <Radio.Button value="taken">
              <div style={{ fontWeight: 600 }}>Loan Taken</div>
              <div style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>
                Liability · we owe the lender
              </div>
            </Radio.Button>
            <Radio.Button value="given">
              <div style={{ fontWeight: 600 }}>Loan Given</div>
              <div style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>
                Asset · borrower owes us
              </div>
            </Radio.Button>
          </Radio.Group>
        </Form.Item>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item
            name="name"
            label="Loan name"
            rules={[
              { required: true, message: 'Loan name is required' },
              { whitespace: true, message: 'Loan name is required' },
            ]}
            extra={isEdit ? null : 'e.g. "HDFC Vehicle Loan", "Advance to Ramesh"'}
          >
            <Input placeholder="HDFC Vehicle Loan" maxLength={100} autoFocus={!isEdit} />
          </Form.Item>

          <Form.Item
            name="party_id"
            label={loanType === 'taken' ? 'Lender (optional)' : 'Borrower (optional)'}
          >
            <Select
              showSearch allowClear
              optionFilterProp="children"
              placeholder={loanType === 'taken' ? 'Pick lender' : 'Pick borrower'}
            >
              {parties.map((p) => (
                <Select.Option key={p.party_id} value={p.party_id}>
                  {p.party_name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Form.Item
            name="principal"
            label="Principal"
            rules={[
              { required: true, message: 'Principal is required' },
              { type: 'number', min: 1, message: 'Must be > 0' },
            ]}
          >
            <InputNumber
              keyboard={false} disabled={lockTerms} min={0} step={1000} style={{ width: '100%' }}
              placeholder="100000"
              formatter={(v) => v != null && v !== '' ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
              parser={(v) => v.replace(/₹\s?|,/g, '')}
            />
          </Form.Item>
          <Form.Item
            name="interest_rate" label="Interest %"
            rules={[{ type: 'number', min: 0, max: 100 }]}
          >
            <InputNumber
              keyboard={false} min={0} max={100} step={0.25} precision={3}
              style={{ width: '100%' }} placeholder="9.5"
              formatter={(v) => v !== null && v !== undefined && v !== '' ? `${v}%` : ''}
              parser={(v) => String(v).replace('%', '')}
            />
          </Form.Item>
          <Form.Item
            name="tenure_months" label="Tenure (mo.)"
            rules={[
              { required: true, message: 'Required' },
              { type: 'number', min: 1, max: 600, message: '1–600 months' },
            ]}
          >
            <InputNumber keyboard={false} min={1} max={600} style={{ width: '100%' }} placeholder="60" />
          </Form.Item>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Form.Item name="disbursement_date" label="Disbursement date">
            <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
          </Form.Item>
          <Form.Item name="first_emi_date" label="First EMI date">
            <DatePicker style={{ width: '100%' }} format="DD-MM-YYYY" />
          </Form.Item>
          <Form.Item
            name="emi_day" label="EMI day (1–31)"
            extra="Reminder hint"
          >
            <InputNumber keyboard={false} min={1} max={31} style={{ width: '100%' }} placeholder="5" />
          </Form.Item>
        </div>

        <Form.Item
          name="emi_amount" label="EMI amount (override)"
          extra="Leave blank to use the calculated amount below"
        >
          <InputNumber
            keyboard={false} min={0} step={100} style={{ width: '100%' }}
            placeholder={computedEmi ? `Calculated: ₹ ${fmtN(computedEmi)}` : 'Auto'}
            formatter={(v) => v != null && v !== '' ? `₹ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
            parser={(v) => v.replace(/₹\s?|,/g, '')}
          />
        </Form.Item>

        <Form.Item name="notes" label="Notes">
          <Input.TextArea rows={2} placeholder="Loan agreement number, branch, anything you need to remember…" maxLength={500} />
        </Form.Item>

        {/* ─── Live calculator strip — updates as fields change ─── */}
        {effectiveEmi > 0 && Number(tenure) > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0,
            border: '1px solid #E5E7EB', borderRadius: 8, overflow: 'hidden',
            background: 'linear-gradient(135deg, rgba(79,70,229,0.04), #FFFFFF 70%)',
          }}>
            <CalcCell
              label="Monthly EMI"
              value={`₹ ${fmtN(effectiveEmi)}`}
              accent="#4F46E5"
              note={overrideEmi && overrideEmi > 0 && Math.abs(overrideEmi - computedEmi) > 0.5
                ? `Manual override (calc'd: ₹ ${fmtN(computedEmi)})`
                : 'From principal × rate × tenure'}
            />
            <CalcCell
              label="Total payable"
              value={`₹ ${fmtN(totalPayable)}`}
              note={`${tenure} EMIs × ₹ ${fmtN(effectiveEmi)}`}
            />
            <CalcCell
              label="Total interest"
              value={`₹ ${fmtN(totalInterest)}`}
              accent={totalInterest > 0 ? '#EF4444' : '#10B981'}
              note={loanType === 'taken' ? 'Cost of borrowing' : 'Earnings from lending'}
              border={false}
            />
          </div>
        )}
      </Form>
    </Modal>
  );
}

function CalcCell({ label, value, note, accent, border = true }) {
  return (
    <div style={{
      padding: '10px 14px',
      borderRight: border ? '1px solid #E5E7EB' : 'none',
    }}>
      <div style={{
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4,
        textTransform: 'uppercase', color: '#6B7280',
      }}>{label}</div>
      <div style={{
        fontSize: 17, fontWeight: 700, marginTop: 3,
        color: accent || '#111827',
        letterSpacing: '-0.01em',
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
      {note && (
        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 1 }}>{note}</div>
      )}
    </div>
  );
}
