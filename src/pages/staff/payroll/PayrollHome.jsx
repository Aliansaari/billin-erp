import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Input, InputNumber, Select, Drawer, message } from 'antd';
import {
  WalletOutlined, PlusOutlined, SettingOutlined, MoreOutlined, CloseOutlined, CalendarOutlined,
  FileTextOutlined, TeamOutlined, EditOutlined, ArrowRightOutlined, WarningOutlined, HistoryOutlined, SearchOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { payrollAPI, bankAPI } from '../../../api';
import ActionStrip from '../../../components/keyboard/ActionStrip';
import useListSelection from '../../../hooks/useListSelection';
import StaffAvatar from '../StaffAvatar';
import QuickEntry, { payable } from './QuickEntry';
import { inr0, cap, errText, ordinal } from './shared';

/*
 * Payroll — a quiet list of staff with one entry line on top.
 *
 *   Entry line (QuickEntry): person → amount → Enter. Pays what is due,
 *   gives an advance, or sets a missing salary. No dialogs.
 *   List: who is owed what. Five columns, nothing else.
 *
 * Keyboard (same model as every ZEHEN list):
 *   ↑ ↓ PgUp PgDn Home End  move · Shift / Ctrl  select several
 *   F1  pay (loads the entry line; with several selected, pays them)
 *   F2  salary   F3  give   F4  find   F6  pay all due
 *   F8 / Enter  details    F10  export    /  jump to the entry line
 *   Esc  back (inside the entry line: clears it)
 *
 * Monthly staff and own-cycle staff share the list; the server
 * (services/payrollHome.js) routes every action to the right engine.
 */
const fmtD = (iso) => dayjs(iso).format('D MMM');
const perText = (t) => (t === 'daily' ? 'a day' : t === 'hourly' ? 'an hour' : 'a month');
const perShort = (t) => (t === 'daily' ? '/day' : t === 'hourly' ? '/hr' : '/mo');
const payDayText = (p) => (p.mode === 'settle' ? `paid on the ${ordinal(p.cycle_day)}` : 'paid monthly');
const outstanding = (r) => (r.taken || 0) + (r.advance || 0);
const dueOf = (r) => (payable(r) ? r.due.amount : 0);
const inField = (el) => !!el?.closest?.('input, textarea, .ant-select, [contenteditable="true"]');

function useBanks() {
  const [banks, setBanks] = useState([]);
  useEffect(() => { bankAPI.list({ include_inactive: false }).then(({ data }) => setBanks(data?.banks || [])).catch(() => {}); }, []);
  return banks;
}

const TABS = [['all', 'All staff'], ['due', 'Due'], ['advance', 'Advances'], ['nosalary', 'Salary not set']];

export default function PayrollHome({ staff, structures, onOpenView, onEditSalary, reloadBase, overlayOpen, menus, notPosted }) {
  const [h, setH] = useState(null);
  const [err, setErr] = useState(null);
  const [payList, setPayList] = useState(null);    // people for "pay all / pay selected"
  const [sheet, setSheet] = useState(null);        // staff_id
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const searchRef = useRef(null);
  const entry = useRef(null);
  const banks = useBanks();

  const load = useCallback(async () => {
    try { const { data } = await payrollAPI.home(); setH(data); setErr(null); }
    catch (e) { setErr(errText(e, 'Could not load payroll')); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const after = async (data, baseChanged) => {
    if (baseChanged) await reloadBase();
    if (data?.people) setH(data); else await load();
  };

  // Everyone in one list: people with a salary, then people still without one.
  const rows = useMemo(() => (!h ? [] : [
    ...h.people.map((p) => ({ ...p, key: p.staff_id })),
    ...h.missing.map((m) => ({ ...m, key: m.staff_id, missing: true })),
  ]), [h]);
  const groups = useMemo(() => ({
    all: rows,
    due: rows.filter((r) => dueOf(r) > 0),
    advance: rows.filter((r) => outstanding(r) > 0),
    nosalary: rows.filter((r) => r.missing),
  }), [rows]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups[tab].filter((r) => !q || r.name.toLowerCase().includes(q) || String(r.designation || '').toLowerCase().includes(q));
  }, [groups, tab, search]);
  const sum = (list, f) => list.reduce((t, r) => t + f(r), 0);

  // While a dialog or drawer is open the list and F-keys stand down, and come
  // back a moment after it closes so the key that closed it is not read twice.
  const open = !!(payList || sheet || overlayOpen);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (open) { setSettling(true); return undefined; }
    const t = setTimeout(() => setSettling(false), 150);
    return () => clearTimeout(t);
  }, [open]);
  const busy = open || settling;

  const sel = useListSelection({ totalCount: visible.length, rows: visible, enabled: !busy });
  const single = sel.selectionCount <= 1 ? sel.activeRow : null;
  const multi = sel.selectionCount > 1 ? sel.selectedRows : null;
  const selectedDue = multi ? multi.filter((r) => dueOf(r) > 0) : [];

  // Keep the cursor in view, above the sticky header.
  useEffect(() => {
    if (sel.cursorIdx == null) return;
    const scroller = document.querySelector('.pr-list-scroll');
    const row = scroller?.querySelector(`[data-row-idx="${sel.cursorIdx}"]`);
    if (!scroller || !row) return;
    const headH = scroller.querySelector('thead')?.offsetHeight || 0;
    const r = row.getBoundingClientRect(); const sc = scroller.getBoundingClientRect();
    if (r.top - sc.top < headH) scroller.scrollTop -= headH - (r.top - sc.top);
    else if (r.bottom - sc.top > scroller.clientHeight) scroller.scrollTop += r.bottom - sc.top - scroller.clientHeight;
  }, [sel.cursorIdx]);
  useEffect(() => { if (visible.length && sel.cursorIdx == null) sel.setCursor(0); }, [visible.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // "/" jumps to the entry line from anywhere on the page.
  useEffect(() => {
    const onKey = (e) => { if (e.key === '/' && !busy && !inField(e.target)) { e.preventDefault(); entry.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy]);

  const pay = () => {
    if (multi) { if (selectedDue.length) setPayList(selectedDue); return; }
    if (single) entry.current?.load(single.staff_id, 'pay');
  };
  const give = () => (single && !single.missing ? entry.current?.load(single.staff_id, 'give') : entry.current?.focus());
  const details = (r) => { if (!r) return; if (r.missing) entry.current?.load(r.staff_id); else setSheet(r.staff_id); };
  const exportCsv = () => {
    const head = ['Name', 'Designation', 'Salary', 'Per', 'Salary date', 'Earned this cycle', 'Advance', 'Due for', 'Due now'];
    const lines = visible.map((r) => [r.name, r.designation || '', r.amount || '', r.missing ? '' : perText(r.pay_type), r.missing ? '' : (r.mode === 'settle' ? ordinal(r.cycle_day) : '1st'),
      r.so_far?.earned ?? '', outstanding(r), dueOf(r) ? r.due.label : '', dueOf(r)]);
    const csv = [head, ...lines].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv' }));
    a.download = `payroll-${h.today}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const T = h?.totals || {};
  const nextPay = h ? h.people.map((p) => p.next_payday).sort()[0] : null;
  const tabAmount = { all: null, due: T.due, advance: T.advances, nosalary: null };

  return (
    <>
      <header className="plv-hdr pr-hdr3">
        <div className="plv-title">
          <h1>Payroll</h1>
          <div className="sub">
            {h ? <>{dayjs(h.today).format('MMMM YYYY')} · paid out <b>{inr0(T.paid_this_month)}</b> this month{nextPay ? <> · next salary day <b>{dayjs(nextPay).format('D MMM')}</b></> : null}{notPosted ? ' · not posted to accounts' : ''}</> : 'Loading…'}
          </div>
        </div>
        <div className="plv-actions">
          {menus}
          <button type="button" className="plv-btn primary" onClick={() => setPayList(groups.due)} disabled={!groups.due.length}>
            <WalletOutlined /> {groups.due.length ? `Pay all due · ${inr0(T.due)}` : 'Everyone is paid'}
          </button>
        </div>
      </header>

      {err && <div className="pr-err"><WarningOutlined /> {err} <button type="button" className="ar-link" onClick={load}>Try again</button></div>}

      <div className="pr-body3">
        <QuickEntry ref={entry} rows={rows} banks={banks} month={h?.month} onSaved={after} />

        <div className="ph-tabs">
          <div className="ph-tabs-l" role="tablist">
            {TABS.filter(([k]) => k === 'all' || groups[k].length || tab === k).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`ph-tab${tab === k ? ' on' : ''}${k === 'nosalary' ? ' warn' : ''}`} onClick={() => setTab(k)}>
                {label} <span className="n">{groups[k].length}</span>
                {tabAmount[k] ? <b>{inr0(tabAmount[k])}</b> : null}
              </button>
            ))}
          </div>
          <div className="plv-search ph-find"><SearchOutlined /><input ref={searchRef} placeholder="Find staff  (F4)" value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSearch(''); e.currentTarget.blur(); } if (e.key === 'Enter' || e.key === 'ArrowDown') { e.currentTarget.blur(); if (visible.length) sel.setCursor(0); } }} /></div>
        </div>

        <div className="ph-card">
          <div className="pr-list-scroll">
            <table className="pr-list3">
              <colgroup><col className="c-who" /><col className="c-pay" /><col className="c-earn" /><col className="c-adv" /><col className="c-due" /></colgroup>
              <thead><tr><th>Staff</th><th>Salary</th><th>Earned this cycle</th><th className="r">Advance</th><th className="r">Due now</th></tr></thead>
              <tbody>
                {!h ? <tr><td colSpan={5} className="pr-none">Loading…</td></tr> : !visible.length ? (
                  <tr><td colSpan={5} className="pr-none"><TeamOutlined /> {rows.length ? 'Nobody here.' : 'No staff yet. Add staff in Staff & Rules first.'}</td></tr>
                ) : visible.map((r, idx) => {
                  const isCursor = sel.cursorIdx === idx; const isMulti = sel.selectedSet.has(idx) && !isCursor;
                  const due = dueOf(r); const adv = outstanding(r);
                  return (
                    <tr key={r.key} data-row-idx={idx} className={`${isCursor ? 'vrt-row-active' : ''}${isMulti ? ' vrt-row-multi' : ''}`}
                      onClick={(e) => { if (e.shiftKey) sel.extendTo(idx); else if (e.ctrlKey || e.metaKey) sel.toggleRow(idx); else sel.setCursor(idx); }}
                      onDoubleClick={() => details(r)}>
                      <td><div className="pr-who"><StaffAvatar name={r.name} photo={r.photo} size={30} />
                        <div><b>{cap(r.name)}</b><small>{r.designation || 'Staff'}{r.mode === 'settle' ? ` · paid on the ${ordinal(r.cycle_day)}` : ''}</small></div></div></td>
                      <td>{r.missing ? <span className="pr-set">Not set</span> : <>{inr0(r.amount)}<small className="pr-dim"> {perShort(r.pay_type)}</small></>}</td>
                      <td>{r.so_far ? <>{inr0(r.so_far.earned)}<small className="pr-dim"> · {r.so_far.paid_days} of {r.so_far.days} days</small></> : <span className="pr-dim">—</span>}</td>
                      <td className="r">{adv > 0 ? <span className="pr-adv3">{inr0(adv)}</span> : <span className="pr-dim">—</span>}</td>
                      <td className="r">{due ? <><b>{inr0(due)}</b><small className="pr-dim pr-for3">{r.due.label}</small></>
                        : r.missing ? <span className="pr-dim">—</span>
                          : r.due?.hold ? <span className="pr-dim">On hold</span>
                            : <span className="pr-ok">Paid up</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ActionStrip
        info={multi ? `${multi.length} selected · ${inr0(sum(selectedDue, dueOf))} due` : null}
        actions={[
          { id: 'salary', key: 'F2', label: 'Salary', disabled: busy || !single, onAction: () => single && onEditSalary(single.staff_id) },
          { id: 'give', key: 'F3', label: 'Give', disabled: busy || !h?.people.length, onAction: give },
          { id: 'find', key: 'F4', label: 'Find', disabled: busy, onAction: () => searchRef.current?.focus() },
          { id: 'refresh', key: 'F5', label: 'Refresh', hidden: true, disabled: busy, onAction: () => load() },
          { id: 'payall', key: 'F6', label: 'Pay all', disabled: busy || !groups.due.length, onAction: () => setPayList(groups.due) },
          { id: 'month', key: 'F7', label: 'Payslips', hidden: true, disabled: busy, onAction: () => onOpenView('month') },
          { id: 'details', key: 'F8', label: 'Details', disabled: busy || !single, onAction: () => details(single) },
          { id: 'enter', key: 'Enter', hidden: true, disabled: busy || !single, onAction: (e) => { if (!inField(e.target)) details(single); } },
          { id: 'rules', key: 'F9', label: 'Rules', hidden: true, disabled: busy, onAction: () => onOpenView('rules') },
          { id: 'export', key: 'F10', label: 'Export', disabled: busy || !visible.length, onAction: exportCsv },
          { id: 'back', key: 'Esc', label: 'Back', hidden: true, disabled: busy },
          { id: 'pay', key: 'F1', tone: 'primary', label: multi ? `Pay ${selectedDue.length} selected` : 'Pay',
            disabled: busy || (multi ? !selectedDue.length : !(single && dueOf(single))), onAction: pay },
        ]}
      />

      <PayAllModal list={payList} h={h} banks={banks} onClose={() => setPayList(null)} onDone={async (d) => { setPayList(null); await after(d); }} />
      <PersonSheet person={sheet ? h?.people.find((p) => p.staff_id === sheet) : null} structures={structures} staff={staff} onClose={() => setSheet(null)}
        onPay={(p) => { setSheet(null); entry.current?.load(p.staff_id, 'pay'); }} onGive={(p) => { setSheet(null); entry.current?.load(p.staff_id, 'give'); }}
        onEditSalary={onEditSalary} onChanged={async () => { await reloadBase(); await load(); }} onOpenView={onOpenView} />
    </>
  );
}

// ── pay several people: everyone due, or the ones selected ────────────

function PayAllModal({ list, h, banks, onClose, onDone }) {
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [from, setFrom] = useState('cash');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (list) { setDate(dayjs().format('YYYY-MM-DD')); setFrom('cash'); setSaving(false); } }, [list]);
  if (!list || !h) return null;
  const everyone = list.length === h.people.filter(payable).length;
  const total = list.reduce((t, p) => t + p.due.amount, 0);
  const locks = list.some((p) => p.due.kind === 'run' && !p.due.locked);
  const submit = async () => {
    setSaving(true);
    try {
      const { data } = await payrollAPI.payAll({ paid_on: date, payment_mode: from === 'cash' ? 'Cash' : 'Bank', bank_ledger_id: from === 'cash' ? null : from, staff_ids: everyone ? undefined : list.map((p) => p.staff_id) });
      if (data.failed?.length) {
        Modal.warning({ rootClassName: 'ar-pop', title: `Paid ${inr0(data.total)} to ${data.paid.length}. ${data.failed.length} not paid.`,
          content: <ul className="ph-fail">{data.failed.map((f) => <li key={f.staff_id}><b>{cap(f.name)}</b>: {f.error}</li>)}</ul> });
      } else message.success(`Paid ${inr0(data.total)} to ${data.paid.length} ${data.paid.length === 1 ? 'person' : 'people'}.`);
      onDone(data.home);
    } catch (e) { message.error(errText(e, 'Could not pay')); setSaving(false); }
  };
  return (
    <Modal rootClassName="ar-pop" open onCancel={onClose} width={520} destroyOnHidden footer={null} className="ph-modal">
      <div className="ph-mhead ph-mhead-plain"><div><b>{everyone ? 'Pay everyone due' : `Pay ${list.length} selected`}</b><span>{list.length} {list.length === 1 ? 'person' : 'people'}</span></div></div>
      <div className="ph-paylist">
        {list.map((p) => (
          <div key={p.staff_id}><StaffAvatar name={p.name} photo={p.photo} size={28} /><span>{cap(p.name)}<small>{p.due.label}</small></span><b>{inr0(p.due.amount)}</b></div>
        ))}
        <div className="ph-paylist-tot"><span>Total</span><b>{inr0(total)}</b></div>
      </div>
      <div className="ph-payrow">
        <Input type="date" value={date} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} />
        <Select value={from} onChange={setFrom} popupClassName="ar-pop" style={{ width: 200 }}
          options={[{ value: 'cash', label: 'Paid from cash' }, ...banks.map((b) => ({ value: b.ledger_id, label: `Paid from ${b.ledger_name || b.bank_name}` }))]} />
      </div>
      {locks && <p className="ph-note">Paying locks {h.month.label} salaries for all {h.month.people} monthly staff, so the amounts stop changing.</p>}
      <div className="ph-mfoot">
        <button type="button" className="plv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="ph-btn-xl" autoFocus disabled={saving} onClick={submit}>{saving ? 'Paying…' : `Pay ${inr0(total)}`}</button>
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

// Kept for the header menu in Payroll.jsx.
export const MORE_VIEWS = [
  ['month', 'Month details and payslips', <FileTextOutlined key="m" />],
  ['salaries', 'All salaries and breakups', <EditOutlined key="s" />],
  ['accounts', 'Own-cycle statements', <HistoryOutlined key="a" />],
  ['advances', 'Advances list', <WalletOutlined key="v" />],
];
export const RULES_ICON = <SettingOutlined />;
export const MORE_ICON = <MoreOutlined />;
