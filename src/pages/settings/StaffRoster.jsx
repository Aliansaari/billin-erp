import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Select, Dropdown, Modal, Input, message, Tooltip } from 'antd';
import {
  PlusOutlined, UsergroupAddOutlined, MoreOutlined, EditOutlined, KeyOutlined, MobileOutlined, SearchOutlined,
  CheckCircleFilled, CloseCircleFilled, CopyOutlined, TeamOutlined, StopOutlined, UndoOutlined, IdcardOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { staffAttendanceAPI, salesmanAPI } from '../../api';
import EntityFormModal from '../../components/EntityFormModal';
import StaffAvatar from '../staff/StaffAvatar';
import PhotoPicker from '../staff/PhotoPicker';
import { aadhaarDigits, aadhaarValid, formatAadhaar, maskAadhaar, cleanPan, panHint, PAN_RE } from '../staff/staffProfile';
import '../parties/party-list-view.css';
import '../staff/attendance-register.css';
import './staff-roster.css';

const { Section, Field } = EntityFormModal;

/*
 * The staff list and the staff form (Settings → Staff Attendance → Staff).
 * One status per person instead of a row of buttons; the next useful action
 * (usually "Set PIN") is the only button shown, everything else lives in ⋯.
 * The form carries the person's photo, identity numbers and contacts, and
 * whether their attendance is tracked.
 */
const EMPTY = {
  name: '', phone: '', designation: '', salesman_id: null, joined_on: '', left_on: '', notes: '', attendance_enabled: true,
  aadhaar: '', pan: '', address: '', emergency_name: '', emergency_phone: '', photo: null, photo_thumb: null,
};

function statusOf(r) {
  const st = r.cloud_status || {};
  if (!r.is_active) return { key: 'left', label: 'Left', tone: 'idle' };
  if (r.attendance_enabled === false) return { key: 'off', label: 'Not tracked', tone: 'idle', hint: 'Paid for every working day; no check-in needed.' };
  if (!r.has_pin) return { key: 'pin', label: 'Needs a PIN', tone: 'late', hint: 'Set a PIN so they can sign in on their phone.' };
  if (st.locked) return { key: 'locked', label: 'Locked', tone: 'bad', hint: 'Too many wrong PINs. Set a new PIN to unlock.' };
  if (st.phone_linked) return { key: 'ready', label: st.passkey ? 'Ready · Face ID' : 'Ready', tone: 'ok', hint: st.device_bound_at ? `Phone linked ${dayjs(st.device_bound_at).format('D MMM YYYY')}` : 'Phone linked' };
  return { key: 'waiting', label: 'Not signed in yet', tone: 'leave', hint: 'PIN set. They sign in once on their phone to link it.' };
}

export default function StaffRoster({ shopCode, staffUrl, refreshKey }) {
  const [staff, setStaff] = useState(null);
  const [salesmen, setSalesmen] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);   // null | {} (new) | row
  const [form, setForm] = useState(EMPTY);
  const [initial, setInitial] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [pinFor, setPinFor] = useState(null);
  const [pin, setPin] = useState('');
  const [modal, modalCtx] = Modal.useModal();

  const load = useCallback(async () => {
    try { const { data } = await staffAttendanceAPI.listStaff(); setStaff(Array.isArray(data) ? data : []); }
    catch (e) { message.error(e?.response?.data?.error || 'Could not load staff'); setStaff([]); }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => { salesmanAPI.getAll({ include_inactive: 'true' }).then(({ data }) => setSalesmen(Array.isArray(data) ? data : [])).catch(() => {}); }, []);

  const rows = staff || [];
  const counts = useMemo(() => {
    const c = { all: 0, pin: 0, waiting: 0, ready: 0, left: 0 };
    for (const r of rows) { const k = statusOf(r).key; if (r.is_active) c.all++; if (c[k] !== undefined) c[k]++; }
    return c;
  }, [rows]);
  const visible = rows.filter((r) => {
    const k = statusOf(r).key;
    if (filter === 'all' ? !r.is_active : filter !== k) return false;
    const q = search.trim().toLowerCase();
    return !q || r.name.toLowerCase().includes(q) || String(r.phone || '').includes(q) || String(r.designation || '').toLowerCase().includes(q);
  });

  // ── form ──
  const open = async (row) => {
    setErrors({});
    if (!row) { setEditing({}); setForm(EMPTY); setInitial(EMPTY); return; }
    setEditing(row);
    try {
      const { data: r } = await staffAttendanceAPI.getStaff(row.staff_id);
      const f = {
        name: r.name || '', phone: r.phone || '', designation: r.designation || '', salesman_id: r.salesman_id || null,
        joined_on: r.joined_on || '', left_on: r.left_on || '', notes: r.notes || '', attendance_enabled: r.attendance_enabled !== false,
        aadhaar: formatAadhaar(r.aadhaar || ''), pan: r.pan || '', address: r.address || '', emergency_name: r.emergency_name || '',
        emergency_phone: r.emergency_phone || '', photo: r.photo || null, photo_thumb: r.photo_thumb || null,
      };
      setForm(f); setInitial(f);
    } catch (e) { message.error(e?.response?.data?.error || 'Could not open this staff member'); setEditing(null); }
  };
  const close = () => { setEditing(null); setForm(EMPTY); };
  const set = (k) => (e) => {
    const v = e?.target ? e.target.value : e;
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((x) => { const n = { ...x }; delete n[k]; return n; });
  };

  const validate = () => {
    const er = {};
    if (!form.name.trim()) er.name = 'Name is required';
    if (String(form.phone).replace(/\D/g, '').length < 10) er.phone = 'Enter the 10-digit mobile number';
    if (form.aadhaar && !aadhaarValid(form.aadhaar)) er.aadhaar = aadhaarDigits(form.aadhaar).length < 12 ? 'Aadhaar has 12 digits' : 'This is not a valid Aadhaar number';
    if (form.pan && !PAN_RE.test(cleanPan(form.pan))) er.pan = 'PAN looks like ABCDE1234F';
    if (form.emergency_phone && String(form.emergency_phone).replace(/\D/g, '').length < 10) er.emergency_phone = 'Enter a 10-digit number';
    if (form.joined_on && form.left_on && form.left_on < form.joined_on) er.left_on = 'Before the joining date';
    setErrors(er);
    return !Object.keys(er).length;
  };
  const save = async (closeAfter = true) => {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
        ...form, joined_on: form.joined_on || null, left_on: form.left_on || null, salesman_id: form.salesman_id || null,
        aadhaar: aadhaarDigits(form.aadhaar) || null, pan: cleanPan(form.pan) || null,
        emergency_phone: form.emergency_phone || null,
        is_active: form.left_on && form.left_on < dayjs().format('YYYY-MM-DD') ? false : undefined,
      };
      if (editing?.staff_id) {
        await staffAttendanceAPI.updateStaff(editing.staff_id, payload);
        message.success(`Saved ${form.name.trim()}.`);
        if (closeAfter) close(); else setInitial(form);
      } else {
        const { data } = await staffAttendanceAPI.createStaff(payload);
        message.success(`${form.name.trim()} added. Now set their PIN.`);
        close();
        setPinFor({ staff_id: data.staff_id, name: form.name.trim(), phone: form.phone }); setPin('');
      }
      await load();
    } catch (e) { message.error(e?.response?.data?.error || 'Save failed'); } finally { setSaving(false); }
  };

  // ── actions ──
  const savePin = async () => {
    try {
      await staffAttendanceAPI.setPin(pinFor.staff_id, pin);
      message.success(`PIN set for ${pinFor.name}.`);
      setPinFor((p) => ({ ...p, done: true }));
      await load();
    } catch (e) { message.error(e?.response?.data?.error || 'Could not set the PIN'); }
  };
  const resetPhone = (r) => modal.confirm({
    rootClassName: 'ar-pop', title: `Reset ${r.name}'s phone?`, icon: <MobileOutlined />,
    content: 'Their current phone stops working for check-in. They sign in again on the new phone with their PIN.',
    okText: 'Reset phone', okButtonProps: { danger: true },
    onOk: async () => { try { await staffAttendanceAPI.resetDevice(r.staff_id); message.success(`${r.name} can now sign in on a new phone.`); await load(); } catch (e) { message.error(e?.response?.data?.error || 'Reset failed'); throw e; } },
  });
  const setActive = async (r, on) => {
    try { await staffAttendanceAPI.updateStaff(r.staff_id, { is_active: on }); await load(); } catch (e) { message.error(e?.response?.data?.error || 'Update failed'); }
  };
  const importSalesmen = async () => {
    try {
      const { data } = await staffAttendanceAPI.importSalesmen();
      if (data.added) message.success(`Added ${data.added} from Salesmen. Set a PIN for each.`);
      else message.info('Every active salesman is already on the staff list.');
      if (data.skipped?.length) message.warning(`Skipped (mobile number already used): ${data.skipped.join(', ')}`, 6);
      await load();
    } catch (e) { message.error(e?.response?.data?.error || 'Import failed'); }
  };
  const inviteText = (p) => `Hi ${String(p.name).split(' ')[0]}, check in for work from your phone:\n${staffUrl || 'staff.zehenapp.com/staff/'}\nMobile: ${p.phone || ''}\nPIN: ${pin}${shopCode ? `\nShop code: ${shopCode}` : ''}`;
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(inviteText(pinFor)); message.success('Copied. Paste it in a message to them.'); } catch { message.info(inviteText(pinFor)); }
  };
  const rowMenu = (r) => ({ items: [
    { key: 'edit', icon: <EditOutlined />, label: 'Edit details', onClick: () => open(r) },
    { key: 'pin', icon: <KeyOutlined />, label: r.has_pin ? 'Change PIN' : 'Set PIN', onClick: () => { setPinFor(r); setPin(''); } },
    { key: 'reset', icon: <MobileOutlined />, label: 'Reset phone', disabled: !r.cloud_status?.phone_linked, onClick: () => resetPhone(r) },
    { type: 'divider' },
    r.is_active
      ? { key: 'off', icon: <StopOutlined />, label: 'Mark as left', danger: true, onClick: () => setActive(r, false) }
      : { key: 'on', icon: <UndoOutlined />, label: 'Bring back', onClick: () => setActive(r, true) },
  ] });

  const aHint = form.aadhaar ? (aadhaarValid(form.aadhaar) ? { ok: true, text: 'Valid Aadhaar number' } : aadhaarDigits(form.aadhaar).length === 12 ? { ok: false, text: 'Not a valid Aadhaar number. Check the digits.' } : { ok: null, text: `${12 - aadhaarDigits(form.aadhaar).length} more digits` }) : null;
  const pHint = panHint(form.pan);
  const Hint = ({ h }) => (h ? <span className={`st-hint ${h.ok === true ? 'ok' : h.ok === false ? 'bad' : ''}`}>{h.ok === true && <CheckCircleFilled />}{h.ok === false && <CloseCircleFilled />}{h.text}</span> : null);
  const FILTERS = [['all', 'Active', counts.all], ['pin', 'Needs a PIN', counts.pin], ['waiting', 'Not signed in', counts.waiting], ['ready', 'Ready', counts.ready], ['left', 'Left', counts.left]];

  return (
    <div className="st-roster ar-pop">
      {modalCtx}
      <div className="st-bar">
        <div className="plv-chips">
          {FILTERS.filter(([k, , n]) => k === 'all' || n > 0).map(([k, label, n]) => (
            <button key={k} type="button" className={`plv-chip${filter === k ? ' on' : ''}${k === 'pin' && n ? ' alarm' : ''}`} onClick={() => setFilter(k)}>{label}<span className="count">{n}</span></button>
          ))}
        </div>
        <div className="st-bar-r">
          <div className="plv-search st-search"><SearchOutlined /><input placeholder="Search name, mobile, role" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <button type="button" className="plv-btn" onClick={importSalesmen}><UsergroupAddOutlined /> From Salesmen</button>
          <button type="button" className="plv-btn primary" onClick={() => open(null)}><PlusOutlined /> Add staff</button>
        </div>
      </div>

      <div className="plv-table-card st-card">
        <table className="plv-table ar-table st-table">
          <colgroup><col className="c-who" /><col className="c-id" /><col className="c-st" /><col className="c-act" /></colgroup>
          <thead><tr><th>Staff</th><th>ID on file</th><th>Check-in</th><th /></tr></thead>
          <tbody>
            {staff === null ? <tr><td colSpan={4}><div className="plv-empty">Loading…</div></td></tr> : !visible.length ? (
              <tr><td colSpan={4}><div className="plv-empty ar-empty"><TeamOutlined className="icon" />
                <div>{rows.length ? 'Nobody here' : 'No staff yet'}</div>
                <div className="sub">{rows.length ? <button type="button" className="ar-link" onClick={() => { setFilter('all'); setSearch(''); }}>Show everyone</button> : 'Add your staff, or bring in your salesmen in one click.'}</div></div></td></tr>
            ) : visible.map((r) => {
              const st = statusOf(r);
              return (
                <tr key={r.staff_id} className={`row${r.is_active ? '' : ' is-left'}`} onClick={() => open(r)}>
                  <td><div className="plv-party-inline"><StaffAvatar name={r.name} photo={r.photo_thumb} size={40} />
                    <div className="plv-party-nm"><div className="main"><span className="txt">{r.name}</span></div>
                      <div className="sub">{[r.designation, r.phone, r.joined_on && `since ${dayjs(r.joined_on).format('MMM YYYY')}`].filter(Boolean).join(' · ') || 'Staff'}</div></div></div></td>
                  <td>{r.has_aadhaar || r.pan ? (
                    <div className="st-ids">{r.has_aadhaar && <span><IdcardOutlined /> {maskAadhaar(r.aadhaar_last4)}</span>}{r.pan && <span>PAN {r.pan.slice(0, 2)}•••••{r.pan.slice(-3)}</span>}</div>
                  ) : <span className="ar-dash">Not added</span>}</td>
                  <td><Tooltip title={st.hint}><span className={`plv-status-tag ar-tag tone-${st.tone}`}>{st.label}</span></Tooltip></td>
                  <td className="ar-actcell st-act" onClick={(e) => e.stopPropagation()}>
                    {r.is_active && st.key === 'pin' && <button type="button" className="plv-btn st-mini" onClick={() => { setPinFor(r); setPin(''); }}><KeyOutlined /> Set PIN</button>}
                    {r.is_active && st.key === 'locked' && <button type="button" className="plv-btn st-mini" onClick={() => { setPinFor(r); setPin(''); }}><KeyOutlined /> New PIN</button>}
                    <Dropdown menu={rowMenu(r)} trigger={['click']} placement="bottomRight" overlayClassName="ar-menu">
                      <button type="button" className="ar-more" aria-label="More"><MoreOutlined /></button>
                    </Dropdown>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <EntityFormModal
        open={!!editing}
        onClose={close}
        title={editing?.staff_id ? 'Edit staff member' : 'Add staff member'}
        subtitle={editing?.staff_id ? editing.name : 'They sign in on their phone with this mobile number'}
        entityIcon="S"
        entityTone="info"
        dirty={JSON.stringify(form) !== JSON.stringify(initial)}
        saving={saving}
        onSave={() => save(false)}
        onSaveAndClose={() => save(true)}
        onReset={() => (editing?.staff_id ? open(editing) : setForm(EMPTY))}
        width={760}
      >
        <Section label="Profile" anchorKey={1}>
          <div className="st-profile efm-field full">
            <PhotoPicker name={form.name} value={{ photo: form.photo }} onChange={({ photo, thumb }) => setForm((f) => ({ ...f, photo, photo_thumb: thumb }))} />
            <div className="st-profile-fields">
              <Field label="Full name" required error={errors.name} span="full">
                <input className={`efm-input${errors.name ? ' has-error' : ''}`} value={form.name} onChange={set('name')} maxLength={100} autoFocus placeholder="As on their Aadhaar" />
              </Field>
              <Field label="Mobile number" required error={errors.phone} help="They sign in with this number.">
                <input className={`efm-input${errors.phone ? ' has-error' : ''}`} value={form.phone} onChange={set('phone')} maxLength={15} inputMode="tel" placeholder="98765 43210" />
              </Field>
              <Field label="Designation">
                <input className="efm-input" value={form.designation} onChange={set('designation')} maxLength={80} placeholder="e.g. Salesman, Cashier" />
              </Field>
            </div>
          </div>
        </Section>

        <Section label="Work" anchorKey={2}>
          <Field label="Joined on" help="No absences are counted before this date.">
            <input className="efm-input" type="date" value={form.joined_on} onChange={set('joined_on')} />
          </Field>
          <Field label="Left on" error={errors.left_on} help="Only if they have left. Pay stops after this date.">
            <input className={`efm-input${errors.left_on ? ' has-error' : ''}`} type="date" value={form.left_on} onChange={set('left_on')} />
          </Field>
          <Field label="Bills as salesman" span="full" help="Links their sales bills: the last bill of the day counts as proof they were in, and it drives sales commission.">
            <Select allowClear value={form.salesman_id || undefined} onChange={(v) => set('salesman_id')(v || null)} placeholder="Not linked" popupClassName="ar-pop"
              options={salesmen.map((s) => ({ value: s.salesman_id, label: s.name }))} style={{ width: '100%' }} className="efm-select-antd" showSearch optionFilterProp="label" />
          </Field>
        </Section>

        <Section label="Identity and contacts" anchorKey={3}>
          <Field label="Aadhaar number" error={errors.aadhaar}>
            <input className={`efm-input st-mono${errors.aadhaar ? ' has-error' : ''}`} value={form.aadhaar} onChange={(e) => set('aadhaar')(formatAadhaar(e.target.value))} inputMode="numeric" placeholder="XXXX XXXX XXXX" autoComplete="off" />
            {!errors.aadhaar && <Hint h={aHint} />}
          </Field>
          <Field label="PAN" error={errors.pan}>
            <input className={`efm-input st-mono${errors.pan ? ' has-error' : ''}`} value={form.pan} onChange={(e) => set('pan')(cleanPan(e.target.value))} placeholder="ABCDE1234F" autoComplete="off" />
            {!errors.pan && <Hint h={pHint} />}
          </Field>
          <Field label="Home address" span="full">
            <textarea className="efm-textarea" value={form.address} onChange={set('address')} maxLength={300} rows={2} placeholder="House, street, area, city" />
          </Field>
          <Field label="Emergency contact">
            <input className="efm-input" value={form.emergency_name} onChange={set('emergency_name')} maxLength={100} placeholder="Name and relation, e.g. Sunita (wife)" />
          </Field>
          <Field label="Emergency number" error={errors.emergency_phone}>
            <input className={`efm-input${errors.emergency_phone ? ' has-error' : ''}`} value={form.emergency_phone} onChange={set('emergency_phone')} maxLength={15} inputMode="tel" placeholder="98765 43210" />
          </Field>
          <p className="st-privacy efm-field full">Aadhaar and PAN stay on this computer. Lists show only the last few characters; the full number opens only here.</p>
        </Section>

        <Section label="Attendance" anchorKey={4}>
          <div className="efm-toggle-cards" style={{ gridColumn: '1 / -1' }}>
            <button type="button" className={form.attendance_enabled ? 'on' : ''} onClick={() => set('attendance_enabled')(true)}>
              <span className="ic"><MobileOutlined /></span><div className="stack"><div className="name">Checks in with their phone</div><div className="hint">Absences and late marks come from check-ins</div></div>
            </button>
            <button type="button" className={!form.attendance_enabled ? 'on' : ''} onClick={() => set('attendance_enabled')(false)}>
              <span className="ic"><StopOutlined /></span><div className="stack"><div className="name">Not tracked</div><div className="hint">Paid for every working day; leave you mark still counts</div></div>
            </button>
          </div>
          <Field label="Notes" span="full">
            <textarea className="efm-textarea" value={form.notes} onChange={set('notes')} maxLength={500} rows={2} placeholder="Anything worth remembering" />
          </Field>
        </Section>
      </EntityFormModal>

      <Modal rootClassName="ar-pop" open={!!pinFor} onCancel={() => { setPinFor(null); setPin(''); }} width={460} destroyOnHidden footer={null}
        title={<div className="ar-mtitle">{pinFor?.done ? `${pinFor?.name} is ready` : `PIN for ${pinFor?.name || ''}`}<small>{pinFor?.done ? 'Send them these details to sign in once on their phone.' : '4 to 8 digits. They use it once to link their phone.'}</small></div>}>
        {pinFor && !pinFor.done && (
          <div className="ar-form">
            <Input value={pin} autoFocus inputMode="numeric" placeholder="e.g. 5823" className="st-pin"
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} onPressEnter={() => /^\d{4,8}$/.test(pin) && savePin()} />
            <p className="ar-hint">Avoid easy PINs like 1234 or 0000; they are refused.</p>
            <div className="ar-bfoot"><span /><div>
              <button type="button" className="plv-btn" onClick={() => { setPinFor(null); setPin(''); }}>Later</button>
              <button type="button" className="plv-btn primary" disabled={!/^\d{4,8}$/.test(pin)} onClick={savePin}><KeyOutlined /> Set PIN</button></div></div>
          </div>
        )}
        {pinFor?.done && (
          <div className="ar-form">
            <pre className="st-invite">{inviteText(pinFor)}</pre>
            <div className="ar-bfoot"><span className="ar-hint">Share it privately. The PIN is not shown again.</span><div>
              <button type="button" className="plv-btn" onClick={() => { setPinFor(null); setPin(''); }}>Done</button>
              <button type="button" className="plv-btn primary" onClick={copyInvite}><CopyOutlined /> Copy message</button></div></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
