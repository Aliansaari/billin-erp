import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Select, InputNumber, Input, message } from 'antd';
import dayjs from 'dayjs';
import { payrollAPI } from '../../../api';
import { inr0, cap, errText, ordinal } from './shared';

/*
 * Quick entry — the one line where every payroll money entry happens.
 *
 *   person → amount → Enter
 *
 * What the line does follows the person:
 *   something due   → Pay      (amount filled with what is due)
 *   nothing due     → Give     (an advance; comes off the next salary)
 *   no salary yet   → Salary   (set it: amount, per, pay day)
 * The owner can switch Pay / Give. After saving, the line clears and the
 * cursor goes back to the person box for the next entry, so a whole
 * month-end is typed without touching the mouse or opening a dialog.
 *
 * The parent drives it through the ref: load(staffId, mode) from F1 / F3 /
 * the details sheet, focus() from the list.
 */
const today = () => dayjs().format('YYYY-MM-DD');
export const payable = (p) => !!(p && !p.missing && p.due && p.due.amount > 0 && !p.due.hold && p.due.kind !== 'error');
const firstName = (n) => cap(n).split(' ')[0];

function defaultMode(p, wanted) {
  if (!p) return wanted || 'pay';
  if (p.missing) return 'salary';
  if (wanted === 'give') return 'give';
  return payable(p) ? 'pay' : 'give';
}

/** One plain sentence under the line: what this entry will do. */
function explain(p, mode, amt, month) {
  if (!p) return 'Choose a person, type the amount and press Enter. Pay clears what is due; Give is an advance that comes off the next salary.';
  if (mode === 'salary') return `${firstName(p.name)} has no salary yet. Paid on the 1st means a calendar-month salary; any other day starts their own monthly cycle from that date.`;
  const out = (p.taken || 0) + (p.advance || 0);
  if (mode === 'give') return `An advance to ${firstName(p.name)}. It comes off the next salary${out > 0 ? `, on top of ${inr0(out)} already outstanding` : ''}.`;
  const d = p.due;
  if (d.kind === 'run') {
    const parts = [`${inr0(d.gross)} for ${d.paid_days}${d.basis_days ? ` of ${d.basis_days}` : ''} days`];
    if (d.deductions > 0) parts.push(`− ${inr0(d.deductions)} deductions and advances`);
    if (d.paid > 0) parts.push(`− ${inr0(d.paid)} already paid`);
    return `${d.label} salary: ${parts.join(' ')} = ${inr0(d.amount)}.${!d.locked ? ` Paying locks ${month?.label || d.label} for all ${month?.people || ''} monthly staff.` : ''}`;
  }
  if (d.kind === 'settle') {
    const parts = [`earned ${inr0(d.earned)} in ${d.paid_days} days`];
    if (Math.abs(d.brought_forward) >= 0.5) parts.push(d.brought_forward < 0 ? `− ${inr0(-d.brought_forward)} advance from before` : `+ ${inr0(d.brought_forward)} unpaid from before`);
    if (d.given > 0) parts.push(`− ${inr0(d.given)} already given`);
    const extra = (Number(amt) || 0) - d.amount;
    return `${d.label}: ${parts.join(' ')} = ${inr0(d.amount)}.${extra > 0.5 ? ` The extra ${inr0(extra)} becomes an advance.` : ''}`;
  }
  return `Left over from the last settlement: ${inr0(d.amount)}.`;
}

