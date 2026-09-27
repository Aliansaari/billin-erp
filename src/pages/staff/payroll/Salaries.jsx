import React, { useEffect, useMemo, useState } from 'react';
import { Drawer, Input, InputNumber, Select, Checkbox, Switch, DatePicker, message, Modal, Tooltip } from 'antd';
import { CloseOutlined, PlusOutlined, DeleteOutlined, TeamOutlined, EditOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import StaffAvatar from '../StaffAvatar';
import { payrollAPI, staffAttendanceAPI } from '../../../api';
import { inr0, cap, initials, errText, PAY_TYPES, cycleText } from './shared';

const CALC = [{ value: 'percent', label: '% of salary' }, { value: 'fixed', label: 'Fixed ₹' }, { value: 'balance', label: 'Rest of salary' }];

/** Split preview, same rule as the server (percent/fixed first, "rest" takes what is left). */
function preview(total, comps) {
  let used = 0; const out = comps.map((c) => {
    if (c.calc === 'balance') return null;
    const v = c.calc === 'fixed' ? Number(c.value) || 0 : (total * (Number(c.value) || 0)) / 100; used += v; return v;
  });
  return out.map((v) => (v == null ? Math.max(0, total - used) : v));
}

export default function Salaries({ staff, structures, settings, meta, reload, onGoTab }) {
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const people = useMemo(() => staff
    .filter((s) => s.is_active || structures[s.staff_id]?.length)
    .filter((s) => !search || s.name.toLowerCase().includes(search.toLowerCase()))
    .map((s) => ({ ...s, hist: structures[s.staff_id] || [] }))
    .sort((a, b) => (a.hist.length ? 1 : 0) - (b.hist.length ? 1 : 0) || a.name.localeCompare(b.name)), [staff, structures, search]);
  const current = (hist) => [...hist].reverse().find((h) => h.effective_from <= dayjs().format('YYYY-MM-DD')) || hist[hist.length - 1];
  const extras = (st) => {
    const d = st?.details || {}; const out = [];
    if (d.pay_by === 'settle') out.push(`Settle up · ${cycleText(d.cycle_day)}`);
    if (d.components?.length) out.push('Breakup');
    if (d.statutory?.pf) out.push('PF'); if (d.statutory?.esi) out.push('ESI'); if (d.statutory?.pt) out.push('PT');
    if (d.tds_monthly) out.push('TDS'); if (d.commission?.enabled) out.push(`${d.commission.percent}% commission`);
    return out;
  };
  const monthly = people.reduce((t, s) => { const c = s.hist.length ? current(s.hist) : null; return t + (c?.pay_type === 'monthly' && s.is_active ? c.amount : 0); }, 0);

  return (
    <>
      <section className="plv-table-card ar-tablecard">
        <div className="ar-tbar">
          <div className="ar-tbar-l"><b>Salaries</b><span className="ar-count">{people.filter((p) => p.hist.length).length} set</span>
            {monthly > 0 && <span className="pr-muted">{inr0(monthly)} a month in fixed salaries</span>}</div>
          <div className="plv-search ar-search"><SearchOutlined /><input placeholder="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        </div>
        <div className="plv-table-scroll">
          <table className="plv-table ar-table pr-table pr-saltable">
            <colgroup><col className="c-staff" /><col className="c-type" /><col className="c-amt2" /><col className="c-since" /><col /><col className="c-act2" /></colgroup>
            <thead><tr><th>Staff</th><th>Pay</th><th className="r">Salary</th><th>Since</th><th>Also</th><th /></tr></thead>
            <tbody>
              {!people.length ? (
                <tr><td colSpan={6}><div className="plv-empty ar-empty"><TeamOutlined className="icon" /><div>No staff yet</div><div className="sub">Add staff in Staff & Rules first.</div></div></td></tr>
              ) : people.map((s) => {
                const c = s.hist.length ? current(s.hist) : null; const upcoming = s.hist.find((h) => h.effective_from > dayjs().format('YYYY-MM-DD'));
                return (
                  <tr key={s.staff_id} className="row" onClick={() => setEditing(s)}>
                    <td><div className="plv-party-inline"><StaffAvatar name={s.name} photo={s.photo_thumb} />
                      <div className="plv-party-nm"><div className="main"><span className="txt">{cap(s.name)}</span>{!s.is_active && <span className="plv-status-tag ar-tag tone-idle">Left</span>}</div>
                        <div className="sub">{s.designation || (s.joined_on ? `Joined ${dayjs(s.joined_on).format('D MMM YYYY')}` : 'Staff')}</div></div></div></td>
                    <td>{c ? PAY_TYPES[c.pay_type]?.label : <span className="ar-dash">Not set</span>}</td>
                    <td className="r ar-num">{c ? <><b>{inr0(c.amount)}</b><span className="pr-of"> {PAY_TYPES[c.pay_type]?.unit}</span></> : <span className="ar-dash">—</span>}
                      {upcoming && <div className="ar-cellsub tx-ok">{inr0(upcoming.amount)} from {dayjs(upcoming.effective_from).format('D MMM')}</div>}</td>
                    <td>{c ? dayjs(c.effective_from).format('D MMM YYYY') : <span className="ar-dash">—</span>}</td>
                    <td>{c ? <div className="pr-badges">{extras(c).map((x) => <span key={x}>{x}</span>)}</div> : null}</td>
                    <td className="ar-actcell" onClick={(e) => e.stopPropagation()}>
                      {c ? <button type="button" className="ar-more" aria-label="Edit salary" onClick={() => setEditing(s)}><EditOutlined /></button>
                        : <button type="button" className="plv-btn pr-setbtn" onClick={() => setEditing(s)}>Set salary</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <SalaryDrawer person={editing} settings={settings} meta={meta} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} onGoTab={onGoTab} />
    </>
  );
}

function SalaryDrawer({ person, settings, meta, onClose, onSaved, onGoTab }) {
  const [f, setF] = useState(null);
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);

  const [modal, modalCtx] = Modal.useModal();
  useEffect(() => {
    if (!person) { setF(null); return; }
    const hist = person.hist || [];
    const last = hist[hist.length - 1];
    const d = last?.details || {};
    const start = last ? dayjs().startOf('month') : dayjs(person.joined_on || undefined).isValid() && person.joined_on ? dayjs(person.joined_on) : dayjs().startOf('month');
    setF({
      pay_type: last?.pay_type || 'monthly', amount: last?.amount ?? null, effective_from: start,
      pay_by: d.pay_by === 'settle' ? 'settle' : 'run', cycle_day: Number(d.cycle_day) || 1,
      breakup: !!d.components?.length, components: d.components?.length ? d.components : meta.standard_components,
      statutory: { pf: !!d.statutory?.pf, esi: !!d.statutory?.esi, pt: !!d.statutory?.pt },
      overtime: d.overtime !== false, commission: { enabled: !!d.commission?.enabled, percent: d.commission?.percent ?? 1 },
      tds_monthly: d.tds_monthly || 0, bank: { holder: '', account: '', ifsc: '', bank: '', ...(d.bank || {}) }, pan: d.pan || '', uan: d.uan || '', esic: d.esic || '',
      designation: person.designation || '', joined_on: person.joined_on ? dayjs(person.joined_on) : null, left_on: person.left_on ? dayjs(person.left_on) : null,
    });
    setMore(!!(d.components?.length || d.statutory?.pf || d.statutory?.esi || d.statutory?.pt || d.tds_monthly || d.commission?.enabled || d.bank?.account));
  }, [person, meta.standard_components]);

  if (!person || !f) return <Drawer rootClassName="ar-pop" open={!!person} onClose={onClose} width={560} />;
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const hist = person.hist || [];
  const sameDay = hist.find((h) => h.effective_from === f.effective_from?.format('YYYY-MM-DD'));
  const amounts = f.breakup ? preview(Number(f.amount) || 0, f.components) : [];
  const breakupOver = f.breakup && f.components.filter((c) => c.calc !== 'balance').reduce((t, c, i) => t + (amounts[f.components.indexOf(c)] || 0), 0) > (Number(f.amount) || 0) + 0.5;
  const statOn = { pf: settings?.pf?.enabled, esi: settings?.esi?.enabled, pt: settings?.pt?.enabled };
  const valid = Number(f.amount) > 0 && f.effective_from && !breakupOver;

  const save = async () => {
    setSaving(true);
    try {
      const staffPatch = { designation: f.designation || null, joined_on: f.joined_on ? f.joined_on.format('YYYY-MM-DD') : null, left_on: f.left_on ? f.left_on.format('YYYY-MM-DD') : null };
      if (staffPatch.designation !== (person.designation || null) || staffPatch.joined_on !== (person.joined_on || null) || staffPatch.left_on !== (person.left_on || null)) {
        await staffAttendanceAPI.updateStaff(person.staff_id, staffPatch);
      }
      const details = {
        ...(f.breakup ? { components: f.components.map((c) => ({ name: String(c.name || '').trim() || 'Component', calc: c.calc, value: Number(c.value) || 0, pf: !!c.pf })) } : {}),
        statutory: f.statutory, overtime: f.overtime,
        ...(f.pay_by === 'settle' ? { pay_by: 'settle', cycle_day: Math.min(28, Math.max(1, Number(f.cycle_day) || 1)) } : {}),
        ...(f.commission.enabled ? { commission: { enabled: true, percent: Number(f.commission.percent) || 0 } } : {}),
        ...(Number(f.tds_monthly) ? { tds_monthly: Number(f.tds_monthly) } : {}),
        ...(Object.values(f.bank).some(Boolean) ? { bank: { ...f.bank, ifsc: String(f.bank.ifsc || '').toUpperCase() } } : {}),
        ...(f.pan ? { pan: String(f.pan).toUpperCase() } : {}), ...(f.uan ? { uan: f.uan } : {}), ...(f.esic ? { esic: f.esic } : {}),
      };
      await payrollAPI.saveStructure(person.staff_id, { pay_type: f.pay_type, amount: Number(f.amount), effective_from: f.effective_from.format('YYYY-MM-DD'), details });
      message.success(`Salary saved for ${cap(person.name)}.`);
      await onSaved();
    } catch (e) { message.error(errText(e, 'Could not save the salary')); } finally { setSaving(false); }
  };
  const removeRevision = (h) => modal.confirm({
    rootClassName: 'ar-pop', title: `Delete the salary from ${dayjs(h.effective_from).format('D MMM YYYY')}?`,
    content: 'Months not yet finalized will use the salary before it. Finalized months keep what they were finalized with.',
    okText: 'Delete', okButtonProps: { danger: true },
    onOk: async () => { try { await payrollAPI.deleteStructure(h.structure_id); await onSaved(); } catch (e) { message.error(errText(e, 'Could not delete')); throw e; } },
  });
  const setComp = (i, patch) => set({ components: f.components.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <Drawer rootClassName="ar-pop" open={!!person} onClose={onClose} width={560} closeIcon={null} destroyOnHidden
      title={(
        <div className="ar-dhead">
          <StaffAvatar name={person.name} photo={person.photo_thumb} size={40} />
          <div><b>{cap(person.name)}</b><small>{hist.length ? 'Change salary' : 'Set salary'}</small></div>
          <div className="ar-dnav"><button type="button" className="ar-dn-btn" aria-label="Close" onClick={onClose}><CloseOutlined /></button></div>
        </div>
      )}
      footer={(
        <div className="ar-dfoot pr-dfoot">
          <span className="pr-muted">{sameDay ? `Replaces the salary from ${dayjs(sameDay.effective_from).format('D MMM YYYY')}.` : hist.length ? 'Earlier months keep the old salary.' : ''}</span>
          <button type="button" className="plv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="plv-btn primary" disabled={!valid || saving} onClick={save}>{saving ? 'Saving…' : 'Save salary'}</button>
        </div>
      )}>
      {modalCtx}
      <div className="ar-form pr-salform">
        <div className="ar-field"><label>How is {cap(person.name).split(' ')[0]} paid?</label>
          <div className="ar-choice pr-three">{Object.entries(PAY_TYPES).map(([k, v]) => (
            <button key={k} type="button" className={f.pay_type === k ? 'is-on' : ''} onClick={() => set({ pay_type: k })}><b>{v.label}</b><span>{v.hint}</span></button>))}</div></div>
        <div className="ar-two">
          <div className="ar-field"><label>{f.pay_type === 'monthly' ? 'Salary' : f.pay_type === 'daily' ? 'Wage per day' : 'Rate per hour'}</label>
            <InputNumber size="large" prefix="₹" min={0} value={f.amount} onChange={(v) => set({ amount: v })} addonAfter={PAY_TYPES[f.pay_type].unit} style={{ width: '100%' }} autoFocus /></div>
          <div className="ar-field"><label>Starting from</label>
            <DatePicker size="large" value={f.effective_from} onChange={(d) => d && set({ effective_from: d })} allowClear={false} format="D MMM YYYY" style={{ width: '100%' }} /></div>
        </div>
        <div className="ar-field"><label>How is salary settled?</label>
          <div className="ar-choice two">
            <button type="button" className={f.pay_by === 'run' ? 'is-on' : ''} onClick={() => set({ pay_by: 'run' })}>
              <b>Monthly pay run</b><span>1st to month end, with everyone. PF, ESI and payslips.</span></button>
            <button type="button" className={f.pay_by === 'settle' ? 'is-on' : ''} onClick={() => set({ pay_by: 'settle' })}>
              <b>Own cycle, settle up</b><span>Give money any day; settle any dates in Staff accounts.</span></button>
          </div>
          {f.pay_by === 'settle' && (
            <span className="pr-inline pr-cycle">Cycle starts on day
              <InputNumber min={1} max={28} value={f.cycle_day} onChange={(v) => set({ cycle_day: v })} style={{ width: 72 }} />
              of each month ({cycleText(f.cycle_day)})
              {f.joined_on && <button type="button" className="ar-link" onClick={() => set({ cycle_day: Math.min(28, f.joined_on.date()) })}>Use joining day ({f.joined_on.date()})</button>}
            </span>
          )}
        </div>
        <div className="ar-three">
          <div className="ar-field"><label>Designation <em>optional</em></label><Input value={f.designation} maxLength={80} placeholder="e.g. Salesman" onChange={(e) => set({ designation: e.target.value })} /></div>
          <div className="ar-field"><label>Joined on</label><DatePicker value={f.joined_on} onChange={(d) => set({ joined_on: d })} format="D MMM YYYY" /></div>
          <div className="ar-field"><label>Left on <em>if leaving</em></label><DatePicker value={f.left_on} onChange={(d) => set({ left_on: d })} format="D MMM YYYY" /></div>
        </div>

        <button type="button" className="pr-more" onClick={() => setMore((v) => !v)} aria-expanded={more}>
          <RightOutlined rotate={more ? 90 : 0} /> <b>More</b><span>Salary breakup, PF / ESI / PT, TDS, commission, bank details</span>
        </button>

        {more && (<>
          <section className="pr-sec">
            <div className="pr-sec-h"><div><b>Salary breakup</b><small>Split into Basic, HRA and allowances. Needed for PF and formal payslips.</small></div>
              <Switch checked={f.breakup} onChange={(v) => set({ breakup: v })} /></div>
            {f.breakup && (
              <div className="pr-comps">
                {f.components.map((c, i) => (
                  <div key={i} className="pr-comp">
                    <Input value={c.name} placeholder="Name" onChange={(e) => setComp(i, { name: e.target.value })} />
                    <Select value={c.calc} options={CALC} onChange={(v) => setComp(i, { calc: v })} popupClassName="ar-pop" />
                    {c.calc === 'balance' ? <span className="pr-muted">Whatever is left</span>
                      : <InputNumber min={0} value={c.value} onChange={(v) => setComp(i, { value: v })} addonAfter={c.calc === 'percent' ? '%' : '₹'} style={{ width: '100%' }} />}
                    <span className="r ar-num">{inr0(amounts[i] || 0)}</span>
                    <Tooltip title="Counts towards the PF wage"><Checkbox checked={!!c.pf} onChange={(e) => setComp(i, { pf: e.target.checked })}>PF</Checkbox></Tooltip>
                    <button type="button" className="pr-x" aria-label="Remove" onClick={() => set({ components: f.components.filter((_, j) => j !== i) })}><DeleteOutlined /></button>
                  </div>
                ))}
                <div className="pr-comp-act">
                  <button type="button" className="ar-link" onClick={() => set({ components: [...f.components, { name: '', calc: 'fixed', value: 0, pf: false }] })}><PlusOutlined /> Add component</button>
                  <button type="button" className="ar-link" onClick={() => set({ components: meta.standard_components })}>Use standard (Basic 50%, HRA 20%, rest)</button>
                </div>
                {breakupOver && <p className="ar-hint tx-bad">The parts add up to more than the salary.</p>}
              </div>
            )}
          </section>

          <section className="pr-sec">
            <div className="pr-sec-h"><div><b>Statutory</b><small>Deducted only when also switched on in Rules.</small></div></div>
            <div className="pr-stat">
              {[['pf', 'Provident Fund (PF)'], ['esi', 'ESI'], ['pt', 'Professional Tax']].map(([k, label]) => (
                <Checkbox key={k} checked={f.statutory[k]} onChange={(e) => set({ statutory: { ...f.statutory, [k]: e.target.checked } })}>
                  {label}{!statOn[k] && <em className="pr-off"> off in Rules</em>}
                </Checkbox>
              ))}
            </div>
            {(!statOn.pf || !statOn.esi || !statOn.pt) && <p className="ar-hint">Rates and limits are set once for everyone in <button type="button" className="ar-link" onClick={() => { onClose(); onGoTab('rules'); }}>Rules</button>.</p>}
            <div className="ar-two">
              <div className="ar-field"><label>Income tax (TDS) a month <em>optional</em></label><InputNumber prefix="₹" min={0} value={f.tds_monthly} onChange={(v) => set({ tds_monthly: v })} style={{ width: '100%' }} /></div>
              <div className="ar-field"><label>Overtime</label><Checkbox checked={f.overtime} onChange={(e) => set({ overtime: e.target.checked })}>Paid overtime{!settings?.overtime?.enabled && <em className="pr-off"> off in Rules</em>}</Checkbox></div>
            </div>
          </section>

          <section className="pr-sec">
            <div className="pr-sec-h"><div><b>Sales commission</b><small>{person.salesman_id ? `On sales billed as ${person.salesman_name || 'their salesman'}, before GST.` : 'Link this person to a salesman in Staff & Rules first.'}</small></div>
              <Switch checked={f.commission.enabled} onChange={(v) => set({ commission: { ...f.commission, enabled: v } })} /></div>
            {f.commission.enabled && <InputNumber min={0} max={100} step={0.25} value={f.commission.percent} onChange={(v) => set({ commission: { ...f.commission, percent: v } })} addonAfter="% of sales" style={{ width: 200 }} />}
          </section>

          <section className="pr-sec">
            <div className="pr-sec-h"><div><b>Bank and IDs</b><small>Printed on the payslip and used for the bank transfer sheet.</small></div></div>
            <div className="ar-two">
              <div className="ar-field"><label>Account holder</label><Input value={f.bank.holder} onChange={(e) => set({ bank: { ...f.bank, holder: e.target.value } })} placeholder={cap(person.name)} /></div>
              <div className="ar-field"><label>Account number</label><Input value={f.bank.account} onChange={(e) => set({ bank: { ...f.bank, account: e.target.value.replace(/\s/g, '') } })} /></div>
              <div className="ar-field"><label>IFSC</label><Input value={f.bank.ifsc} maxLength={11} onChange={(e) => set({ bank: { ...f.bank, ifsc: e.target.value.toUpperCase() } })} /></div>
              <div className="ar-field"><label>Bank</label><Input value={f.bank.bank} onChange={(e) => set({ bank: { ...f.bank, bank: e.target.value } })} /></div>
            </div>
            <div className="ar-three">
              <div className="ar-field"><label>PAN</label><Input value={f.pan} maxLength={10} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} /></div>
              <div className="ar-field"><label>UAN (PF)</label><Input value={f.uan} maxLength={12} onChange={(e) => set({ uan: e.target.value })} /></div>
              <div className="ar-field"><label>ESIC no.</label><Input value={f.esic} maxLength={17} onChange={(e) => set({ esic: e.target.value })} /></div>
            </div>
          </section>
        </>)}

        {hist.length > 0 && (
          <section className="pr-sec">
            <div className="pr-sec-h"><div><b>Salary history</b></div></div>
            <ul className="pr-hist">
              {[...hist].reverse().map((h) => (
                <li key={h.structure_id}><span>From {dayjs(h.effective_from).format('D MMM YYYY')}</span><b>{inr0(h.amount)} <em>{PAY_TYPES[h.pay_type]?.unit}</em></b>
                  <button type="button" className="pr-x" aria-label="Delete" onClick={() => removeRevision(h)}><DeleteOutlined /></button></li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Drawer>
  );
}
