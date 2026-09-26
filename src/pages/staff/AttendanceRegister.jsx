import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, DatePicker, Segmented, Tooltip, Modal, Input, Select, message, Alert, Checkbox, Drawer, Dropdown, Tag,
} from 'antd';
import {
  SyncOutlined, SettingOutlined, PlusOutlined, WifiOutlined, EnvironmentOutlined, SafetyCertificateOutlined,
  WarningOutlined, CameraOutlined, LeftOutlined, RightOutlined, MoreOutlined, SearchOutlined, CheckOutlined,
  CoffeeOutlined, DownOutlined, UserOutlined,
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

// Status → label, colour key, month-grid letter, and sort order on the day view.
const STATUS = {
  working:    { label: 'In the shop',  tone: 'work',  short: 'W',  order: 0 },
  late:       { label: 'Late',         tone: 'late',  short: 'L',  order: 1 },
  present:    { label: 'Present',      tone: 'ok',    short: 'P',  order: 2 },
  unverified: { label: 'Not verified', tone: 'unv',   short: 'U',  order: 3 },
  absent:     { label: 'Absent',       tone: 'bad',   short: 'A',  order: 4 },
  not_in:     { label: 'Not in yet',   tone: 'idle',  short: '',   order: 5 },
  leave:      { label: 'On leave',     tone: 'leave', short: 'LV', order: 6 },
  off:        { label: 'Weekly off',   tone: 'off',   short: 'O',  order: 7 },
  none:       { label: '',             tone: 'idle',  short: '',   order: 8 },
};
const statusKey = (d) => (d?.working ? 'working' : (STATUS[d?.status] ? d.status : 'none'));
const FLAG = { network: 'Wi-Fi doubtful', location: 'Away from shop', shared_phone: 'Shared phone', voided: 'Corrected', manual: 'Added by owner' };
const NET = {
  match: { label: 'Shop Wi-Fi', color: 'green' }, pending: { label: 'Wi-Fi not confirmed', color: 'orange' },
  mismatch: { label: 'Not on shop Wi-Fi', color: 'red' }, off: { label: 'Wi-Fi not checked', color: 'default' },
};
const QUICK_REASONS = ['Sick', 'Personal work', 'Family function', 'Festival', 'Out of town'];

const hm = (min) => (min > 0 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '0h');
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const HUES = [14, 36, 158, 198, 258, 318, 96, 48];
const hueOf = (n) => HUES[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

function Avatar({ name, size = 34 }) {
  return <span className="ar-av" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), '--h': hueOf(name) }}>{initials(name)}</span>;
}

