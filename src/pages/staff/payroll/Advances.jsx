import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Input, InputNumber, Select, message } from 'antd';
import { PlusOutlined, WalletOutlined, MoreOutlined } from '@ant-design/icons';
import { Dropdown } from 'antd';
import dayjs from 'dayjs';
import { payrollAPI, bankAPI } from '../../../api';
import { inr0, cap, initials, errText } from './shared';

/*
 * Salary advances: money given ahead of pay, recovered from payslips. The
 * installment is a plan; each month's payslip can still skip or change it.
 */
export default function Advances({ staff }) {
  const [rows, setRows] = useState(null);
  const [giving, setGiving] = useState(null);
  const [banks, setBanks] = useState([]);
  const [showClosed, setShowClosed] = useState(false);
  const [modal, modalCtx] = Modal.useModal();

  const load = useCallback(async () => {
    try { const { data } = await payrollAPI.advances(); setRows(data || []); } catch (e) { message.error(errText(e, 'Could not load advances')); setRows([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { bankAPI.list({ include_inactive: false }).then(({ data }) => setBanks(data?.banks || [])).catch(() => {}); }, []);

  const nameOf = useMemo(() => new Map(staff.map((s) => [s.staff_id, s.name])), [staff]);
  const open = (rows || []).filter((r) => r.outstanding > 0);
  const closed = (rows || []).filter((r) => r.outstanding <= 0);
  const outstanding = open.reduce((t, r) => t + r.outstanding, 0);

  const give = async () => {
    try {
      await payrollAPI.giveAdvance({ ...giving, bank_ledger_id: giving.payment_mode === 'Bank' ? giving.bank_ledger_id : null });
      message.success(`Advance of ${inr0(giving.amount)} recorded.`); setGiving(null); load();
    } catch (e) { message.error(errText(e, 'Could not record the advance')); }
  };
  const changePlan = (r) => {
    let v = r.installment;
    modal.confirm({
      rootClassName: 'ar-pop', title: `Recovery plan for ${cap(nameOf.get(r.staff_id))}`, icon: null,
      content: <div className="ar-form"><div className="ar-field"><label>Recover each month <em>0 = all in the next salary</em></label>
        <InputNumber prefix="₹" min={0} defaultValue={r.installment} onChange={(x) => { v = x; }} style={{ width: '100%' }} /></div></div>,
      okText: 'Save',
      onOk: async () => { try { await payrollAPI.updateAdvance(r.advance_id, { installment: v || 0 }); load(); } catch (e) { message.error(errText(e, 'Could not save')); throw e; } },
    });
  };
  const cancel = (r) => {
    let reason = '';
    modal.confirm({
      rootClassName: 'ar-pop', title: `Cancel this ${inr0(r.amount)} advance?`,
      content: <div className="ar-form"><p className="ar-hint">Only possible while nothing has been recovered. The accounting entry is reversed.</p>
        <Input.TextArea rows={2} placeholder="Reason" onChange={(e) => { reason = e.target.value; }} /></div>,
      okText: 'Cancel advance', okButtonProps: { danger: true },
      onOk: async () => { try { await payrollAPI.voidAdvance(r.advance_id, reason); message.success('Advance cancelled.'); load(); } catch (e) { message.error(errText(e, 'Could not cancel')); throw e; } },
    });
  };
  const list = showClosed ? [...open, ...closed] : open;
  const active = staff.filter((s) => s.is_active);

  return (
    <>
      {modalCtx}
      <div className="pr-toolbar">
        <div className="ar-tbar-l"><span className="pr-muted">{open.length ? <><b>{inr0(outstanding)}</b> still to recover from {new Set(open.map((r) => r.staff_id)).size} staff</> : 'No advances waiting to be recovered.'}</span></div>
        <div className="plv-actions">
          <button type="button" className="plv-btn primary" disabled={!active.length} onClick={() => setGiving({ staff_id: active[0]?.staff_id, given_on: dayjs().format('YYYY-MM-DD'), amount: null, installment: null, payment_mode: 'Cash', bank_ledger_id: banks[0]?.ledger_id, reason: '' })}>
            <PlusOutlined /> Give advance</button>
        </div>
      </div>
      <section className="plv-table-card ar-tablecard">
        <div className="ar-tbar">
          <div className="ar-tbar-l"><b>Advances</b><span className="ar-count">{open.length} open</span></div>
          {closed.length > 0 && <button type="button" className="ar-link" onClick={() => setShowClosed((v) => !v)}>{showClosed ? 'Hide' : 'Show'} {closed.length} fully recovered</button>}
        </div>
        <div className="plv-table-scroll">
          <table className="plv-table ar-table pr-table">
            <colgroup><col className="c-staff" /><col className="c-since" /><col className="c-amt" /><col className="c-amt" /><col className="c-net" /><col className="c-plan" /><col /><col className="c-act" /></colgroup>
            <thead><tr><th>Staff</th><th>Given on</th><th className="r">Amount</th><th className="r">Recovered</th><th className="r">Left</th><th className="r">Each month</th><th>Reason</th><th /></tr></thead>
            <tbody>
              {rows === null ? <tr><td colSpan={8}><div className="plv-empty">Loading…</div></td></tr> : !list.length ? (
                <tr><td colSpan={8}><div className="plv-empty ar-empty"><WalletOutlined className="icon" /><div>No open advances</div>
                  <div className="sub">When you give staff money ahead of salary, record it here. It comes off their next payslips automatically.</div></div></td></tr>
              ) : list.map((r) => (
                <tr key={r.advance_id} className={r.outstanding <= 0 ? 'is-hold' : ''}>
                  <td><div className="plv-party-inline"><span className="plv-avatar ar-av">{initials(nameOf.get(r.staff_id))}</span>
                    <div className="plv-party-nm"><div className="main"><span className="txt">{cap(nameOf.get(r.staff_id) || `Staff #${r.staff_id}`)}</span></div><div className="sub">{r.payment_mode}</div></div></div></td>
                  <td>{dayjs(r.given_on).format('D MMM YYYY')}</td>
                  <td className="r ar-num">{inr0(r.amount)}</td>
                  <td className="r ar-num">{r.recovered ? inr0(r.recovered) : <span className="ar-dash">—</span>}</td>
                  <td className="r ar-num pr-net">{r.outstanding > 0 ? inr0(r.outstanding) : <span className="plv-status-tag ar-tag tone-ok">Recovered</span>}
                    {r.outstanding > 0 && <div className="pr-minibar"><i style={{ width: `${Math.min(100, (r.recovered / r.amount) * 100)}%` }} /></div>}</td>
                  <td className="r ar-num">{r.installment > 0 ? inr0(r.installment) : 'All at once'}</td>
                  <td className="pr-reason">{r.reason || <span className="ar-dash">—</span>}</td>
                  <td className="ar-actcell">{r.outstanding > 0 && (
                    <Dropdown trigger={['click']} placement="bottomRight" overlayClassName="ar-menu" menu={{ items: [
                      { key: 'plan', label: 'Change monthly recovery', onClick: () => changePlan(r) },
                      { key: 'cancel', danger: true, label: 'Cancel advance', disabled: r.recovered > 0, onClick: () => cancel(r) },
                    ] }}><button type="button" className="ar-more" aria-label="More"><MoreOutlined /></button></Dropdown>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Modal rootClassName="ar-pop" open={!!giving} onCancel={() => setGiving(null)} width={500} destroyOnHidden okText={giving?.amount ? `Give ${inr0(giving.amount)}` : 'Give advance'} onOk={give}
        okButtonProps={{ disabled: !giving || !(Number(giving.amount) > 0) || !giving.staff_id || (giving.payment_mode === 'Bank' && !giving.bank_ledger_id) }}
        title={<div className="ar-mtitle">Give advance<small>Recovered from salary, a fixed amount each month or all at once.</small></div>}>
        {giving && (
          <div className="ar-form">
            <div className="ar-field"><label>Staff</label><Select value={giving.staff_id} onChange={(v) => setGiving({ ...giving, staff_id: v })} popupClassName="ar-pop"
              options={active.map((s) => ({ value: s.staff_id, label: cap(s.name) }))} showSearch optionFilterProp="label" /></div>
            <div className="ar-two">
              <div className="ar-field"><label>Amount</label><InputNumber size="large" prefix="₹" min={1} value={giving.amount} onChange={(v) => setGiving({ ...giving, amount: v })} style={{ width: '100%' }} autoFocus /></div>
              <div className="ar-field"><label>Date</label><Input size="large" type="date" value={giving.given_on} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setGiving({ ...giving, given_on: e.target.value })} /></div>
            </div>
            <div className="ar-field"><label>Recover each month <em>leave empty to recover all from the next salary</em></label>
              <InputNumber prefix="₹" min={0} value={giving.installment} onChange={(v) => setGiving({ ...giving, installment: v })} style={{ width: '100%' }} />
              {Number(giving.amount) > 0 && Number(giving.installment) > 0 && <span className="ar-hint">About {Math.ceil(giving.amount / giving.installment)} months to recover.</span>}</div>
            <div className="ar-field"><label>Given from</label>
              <div className="ar-choice two">{[['Cash', 'Cash'], ['Bank', 'Bank']].map(([v, t]) => <button key={v} type="button" className={giving.payment_mode === v ? 'is-on' : ''} onClick={() => setGiving({ ...giving, payment_mode: v })}><b>{t}</b></button>)}</div>
              {giving.payment_mode === 'Bank' && <Select value={giving.bank_ledger_id} onChange={(v) => setGiving({ ...giving, bank_ledger_id: v })} placeholder="Bank account" popupClassName="ar-pop"
                options={banks.map((b) => ({ value: b.ledger_id, label: b.ledger_name || b.bank_name }))} />}</div>
            <div className="ar-field"><label>Reason <em>optional</em></label><Input maxLength={200} value={giving.reason} placeholder="e.g. Medical, festival" onChange={(e) => setGiving({ ...giving, reason: e.target.value })} /></div>
          </div>
        )}
      </Modal>
    </>
  );
}
