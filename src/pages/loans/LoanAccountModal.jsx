// ── Add / Edit Loan modal ─────────────────────────────────────────
//
// Single modal for both create and edit. The killer feature is the
// live EMI calculator strip that updates as the operator types
// principal / rate / tenure — so they can see the EMI before saving.
//
// Now renders inside the shared EntityFormModal shell so the chrome /
// F-key vocabulary / dirty-state confirm matches every other form.
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
// Live preview cells in the "Preview" section show monthly EMI, total
// payable, and total interest — recomputed via Form.useWatch.

import React, { useEffect, useMemo, useState } from 'react';
import { Form, Input, InputNumber, DatePicker, Select, message } from 'antd';
import dayjs from 'dayjs';
import { loanAPI, partyAPI } from '../../api';
import EntityFormModal from '../../components/EntityFormModal';
import { inrFormatter, inrParser } from '../../utils/indianFormat';

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
  const [dirty, setDirty] = useState(false);

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

  const setLoanType = (t) => {
    form.setFieldsValue({ loan_type: t });
    setDirty(true);
  };

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    // Pull party list. Lenders are typically Suppliers; borrowers
    // typically Customers. Show both kinds — the operator picks.
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
        name:              '',
        loan_type:         'taken',
        party_id:          undefined,
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
    catch { message.warning('Fix the highlighted fields and try again'); return; }

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
      setDirty(false);
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to save loan');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
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
        name:              '',
        loan_type:         'taken',
        party_id:          undefined,
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
    setDirty(false);
  };

  const showPreview = effectiveEmi > 0 && Number(tenure) > 0;

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
        title={isEdit ? 'Edit Loan' : 'Add Loan'}
        subtitle={isEdit ? loan?.name : 'New loan ledger · auto-generates amortization schedule'}
        entityIcon="L"
        entityTone="info"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAndClose={handleSave}
        onReset={handleReset}
        width={680}
      >
        <EntityFormModal.Section label="Type & Identity">
          {/* Hidden Form.Item to register loan_type with the form. The
              visible UI is the toggle-cards row below. */}
          <Form.Item name="loan_type" hidden noStyle>
            <Input />
          </Form.Item>

          <div className="efm-toggle-cards" style={{ gridColumn: '1 / -1' }}>
            <button
              type="button"
              className={loanType === 'taken' ? 'on' : ''}
              disabled={lockTerms}
              onClick={() => setLoanType('taken')}
            >
              <div className="ic">↓</div>
              <div className="stack">
                <div className="name">Loan Taken</div>
                <div className="hint">Liability · we owe the lender</div>
              </div>
            </button>
            <button
              type="button"
              className={loanType === 'given' ? 'on' : ''}
              disabled={lockTerms}
              onClick={() => setLoanType('given')}
            >
              <div className="ic">↑</div>
              <div className="stack">
                <div className="name">Loan Given</div>
                <div className="hint">Asset · borrower owes us</div>
              </div>
            </button>
          </div>

          {lockTerms && (
            <div className="efm-callout warning" style={{ gridColumn: '1 / -1' }}>
              Type & principal are locked — entries already posted to this loan.
            </div>
          )}

          <EntityFormModal.Field
            label="Loan Name"
            required
            span="full"
            help={isEdit ? null : 'e.g. "HDFC Vehicle Loan", "Advance to Ramesh"'}
          >
            <Form.Item
              name="name"
              rules={[
                { required: true, message: 'Loan name is required' },
                { whitespace: true, message: 'Loan name is required' },
              ]}
              noStyle
            >
              <Input className="efm-input" placeholder="HDFC Vehicle Loan" maxLength={100} autoFocus={!isEdit} />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label={loanType === 'taken' ? 'Lender (optional)' : 'Borrower (optional)'}
            span="full"
          >
            <Form.Item name="party_id" noStyle>
              <Select
                className="efm-select-antd"
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
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        <EntityFormModal.Section label="Terms">
          <EntityFormModal.Field label="Principal" required>
            <Form.Item
              name="principal"
              rules={[
                { required: true, message: 'Required' },
                { type: 'number', min: 1, message: 'Must be > 0' },
              ]}
              noStyle
            >
              <InputNumber
                className="efm-input"
                keyboard={false}
                disabled={lockTerms}
                min={0}
                step={1000}
                style={{ width: '100%' }}
                controls={false}
                placeholder="100000"
                formatter={(v) => v != null && v !== '' ? inrFormatter(v) : ''}
                parser={(v) => v.replace(/₹\s?|,/g, '')}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="Interest %">
            <Form.Item
              name="interest_rate"
              rules={[{ type: 'number', min: 0, max: 100 }]}
              noStyle
            >
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={0}
                max={100}
                step={0.25}
                precision={3}
                style={{ width: '100%' }}
                controls={false}
                placeholder="9.5"
                formatter={(v) => v !== null && v !== undefined && v !== '' ? `${v}%` : ''}
                parser={(v) => String(v).replace('%', '')}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="Tenure (months)" required>
            <Form.Item
              name="tenure_months"
              rules={[
                { required: true, message: 'Required' },
                { type: 'number', min: 1, max: 600, message: '1–600' },
              ]}
              noStyle
            >
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={1}
                max={600}
                style={{ width: '100%' }}
                controls={false}
                placeholder="60"
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label="EMI Override"
            help="Leave blank for auto-calculated"
          >
            <Form.Item name="emi_amount" noStyle>
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={0}
                step={100}
                style={{ width: '100%' }}
                controls={false}
                placeholder={computedEmi ? `Calc: ₹${fmtN(computedEmi)}` : 'Auto'}
                formatter={(v) => v != null && v !== '' ? inrFormatter(v) : ''}
                parser={(v) => v.replace(/₹\s?|,/g, '')}
              />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        <EntityFormModal.Section label="Schedule">
          <EntityFormModal.Field label="Disbursement Date">
            <Form.Item name="disbursement_date" noStyle>
              <DatePicker className="efm-input" style={{ width: '100%' }} format="DD-MM-YYYY" />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="First EMI Date">
            <Form.Item name="first_emi_date" noStyle>
              <DatePicker className="efm-input" style={{ width: '100%' }} format="DD-MM-YYYY" />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="EMI Day (1–31)" help="Reminder hint">
            <Form.Item name="emi_day" noStyle>
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={1}
                max={31}
                style={{ width: '100%' }}
                controls={false}
                placeholder="5"
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="Notes" span="full">
            <Form.Item name="notes" noStyle>
              <Input.TextArea
                rows={2}
                placeholder="Loan agreement number, branch, anything you need to remember…"
                maxLength={500}
              />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        {showPreview && (
          <EntityFormModal.Section label="Preview">
            <div className="efm-calc" style={{ gridColumn: '1 / -1' }}>
              <div className="efm-calc-cell">
                <div className="k">Monthly EMI</div>
                <div className="v accent">₹ {fmtN(effectiveEmi)}</div>
                <div className="n">
                  {overrideEmi && overrideEmi > 0 && Math.abs(overrideEmi - computedEmi) > 0.5
                    ? `Manual (calc: ₹${fmtN(computedEmi)})`
                    : 'From P × R × N'}
                </div>
              </div>
              <div className="efm-calc-cell">
                <div className="k">Total Payable</div>
                <div className="v">₹ {fmtN(totalPayable)}</div>
                <div className="n">{tenure} EMIs × ₹{fmtN(effectiveEmi)}</div>
              </div>
              <div className="efm-calc-cell">
                <div className="k">Total Interest</div>
                <div className={`v ${totalInterest > 0 ? 'danger' : 'success'}`}>₹ {fmtN(totalInterest)}</div>
                <div className="n">{loanType === 'taken' ? 'Cost of borrowing' : 'Earnings from lending'}</div>
              </div>
            </div>
          </EntityFormModal.Section>
        )}
      </EntityFormModal>
    </Form>
  );
}
