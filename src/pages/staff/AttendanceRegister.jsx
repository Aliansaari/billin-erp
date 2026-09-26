import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, DatePicker, Segmented, Table, Tag, Space, Tooltip, Modal, Input, Select, message, Empty, Alert,
} from 'antd';
import {
  SyncOutlined, SettingOutlined, PlusOutlined, WifiOutlined, EnvironmentOutlined,
  SafetyCertificateOutlined, WarningOutlined, CameraOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { staffAttendanceAPI } from '../../api';
import './attendance-register.css';

/*
 * Staff Attendance register.
 *
 * Everything shown here is computed by the server's buildRegister() — the
 * same function that produces what each staff member sees on their phone —
 * so the owner and the staff can never be looking at different numbers.
 *
 * Corrections are append-only: "Add punch" and "Remove" both require a
 * reason, nothing is edited or deleted, and the staff member sees the reason.
 */

const STATUS = {
  present:    { label: 'Present',      color: 'green',   short: 'P' },
  late:       { label: 'Late',         color: 'orange',  short: 'L' },
  absent:     { label: 'Absent',       color: 'red',     short: 'A' },
  off:        { label: 'Weekly off',   color: 'default', short: 'O' },
  unverified: { label: 'Not verified', color: 'magenta', short: 'U' },
  not_in:     { label: 'Not in yet',   color: 'default', short: '' },
  none:       { label: '',             color: 'default', short: '' },
};

const FLAG = {
  network:      { label: 'Wi-Fi doubtful', color: 'orange' },
  location:     { label: 'Away from shop', color: 'orange' },
  shared_phone: { label: 'Shared phone',   color: 'red' },
  voided:       { label: 'Corrected',      color: 'default' },
  manual:       { label: 'Added by owner', color: 'default' },
};

const NET = {
  match:    { label: 'Shop Wi-Fi',               color: 'green' },
  pending:  { label: 'Wi-Fi not confirmed',      color: 'orange' },
  mismatch: { label: 'Not on shop Wi-Fi',        color: 'red' },
  off:      { label: 'Wi-Fi not checked',        color: 'default' },
};

function hoursText(min) {
  if (!min) return '';
  const h = Math.floor(min / 60); const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function Selfie({ punchId, size = 44, onOpen }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true; let made = null;
    staffAttendanceAPI.getSelfie(punchId)
      .then(({ data }) => { if (!alive) return; made = URL.createObjectURL(data); setUrl(made); })
      .catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [punchId]);
  if (!url) return <div className="ar-selfie ar-selfie-empty" style={{ width: size, height: size }}><CameraOutlined /></div>;
  return (
    <img
      src={url} alt="Check-in photo" className="ar-selfie" style={{ width: size, height: size }}
      onClick={() => onOpen?.(url)}
    />
  );
}

export default function AttendanceRegister() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('day');
  const [date, setDate] = useState(dayjs());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState(null);
  const [preview, setPreview] = useState(null);
  const [adding, setAdding] = useState(null);      // { staff_id, kind, date, time, reason }
  const [voiding, setVoiding] = useState(null);    // { punch, staffName, reason }

  const range = useMemo(() => (mode === 'day'
    ? { from: date.format('YYYY-MM-DD'), to: date.format('YYYY-MM-DD') }
    : { from: date.startOf('month').format('YYYY-MM-DD'), to: date.endOf('month').format('YYYY-MM-DD') }), [mode, date]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: reg }, { data: st }] = await Promise.all([
        staffAttendanceAPI.getRegister(range),
        staffAttendanceAPI.getSettings(),
      ]);
      setData(reg); setSettings(st);
    } catch (err) {
      message.error(err?.response?.data?.error || 'Could not load the register');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const off = data?.config?.tz_offset_min ?? 330;
  const fmt = (ms) => (ms ? dayjs(ms + off * 60000).subtract(dayjs(ms).utcOffset(), 'minute').format('h:mm A') : '');

  const sync = async () => {
    setSyncing(true);
    try {
      const { data: r } = await staffAttendanceAPI.syncNow();
      if (r?.received) message.success(`${r.received} new punch(es)`);
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const submitAdd = async () => {
    try {
      await staffAttendanceAPI.addPunch(adding);
      message.success('Punch added. The staff member will see it with your reason.');
      setAdding(null);
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Could not add the punch');
    }
  };

  const submitVoid = async () => {
    try {
      await staffAttendanceAPI.voidPunch(voiding.punch.punch_id, voiding.reason);
      message.success('Punch removed. The staff member will see it with your reason.');
      setVoiding(null);
      await load();
    } catch (err) {
      message.error(err?.response?.data?.error || 'Could not remove the punch');
    }
  };

  // ── day view ──
  const dayIso = range.from;
  const dayRows = useMemo(() => (data?.staff || []).map((s) => ({ ...s, day: s.days[dayIso] })), [data, dayIso]);

  const dayColumns = [
    {
      title: 'Staff', dataIndex: 'name',
      render: (v, r) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    {
      title: 'Status', key: 'status', width: 150,
      render: (_, r) => {
        const d = r.day || {};
        if (d.working) return <Tag color="blue">In the shop</Tag>;
        const st = STATUS[d.status] || STATUS.none;
        return st.label ? <Tag color={st.color}>{st.label}</Tag> : null;
      },
    },
    { title: 'In', key: 'in', width: 100, render: (_, r) => fmt(r.day?.in_at) },
    {
      title: 'Out', key: 'out', width: 130,
      render: (_, r) => (r.day?.out_at ? (
        <Space size={4}>
          {fmt(r.day.out_at)}
          {r.day.auto_out && (
            <Tooltip title={r.day.auto_basis === 'last_bill'
              ? 'Forgot to check out. Closed at their last sales bill of the day.'
              : 'Forgot to check out and no later activity was found. Closed at their check-in time.'}>
              <Tag color="purple">Auto</Tag>
            </Tooltip>
          )}
        </Space>
      ) : ''),
    },
    { title: 'Worked', key: 'worked', width: 90, render: (_, r) => hoursText(r.day?.worked_min) },
    {
      title: 'Checks', key: 'flags',
      render: (_, r) => (
        <Space size={4} wrap>
          {(r.day?.flags || []).map((f) => <Tag key={f} color={FLAG[f]?.color}>{FLAG[f]?.label || f}</Tag>)}
        </Space>
      ),
    },
    {
      title: 'Photo', key: 'photo', width: 70,
      render: (_, r) => {
        const p = (r.day?.punches || []).find((x) => x.has_selfie && !x.voided_at);
        return p ? <Selfie punchId={p.punch_id} onOpen={(url) => setPreview({ url, punch: p, name: r.name })} /> : null;
      },
    },
    {
      title: '', key: 'add', width: 110, align: 'right',
      render: (_, r) => (
        <Button size="small" icon={<PlusOutlined />}
          onClick={() => setAdding({ staff_id: r.staff_id, kind: r.day?.working ? 'out' : 'in', date: dayIso, time: dayjs().format('HH:mm'), reason: '' })}>
          Add punch
        </Button>
      ),
    },
  ];

  const expandedRow = (r) => {
    const punches = r.day?.punches || [];
    if (!punches.length) return <span className="ar-muted">No punches this day.</span>;
    return (
      <div className="ar-punches">
        {punches.map((p) => (
          <div key={p.punch_id} className={`ar-punch${p.voided_at ? ' is-void' : ''}`}>
            <b className="ar-kind">{p.kind.toUpperCase()}</b>
            <span className="ar-time">{fmt(p.at)}</span>
            {p.source === 'manual'
              ? <Tag>Added by owner: {p.reason}</Tag>
              : (
                <Space size={4} wrap>
                  <Tag icon={<WifiOutlined />} color={NET[p.net_status]?.color}>{NET[p.net_status]?.label || p.net_status}</Tag>
                  {p.passkey && <Tag icon={<SafetyCertificateOutlined />} color="blue">Fingerprint / Face ID</Tag>}
                  {p.geo_status === 'inside' && <Tag icon={<EnvironmentOutlined />} color="green">{p.distance_m != null ? `${Math.round(p.distance_m)} m from shop` : 'At shop'}</Tag>}
                  {p.geo_status === 'outside' && <Tag icon={<EnvironmentOutlined />} color="orange">{p.distance_m != null ? `${(p.distance_m / 1000).toFixed(1)} km from shop` : 'Away'}</Tag>}
                  {p.geo_status === 'none' && <Tag icon={<EnvironmentOutlined />}>No location</Tag>}
                  {p.device_shared && <Tag icon={<WarningOutlined />} color="red">Phone also used by another staff member</Tag>}
                  {p.prompt && <Tag icon={<CameraOutlined />}>Asked: {p.prompt}</Tag>}
                </Space>
              )}
            {p.has_selfie && <Selfie punchId={p.punch_id} size={36} onOpen={(url) => setPreview({ url, punch: p, name: r.name })} />}
            <span className="ar-spacer" />
            {p.voided_at
              ? <span className="ar-muted">Removed: {p.void_reason}</span>
              : <Button size="small" type="link" danger onClick={() => setVoiding({ punch: p, staffName: r.name, reason: '' })}>Remove</Button>}
          </div>
        ))}
      </div>
    );
  };

  // ── month view ──
  const monthColumns = useMemo(() => {
    if (mode !== 'month' || !data) return [];
    const cols = [{ title: 'Staff', dataIndex: 'name', fixed: 'left', width: 160, render: (v) => <b>{v}</b> }];
    for (const iso of data.days) {
      const d = dayjs(iso);
      cols.push({
        title: <div className={`ar-dayhead${d.day() === 0 ? ' is-sun' : ''}`}><div>{d.format('dd')[0]}</div><div>{d.date()}</div></div>,
        key: iso, width: 34, align: 'center',
        render: (_, r) => {
          const day = r.days[iso];
          if (!day) return null;
          const st = day.working ? { short: 'W', color: 'blue', label: 'In the shop' } : (STATUS[day.status] || STATUS.none);
          if (!st.short) return null;
          const tip = [st.label, day.in_at && `In ${fmt(day.in_at)}`, day.out_at && `Out ${fmt(day.out_at)}${day.auto_out ? ' (auto)' : ''}`, ...(day.flags || []).map((f) => FLAG[f]?.label)]
            .filter(Boolean).join(' · ');
          return (
            <Tooltip title={tip}>
              <span className={`ar-cell ar-${day.working ? 'working' : day.status}${day.flags?.length ? ' has-flag' : ''}`}
                onClick={() => { setDate(dayjs(iso)); setMode('day'); }}>
                {st.short}
              </span>
            </Tooltip>
          );
        },
      });
    }
    cols.push(
      { title: 'Present', key: 'p', width: 76, align: 'right', fixed: 'right', render: (_, r) => r.summary.present },
      { title: 'Late', key: 'l', width: 60, align: 'right', fixed: 'right', render: (_, r) => r.summary.late || '' },
      { title: 'Absent', key: 'a', width: 70, align: 'right', fixed: 'right', render: (_, r) => r.summary.absent || '' },
      { title: 'Hours', key: 'h', width: 84, align: 'right', fixed: 'right', render: (_, r) => hoursText(r.summary.worked_min) },
    );
    return cols;
  }, [mode, data, off]);

  const notOn = settings && !settings.enabled;

  return (
    <div className="ar-page">
      <header className="ar-header">
        <div>
          <h1>Staff Attendance</h1>
          <p>Punches from staff phones. Times are shown in shop time.</p>
        </div>
        <Space wrap>
          <Segmented value={mode} onChange={setMode} options={[{ label: 'Day', value: 'day' }, { label: 'Month', value: 'month' }]} />
          {mode === 'day'
            ? <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} format="ddd, D MMM YYYY" />
            : <DatePicker picker="month" value={date} onChange={(d) => d && setDate(d)} allowClear={false} format="MMMM YYYY" />}
          <Button icon={<SyncOutlined spin={syncing} />} onClick={sync} loading={syncing}>Sync</Button>
          <Button icon={<SettingOutlined />} onClick={() => navigate('/settings/staff-attendance')}>Staff & rules</Button>
        </Space>
      </header>

      {notOn && (
        <Alert
          type="info" showIcon style={{ margin: '0 0 12px' }}
          message="Staff attendance is off"
          description="Turn it on and add your staff in Staff & rules. Staff then check in from their own phones."
          action={<Button size="small" type="primary" onClick={() => navigate('/settings/staff-attendance')}>Set up</Button>}
        />
      )}
      {settings?.last_sync_error && settings.enabled && (
        <Alert type="warning" showIcon style={{ margin: '0 0 12px' }} message="Could not reach staff phones" description={settings.last_sync_error} />
      )}

      {mode === 'day' ? (
        <Table
          rowKey="staff_id"
          loading={loading}
          dataSource={dayRows}
          columns={dayColumns}
          pagination={false}
          size="middle"
          expandable={{ expandedRowRender: expandedRow, rowExpandable: () => true }}
          locale={{ emptyText: <Empty description="No staff yet" /> }}
        />
      ) : (
        <Table
          rowKey="staff_id"
          loading={loading}
          dataSource={data?.staff || []}
          columns={monthColumns}
          pagination={false}
          size="small"
          scroll={{ x: 'max-content' }}
          className="ar-month"
          locale={{ emptyText: <Empty description="No staff yet" /> }}
        />
      )}

      <Modal open={!!preview} footer={null} onCancel={() => setPreview(null)} title={preview ? `${preview.name} · ${preview.punch.kind.toUpperCase()} ${fmt(preview.punch.at)}` : ''} width={420}>
        {preview && (
          <div style={{ textAlign: 'center' }}>
            {preview.punch.prompt && <p style={{ marginTop: 0 }}>They were asked to: <b>{preview.punch.prompt}</b></p>}
            <img src={preview.url} alt="Check-in photo" style={{ maxWidth: '100%', borderRadius: 8 }} />
          </div>
        )}
      </Modal>

      <Modal
        open={!!adding}
        title="Add a punch"
        okText="Add punch"
        onOk={submitAdd}
        onCancel={() => setAdding(null)}
        okButtonProps={{ disabled: !adding || adding.reason.trim().length < 3 }}
        destroyOnClose
      >
        {adding && (
          <div className="ar-form">
            <label>Staff</label>
            <Select value={adding.staff_id} onChange={(v) => setAdding({ ...adding, staff_id: v })} style={{ width: '100%' }}
              options={(data?.staff || []).map((s) => ({ value: s.staff_id, label: s.name }))} />
            <label>Punch</label>
            <Segmented value={adding.kind} onChange={(v) => setAdding({ ...adding, kind: v })} options={[{ label: 'IN', value: 'in' }, { label: 'OUT', value: 'out' }]} />
            <label>Date and time</label>
            <Space>
              <Input type="date" value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} />
              <Input type="time" value={adding.time} onChange={(e) => setAdding({ ...adding, time: e.target.value })} />
            </Space>
            <label>Reason (the staff member will see this)</label>
            <Input.TextArea rows={2} maxLength={300} value={adding.reason} placeholder="e.g. Phone battery was dead"
              onChange={(e) => setAdding({ ...adding, reason: e.target.value })} />
          </div>
        )}
      </Modal>

      <Modal
        open={!!voiding}
        title={voiding ? `Remove ${voiding.staffName}'s ${voiding.punch.kind.toUpperCase()} at ${fmt(voiding.punch.at)}?` : ''}
        okText="Remove punch"
        okButtonProps={{ danger: true, disabled: !voiding || voiding.reason.trim().length < 3 }}
        onOk={submitVoid}
        onCancel={() => setVoiding(null)}
        destroyOnClose
      >
        {voiding && (
          <div className="ar-form">
            <p style={{ marginTop: 0 }}>The punch is kept on record as removed. It is never deleted.</p>
            <label>Reason (the staff member will see this)</label>
            <Input.TextArea rows={2} maxLength={300} value={voiding.reason} placeholder="e.g. Punched by mistake"
              onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} autoFocus />
          </div>
        )}
      </Modal>
    </div>
  );
}
