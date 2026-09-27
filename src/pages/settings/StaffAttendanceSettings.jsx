import React, { useEffect, useMemo, useState } from 'react';
import {
  Button, Switch, Segmented, Input, InputNumber, Checkbox, Space, message, Alert,
} from 'antd';
import {
  SyncOutlined, CopyOutlined, PrinterOutlined, CalendarOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { staffAttendanceAPI } from '../../api';
import StaffRoster from './StaffRoster';
import './ModuleSettings.css';


/*
 * Settings → Staff Attendance.
 *
 * Staff punch IN/OUT from their own phone at staff.zehenapp.com (no app, no
 * attendance machine, and this PC does not need to be on). This page is the
 * owner's control panel for it:
 *
 *   · the master switch and the staff link / QR code to hand out
 *   · the checks: shop Wi-Fi, fingerprint / Face ID, selfie, location
 *   · shop hours (late marks, weekly off)
 *   · the staff list: mobile number, PIN, "Reset phone"
 *
 * The register itself (who came, when, corrections) is at /staff-attendance.
 */

const WEEKDAYS = [
  { label: 'Sun', value: 0 }, { label: 'Mon', value: 1 }, { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 }, { label: 'Thu', value: 4 }, { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];


function Row({ label, desc, children }) {
  return (
    <div className="ms-row">
      <div>
        <div className="ms-row-label">{label}</div>
        {desc && <div className="ms-row-desc">{desc}</div>}
      </div>
      <div className="ms-row-control">{children}</div>
    </div>
  );
}

function when(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function StaffAttendanceSettings() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [server, setServer] = useState(null);        // last saved settings from the server
  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [qr, setQr] = useState(null);
  const [geoText, setGeoText] = useState('');

  const [staffRefresh, setStaffRefresh] = useState(0);

  const loadSettings = async () => {
    const { data } = await staffAttendanceAPI.getSettings();
    setServer(data);
    setEnabled(!!data.enabled);
    setConfig(data.config);
    const g = data.config?.geo || {};
    setGeoText(g.lat != null && g.lng != null ? `${g.lat}, ${g.lng}` : '');
  };

  useEffect(() => {
    (async () => {
      try {
        await loadSettings();
      } catch (err) {
        message.error(err?.response?.data?.error || 'Could not load staff attendance');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!server?.staff_url) { setQr(null); return; }
    QRCode.toDataURL(server.staff_url, { width: 360, margin: 1 }).then(setQr).catch(() => setQr(null));
  }, [server?.staff_url]);

  const dirty = useMemo(() => {
    if (!server || !config) return false;
    return enabled !== !!server.enabled || JSON.stringify(config) !== JSON.stringify(server.config);
  }, [server, config, enabled]);

  const setCfg = (patch) => setConfig((c) => ({ ...c, ...patch }));
  const setGeo = (patch) => setConfig((c) => ({ ...c, geo: { ...c.geo, ...patch } }));

  // Accepts "18.5204, 73.8567" as copied from Google Maps (long-press the
  // shop on the map, the coordinates are the first thing shown).
  const onGeoText = (text) => {
    setGeoText(text);
    const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (m) setGeo({ lat: Number(m[1]), lng: Number(m[2]) });
    else setGeo({ lat: null, lng: null });
  };

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await staffAttendanceAPI.saveSettings({ enabled, config });
      setServer(data);
      setConfig(data.config);
      message.success(enabled ? 'Saved. Staff phones get the change within a minute.' : 'Saved');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const { data } = await staffAttendanceAPI.syncNow();
      if (data?.busy) message.info('A sync is already running');
      else message.success(data?.received ? `Synced. ${data.received} new punch(es).` : 'Synced');
    } catch (err) {
      message.error(err?.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
      await loadSettings().catch(() => {});
      setStaffRefresh((n) => n + 1);
    }
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(server.staff_url); message.success('Link copied'); }
    catch { message.info(server.staff_url); }
  };

  const printPoster = () => {
    const w = window.open('', '_blank', 'width=640,height=820');
    if (!w) return;
    w.document.write(`<!doctype html><title>Staff check-in</title>
      <body style="font-family:system-ui,sans-serif;text-align:center;padding:40px">
      <h1 style="margin:0 0 6px">Staff check-in</h1>
      <p style="font-size:18px;margin:0 0 24px">Scan with your phone camera, then add it to your home screen.</p>
      <img src="${qr}" style="width:340px;height:340px">
      <p style="font-size:22px;margin:22px 0 4px">Shop code <b style="letter-spacing:.15em">${server.shop_code}</b></p>
      <p style="font-size:14px;color:#555">${server.staff_url}</p>
      <script>window.onload=()=>setTimeout(()=>window.print(),200)</script></body>`);
    w.document.close();
  };

  if (loading || !config) {
    return <div className="ms-shell settings-pane-fill"><div className="ms-page-body"><div className="ms-page-body-inner">Loading…</div></div></div>;
  }

  const net = server?.network;

  return (
    <div className="ms-shell settings-pane-fill">
      <header className="ms-page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="ms-page-title">Staff Attendance</h1>
          <p className="ms-page-sub">
            Staff check in and out from their own phone. No attendance machine, no app to install, and this computer does not need to be on.
          </p>
        </div>
        <Space>
          <Button icon={<CalendarOutlined />} onClick={() => navigate('/staff-attendance')}>Open register</Button>
          <Button type="primary" onClick={save} loading={saving} disabled={!dirty}>Save changes</Button>
        </Space>
      </header>

      <div className="ms-page-body">
        <div className="ms-page-body-inner">
          <section className="ms-section">
            <div className="ms-section-head">
              <div className="ms-section-title">Check-in</div>
            </div>
            <Row label="Staff attendance" desc="When off, staff cannot sign in or punch. Past records stay.">
              <Switch checked={enabled} onChange={setEnabled} />
            </Row>
            {server?.shop_code ? (
              <div className="ms-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div className="ms-row-label">Staff link and shop code</div>
                  <div className="ms-row-desc" style={{ marginBottom: 10 }}>
                    Each staff member opens this once on their phone, adds it to the home screen, and signs in with their mobile number and PIN.
                  </div>
                  <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '.15em' }}>{server.shop_code}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-secondary)', margin: '4px 0 10px', wordBreak: 'break-all' }}>{server.staff_url}</div>
                  <Space wrap>
                    <Button size="small" icon={<CopyOutlined />} onClick={copyLink}>Copy link</Button>
                    <Button size="small" icon={<PrinterOutlined />} onClick={printPoster} disabled={!qr}>Print poster</Button>
                  </Space>
                </div>
                {qr && <img src={qr} alt="Staff check-in QR code" style={{ width: 150, height: 150, borderRadius: 8, background: '#fff' }} />}
              </div>
            ) : (
              <Row label="Staff link and shop code" desc="Appears after the first sync. Turn attendance on, save, then press Sync now.">
                <span />
              </Row>
            )}
            <Row
              label="Sync with staff phones"
              desc={server?.last_sync_error
                ? null
                : (server?.last_sync_at ? `Last synced ${when(server.last_sync_at)}. Runs every 2 minutes while this computer is on.` : 'Not synced yet.')}
            >
              <Button icon={<SyncOutlined spin={syncing} />} onClick={syncNow} loading={syncing} disabled={dirty}>
                Sync now
              </Button>
            </Row>
            {server?.last_sync_error && (
              <Alert type="warning" showIcon style={{ marginTop: 8 }} message="Last sync failed" description={server.last_sync_error} />
            )}
          </section>

          <section className="ms-section">
            <div className="ms-section-head">
              <div className="ms-section-title">Checks</div>
              <div className="ms-section-desc">
                What a punch must pass. Fingerprint and Wi-Fi are proof. Location and selfie are evidence you can review.
              </div>
            </div>
            <Row
              label="Shop Wi-Fi"
              desc={config.wifi_mode === 'require'
                ? 'Punches must come from the shop\'s internet connection. Punching from home is refused.'
                : config.wifi_mode === 'flag'
                  ? 'Punches from elsewhere are accepted but marked for you to review.'
                  : 'Not checked.'}
            >
              <Segmented
                value={config.wifi_mode}
                onChange={(v) => setCfg({ wifi_mode: v })}
                options={[{ label: 'Off', value: 'off' }, { label: 'Flag', value: 'flag' }, { label: 'Require', value: 'require' }]}
              />
            </Row>
            {net && config.wifi_mode !== 'off' && (
              <div className="ms-row-desc" style={{ margin: '-4px 0 8px' }}>
                This computer's connection: IPv4 {net.v4 ? '✓' : 'not seen'} · IPv6 {net.v6 ? '✓' : 'not available'}
              </div>
            )}
            <Row
              label="Fingerprint / Face ID"
              desc="Uses the phone's own sensor. Nobody else can check in for a staff member, even with their PIN."
            >
              <Segmented
                value={config.passkey}
                onChange={(v) => setCfg({ passkey: v })}
                options={[{ label: 'Optional', value: 'optional' }, { label: 'Required', value: 'required' }]}
              />
            </Row>
            <Row
              label="Selfie"
              desc="Taken live with a random instruction (for example: show 3 fingers), so an old photo cannot be used."
            >
              <Segmented
                value={config.selfie}
                onChange={(v) => setCfg({ selfie: v })}
                options={[{ label: 'Off', value: 'off' }, { label: 'At IN', value: 'in' }, { label: 'IN and OUT', value: 'both' }]}
              />
            </Row>
            <Row label="Location" desc="Records whether the phone was near the shop. Shown to you; never blocks a punch.">
              <Switch checked={!!config.geo.enabled} onChange={(v) => setGeo({ enabled: v })} />
            </Row>
            {config.geo.enabled && (
              <div className="ms-nested">
                <Row label="Shop location" desc="In Google Maps, long-press your shop and paste the numbers shown (e.g. 18.5204, 73.8567).">
                  <Input value={geoText} onChange={(e) => onGeoText(e.target.value)} placeholder="18.5204, 73.8567" style={{ width: 220 }}
                    status={geoText && config.geo.lat == null ? 'error' : undefined} />
                </Row>
                <Row label="Distance allowed" desc="Phone GPS inside shops is often off by 50 to 100 m.">
                  <InputNumber min={30} max={2000} step={10} value={config.geo.radius_m} onChange={(v) => setGeo({ radius_m: v })} addonAfter="m" style={{ width: 140 }} />
                </Row>
              </div>
            )}
          </section>

          <section className="ms-section">
            <div className="ms-section-head">
              <div className="ms-section-title">Shop hours</div>
              <div className="ms-section-desc">Used for late marks and weekly offs in the register.</div>
            </div>
            <Row label="Opening time" desc="A check-in after this time plus the grace period is marked late.">
              <Input type="time" value={config.open_time} onChange={(e) => setCfg({ open_time: e.target.value })} style={{ width: 130 }} />
            </Row>
            <Row label="Grace period">
              <InputNumber min={0} max={180} value={config.grace_min} onChange={(v) => setCfg({ grace_min: v ?? 0 })} addonAfter="min" style={{ width: 140 }} />
            </Row>
            <Row label="Closing time">
              <Input type="time" value={config.close_time} onChange={(e) => setCfg({ close_time: e.target.value })} style={{ width: 130 }} />
            </Row>
            <Row label="Weekly off" desc="Days the shop is closed. Nobody is marked absent on these days.">
              <Checkbox.Group options={WEEKDAYS} value={config.weekly_off} onChange={(v) => setCfg({ weekly_off: v })} />
            </Row>
          </section>

          <section className="ms-section">
            <div className="ms-section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div className="ms-section-title">Staff</div>
                <div className="ms-section-desc">Each person signs in once with their mobile number and a PIN you set; that links their phone. Add their photo and ID here too.</div>
              </div>
            </div>
            <StaffRoster shopCode={server?.shop_code} staffUrl={server?.staff_url} refreshKey={staffRefresh} />
          </section>
        </div>
      </div>

    </div>
  );
}