const QuickEntry = forwardRef(function QuickEntry({ rows, banks, month, onSaved }, ref) {
  const [who, setWho] = useState(null);
  const [mode, setMode] = useState('pay');
  const [amt, setAmt] = useState(null);
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState('cash');           // 'cash' | bank ledger id
  const [note, setNote] = useState('');
  const [per, setPer] = useState('monthly');
  const [day, setDay] = useState(1);
  const [saving, setSaving] = useState(false);
  const whoRef = useRef(null);
  const amtRef = useRef(null);
  const p = rows.find((r) => r.staff_id === who) || null;

  const focusAmount = () => setTimeout(() => { amtRef.current?.focus(); amtRef.current?.select?.(); }, 30);
  const pick = (id, wanted) => {
    const x = rows.find((r) => r.staff_id === id) || null;
    const m = defaultMode(x, wanted);
    setWho(x ? id : null); setMode(m); setNote('');
    setAmt(m === 'pay' ? x.due.amount : null);
    if (x) focusAmount();
  };
  const switchMode = (m) => { setMode(m); setAmt(m === 'pay' && payable(p) ? p.due.amount : null); focusAmount(); };
  const clear = () => { setWho(null); setAmt(null); setNote(''); setMode('pay'); setDate(today()); };
  useImperativeHandle(ref, () => ({
    load: pick,
    focus: () => whoRef.current?.focus(),
    contains: (el) => !!el?.closest?.('.qe'),
  }));

  const n = Number(amt) || 0;
  const tooMuch = mode === 'pay' && p?.due && p.due.kind !== 'settle' && n > p.due.amount + 0.005;
  const ready = p && n > 0 && !tooMuch && !saving;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    const money = { payment_mode: from === 'cash' ? 'Cash' : 'Bank', bank_ledger_id: from === 'cash' ? null : from };
    try {
      if (mode === 'pay') {
        const { data } = await payrollAPI.payPerson(p.staff_id, { amount: n, paid_on: date, ...money, lock_month: p.due.kind === 'run' && !p.due.locked });
        message.success(`Paid ${inr0(n)} to ${cap(p.name)}.`);
        await onSaved(data);
      } else if (mode === 'give') {
        await payrollAPI.givePerson(p.staff_id, { amount: n, given_on: date, note: note.trim() || null, ...money });
        message.success(`${inr0(n)} given to ${cap(p.name)}. It comes off the next salary.`);
        await onSaved(null);
      } else {
        const monthStart = dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
        const effective = p.joined_on && p.joined_on > monthStart ? p.joined_on : monthStart;
        await payrollAPI.saveStructure(p.staff_id, { pay_type: per, amount: n, effective_from: effective, details: day > 1 ? { pay_by: 'settle', cycle_day: day } : {} });
        message.success(`Salary set for ${cap(p.name)}.`);
        await onSaved(null, true);
      }
      clear();
      setTimeout(() => whoRef.current?.focus(), 30);
    } catch (e) { message.error(errText(e, 'Could not save')); }
    finally { setSaving(false); }
  };

  const onKeyDown = (e) => {
    // Esc inside the line clears it (and never walks the page back).
    if (e.key === 'Escape') { e.stopPropagation(); if (who || amt) clear(); else e.target.blur?.(); }
  };
  const enter = (e) => { e.preventDefault(); save(); };

  const personOptions = rows.map((r) => ({
    value: r.staff_id,
    label: cap(r.name),
    search: `${r.name} ${r.designation || ''}`.toLowerCase(),
    hint: r.missing ? 'Salary not set' : payable(r) ? `${inr0(r.due.amount)} due` : 'Paid up',
    tone: r.missing ? 'late' : payable(r) ? 'due' : 'ok',
  }));

  return (
    <section className="qe" onKeyDown={onKeyDown}>
      <div className="qe-line">
        <Select
          ref={whoRef} className="qe-who" size="large" showSearch allowClear placeholder="Staff name" value={who}
          popupClassName="ar-pop" options={personOptions}
          filterOption={(q, o) => o.search.includes(q.toLowerCase())}
          optionRender={(o) => <div className="qe-opt"><span>{o.data.label}</span><small className={`t-${o.data.tone}`}>{o.data.hint}</small></div>}
          onChange={(v) => (v == null ? clear() : pick(v))}
        />

        {mode === 'salary' ? <span className="qe-mode one">Set salary</span> : (
          <div className="qe-mode" role="radiogroup" aria-label="Entry type">
            <button type="button" role="radio" aria-checked={mode === 'pay'} className={mode === 'pay' ? 'on' : ''} disabled={!!p && !payable(p)} onClick={() => switchMode('pay')}>Pay</button>
            <button type="button" role="radio" aria-checked={mode === 'give'} className={mode === 'give' ? 'on' : ''} onClick={() => switchMode('give')}>Give</button>
          </div>
        )}

        <InputNumber ref={amtRef} className="qe-amt" size="large" prefix="₹" min={0} placeholder={mode === 'salary' ? 'Salary' : 'Amount'}
          value={amt} onChange={setAmt} onPressEnter={enter} disabled={!p} status={tooMuch ? 'error' : undefined} />

        {mode === 'salary' ? (<>
          <Select className="qe-per" size="large" value={per} onChange={setPer} popupClassName="ar-pop"
            options={[{ value: 'monthly', label: 'a month' }, { value: 'daily', label: 'a day' }, { value: 'hourly', label: 'an hour' }]} />
          <Select className="qe-day" size="large" value={day} onChange={setDay} popupClassName="ar-pop"
            options={Array.from({ length: 28 }, (_, i) => ({ value: i + 1, label: i === 0 ? 'Paid on the 1st' : `Paid on the ${ordinal(i + 1)}` }))} />
        </>) : (<>
          <Input className="qe-date" size="large" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} onPressEnter={enter} />
          <Select className="qe-from" size="large" value={from} onChange={setFrom} popupClassName="ar-pop"
            options={[{ value: 'cash', label: 'Cash' }, ...banks.map((b) => ({ value: b.ledger_id, label: b.ledger_name || b.bank_name }))]} />
          {mode === 'give' && <Input className="qe-note" size="large" placeholder="Note (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} onPressEnter={enter} />}
        </>)}

        <button type="button" className="qe-save" disabled={!ready} onClick={save}>
          {saving ? 'Saving…' : mode === 'salary' ? 'Save salary' : mode === 'give' ? `Give${n ? ` ${inr0(n)}` : ''}` : `Pay${n ? ` ${inr0(n)}` : ''}`}
          {!saving && <kbd>Enter</kbd>}
        </button>
      </div>
      <p className={`qe-say${tooMuch ? ' bad' : ''}`}>
        {tooMuch ? `That is more than the ${inr0(p.due.amount)} due.` : explain(p, mode, amt, month)}
      </p>
    </section>
  );
});

export default QuickEntry;
