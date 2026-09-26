import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DatePicker, Segmented, Tooltip, Modal, Input, Select, message, Alert, Checkbox, Drawer, Dropdown,
} from 'antd';
import {
  SyncOutlined, SettingOutlined, PlusOutlined, WarningOutlined, CameraOutlined, LeftOutlined, RightOutlined,
  MoreOutlined, SearchOutlined, CheckOutlined, CoffeeOutlined, DownOutlined, SafetyCertificateOutlined,
  WifiOutlined, EnvironmentOutlined, EyeOutlined, CloseOutlined, TeamOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { staffAttendanceAPI } from '../../api';
import '../parties/party-list-view.css';
import './attendance-register.css';

/*
 * Staff Attendance register.
 *
 * Everything shown is computed by the server's buildRegister() — the same
 * function that produces what each staff member sees on their phone — so the
 * owner and the staff can never be looking at different numbers.
 *
 * Corrections are append-only: adding a punch or leave, and removing either,
 * all carry a reason the staff member sees. Nothing is edited or deleted.
 *
 * Visual language follows the Customers / Suppliers list (plv-* classes):
 * left-aligned title, clickable summary cards that filter, one table card.
 */

// Attendance outcome for a day. Whether someone is in the shop right now is
// shown separately (Check-out column), so "late" and "in the shop" never compete.
const STATUS = {
  late:       { label: 'Late',         tone: 'late',  short: 'L',  order: 1 },
  present:    { label: 'On time',      tone: 'ok',    short: 'P',  order: 2 },
  unverified: { label: 'Needs review', tone: 'late',  short: '?',  order: 3 },
  absent:     { label: 'Absent',       tone: 'bad',   short: 'A',  order: 4 },
  not_in:     { label: 'Not in yet',   tone: 'idle',  short: '',   order: 5 },
  leave:      { label: 'On leave',     tone: 'leave', short: 'LV', order: 6 },
  off:        { label: 'Weekly off',   tone: 'off',   short: '',   order: 7 },
  none:       { label: '',             tone: 'idle',  short: '',   order: 8 },
};
const statusKey = (d) => (STATUS[d?.status] ? d.status : 'none');
const QUICK_REASONS = ['Sick', 'Personal work', 'Family function', 'Festival', 'Out of town'];

const hm = (min) => (min > 0 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '0h');
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60 ? `${min % 60}m` : ''}`.trim() : `${min} min`);
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const clock = (s) => { const m = toMin(s); if (m == null) return s || ''; const h = Math.floor(m / 60); return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const cap = (n) => String(n || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// Why a punch deserves a second look. Empty = nothing to worry about.
function doubts(p) {
  if (!p || p.voided_at || p.source === 'manual') return [];
  const out = [];
  if (p.net_status === 'mismatch') out.push('Not on shop Wi-Fi');
  else if (p.net_status === 'pending') out.push('Wi-Fi not confirmed');
  if (p.geo_status === 'outside') out.push(`${((p.distance_m || 0) / 1000).toFixed(1)} km from shop`);
  if (p.device_shared) out.push('Shared phone');
  return out;
}

function Avatar({ name, size = 30 }) {
  return <span className="plv-avatar ar-av" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>{initials(name)}</span>;
}

function Selfie({ punchId, size = 28, onOpen }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true; let made = null;
    staffAttendanceAPI.getSelfie(punchId).then(({ data }) => { if (alive) { made = URL.createObjectURL(data); setUrl(made); } }).catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [punchId]);
  if (!url) return <span className="ar-selfie is-empty" style={{ width: size, height: size }}><CameraOutlined /></span>;
  return <img src={url} alt="Check-in selfie" className="ar-selfie" style={{ width: size, height: size }} onClick={(e) => { e.stopPropagation(); onOpen?.(url); }} />;
}

export default function AttendanceRegister() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('day');
  const [date, setDate] = useState(dayjs());
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState(null);
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [preview, setPreview] = useState(null);
  const [adding, setAdding] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [leaveForm, setLeaveForm] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [, setTick] = useState(0);

  const range = useMemo(() => (mode === 'day'
    ? { from: date.format('YYYY-MM-DD'), to: date.format('YYYY-MM-DD') }
    : { from: date.startOf('month').format('YYYY-MM-DD'), to: date.endOf('month').format('YYYY-MM-DD') }), [mode, date]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: reg }, { data: st }] = await Promise.all([staffAttendanceAPI.getRegister(range), staffAttendanceAPI.getSettings()]);
      setData(reg); setSettings(st);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Could not load the register');
    } finally { setLoading(false); }
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []); // live hours

  const cfg = data?.config || {};
  const off = cfg.tz_offset_min ?? 330;
  const fmt = (ms) => (ms ? dayjs(ms + (off - dayjs(ms).utcOffset()) * 60000).format('h:mm A') : '');
  const minOfDay = (ms) => { const d = new Date(ms + off * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const openMin = toMin(cfg.open_time) ?? 600; const closeMin = toMin(cfg.close_time) ?? 1260;
  const grace = Number(cfg.grace_min) || 0;
  const lateBy = (d) => (d?.in_at ? minOfDay(d.in_at) - openMin - grace : null);
  const livePunches = (d) => (d?.punches || []).filter((p) => !p.voided_at).sort((a, b) => a.at - b.at);
  const liveMin = (d) => (d?.worked_min || 0) + (d?.working ? Math.max(0, Math.round((Date.now() - Math.max(0, ...livePunches(d).filter((p) => p.kind === 'in').map((p) => p.at))) / 60000)) : 0);
  const staffById = useMemo(() => new Map((data?.staff || []).map((s) => [s.staff_id, s])), [data]);
  const nameOf = (s) => cap(s?.name);

  const sync = async () => {
    setSyncing(true);
    try {
      const { data: r } = await staffAttendanceAPI.syncNow();
      message.success(r?.received ? `${r.received} new check-in(s) from phones` : 'Up to date');
      await load();
    } catch (err) { message.error(err?.response?.data?.error || 'Sync failed'); } finally { setSyncing(false); }
  };

  // ── day view data ──
  const dayIso = range.from;
  const isToday = mode === 'day' ? date.isSame(dayjs(), 'day') : date.isSame(dayjs(), 'month');
  const rows = useMemo(() => (data?.staff || []).map((s) => ({ ...s, day: s.days[dayIso] || {}, key: statusKey(s.days[dayIso]) }))
    .sort((a, b) => (b.day.working ? 1 : 0) - (a.day.working ? 1 : 0) || STATUS[a.key].order - STATUS[b.key].order || a.name.localeCompare(b.name)), [data, dayIso]);
  const FILTERS = {
    present: (r) => r.key === 'present' || r.key === 'late',
    in_shop: (r) => !!r.day.working,
    late: (r) => r.key === 'late',
    leave: (r) => r.key === 'leave',
    absent: (r) => r.key === 'absent' || r.key === 'unverified' || r.key === 'not_in' || r.key === 'none',
  };
  const count = (f) => rows.filter(FILTERS[f]).length;
  const expected = rows.filter((r) => r.key !== 'off' && r.key !== 'leave').length;
  const hoursToday = rows.reduce((a, r) => a + liveMin(r.day), 0);
  const visible = rows.filter((r) => (!search || r.name.toLowerCase().includes(search.toLowerCase())) && (!filter || FILTERS[filter](r)));
  const leaveSplit = rows.filter((r) => r.key === 'leave').reduce((a, r) => { a[r.day.leave?.type === 'unpaid' ? 'unpaid' : 'paid']++; return a; }, { paid: 0, unpaid: 0 });
  const notInYet = rows.filter((r) => r.key === 'not_in' || r.key === 'none').length;

  // Everything that happened on the day, newest first, and what needs a look.
  const activity = useMemo(() => {
    const ev = []; const look = [];
    for (const r of rows) {
      for (const p of livePunches(r.day)) ev.push({ r, p });
      const why = [...new Set(livePunches(r.day).flatMap(doubts))]; const last = livePunches(r.day).filter((p) => doubts(p).length).pop();
      if (why.length) look.push({ r, why: why.join(' · '), at: last?.at });
      if (r.day.auto_out) look.push({ r, why: r.day.auto_basis === 'last_bill' ? 'Forgot to check out, closed at their last bill' : 'Forgot to check out', at: r.day.out_at, kind: 'out' });
      if (r.key === 'unverified') look.push({ r, why: 'Check-in could not be verified', at: r.day.in_at, kind: 'in' });
    }
    ev.sort((a, b) => b.p.at - a.p.at);
    return { ev, look };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const monthTotals = useMemo(() => {
    const t = { present: 0, late: 0, leave: 0, leave_paid: 0, leave_unpaid: 0, absent: 0, worked: 0 };
    for (const s of data?.staff || []) {
      t.present += s.summary.present; t.late += s.summary.late; t.leave += s.summary.leave || 0; t.absent += s.summary.absent; t.worked += s.summary.worked_min;
      t.leave_paid += s.summary.leave_paid || 0; t.leave_unpaid += s.summary.leave_unpaid || 0;
    }
    t.rate = t.present + t.absent ? Math.round((t.present / (t.present + t.absent)) * 100) : null;
    return t;
  }, [data]);

  // ── actions ──
  const doVoid = async () => {
    try {
      if (voiding.kind === 'leave') await staffAttendanceAPI.voidLeave(voiding.id, voiding.reason);
      else await staffAttendanceAPI.voidPunch(voiding.id, voiding.reason);
      message.success('Removed. The staff member will see your reason.'); setVoiding(null); await load();
    } catch (err) { message.error(err?.response?.data?.error || 'Could not remove'); }
  };
  const doAdd = async () => {
    try { await staffAttendanceAPI.addPunch(adding); message.success('Punch added.'); setAdding(null); await load(); }
    catch (err) { message.error(err?.response?.data?.error || 'Could not add the punch'); }
  };
  const openAdd = (sid, iso, kind) => setAdding({ staff_id: sid ?? rows[0]?.staff_id, kind: kind || 'in', date: iso || dayIso, time: dayjs().format('HH:mm'), reason: '' });
  const openLeave = (sid, iso) => setLeaveForm({ staff_id: sid ?? rows[0]?.staff_id, dates: [dayjs(iso || dayIso)], leave_type: 'paid', reason: '' });
  const doLeave = async () => {
    try {
      const { data: r } = await staffAttendanceAPI.addLeave({ staff_id: leaveForm.staff_id, dates: leaveForm.dates.map((d) => d.format('YYYY-MM-DD')), leave_type: leaveForm.leave_type, reason: leaveForm.reason });
      message.success(`${r.added} leave day(s) recorded${r.already ? `, ${r.already} already on leave` : ''}.`); setLeaveForm(null); await load();
    } catch (err) { message.error(err?.response?.data?.error || 'Could not record leave'); }
  };
  const openBulk = () => {
    const end = dayjs(range.to).isAfter(dayjs()) ? dayjs() : dayjs(range.to);
    setBulk({ staff_ids: rows.map((s) => s.staff_id), range: [dayjs(range.from), end], in_time: cfg.open_time || '10:00', out_time: cfg.close_time || '21:00',
      reason: 'Marked present by owner', include_weekly_off: false, leaves: {}, saving: false });
  };
  const bulkDays = useMemo(() => {
    if (!bulk?.range?.[0]) return [];
    const out = []; const wo = new Set((cfg.weekly_off || []).map(Number));
    for (let d = bulk.range[0].startOf('day'); !d.isAfter(bulk.range[1], 'day'); d = d.add(1, 'day')) if (bulk.include_weekly_off || !wo.has(d.day())) out.push(d);
    return out;
  }, [bulk, cfg.weekly_off]);
  const setBulkLeave = (sid, patch) => setBulk((b) => ({ ...b, leaves: { ...b.leaves, [sid]: { dates: [], type: 'paid', ...b.leaves[sid], ...patch } } }));
  const toggleBulkStaff = (sid, on) => setBulk((b) => ({ ...b, staff_ids: on ? [...b.staff_ids, sid] : b.staff_ids.filter((x) => x !== sid) }));
  const bulkLeaveTotal = bulk ? bulk.staff_ids.reduce((a, sid) => a + (bulk.leaves[sid]?.dates?.length || 0), 0) : 0;
  const bulkPresent = bulk ? bulk.staff_ids.length * bulkDays.length - bulkLeaveTotal : 0;
  const submitBulk = async () => {
    setBulk((b) => ({ ...b, saving: true }));
    try {
      const { data: r } = await staffAttendanceAPI.bulkPunches({
        staff_ids: bulk.staff_ids, from: bulk.range[0].format('YYYY-MM-DD'), to: bulk.range[1].format('YYYY-MM-DD'),
        in_time: bulk.in_time, out_time: bulk.out_time || null, reason: bulk.reason, include_weekly_off: bulk.include_weekly_off,
        leaves: Object.entries(bulk.leaves).filter(([sid, l]) => bulk.staff_ids.includes(Number(sid)) && l.dates?.length)
          .map(([sid, l]) => ({ staff_id: Number(sid), dates: l.dates.map((d) => d.format('YYYY-MM-DD')), leave_type: l.type })),
      });
      const sk = r.skipped || {};
      const notes = [sk.existing && `${sk.existing} already had a check-in`, sk.on_leave && `${sk.on_leave} already on leave`, sk.weekly_off && `${sk.weekly_off} weekly off`,
        sk.before_joining && `${sk.before_joining} before joining`, sk.future && `${sk.future} in the future`].filter(Boolean);
      message.success(`Saved: ${r.created_days} present day(s)${r.leave_days ? `, ${r.leave_days} leave day(s)` : ''}.${notes.length ? ` Skipped ${notes.join(', ')}.` : ''}`, 7);
      setBulk(null); await load();
    } catch (err) { message.error(err?.response?.data?.error || 'Could not save attendance'); setBulk((b) => b && ({ ...b, saving: false })); }
  };

  // ── timeline scale (shared by the header ruler and every row) ──
  const scaleFrom = Math.floor((openMin - 60) / 60) * 60; const scaleTo = Math.ceil((closeMin + 60) / 60) * 60;
  const pos = (min) => Math.min(100, Math.max(0, ((min - scaleFrom) / (scaleTo - scaleFrom)) * 100));
  const pct = (min) => `${pos(min)}%`;
  const ticks = []; for (let m = scaleFrom; m <= scaleTo; m += 60) ticks.push(m);
  const tickLabel = (m) => { const h = Math.floor(m / 60) % 24; return `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`; };
  const nowMin = minOfDay(Date.now());

  function Timeline({ d }) {
    const work = []; let open = null;
    for (const p of livePunches(d)) { if (p.kind === 'in' && open === null) open = p.at; else if (p.kind === 'out' && open !== null) { work.push([open, p.at, false]); open = null; } }
    if (open !== null) work.push([open, d.working ? Date.now() : (d.out_at || open), d.working]);
    const late = lateBy(d) > 0;
    return (
      <div className="ar-tl">
        {ticks.map((m) => <span key={m} className="ar-tl-tick" style={{ left: pct(m) }} />)}
        <div className="ar-tl-shift" style={{ left: pct(openMin), width: `${pos(closeMin) - pos(openMin)}%` }} />
        {late && <div className="ar-tl-late" style={{ left: pct(openMin), width: `${pos(minOfDay(d.in_at)) - pos(openMin)}%` }} />}
        {work.map(([a, b, isLive], i) => (
          <div key={i} className={`ar-tl-bar${isLive ? ' is-live' : ''}${d.auto_out && i === work.length - 1 && !isLive ? ' is-auto' : ''}`}
            style={{ left: pct(minOfDay(a)), width: `max(3px, ${pos(minOfDay(b)) - pos(minOfDay(a))}%)` }} />
        ))}
      </div>
    );
  }
  const Tag = ({ k, d }) => (STATUS[k].label ? (
    <span className={`plv-status-tag ar-tag tone-${STATUS[k].tone}`}>{STATUS[k].label}{k === 'leave' && d?.leave?.type === 'unpaid' ? ' · unpaid' : ''}</span>
  ) : null);

  const drawerStaff = drawer ? staffById.get(drawer.staffId) : null;
  const drawerDay = drawerStaff ? (drawerStaff.days[drawer.date] || {}) : null;
  const openDay = (staffId, iso) => { setShowRemoved(false); setDrawer({ staffId, date: iso }); };
  const step = (n) => setDate((d) => d.add(n, mode === 'day' ? 'day' : 'month'));
  const syncedAgo = settings?.last_sync_at ? dayjs(settings.last_sync_at) : null;
  const markMenu = { items: [
    { key: 'present', icon: <CheckOutlined />, label: 'Mark present for several days', onClick: openBulk },
    { key: 'leave', icon: <CoffeeOutlined />, label: 'Mark leave', onClick: () => openLeave() },
    { key: 'punch', icon: <PlusOutlined />, label: 'Add a check-in or check-out', onClick: () => openAdd() },
  ] };
  const rowMenu = (r) => ({ items: [
    { key: 'view', icon: <EyeOutlined />, label: 'View day', onClick: () => openDay(r.staff_id, dayIso) },
    { key: 'punch', icon: <PlusOutlined />, label: r.day.working ? 'Add check-out' : 'Add check-in', onClick: () => openAdd(r.staff_id, dayIso, r.day.working ? 'out' : 'in') },
    r.day.leave
      ? { key: 'unleave', icon: <CloseOutlined />, danger: true, label: 'Remove leave', onClick: () => setVoiding({ kind: 'leave', id: r.day.leave.leave_id, label: `${nameOf(r)}'s leave`, reason: '' }) }
      : { key: 'leave', icon: <CoffeeOutlined />, label: 'Mark leave', onClick: () => openLeave(r.staff_id, dayIso) },
  ] });

  const Card = ({ id, k, v, sub, tone, bar }) => {
    const n = id ? count(id) : null; const clickable = id && (n || filter === id);
    return (
      <div role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
        className={`plv-age-card ar-card${tone ? ` tone-${tone}` : ''}${filter === id && id ? ' on' : ''}${clickable ? '' : ' is-static'}`}
        onClick={() => clickable && setFilter(filter === id ? null : id)} onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setFilter(filter === id ? null : id); } }}>
        <div className="k">{k}</div><div className="v">{v}</div>{sub && <div className="sub">{sub}</div>}
        {bar != null && <div className="bar"><div className="fill" style={{ width: `${Math.min(100, bar)}%` }} /></div>}
      </div>
    );
  };

  const drawerLive = drawerDay ? livePunches(drawerDay) : [];
  const drawerRemoved = drawerDay ? (drawerDay.punches || []).filter((p) => p.voided_at).sort((a, b) => a.at - b.at) : [];

  return (
    <div className="ar">
      <header className="plv-hdr ar-hdr">
        <div className="plv-title">
          <h1>Attendance</h1>
          <div className="sub">
            Shift <b>{clock(cfg.open_time || '10:00')} – {clock(cfg.close_time || '21:00')}</b>{grace ? <> · {grace} min grace</> : null}
            {syncedAgo && <> · Synced {syncedAgo.isSame(dayjs(), 'day') ? syncedAgo.format('h:mm A') : syncedAgo.format('D MMM, h:mm A')}</>}
          </div>
        </div>
        <div className="plv-actions">
          <div className="ar-datenav">
            <button type="button" className="ar-dn-btn" onClick={() => step(-1)} aria-label="Previous"><LeftOutlined /></button>
            {mode === 'day'
              ? <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} inputReadOnly format={isToday ? '[Today], D MMM YYYY' : 'ddd, D MMM YYYY'} variant="borderless" suffixIcon={<DownOutlined />} className="ar-datepick" disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
              : <DatePicker picker="month" value={date} onChange={(d) => d && setDate(d)} allowClear={false} inputReadOnly format="MMMM YYYY" variant="borderless" suffixIcon={<DownOutlined />} className="ar-datepick" disabledDate={(d) => d.isAfter(dayjs(), 'month')} />}
            <button type="button" className="ar-dn-btn" onClick={() => step(1)} disabled={isToday} aria-label="Next"><RightOutlined /></button>
          </div>
          {!isToday && <button type="button" className="plv-iconbtn" onClick={() => setDate(dayjs())}>{mode === 'day' ? 'Today' : 'This month'}</button>}
          <Segmented className="ar-seg" value={mode} onChange={(v) => { setMode(v); setFilter(null); }} options={[{ label: 'Day', value: 'day' }, { label: 'Month', value: 'month' }]} />
          <span className="ar-vsep" />
          <Tooltip title="Fetch new check-ins from staff phones">
            <button type="button" className="plv-btn" onClick={sync} disabled={syncing}><SyncOutlined spin={syncing} /> Sync</button>
          </Tooltip>
          <Dropdown menu={markMenu} trigger={['click']} placement="bottomRight" disabled={!rows.length} overlayClassName="ar-menu">
            <button type="button" className="plv-btn primary" disabled={!rows.length}><CheckOutlined /> Mark attendance <DownOutlined className="ar-caret" /></button>
          </Dropdown>
          <Tooltip title="Staff, PINs and rules">
            <button type="button" className="plv-iconbtn square ar-sq" onClick={() => navigate('/settings/staff-attendance')} aria-label="Staff and rules"><SettingOutlined /></button>
          </Tooltip>
        </div>
      </header>

      <div className="ar-body">
        {settings && !settings.enabled && (
          <Alert type="info" showIcon className="ar-alert" message="Staff attendance is off" description="Turn it on and add your staff in Staff & rules. Staff then check in from their own phones."
            action={<button type="button" className="plv-btn primary" onClick={() => navigate('/settings/staff-attendance')}>Set up</button>} />
        )}
        {settings?.enabled && settings?.last_sync_error && <Alert type="warning" showIcon className="ar-alert" message="Could not reach staff phones" description={settings.last_sync_error} />}

        {mode === 'day' ? (
          <>
            <section className="ar-cards">
              <Card id="present" k={isToday ? 'Present today' : 'Present'} tone="ok" v={<>{count('present')}<small> / {expected}</small></>}
                sub={expected ? `${Math.round((count('present') / expected) * 100)}% of expected staff` : 'Nobody expected'} bar={expected ? (count('present') / expected) * 100 : 0} />
              {isToday && <Card id="in_shop" k="In the shop now" tone="work" v={count('in_shop')} sub={count('in_shop') ? rows.filter(FILTERS.in_shop).slice(0, 3).map(nameOf).join(', ') + (count('in_shop') > 3 ? ` +${count('in_shop') - 3}` : '') : 'Nobody checked in right now'} />}
              <Card id="late" k="Late" tone="late" v={count('late')} sub={`After ${clock(`${Math.floor((openMin + grace) / 60)}:${String((openMin + grace) % 60).padStart(2, '0')}`)}`} />
              <Card id="leave" k="On leave" tone="leave" v={count('leave')} sub={count('leave') ? `${leaveSplit.paid} paid · ${leaveSplit.unpaid} unpaid` : 'No leave'} />
              <Card id="absent" k={isToday ? 'Not in' : 'Absent'} tone="bad" v={count('absent')} sub={isToday && notInYet ? `${notInYet} not in yet` : count('absent') ? 'No check-in' : 'Everyone came in'} />
              <Card k="Hours worked" v={hm(hoursToday)} sub={count('present') ? `Avg ${hm(Math.round(hoursToday / count('present')))} each` : '—'} />
            </section>

            <div className="ar-split">
              <section className="plv-table-card ar-tablecard">
                <div className="ar-tbar">
                  <div className="ar-tbar-l">
                    <b>{filter ? { present: 'Present', in_shop: 'In the shop', late: 'Late', leave: 'On leave', absent: isToday ? 'Not in' : 'Absent' }[filter] : 'All staff'}</b>
                    <span className="ar-count">{visible.length}</span>
                    {filter && <button type="button" className="ar-clear" onClick={() => setFilter(null)}><CloseOutlined /> Clear filter</button>}
                  </div>
                  <div className="plv-search ar-search"><SearchOutlined /><input placeholder="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
                </div>
                <div className="plv-table-scroll">
                  <table className="plv-table ar-table">
                    <colgroup><col className="c-staff" /><col className="c-status" /><col className="c-in" /><col className="c-out" /><col className="c-hrs" /><col className="c-tl" /><col className="c-act" /></colgroup>
                    <thead><tr>
                      <th>Staff</th><th>Status</th><th>Check in</th><th>Check out</th><th className="r">Worked</th>
                      <th className="ar-ruler-th"><div className="ar-ruler">{ticks.filter((m) => m >= openMin && m <= closeMin).map((m) => <em key={m} className={m === openMin || m === closeMin ? 'is-major' : (m - openMin) % 120 || closeMin - m < 90 ? 'is-hide' : ''} style={{ left: pct(m) }}>{tickLabel(m)}</em>)}{closeMin % 60 ? <em className="is-major" style={{ left: pct(closeMin) }}>{clock(cfg.close_time)}</em> : null}</div></th><th />
                    </tr></thead>
                    <tbody>
                      {loading && !data ? <tr><td colSpan={7}><div className="plv-empty">Loading…</div></td></tr> : visible.length === 0 ? (
                        <tr><td colSpan={7}><div className="plv-empty ar-empty"><TeamOutlined className="icon" /><div>{rows.length ? 'Nobody matches.' : 'No staff yet'}</div>
                          <div className="sub">{rows.length ? <button type="button" className="ar-link" onClick={() => { setFilter(null); setSearch(''); }}>Show everyone</button> : 'Add staff in Staff & rules. They check in from their own phones.'}</div></div></td></tr>
                      ) : visible.map((r) => {
                        const d = r.day; const live = livePunches(d);
                        const firstIn = live.find((p) => p.kind === 'in'); const photo = live.find((p) => p.has_selfie);
                        const why = live.flatMap(doubts); const l = lateBy(d);
                        return (
                          <tr key={r.staff_id} className="row" onClick={() => openDay(r.staff_id, dayIso)}>
                            <td>
                              <div className="plv-party-inline"><Avatar name={r.name} />
                                <div className="plv-party-nm"><div className="main"><span className="txt">{nameOf(r)}</span></div>
                                  <div className="sub">{r.phone ? `•••• ${String(r.phone).slice(-4)}` : 'Staff'}</div></div></div>
                            </td>
                            <td><Tag k={r.key} d={d} />{r.key === 'late' && l > 0 && <div className="ar-cellsub tx-late">{dur(l)} late</div>}
                              {r.key === 'leave' && d.leave?.reason && <div className="ar-cellsub">{d.leave.reason}</div>}</td>
                            <td>{firstIn ? (
                              <div className="ar-time">
                                {photo ? <Selfie punchId={photo.punch_id} onOpen={(url) => setPreview({ url, punch: photo, name: nameOf(r) })} /> : <span className="ar-selfie is-empty"><ClockCircleOutlined /></span>}
                                <span>{fmt(firstIn.at)}</span>
                                <Tooltip title={why.length ? why.join(' · ') : [live.some((p) => p.net_status === 'match') && 'On shop Wi-Fi', live.some((p) => p.passkey) && 'Fingerprint / Face ID'].filter(Boolean).join(' · ') || 'Added by owner'}>
                                  {why.length ? <WarningOutlined className="ic-warn" /> : <SafetyCertificateOutlined className="ic-ok" />}
                                </Tooltip>
                              </div>) : <span className="ar-dash">—</span>}</td>
                            <td>{d.working ? <span className="ar-live"><i />In the shop</span>
                              : d.out_at ? <span className="ar-time"><span>{fmt(d.out_at)}</span>{d.auto_out && <Tooltip title={d.auto_basis === 'last_bill' ? 'Forgot to check out: closed at their last sales bill' : 'Forgot to check out'}><span className="ar-auto">Auto</span></Tooltip>}</span>
                                : <span className="ar-dash">—</span>}</td>
                            <td className="r ar-num">{d.in_at ? <>{hm(liveMin(d))}{d.working && <div className="ar-cellsub">so far</div>}</> : <span className="ar-dash">—</span>}</td>
                            <td className="ar-tlcell">{d.in_at || live.length ? <Timeline d={d} /> : <div className="ar-tl is-empty" />}
                              {isToday && nowMin > scaleFrom && nowMin < scaleTo && <span className="ar-now" style={{ left: `calc(14px + (100% - 28px) * ${pos(nowMin) / 100})` }} />}</td>
                            <td className="ar-actcell" onClick={(e) => e.stopPropagation()}>
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
              </section>

              <aside className="ar-rail">
                {activity.look.length > 0 && (
                  <section className="plv-table-card ar-panel">
                    <div className="ar-panel-h"><WarningOutlined className="ic-warn" /> Needs a look <span className="ar-count">{activity.look.length}</span></div>
                    {activity.look.map((x, i) => (
                      <button type="button" key={i} className="ar-feed" onClick={() => openDay(x.r.staff_id, dayIso)}>
                        <Avatar name={x.r.name} size={26} />
                        <div><b>{nameOf(x.r)}</b><span>{x.why}</span></div>
                        <time>{x.at ? fmt(x.at) : ''}</time>
                      </button>
                    ))}
                  </section>
                )}
                <section className="plv-table-card ar-panel ar-panel-grow">
                  <div className="ar-panel-h">{isToday ? 'Today’s activity' : 'Activity'} <span className="ar-count">{activity.ev.length}</span></div>
                  {activity.ev.length === 0 ? (
                    <div className="ar-panel-empty">
                      <ClockCircleOutlined />
                      <p>{isToday ? 'No check-ins yet today.' : 'No check-ins this day.'}</p>
                      {isToday && settings?.shop_code && <span>Staff check in at <b>staff.zehenapp.com</b></span>}
                    </div>
                  ) : (
                    <div className="ar-feedlist">
                      {activity.ev.map(({ r, p }) => (
                        <button type="button" key={p.punch_id} className="ar-feed" onClick={() => openDay(r.staff_id, dayIso)}>
                          <span className={`ar-dot k-${p.kind}`} />
                          <div><b>{nameOf(r)}</b><span>{p.kind === 'in' ? 'Checked in' : 'Checked out'}{p.source === 'manual' ? ' · added by owner' : doubts(p).length ? ` · ${doubts(p)[0]}` : ''}</span></div>
                          <time>{fmt(p.at)}</time>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </aside>
            </div>
          </>
        ) : (
          <>
            <section className="ar-cards">
              <Card k="Attendance" tone="ok" v={monthTotals.rate == null ? '—' : `${monthTotals.rate}%`} sub="Present ÷ (present + absent)" bar={monthTotals.rate ?? 0} />
              <Card k="Days present" v={monthTotals.present} sub={`${(data?.staff || []).length} staff`} />
              <Card k="Late marks" tone="late" v={monthTotals.late} sub={monthTotals.present ? `${Math.round((monthTotals.late / monthTotals.present) * 100)}% of present days` : '—'} />
              <Card k="Leave days" tone="leave" v={monthTotals.leave} sub={`${monthTotals.leave_paid} paid · ${monthTotals.leave_unpaid} unpaid`} />
              <Card k="Absences" tone="bad" v={monthTotals.absent} sub={monthTotals.absent ? 'Days with no check-in' : 'None this month'} />
              <Card k="Hours worked" v={hm(monthTotals.worked)} sub={monthTotals.present ? `Avg ${hm(Math.round(monthTotals.worked / monthTotals.present))} a day` : '—'} />
            </section>
            <section className="plv-table-card ar-monthcard">
              <div className="plv-table-scroll">
                <table className="ar-month">
                  <colgroup><col className="c-staff" />{(data?.days || []).map((iso) => <col key={iso} className="c-day" />)}<col className="c-rate" /><col className="c-tot" /><col className="c-tot" /><col className="c-tot" /><col className="c-tot" /><col className="c-hrs" /></colgroup>
                  <thead><tr>
                    <th className="ar-sticky">Staff</th>
                    {(data?.days || []).map((iso) => { const d = dayjs(iso); const wo = (cfg.weekly_off || []).map(Number).includes(d.day());
                      return <th key={iso} className={`ar-dh${iso === data.today ? ' is-today' : ''}${wo ? ' is-wo' : ''}`}><span>{d.format('dd')[0]}</span><b>{d.date()}</b></th>; })}
                    <th className="ar-sum ar-sum-first">Rate</th><th className="ar-sum">Present</th><th className="ar-sum">Late</th><th className="ar-sum">Leave</th><th className="ar-sum">Absent</th><th className="ar-sum">Hours</th>
                  </tr></thead>
                  <tbody>
                    {(data?.staff || []).map((s) => {
                      const rate = s.summary.present + s.summary.absent ? Math.round((s.summary.present / (s.summary.present + s.summary.absent)) * 100) : null;
                      return (
                        <tr key={s.staff_id}>
                          <td className="ar-sticky"><div className="plv-party-inline"><Avatar name={s.name} size={26} /><span className="ar-mname">{nameOf(s)}</span></div></td>
                          {data.days.map((iso) => {
                            const d = s.days[iso]; const k = statusKey(d); const st = STATUS[k];
                            const wo = k === 'off'; const future = iso > data.today;
                            const tip = [dayjs(iso).format('ddd D MMM'), st.label, d?.in_at && `In ${fmt(d.in_at)}`, d?.out_at && `Out ${fmt(d.out_at)}${d.auto_out ? ' (auto)' : ''}`,
                              d?.leave && `${d.leave.type === 'unpaid' ? 'Unpaid' : 'Paid'} leave${d.leave.reason ? `: ${d.leave.reason}` : ''}`,
                              ...livePunches(d).flatMap(doubts)].filter(Boolean).join(' · ');
                            return (
                              <td key={iso} className={`ar-dc${iso === data.today ? ' is-today' : ''}${wo ? ' is-wo' : ''}`}>
                                {!future && k !== 'none' && !wo && (
                                  <Tooltip title={tip} mouseEnterDelay={0.15}>
                                    <button type="button" className={`ar-cell tone-${st.tone}${d?.working ? ' is-live' : ''}${livePunches(d).some((p) => doubts(p).length) ? ' has-flag' : ''}`}
                                      onClick={() => openDay(s.staff_id, iso)} aria-label={tip}>{st.short}</button>
                                  </Tooltip>
                                )}
                              </td>
                            );
                          })}
                          <td className="ar-sum ar-sum-first"><div className="ar-rate"><b>{rate == null ? '—' : `${rate}%`}</b><span><i style={{ width: `${rate || 0}%` }} /></span></div></td>
                          <td className="ar-sum"><b>{s.summary.present}</b></td>
                          <td className="ar-sum">{s.summary.late ? <span className="tx-late">{s.summary.late}</span> : <span className="ar-dash">0</span>}</td>
                          <td className="ar-sum">{s.summary.leave ? <Tooltip title={`${s.summary.leave_paid || 0} paid · ${s.summary.leave_unpaid || 0} unpaid`}><span className="tx-leave">{s.summary.leave}</span></Tooltip> : <span className="ar-dash">0</span>}</td>
                          <td className="ar-sum">{s.summary.absent ? <span className="tx-bad">{s.summary.absent}</span> : <span className="ar-dash">0</span>}</td>
                          <td className="ar-sum ar-num">{hm(s.summary.worked_min)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="ar-mlegend">
                {[['ok', 'P', 'On time'], ['late', 'L', 'Late'], ['bad', 'A', 'Absent'], ['leave', 'LV', 'Leave']].map(([t, s, l]) => <span key={t}><i className={`ar-cell tone-${t}`}>{s}</i>{l}</span>)}
                <span><i className="ar-cell tone-ok has-flag">P</i>Something to check</span>
                <span><i className="ar-wo-sw" />Weekly off</span>
                <em>Click any day to see check-ins, selfies and corrections.</em>
              </div>
            </section>
          </>
        )}
      </div>

      {/* ── day details ── */}
      <Drawer rootClassName="ar-pop" open={!!drawer} onClose={() => setDrawer(null)} width={460} destroyOnHidden closeIcon={null}
        title={drawerStaff && (
          <div className="ar-dhead">
            <Avatar name={drawerStaff.name} size={40} />
            <div><b>{nameOf(drawerStaff)}</b><small>{dayjs(drawer.date).format('dddd, D MMMM YYYY')}</small></div>
            <div className="ar-dnav">
              <button type="button" className="ar-dn-btn" aria-label="Previous day" onClick={() => openDay(drawer.staffId, dayjs(drawer.date).subtract(1, 'day').format('YYYY-MM-DD'))} disabled={!drawerStaff.days[dayjs(drawer.date).subtract(1, 'day').format('YYYY-MM-DD')]}><LeftOutlined /></button>
              <button type="button" className="ar-dn-btn" aria-label="Next day" onClick={() => openDay(drawer.staffId, dayjs(drawer.date).add(1, 'day').format('YYYY-MM-DD'))} disabled={!drawerStaff.days[dayjs(drawer.date).add(1, 'day').format('YYYY-MM-DD')]}><RightOutlined /></button>
              <button type="button" className="ar-dn-btn" aria-label="Close" onClick={() => setDrawer(null)}><CloseOutlined /></button>
            </div>
          </div>
        )}
        footer={drawerStaff && (
          <div className="ar-dfoot">
            <button type="button" className="plv-btn" onClick={() => openAdd(drawerStaff.staff_id, drawer.date, drawerDay.working ? 'out' : 'in')}><PlusOutlined /> {drawerDay.working ? 'Add check-out' : 'Add check-in'}</button>
            {drawerDay.leave
              ? <button type="button" className="plv-btn" onClick={() => setVoiding({ kind: 'leave', id: drawerDay.leave.leave_id, label: `${nameOf(drawerStaff)}'s leave`, reason: '' })}><CloseOutlined /> Remove leave</button>
              : <button type="button" className="plv-btn" onClick={() => openLeave(drawerStaff.staff_id, drawer.date)}><CoffeeOutlined /> Mark leave</button>}
          </div>
        )}>
        {drawerStaff && (
          <div className="ar-drawer">
            <div className="ar-dsum">
              <div className="ar-dsum-top"><Tag k={statusKey(drawerDay)} d={drawerDay} />{drawerDay.working && <span className="ar-live"><i />In the shop</span>}</div>
              {drawerDay.in_at ? (
                <div className="ar-dstats3">
                  <div><span>Check in</span><b>{fmt(drawerDay.in_at)}</b></div>
                  <div><span>Check out</span><b>{drawerDay.out_at ? fmt(drawerDay.out_at) : drawerDay.working ? '—' : '—'}</b>{drawerDay.auto_out && <em>auto</em>}</div>
                  <div><span>Worked</span><b>{hm(liveMin(drawerDay))}</b></div>
                </div>
              ) : null}
              {drawerDay.in_at && lateBy(drawerDay) > 0 && (
                <p className="ar-dnote tone-late"><ClockCircleOutlined /> {dur(lateBy(drawerDay))} late. Shift starts {clock(cfg.open_time)}{grace ? `, ${grace} min grace` : ''}.</p>
              )}
              {drawerDay.leave && <p className="ar-dnote tone-leave"><CoffeeOutlined /> {drawerDay.leave.type === 'unpaid' ? 'Unpaid' : 'Paid'} leave{drawerDay.leave.reason ? `: ${drawerDay.leave.reason}` : ''}</p>}
              {!drawerDay.in_at && !drawerDay.leave && <p className="ar-dnote">{statusKey(drawerDay) === 'off' ? 'Weekly off.' : 'No check-in recorded this day.'}</p>}
            </div>

            {drawerLive.length > 0 && <h4>Check-ins and check-outs</h4>}
            <ol className="ar-plist">
              {drawerLive.map((p) => {
                const why = doubts(p);
                return (
                  <li key={p.punch_id} className={`ar-p k-${p.kind}`}>
                    <span className="ar-p-dot" />
                    <div className="ar-p-main">
                      <div className="ar-p-top">
                        <b>{fmt(p.at)}</b><span>{p.kind === 'in' ? 'Checked in' : 'Checked out'}</span>
                        <button type="button" className="ar-link danger" onClick={() => setVoiding({ kind: 'punch', id: p.punch_id, label: `${p.kind === 'in' ? 'check-in' : 'check-out'} at ${fmt(p.at)}`, reason: '' })}>Remove</button>
                      </div>
                      {p.source === 'manual' ? <div className="ar-p-meta">Added by owner · {p.reason}</div> : (
                        <div className="ar-p-meta">
                          {p.passkey && <span className="ok"><SafetyCertificateOutlined /> Fingerprint / Face ID</span>}
                          {p.net_status === 'match' && <span className="ok"><WifiOutlined /> Shop Wi-Fi</span>}
                          {p.geo_status === 'inside' && <span className="ok"><EnvironmentOutlined /> {Math.round(p.distance_m || 0)} m from shop</span>}
                          {why.map((w) => <span key={w} className="warn"><WarningOutlined /> {w}</span>)}
                        </div>
                      )}
                    </div>
                    {p.has_selfie && <div className="ar-p-selfie"><Selfie punchId={p.punch_id} size={52} onOpen={(url) => setPreview({ url, punch: p, name: nameOf(drawerStaff) })} />{p.prompt && <small>{p.prompt}</small>}</div>}
                  </li>
                );
              })}
            </ol>
            {drawerRemoved.length > 0 && (
              <div className="ar-removed">
                <button type="button" className="ar-link" onClick={() => setShowRemoved((v) => !v)}>{showRemoved ? 'Hide' : 'Show'} {drawerRemoved.length} removed {drawerRemoved.length === 1 ? 'entry' : 'entries'} <DownOutlined rotate={showRemoved ? 180 : 0} /></button>
                {showRemoved && (
                  <ul>
                    {drawerRemoved.map((p) => <li key={p.punch_id}><span>{p.kind === 'in' ? 'Check-in' : 'Check-out'} {fmt(p.at)}</span><em>{p.void_reason || 'Removed'}</em></li>)}
                  </ul>
                )}
              </div>
            )}

            <h4>{dayjs(drawer.date).format('MMMM')} so far</h4>
            <div className="ar-dmonth">
              <div><b className="tx-ok">{drawerStaff.summary.present}</b><span>Present</span></div>
              <div><b className="tx-late">{drawerStaff.summary.late}</b><span>Late</span></div>
              <div><b className="tx-leave">{drawerStaff.summary.leave || 0}</b><span>Leave</span></div>
              <div><b className="tx-bad">{drawerStaff.summary.absent}</b><span>Absent</span></div>
            </div>
            {mode === 'day' && <p className="ar-dhint">Switch to Month to see the full month for everyone.</p>}
          </div>
        )}
      </Drawer>

      {/* ── dialogs ── */}
      <Modal rootClassName="ar-pop" open={!!preview} footer={null} onCancel={() => setPreview(null)} width={400} title={preview ? `${preview.name} · ${fmt(preview.punch.at)}` : ''}>
        {preview && <div className="ar-preview">{preview.punch.prompt && <p>Asked to: <b>{preview.punch.prompt}</b></p>}<img src={preview.url} alt="Check-in" /></div>}
      </Modal>

      <Modal rootClassName="ar-pop" open={!!adding} title="Add a check-in or check-out" okText={adding?.kind === 'out' ? 'Add check-out' : 'Add check-in'} onOk={doAdd} onCancel={() => setAdding(null)} width={460}
        okButtonProps={{ disabled: !adding || adding.reason.trim().length < 3 }} destroyOnHidden>
        {adding && (
          <div className="ar-form">
            <div className="ar-field"><label>Staff</label><Select value={adding.staff_id} onChange={(v) => setAdding({ ...adding, staff_id: v })} options={rows.map((s) => ({ value: s.staff_id, label: nameOf(s) }))} /></div>
            <div className="ar-field"><label>Type</label>
              <div className="ar-choice two">{[['in', 'Check in'], ['out', 'Check out']].map(([v, t]) => <button key={v} type="button" className={adding.kind === v ? 'is-on' : ''} onClick={() => setAdding({ ...adding, kind: v })}><b>{t}</b></button>)}</div></div>
            <div className="ar-two">
              <div className="ar-field"><label>Date</label><Input type="date" value={adding.date} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setAdding({ ...adding, date: e.target.value })} /></div>
              <div className="ar-field"><label>Time</label><Input type="time" value={adding.time} onChange={(e) => setAdding({ ...adding, time: e.target.value })} /></div>
            </div>
            <div className="ar-field"><label>Reason <em>the staff member sees this</em></label>
              <Input.TextArea rows={2} maxLength={300} value={adding.reason} placeholder="e.g. Phone battery was dead" onChange={(e) => setAdding({ ...adding, reason: e.target.value })} /></div>
          </div>
        )}
      </Modal>

      <Modal rootClassName="ar-pop" open={!!leaveForm} title="Mark leave" okText={leaveForm?.dates?.length ? `Mark ${leaveForm.dates.length} day${leaveForm.dates.length > 1 ? 's' : ''} as leave` : 'Mark leave'} onOk={doLeave} onCancel={() => setLeaveForm(null)} width={480}
        okButtonProps={{ disabled: !leaveForm || !leaveForm.dates?.length || leaveForm.reason.trim().length < 3 }} destroyOnHidden>
        {leaveForm && (
          <div className="ar-form">
            <div className="ar-field"><label>Staff</label><Select value={leaveForm.staff_id} onChange={(v) => setLeaveForm({ ...leaveForm, staff_id: v })} options={rows.map((s) => ({ value: s.staff_id, label: nameOf(s) }))} /></div>
            <div className="ar-field"><label>Days <em>pick one or more</em></label>
              <DatePicker multiple value={leaveForm.dates} onChange={(v) => setLeaveForm({ ...leaveForm, dates: v || [] })} format="D MMM" maxTagCount="responsive" /></div>
            <div className="ar-field"><label>Type</label>
              <div className="ar-choice two">
                {[['paid', 'Paid leave', 'Counts as a paid day'], ['unpaid', 'Unpaid leave', 'Deducted from salary']].map(([v, t, s]) => (
                  <button key={v} type="button" className={leaveForm.leave_type === v ? 'is-on' : ''} onClick={() => setLeaveForm({ ...leaveForm, leave_type: v })}><b>{t}</b><span>{s}</span></button>
                ))}
              </div></div>
            <div className="ar-field"><label>Reason <em>the staff member sees this</em></label>
              <div className="ar-quick">{QUICK_REASONS.map((q) => <button key={q} type="button" className={leaveForm.reason === q ? 'is-on' : ''} onClick={() => setLeaveForm({ ...leaveForm, reason: q })}>{q}</button>)}</div>
              <Input maxLength={300} value={leaveForm.reason} placeholder="Or type a reason" onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })} /></div>
          </div>
        )}
      </Modal>

      <Modal rootClassName="ar-pop" open={!!bulk} title={<div className="ar-mtitle">Mark present<small>For days staff could not check in, like before they started using the app.</small></div>} onCancel={() => setBulk(null)} width={760} destroyOnHidden style={{ top: 32 }}
        footer={bulk && (
          <div className="ar-bfoot">
            <span>{bulk.staff_ids.length ? <><b>{Math.max(0, bulkPresent)}</b> present day{bulkPresent === 1 ? '' : 's'}{bulkLeaveTotal ? <> · <b>{bulkLeaveTotal}</b> leave day{bulkLeaveTotal === 1 ? '' : 's'}</> : null} · {bulk.staff_ids.length} staff</> : 'Choose at least one person'}</span>
            <div><button type="button" className="plv-btn" onClick={() => setBulk(null)}>Cancel</button>
              <button type="button" className="plv-btn primary" onClick={submitBulk} disabled={bulk.saving || !bulk.staff_ids.length || bulk.reason.trim().length < 3 || !bulk.range?.[0]}>{bulk.saving ? 'Saving…' : 'Save attendance'}</button></div>
          </div>
        )}>
        {bulk && (
          <div className="ar-form">
            <div className="ar-three">
              <div className="ar-field"><label>Days</label>
                <DatePicker.RangePicker value={bulk.range} onChange={(v) => v && setBulk({ ...bulk, range: v })} allowClear={false} format="D MMM YYYY" disabledDate={(d) => d.isAfter(dayjs(), 'day')} /></div>
              <div className="ar-field"><label>Check in</label><Input type="time" value={bulk.in_time} onChange={(e) => setBulk({ ...bulk, in_time: e.target.value })} /></div>
              <div className="ar-field"><label>Check out</label><Input type="time" value={bulk.out_time} onChange={(e) => setBulk({ ...bulk, out_time: e.target.value })} /></div>
            </div>
            <Checkbox checked={bulk.include_weekly_off} onChange={(e) => setBulk({ ...bulk, include_weekly_off: e.target.checked })}>Include weekly off days</Checkbox>

            <div className="ar-field"><label>Staff and leave <em>{bulkDays.length} working day{bulkDays.length === 1 ? '' : 's'} in range</em></label>
              <div className="ar-bl">
                <div className="ar-bl-row ar-bl-head">
                  <Checkbox checked={bulk.staff_ids.length === rows.length && rows.length > 0} indeterminate={bulk.staff_ids.length > 0 && bulk.staff_ids.length < rows.length}
                    onChange={(e) => setBulk({ ...bulk, staff_ids: e.target.checked ? rows.map((s) => s.staff_id) : [] })} />
                  <span>Staff</span><span>Leave days</span><span>Leave type</span><span className="r">Result</span>
                </div>
                <div className="ar-bl-body">
                  {rows.map((s) => {
                    const on = bulk.staff_ids.includes(s.staff_id); const l = bulk.leaves[s.staff_id] || { dates: [], type: 'paid' }; const n = on ? (l.dates?.length || 0) : 0;
                    return (
                      <div key={s.staff_id} className={`ar-bl-row${on ? '' : ' is-off'}`}>
                        <Checkbox checked={on} onChange={(e) => toggleBulkStaff(s.staff_id, e.target.checked)} />
                        <div className="plv-party-inline"><Avatar name={s.name} size={26} /><span className="ar-mname">{nameOf(s)}</span></div>
                        <DatePicker multiple disabled={!on} value={l.dates} onChange={(v) => setBulkLeave(s.staff_id, { dates: v || [] })} format="D MMM" maxTagCount="responsive" placeholder="No leave" size="small"
                          disabledDate={(d) => d.isBefore(bulk.range[0], 'day') || d.isAfter(bulk.range[1], 'day')} />
                        {n ? <Select size="small" value={l.type} onChange={(v) => setBulkLeave(s.staff_id, { type: v })} options={[{ label: 'Paid', value: 'paid' }, { label: 'Unpaid', value: 'unpaid' }]} popupClassName="ar-pop" />
                          : <span className="ar-dash">—</span>}
                        <span className="ar-bl-res r">{on ? <><b className="tx-ok">{Math.max(0, bulkDays.length - n)}</b> present{n ? <>, <b className="tx-leave">{n}</b> leave</> : null}</> : <span className="ar-dash">Skipped</span>}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <p className="ar-hint">Days that already have a check-in or leave, and days before someone joined, are left as they are.</p>
            </div>
            <div className="ar-field"><label>Reason <em>the staff member sees this</em></label>
              <Input maxLength={300} value={bulk.reason} onChange={(e) => setBulk({ ...bulk, reason: e.target.value })} /></div>
          </div>
        )}
      </Modal>

      <Modal rootClassName="ar-pop" open={!!voiding} title={voiding ? `Remove ${voiding.label}?` : ''} okText="Remove" onOk={doVoid} onCancel={() => setVoiding(null)} width={440}
        okButtonProps={{ danger: true, disabled: !voiding || voiding.reason.trim().length < 3 }} destroyOnHidden>
        {voiding && (
          <div className="ar-form">
            <p className="ar-hint">It stays on record as removed and is never deleted.</p>
            <div className="ar-field"><label>Reason <em>the staff member sees this</em></label>
              <Input.TextArea rows={2} maxLength={300} value={voiding.reason} autoFocus onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} /></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
