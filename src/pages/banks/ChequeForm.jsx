// ── Cheque Form modal ─────────────────────────────────────────────
//
// Single modal for both create and edit. The relevant prop is
// `cheque` — null = create, an object = edit. Renders inside the
// shared EntityFormModal shell.
//
// Direction is the structural choice that picks every other label:
//   • INWARD  — received from a customer.  The party picker filters
//                customers / both-typed parties; the bank picker is
//                "deposit destination" (optional at PENDING).
//   • OUTWARD — issued to a supplier.  The party picker filters
//                suppliers / both-typed; the bank picker is "drawn
//                on" (required), and a future-dated cheque becomes
//                a PDC (post-dated cheque) automatically.
//
// Live preview banner shows the exact double-entry that will post
// when the operator hits Save.
//
// Editing financial details is only allowed while PENDING. Past
// PENDING the form opens in memo-only mode (notes editable, all
// other fields locked + disabled).

import React, { useEffect, useMemo, useState } from 'react';
import { Form, Input, InputNumber, DatePicker, Select, message } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { chequeAPI, partyAPI, bankAPI } from '../../api';
import EntityFormModal from '../../components/EntityFormModal';
import { inrFormatter, inrParser } from '../../utils/indianFormat';

const fmtRupees = (v) => {
  const n = Number(v) || 0;
  return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function ChequeForm({ open, onClose, onSaved, cheque }) {
  const isEdit = !!cheque;
  const isPending = !isEdit || cheque.status === 'PENDING';
  const memoOnly = isEdit && !isPending;

  const [form] = Form.useForm();
  const [saving, setSaving]   = useState(false);
  const [parties, setParties] = useState([]);
  const [banks,   setBanks]   = useState([]);
  const [dirty,   setDirty]   = useState(false);

  // Watch the relevant fields so the preview banner updates live as
  // the operator types. Each Form.useWatch returns undefined while the
  // form mounts; we coerce to safe defaults in the memo below.
  const direction      = Form.useWatch('direction', form) || 'INWARD';
  const amount         = Form.useWatch('amount', form);
  const partyId        = Form.useWatch('party_id', form);
  const bankLedgerId   = Form.useWatch('bank_ledger_id', form);
  const chequeDate     = Form.useWatch('cheque_date', form);
  const instrumentDate = Form.useWatch('instrument_date', form);

  // Filter the party dropdown by direction. Both-typed parties always
  // qualify since they can play either side.
  const filteredParties = useMemo(() => {
    if (!Array.isArray(parties)) return [];
    if (direction === 'INWARD') {
      return parties.filter((p) => p.party_type === 'Customer' || p.party_type === 'Both');
    }
    return parties.filter((p) => p.party_type === 'Supplier' || p.party_type === 'Both');
  }, [parties, direction]);

  const isPdc = useMemo(() => {
    if (!chequeDate || !instrumentDate) return false;
    const cd = dayjs(chequeDate).startOf('day');
    const id = dayjs(instrumentDate).startOf('day');
    return cd.isAfter(id);
  }, [chequeDate, instrumentDate]);

  const selectedParty = useMemo(
    () => filteredParties.find((p) => p.party_id === partyId),
    [filteredParties, partyId],
  );
  const selectedBank = useMemo(
    () => banks.find((b) => b.ledger_id === bankLedgerId),
    [banks, bankLedgerId],
  );

  // Initial load: parties + banks. Re-runs each open so that newly-
  // added parties / banks show up without a page reload.
  useEffect(() => {
    if (!open) return;
    setDirty(false);

    partyAPI.getAll({ limit: 5000 })
      .then((r) => {
        const arr = Array.isArray(r.data) ? r.data
                  : Array.isArray(r.data?.data) ? r.data.data
                  : Array.isArray(r.data?.parties) ? r.data.parties
                  : [];
        // Drop the system Cash party — cheques can't be linked to it.
        setParties(arr.filter((p) => !p.is_system_cash));
      })
      .catch(() => setParties([]));

    bankAPI.list({ include_inactive: false })
      .then((r) => setBanks(r.data?.banks || []))
      .catch(() => setBanks([]));

    if (isEdit) {
      form.setFieldsValue({
        direction:        cheque.direction,
        cheque_number:    cheque.cheque_number,
        cheque_date:      cheque.cheque_date ? dayjs(cheque.cheque_date) : null,
        instrument_date:  cheque.instrument_date ? dayjs(cheque.instrument_date) : dayjs(),
        amount:           Number(cheque.amount),
        party_id:         cheque.party_id,
        bank_ledger_id:   cheque.bank_ledger_id || undefined,
        drawee_bank_name: cheque.drawee_bank_name || '',
        notes:            cheque.notes || '',
      });
    } else {
      const today = dayjs();
      form.setFieldsValue({
        direction:        'INWARD',
        cheque_number:    '',
        cheque_date:      today,
        instrument_date:  today,
        amount:           null,
        party_id:         undefined,
        bank_ledger_id:   undefined,
        drawee_bank_name: '',
        notes:            '',
      });
    }
  }, [open, isEdit, cheque, form]);

  // Direction toggle resets the party (since the selectable set
  // flips). Amount / dates / bank are kept because the operator
  // sometimes flips direction by accident on a new entry — we don't
  // want to lose the keystrokes.
  const setDirection = (d) => {
    form.setFieldsValue({ direction: d, party_id: undefined });
    setDirty(true);
  };

  const handleSave = async () => {
    let v;
    try { v = await form.validateFields(); }
    catch { message.warning('Fix the highlighted fields and try again'); return; }

    const body = memoOnly
      ? {
        notes: v.notes || null,
        drawee_bank_name: v.drawee_bank_name || null,
      }
      : {
        direction:        v.direction,
        cheque_number:    String(v.cheque_number || '').trim(),
        cheque_date:      v.cheque_date ? v.cheque_date.format('YYYY-MM-DD') : null,
        instrument_date:  v.instrument_date ? v.instrument_date.format('YYYY-MM-DD') : null,
        amount:           Number(v.amount) || 0,
        party_id:         v.party_id,
        bank_ledger_id:   v.bank_ledger_id || null,
        drawee_bank_name: v.drawee_bank_name || null,
        notes:            v.notes || null,
      };

    setSaving(true);
    try {
      if (isEdit) {
        await chequeAPI.update(cheque.cheque_id, body);
        message.success('Cheque updated');
      } else {
        await chequeAPI.create(body);
        message.success('Cheque recorded');
      }
      setDirty(false);
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || 'Failed to save cheque');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (isEdit) {
      form.setFieldsValue({
        direction:        cheque.direction,
        cheque_number:    cheque.cheque_number,
        cheque_date:      cheque.cheque_date ? dayjs(cheque.cheque_date) : null,
        instrument_date:  cheque.instrument_date ? dayjs(cheque.instrument_date) : dayjs(),
        amount:           Number(cheque.amount),
        party_id:         cheque.party_id,
        bank_ledger_id:   cheque.bank_ledger_id || undefined,
        drawee_bank_name: cheque.drawee_bank_name || '',
        notes:            cheque.notes || '',
      });
    } else {
      const today = dayjs();
      form.setFieldsValue({
        direction:        'INWARD',
        cheque_number:    '',
        cheque_date:      today,
        instrument_date:  today,
        amount:           null,
        party_id:         undefined,
        bank_ledger_id:   undefined,
        drawee_bank_name: '',
        notes:            '',
      });
    }
    setDirty(false);
  };

  // Resolve the human-readable double-entry preview based on the
  // current form state. Mirrors the server-side voucher builders so
  // the operator's expectation matches what gets posted.
  const previewLines = useMemo(() => {
    if (!amount || !selectedParty) return null;
    const amt = fmtRupees(amount);
    if (direction === 'INWARD') {
      return [
        { dr: 'Cheques in Hand', drAmt: amt, cr: selectedParty.party_name, crAmt: amt },
      ];
    }
    if (isPdc) {
      return [
        { dr: selectedParty.party_name, drAmt: amt, cr: 'Cheques Issued (PDC)', crAmt: amt },
      ];
    }
    if (!selectedBank) return null;
    return [
      { dr: selectedParty.party_name, drAmt: amt, cr: selectedBank.name, crAmt: amt },
    ];
  }, [direction, amount, selectedParty, selectedBank, isPdc]);

  const title = isEdit
    ? (memoOnly ? 'Edit Notes' : 'Edit Cheque')
    : 'Record Cheque';

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
        title={title}
        subtitle={isEdit ? `${cheque.direction} · ${cheque.cheque_number}` : 'Capture an inward or outward cheque'}
        entityIcon="₹"
        entityTone="accent"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onSaveAndClose={handleSave}
        onReset={handleReset}
        width={620}
      >
        {/* Hidden Form.Item to register direction with the form. The
            visible UI is the toggle-cards row below. */}
        <Form.Item name="direction" hidden noStyle>
          <Input />
        </Form.Item>

        <EntityFormModal.Section label="Direction">
          <div className="efm-toggle-cards" style={{ gridColumn: '1 / -1' }}>
            <button
              type="button"
              className={direction === 'INWARD' ? 'on' : ''}
              disabled={isEdit}
              onClick={() => setDirection('INWARD')}
            >
              <div className="ic"><ArrowDownOutlined /></div>
              <div className="stack">
                <div className="name">Inward · Received</div>
                <div className="hint">From a customer or debtor</div>
              </div>
            </button>
            <button
              type="button"
              className={direction === 'OUTWARD' ? 'on' : ''}
              disabled={isEdit}
              onClick={() => setDirection('OUTWARD')}
            >
              <div className="ic"><ArrowUpOutlined /></div>
              <div className="stack">
                <div className="name">Outward · Issued</div>
                <div className="hint">To a supplier or creditor</div>
              </div>
            </button>
          </div>

          {memoOnly && (
            <div className="efm-callout warning" style={{ gridColumn: '1 / -1' }}>
              Cheque is <b>{cheque.status}</b> — only notes / drawee name can be edited. To change financial details, cancel the cheque and record a new one.
            </div>
          )}
        </EntityFormModal.Section>

        <EntityFormModal.Section label="Cheque">
          <EntityFormModal.Field label="Cheque Number" required>
            <Form.Item
              name="cheque_number"
              rules={[
                { required: true, message: 'Required' },
                { max: 40, message: 'Max 40 characters' },
                { whitespace: true, message: 'Required' },
              ]}
              noStyle
            >
              <Input className="efm-input" placeholder="000123" maxLength={40} disabled={memoOnly} autoFocus={!isEdit} />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field label="Amount" required>
            <Form.Item
              name="amount"
              rules={[
                { required: true, message: 'Required' },
                { type: 'number', min: 0.01, message: 'Must be > 0' },
              ]}
              noStyle
            >
              <InputNumber
                className="efm-input"
                keyboard={false}
                min={0.01}
                step={100}
                style={{ width: '100%' }}
                controls={false}
                placeholder="0.00"
                disabled={memoOnly}
                formatter={(v) => v != null && v !== '' ? inrFormatter(v) : ''}
                parser={(v) => v.replace(/₹\s?|,/g, '')}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label={direction === 'INWARD' ? 'Received On' : 'Issued On'}
            required
            help="Date the cheque physically changed hands."
          >
            <Form.Item name="instrument_date" rules={[{ required: true, message: 'Required' }]} noStyle>
              <DatePicker className="efm-input" style={{ width: '100%' }} format="DD MMM YYYY" disabled={memoOnly} allowClear={false} />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label="Cheque Date"
            required
            help={isPdc ? <span style={{ color: 'var(--warning)', fontWeight: 600 }}>Post-dated · PDC</span> : 'Date written on the cheque face.'}
          >
            <Form.Item name="cheque_date" rules={[{ required: true, message: 'Required' }]} noStyle>
              <DatePicker className="efm-input" style={{ width: '100%' }} format="DD MMM YYYY" disabled={memoOnly} allowClear={false} />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        <EntityFormModal.Section label="Counterparty">
          <EntityFormModal.Field
            label={direction === 'INWARD' ? 'From Customer' : 'To Supplier'}
            required
            span="full"
          >
            <Form.Item
              name="party_id"
              rules={[{ required: true, message: `Pick a ${direction === 'INWARD' ? 'customer' : 'supplier'}` }]}
              noStyle
            >
              <Select
                className="efm-select-antd"
                showSearch
                placeholder={direction === 'INWARD' ? 'Select customer…' : 'Select supplier…'}
                optionFilterProp="label"
                disabled={memoOnly}
                options={filteredParties.map((p) => ({
                  value: p.party_id,
                  label: p.party_name + (p.mobile_1 && p.mobile_1 !== 'CASH' ? ` · ${p.mobile_1}` : ''),
                }))}
              />
            </Form.Item>
          </EntityFormModal.Field>

          <EntityFormModal.Field
            label={direction === 'INWARD' ? 'Deposit To' : 'Drawn On'}
            required={direction === 'OUTWARD'}
            help={direction === 'INWARD' ? 'Optional — required when you deposit' : null}
          >
            <Form.Item
              name="bank_ledger_id"
              rules={direction === 'OUTWARD' ? [{ required: true, message: 'Pick the bank' }] : []}
              noStyle
            >
              <Select
                className="efm-select-antd"
                showSearch
                placeholder="Select bank…"
                optionFilterProp="label"
                disabled={memoOnly && direction !== 'INWARD'}
                allowClear={direction === 'INWARD'}
                options={banks.map((b) => ({
                  value: b.ledger_id,
                  label: b.name + (b.is_overdraft ? ' (OD)' : ''),
                }))}
              />
            </Form.Item>
          </EntityFormModal.Field>

          {direction === 'INWARD' && (
            <EntityFormModal.Field label="Drawee Bank" help="Customer's bank name printed on the cheque">
              <Form.Item name="drawee_bank_name" noStyle>
                <Input className="efm-input" placeholder="HDFC, ICICI, …" maxLength={120} />
              </Form.Item>
            </EntityFormModal.Field>
          )}

          <EntityFormModal.Field label="Notes" span="full">
            <Form.Item name="notes" noStyle>
              <Input.TextArea rows={2} maxLength={500} showCount placeholder="Optional context…" />
            </Form.Item>
          </EntityFormModal.Field>
        </EntityFormModal.Section>

        {/* Live preview — reads the watched form values and renders
            the exact Dr/Cr that will post. Doesn't show until enough
            of the form is filled in to make a meaningful prediction. */}
        {!memoOnly && previewLines && (
          <EntityFormModal.Section label="Will Post">
            <div className="efm-preview" style={{ gridColumn: '1 / -1' }}>
              {previewLines.map((line, i) => (
                <div key={i}>
                  <div className="leg">
                    <span className="dr">Dr</span> {line.dr} · <b>{line.drAmt}</b>
                  </div>
                  <div style={{ marginLeft: 14, marginTop: 2 }} className="leg">
                    <span className="cr">Cr</span> {line.cr} · <b>{line.crAmt}</b>
                  </div>
                </div>
              ))}
              {isPdc && direction === 'OUTWARD' && (
                <div className="pdc">Post-dated cheque — credits the PDC liability ledger, not your bank, until it matures.</div>
              )}
              {isPdc && direction === 'INWARD' && (
                <div className="pdc">Post-dated cheque — sits in Cheques in Hand; cannot be deposited until the cheque date.</div>
              )}
            </div>
          </EntityFormModal.Section>
        )}
      </EntityFormModal>
    </Form>
  );
}
