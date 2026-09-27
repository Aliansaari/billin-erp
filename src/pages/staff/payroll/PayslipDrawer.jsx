import React, { useEffect, useState } from 'react';
import { Drawer, Input, InputNumber, Modal, message, Switch } from 'antd';
import {
  LeftOutlined, RightOutlined, CloseOutlined, PrinterOutlined, WalletOutlined, PlusOutlined, DeleteOutlined, WarningOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StaffAvatar from '../StaffAvatar';
import { payrollAPI } from '../../../api';
import { printPayslips } from './printPayslip';
import { inr, inr0, monthLabel, cap, initials, errText, lineStatus, PAY_TYPES } from './shared';

/** Amount box that saves on blur / Enter, not on every keystroke. */
function RecoveryInput({ value, max, disabled, onCommit }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const commit = () => { const n = Math.min(Number(v) || 0, max); if (n !== value) onCommit(n); };
  return <InputNumber prefix="₹" min={0} max={max} value={v} disabled={disabled} onChange={setV} onBlur={commit} onPressEnter={commit} style={{ width: 120 }} />;
}

const EARN_PICKS =['Bonus', 'Incentive', 'Arrears', 'Reimbursement'];
const DED_PICKS = ['Fine', 'Breakage', 'Canteen', 'Other deduction'];

/*
 * One person's payslip for the month. Reads the server's computed slip; the
 * only things edited here (draft only) are extra lines, advance recovery and
 * hold — each save re-computes on the server, so the numbers shown are always
 * the numbers that will be finalized.
 */
export default function PayslipDrawer({ open, line, lines, period, status, company, photo, onClose, onNavigate, onData, onPay }) {
  const final = status === 'finalized';
  const [adding, setAdding] = useState(null);
  const [saving, setSaving] = useState(false);
  const [payments, setPayments] = useState([]);
  const [modal, modalCtx] = Modal.useModal();

  useEffect(() => { setAdding(null); }, [line?.staff_id]);
  useEffect(() => {
    if (!open || !final || !line) { setPayments([]); return; }
    payrollAPI.payments(period).then(({ data }) => setPayments((data || []).filter((p) => p.payslip_id === line.payslip_id))).catch(() => setPayments([]));
  }, [open, final, line, period]);

  if (!line) return <Drawer rootClassName="ar-pop" open={open} onClose={onClose} width={500} />;
  const s = line.slip; const a = s.attendance; const st = lineStatus(line, status);
  const idx = lines.findIndex((l) => l.staff_id === line.staff_id);

  const save = async (patch) => {
    setSaving(true);
    try {
      const { data } = await payrollAPI.saveLine(period, line.staff_id, { adjustments: line.adjustments || [], recoveries: line.recoveries || {}, hold: line.hold, ...patch });
      onData(data);
      return true;
    } catch (e) { message.error(errText(e, 'Could not save')); return false; } finally { setSaving(false); }
  };
  const addLine = async () => {
    if (!adding.label.trim() || !(Number(adding.amount) > 0)) return;
    if (await save({ adjustments: [...(line.adjustments || []), { type: adding.type, label: adding.label.trim(), amount: Number(adding.amount), note: adding.note || null }] })) setAdding(null);
  };
  const removeLine = (id) => save({ adjustments: (line.adjustments || []).filter((x) => x.id !== id) });
  const setRecovery = (advanceId, v) => save({ recoveries: { ...(line.recoveries || {}), [advanceId]: v } });
  const clearRecovery = (advanceId) => { const r = { ...(line.recoveries || {}) }; delete r[advanceId]; return save({ recoveries: r }); };
  const voidPayment = (p) => {
    let reason = '';
    modal.confirm({
      rootClassName: 'ar-pop', title: `Cancel the ${inr0(p.amount)} payment of ${dayjs(p.paid_on).format('D MMM')}?`,
      content: <div className="ar-form"><p className="ar-hint">The accounting entry is reversed. The payment stays on record as cancelled.</p>
        <Input.TextArea rows={2} placeholder="Reason" onChange={(e) => { reason = e.target.value; }} /></div>,
      okText: 'Cancel payment', okButtonProps: { danger: true },
      onOk: async () => {
        try { await payrollAPI.voidPayment(p.payment_id, reason); message.success('Payment cancelled.'); const { data } = await payrollAPI.getRun(period); onData(data); }
        catch (e) { message.error(errText(e, 'Could not cancel')); throw e; }
      },
    });
  };

  const attCells = s.pay_type === 'hourly'
    ? [['Paid hours', `${a.paid_hours} h`], ['On the clock', `${a.worked_hours} h`], ['Days present', a.present], ['Paid leave', a.paid_leave], ['Absent', a.absent]]
    : [['Paid days', s.pay_type === 'monthly' ? `${a.paid_days} of ${s.basis_days}` : a.paid_days], ['Present', a.present], ['Paid leave', a.paid_leave],
      ['Unpaid leave', a.unpaid_leave], ['Absent', a.absent], ['Late', a.late], ...(a.ot_hours ? [['Overtime', `${a.ot_hours} h`]] : []),
      ...(a.holidays ? [['Holidays', a.holidays]] : []), ...(a.half_days ? [['Half days', a.half_days]] : [])];
  const cutWhy = [a.absent && `${a.absent} absent`, a.unpaid_leave && `${a.unpaid_leave} unpaid leave`, a.half_days && `${a.half_days} half day${a.half_days > 1 ? 's' : ''}`,
    a.late_penalty_days && `${a.late_penalty_days} for ${a.late} late marks`, a.unverified && `${a.unverified} unverified`].filter(Boolean);
  const joinedIn = s.staff.joined_on?.startsWith(period); const leftIn = s.staff.left_on?.startsWith(period);
  const recLines = s.deductions.filter((d) => d.code === 'advance');

  return (
    <Drawer rootClassName="ar-pop" open={open} onClose={onClose} width={500} closeIcon={null} destroyOnHidden
      title={(
        <div className="ar-dhead">
          <StaffAvatar name={s.staff.name} photo={photo} size={40} />
          <div><b>{cap(s.staff.name)}</b><small>{[s.staff.designation, monthLabel(period)].filter(Boolean).join(' · ')}</small></div>
          <div className="ar-dnav">
            <button type="button" className="ar-dn-btn" aria-label="Previous" disabled={idx <= 0} onClick={() => onNavigate(lines[idx - 1].staff_id)}><LeftOutlined /></button>
            <button type="button" className="ar-dn-btn" aria-label="Next" disabled={idx >= lines.length - 1} onClick={() => onNavigate(lines[idx + 1].staff_id)}><RightOutlined /></button>
            <button type="button" className="ar-dn-btn" aria-label="Close" onClick={onClose}><CloseOutlined /></button>
          </div>
        </div>
      )}
      footer={(
        <div className="ar-dfoot">
          {final && <button type="button" className="plv-btn" onClick={() => printPayslips([line], company, period)}><PrinterOutlined /> Print payslip</button>}
          {final && line.due > 0 && !line.hold && <button type="button" className="plv-btn primary" onClick={() => onPay(line)}><WalletOutlined /> Pay {inr0(line.due)}</button>}
          {!final && <span className="pr-muted">Draft. Finalize the month to print or pay.</span>}
        </div>
      )}>
      <div className="ar-drawer pr-slip">
        {modalCtx}
      <div className="pr-hero">
          <div><span>Net pay</span><b>{inr0(s.net)}</b></div>
          <div className="pr-hero-r">
            <span className={`plv-status-tag ar-tag tone-${st.tone}`}>{st.label}</span>
            {final && <small>{line.paid ? `${inr0(line.paid)} paid · ${inr0(line.due)} to pay` : 'Nothing paid yet'}</small>}
            {!final && <small>{PAY_TYPES[s.pay_type]?.label} · {inr0(s.rate)} {PAY_TYPES[s.pay_type]?.unit}</small>}
          </div>
        </div>

        {(s.warnings || []).map((w) => <p key={w} className="ar-dnote tone-late"><WarningOutlined /> {w}</p>)}

        <h4>Attendance</h4>
        {!s.tracked && <p className="ar-dnote"><InfoCircleOutlined /> Attendance is not tracked for this person, so every working day counts. Unpaid leave still comes off.</p>}
        <div className="pr-attgrid">{attCells.map(([k, v]) => <div key={k}><b>{v}</b><span>{k}</span></div>)}</div>
        {s.pay_type === 'monthly' && cutWhy.length > 0 && <p className="ar-dnote tone-late">{a.lop_days} day{a.lop_days === 1 ? '' : 's'} cut: {cutWhy.join(', ')}.</p>}
        {a.not_employed > 0 && (joinedIn || leftIn) && (
          <p className="ar-dnote">{joinedIn ? `Joined on ${dayjs(s.staff.joined_on).format('D MMMM')}` : `Left on ${dayjs(s.staff.left_on).format('D MMMM')}`}, so {a.not_employed} day{a.not_employed === 1 ? ' is' : 's are'} not paid this month.</p>
        )}
        {(s.notes || []).map((n) => <p key={n} className="ar-dnote">{n}</p>)}

        <h4>Earnings</h4>
        <table className="pr-lines"><tbody>
          {s.earnings.map((e, i) => (
            <tr key={i}><td>{e.label}{e.note && <small>{e.note}</small>}</td>
              <td className="r">{inr(e.amount, 2)}{!final && e.code === 'adjustment' && <button type="button" className="pr-x" aria-label="Remove" onClick={() => removeLine(e.adj_id)}><DeleteOutlined /></button>}</td></tr>
          ))}
          <tr className="tot"><td>Gross pay</td><td className="r">{inr(s.gross, 2)}</td></tr>
        </tbody></table>

        <h4>Deductions</h4>
        {s.deductions.length === 0 ? <p className="ar-dnote">No deductions.</p> : (
          <table className="pr-lines"><tbody>
            {s.deductions.map((d, i) => (
              <tr key={i}><td>{d.label}{d.note && <small>{d.note}</small>}</td>
                <td className="r">−{inr(d.amount, 2)}{!final && d.code === 'adjustment' && <button type="button" className="pr-x" aria-label="Remove" onClick={() => removeLine(d.adj_id)}><DeleteOutlined /></button>}</td></tr>
            ))}
            {s.round_off ? <tr><td>Rounding</td><td className="r">{s.round_off > 0 ? '+' : '−'}{inr(Math.abs(s.round_off), 2)}</td></tr> : null}
            <tr className="tot"><td>Total deductions</td><td className="r">−{inr(s.total_deductions, 2)}</td></tr>
          </tbody></table>
        )}

        {s.employer.length > 0 && (<>
          <h4>Paid by the shop on top</h4>
          <table className="pr-lines"><tbody>
            {s.employer.map((e, i) => <tr key={i}><td>{e.label}</td><td className="r">{inr(e.amount, 2)}</td></tr>)}
            <tr className="tot"><td>Cost to company</td><td className="r">{inr(s.employer_cost, 2)}</td></tr>
          </tbody></table>
        </>)}

        {!final && (
          <section className="pr-edit">
            <h4>Bonus and deductions this month</h4>
            {adding ? (
              <div className="pr-addrow">
                <div className="ar-choice two">{[['earning', 'Add to pay'], ['deduction', 'Take from pay']].map(([v, t]) => (
                  <button key={v} type="button" className={adding.type === v ? 'is-on' : ''} onClick={() => setAdding({ ...adding, type: v, label: '' })}><b>{t}</b></button>))}</div>
                <div className="ar-quick">{(adding.type === 'earning' ? EARN_PICKS : DED_PICKS).map((q) => <button key={q} type="button" className={adding.label === q ? 'is-on' : ''} onClick={() => setAdding({ ...adding, label: q })}>{q}</button>)}</div>
                <div className="ar-two">
                  <Input placeholder="What is it for" value={adding.label} maxLength={60} onChange={(e) => setAdding({ ...adding, label: e.target.value })} />
                  <InputNumber prefix="₹" min={0} placeholder="Amount" value={adding.amount} onChange={(v) => setAdding({ ...adding, amount: v })} style={{ width: '100%' }} onPressEnter={addLine} />
                </div>
                <Input placeholder="Note on the payslip (optional)" value={adding.note} maxLength={200} onChange={(e) => setAdding({ ...adding, note: e.target.value })} />
                <div className="pr-addact">
                  <button type="button" className="plv-btn" onClick={() => setAdding(null)}>Cancel</button>
                  <button type="button" className="plv-btn primary" disabled={saving || !adding.label.trim() || !(Number(adding.amount) > 0)} onClick={addLine}>Add</button>
                </div>
              </div>
            ) : <button type="button" className="plv-btn" onClick={() => setAdding({ type: 'earning', label: '', amount: null, note: '' })}><PlusOutlined /> Add bonus or deduction</button>}

            {(line.advances || []).length > 0 && (<>
              <h4>Advance recovery</h4>
              {line.advances.map((adv) => {
                const cur = recLines.find((r) => r.advance_id === adv.advance_id)?.amount || 0;
                const overridden = line.recoveries && line.recoveries[adv.advance_id] != null;
                return (
                  <div key={adv.advance_id} className="pr-adv">
                    <div><b>{inr0(adv.outstanding)} left</b><small>of {inr0(adv.amount)} given {dayjs(adv.given_on).format('D MMM YYYY')}{adv.reason ? ` · ${adv.reason}` : ''}</small></div>
                    <RecoveryInput value={cur} max={adv.outstanding} disabled={saving} onCommit={(v) => setRecovery(adv.advance_id, v)} />
                    {overridden ? <button type="button" className="ar-link" onClick={() => clearRecovery(adv.advance_id)}>Use plan</button>
                      : cur > 0 ? <button type="button" className="ar-link" onClick={() => setRecovery(adv.advance_id, 0)}>Skip this month</button> : null}
                  </div>
                );
              })}
            </>)}

            <label className="pr-hold"><Switch size="small" checked={line.hold} disabled={saving} onChange={(v) => save({ hold: v })} />
              <span><b>Hold this salary</b><small>Stays in the month, but is left out of Pay salaries until you release it.</small></span></label>
          </section>
        )}

        {final && payments.length > 0 && (<>
          <h4>Payments</h4>
          <ul className="pr-pays">
            {payments.map((p) => (
              <li key={p.payment_id} className={p.voided_at ? 'is-void' : ''}>
                <span>{dayjs(p.paid_on).format('D MMM YYYY')}</span><span>{p.payment_mode}{p.reference ? ` · ${p.reference}` : ''}</span><b>{inr0(p.amount)}</b>
                {p.voided_at ? <em>Cancelled</em> : <button type="button" className="ar-link danger" onClick={() => voidPayment(p)}>Cancel</button>}
              </li>
            ))}
          </ul>
        </>)}
        {(s.bank?.account || s.ids?.pan || s.ids?.uan) && (
          <p className="pr-ids">{[s.bank?.account && `A/c ••••${String(s.bank.account).slice(-4)}${s.bank.ifsc ? ` · ${s.bank.ifsc}` : ''}`, s.ids?.pan && `PAN ${s.ids.pan}`, s.ids?.uan && `UAN ${s.ids.uan}`].filter(Boolean).join('  ·  ')}</p>
        )}
      </div>
    </Drawer>
  );
}