function Selfie({ punchId, size = 30, onOpen }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true; let made = null;
    staffAttendanceAPI.getSelfie(punchId).then(({ data }) => { if (alive) { made = URL.createObjectURL(data); setUrl(made); } }).catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [punchId]);
  if (!url) return <span className="ar-selfie is-empty" style={{ width: size, height: size }}><CameraOutlined /></span>;
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
  const [filter, setFilter] = useState(null);
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState(null);
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
  const lateBy = (d) => (d?.in_at ? minOfDay(d.in_at) - openMin - (Number(cfg.grace_min) || 0) : null);
  const liveMin = (d) => (d?.worked_min || 0) + (d?.working && d?.punches ? Math.max(0, Math.round((Date.now() - Math.max(...d.punches.filter((p) => p.kind === 'in' && !p.voided_at).map((p) => p.at), 0)) / 60000)) : 0);
  const staffById = useMemo(() => new Map((data?.staff || []).map((s) => [s.staff_id, s])), [data]);

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
  const rows = useMemo(() => (data?.staff || []).map((s) => ({ ...s, day: s.days[dayIso] || {}, key: statusKey(s.days[dayIso]) }))
    .sort((a, b) => STATUS[a.key].order - STATUS[b.key].order || a.name.localeCompare(b.name)), [data, dayIso]);
  const groups = useMemo(() => {
    const g = { working: 0, left: 0, leave: 0, absent: 0, not_in: 0, off: 0, late: 0 };
    for (const r of rows) {
      if (r.key === 'working') g.working++;
      else if (r.key === 'present' || r.key === 'late') g.left++;
      else if (r.key === 'leave') g.leave++;
      else if (r.key === 'absent' || r.key === 'unverified') g.absent++;
      else if (r.key === 'off') g.off++;
      else g.not_in++;
      if (r.day.status === 'late') g.late++;
    }
    return g;
  }, [rows]);
  const hoursToday = rows.reduce((a, r) => a + liveMin(r.day), 0);
  const inGroup = (r, f) => ({
    working: r.key === 'working', left: r.key === 'present' || (r.key === 'late' && !r.day.working), leave: r.key === 'leave',
    absent: r.key === 'absent' || r.key === 'unverified', not_in: r.key === 'not_in' || r.key === 'none', late: r.day.status === 'late', off: r.key === 'off',
  }[f]);
  const visible = rows.filter((r) => (!search || r.name.toLowerCase().includes(search.toLowerCase())) && (!filter || inGroup(r, filter)));

  const monthTotals = useMemo(() => {
    const t = { present: 0, late: 0, leave: 0, absent: 0, worked: 0 };
    for (const s of data?.staff || []) { t.present += s.summary.present; t.late += s.summary.late; t.leave += s.summary.leave || 0; t.absent += s.summary.absent; t.worked += s.summary.worked_min; }
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
  const bulkLeaveTotal = bulk ? bulk.staff_ids.reduce((a, sid) => a + (bulk.leaves[sid]?.dates?.length || 0), 0) : 0;
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

  // ── pieces ──
  const scaleFrom = Math.floor((openMin - 60) / 60) * 60; const scaleTo = Math.ceil((closeMin + 60) / 60) * 60;
  const pct = (min) => `${Math.min(100, Math.max(0, ((min - scaleFrom) / (scaleTo - scaleFrom)) * 100))}%`;
  const ticks = []; for (let m = scaleFrom; m <= scaleTo; m += 120) ticks.push(m);
  const tickLabel = (m) => { const h = Math.floor(m / 60) % 24; return `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`; };

  function Timeline({ d }) {
    const work = [];
    const live = (d?.punches || []).filter((p) => !p.voided_at).sort((a, b) => a.at - b.at);
    let open = null;
    for (const p of live) { if (p.kind === 'in' && open === null) open = p.at; else if (p.kind === 'out' && open !== null) { work.push([open, p.at, false]); open = null; } }
    if (open !== null) work.push([open, d.working ? Date.now() : (d.out_at || open), d.working]);
    return (
      <div className="ar-tl">
        <div className="ar-tl-shift" style={{ left: pct(openMin), width: `calc(${pct(closeMin)} - ${pct(openMin)})` }} />
        {ticks.map((m) => <span key={m} className="ar-tl-tick" style={{ left: pct(m) }} />)}
        {work.map(([a, b, isLive], i) => (
          <div key={i} className={`ar-tl-bar${isLive ? ' is-live' : ''}${d.auto_out && i === work.length - 1 && !isLive ? ' is-auto' : ''}`}
            style={{ left: pct(minOfDay(a)), width: `max(4px, calc(${pct(minOfDay(b))} - ${pct(minOfDay(a))}))` }} />
        ))}
      </div>
    );
  }
  const Pill = ({ k, d }) => (STATUS[k].label ? (
    <span className={`ar-pill tone-${STATUS[k].tone}`}><i />{STATUS[k].label}{k === 'leave' && d?.leave ? ` · ${d.leave.type === 'unpaid' ? 'unpaid' : 'paid'}` : ''}</span>
  ) : null);
  const subline = (r) => {
    const d = r.day;
    if (r.key === 'leave') return d.leave?.reason || 'Leave';
    if (d.in_at) { const l = lateBy(d); return l > 0 ? <span className="tx-late">Late by {l >= 60 ? `${Math.floor(l / 60)}h ` : ''}{l % 60}m</span> : <span className="tx-ok">On time</span>; }
    if (r.key === 'not_in') return `Shift starts ${cfg.open_time || '10:00'}`;
    return r.phone ? `•••• ${String(r.phone).slice(-4)}` : '';
  };

  const drawerStaff = drawer ? staffById.get(drawer.staffId) : null;
  const drawerDay = drawerStaff ? (drawerStaff.days[drawer.date] || {}) : null;
  const isToday = mode === 'day' ? date.isSame(dayjs(), 'day') : date.isSame(dayjs(), 'month');
  const step = (n) => setDate((d) => d.add(n, mode === 'day' ? 'day' : 'month'));
  const total = rows.length || 1;
  const SEGS = [['working', 'In the shop'], ['left', 'Left for the day'], ['leave', 'On leave'], ['absent', 'Absent'], ['not_in', 'Not in yet'], ['off', 'Weekly off']];
  const markMenu = { items: [
    { key: 'present', icon: <CheckOutlined />, label: 'Mark present…', onClick: openBulk },
    { key: 'leave', icon: <CoffeeOutlined />, label: 'Mark leave…', onClick: () => openLeave() },
    { key: 'punch', icon: <PlusOutlined />, label: 'Add a punch…', onClick: () => openAdd() },
  ] };

  return (
    <div className="ar">
      <header className="ar-top">
        <div className="ar-title">
          <h1>Attendance</h1>
          <div className="ar-date">
            <button type="button" className="ar-iconbtn" onClick={() => step(-1)} aria-label="Previous"><LeftOutlined /></button>
            {mode === 'day'
              ? <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} format="ddd, D MMM YYYY" variant="borderless" suffixIcon={null} className="ar-datepick" />
              : <DatePicker picker="month" value={date} onChange={(d) => d && setDate(d)} allowClear={false} format="MMMM YYYY" variant="borderless" suffixIcon={null} className="ar-datepick" />}
            <button type="button" className="ar-iconbtn" onClick={() => step(1)} disabled={isToday} aria-label="Next"><RightOutlined /></button>
            {!isToday && <button type="button" className="ar-link" onClick={() => setDate(dayjs())}>Today</button>}
          </div>
        </div>
        <div className="ar-actions">
          <Segmented value={mode} onChange={(v) => { setMode(v); setFilter(null); }} options={[{ label: 'Day', value: 'day' }, { label: 'Month', value: 'month' }]} />
          <Tooltip title={settings?.last_sync_at ? `Last synced ${dayjs(settings.last_sync_at).format('h:mm A')}` : 'Fetch check-ins from phones'}>
            <Button icon={<SyncOutlined spin={syncing} />} onClick={sync} loading={syncing}>Sync</Button>
          </Tooltip>
          <Dropdown menu={markMenu} trigger={['click']} placement="bottomRight" disabled={!rows.length}>
            <Button type="primary">Mark attendance <DownOutlined /></Button>
          </Dropdown>
          <Tooltip title="Staff & rules"><Button icon={<SettingOutlined />} onClick={() => navigate('/settings/staff-attendance')} /></Tooltip>
        </div>
      </header>

      {settings && !settings.enabled && (
        <Alert type="info" showIcon className="ar-alert" message="Staff attendance is off" description="Turn it on and add your staff in Staff & rules. Staff then check in from their own phones."
          action={<Button size="small" type="primary" onClick={() => navigate('/settings/staff-attendance')}>Set up</Button>} />
      )}
      {settings?.enabled && settings?.last_sync_error && <Alert type="warning" showIcon className="ar-alert" message="Could not reach staff phones" description={settings.last_sync_error} />}

      {mode === 'day' ? (
        <>
          <section className="ar-summary">
            <div className="ar-sum-main">
              <div className="ar-sum-head">
                <b>{groups.working + groups.left} of {rows.length}</b> <span>came in {isToday ? 'today' : 'this day'}</span>
              </div>
              <div className="ar-stack">
                {SEGS.map(([k]) => groups[k] > 0 && <span key={k} className={`seg-${k}`} style={{ width: `${(groups[k] / total) * 100}%` }} />)}
              </div>
              <div className="ar-legend">
                {SEGS.filter(([k]) => k !== 'off' || groups.off).map(([k, l]) => (
                  <button key={k} type="button" className={`ar-lg${filter === k ? ' is-on' : ''}${groups[k] ? '' : ' is-zero'}`} disabled={!groups[k]} onClick={() => setFilter(filter === k ? null : k)}>
                    <i className={`seg-${k}`} />{l}<b>{groups[k]}</b>
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className={`ar-sum-stat${filter === 'late' ? ' is-on' : ''}`} disabled={!groups.late} onClick={() => setFilter(filter === 'late' ? null : 'late')}>
              <b className="tx-late">{groups.late}</b><span>Late</span>
            </button>
            <div className="ar-sum-stat"><b>{hm(hoursToday)}</b><span>Hours worked</span></div>
          </section>

          <section className="ar-table">
            <div className="ar-tbar">
              <div className="ar-tbar-l">{filter ? <><Tag closable onClose={() => setFilter(null)} className="ar-ftag">{SEGS.find(([k]) => k === filter)?.[1] || 'Late'}</Tag><span className="ar-muted">{visible.length} of {rows.length}</span></> : <span className="ar-muted">{rows.length} staff</span>}</div>
              <Input allowClear prefix={<SearchOutlined />} placeholder="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} className="ar-search" />
            </div>
            <div className="ar-row ar-head-row">
              <span>Staff</span><span>Status</span><span>Check in</span><span>Check out</span><span>Hours</span>
              <span className="ar-scale">{ticks.map((m) => <em key={m} style={{ left: pct(m) }}>{tickLabel(m)}</em>)}</span><span />
            </div>
            {loading && !data ? <div className="ar-empty">Loading…</div> : visible.length === 0 ? (
              <div className="ar-empty"><UserOutlined /><p>{rows.length ? 'Nobody here.' : 'No staff yet. Add them in Staff & rules.'}</p>{filter && <Button size="small" onClick={() => setFilter(null)}>Show everyone</Button>}</div>
            ) : visible.map((r) => {
              const d = r.day; const live = (d.punches || []).filter((p) => !p.voided_at);
              const firstIn = live.find((p) => p.kind === 'in'); const photo = live.find((p) => p.has_selfie);
              const doubt = live.some((p) => p.net_status === 'mismatch' || p.net_status === 'pending') || live.some((p) => p.device_shared) || live.some((p) => p.geo_status === 'outside');
              return (
                <div key={r.staff_id} className="ar-row" onClick={() => setDrawer({ staffId: r.staff_id, date: dayIso })}>
                  <div className="ar-person"><Avatar name={r.name} /><div><b>{r.name}</b><small>{subline(r)}</small></div></div>
                  <div><Pill k={r.key} d={d} /></div>
                  <div className="ar-cellin">{firstIn ? <>{photo && <Selfie punchId={photo.punch_id} onOpen={(url) => setPreview({ url, punch: photo, name: r.name })} />}<span>{fmt(firstIn.at)}</span>
                    <Tooltip title={[live.some((p) => p.net_status === 'match') && 'Shop Wi-Fi', live.some((p) => p.passkey) && 'Fingerprint / Face ID', doubt && 'Something to check: open for details'].filter(Boolean).join(' · ')}>
                      {doubt ? <WarningOutlined className="ic-warn" /> : <SafetyCertificateOutlined className="ic-ok" />}
                    </Tooltip></> : <span className="ar-dash">-</span>}</div>
                  <div className="ar-cellout">{d.out_at ? <>{fmt(d.out_at)}{d.auto_out && <Tooltip title={d.auto_basis === 'last_bill' ? 'Forgot to check out: closed at their last sales bill' : 'Forgot to check out: closed at check-in'}><span className="ar-auto">auto</span></Tooltip>}</> : d.working ? <span className="ar-muted">still in</span> : <span className="ar-dash">-</span>}</div>
                  <div className="ar-hours">{d.in_at ? <>{hm(liveMin(d))}{d.working && <small> so far</small>}</> : <span className="ar-dash">-</span>}</div>
                  <div className="ar-tlcell">{d.in_at || live.length ? <Timeline d={d} /> : null}</div>
                  <div className="ar-rowact" onClick={(e) => e.stopPropagation()}>
                    <Tooltip title="Add punch"><button type="button" className="ar-iconbtn" onClick={() => openAdd(r.staff_id, dayIso, d.working ? 'out' : 'in')}><PlusOutlined /></button></Tooltip>
                    {d.leave
                      ? <Tooltip title="Remove leave"><button type="button" className="ar-iconbtn" onClick={() => setVoiding({ kind: 'leave', id: d.leave.leave_id, label: `${r.name}'s leave`, reason: '' })}><CoffeeOutlined /></button></Tooltip>
                      : <Tooltip title="Mark leave"><button type="button" className="ar-iconbtn" onClick={() => openLeave(r.staff_id, dayIso)}><CoffeeOutlined /></button></Tooltip>}
                  </div>
                </div>
              );
            })}
          </section>
        </>
      ) : (
        <>
          <section className="ar-mstats">
            <div><b>{monthTotals.rate == null ? '-' : `${monthTotals.rate}%`}</b><span>Attendance</span></div>
            <div><b className="tx-ok">{monthTotals.present}</b><span>Days present</span></div>
            <div><b className="tx-late">{monthTotals.late}</b><span>Late marks</span></div>
            <div><b className="tx-leave">{monthTotals.leave}</b><span>Leave days</span></div>
            <div><b className="tx-bad">{monthTotals.absent}</b><span>Absences</span></div>
            <div><b>{hm(monthTotals.worked)}</b><span>Hours worked</span></div>
          </section>
          <section className="ar-table ar-month-wrap">
            <table className="ar-month">
              <thead><tr>
                <th className="ar-sticky">Staff</th>
                {(data?.days || []).map((iso) => { const d = dayjs(iso); const wo = (cfg.weekly_off || []).map(Number).includes(d.day());
                  return <th key={iso} className={`${iso === data.today ? 'is-today' : ''}${wo ? ' is-wo' : ''}`}><span>{d.format('dd')[0]}</span>{d.date()}</th>; })}
                <th className="ar-tot">Present</th><th className="ar-tot">Late</th><th className="ar-tot">Leave</th><th className="ar-tot">Absent</th><th className="ar-tot">Hours</th>
              </tr></thead>
              <tbody>
                {(data?.staff || []).map((s) => (
                  <tr key={s.staff_id}>
                    <td className="ar-sticky"><div className="ar-person sm"><Avatar name={s.name} size={26} /><b>{s.name}</b></div></td>
                    {data.days.map((iso) => {
                      const d = s.days[iso]; const k = statusKey(d); const st = STATUS[k];
                      const tip = [st.label, d?.in_at && `In ${fmt(d.in_at)}`, d?.out_at && `Out ${fmt(d.out_at)}${d.auto_out ? ' (auto)' : ''}`,
                        d?.leave && `${d.leave.type === 'unpaid' ? 'Unpaid' : 'Paid'} leave${d.leave.reason ? `: ${d.leave.reason}` : ''}`, ...((d?.flags) || []).map((f) => FLAG[f])].filter(Boolean).join(' · ');
                      return (
                        <td key={iso} className={iso === data.today ? 'is-today' : ''}>
                          {k !== 'none' && (
                            <Tooltip title={tip}>
                              <button type="button" className={`ar-cell tone-${st.tone}${d?.flags?.length ? ' has-flag' : ''}`} onClick={() => setDrawer({ staffId: s.staff_id, date: iso })}>{st.short}</button>
                            </Tooltip>
                          )}
                        </td>
                      );
                    })}
                    <td className="ar-tot"><b>{s.summary.present}</b></td><td className="ar-tot">{s.summary.late || ''}</td>
                    <td className="ar-tot">{s.summary.leave || ''}</td><td className="ar-tot">{s.summary.absent || ''}</td><td className="ar-tot">{hm(s.summary.worked_min)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ar-mlegend">
              {['present', 'late', 'absent', 'leave', 'off', 'working'].map((k) => <span key={k}><i className={`ar-cell tone-${STATUS[k].tone}`}>{STATUS[k].short}</i>{STATUS[k].label}</span>)}
              <span><i className="ar-cell tone-ok has-flag">P</i>Something to check</span>
            </div>
          </section>
        </>
      )}

      {/* ── day details ── */}
      <Drawer rootClassName="ar-pop" open={!!drawer} onClose={() => setDrawer(null)} width={440} destroyOnHidden
        title={drawerStaff && <div className="ar-person"><Avatar name={drawerStaff.name} size={38} /><div><b>{drawerStaff.name}</b><small>{dayjs(drawer.date).format('dddd, D MMMM YYYY')}</small></div></div>}>
        {drawerStaff && (
          <div className="ar-drawer">
            <div className="ar-dsum">
              <Pill k={statusKey(drawerDay)} d={drawerDay} />
              {drawerDay.in_at && <span>{fmt(drawerDay.in_at)} → {drawerDay.out_at ? fmt(drawerDay.out_at) : 'still in'}</span>}
              {drawerDay.in_at && <b>{hm(liveMin(drawerDay))}</b>}
            </div>
            {drawerDay.in_at && lateBy(drawerDay) > 0 && <div className="ar-note tone-late">Came in {lateBy(drawerDay)} min after {cfg.open_time} (with {cfg.grace_min || 0} min grace).</div>}
            {drawerDay.leave && (
              <div className="ar-note tone-leave"><CoffeeOutlined /><div><b>{drawerDay.leave.type === 'unpaid' ? 'Unpaid' : 'Paid'} leave</b>{drawerDay.leave.reason && <span> · {drawerDay.leave.reason}</span>}</div>
                <button type="button" className="ar-link danger" onClick={() => setVoiding({ kind: 'leave', id: drawerDay.leave.leave_id, label: `${drawerStaff.name}'s leave`, reason: '' })}>Remove</button></div>
            )}
            <h4>Check-ins and check-outs</h4>
            {(drawerDay.punches || []).length === 0 && <p className="ar-muted">Nothing recorded this day.</p>}
            {(drawerDay.punches || []).map((p) => (
              <div key={p.punch_id} className={`ar-punch${p.voided_at ? ' is-void' : ''}`}>
                {p.has_selfie ? <Selfie punchId={p.punch_id} size={46} onOpen={(url) => setPreview({ url, punch: p, name: drawerStaff.name })} /> : <span className={`ar-kind k-${p.kind}`}>{p.kind.toUpperCase()}</span>}
                <div className="ar-punch-main">
                  <b>{p.kind === 'in' ? 'Checked in' : 'Checked out'} · {fmt(p.at)}</b>
                  <div className="ar-punch-tags">
                    {p.source === 'manual' ? <Tag>Added by owner: {p.reason}</Tag> : (<>
                      <Tag icon={<WifiOutlined />} color={NET[p.net_status]?.color}>{NET[p.net_status]?.label || p.net_status}</Tag>
                      {p.passkey && <Tag icon={<SafetyCertificateOutlined />} color="blue">Fingerprint</Tag>}
                      {p.geo_status === 'inside' && <Tag icon={<EnvironmentOutlined />} color="green">{Math.round(p.distance_m || 0)} m from shop</Tag>}
                      {p.geo_status === 'outside' && <Tag icon={<EnvironmentOutlined />} color="orange">{((p.distance_m || 0) / 1000).toFixed(1)} km away</Tag>}
                      {p.device_shared && <Tag icon={<WarningOutlined />} color="red">Shared phone</Tag>}
                      {p.prompt && <Tag icon={<CameraOutlined />}>{p.prompt}</Tag>}
                    </>)}
                  </div>
                  {p.voided_at && <small className="ar-muted">Removed: {p.void_reason}</small>}
                </div>
                {!p.voided_at && <button type="button" className="ar-link danger" onClick={() => setVoiding({ kind: 'punch', id: p.punch_id, label: `${p.kind === 'in' ? 'check-in' : 'check-out'} at ${fmt(p.at)}`, reason: '' })}>Remove</button>}
              </div>
            ))}
            <div className="ar-dact">
              <Button icon={<PlusOutlined />} onClick={() => openAdd(drawerStaff.staff_id, drawer.date, drawerDay.working ? 'out' : 'in')}>Add punch</Button>
              {!drawerDay.leave && <Button icon={<CoffeeOutlined />} onClick={() => openLeave(drawerStaff.staff_id, drawer.date)}>Mark leave</Button>}
            </div>
            {mode === 'month' && <><h4>{date.format('MMMM')} at a glance</h4>
            <div className="ar-dstats">
              <span><b className="tx-ok">{drawerStaff.summary.present}</b>present</span><span><b className="tx-late">{drawerStaff.summary.late}</b>late</span>
              <span><b className="tx-leave">{drawerStaff.summary.leave || 0}</b>leave</span><span><b className="tx-bad">{drawerStaff.summary.absent}</b>absent</span>
            </div></>}
          </div>
        )}
      </Drawer>

      {/* ── dialogs ── */}
      <Modal rootClassName="ar-pop" open={!!preview} footer={null} onCancel={() => setPreview(null)} width={400} title={preview ? `${preview.name} · ${fmt(preview.punch.at)}` : ''}>
        {preview && <div className="ar-preview">{preview.punch.prompt && <p>Asked to: <b>{preview.punch.prompt}</b></p>}<img src={preview.url} alt="Check-in" /></div>}
      </Modal>

      <Modal rootClassName="ar-pop" open={!!adding} title="Add a punch" okText="Add punch" onOk={doAdd} onCancel={() => setAdding(null)} width={440}
        okButtonProps={{ disabled: !adding || adding.reason.trim().length < 3 }} destroyOnHidden>
        {adding && (
          <div className="ar-form">
            <div className="ar-field"><label>Staff</label><Select value={adding.staff_id} onChange={(v) => setAdding({ ...adding, staff_id: v })} options={rows.map((s) => ({ value: s.staff_id, label: s.name }))} /></div>
            <div className="ar-field"><label>Type</label><Segmented block value={adding.kind} onChange={(v) => setAdding({ ...adding, kind: v })} options={[{ label: 'Check in', value: 'in' }, { label: 'Check out', value: 'out' }]} /></div>
            <div className="ar-two">
              <div className="ar-field"><label>Date</label><Input type="date" value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} /></div>
              <div className="ar-field"><label>Time</label><Input type="time" value={adding.time} onChange={(e) => setAdding({ ...adding, time: e.target.value })} /></div>
            </div>
            <div className="ar-field"><label>Reason <em>the staff member sees this</em></label>
              <Input.TextArea rows={2} maxLength={300} value={adding.reason} placeholder="e.g. Phone battery was dead" onChange={(e) => setAdding({ ...adding, reason: e.target.value })} /></div>
          </div>
        )}
      </Modal>

      <Modal rootClassName="ar-pop" open={!!leaveForm} title="Mark leave" okText={leaveForm?.dates?.length ? `Mark ${leaveForm.dates.length} day${leaveForm.dates.length > 1 ? 's' : ''} as leave` : 'Mark leave'} onOk={doLeave} onCancel={() => setLeaveForm(null)} width={460}
        okButtonProps={{ disabled: !leaveForm || !leaveForm.dates?.length || leaveForm.reason.trim().length < 3 }} destroyOnHidden>
        {leaveForm && (
          <div className="ar-form">
            <div className="ar-field"><label>Staff</label><Select value={leaveForm.staff_id} onChange={(v) => setLeaveForm({ ...leaveForm, staff_id: v })} options={rows.map((s) => ({ value: s.staff_id, label: s.name }))} /></div>
            <div className="ar-field"><label>Days <em>pick one or more</em></label>
              <DatePicker multiple value={leaveForm.dates} onChange={(v) => setLeaveForm({ ...leaveForm, dates: v || [] })} format="D MMM" maxTagCount="responsive" /></div>
            <div className="ar-field"><label>Type</label>
              <div className="ar-choice">
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

      <Modal rootClassName="ar-pop" open={!!bulk} title="Mark present" onCancel={() => setBulk(null)} width={720} destroyOnHidden style={{ top: 24 }}
        footer={bulk && (
          <div className="ar-bfoot">
            <span>{bulk.staff_ids.length ? <>Up to <b>{bulk.staff_ids.length * bulkDays.length - bulkLeaveTotal}</b> present day{bulk.staff_ids.length * bulkDays.length - bulkLeaveTotal === 1 ? '' : 's'}{bulkLeaveTotal ? <> and <b>{bulkLeaveTotal}</b> leave day{bulkLeaveTotal === 1 ? '' : 's'}</> : null} for {bulk.staff_ids.length} staff</> : 'Choose staff'}</span>
            <div><Button onClick={() => setBulk(null)}>Cancel</Button>
              <Button type="primary" loading={bulk.saving} onClick={submitBulk} disabled={!bulk.staff_ids.length || bulk.reason.trim().length < 3 || !bulk.range?.[0]}>Save attendance</Button></div>
          </div>
        )}>
        {bulk && (
          <div className="ar-form">
            <p className="ar-muted ar-intro">Everyone chosen is marked present for their shift on each day, except the leave days you pick. Days that already have a check-in, weekly offs and future days are left as they are.</p>
            <div className="ar-three">
              <div className="ar-field"><label>Days</label>
                <DatePicker.RangePicker value={bulk.range} onChange={(v) => v && setBulk({ ...bulk, range: v })} allowClear={false} format="D MMM" disabledDate={(d) => d.isAfter(dayjs(), 'day')} /></div>
              <div className="ar-field"><label>Check in</label><Input type="time" value={bulk.in_time} onChange={(e) => setBulk({ ...bulk, in_time: e.target.value })} /></div>
              <div className="ar-field"><label>Check out</label><Input type="time" value={bulk.out_time} onChange={(e) => setBulk({ ...bulk, out_time: e.target.value })} /></div>
            </div>
            <div className="ar-field"><label>Staff <em>
              <button type="button" className="ar-link" onClick={() => setBulk({ ...bulk, staff_ids: rows.map((s) => s.staff_id) })}>All</button> ·{' '}
              <button type="button" className="ar-link" onClick={() => setBulk({ ...bulk, staff_ids: [] })}>None</button></em></label>
              <Select mode="multiple" value={bulk.staff_ids} onChange={(v) => setBulk({ ...bulk, staff_ids: v })} maxTagCount="responsive" placeholder="Choose staff" options={rows.map((s) => ({ value: s.staff_id, label: s.name }))} /></div>
            <Checkbox checked={bulk.include_weekly_off} onChange={(e) => setBulk({ ...bulk, include_weekly_off: e.target.checked })}>Also mark weekly off days</Checkbox>

            {bulk.staff_ids.length > 0 && (
              <div className="ar-field"><label>Leave in these days <em>optional</em></label>
                <div className="ar-bl">
                  <div className="ar-bl-row ar-bl-head"><span>Staff</span><span>Leave days</span><span>Type</span><span>Result</span></div>
                  {bulk.staff_ids.map((sid) => {
                    const s = staffById.get(sid); const l = bulk.leaves[sid] || { dates: [], type: 'paid' }; const n = l.dates?.length || 0;
                    return (
                      <div key={sid} className="ar-bl-row">
                        <div className="ar-person sm"><Avatar name={s?.name} size={26} /><b>{s?.name}</b></div>
                        <DatePicker multiple value={l.dates} onChange={(v) => setBulkLeave(sid, { dates: v || [] })} format="D MMM" maxTagCount="responsive" placeholder="None" size="small"
                          disabledDate={(d) => d.isBefore(bulk.range[0], 'day') || d.isAfter(bulk.range[1], 'day')} />
                        <Segmented size="small" value={l.type} onChange={(v) => setBulkLeave(sid, { type: v })} options={[{ label: 'Paid', value: 'paid' }, { label: 'Unpaid', value: 'unpaid' }]} disabled={!n} />
                        <span className="ar-bl-res"><b className="tx-ok">{Math.max(0, bulkDays.length - n)}</b> present{n ? <> · <b className="tx-leave">{n}</b> leave</> : null}</span>
                      </div>
                    );
                  })}
                </div></div>
            )}
            <div className="ar-field"><label>Reason <em>the staff member sees this</em></label>
              <Input maxLength={300} value={bulk.reason} onChange={(e) => setBulk({ ...bulk, reason: e.target.value })} /></div>
          </div>
        )}
      </Modal>

      <Modal rootClassName="ar-pop" open={!!voiding} title={voiding ? `Remove ${voiding.label}?` : ''} okText="Remove" onOk={doVoid} onCancel={() => setVoiding(null)} width={420}
        okButtonProps={{ danger: true, disabled: !voiding || voiding.reason.trim().length < 3 }} destroyOnHidden>
        {voiding && (
          <div className="ar-form">
            <p className="ar-muted ar-intro">It stays on record as removed and is never deleted.</p>
            <div className="ar-field"><label>Reason <em>the staff member sees this</em></label>
              <Input.TextArea rows={2} maxLength={300} value={voiding.reason} autoFocus onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} /></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
