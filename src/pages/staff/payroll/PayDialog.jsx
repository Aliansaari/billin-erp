import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Input, InputNumber, Select, Checkbox, message } from 'antd';
import dayjs from 'dayjs';
import StaffAvatar from '../StaffAvatar';
import { payrollAPI, bankAPI } from '../../../api';
import { inr0, cap, initials, errText, monthLabel } from './shared';

/*
 * Record salary paid — for everyone due, or one person. Amounts default to
 * what is due and can be lowered for a part payment. One date and one
 * cash/bank choice for the batch; each person gets their own payment entry.
 */
export default function PayDialog({ open, lines, period, onClose, onDone, photoOf }) {
  const [rows, setRows] = useState([]);
  const [paidOn, setPaidOn] = useState(dayjs().format('YYYY-MM-DD'));
  const [mode, setMode] = useState('Cash');
  const [bank, setBank] = useState(null);
  const [banks, setBanks] = useState([]);
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(lines.map((l) => ({ payslip_id: l.payslip_id, staff_id: l.staff_id, name: l.slip.staff.name, due: l.due, amount: l.due, on: true, bank: l.slip.bank })));
    setPaidOn(dayjs().format('YYYY-MM-DD')); setReference(''); setSaving(false);
    // Bank transfer is the obvious default when everyone has bank details.
    setMode(lines.length > 1 && lines.every((l) => l.slip.bank?.account) ? 'Bank' : 'Cash');
    bankAPI.list({ include_inactive: false }).then(({ data }) => {
      const list = data?.banks || [];
      setBanks(list); setBank((b) => b || list[0]?.ledger_id || null);
    }).catch(() => setBanks([]));
  }, [open, lines]);

  const picked = rows.filter((r) => r.on && Number(r.amount) > 0);
  const total = useMemo(() => picked.reduce((t, r) => t + (Number(r.amount) || 0), 0), [picked]);
  const bad = picked.find((r) => Number(r.amount) > r.due + 0.005);

  const submit = async () => {
    setSaving(true);
    try {
      const { data } = await payrollAPI.pay(period, {
        items: picked.map((r) => ({ payslip_id: r.payslip_id, amount: Number(r.amount) })),
        paid_on: paidOn, payment_mode: mode, bank_ledger_id: mode === 'Bank' ? bank : null, reference: reference || null,
      });
      message.success(`Recorded ${inr0(data.total)} paid to ${data.count} staff.`);
      onDone();
    } catch (e) { message.error(errText(e, 'Could not record the payment')); setSaving(false); }
  };

  return (
    <Modal rootClassName="ar-pop" open={open} onCancel={onClose} width={640} destroyOnHidden style={{ top: 40 }}
      title={<div className="ar-mtitle">Pay salaries<small>{monthLabel(period)} · recorded in your accounts as salary paid</small></div>}
      footer={(
        <div className="ar-bfoot">
          <span>{picked.length ? <><b>{inr0(total)}</b> to {picked.length} staff</> : 'Choose who to pay'}</span>
          <div><button type="button" className="plv-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="plv-btn primary" disabled={saving || !picked.length || !!bad || (mode === 'Bank' && !bank) || !paidOn} onClick={submit}>
              {saving ? 'Saving…' : `Pay ${inr0(total)}`}</button></div>
        </div>
      )}>
      <div className="ar-form">
        <div className="ar-field"><label>Paid by</label>
          <div className="ar-choice two">
            {[['Cash', 'Cash', 'From the cash drawer'], ['Bank', 'Bank transfer', 'NEFT, IMPS, UPI or cheque']].map(([v, t, sub]) => (
              <button key={v} type="button" className={mode === v ? 'is-on' : ''} onClick={() => setMode(v)}><b>{t}</b><span>{sub}</span></button>
            ))}
          </div></div>
        <div className="ar-three pr-paymeta">
          <div className="ar-field"><label>Date</label><Input type="date" value={paidOn} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setPaidOn(e.target.value)} /></div>
          {mode === 'Bank' ? (
            <div className="ar-field"><label>From account</label>
              <Select value={bank} onChange={setBank} placeholder={banks.length ? 'Choose' : 'No bank account set up'} popupClassName="ar-pop"
                options={banks.map((b) => ({ value: b.ledger_id, label: b.ledger_name || b.bank_name }))} /></div>
          ) : <div />}
          <div className="ar-field"><label>Reference <em>optional</em></label><Input value={reference} maxLength={60} placeholder={mode === 'Bank' ? 'UTR / cheque no.' : 'Voucher no.'} onChange={(e) => setReference(e.target.value)} /></div>
        </div>

        <div className="ar-bl pr-paylist">
          <div className="ar-bl-row ar-bl-head">
            <Checkbox checked={rows.length > 0 && rows.every((r) => r.on)} indeterminate={rows.some((r) => r.on) && !rows.every((r) => r.on)}
              onChange={(e) => setRows(rows.map((r) => ({ ...r, on: e.target.checked })))} />
            <span>Staff</span><span className="r">Due</span><span className="r">Paying now</span>
          </div>
          <div className="ar-bl-body">
            {rows.map((r, i) => (
              <div key={r.payslip_id} className={`ar-bl-row${r.on ? '' : ' is-off'}`}>
                <Checkbox checked={r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <div className="plv-party-inline"><StaffAvatar name={r.name} photo={photoOf ? photoOf(r.staff_id) : null} size={26} />
                  <div><span className="ar-mname">{cap(r.name)}</span>{mode === 'Bank' && <small className="pr-acct">{r.bank?.account ? `A/c ••••${String(r.bank.account).slice(-4)}` : 'No bank details'}</small>}</div></div>
                <span className="r ar-num">{inr0(r.due)}</span>
                <InputNumber size="small" prefix="₹" min={0} max={r.due} value={r.amount} disabled={!r.on} status={Number(r.amount) > r.due + 0.005 ? 'error' : undefined}
                  onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: v } : x)))} style={{ width: '100%' }} />
              </div>
            ))}
          </div>
        </div>
        {bad && <p className="ar-hint tx-bad">{cap(bad.name)}: more than the {inr0(bad.due)} due.</p>}
        {picked.some((r) => Number(r.amount) < r.due) && <p className="ar-hint">Paying less than due records a part payment; the rest stays to pay.</p>}
      </div>
    </Modal>
  );
}
