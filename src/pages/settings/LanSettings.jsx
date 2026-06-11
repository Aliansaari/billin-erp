import React, { useEffect, useRef, useState } from 'react';
import { Switch, InputNumber, Button, Tag, Alert, Popconfirm, QRCode, message, Skeleton } from 'antd';
import {
  WifiOutlined, CopyOutlined, ReloadOutlined, DesktopOutlined, GlobalOutlined,
  CheckCircleFilled, SafetyOutlined, ApiOutlined, StopOutlined, UndoOutlined, LaptopOutlined,
} from '@ant-design/icons';
import { settingsAPI } from '../../api';
import { refreshSystemSettings } from '../../hooks/useSystemSettings';
import './LanSettings.css';

/*
 * LAN & Network — share this ZEHEN with other PCs and phones on the
 * same Wi-Fi.
 *
 * Two access paths, both pointing at the SAME http://<ip>:<port> URL:
 *   1. The installed client app → paste the URL in its Server Setup.
 *   2. Any browser on the same Wi-Fi → just open the URL (the server also
 *      serves the web app, so nothing needs installing).
 *
 * Everything here reads existing endpoints — the master switch
 * (dev_lan_enabled) + client cap (dev_lan_max_clients) live in
 * system_settings and are toggled via settingsAPI.updateSystem (which
 * busts the LAN gate's cache instantly); the IPs / port / live client
 * count come from the unauthenticated /server-info endpoint.
 */

function copyText(txt) {
  try {
    navigator.clipboard?.writeText(txt);
    message.success('Copied to clipboard');
  } catch {
    message.error('Could not copy');
  }
}

// Most office/home Wi-Fi sits on 192.168.x.x; surface that first so the
// admin reads out the address staff will actually be able to reach.
function rankAddress(a) {
  const ip = a.address || '';
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.'))      return 1;
  if (ip.startsWith('172.'))     return 2;
  return 3;
}

