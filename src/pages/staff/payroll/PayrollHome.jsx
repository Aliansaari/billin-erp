import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Input, InputNumber, Select, Drawer, message, Tooltip } from 'antd';
import {
  WalletOutlined, PlusOutlined, CheckCircleFilled, SettingOutlined, MoreOutlined, CloseOutlined, CalendarOutlined,
  FileTextOutlined, TeamOutlined, EditOutlined, ArrowRightOutlined, WarningOutlined, BankOutlined, HistoryOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { payrollAPI, bankAPI } from '../../../api';
import StaffAvatar from '../StaffAvatar';
import { inr0, cap, errText, ordinal } from './shared';

/*
 * Payroll home — one screen, built around people, not processes.
 *
 * What an owner does, and how many clicks it takes here:
 *   pay everyone at month end ........ 2 (Pay everyone → Pay)
 *   pay one person ..................... 2 (Pay → Pay)
 *   give someone money today ........... 2 (Give → Give), amount typed
 *   set a new person's salary .......... type the amount → Save, in the list
 * Monthly staff and own-cycle staff sit in the same list; the server
 * (services/payrollHome.js) routes each action to the right engine.
 */
const fmtD = (iso) => dayjs(iso).format('D MMM');
const perText = (t) => (t === 'daily' ? 'a day' : t === 'hourly' ? 'an hour' : 'a month');
const perShort = (t) => (t === 'daily' ? '/day' : t === 'hourly' ? '/hr' : '/mo');
const payDayText = (p) => (p.mode === 'settle' ? `paid on the ${ordinal(p.cycle_day)}` : 'paid monthly');
const QUICK_NOTES = ['Advance', 'Medical', 'Festival', 'Rent', 'Family'];

function useBanks() {
  const [banks, setBanks] = useState([]);
  useEffect(() => { bankAPI.list({ include_inactive: false }).then(({ data }) => setBanks(data?.banks || [])).catch(() => {}); }, []);
  return banks;
}

function CashOrBank({ value, onChange, banks }) {
  return (
    <div className="ph-cob">
      <div className="ph-seg" role="radiogroup">
        {[['Cash', 'Cash', <WalletOutlined key="w" />], ['Bank', 'Bank / UPI', <BankOutlined key="b" />]].map(([v, t, ic]) => (
          <button key={v} type="button" role="radio" aria-checked={value.mode === v} className={value.mode === v ? 'is-on' : ''}
            onClick={() => onChange({ ...value, mode: v, bank: value.bank || banks[0]?.ledger_id })}>{ic}{t}</button>
        ))}
      </div>
      {value.mode === 'Bank' && (
        <Select value={value.bank} onChange={(b) => onChange({ ...value, bank: b })} placeholder={banks.length ? 'Which account' : 'No bank account set up'}
          popupClassName="ar-pop" options={banks.map((b) => ({ value: b.ledger_id, label: b.ledger_name || b.bank_name }))} style={{ minWidth: 200 }} />
      )}
    </div>
  );
}

export default function PayrollHome({ staff, structures, onOpenView, onEditSalary, reloadBase }) {
  const [h, setH] = useState(null);
  const [err, setErr] = useState(null);
  const [paying, setPaying] = useState(null);      // person
  const [payingAll, setPayingAll] = useState(false);
  const [giving, setGiving] = useState(null);      // person | 'pick'
  const [sheet, setSheet] = useState(null);        // staff_id
  const [filter, setFilter] = useState('all');
  const banks = useBanks();

  const load = useCallback(async () => {
    try { const { data } = await payrollAPI.home(); setH(data); setErr(null); } catch (e) { setErr(errText(e, 'Could not load payroll')); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const after = async (data) => { if (data?.people) setH(data); else await load(); };

  if (err) return <div className="ph-empty"><WarningOutlined /> {err} <button type="button" className="ar-link" onClick={load}>Try again</button></div>;
  if (!h) return <div className="ph-skel"><div /><div /><div /></div>;

  const due = h.people.filter((p) => p.due && p.due.amount > 0 && !p.due.hold);
  const shown = filter === 'due' ? due : filter === 'taken' ? h.people.filter((p) => p.taken > 0 || p.advance) : h.people;
  const nextPay = h.people.map((p) => p.next_payday).sort()[0];
  const personOf = (id) => h.people.find((p) => p.staff_id === id);

  return (
    <div className="ph">
      {/* ── headline ── */}
      <section className={`ph-hero${h.totals.due > 0 ? '' : ' is-clear'}`}>
        <div className="ph-hero-main">
          {h.totals.due > 0 ? (<>
            <span className="ph-eyebrow">{h.month.ready ? `${h.month.label} salaries are ready` : 'Due now'}</span>
            <div className="ph-big">{inr0(h.totals.due)}</div>
            <p className="ph-sub">
              to <b>{h.totals.due_count}</b> {h.totals.due_count === 1 ? 'person' : 'people'}
              {h.totals.taken > 0 && <> · advances already taken off where due</>}
              {h.month.ready && !h.month.month_complete && <> · <span className="tx-late">{h.month.label} is not over yet</span></>}
            </p>
            <div className="ph-hero-act">
              <button type="button" className="ph-btn-xl" onClick={() => setPayingAll(true)}><WalletOutlined /> Pay everyone {inr0(h.totals.due)}</button>
              <button type="button" className="ph-btn-ghost" onClick={() => setFilter('due')}>See who</button>
            </div>
          </>) : (<>
            <span className="ph-eyebrow">All paid up</span>
            <div className="ph-big ph-big-ok"><CheckCircleFilled /> Nothing due</div>
            <p className="ph-sub">{nextPay ? <>Next salary day: <b>{dayjs(nextPay).format('D MMMM')}</b></> : 'Set salaries below to start.'}</p>
            <div className="ph-hero-act">
              <button type="button" className="ph-btn-ghost" onClick={() => setGiving('pick')}><PlusOutlined /> Give money</button>
            </div>
          </>)}
        </div>
        <div className="ph-hero-side">
          <div><span>Earned so far this cycle</span><b>{inr0(h.totals.so_far)}</b></div>
          <div><span>Given in advance, not yet taken back</span><b className={h.totals.taken ? 'tx-late' : ''}>{inr0(h.totals.taken)}</b></div>
          <div><span>Monthly salaries</span><b>{inr0(h.totals.monthly)}</b></div>
        </div>
      </section>

      {/* ── people without a salary: set it right here ── */}
      {h.missing.length > 0 && <QuickSetup missing={h.missing} onSaved={async () => { await reloadBase(); await load(); }} />}

      {/* ── people ── */}
      <section className="ph-list">
        <div className="ph-list-h">
          <div className="plv-chips">
            {[['all', 'Everyone', h.people.length], ['due', 'Due now', due.length], ['taken', 'Has taken money', h.people.filter((p) => p.taken > 0 || p.advance).length]].map(([k, t, n]) => (
              <button key={k} type="button" className={`plv-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{t}<span className="count">{n}</span></button>
            ))}
          </div>
          <button type="button" className="plv-btn" onClick={() => setGiving('pick')}><PlusOutlined /> Give money</button>
        </div>
        {!shown.length ? (
          <div className="ph-empty"><TeamOutlined /> {h.people.length ? 'Nobody here.' : 'Set a salary above to get started.'}</div>
        ) : shown.map((p) => <PersonRow key={p.staff_id} p={p} onOpen={() => setSheet(p.staff_id)} onPay={() => setPaying(p)} onGive={() => setGiving(p)} />)}
      </section>

      <p className="ph-foot">
        Monthly staff are paid for the calendar month; staff with their own salary date are paid for their cycle.
        Advances come off the next salary automatically. <button type="button" className="ar-link" onClick={() => onOpenView('month')}>Month details and payslips</button>
      </p>

      <PayModal person={paying} month={h.month} banks={banks} onClose={() => setPaying(null)} onDone={async (d) => { setPaying(null); await after(d); }} />
      <PayAllModal open={payingAll} h={h} due={due} banks={banks} onClose={() => setPayingAll(false)} onDone={async (d) => { setPayingAll(false); await after(d); }} />
      <GiveModal target={giving} people={h.people} banks={banks} today={h.today} onClose={() => setGiving(null)} onDone={async () => { setGiving(null); await load(); }} />
      <PersonSheet person={sheet ? personOf(sheet) : null} structures={structures} staff={staff} onClose={() => setSheet(null)}
        onPay={(p) => setPaying(p)} onGive={(p) => setGiving(p)} onEditSalary={onEditSalary} onChanged={async () => { await reloadBase(); await load(); }} onOpenView={onOpenView} />
    </div>
  );
}

// ── one person in the list ───────────────────────────────────────────

function PersonRow({ p, onOpen, onPay, onGive }) {
  const pct = p.so_far && p.pay_type === 'monthly' && p.amount ? Math.min(100, (p.so_far.earned / p.amount) * 100) : null;
  const d = p.due;
  return (
    <div className="ph-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <StaffAvatar name={p.name} photo={p.photo} size={46} />
      <div className="ph-who">
        <b>{cap(p.name)}</b>
        <span>{[p.designation, `${inr0(p.amount)}${perShort(p.pay_type)}`, p.mode === 'settle' ? `${ordinal(p.cycle_day)} cycle` : null].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="ph-prog">
        {p.so_far ? (<>
          <div className="ph-prog-top"><span>Earned so far</span><b>{inr0(p.so_far.earned)}</b></div>
          {pct != null && <div className="ph-bar"><i style={{ width: `${pct}%` }} /></div>}
          <small>{p.so_far.paid_days} of {p.so_far.days} days{p.so_far.absent ? ` · ${p.so_far.absent} off` : ''}</small>
        </>) : <small className="ar-dash">Starts {p.joined_on ? fmtD(p.joined_on) : 'soon'}</small>}
      </div>
      <div className="ph-taken">
        {p.taken > 0 && <Tooltip title="Given before salary; comes off their next pay"><span className="ph-chip warn">Taken {inr0(p.taken)}</span></Tooltip>}
        {p.advance > 0 && <Tooltip title="Paid more than earned; comes off the next salary"><span className="ph-chip warn">Advance {inr0(p.advance)}</span></Tooltip>}
      </div>
      <div className="ph-due">
        {d && d.amount > 0 && !d.hold ? (<>
          <small>{d.kind === 'run' ? `${d.label}` : d.label}</small>
          <b>{inr0(d.amount)}</b>
        </>) : d?.hold ? <small className="tx-late">On hold</small>
          : d?.kind === 'error' ? <small className="tx-late"><WarningOutlined /> Needs a look</small>
            : <small className="ph-next">Next pay {fmtD(p.next_payday)}</small>}
      </div>
      <div className="ph-act" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="plv-btn ph-give" onClick={onGive}><PlusOutlined /> Give</button>
        {d && d.amount > 0 && !d.hold
          ? <button type="button" className="plv-btn primary ph-pay" onClick={onPay}>Pay {inr0(d.amount)}</button>
          : <button type="button" className="plv-btn ph-pay is-done" disabled><CheckCircleFilled /> Paid up</button>}
      </div>
    </div>
  );
}

// ── set salaries right in the list ───────────────────────────────────

function QuickSetup({ missing, onSaved }) {
  const [rows, setRows] = useState({});
  const [saving, setSaving] = useState(null);
  const set = (id, patch) => setRows((r) => ({ ...r, [id]: { pay_type: 'monthly', day: 1, ...r[id], ...patch } }));
  const save = async (m) => {
    const r = rows[m.staff_id] || {};
    if (!(Number(r.amount) > 0)) { message.warning(`Enter ${cap(m.name).split(' ')[0]}'s salary.`); return; }
    setSaving(m.staff_id);
    try {
      const from = m.joined_on && m.joined_on > dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD') ? m.joined_on : dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
      const day = Number(r.day) || 1;
      await payrollAPI.saveStructure(m.staff_id, { pay_type: r.pay_type || 'monthly', amount: Number(r.amount), effective_from: from, details: day > 1 ? { pay_by: 'settle', cycle_day: day } : {} });
      message.success(`Salary set for ${cap(m.name)}.`);
      await onSaved();
    } catch (e) { message.error(errText(e, 'Could not save')); } finally { setSaving(null); }
  };
  return (
    <section className="ph-setup">
      <div className="ph-setup-h"><b>Set salary for {missing.length} {missing.length === 1 ? 'person' : 'people'}</b><span>Type the amount and save. You can add PF, breakup and bank details later.</span></div>
      {missing.map((m) => {
        const r = rows[m.staff_id] || { pay_type: 'monthly', day: 1 };
        return (
          <div key={m.staff_id} className="ph-setup-row">
            <StaffAvatar name={m.name} photo={m.photo} size={36} />
            <b className="ph-setup-name">{cap(m.name)}<small>{m.designation || 'Staff'}</small></b>
            <InputNumber prefix="₹" min={0} placeholder="Salary" value={r.amount} onChange={(v) => set(m.staff_id, { amount: v })} onPressEnter={() => save(m)} style={{ width: 150 }} />
            <Select value={r.pay_type} onChange={(v) => set(m.staff_id, { pay_type: v })} popupClassName="ar-pop" style={{ width: 130 }}
              options={[{ value: 'monthly', label: 'a month' }, { value: 'daily', label: 'a day' }, { value: 'hourly', label: 'an hour' }]} />
            <span className="ph-setup-lbl">paid on the</span>
            <Select value={r.day} onChange={(v) => set(m.staff_id, { day: v })} popupClassName="ar-pop" style={{ width: 118 }}
              options={Array.from({ length: 28 }, (_, i) => ({ value: i + 1, label: i === 0 ? '1st (monthly)' : ordinal(i + 1) }))} />
            <button type="button" className="plv-btn primary" disabled={saving === m.staff_id} onClick={() => save(m)}>{saving === m.staff_id ? 'Saving…' : 'Save'}</button>
          </div>
        );
      })}
    </section>
  );
}

// ── pay one person ───────────────────────────────────────────────────

function PayModal({ person: p, month, banks, onClose, onDone }) {
  const [amt, setAmt] = useState(null);
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [cob, setCob] = useState({ mode: 'Cash', bank: null });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (p) { setAmt(p.due?.amount || null); setDate(dayjs().format('YYYY-MM-DD')); setCob({ mode: 'Cash', bank: banks[0]?.ledger_id }); setSaving(false); } }, [p]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p || !p.due) return null;
  const d = p.due;
  const run = d.kind === 'run';
  const locking = run && !d.locked;
  const extra = !run && d.kind === 'settle' ? (Number(amt) || 0) - d.amount : 0;
  const tooMuch = (run || d.kind === 'balance') && (Number(amt) || 0) > d.amount + 0.005;
  const submit = async () => {
    if (!(Number(amt) > 0) || tooMuch) return;
    setSaving(true);
    try {
      const { data } = await payrollAPI.payPerson(p.staff_id, { amount: Number(amt), paid_on: date, payment_mode: cob.mode, bank_ledger_id: cob.mode === 'Bank' ? cob.bank : null, lock_month: locking });
      message.success(`Paid ${inr0(amt)} to ${cap(p.name)}.${extra > 0.5 ? ` ${inr0(extra)} comes off their next salary.` : ''}`);
      onDone(data);
    } catch (e) { message.error(errText(e, 'Could not pay')); setSaving(false); }
  };
  return (
    <Modal rootClassName="ar-pop" open onCancel={onClose} width={480} destroyOnHidden footer={null} className="ph-modal">
      <div className="ph-mhead"><StaffAvatar name={p.name} photo={p.photo} size={48} /><div><b>Pay {cap(p.name)}</b><span>{run ? `${d.label} salary` : `Salary for ${d.label}`}</span></div></div>
      <div className="ph-calc">
        {run ? (<>
          <div><span>Salary for {d.paid_days}{d.basis_days ? ` of ${d.basis_days}` : ''} days</span><b>{inr0(d.gross)}</b></div>
          {d.deductions > 0 && <div><span>Deductions and advances</span><b>−{inr0(d.deductions)}</b></div>}
          {d.paid > 0 && <div><span>Already paid</span><b>−{inr0(d.paid)}</b></div>}
        </>) : d.kind === 'settle' ? (<>
          <div><span>Earned ({d.paid_days} days)</span><b>{inr0(d.earned)}</b></div>
          {Math.abs(d.brought_forward) >= 0.5 && <div><span>{d.brought_forward < 0 ? 'Advance from before' : 'Unpaid from before'}</span><b>{d.brought_forward < 0 ? '−' : '+'}{inr0(Math.abs(d.brought_forward))}</b></div>}
          {d.given > 0 && <div><span>Already given</span><b>−{inr0(d.given)}</b></div>}
        </>) : <div><span>Left from last settlement</span><b>{inr0(d.amount)}</b></div>}
        <div className="tot"><span>To pay</span><b>{inr0(d.amount)}</b></div>
      </div>
      <div className="ph-payrow">
        <InputNumber size="large" prefix="₹" min={0} value={amt} onChange={setAmt} onPressEnter={submit} autoFocus status={tooMuch ? 'error' : undefined} style={{ width: 190 }} />
        <Input size="large" type="date" value={date} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
      </div>
      <CashOrBank value={cob} onChange={setCob} banks={banks} />
      {extra > 0.5 && <p className="ph-note">{inr0(extra)} more than due. It is taken off their next salary.</p>}
      {tooMuch && <p className="ph-note bad">That is more than the {inr0(d.amount)} due.</p>}
      {locking && <p className="ph-note">This locks {month.label} salaries for all {month.people} monthly staff, so the amounts stop changing.</p>}
      {(d.warnings || []).map((w) => <p key={w} className="ph-note">{w}</p>)}
      <div className="ph-mfoot">
        <button type="button" className="plv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="ph-btn-xl sm" disabled={saving || !(Number(amt) > 0) || tooMuch || (cob.mode === 'Bank' && !cob.bank)} onClick={submit}>{saving ? 'Paying…' : `Pay ${inr0(amt || 0)}`}</button>
      </div>
    </Modal>
  );
}

// ── pay everyone ─────────────────────────────────────────────────────

function PayAllModal({ open, h, due, banks, onClose, onDone }) {
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [cob, setCob] = useState({ mode: 'Cash', bank: null });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setDate(dayjs().format('YYYY-MM-DD')); setCob({ mode: 'Cash', bank: banks[0]?.ledger_id }); setSaving(false); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  const locks = h.month.ready && due.some((p) => p.due.kind === 'run');
  const submit = async () => {
    setSaving(true);
    try {
      const { data } = await payrollAPI.payAll({ paid_on: date, payment_mode: cob.mode, bank_ledger_id: cob.mode === 'Bank' ? cob.bank : null });
      if (data.failed?.length) {
        Modal.warning({ rootClassName: 'ar-pop', title: `Paid ${inr0(data.total)} to ${data.paid.length}. ${data.failed.length} not paid.`,
          content: <ul className="ph-fail">{data.failed.map((f) => <li key={f.staff_id}><b>{cap(f.name)}</b>: {f.error}</li>)}</ul> });
      } else message.success(`Paid ${inr0(data.total)} to ${data.paid.length} ${data.paid.length === 1 ? 'person' : 'people'}.`);
      onDone(data.home);
    } catch (e) { message.error(errText(e, 'Could not pay')); setSaving(false); }
  };
  return (
    <Modal rootClassName="ar-pop" open onCancel={onClose} width={560} destroyOnHidden footer={null} className="ph-modal">
      <div className="ph-mhead ph-mhead-plain"><div><b>Pay everyone</b><span>{due.length} {due.length === 1 ? 'person' : 'people'} · {inr0(h.totals.due)}</span></div></div>
      <div className="ph-paylist">
        {due.map((p) => (
          <div key={p.staff_id}><StaffAvatar name={p.name} photo={p.photo} size={30} /><span>{cap(p.name)}<small>{p.due.label}</small></span><b>{inr0(p.due.amount)}</b></div>
        ))}
      </div>
      <div className="ph-payrow">
        <Input size="large" type="date" value={date} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
        <CashOrBank value={cob} onChange={setCob} banks={banks} />
      </div>
      {locks && <p className="ph-note">{h.month.label} salaries are locked when you pay, so the amounts stop changing.</p>}
      <div className="ph-mfoot">
        <button type="button" className="plv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="ph-btn-xl sm" disabled={saving || (cob.mode === 'Bank' && !cob.bank)} onClick={submit}>{saving ? 'Paying…' : `Pay ${inr0(h.totals.due)}`}</button>
      </div>
    </Modal>
  );
}

// ── give money ───────────────────────────────────────────────────────

function GiveModal({ target, people, banks, today, onClose, onDone }) {
  const [who, setWho] = useState(null);
  const [amt, setAmt] = useState(null);
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today);
  const [cob, setCob] = useState({ mode: 'Cash', bank: null });
  const [saving, setSaving] = useState(false);
  const amtRef = useRef(null);
  useEffect(() => {
    if (!target) return;
    setWho(target === 'pick' ? null : target.staff_id); setAmt(null); setNote(''); setDate(dayjs().format('YYYY-MM-DD'));
    setCob({ mode: 'Cash', bank: banks[0]?.ledger_id }); setSaving(false);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!target) return null;
  const p = people.find((x) => x.staff_id === who);
  const submit = async () => {
    if (!p || !(Number(amt) > 0)) return;
    setSaving(true);
    try {
      await payrollAPI.givePerson(p.staff_id, { amount: Number(amt), given_on: date, note: note || null, payment_mode: cob.mode, bank_ledger_id: cob.mode === 'Bank' ? cob.bank : null });
      message.success(`${inr0(amt)} given to ${cap(p.name)}. It comes off their next salary.`);
      onDone();
    } catch (e) { message.error(errText(e, 'Could not record it')); setSaving(false); }
  };
  return (
    <Modal rootClassName="ar-pop" open onCancel={onClose} width={480} destroyOnHidden footer={null} className="ph-modal">
      {p ? <div className="ph-mhead"><StaffAvatar name={p.name} photo={p.photo} size={48} /><div><b>Give money to {cap(p.name)}</b><span>Comes off their next salary{p.due?.amount ? ` (${inr0(p.due.amount)} due now)` : ''}</span></div></div>
        : <div className="ph-mhead ph-mhead-plain"><div><b>Give money</b><span>To whom?</span></div></div>}
      {target === 'pick' && (
        <Select showSearch optionFilterProp="label" value={who} onChange={(v) => { setWho(v); setTimeout(() => amtRef.current?.focus(), 50); }} placeholder="Choose a person" size="large" style={{ width: '100%' }} popupClassName="ar-pop" autoFocus
          options={people.map((x) => ({ value: x.staff_id, label: cap(x.name) }))} />
      )}
      <div className="ph-payrow">
        <InputNumber ref={amtRef} size="large" prefix="₹" min={1} placeholder="Amount" value={amt} onChange={setAmt} onPressEnter={submit} autoFocus={target !== 'pick'} style={{ width: 190 }} />
        <Input size="large" type="date" value={date} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
      </div>
      <div className="ar-quick">{QUICK_NOTES.map((q) => <button key={q} type="button" className={note === q ? 'is-on' : ''} onClick={() => setNote(note === q ? '' : q)}>{q}</button>)}</div>
      <Input placeholder="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      <CashOrBank value={cob} onChange={setCob} banks={banks} />
      <div className="ph-mfoot">
        <button type="button" className="plv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="ph-btn-xl sm" disabled={saving || !p || !(Number(amt) > 0) || (cob.mode === 'Bank' && !cob.bank)} onClick={submit}>{saving ? 'Saving…' : `Give ${amt ? inr0(amt) : ''}`}</button>
      </div>
    </Modal>
  );
}

// ── everything about one person ──────────────────────────────────────

function PersonSheet({ person: p, structures, staff, onClose, onPay, onGive, onEditSalary, onChanged, onOpenView }) {
  const [hist, setHist] = useState(null);
  const [edit, setEdit] = useState(null);
  const [modal, modalCtx] = Modal.useModal();
  const load = useCallback(async () => {
    if (!p) return;
    try {
      if (p.mode === 'settle') {
        const { data } = await payrollAPI.account(p.staff_id);
        const items = [
          ...data.given.map((g) => ({ key: `g${g.entry_id}`, date: g.given_on, text: g.kind === 'salary' ? 'Salary paid' : 'Money given', note: g.note, amount: -g.amount, void: g.voided_at, cancel: !g.voided_at && !g.settlement_id ? () => payrollAPI.voidMoney(g.entry_id, 'Cancelled from payroll') : null })),
          ...data.settlements.map((s) => ({ key: `s${s.settlement_id}`, date: s.to_date, text: `Salary ${fmtD(s.from_date)} – ${fmtD(s.to_date)}`, amount: s.earned, void: s.voided_at, earned: true })),
          ...data.old_advances.map((a) => ({ key: `a${a.advance_id}`, date: a.given_on, text: 'Advance', note: a.reason, amount: -a.outstanding })),
        ].sort((a, b) => b.date.localeCompare(a.date));
        setHist(items);
      } else {
        const { data } = await payrollAPI.advances();
        setHist(data.filter((a) => a.staff_id === p.staff_id).map((a) => ({
          key: `a${a.advance_id}`, date: a.given_on, text: 'Money given', note: a.reason, amount: -a.amount,
          sub: a.outstanding > 0 ? `${inr0(a.outstanding)} still to come off salary` : 'Taken back from salary',
          cancel: a.recovered === 0 ? () => payrollAPI.voidAdvance(a.advance_id, 'Cancelled from payroll') : null,
        })).sort((a, b) => b.date.localeCompare(a.date)));
      }
    } catch { setHist([]); }
  }, [p?.staff_id, p?.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHist(null); setEdit(null); load(); }, [load]);
  if (!p) return <Drawer rootClassName="ar-pop" open={false} />;
  const st = structures?.[p.staff_id]; const cur = st ? [...st].reverse().find((x) => x.effective_from <= dayjs().format('YYYY-MM-DD')) || st[0] : null;
  const saveSalary = async () => {
    try {
      const details = { ...(cur?.details || {}) };
      if (Number(edit.day) > 1) { details.pay_by = 'settle'; details.cycle_day = Number(edit.day); } else { delete details.pay_by; delete details.cycle_day; }
      await payrollAPI.saveStructure(p.staff_id, { pay_type: edit.pay_type, amount: Number(edit.amount), effective_from: edit.from, details });
      message.success('Salary saved.'); setEdit(null); await onChanged();
    } catch (e) { message.error(errText(e, 'Could not save')); }
  };
  const cancelItem = (it) => modal.confirm({
    rootClassName: 'ar-pop', title: `Cancel this ${inr0(Math.abs(it.amount))}?`, content: 'The cash or bank entry is reversed.', okText: 'Cancel it', okButtonProps: { danger: true },
    onOk: async () => { try { await it.cancel(); await load(); await onChanged(); } catch (e) { message.error(errText(e, 'Could not cancel')); throw e; } },
  });
  const d = p.due;
  return (
    <Drawer rootClassName="ar-pop" open onClose={onClose} width={500} closeIcon={null} destroyOnHidden className="ph-sheet"
      title={(
        <div className="ph-sheet-h">
          <StaffAvatar name={p.name} photo={p.photo} size={56} />
          <div><b>{cap(p.name)}</b><span>{[p.designation, `${inr0(p.amount)} ${perText(p.pay_type)}`, payDayText(p)].filter(Boolean).join(' · ')}</span></div>
          <button type="button" className="ar-dn-btn" aria-label="Close" onClick={onClose}><CloseOutlined /></button>
        </div>
      )}>
      {modalCtx}
      <div className="ph-sheet-due">
        <div><span>{d && d.amount > 0 ? `Due · ${d.label}` : 'Nothing due'}</span><b>{inr0(d?.amount || 0)}</b>
          {p.advance > 0 && <small className="tx-late">Advance {inr0(p.advance)} comes off the next salary</small>}
          {!d?.amount && <small>Next salary day {dayjs(p.next_payday).format('D MMMM')}</small>}</div>
        <div className="ph-sheet-btns">
          <button type="button" className="plv-btn" onClick={() => onGive(p)}><PlusOutlined /> Give money</button>
          {d && d.amount > 0 && <button type="button" className="plv-btn primary" onClick={() => onPay(p)}>Pay {inr0(d.amount)}</button>}
        </div>
      </div>

      {p.so_far && (
        <div className="ph-sheet-sec">
          <h4><CalendarOutlined /> This cycle · {fmtD(p.cycle.from)} – {fmtD(p.cycle.to)}</h4>
          <div className="ph-kv3">
            <div><b>{inr0(p.so_far.earned)}</b><span>Earned so far</span></div>
            <div><b>{p.so_far.paid_days}<small> / {p.so_far.days}</small></b><span>Paid days</span></div>
            <div><b className={p.taken ? 'tx-late' : ''}>{inr0(p.taken)}</b><span>Taken already</span></div>
          </div>
        </div>
      )}

      <div className="ph-sheet-sec">
        <h4><HistoryOutlined /> Money given and paid</h4>
        {hist === null ? <p className="ph-muted">Loading…</p> : !hist.length ? <p className="ph-muted">Nothing yet. Money you give shows here and comes off their salary.</p> : (
          <ul className="ph-hist">
            {hist.slice(0, 12).map((it) => (
              <li key={it.key} className={it.void ? 'is-void' : ''}>
                <span className="dt">{fmtD(it.date)}</span>
                <div><b>{it.text}</b>{(it.note || it.sub) && <small>{[it.note, it.sub].filter(Boolean).join(' · ')}</small>}</div>
                <em className={it.earned ? 'plus' : ''}>{it.earned ? '+' : '−'}{inr0(Math.abs(it.amount))}</em>
                {it.cancel && !it.void ? <button type="button" className="ar-link danger" onClick={() => cancelItem(it)}>Cancel</button> : <span />}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ph-sheet-sec">
        <h4><EditOutlined /> Salary</h4>
        {edit ? (
          <div className="ph-salary-edit">
            <div className="ph-payrow">
              <InputNumber prefix="₹" min={0} value={edit.amount} onChange={(v) => setEdit({ ...edit, amount: v })} style={{ width: 150 }} autoFocus />
              <Select value={edit.pay_type} onChange={(v) => setEdit({ ...edit, pay_type: v })} popupClassName="ar-pop" style={{ width: 120 }}
                options={[{ value: 'monthly', label: 'a month' }, { value: 'daily', label: 'a day' }, { value: 'hourly', label: 'an hour' }]} />
            </div>
            <div className="ph-payrow">
              <span className="ph-setup-lbl">Paid on the</span>
              <Select value={edit.day} onChange={(v) => setEdit({ ...edit, day: v })} popupClassName="ar-pop" style={{ width: 130 }}
                options={Array.from({ length: 28 }, (_, i) => ({ value: i + 1, label: i === 0 ? '1st (monthly)' : ordinal(i + 1) }))} />
              <span className="ph-setup-lbl">from</span>
              <Input type="date" value={edit.from} onChange={(e) => setEdit({ ...edit, from: e.target.value })} style={{ width: 160 }} />
            </div>
            {p.statutory && Number(edit.day) > 1 && <p className="ph-note">PF, ESI and PT are only deducted for monthly (1st) salaries.</p>}
            <div className="ph-mfoot"><button type="button" className="plv-btn" onClick={() => setEdit(null)}>Cancel</button>
              <button type="button" className="plv-btn primary" disabled={!(Number(edit.amount) > 0) || !edit.from} onClick={saveSalary}>Save salary</button></div>
          </div>
        ) : (
          <div className="ph-salary">
            <div><b>{inr0(p.amount)} {perText(p.pay_type)}</b><span>{p.mode === 'settle' ? `Paid on the ${ordinal(p.cycle_day)} for ${ordinal(p.cycle_day)} to ${ordinal(p.cycle_day - 1)}` : 'Paid for each calendar month'}</span></div>
            <button type="button" className="plv-btn" onClick={() => setEdit({ amount: p.amount, pay_type: p.pay_type, day: p.cycle_day, from: p.cycle.from })}>Change</button>
          </div>
        )}
        <button type="button" className="ar-link ph-more-link" onClick={() => onEditSalary(p.staff_id)}>Breakup, PF / ESI / PT, commission, bank details <ArrowRightOutlined /></button>
      </div>

      <div className="ph-sheet-links">
        <button type="button" className="ar-link" onClick={() => onOpenView('month')}><FileTextOutlined /> Payslips and month details</button>
      </div>
    </Drawer>
  );
}

export { useBanks, CashOrBank };
// Kept for the header menu in Payroll.jsx.
export const MORE_VIEWS = [
  ['month', 'Month details and payslips', <FileTextOutlined key="m" />],
  ['salaries', 'All salaries and breakups', <EditOutlined key="s" />],
  ['accounts', 'Own-cycle statements', <HistoryOutlined key="a" />],
  ['advances', 'Advances list', <WalletOutlined key="v" />],
];
export const RULES_ICON = <SettingOutlined />;
export const MORE_ICON = <MoreOutlined />;
