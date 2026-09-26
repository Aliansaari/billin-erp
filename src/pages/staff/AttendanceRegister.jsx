import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, DatePicker, Segmented, Tooltip, Modal, Input, Select, message, Empty, Alert, Checkbox, Drawer, Dropdown, Space, Tag,
} from 'antd';
import {
  SyncOutlined, SettingOutlined, PlusOutlined, WifiOutlined, EnvironmentOutlined, SafetyCertificateOutlined,
  WarningOutlined, CameraOutlined, LeftOutlined, RightOutlined, MoreOutlined, CalendarOutlined, SearchOutlined,
  CheckCircleOutlined, CoffeeOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { staffAttendanceAPI } from '../../api';
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
 */

const STATUS = {
  working:    { label: 'In the shop',  tone: 'working', short: 'W' },
  present:    { label: 'Present',      tone: 'ok',      short: 'P' },
  late:       { label: 'Late',         tone: 'warn',    short: 'L' },
  absent:     { label: 'Absent',       tone: 'bad',     short: 'A' },
  leave:      { label: 'On leave',     tone: 'leave',   short: 'LV' },
  off:        { label: 'Weekly off',   tone: 'off',     short: 'O' },
  unverified: { label: 'Not verified', tone: 'unv',     short: 'U' },
  not_in:     { label: 'Not in yet',   tone: 'idle',    short: '' },
  none:       { label: '',             tone: 'idle',    short: '' },
};
const statusOf = (d) => (d?.working ? STATUS.working : STATUS[d?.status] || STATUS.none);

const FLAG = {
  network: 'Wi-Fi doubtful', location: 'Away from shop', shared_phone: 'Shared phone', voided: 'Corrected', manual: 'Added by owner',
};
const NET = {
  match: { label: 'Shop Wi-Fi', color: 'green' }, pending: { label: 'Wi-Fi not confirmed', color: 'orange' },
  mismatch: { label: 'Not on shop Wi-Fi', color: 'red' }, off: { label: 'Wi-Fi not checked', color: 'default' },
};
const AVATAR_HUES = [12, 32, 160, 200, 262, 330, 90, 45];

const hours = (min) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '');
const hhmm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const hue = (n) => AVATAR_HUES[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_HUES.length];

function Avatar({ name, size = 36 }) {
  const h = hue(name);
  return (
    <span className="ar-avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${h} 70% 92%)`, color: `hsl(${h} 55% 32%)` }}>
      {initials(name)}
    </span>
  );
}

function Selfie({ punchId, size = 40, onOpen }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true; let made = null;
    staffAttendanceAPI.getSelfie(punchId)
      .then(({ data }) => { if (!alive) return; made = URL.createObjectURL(data); setUrl(made); })
      .catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [punchId]);
  if (!url) return <span className="ar-selfie ar-selfie-empty" style={{ width: size, height: size }}><CameraOutlined /></span>;
  return <img src={url} alt="Check-in" className="ar-selfie" style={{ width: size, height: size }} onClick={(e) => { e.stopPropagation(); onOpen?.(url); }} />;
}

