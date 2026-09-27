import React, { useEffect, useMemo, useState } from 'react';
import { Switch, InputNumber, Select, DatePicker, Input, message } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { payrollAPI } from '../../../api';
import { inr0, errText } from './shared';

const BASIS = [
  ['calendar', 'Days in the month', 'Salary ÷ 28 to 31. The most common way.'],
  ['30', 'Always 30 days', 'Salary ÷ 30, whatever the month.'],
  ['26', 'Always 26 days', 'Salary ÷ 26. Weekly offs are not counted.'],
  ['working', 'Working days only', 'Days in the month minus weekly offs and holidays.'],
];

function Row({ title, sub, on, onToggle, children }) {
  return (
    <div className={`pr-rule${on === false ? ' is-off' : ''}`}>
      <div className="pr-rule-h"><div><b>{title}</b>{sub && <small>{sub}</small>}</div>{onToggle && <Switch checked={!!on} onChange={onToggle} />}</div>
      {children && (on !== false) && <div className="pr-rule-b">{children}</div>}
    </div>
  );
}

export default function Rules({ settings, meta, onSaved }) {
  const [s, setS] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [newHol, setNewHol] = useState({ date: null, name: '' });
  useEffect(() => { setS(settings); }, [settings]);
  const dirty = useMemo(() => JSON.stringify(s) !== JSON.stringify(settings), [s, settings]);
  const set = (patch) => setS((x) => ({ ...x, ...patch }));
  const sub = (k, patch) => setS((x) => ({ ...x, [k]: { ...x[k], ...patch } }));

  // A worked example, so the owner sees what the basis means in rupees.
  const example = useMemo(() => {
    const D = dayjs().daysInMonth();
    const basis = s.day_basis === '30' ? 30 : s.day_basis === '26' ? 26 : s.day_basis === 'working' ? D - 4 : D;
    return `With a ${inr0(15000)} salary, one day absent this month cuts ${inr0(15000 / basis)}, so pay is ${inr0(15000 - 15000 / basis)}.`;
  }, [s.day_basis]);

  const save = async () => {
    setSaving(true);
    try { const { data } = await payrollAPI.saveSettings(s); onSaved(data.settings); message.success('Payroll rules saved. Draft months update right away.'); }
    catch (e) { message.error(errText(e, 'Could not save')); } finally { setSaving(false); }
  };
  const presets = meta.pt_presets || {};
  const holidays = [...(s.holidays || [])].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="pr-rules">
      <section className="plv-table-card pr-card">
        <div className="pr-card-h"><b>How a day's pay is worked out</b><small>For monthly salaries: what one day is worth when someone is absent or joins mid-month.</small></div>
        <div className="ar-choice pr-basis">{BASIS.map(([v, t, d]) => (
          <button key={v} type="button" className={s.day_basis === v ? 'is-on' : ''} onClick={() => set({ day_basis: v })}><b>{t}</b><span>{d}</span></button>))}</div>
        <p className="pr-example">{example}</p>
        <Row title="Pay daily-wage staff for the weekly off" sub="Off: daily-wage staff are paid only for days they work." on={s.paid_weekly_off} onToggle={(v) => set({ paid_weekly_off: v })} />
        <Row title="A check-in the shop could not verify counts as" sub="For example a phone that was not on the shop Wi-Fi and was never confirmed.">
          <Select value={s.unverified_as} onChange={(v) => set({ unverified_as: v })} style={{ width: 220 }} popupClassName="ar-pop"
            options={[{ value: 'absent', label: 'Absent (safer)' }, { value: 'present', label: 'Present' }]} />
        </Row>
      </section>

      <section className="plv-table-card pr-card">
        <div className="pr-card-h"><b>Holidays</b><small>Paid days off. Nobody is marked absent on a holiday.</small></div>
        {holidays.length > 0 && (
          <ul className="pr-hols">{holidays.map((h) => (
            <li key={h.date}><span>{dayjs(h.date).format('ddd, D MMM YYYY')}</span><b>{h.name}</b>
              <button type="button" className="pr-x" aria-label="Remove" onClick={() => set({ holidays: s.holidays.filter((x) => x.date !== h.date) })}><DeleteOutlined /></button></li>))}</ul>
        )}
        <div className="pr-holadd">
          <DatePicker value={newHol.date} onChange={(d) => setNewHol({ ...newHol, date: d })} format="D MMM YYYY" placeholder="Date" />
          <Input value={newHol.name} placeholder="e.g. Diwali" maxLength={40} onChange={(e) => setNewHol({ ...newHol, name: e.target.value })} />
          <button type="button" className="plv-btn" disabled={!newHol.date} onClick={() => {
            const date = newHol.date.format('YYYY-MM-DD');
            set({ holidays: [...(s.holidays || []).filter((x) => x.date !== date), { date, name: newHol.name.trim() || 'Holiday' }] });
            setNewHol({ date: null, name: '' });
          }}><PlusOutlined /> Add holiday</button>
        </div>
      </section>

      <section className="plv-table-card pr-card">
        <div className="pr-card-h"><b>Attendance rules</b><small>Optional. Everything here is off until you switch it on.</small></div>
        <Row title="Half day" sub="A day with too few hours counts as half a day's pay." on={s.half_day.enabled} onToggle={(v) => sub('half_day', { enabled: v })}>
          <span className="pr-inline">Worked less than <InputNumber min={1} max={12} value={s.half_day.below_hours} onChange={(v) => sub('half_day', { below_hours: v })} style={{ width: 80 }} /> hours</span>
        </Row>
        <Row title="Late marks" sub="Repeated late coming costs pay." on={s.late_penalty.enabled} onToggle={(v) => sub('late_penalty', { enabled: v })}>
          <span className="pr-inline">Every <InputNumber min={1} max={31} value={s.late_penalty.every} onChange={(v) => sub('late_penalty', { every: v })} style={{ width: 70 }} /> late marks cut
            <Select value={s.late_penalty.deduct_days} onChange={(v) => sub('late_penalty', { deduct_days: v })} style={{ width: 130 }} popupClassName="ar-pop"
              options={[{ value: 0.5, label: 'half a day' }, { value: 1, label: 'one day' }]} /></span>
        </Row>
        <Row title="Overtime" sub="Hours beyond the shift, for monthly and daily staff." on={s.overtime.enabled} onToggle={(v) => sub('overtime', { enabled: v })}>
          <span className="pr-inline">Paid at <Select value={s.overtime.multiplier} onChange={(v) => sub('overtime', { multiplier: v })} style={{ width: 150 }} popupClassName="ar-pop"
            options={[{ value: 1, label: 'normal rate' }, { value: 1.5, label: '1.5 × rate' }, { value: 2, label: '2 × rate (legal)' }]} />
            when at least <InputNumber min={0} max={240} step={15} value={s.overtime.min_minutes} onChange={(v) => sub('overtime', { min_minutes: v })} style={{ width: 80 }} /> min extra</span>
        </Row>
      </section>

      <section className="plv-table-card pr-card">
        <div className="pr-card-h"><b>Statutory deductions</b><small>Switch on what applies to your shop, then tick it on each person's salary. Check rates with your accountant.</small></div>
        <Row title="Provident Fund (PF)" sub="On the Basic part of salary (the PF-ticked parts)." on={s.pf.enabled} onToggle={(v) => sub('pf', { enabled: v })}>
          <span className="pr-inline">Employee <InputNumber min={0} max={20} step={0.5} value={s.pf.employee_rate} onChange={(v) => sub('pf', { employee_rate: v })} addonAfter="%" style={{ width: 110 }} />
            Employer <InputNumber min={0} max={20} step={0.5} value={s.pf.employer_rate} onChange={(v) => sub('pf', { employer_rate: v })} addonAfter="%" style={{ width: 110 }} /></span>
          <span className="pr-inline"><Switch size="small" checked={s.pf.cap} onChange={(v) => sub('pf', { cap: v })} /> Limit the PF wage to <InputNumber prefix="₹" min={0} value={s.pf.wage_ceiling} onChange={(v) => sub('pf', { wage_ceiling: v })} style={{ width: 130 }} disabled={!s.pf.cap} /></span>
        </Row>
        <Row title="ESI" sub="For staff earning up to the limit." on={s.esi.enabled} onToggle={(v) => sub('esi', { enabled: v })}>
          <span className="pr-inline">Employee <InputNumber min={0} max={10} step={0.25} value={s.esi.employee_rate} onChange={(v) => sub('esi', { employee_rate: v })} addonAfter="%" style={{ width: 110 }} />
            Employer <InputNumber min={0} max={10} step={0.25} value={s.esi.employer_rate} onChange={(v) => sub('esi', { employer_rate: v })} addonAfter="%" style={{ width: 110 }} />
            Up to <InputNumber prefix="₹" min={0} value={s.esi.gross_limit} onChange={(v) => sub('esi', { gross_limit: v })} style={{ width: 130 }} /> a month</span>
        </Row>
        <Row title="Professional Tax" sub="By state, on monthly gross pay." on={s.pt.enabled} onToggle={(v) => sub('pt', { enabled: v })}>
          <span className="pr-inline">State <Select value={s.pt.state} style={{ width: 200 }} popupClassName="ar-pop" onChange={(v) => sub('pt', { state: v, slabs: presets[v]?.slabs || s.pt.slabs })}
            options={Object.entries(presets).map(([k, p]) => ({ value: k, label: p.label }))} /></span>
          <table className="pr-slabs"><thead><tr><th>Gross pay up to</th><th>Tax a month</th><th>In February</th><th /></tr></thead>
            <tbody>{s.pt.slabs.map((sl, i) => (
              <tr key={i}>
                <td>{sl.upto == null ? <span className="pr-muted">and above</span> : <InputNumber prefix="₹" min={0} value={sl.upto} onChange={(v) => sub('pt', { slabs: s.pt.slabs.map((x, j) => (j === i ? { ...x, upto: v } : x)), state: 'custom' })} style={{ width: 130 }} />}</td>
                <td><InputNumber prefix="₹" min={0} value={sl.amount} onChange={(v) => sub('pt', { slabs: s.pt.slabs.map((x, j) => (j === i ? { ...x, amount: v } : x)), state: 'custom' })} style={{ width: 110 }} /></td>
                <td><InputNumber prefix="₹" min={0} value={sl.feb} placeholder="same" onChange={(v) => sub('pt', { slabs: s.pt.slabs.map((x, j) => (j === i ? { ...x, feb: v } : x)), state: 'custom' })} style={{ width: 110 }} /></td>
                <td>{sl.upto != null && <button type="button" className="pr-x" aria-label="Remove" onClick={() => sub('pt', { slabs: s.pt.slabs.filter((_, j) => j !== i), state: 'custom' })}><DeleteOutlined /></button>}</td>
              </tr>))}</tbody></table>
          <button type="button" className="ar-link" onClick={() => {
            const fixed = s.pt.slabs.filter((x) => x.upto != null); const top = s.pt.slabs.find((x) => x.upto == null) || { upto: null, amount: 0 };
            sub('pt', { slabs: [...fixed, { upto: (fixed[fixed.length - 1]?.upto || 0) + 5000, amount: 0 }, top], state: 'custom' });
          }}><PlusOutlined /> Add slab</button>
        </Row>
      </section>

      <section className="plv-table-card pr-card">
        <div className="pr-card-h"><b>Accounts and staff app</b></div>
        <Row title="Post salaries to accounts" sub="Finalizing books Salaries & Wages against Salary Payable; paying clears it from Cash or Bank. Advances go to Staff Advances." on={s.post_to_accounts} onToggle={(v) => set({ post_to_accounts: v })} />
        <Row title="Round net pay to the rupee" on={s.rounding === 'rupee'} onToggle={(v) => set({ rounding: v ? 'rupee' : 'none' })} />
        <Row title="Staff can see their payslips in the staff app" sub="Finalized months appear on their phone at staff.zehenapp.com. Nothing shows before you finalize." on={s.staff_see_payslips} onToggle={(v) => set({ staff_see_payslips: v })} />
      </section>

      <div className={`pr-savebar${dirty ? ' is-dirty' : ''}`}>
        <span>{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
        <button type="button" className="plv-btn" disabled={!dirty || saving} onClick={() => setS(settings)}>Discard</button>
        <button type="button" className="plv-btn primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save rules'}</button>
      </div>
    </div>
  );
}
