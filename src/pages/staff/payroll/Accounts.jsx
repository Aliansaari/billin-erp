import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawer, Modal, Input, InputNumber, Select, DatePicker, message } from 'antd';
import {
  CloseOutlined, PlusOutlined, WalletOutlined, CheckOutlined, DeleteOutlined, TeamOutlined, WarningOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StaffAvatar from '../StaffAvatar';
import { payrollAPI, bankAPI } from '../../../api';
import { inr0, cap, initials, errText, cycleText } from './shared';

/*
 * Staff accounts — settle-up pay. One running balance per person:
 * earned (from settlements) minus everything handed over. Above zero the shop
 * owes them; below zero it is an advance that comes off the next settlement.
 * All figures come from services/staffAccounts.js; this screen only shows them.
 */
const fmtD = (iso) => dayjs(iso).format('D MMM YYYY');
const fmtShort = (iso) => dayjs(iso).format('D MMM');

function Balance({ value, big }) {
  const v = Number(value) || 0;
  if (Math.abs(v) < 0.5) return <span className={`pr-bal is-zero${big ? ' big' : ''}`}><b>{inr0(0)}</b><small>All settled</small></span>;
  return v > 0
    ? <span className={`pr-bal is-owe${big ? ' big' : ''}`}><b>{inr0(v)}</b><small>You owe them</small></span>
    : <span className={`pr-bal is-adv${big ? ' big' : ''}`}><b>{inr0(-v)}</b><small>Advance with them</small></span>;
}

function useBanks() {
  const [banks, setBanks] = useState([]);
  useEffect(() => { bankAPI.list({ include_inactive: false }).then(({ data }) => setBanks(data?.banks || [])).catch(() => {}); }, []);
  return banks;
}

function PayBy({ value, onChange, banks }) {
  return (
    <div className="ar-field"><label>Given by</label>
      <div className="pr-payby">
        <div className="ar-choice two">{[['Cash', 'Cash'], ['Bank', 'Bank / UPI']].map(([v, t]) => (
          <button key={v} type="button" className={value.mode === v ? 'is-on' : ''} onClick={() => onChange({ ...value, mode: v, bank: value.bank || banks[0]?.ledger_id })}><b>{t}</b></button>))}</div>
        {value.mode === 'Bank' && <Select value={value.bank} onChange={(b) => onChange({ ...value, bank: b })} placeholder={banks.length ? 'Bank account' : 'No bank account set up'} popupClassName="ar-pop"
          options={banks.map((b) => ({ value: b.ledger_id, label: b.ledger_name || b.bank_name }))} />}
      </div>
    </div>
  );
}

export default function Accounts({ staff, onGoTab }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);       // staff_id for the statement drawer
  const [giving, setGiving] = useState(null);   // staff row
  const [settling, setSettling] = useState(null);
  const banks = useBanks();
  const photos = useMemo(() => new Map((staff || []).map((s) => [s.staff_id, s.photo_thumb])), [staff]);
  const photoOf = (id) => photos.get(id) || null;

  const load = useCallback(async () => {
    try { const { data } = await payrollAPI.accounts(); setRows(data || []); } catch (e) { message.error(errText(e, 'Could not load staff accounts')); setRows([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const settle = (rows || []).filter((r) => r.mode === 'settle' || r.balance);
  const runCount = (rows || []).filter((r) => r.mode === 'run' && !r.balance).length;
  const owe = settle.filter((r) => r.balance > 0.5); const adv = settle.filter((r) => r.balance < -0.5);
  const refresh = async () => { await load(); if (open) setOpen((o) => o); };

  return (
    <>
      <div className="pr-toolbar">
        <div className="ar-tbar-l pr-muted">
          {settle.length ? <>
            {owe.length > 0 && <span>You owe <b className="tx-leave">{inr0(owe.reduce((t, r) => t + r.balance, 0))}</b> to {owe.length}</span>}
            {owe.length > 0 && adv.length > 0 && <span> · </span>}
            {adv.length > 0 && <span>Advances <b className="tx-late">{inr0(-adv.reduce((t, r) => t + r.balance, 0))}</b> with {adv.length}</span>}
            {!owe.length && !adv.length && <span>Everyone is settled.</span>}
          </> : 'Pay staff on their own cycle: give money any day, settle any dates.'}
        </div>
      </div>

      <section className="plv-table-card ar-tablecard">
        <div className="ar-tbar">
          <div className="ar-tbar-l"><b>Staff accounts</b><span className="ar-count">{settle.length}</span>
            {runCount > 0 && <span className="pr-muted">{runCount} more paid by the monthly pay run</span>}</div>
        </div>
        <div className="plv-table-scroll">
          <table className="plv-table ar-table pr-table pr-acctable">
            <colgroup><col className="c-staff" /><col className="c-cycle" /><col className="c-bal" /><col className="c-amt" /><col className="c-since" /><col className="c-btns" /></colgroup>
            <thead><tr><th>Staff</th><th>Cycle</th><th>Balance</th><th className="r">Not settled</th><th>Settled up to</th><th /></tr></thead>
            <tbody>
              {rows === null ? <tr><td colSpan={6}><div className="plv-empty">Loading…</div></td></tr> : !settle.length ? (
                <tr><td colSpan={6}><div className="plv-empty ar-empty"><TeamOutlined className="icon" /><div>Nobody is on settle-up yet</div>
                  <div className="sub">In <button type="button" className="ar-link" onClick={() => onGoTab('salaries')}>Salaries</button>, open a person and choose <b>Own cycle, settle up</b>. Their cycle can start on any day, like their joining date.</div></div></td></tr>
              ) : settle.map((r) => (
                <tr key={r.staff_id} className="row" onClick={() => setOpen(r.staff_id)}>
                  <td><div className="plv-party-inline"><StaffAvatar name={r.name} photo={photoOf(r.staff_id)} />
                    <div className="plv-party-nm"><div className="main"><span className="txt">{cap(r.name)}</span></div>
                      <div className="sub">{inr0(r.amount)} {r.pay_type === 'monthly' ? 'a month' : r.pay_type === 'daily' ? 'a day' : 'an hour'}</div></div></div></td>
                  <td>{cycleText(r.cycle_day)}{r.cycle_over_unsettled && <div className="ar-cellsub tx-late">Last cycle not settled</div>}</td>
                  <td><Balance value={r.balance} /></td>
                  <td className="r ar-num">{r.unsettled_given ? inr0(r.unsettled_given) : <span className="ar-dash">—</span>}</td>
                  <td>{r.last_settled_to ? fmtD(r.last_settled_to) : <span className="ar-dash">Never</span>}</td>
                  <td className="ar-actcell pr-rowbtns" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="plv-btn" onClick={() => setGiving(r)}><PlusOutlined /> Give money</button>
                    <button type="button" className="plv-btn primary" onClick={() => setSettling(r)}><CheckOutlined /> Settle up</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Statement staffId={open} photo={photoOf(open)} row={settle.find((r) => r.staff_id === open)} onClose={() => setOpen(null)}
        onGive={(r) => setGiving(r)} onSettle={(r) => setSettling(r)} reloadList={load} />
      <GiveMoney row={giving} banks={banks} onClose={() => setGiving(null)} onDone={async () => { setGiving(null); await refresh(); }} />
      <SettleUp row={settling} banks={banks} onClose={() => setSettling(null)} onDone={async () => { setSettling(null); await refresh(); }} />
    </>
  );
}

// ── statement drawer ─────────────────────────────────────────────────

function Statement({ staffId, photo, row, onClose, onGive, onSettle, reloadList }) {
  const [acc, setAcc] = useState(null);
  const [modal, modalCtx] = Modal.useModal();
  const load = useCallback(async () => {
    if (!staffId) return;
    try { const { data } = await payrollAPI.account(staffId); setAcc(data); } catch (e) { message.error(errText(e, 'Could not load the account')); }
  }, [staffId]);
  useEffect(() => { setAcc(null); load(); }, [load]);
  // Refresh when a give/settle elsewhere changed the list row.
  useEffect(() => { if (staffId && row) load(); }, [row?.balance, row?.unsettled_given]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = (title, content, okText, fn) => {
    let reason = '';
    modal.confirm({
      rootClassName: 'ar-pop', title, okText, okButtonProps: { danger: true },
      content: <div className="ar-form"><p className="ar-hint">{content}</p><Input.TextArea rows={2} placeholder="Reason" onChange={(e) => { reason = e.target.value; }} /></div>,
      onOk: async () => { try { await fn(reason); await load(); await reloadList(); } catch (e) { message.error(errText(e, 'Could not do that')); throw e; } },
    });
  };

  const items = useMemo(() => {
    if (!acc) return [];
    const out = [];
    for (const s of acc.settlements) out.push({ key: `s${s.settlement_id}`, date: s.to_date, order: 1, type: 'settle', s });
    for (const g of acc.given) out.push({ key: `g${g.entry_id}`, date: g.given_on, order: 0, type: 'give', g });
    for (const a of acc.old_advances) out.push({ key: `a${a.advance_id}`, date: a.given_on, order: 0, type: 'old', a });
    return out.sort((a, b) => (b.date.localeCompare(a.date)) || (b.order - a.order));
  }, [acc]);
  const latestLive = acc?.settlements.filter((s) => !s.voided_at).slice(-1)[0];

  return (
    <Drawer rootClassName="ar-pop" open={!!staffId} onClose={onClose} width={520} closeIcon={null} destroyOnHidden
      title={row && (
        <div className="ar-dhead">
          <StaffAvatar name={row.name} photo={photo} size={40} />
          <div><b>{cap(row.name)}</b><small>Cycle {cycleText(row.cycle_day)} · {inr0(row.amount)} {row.pay_type === 'monthly' ? 'a month' : row.pay_type === 'daily' ? 'a day' : 'an hour'}</small></div>
          <div className="ar-dnav"><button type="button" className="ar-dn-btn" aria-label="Close" onClick={onClose}><CloseOutlined /></button></div>
        </div>
      )}
      footer={row && (
        <div className="ar-dfoot">
          <button type="button" className="plv-btn" onClick={() => onGive(row)}><PlusOutlined /> Give money</button>
          <button type="button" className="plv-btn primary" onClick={() => onSettle(row)}><CheckOutlined /> Settle up</button>
        </div>
      )}>
      {modalCtx}
      {!acc ? <div className="plv-empty">Loading…</div> : (
        <div className="ar-drawer">
          <div className="pr-hero"><div><span>Balance</span><Balance value={acc.balance} big /></div>
            <div className="pr-hero-r"><small>Earned {inr0(acc.earned_total)} · Given {inr0(acc.given_total + acc.old_advance_total)}</small>
              {acc.unsettled_given > 0 && <small>{inr0(acc.unsettled_given)} given since the last settlement</small>}</div></div>
          <h4>Statement</h4>
          {!items.length && <p className="ar-dnote">Nothing yet. Money you give and each settlement show here.</p>}
          <ul className="pr-stmt">
            {items.map((it) => {
              if (it.type === 'settle') {
                const s = it.s; const snap = s.snapshot || {};
                return (
                  <li key={it.key} className={`is-settle${s.voided_at ? ' is-void' : ''}`}>
                    <span className="d">{fmtShort(s.to_date)}</span>
                    <div><b>Salary {fmtShort(s.from_date)} – {fmtShort(s.to_date)}</b>
                      <small>{snap.attendance ? `${snap.attendance.paid_days} paid days` : ''}{snap.adjustments?.length ? ` · ${snap.adjustments.map((a) => `${a.type === 'deduction' ? '−' : '+'}${inr0(a.amount)} ${a.label}`).join(', ')}` : ''}{s.voided_at ? ` · Cancelled: ${s.void_reason || ''}` : ''}</small></div>
                    <em className="plus">+{inr0(s.earned)}</em>
                    {!s.voided_at && latestLive?.settlement_id === s.settlement_id
                      ? <button type="button" className="ar-link danger" onClick={() => ask('Cancel this settlement?', 'The salary entry is reversed. Money you handed over stays recorded as given.', 'Cancel settlement', (r) => payrollAPI.cancelSettlement(s.settlement_id, r))}>Cancel</button> : <span />}
                  </li>
                );
              }
              if (it.type === 'old') {
                const a = it.a;
                return (
                  <li key={it.key}><span className="d">{fmtShort(a.given_on)}</span>
                    <div><b>Advance (from Advances)</b><small>{a.reason || ''}{a.recovered ? ` · ${inr0(a.recovered)} already recovered in pay runs` : ''}</small></div>
                    <em className="minus">−{inr0(a.outstanding)}</em><span /></li>
                );
              }
              const g = it.g;
              return (
                <li key={it.key} className={g.voided_at ? 'is-void' : ''}>
                  <span className="d">{fmtShort(g.given_on)}</span>
                  <div><b>{g.kind === 'salary' ? 'Salary paid' : 'Money given'}</b><small>{[g.payment_mode, g.note, g.voided_at && `Cancelled: ${g.void_reason || ''}`, !g.voided_at && !g.settlement_id && 'not settled yet'].filter(Boolean).join(' · ')}</small></div>
                  <em className="minus">−{inr0(g.amount)}</em>
                  {!g.voided_at && !g.settlement_id
                    ? <button type="button" className="ar-link danger" onClick={() => ask(`Cancel the ${inr0(g.amount)} given on ${fmtShort(g.given_on)}?`, 'The cash or bank entry is reversed.', 'Cancel entry', (r) => payrollAPI.voidMoney(g.entry_id, r))}>Cancel</button> : <span />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Drawer>
  );
}

// ── give money ───────────────────────────────────────────────────────

function GiveMoney({ row, banks, onClose, onDone }) {
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (row) setF({ amount: null, date: dayjs().format('YYYY-MM-DD'), note: '', pay: { mode: 'Cash', bank: banks[0]?.ledger_id } }); }, [row]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!row || !f) return null;
  const after = (Number(row.balance) || 0) - (Number(f.amount) || 0);
  const submit = async () => {
    setSaving(true);
    try {
      await payrollAPI.giveMoney(row.staff_id, { amount: f.amount, given_on: f.date, note: f.note || null, payment_mode: f.pay.mode, bank_ledger_id: f.pay.mode === 'Bank' ? f.pay.bank : null });
      message.success(`${inr0(f.amount)} given to ${cap(row.name)}.`); onDone();
    } catch (e) { message.error(errText(e, 'Could not record it')); setSaving(false); }
  };
  return (
    <Modal rootClassName="ar-pop" open onCancel={onClose} width={480} destroyOnHidden
      title={<div className="ar-mtitle">Give money to {cap(row.name)}<small>Any day, any amount. It comes off their next settlement.</small></div>}
      footer={<div className="ar-bfoot"><span>{f.amount ? <>Balance after: <b>{after >= 0 ? `you owe ${inr0(after)}` : `advance ${inr0(-after)}`}</b></> : ''}</span>
        <div><button type="button" className="plv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="plv-btn primary" disabled={saving || !(Number(f.amount) > 0) || (f.pay.mode === 'Bank' && !f.pay.bank)} onClick={submit}>{saving ? 'Saving…' : `Give ${f.amount ? inr0(f.amount) : ''}`}</button></div></div>}>
      <div className="ar-form">
        <div className="ar-two">
          <div className="ar-field"><label>Amount</label><InputNumber size="large" prefix="₹" min={1} value={f.amount} autoFocus onChange={(v) => setF({ ...f, amount: v })} style={{ width: '100%' }} onPressEnter={submit} /></div>
          <div className="ar-field"><label>Date</label><Input size="large" type="date" value={f.date} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
        </div>
        <PayBy value={f.pay} onChange={(pay) => setF({ ...f, pay })} banks={banks} />
        <div className="ar-field"><label>Note <em>optional</em></label><Input maxLength={200} value={f.note} placeholder="e.g. Rent, medical, festival" onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        {Number(row.balance) > 0 && <p className="ar-hint">You currently owe {cap(row.name).split(' ')[0]} {inr0(row.balance)} from earlier settlements.</p>}
      </div>
    </Modal>
  );
}

// ── settle up ────────────────────────────────────────────────────────

function SettleUp({ row, banks, onClose, onDone }) {
  const [range, setRange] = useState(null);
  const [suggested, setSuggested] = useState(null);
  const [adj, setAdj] = useState([]);
  const [addAdj, setAddAdj] = useState(null);
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [pay, setPay] = useState({ amount: null, date: dayjs().format('YYYY-MM-DD'), mode: 'Cash', bank: null });
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!row) return;
    setP(null); setErr(null); setAdj([]); setAddAdj(null); setSaving(false);
    setPay({ amount: null, date: dayjs().format('YYYY-MM-DD'), mode: 'Cash', bank: banks[0]?.ledger_id });
    payrollAPI.account(row.staff_id).then(({ data }) => { setSuggested(data.suggested); setRange([dayjs(data.suggested.from), dayjs(data.suggested.to)]); })
      .catch((e) => setErr(errText(e, 'Could not load')));
  }, [row]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!row || !range?.[0]) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const { data } = await payrollAPI.previewSettle(row.staff_id, { from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD'), adjustments: adj });
        if (n !== seq.current) return;
        setP(data); setErr(null);
        setPay((x) => ({ ...x, amount: Math.max(0, Math.round(data.owed)) }));
      } catch (e) { if (n === seq.current) { setP(null); setErr(errText(e, 'Could not work this out')); } }
    }, 250);
    return () => clearTimeout(t);
  }, [row, range, adj]);

  if (!row) return null;
  const owed = p ? p.owed : 0;
  const payAmt = Number(pay.amount) || 0;
  const after = owed - payAmt;
  const today = dayjs();
  const cyc = suggested ? { day: suggested.cycle_day } : null;
  const thisCycleFrom = (() => { if (!cyc) return null; const d = cyc.day; const s = today.date() >= d ? today.date(d) : today.subtract(1, 'month').date(d); return s; })();
  const presets = suggested ? [
    ['Suggested', dayjs(suggested.from), dayjs(suggested.to)],
    thisCycleFrom && ['This cycle so far', thisCycleFrom, today],
  ].filter(Boolean) : [];

  const submit = async (withPay) => {
    setSaving(true);
    try {
      const { data } = await payrollAPI.settle(row.staff_id, {
        from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD'), adjustments: adj,
        pay: withPay && payAmt > 0 ? { amount: payAmt, paid_on: pay.date, payment_mode: pay.mode, bank_ledger_id: pay.mode === 'Bank' ? pay.bank : null } : null,
      });
      const tail = data.balance < -0.5 ? `${inr0(-data.balance)} carried as advance.` : data.balance > 0.5 ? `${inr0(data.balance)} still owed to them.` : 'All settled.';
      message.success(`Settled ${cap(row.name)}: earned ${inr0(data.earned)}${data.paid ? `, paid ${inr0(data.paid)}` : ''}. ${tail}`, 6);
      onDone();
    } catch (e) { message.error(errText(e, 'Could not settle')); setSaving(false); }
  };
  const att = p?.attendance;

  return (
    <Modal rootClassName="ar-pop" open onCancel={onClose} width={720} destroyOnHidden style={{ top: 28 }}
      title={<div className="ar-mtitle">Settle up with {cap(row.name)}<small>Cycle {cycleText(row.cycle_day)}. Pick any dates; everything given up to the end date is counted.</small></div>}
      footer={(
        <div className="ar-bfoot">
          <span>{p ? (payAmt > 0
            ? (after < -0.5 ? <><b>{inr0(-after)}</b> extra becomes an advance</> : after > 0.5 ? <><b>{inr0(after)}</b> stays owed to them</> : 'Fully settled')
            : (owed < -0.5 ? <>They owe <b>{inr0(-owed)}</b>; it stays as an advance</> : null)) : null}</span>
          <div>
            <button type="button" className="plv-btn" onClick={onClose}>Cancel</button>
            {payAmt > 0 && <button type="button" className="plv-btn" disabled={saving || !p} onClick={() => submit(false)}>Settle, pay later</button>}
            <button type="button" className="plv-btn primary" disabled={saving || !p || (payAmt > 0 && pay.mode === 'Bank' && !pay.bank)} onClick={() => submit(true)}>
              {saving ? 'Saving…' : payAmt > 0 ? `Settle and pay ${inr0(payAmt)}` : 'Settle'}</button>
          </div>
        </div>
      )}>
      <div className="ar-form">
        <div className="pr-rangebar">
          <DatePicker.RangePicker value={range} onChange={(v) => v && setRange(v)} allowClear={false} format="D MMM YYYY" disabledDate={(d) => d.isAfter(today, 'day')} />
          <div className="ar-quick">{presets.map(([label, a, b]) => (
            <button key={label} type="button" className={range && range[0].isSame(a, 'day') && range[1].isSame(b, 'day') ? 'is-on' : ''} onClick={() => setRange([a, b])}>{label}: {a.format('D MMM')} – {b.format('D MMM')}</button>))}</div>
        </div>
        {err && <p className="ar-dnote tone-late"><WarningOutlined /> {err}</p>}
        {p && (<>
          {(p.warnings || []).map((w) => <p key={w} className="ar-dnote tone-late"><WarningOutlined /> {w}</p>)}
          <div className="pr-settle">
            <div className="pr-settle-l">
              <h4>Earned {fmtShort(p.from)} – {fmtShort(p.to)}</h4>
              {att && <div className="pr-attmini">
                <span><b>{att.paid_days}</b> paid days</span>{p.tracked ? <span><b>{att.present}</b> present</span> : <span>Attendance not tracked, every working day counts</span>}
                {att.absent > 0 && <span className="tx-bad"><b>{att.absent}</b> absent</span>}
                {att.unpaid_leave > 0 && <span className="tx-late"><b>{att.unpaid_leave}</b> unpaid leave</span>}
                {att.paid_leave > 0 && <span><b>{att.paid_leave}</b> paid leave</span>}
                {att.late > 0 && <span><b>{att.late}</b> late</span>}
              </div>}
              <table className="pr-lines"><tbody>
                {p.segments.map((g, i) => g.earnings.map((e, j) => (
                  <tr key={`${i}-${j}`}><td>{e.label}{j === 0 && <small>{fmtShort(g.from)} – {fmtShort(g.to)}{e.note ? ` · ${e.note}` : ''}</small>}{j > 0 && e.note && <small>{e.note}</small>}</td><td className="r">{inr0(e.amount)}</td></tr>
                )))}
                {p.adjustments.map((a, i) => (
                  <tr key={`a${i}`}><td>{a.label}<small>{a.type === 'deduction' ? 'Deduction' : 'Added'}</small></td>
                    <td className="r">{a.type === 'deduction' ? '−' : '+'}{inr0(a.amount)}<button type="button" className="pr-x" aria-label="Remove" onClick={() => setAdj(adj.filter((_, k) => k !== i))}><DeleteOutlined /></button></td></tr>
                ))}
                <tr className="tot"><td>Earned</td><td className="r">{inr0(p.earned)}</td></tr>
              </tbody></table>
              {addAdj ? (
                <div className="pr-addrow">
                  <div className="ar-choice two">{[['earning', 'Add to pay'], ['deduction', 'Take from pay']].map(([v, t]) => (
                    <button key={v} type="button" className={addAdj.type === v ? 'is-on' : ''} onClick={() => setAddAdj({ ...addAdj, type: v })}><b>{t}</b></button>))}</div>
                  <div className="ar-two">
                    <Input placeholder={addAdj.type === 'earning' ? 'Bonus, incentive…' : 'Fine, breakage…'} value={addAdj.label} maxLength={60} onChange={(e) => setAddAdj({ ...addAdj, label: e.target.value })} />
                    <InputNumber prefix="₹" min={0} value={addAdj.amount} onChange={(v) => setAddAdj({ ...addAdj, amount: v })} style={{ width: '100%' }} />
                  </div>
                  <div className="pr-addact"><button type="button" className="plv-btn" onClick={() => setAddAdj(null)}>Cancel</button>
                    <button type="button" className="plv-btn primary" disabled={!(Number(addAdj.amount) > 0)} onClick={() => { setAdj([...adj, { type: addAdj.type, label: addAdj.label.trim() || (addAdj.type === 'earning' ? 'Bonus' : 'Deduction'), amount: Number(addAdj.amount) }]); setAddAdj(null); }}>Add</button></div>
                </div>
              ) : <button type="button" className="ar-link" onClick={() => setAddAdj({ type: 'earning', label: '', amount: null })}><PlusOutlined /> Bonus or deduction</button>}
            </div>

            <div className="pr-settle-r">
              <h4>What you owe</h4>
              <div className="pr-calc">
                <div><span>Earned</span><b>{inr0(p.earned)}</b></div>
                {Math.abs(p.brought_forward) >= 0.5 && (
                  <div><span>{p.brought_forward < 0 ? 'Advance from before' : 'Unpaid from before'}</span><b className={p.brought_forward < 0 ? 'tx-late' : ''}>{p.brought_forward < 0 ? '−' : '+'}{inr0(Math.abs(p.brought_forward))}</b></div>
                )}
                {p.given.length > 0 && <div className="pr-calc-sub"><span>Given up to {fmtShort(p.to)}</span><b className="tx-late">−{inr0(p.given_total)}</b></div>}
                {p.given.map((g) => <div key={g.entry_id} className="pr-calc-item"><span>{fmtShort(g.given_on)}{g.note ? ` · ${g.note}` : ''}</span><em>{inr0(g.amount)}</em></div>)}
                <div className={`pr-calc-tot ${owed < -0.5 ? 'is-adv' : ''}`}><span>{owed < -0.5 ? 'They owe you' : 'You owe them'}</span><b>{inr0(Math.abs(owed))}</b></div>
                {p.given_later?.length > 0 && <p className="ar-hint"><InfoCircleOutlined /> {inr0(p.given_later.reduce((t, g) => t + g.amount, 0))} given after {fmtShort(p.to)} is kept for the next settlement.</p>}
              </div>
              <h4>Pay now</h4>
              <div className="ar-two">
                <InputNumber size="large" prefix="₹" min={0} value={pay.amount} onChange={(v) => setPay({ ...pay, amount: v })} style={{ width: '100%' }} />
                <Input size="large" type="date" value={pay.date} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setPay({ ...pay, date: e.target.value })} />
              </div>
              {payAmt > 0 && <PayBy value={{ mode: pay.mode, bank: pay.bank }} onChange={(v) => setPay({ ...pay, mode: v.mode, bank: v.bank })} banks={banks} />}
              {payAmt > 0 && after < -0.5 && <p className="ar-dnote tone-leave"><WalletOutlined /> Paying {inr0(-after)} more than owed. It becomes an advance and comes off the next settlement.</p>}
            </div>
          </div>
        </>)}
      </div>
    </Modal>
  );
}