export default function AttendanceRegister() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('day');
  const [date, setDate] = useState(dayjs());
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState(null);      // { staffId, date }
  const [preview, setPreview] = useState(null);
  const [adding, setAdding] = useState(null);
  const [voiding, setVoiding] = useState(null);    // { kind: 'punch'|'leave', id, label, reason }
  const [leaveForm, setLeaveForm] = useState(null);
  const [bulk, setBulk] = useState(null);

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
    } finally {
      setLoading(false);
    }
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const cfg = data?.config || {};
  const off = cfg.tz_offset_min ?? 330;
  const fmt = (ms) => (ms ? dayjs(ms + (off - dayjs(ms).utcOffset()) * 60000).format('h:mm A') : '');
  const minOfDay = (ms) => { const d = new Date(ms + off * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const staffById = useMemo(() => new Map((data?.staff || []).map((s) => [s.staff_id, s])), [data]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { data: r } = await staffAttendanceAPI.syncNow();
      message.success(r?.received ? `${r.received} new punch(es) from phones` : 'Up to date');
      await load();
    } catch (err) { message.error(err?.response?.data?.error || 'Sync failed'); } finally { setSyncing(false); }
  };

  // ── derived: the selected day's rows + KPIs ──
  const dayIso = range.from;
  const rows = useMemo(() => (data?.staff || []).map((s) => ({ ...s, day: s.days[dayIso] })), [data, dayIso]);
  const counts = useMemo(() => {
    const c = { all: rows.length, working: 0, present: 0, late: 0, leave: 0, absent: 0, not_in: 0, worked: 0 };
    for (const r of rows) {
      const d = r.day || {};
      if (d.working) c.working++;
      if (d.status === 'present' || d.status === 'late') c.present++;
      if (d.status === 'late') c.late++;
      if (d.status === 'leave') c.leave++;
      if (d.status === 'absent' || d.status === 'unverified') c.absent++;
      if (d.status === 'not_in') c.not_in++;
      c.worked += d.worked_min || 0;
    }
    return c;
  }, [rows]);
  const monthTotals = useMemo(() => {
    const t = { present: 0, late: 0, leave: 0, absent: 0, worked: 0 };
    for (const s of data?.staff || []) {
      t.present += s.summary.present; t.late += s.summary.late; t.leave += s.summary.leave || 0;
      t.absent += s.summary.absent; t.worked += s.summary.worked_min;
    }
    t.rate = t.present + t.absent ? Math.round((t.present / (t.present + t.absent)) * 100) : null;
    return t;
  }, [data]);

  const visible = rows.filter((r) => {
    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false;
    const d = r.day || {};
    switch (filter) {
      case 'working': return !!d.working;
      case 'late': return d.status === 'late';
      case 'leave': return d.status === 'leave';
      case 'absent': return d.status === 'absent' || d.status === 'unverified';
      case 'not_in': return d.status === 'not_in';
      default: return true;
    }
  });

  // ── actions ──
  const doVoid = async () => {
    try {
      if (voiding.kind === 'leave') await staffAttendanceAPI.voidLeave(voiding.id, voiding.reason);
      else await staffAttendanceAPI.voidPunch(voiding.id, voiding.reason);
      message.success('Removed. The staff member will see your reason.');
      setVoiding(null); await load();
    } catch (err) { message.error(err?.response?.data?.error || 'Could not remove'); }
  };
  const doAdd = async () => {
    try { await staffAttendanceAPI.addPunch(adding); message.success('Punch added.'); setAdding(null); await load(); }
    catch (err) { message.error(err?.response?.data?.error || 'Could not add the punch'); }
  };
  const openLeave = (staffId, iso) => setLeaveForm({ staff_id: staffId ?? data?.staff?.[0]?.staff_id, dates: [dayjs(iso || dayIso)], leave_type: 'paid', reason: '' });
  const doLeave = async () => {
    try {
      const { data: r } = await staffAttendanceAPI.addLeave({
        staff_id: leaveForm.staff_id, dates: leaveForm.dates.map((d) => d.format('YYYY-MM-DD')), leave_type: leaveForm.leave_type, reason: leaveForm.reason,
      });
      message.success(`${r.added} leave day(s) recorded${r.already ? `, ${r.already} already on leave` : ''}.`);
      setLeaveForm(null); await load();
    } catch (err) { message.error(err?.response?.data?.error || 'Could not record leave'); }
  };

  const openBulk = () => {
    const end = dayjs(range.to).isAfter(dayjs()) ? dayjs() : dayjs(range.to);
    setBulk({
      staff_ids: (data?.staff || []).map((s) => s.staff_id),
      range: [dayjs(range.from), end], in_time: cfg.open_time || '10:00', out_time: cfg.close_time || '21:00',
      reason: 'Marked present by owner', include_weekly_off: false, leaves: {}, saving: false,
    });
  };
  const bulkDays = useMemo(() => {
    if (!bulk?.range?.[0]) return [];
    const out = []; const wo = new Set((cfg.weekly_off || []).map(Number));
    for (let d = bulk.range[0].startOf('day'); !d.isAfter(bulk.range[1], 'day'); d = d.add(1, 'day')) {
      if (bulk.include_weekly_off || !wo.has(d.day())) out.push(d.format('YYYY-MM-DD'));
    }
    return out;
  }, [bulk, cfg.weekly_off]);
  const setLeave = (sid, patch) => setBulk((b) => ({ ...b, leaves: { ...b.leaves, [sid]: { dates: [], type: 'paid', ...b.leaves[sid], ...patch } } }));
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
      const notes = [sk.existing && `${sk.existing} already had a check-in`, sk.on_leave && `${sk.on_leave} already on leave`,
        sk.weekly_off && `${sk.weekly_off} weekly off`, sk.before_joining && `${sk.before_joining} before joining`, sk.future && `${sk.future} in the future`].filter(Boolean);
      message.success(`Marked ${r.created_days} day(s) present${r.leave_days ? ` and ${r.leave_days} leave day(s)` : ''}${notes.length ? `. Skipped: ${notes.join(', ')}` : ''}.`, 7);
      setBulk(null); await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Could not mark attendance');
      setBulk((b) => b && ({ ...b, saving: false }));
    }
  };

  // ── pieces ──
  const openMin = hhmm(cfg.open_time) ?? 600; const closeMin = hhmm(cfg.close_time) ?? 1260;
  const span = Math.max(60, closeMin - openMin + 120);
  const pos = (min) => `${Math.min(100, Math.max(0, ((min - (openMin - 60)) / span) * 100))}%`;
  function Timeline({ d }) {
    const shift = <div className="ar-tl-shift" style={{ left: pos(openMin), width: `calc(${pos(closeMin)} - ${pos(openMin)})` }} />;
    if (!d?.in_at) return <div className="ar-tl">{shift}</div>;
    const a = minOfDay(d.in_at); const b = d.out_at ? minOfDay(d.out_at) : (d.working ? minOfDay(Date.now()) : a);
    return (
      <div className="ar-tl">
        {shift}
        <div className={`ar-tl-work${d.working ? ' is-live' : ''}${d.auto_out ? ' is-auto' : ''}`} style={{ left: pos(a), width: `calc(${pos(b)} - ${pos(a)})` }} />
      </div>
    );
  }
  const Pill = ({ d }) => { const s = statusOf(d); return s.label ? <span className={`ar-pill t-${s.tone}`}>{s.label}{d?.status === 'leave' ? ` · ${d.leave?.type === 'unpaid' ? 'Unpaid' : 'Paid'}` : ''}</span> : null; };

  const rowMenu = (r) => ({
    items: [
      { key: 'punch', icon: <PlusOutlined />, label: 'Add punch', onClick: () => setAdding({ staff_id: r.staff_id, kind: r.day?.working ? 'out' : 'in', date: dayIso, time: dayjs().format('HH:mm'), reason: '' }) },
      r.day?.leave
        ? { key: 'unleave', icon: <CoffeeOutlined />, label: 'Remove leave', onClick: () => setVoiding({ kind: 'leave', id: r.day.leave.leave_id, label: `${r.name}'s leave on ${dayjs(dayIso).format('D MMM')}`, reason: '' }) }
        : { key: 'leave', icon: <CoffeeOutlined />, label: 'Mark leave', onClick: () => openLeave(r.staff_id, dayIso) },
      { key: 'month', icon: <CalendarOutlined />, label: 'See month', onClick: () => setMode('month') },
    ],
  });

  const drawerStaff = drawer ? staffById.get(drawer.staffId) : null;
  const drawerDay = drawerStaff ? drawerStaff.days[drawer.date] : null;

  const kpis = mode === 'day' ? [
    { k: 'working', label: 'In the shop now', value: counts.working, tone: 'working' },
    { k: 'present', label: 'Came in', value: `${counts.present}/${counts.all}`, tone: 'ok' },
    { k: 'late', label: 'Late', value: counts.late, tone: 'warn' },
    { k: 'leave', label: 'On leave', value: counts.leave, tone: 'leave' },
    { k: 'absent', label: 'Absent', value: counts.absent, tone: 'bad' },
    { k: 'hours', label: 'Hours worked', value: hours(counts.worked) || '0h', tone: 'idle' },
  ] : [
    { k: 'rate', label: 'Attendance', value: monthTotals.rate == null ? '-' : `${monthTotals.rate}%`, tone: 'ok' },
    { k: 'present', label: 'Days present', value: monthTotals.present, tone: 'ok' },
    { k: 'late', label: 'Late marks', value: monthTotals.late, tone: 'warn' },
    { k: 'leave', label: 'Leave days', value: monthTotals.leave, tone: 'leave' },
    { k: 'absent', label: 'Absences', value: monthTotals.absent, tone: 'bad' },
    { k: 'hours', label: 'Hours worked', value: hours(monthTotals.worked) || '0h', tone: 'idle' },
  ];

  const step = (n) => setDate((d) => d.add(n, mode === 'day' ? 'day' : 'month'));
  const isToday = mode === 'day' ? date.isSame(dayjs(), 'day') : date.isSame(dayjs(), 'month');

  return (
    <div className="ar-page">
      <header className="ar-head">
        <div>
          <h1>Staff Attendance</h1>
          <p>{mode === 'day' ? date.format('dddd, D MMMM YYYY') : date.format('MMMM YYYY')} · from staff phones, in shop time
            {settings?.last_sync_at && <> · synced {dayjs(settings.last_sync_at).format('h:mm A')}</>}</p>
        </div>
        <div className="ar-tools">
          <Segmented value={mode} onChange={setMode} options={[{ label: 'Day', value: 'day' }, { label: 'Month', value: 'month' }]} />
          <div className="ar-datenav">
            <Button type="text" icon={<LeftOutlined />} onClick={() => step(-1)} aria-label="Previous" />
            {mode === 'day'
              ? <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} format="D MMM YYYY" variant="borderless" />
              : <DatePicker picker="month" value={date} onChange={(d) => d && setDate(d)} allowClear={false} format="MMM YYYY" variant="borderless" />}
            <Button type="text" icon={<RightOutlined />} onClick={() => step(1)} disabled={isToday} aria-label="Next" />
          </div>
          {!isToday && <Button onClick={() => setDate(dayjs())}>Today</Button>}
          <Tooltip title="Fetch new punches from staff phones"><Button icon={<SyncOutlined spin={syncing} />} onClick={sync} loading={syncing}>Sync</Button></Tooltip>
          <Button icon={<CoffeeOutlined />} onClick={() => openLeave()} disabled={!data?.staff?.length}>Mark leave</Button>
          <Button type="primary" icon={<CheckCircleOutlined />} onClick={openBulk} disabled={!data?.staff?.length}>Mark present</Button>
          <Tooltip title="Staff & rules"><Button icon={<SettingOutlined />} onClick={() => navigate('/settings/staff-attendance')} /></Tooltip>
        </div>
      </header>

      {settings && !settings.enabled && (
        <Alert type="info" showIcon className="ar-alert" message="Staff attendance is off"
          description="Turn it on and add your staff in Staff & rules. Staff then check in from their own phones."
          action={<Button size="small" type="primary" onClick={() => navigate('/settings/staff-attendance')}>Set up</Button>} />
      )}
      {settings?.enabled && settings?.last_sync_error && (
        <Alert type="warning" showIcon className="ar-alert" message="Could not reach staff phones" description={settings.last_sync_error} />
      )}

      <section className="ar-kpis">
        {kpis.map((k) => (
          <button key={k.k} type="button" className={`ar-kpi t-${k.tone}${mode === 'day' && filter === k.k ? ' is-on' : ''}`}
            onClick={() => mode === 'day' && ['working', 'late', 'leave', 'absent'].includes(k.k) && setFilter(filter === k.k ? 'all' : k.k)}>
            <span className="ar-kpi-v">{k.value}</span><span className="ar-kpi-l">{k.label}</span>
          </button>
        ))}
      </section>

      {mode === 'day' ? (
        <section className="ar-card">
          <div className="ar-filterbar">
            <div className="ar-chips">
              {[['all', `All ${counts.all}`], ['working', `In shop ${counts.working}`], ['late', `Late ${counts.late}`], ['leave', `Leave ${counts.leave}`],
                ['absent', `Absent ${counts.absent}`], ['not_in', `Not in ${counts.not_in}`]].map(([k, l]) => (
                <button key={k} type="button" className={`ar-chip${filter === k ? ' is-on' : ''}`} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            <Input allowClear prefix={<SearchOutlined />} placeholder="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
          </div>

          <div className="ar-rows-head"><span>Staff</span><span>Status</span><span>Shift {cfg.open_time || '10:00'} to {cfg.close_time || '21:00'}</span><span>In / Out</span><span>Worked</span><span>Checks</span><span /></div>
          {loading && !data ? <div className="ar-empty">Loading…</div> : visible.length === 0 ? (
            <div className="ar-empty"><Empty description={rows.length ? 'Nobody matches this filter' : 'No staff yet'} /></div>
          ) : visible.map((r) => {
            const d = r.day || {};
            const photo = (d.punches || []).find((p) => p.has_selfie && !p.voided_at);
            const live = (d.punches || []).filter((p) => !p.voided_at);
            return (
              <div key={r.staff_id} className="ar-row" onClick={() => setDrawer({ staffId: r.staff_id, date: dayIso })}>
                <div className="ar-who"><Avatar name={r.name} /><div><b>{r.name}</b><span>{r.phone ? `•••• ${String(r.phone).slice(-4)}` : ''}</span></div></div>
                <div><Pill d={d} /></div>
                <div><Timeline d={d} /></div>
                <div className="ar-times">{d.in_at ? <>{fmt(d.in_at)}<i>→</i>{d.out_at ? fmt(d.out_at) : (d.working ? 'now' : '-')}{d.auto_out && <Tooltip title={d.auto_basis === 'last_bill' ? 'Forgot to check out: closed at their last sales bill' : 'Forgot to check out: no later activity, closed at check-in'}><Tag color="purple" className="ar-tag">Auto</Tag></Tooltip>}</> : <span className="ar-muted">{d.leave?.reason || ''}</span>}</div>
                <div className="ar-worked">{hours(d.worked_min)}</div>
                <div className="ar-checks">
                  {live.some((p) => p.net_status === 'match') && <Tooltip title="On shop Wi-Fi"><WifiOutlined className="ok" /></Tooltip>}
                  {live.some((p) => p.net_status === 'mismatch' || p.net_status === 'pending') && <Tooltip title="Wi-Fi not confirmed"><WifiOutlined className="warn" /></Tooltip>}
                  {live.some((p) => p.passkey) && <Tooltip title="Fingerprint / Face ID"><SafetyCertificateOutlined className="ok" /></Tooltip>}
                  {live.some((p) => p.geo_status === 'outside') && <Tooltip title="Away from shop"><EnvironmentOutlined className="warn" /></Tooltip>}
                  {live.some((p) => p.device_shared) && <Tooltip title="Phone also used by another staff member"><WarningOutlined className="bad" /></Tooltip>}
                  {(d.flags || []).includes('manual') && <Tooltip title="Added by owner"><span className="ar-mini">owner</span></Tooltip>}
                  {photo && <Selfie punchId={photo.punch_id} size={32} onOpen={(url) => setPreview({ url, punch: photo, name: r.name })} />}
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <Dropdown menu={rowMenu(r)} trigger={['click']} placement="bottomRight"><Button type="text" icon={<MoreOutlined />} /></Dropdown>
                </div>
              </div>
            );
          })}
        </section>
      ) : (
        <section className="ar-card ar-month-wrap">
          <table className="ar-month">
            <thead>
              <tr>
                <th className="ar-sticky">Staff</th>
                {(data?.days || []).map((iso) => {
                  const d = dayjs(iso); const wo = (cfg.weekly_off || []).map(Number).includes(d.day());
                  return <th key={iso} className={`${iso === data.today ? 'is-today' : ''}${wo ? ' is-wo' : ''}`}><span>{d.format('dd')[0]}</span>{d.date()}</th>;
                })}
                <th className="ar-tot">Present</th><th className="ar-tot">Late</th><th className="ar-tot">Leave</th><th className="ar-tot">Absent</th><th className="ar-tot">Hours</th>
              </tr>
            </thead>
            <tbody>
              {(data?.staff || []).map((s) => (
                <tr key={s.staff_id}>
                  <td className="ar-sticky"><div className="ar-who"><Avatar name={s.name} size={28} /><b>{s.name}</b></div></td>
                  {data.days.map((iso) => {
                    const d = s.days[iso]; const st = statusOf(d);
                    return (
                      <td key={iso} className={iso === data.today ? 'is-today' : ''}>
                        {st.short ? (
                          <Tooltip title={[st.label, d.in_at && `In ${fmt(d.in_at)}`, d.out_at && `Out ${fmt(d.out_at)}${d.auto_out ? ' (auto)' : ''}`, d.leave && `${d.leave.type === 'unpaid' ? 'Unpaid' : 'Paid'} leave${d.leave.reason ? `: ${d.leave.reason}` : ''}`, ...(d.flags || []).map((f) => FLAG[f])].filter(Boolean).join(' · ')}>
                            <button type="button" className={`ar-cell t-${st.tone}${d.flags?.length ? ' has-flag' : ''}`} onClick={() => setDrawer({ staffId: s.staff_id, date: iso })}>{st.short}</button>
                          </Tooltip>
                        ) : (d && d.status !== 'none' ? <button type="button" className="ar-cell t-idle" onClick={() => setDrawer({ staffId: s.staff_id, date: iso })} /> : null)}
                      </td>
                    );
                  })}
                  <td className="ar-tot"><b>{s.summary.present}</b></td>
                  <td className="ar-tot">{s.summary.late || ''}</td>
                  <td className="ar-tot">{s.summary.leave || ''}</td>
                  <td className="ar-tot">{s.summary.absent || ''}</td>
                  <td className="ar-tot">{hours(s.summary.worked_min)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.staff?.length && <div className="ar-empty"><Empty description="No staff yet" /></div>}
          <div className="ar-legend">
            {['present', 'late', 'absent', 'leave', 'off', 'unverified', 'working'].map((k) => (
              <span key={k}><i className={`ar-cell t-${STATUS[k].tone}`}>{STATUS[k].short}</i>{STATUS[k].label}</span>
            ))}
            <span><i className="ar-cell t-ok has-flag">P</i>Needs a look</span>
          </div>
        </section>
      )}

      {/* ── staff day drawer ── */}
      <Drawer open={!!drawer} onClose={() => setDrawer(null)} width={460} destroyOnClose
        title={drawerStaff && <div className="ar-who"><Avatar name={drawerStaff.name} /><div><b>{drawerStaff.name}</b><span>{dayjs(drawer.date).format('dddd, D MMMM')}</span></div></div>}>
        {drawerStaff && (
          <div className="ar-drawer">
            <div className="ar-drawer-top"><Pill d={drawerDay} />{drawerDay?.worked_min ? <span className="ar-muted">{hours(drawerDay.worked_min)} worked</span> : null}</div>
            <Timeline d={drawerDay} />
            {drawerDay?.leave && (
              <div className="ar-leavebox"><CoffeeOutlined /><div><b>{drawerDay.leave.type === 'unpaid' ? 'Unpaid' : 'Paid'} leave</b><span>{drawerDay.leave.reason}</span></div>
                <Button size="small" danger type="link" onClick={() => setVoiding({ kind: 'leave', id: drawerDay.leave.leave_id, label: `${drawerStaff.name}'s leave`, reason: '' })}>Remove</Button></div>
            )}
            <h4>Punches</h4>
            {(drawerDay?.punches || []).length === 0 && <p className="ar-muted">No punches this day.</p>}
            {(drawerDay?.punches || []).map((p) => (
              <div key={p.punch_id} className={`ar-punch${p.voided_at ? ' is-void' : ''}`}>
                <b className="ar-kind">{p.kind.toUpperCase()}</b><span className="ar-time">{fmt(p.at)}</span>
                <div className="ar-punch-tags">
                  {p.source === 'manual' ? <Tag>Owner: {p.reason}</Tag> : (
                    <>
                      <Tag icon={<WifiOutlined />} color={NET[p.net_status]?.color}>{NET[p.net_status]?.label || p.net_status}</Tag>
                      {p.passkey && <Tag icon={<SafetyCertificateOutlined />} color="blue">Fingerprint</Tag>}
                      {p.geo_status === 'inside' && <Tag icon={<EnvironmentOutlined />} color="green">{Math.round(p.distance_m || 0)} m from shop</Tag>}
                      {p.geo_status === 'outside' && <Tag icon={<EnvironmentOutlined />} color="orange">{((p.distance_m || 0) / 1000).toFixed(1)} km away</Tag>}
                      {p.device_shared && <Tag icon={<WarningOutlined />} color="red">Shared phone</Tag>}
                      {p.prompt && <Tag icon={<CameraOutlined />}>Asked: {p.prompt}</Tag>}
                    </>
                  )}
                </div>
                {p.has_selfie && <Selfie punchId={p.punch_id} size={44} onOpen={(url) => setPreview({ url, punch: p, name: drawerStaff.name })} />}
                {p.voided_at ? <span className="ar-muted">Removed: {p.void_reason}</span>
                  : <Button size="small" type="link" danger onClick={() => setVoiding({ kind: 'punch', id: p.punch_id, label: `${p.kind.toUpperCase()} at ${fmt(p.at)}`, reason: '' })}>Remove</Button>}
              </div>
            ))}
            <Space style={{ marginTop: 16 }}>
              <Button icon={<PlusOutlined />} onClick={() => setAdding({ staff_id: drawerStaff.staff_id, kind: drawerDay?.working ? 'out' : 'in', date: drawer.date, time: dayjs().format('HH:mm'), reason: '' })}>Add punch</Button>
              {!drawerDay?.leave && <Button icon={<CoffeeOutlined />} onClick={() => openLeave(drawerStaff.staff_id, drawer.date)}>Mark leave</Button>}
            </Space>
            <h4 style={{ marginTop: 22 }}>This {mode === 'day' ? 'day' : 'month'}</h4>
            <div className="ar-drawer-sum">
              <span><b>{drawerStaff.summary.present}</b>present</span><span><b>{drawerStaff.summary.late}</b>late</span>
              <span><b>{drawerStaff.summary.leave || 0}</b>leave</span><span><b>{drawerStaff.summary.absent}</b>absent</span>
            </div>
          </div>
        )}
      </Drawer>

      {/* ── modals ── */}
      <Modal open={!!preview} footer={null} onCancel={() => setPreview(null)} width={420}
        title={preview ? `${preview.name} · ${preview.punch.kind.toUpperCase()} ${fmt(preview.punch.at)}` : ''}>
        {preview && <div style={{ textAlign: 'center' }}>{preview.punch.prompt && <p style={{ marginTop: 0 }}>They were asked to: <b>{preview.punch.prompt}</b></p>}
          <img src={preview.url} alt="Check-in" style={{ maxWidth: '100%', borderRadius: 10 }} /></div>}
      </Modal>

      <Modal open={!!adding} title="Add a punch" okText="Add punch" onOk={doAdd} onCancel={() => setAdding(null)}
        okButtonProps={{ disabled: !adding || adding.reason.trim().length < 3 }} destroyOnClose>
        {adding && (
          <div className="ar-form">
            <label>Staff</label>
            <Select value={adding.staff_id} onChange={(v) => setAdding({ ...adding, staff_id: v })} options={(data?.staff || []).map((s) => ({ value: s.staff_id, label: s.name }))} />
            <label>Punch</label>
            <Segmented value={adding.kind} onChange={(v) => setAdding({ ...adding, kind: v })} options={[{ label: 'IN', value: 'in' }, { label: 'OUT', value: 'out' }]} />
            <label>Date and time</label>
            <Space><Input type="date" value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} />
              <Input type="time" value={adding.time} onChange={(e) => setAdding({ ...adding, time: e.target.value })} /></Space>
            <label>Reason (the staff member will see this)</label>
            <Input.TextArea rows={2} maxLength={300} value={adding.reason} placeholder="e.g. Phone battery was dead" onChange={(e) => setAdding({ ...adding, reason: e.target.value })} />
          </div>
        )}
      </Modal>

      <Modal open={!!leaveForm} title="Mark leave" okText="Mark leave" onOk={doLeave} onCancel={() => setLeaveForm(null)}
        okButtonProps={{ disabled: !leaveForm || !leaveForm.dates?.length || leaveForm.reason.trim().length < 3 }} destroyOnClose>
        {leaveForm && (
          <div className="ar-form">
            <label>Staff</label>
            <Select value={leaveForm.staff_id} onChange={(v) => setLeaveForm({ ...leaveForm, staff_id: v })} options={(data?.staff || []).map((s) => ({ value: s.staff_id, label: s.name }))} />
            <label>Leave days {leaveForm.dates?.length ? <b>· {leaveForm.dates.length} day(s)</b> : null}</label>
            <DatePicker multiple value={leaveForm.dates} onChange={(v) => setLeaveForm({ ...leaveForm, dates: v || [] })} format="D MMM" maxTagCount="responsive" style={{ width: '100%' }} />
            <label>Type</label>
            <Segmented value={leaveForm.leave_type} onChange={(v) => setLeaveForm({ ...leaveForm, leave_type: v })} options={[{ label: 'Paid leave', value: 'paid' }, { label: 'Unpaid leave', value: 'unpaid' }]} />
            <label>Reason (the staff member will see this)</label>
            <Input.TextArea rows={2} maxLength={300} value={leaveForm.reason} placeholder="e.g. Sick, family function" onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })} />
          </div>
        )}
      </Modal>

      <Modal open={!!bulk} title="Mark present" okText="Save attendance" onOk={submitBulk} onCancel={() => setBulk(null)} confirmLoading={bulk?.saving}
        okButtonProps={{ disabled: !bulk || !bulk.staff_ids.length || bulk.reason.trim().length < 3 || !bulk.range?.[0] }} destroyOnClose width={680}>
        {bulk && (
          <div className="ar-form">
            <p className="ar-muted" style={{ marginTop: 0 }}>
              Marks the chosen staff present on every day in the range, except the leave days you pick below. Days that already have a check-in, weekly offs
              and future days are skipped, and nothing existing is changed. Staff see your reason.
            </p>
            <div className="ar-grid2">
              <div><label>Days</label>
                <DatePicker.RangePicker value={bulk.range} onChange={(v) => v && setBulk({ ...bulk, range: v })} allowClear={false} format="D MMM YYYY" disabledDate={(d) => d.isAfter(dayjs(), 'day')} style={{ width: '100%' }} /></div>
              <div><label>Shift</label>
                <Space><Input type="time" value={bulk.in_time} onChange={(e) => setBulk({ ...bulk, in_time: e.target.value })} /><span>to</span>
                  <Input type="time" value={bulk.out_time} onChange={(e) => setBulk({ ...bulk, out_time: e.target.value })} /></Space></div>
            </div>
            <label>Staff</label>
            <Select mode="multiple" value={bulk.staff_ids} onChange={(v) => setBulk({ ...bulk, staff_ids: v })} maxTagCount="responsive" placeholder="Choose staff"
              options={(data?.staff || []).map((s) => ({ value: s.staff_id, label: s.name }))} />
            <Checkbox checked={bulk.include_weekly_off} onChange={(e) => setBulk({ ...bulk, include_weekly_off: e.target.checked })} style={{ marginTop: 8 }}>Include weekly off days</Checkbox>

            <label>Leave in this period</label>
            <div className="ar-bulk-leave">
              {bulk.staff_ids.map((sid) => {
                const s = staffById.get(sid); const l = bulk.leaves[sid] || { dates: [], type: 'paid' };
                const leaveN = (l.dates || []).length; const presentN = Math.max(0, bulkDays.length - leaveN);
                return (
                  <div key={sid} className="ar-bl-row">
                    <div className="ar-who"><Avatar name={s?.name} size={28} /><b>{s?.name}</b></div>
                    <DatePicker multiple value={l.dates} onChange={(v) => setLeave(sid, { dates: v || [] })} format="D MMM" maxTagCount="responsive" placeholder="No leave"
                      disabledDate={(d) => d.isBefore(bulk.range[0], 'day') || d.isAfter(bulk.range[1], 'day')} style={{ minWidth: 190 }} />
                    <Segmented size="small" value={l.type} onChange={(v) => setLeave(sid, { type: v })} options={[{ label: 'Paid', value: 'paid' }, { label: 'Unpaid', value: 'unpaid' }]} />
                    <span className="ar-bl-count"><b>{presentN}</b> present · <b>{leaveN}</b> leave</span>
                  </div>
                );
              })}
            </div>
            <label>Reason (the staff member will see this)</label>
            <Input.TextArea rows={2} maxLength={300} value={bulk.reason} onChange={(e) => setBulk({ ...bulk, reason: e.target.value })} />
          </div>
        )}
      </Modal>

      <Modal open={!!voiding} title={voiding ? `Remove ${voiding.label}?` : ''} okText="Remove" onOk={doVoid} onCancel={() => setVoiding(null)}
        okButtonProps={{ danger: true, disabled: !voiding || voiding.reason.trim().length < 3 }} destroyOnClose>
        {voiding && (
          <div className="ar-form">
            <p style={{ marginTop: 0 }}>It stays on record as removed and is never deleted.</p>
            <label>Reason (the staff member will see this)</label>
            <Input.TextArea rows={2} maxLength={300} value={voiding.reason} autoFocus onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
          </div>
        )}
      </Modal>
    </div>
  );
}
