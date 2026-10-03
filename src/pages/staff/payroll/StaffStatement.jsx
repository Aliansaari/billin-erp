import React, { useCallback, useEffect, useState } from 'react';
import { Drawer, DatePicker, Modal, message } from 'antd';
import { CloseOutlined, PrinterOutlined, PlusOutlined, EditOutlined, WalletOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { payrollAPI } from '../../../api';
import StaffAvatar from '../StaffAvatar';
import { inr0, cap, errText, ordinal } from './shared';
import { printStatement } from './printStatement';

/*
 * Staff statement — everything between the shop and one person, in one
 * ledger: salary earned, salary paid, advances and money given, with a
 * running balance. Works the same for monthly and own-cycle staff; the
 * figures come from GET /payroll/people/:id/statement, nothing is
 * recalculated here.
 *
 *   Balance > 0  the shop owes the person
 *   Balance < 0  the person has taken more than earned (advance)
 *
 * Keys: P prints, Esc closes.
 */
const fyStart = (d) => (d.month() >= 3 ? d.month(3).date(1) : d.subtract(1, 'year').month(3).date(1));
const PERIODS = [
  ['month', 'This month', () => ({ from: dayjs().startOf('month'), to: null })],
  ['3m', 'Last 3 months', () => ({ from: dayjs().subtract(2, 'month').startOf('month'), to: null })],
  ['fy', 'This year', () => ({ from: fyStart(dayjs()), to: null })],
  ['all', 'All', () => ({ from: null, to: null })],
];
const fmtD = (iso) => dayjs(iso).format('D MMM YYYY');
const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const balText = (n) => (Math.abs(n) < 0.5 ? 'Settled' : n > 0 ? `${inr0(n)} to pay` : `${inr0(-n)} advance`);
const perText = (t) => (t === 'daily' ? 'a day' : t === 'hourly' ? 'an hour' : 'a month');

export default function StaffStatement({ person: p, company, onClose, onPay, onGive, onEditSalary, onChanged }) {
  const [period, setPeriod] = useState('fy');
  const [custom, setCustom] = useState(null);           // [dayjs, dayjs]
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [modal, modalCtx] = Modal.useModal();

  const range = period === 'custom' && custom
    ? { from: custom[0], to: custom[1] }
    : (PERIODS.find(([k]) => k === period) || PERIODS[2])[2]();
  const fromIso = range.from ? range.from.format('YYYY-MM-DD') : undefined;
  const toIso = range.to ? range.to.format('YYYY-MM-DD') : undefined;

  const load = useCallback(async () => {
    if (!p) return;
    try { const { data } = await payrollAPI.statement(p.staff_id, { from: fromIso, to: toIso }); setSt(data); setErr(null); }
    catch (e) { setErr(errText(e, 'Could not load the statement')); }
  }, [p?.staff_id, fromIso, toIso]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (p) { setPeriod('fy'); setCustom(null); setSt(null); } }, [p?.staff_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const periodLabel = period === 'custom' && custom
    ? `${custom[0].format('D MMM YYYY')} – ${custom[1].format('D MMM YYYY')}`
    : period === 'all' ? 'All entries'
      : `${range.from.format('D MMM YYYY')} – ${dayjs().format('D MMM YYYY')}`;
  const print = () => st && printStatement(st, { company, periodLabel, person: p });

  // P prints (not while typing in a field).
  useEffect(() => {
    if (!p) return undefined;
    const onKey = (e) => {
      if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.target.closest?.('input, textarea')) { e.preventDefault(); print(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelRow = (row) => modal.confirm({
    rootClassName: 'ar-pop', title: `Cancel this ${inr0(row.paid)}?`, okText: 'Cancel it', cancelText: 'Keep', okButtonProps: { danger: true },
    content: 'It comes off the statement and the cash or bank entry is reversed.',
    onOk: async () => {
      try {
        if (row.cancel.type === 'advance') await payrollAPI.voidAdvance(row.cancel.id, 'Cancelled from staff statement');
        else await payrollAPI.voidMoney(row.cancel.id, 'Cancelled from staff statement');
        await load(); await onChanged?.();
      } catch (e) { message.error(errText(e, 'Could not cancel')); throw e; }
    },
  });

  if (!p) return <Drawer rootClassName="ar-pop" open={false} />;
  const due = p.due && p.due.amount > 0 && !p.due.hold ? p.due.amount : 0;
  const bal = st?.balance_now ?? 0;

  return (
    <Drawer rootClassName="ar-pop" open onClose={onClose} width={860} closeIcon={null} destroyOnHidden className="ss" title={null}>
      {modalCtx}
      <header className="ss-head">
        <StaffAvatar name={p.name} photo={p.photo} size={44} />
        <div className="ss-who">
          <b>{cap(p.name)}</b>
          <span>{[p.designation, p.amount ? `${inr0(p.amount)} ${perText(p.pay_type)}` : null, p.mode === 'settle' ? `paid on the ${ordinal(p.cycle_day)}` : 'paid monthly'].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="ss-head-act">
          <button type="button" className="plv-btn" onClick={print} disabled={!st} title="Print statement (P)"><PrinterOutlined /> Print</button>
          <button type="button" className="ar-dn-btn" aria-label="Close" onClick={onClose}><CloseOutlined /></button>
        </div>
      </header>

      <section className="ss-sum">
        <div className="ss-bal">
          <span>Balance today</span>
          <b className={bal < -0.5 ? 'adv' : bal > 0.5 ? 'owe' : ''}>{st ? balText(bal) : '…'}</b>
          {p.so_far && <small>Plus {inr0(p.so_far.earned)} earned so far this cycle, not yet due</small>}
        </div>
        <div className="ss-act">
          {due > 0 && <button type="button" className="plv-btn primary" onClick={() => onPay(p)}><WalletOutlined /> Pay {inr0(due)}</button>}
          <button type="button" className="plv-btn" onClick={() => onGive(p)}><PlusOutlined /> Give money</button>
          <button type="button" className="plv-btn" onClick={() => onEditSalary(p.staff_id)}><EditOutlined /> Salary</button>
        </div>
      </section>

      <nav className="ss-tabs">
        {PERIODS.map(([k, label]) => (
          <button key={k} type="button" className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{label}</button>
        ))}
        <span className={`ss-custom${period === 'custom' ? ' on' : ''}`}>
          <DatePicker.RangePicker size="small" format="D MMM YYYY" allowClear={false} value={custom} popupClassName="ar-pop"
            onChange={(v) => { if (v) { setCustom(v); setPeriod('custom'); } }} placeholder={['From', 'To']} />
        </span>
      </nav>

      {err ? <p className="ss-err">{err}</p> : !st ? <p className="ss-muted">Loading…</p> : (
        <div className="ss-table-wrap">
          <table className="ss-table">
            <colgroup><col className="c-date" /><col /><col className="c-amt" /><col className="c-amt" /><col className="c-bal" /></colgroup>
            <thead><tr><th>Date</th><th>Details</th><th className="r">Earned</th><th className="r">Paid</th><th className="r">Balance</th></tr></thead>
            <tbody>
              {st.from && (
                <tr className="ss-open"><td>{fmtD(st.from)}</td><td>Opening balance</td><td /><td /><td className="r">{money(st.opening)}</td></tr>
              )}
              {!st.rows.length ? (
                <tr className="ss-none"><td colSpan={5}>Nothing in this period.</td></tr>
              ) : st.rows.map((r) => (
                <tr key={r.ref} className={`k-${r.kind}`}>
                  <td className="d">{fmtD(r.date)}</td>
                  <td><div className="t">{r.text}{r.cancel && <button type="button" className="ss-cancel" onClick={() => cancelRow(r)}>Cancel</button>}</div>
                    {r.detail && <div className="s">{r.detail}</div>}</td>
                  <td className="r e">{r.earned ? money(r.earned) : ''}</td>
                  <td className="r pd">{r.paid ? money(r.paid) : ''}</td>
                  <td className={`r b${r.balance < -0.004 ? ' neg' : ''}`}>{money(r.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Closing balance <span className="ss-cl">{balText(st.closing)}</span></td>
                <td className="r">{money(st.earned)}</td>
                <td className="r">{money(st.paid)}</td>
                <td className={`r${st.closing < -0.004 ? ' neg' : ''}`}>{money(st.closing)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="ss-foot">Earned is salary after PF, ESI and other deductions. Advances count as paid the day they are given, so salary is shown before taking them back. Press P to print.</p>
    </Drawer>
  );
}