export default function LanSettings() {
  const [settings, setSettings] = useState(null);
  const [info, setInfo] = useState(null);
  const [clients, setClients] = useState([]);
  const [blockedDevices, setBlockedDevices] = useState([]);
  const [busyIp, setBusyIp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const pollRef = useRef(null);

  const loadSettings = async () => {
    try { const r = await settingsAPI.getSystem(); setSettings(r.data?.data || r.data || {}); } catch { /* keep prior */ }
  };
  const loadInfo = async () => {
    try { const r = await settingsAPI.serverInfo(); setInfo(r.data || null); } catch { /* keep prior */ }
  };
  const loadClients = async () => {
    try {
      const r = await settingsAPI.lanClients();
      setClients(r.data?.clients || []);
      setBlockedDevices(r.data?.blocked || []);
    } catch { /* keep prior */ }
  };

  useEffect(() => {
    (async () => { setLoading(true); await Promise.all([loadSettings(), loadInfo(), loadClients()]); setLoading(false); })();
    // Refresh the live device list + addresses every 5s.
    pollRef.current = setInterval(() => { loadInfo(); loadClients(); }, 5000);
    return () => clearInterval(pollRef.current);
  }, []);

  const enabled    = settings?.dev_lan_enabled !== false;          // default ON
  const maxClients = Number(settings?.dev_lan_max_clients) || 0;    // 0 = unlimited
  const port       = info?.port || 3001;
  const addresses  = (info?.addresses || []).slice().sort((a, b) => rankAddress(a) - rankAddress(b));
  const urls       = addresses.map((a) => `http://${a.address}:${port}`);
  const primaryUrl = urls[0] || null;
  const activeCount = clients.length;

  const patchSettings = async (patch, okMsg) => {
    setSaving(true);
    const prev = settings;
    setSettings((s) => ({ ...s, ...patch }));   // optimistic
    try {
      await settingsAPI.updateSystem(patch);
      await refreshSystemSettings();
      await loadInfo();
      if (okMsg) message.success(okMsg);
    } catch (e) {
      setSettings(prev);
      message.error('Could not save — ' + (e.response?.data?.error || e.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (ip) => {
    if (!ip) return;
    setBusyIp(ip);
    try {
      await settingsAPI.disconnectLanClient(ip);
      message.success(`Disconnected ${ip}`);
      await loadClients();
    } catch (e) {
      message.error('Could not disconnect — ' + (e.response?.data?.error || e.message));
    } finally { setBusyIp(null); }
  };

  const allow = async (ip) => {
    if (!ip) return;
    setBusyIp(ip);
    try {
      await settingsAPI.allowLanClient(ip);
      message.success(`${ip} can reconnect`);
      await loadClients();
    } catch (e) {
      message.error('Could not re-allow — ' + (e.response?.data?.error || e.message));
    } finally { setBusyIp(null); }
  };

  const idleLabel = (ms) => {
    const s = Math.round((ms || 0) / 1000);
    if (s < 8) return 'online now';
    if (s < 60) return `active ${s}s ago`;
    return `active ${Math.round(s / 60)}m ago`;
  };

  return (
    <div className="lan-page">
      <header className="lan-head">
        <div>
          <h1 className="lan-title">LAN &amp; Network</h1>
          <p className="lan-sub">Let other PCs and phones on the same Wi-Fi use this ZEHEN — no extra server needed.</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => { loadSettings(); loadInfo(); }} loading={loading}>
          Refresh
        </Button>
      </header>

      {loading && !settings ? (
        <div className="lan-card"><Skeleton active paragraph={{ rows: 4 }} /></div>
      ) : (
        <>
          {/* ── Master switch ───────────────────────────────────────── */}
          <div className={`lan-card lan-hero ${enabled ? 'is-on' : 'is-off'}`}>
            <div className="lan-hero-icon"><WifiOutlined /></div>
            <div className="lan-hero-body">
              <div className="lan-hero-row">
                <span className="lan-hero-ttl">LAN access</span>
                <Tag className="lan-status" color={enabled ? 'success' : 'default'}>
                  {enabled ? 'Enabled' : 'Disabled'}
                </Tag>
              </div>
              <p className="lan-hero-desc">
                {enabled
                  ? 'Other devices on this Wi-Fi can connect to this computer and bill together on one shared database.'
                  : 'Only this computer can use the app. Turn on to let other PCs / phones on the same Wi-Fi connect.'}
              </p>
            </div>
            <Switch
              checked={enabled}
              loading={saving}
              onChange={(v) => patchSettings({ dev_lan_enabled: v }, v ? 'LAN access enabled' : 'LAN access disabled')}
            />
          </div>

          {!enabled && (
            <Alert
              type="info" showIcon style={{ marginBottom: 18 }}
              message="LAN is off"
              description="Turn on LAN access above to reveal the connection address other devices should use."
            />
          )}

          {enabled && addresses.length === 0 && (
            <Alert
              type="warning" showIcon style={{ marginBottom: 18 }}
              message="No Wi-Fi / network detected"
              description="This PC doesn't have an active LAN/Wi-Fi connection right now. Connect it to your shop's Wi-Fi, then press Refresh."
            />
          )}

          {enabled && addresses.length > 0 && (
            <>
              {/* ── Connection address + QR ──────────────────────────── */}
              <div className="lan-card lan-addr">
                <div className="lan-addr-left">
                  <div className="lan-kicker">Server address</div>
                  <button className="lan-url" onClick={() => copyText(primaryUrl)} title="Click to copy">
                    <span className="lan-url-text">{primaryUrl}</span>
                    <CopyOutlined />
                  </button>
                  <div className="lan-addr-meta">
                    Computer <b>{info?.hostname || '—'}</b> · port <b>{port}</b>
                  </div>

                  {addresses.length > 1 && (
                    <div className="lan-alt">
                      <div className="lan-alt-lbl">This PC has more than one network — use the one on your Wi-Fi:</div>
                      {urls.map((u, i) => (
                        <button key={u} className={`lan-alt-row${i === 0 ? ' primary' : ''}`} onClick={() => copyText(u)}>
                          <span>{u}</span>
                          <span className="lan-alt-if">{addresses[i].iface}{i === 0 ? ' · recommended' : ''}</span>
                          <CopyOutlined />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="lan-qr">
                  <QRCode value={primaryUrl} size={150} bordered={false} />
                  <div className="lan-qr-cap">Scan on a phone to open in its browser</div>
                </div>
              </div>

              {/* ── Two ways to connect ──────────────────────────────── */}
              <div className="lan-grid2">
                <div className="lan-card lan-method">
                  <div className="lan-method-head">
                    <span className="lan-method-ic"><DesktopOutlined /></span>
                    <span className="lan-method-ttl">From the installed app</span>
                  </div>
                  <ol className="lan-steps">
                    <li>Install ZEHEN on the other PC.</li>
                    <li>On first launch, open <b>Server Setup</b>.</li>
                    <li>Paste this address and connect:</li>
                  </ol>
                  <button className="lan-url sm" onClick={() => copyText(primaryUrl)} title="Click to copy">
                    <span className="lan-url-text">{primaryUrl}</span><CopyOutlined />
                  </button>
                </div>

                <div className="lan-card lan-method">
                  <div className="lan-method-head">
                    <span className="lan-method-ic alt"><GlobalOutlined /></span>
                    <span className="lan-method-ttl">From a browser — no install</span>
                  </div>
                  <p className="lan-method-desc">
                    On any phone, tablet or laptop on the same Wi-Fi, open this link in a browser (Chrome, Safari, Edge…).
                    The full app loads — nothing to install.
                  </p>
                  <button className="lan-url sm" onClick={() => copyText(primaryUrl)} title="Click to copy">
                    <span className="lan-url-text">{primaryUrl}</span><CopyOutlined />
                  </button>
                </div>
              </div>

              {/* ── Connected devices (live) + disconnect ─────────────── */}
              <div className="lan-card lan-devices">
                <div className="lan-dev-head">
                  <div className="lan-dev-head-left">
                    <span className="lan-dev-count">{activeCount}</span>
                    <div>
                      <div className="lan-dev-ttl">Connected device{activeCount === 1 ? '' : 's'}</div>
                      <div className="lan-dev-sub">Live · other PCs &amp; phones using this server now</div>
                    </div>
                  </div>
                  <div className="lan-dev-cap">
                    <span className="lan-kicker" style={{ marginBottom: 4 }}>Max at once</span>
                    <div className="lan-cap-row">
                      <InputNumber
                        size="small" min={0} max={100} value={maxClients} disabled={saving}
                        onChange={(v) => patchSettings({ dev_lan_max_clients: Number(v) || 0 })}
                        style={{ width: 88 }}
                      />
                      <span className="lan-cap-hint">{maxClients === 0 ? 'unlimited' : `cap ${maxClients}`}</span>
                    </div>
                  </div>
                </div>

                {clients.length === 0 ? (
                  <div className="lan-dev-empty">No other devices are connected right now.</div>
                ) : (
                  <div className="lan-dev-list">
                    {clients.map((c) => (
                      <div key={c.id} className="lan-dev-row">
                        <span className="lan-dev-dot" />
                        <span className="lan-dev-ic"><LaptopOutlined /></span>
                        <div className="lan-dev-info">
                          <div className="lan-dev-name">{c.username || 'Browser / signed-out'}</div>
                          <div className="lan-dev-meta"><span className="mono">{c.ip || '—'}</span> · {idleLabel(c.idle_ms)}</div>
                        </div>
                        <Popconfirm
                          title="Disconnect this device?"
                          description="It will be blocked from using the app until you allow it again."
                          okText="Disconnect" okButtonProps={{ danger: true }} cancelText="Cancel"
                          onConfirm={() => disconnect(c.ip)}
                        >
                          <Button danger size="small" icon={<StopOutlined />} loading={busyIp === c.ip}>
                            Disconnect
                          </Button>
                        </Popconfirm>
                      </div>
                    ))}
                  </div>
                )}

                {blockedDevices.length > 0 && (
                  <div className="lan-dev-blocked">
                    <div className="lan-kicker">Disconnected — blocked from reconnecting</div>
                    {blockedDevices.map((b) => (
                      <div key={b.ip} className="lan-dev-row is-blocked">
                        <span className="lan-dev-dot off" />
                        <span className="lan-dev-ic"><StopOutlined /></span>
                        <div className="lan-dev-info">
                          <div className="lan-dev-name mono">{b.ip}</div>
                          <div className="lan-dev-meta">Blocked{b.since ? ` · ${new Date(b.since).toLocaleTimeString()}` : ''}</div>
                        </div>
                        <Button size="small" icon={<UndoOutlined />} loading={busyIp === b.ip} onClick={() => allow(b.ip)}>
                          Allow
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Help / notes ───────────────────────────────────────── */}
          <div className="lan-notes">
            <div className="lan-note">
              <SafetyOutlined />
              <span>The first time another device connects, Windows may ask to <b>Allow access</b> — choose <b>Private networks</b> and allow it.</span>
            </div>
            <div className="lan-note">
              <ApiOutlined />
              <span>All devices must be on the <b>same Wi-Fi / LAN</b>. This computer must stay on for others to bill.</span>
            </div>
            <div className="lan-note">
              <CheckCircleFilled style={{ color: 'var(--success, #16a34a)' }} />
              <span>This computer always works regardless of the limit — it never uses up a device slot.</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
