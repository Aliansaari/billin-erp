import React, { useEffect, useRef, useState } from 'react';
import {
  Segmented, Switch, Input, InputNumber, Button, Tag, Alert, QRCode, message,
  Skeleton, Tooltip, TimePicker,
} from 'antd';
import {
  WhatsAppOutlined, ReloadOutlined, SafetyOutlined, ApiOutlined, ThunderboltOutlined,
  CheckCircleFilled, DisconnectOutlined, SendOutlined, ClockCircleOutlined, InfoCircleOutlined,
  CheckOutlined, FilePdfFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { whatsappAPI } from '../../api';
import './WhatsappSettings.css';

/*
 * Settings → WhatsApp. Two ways to deliver invoice / statement PDFs to
 * customers on WhatsApp:
 *   • Web (free)      — link the shop's own WhatsApp by QR (like WhatsApp Web,
 *                       powered by Baileys). Unofficial → ban-resistance is
 *                       enforced by the paced outbox (see the Safety section).
 *   • Official (paid) — a generic Cloud-API config that works for Meta Cloud
 *                       API direct OR any BSP (Interakt/AiSensy/Gupshup/…).
 *
 * The page reads/writes /api/whatsapp/* only. The live QR + connection state
 * come from /status (polled while connecting); everything else is /settings.
 */

// Plain-language explanation of every template placeholder, shown under the
// message editors so the owner knows exactly what each one fills in.
const PLACEHOLDERS = [
  { token: '{name}',        desc: "Customer's name" },
  { token: '{shop}',        desc: 'Your shop / business name' },
  { token: '{billno}',      desc: 'Bill, invoice or receipt number' },
  { token: '{amount}',      desc: 'This bill total / payment amount' },
  { token: '{date}',        desc: 'Document date' },
  { token: '{previous}',    desc: 'Previous balance (older dues)', note: 'bills only · hidden if none' },
  { token: '{outstanding}', desc: 'Total the customer owes now', note: 'bills only · hidden if none' },
  { token: '{balance}',     desc: 'Remaining balance after the receipt', note: 'receipts only' },
];

// WhatsApp-style delivery indicator: 🕐 queued · ✓ sent · ✓✓ delivered ·
// ✓✓ (blue) read · ⚠ failed · skipped.
function DeliveryTicks({ status }) {
  if (status === 'queued' || status === 'sending') {
    return <ClockCircleOutlined className="wa-tick wa-tick-wait" title="Waiting to send" />;
  }
  if (status === 'failed')  return <span className="wa-tick wa-tick-fail" title="Failed to send">⚠</span>;
  if (status === 'skipped') return <span className="wa-tick wa-tick-skip" title="Skipped">skipped</span>;
  const read = status === 'read';
  const dbl  = read || status === 'delivered';
  return (
    <span className={`wa-ticks${dbl ? ' is-dbl' : ''}${read ? ' is-read' : ''}`} title={status}>
      <CheckOutlined />{dbl && <CheckOutlined />}
    </span>
  );
}

// "7:44 PM" for today, "2 Jun, 7:44 PM" otherwise.
function chatTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  const t = dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const sameDay = dt.toDateString() === today.toDateString();
  return sameDay ? t : `${dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${t}`;
}

const DOC_KIND = {
  sales: 'Invoice', purchase: 'Purchase bill', sales_return: 'Credit note',
  purchase_return: 'Debit note', ledger: 'Statement', receipt: 'Receipt', payment: 'Payment',
};

export default function WhatsappSettings() {
  const [cfg, setCfg] = useState(null);          // server settings (no token)
  const [status, setStatus] = useState({ state: 'disconnected', provider: 'off', qr: null, me: null });
  const [outbox, setOutbox] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);       // connect/logout/test in flight
  const [testNo, setTestNo] = useState('');
  const pollRef = useRef(null);

  const loadSettings = async () => { try { const r = await whatsappAPI.getSettings(); setCfg(r.data || {}); } catch { /* keep */ } };
  const loadStatus   = async () => { try { const r = await whatsappAPI.status();      setStatus(r.data || {}); } catch { /* keep */ } };
  const loadOutbox   = async () => { try { const r = await whatsappAPI.outbox();       setOutbox(r.data?.data || []); } catch { /* keep */ } };

  useEffect(() => {
    (async () => { setLoading(true); await Promise.all([loadSettings(), loadStatus(), loadOutbox()]); setLoading(false); })();
    return () => clearInterval(pollRef.current);
  }, []);

  // Poll fast while connecting (to catch the QR + the moment it links), slow otherwise.
  useEffect(() => {
    clearInterval(pollRef.current);
    const fast = status.state === 'connecting';
    pollRef.current = setInterval(() => { loadStatus(); loadOutbox(); }, fast ? 1500 : 6000);
    return () => clearInterval(pollRef.current);
  }, [status.state]);

  if (loading && !cfg) {
    return <div className="wa-page"><div className="wa-card"><Skeleton active paragraph={{ rows: 5 }} /></div></div>;
  }

  const provider = cfg?.provider || 'off';
  const enabled  = !!cfg?.enabled;

  // Persist a partial change immediately (used by toggles / provider switch).
  const patch = async (partial, okMsg) => {
    setSaving(true);
    const prev = cfg;
    setCfg((c) => ({ ...c, ...partial }));
    try {
      await whatsappAPI.saveSettings(partial);
      await Promise.all([loadStatus(), loadSettings()]);
      if (okMsg) message.success(okMsg);
    } catch (e) {
      setCfg(prev);
      message.error('Could not save — ' + (e.response?.data?.error || e.message));
    } finally { setSaving(false); }
  };

  // Save the editable form subset (templates, safety, official creds).
  const saveForm = async () => {
    setSaving(true);
    try {
      const f = cfg || {};
      const payload = {
        msg_template_bill: f.msg_template_bill, msg_template_ledger: f.msg_template_ledger,
        msg_template_receipt: f.msg_template_receipt,
        min_delay_s: f.min_delay_s, max_delay_s: f.max_delay_s, daily_cap: f.daily_cap,
        warmup_start: f.warmup_start, warmup_step: f.warmup_step,
        quiet_start: f.quiet_start, quiet_end: f.quiet_end, validate_numbers: f.validate_numbers,
        official_api_base: f.official_api_base, official_phone_number_id: f.official_phone_number_id,
        official_template_name: f.official_template_name, official_template_lang: f.official_template_lang,
      };
      if (f.official_access_token) payload.official_access_token = f.official_access_token; // only if (re)typed
      await whatsappAPI.saveSettings(payload);
      await loadSettings();
      message.success('WhatsApp settings saved');
    } catch (e) {
      message.error('Could not save — ' + (e.response?.data?.error || e.message));
    } finally { setSaving(false); }
  };

  const connect = async () => {
    setBusy(true);
    try { await whatsappAPI.connect(); await loadStatus(); message.info('Scan the QR with WhatsApp on your phone'); }
    catch (e) { message.error('Could not start connection — ' + (e.response?.data?.error || e.message)); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try { await whatsappAPI.logout(); await loadStatus(); message.success('WhatsApp disconnected'); }
    catch (e) { message.error('Could not disconnect — ' + (e.response?.data?.error || e.message)); }
    finally { setBusy(false); }
  };
  const sendTest = async () => {
    if (!testNo.trim()) { message.warning('Enter a number to test'); return; }
    setBusy(true);
    try { await whatsappAPI.test(testNo.trim()); message.success('Test message sent — check that phone'); }
    catch (e) { message.error('Test failed — ' + (e.response?.data?.error || e.message)); }
    finally { setBusy(false); }
  };

  const set = (k) => (v) => setCfg((c) => ({ ...c, [k]: v }));
  const setE = (k) => (e) => setCfg((c) => ({ ...c, [k]: e.target.value }));
  // Build a dayjs from 'HH:mm' WITHOUT relying on the customParseFormat plugin
  // (not loaded app-wide) — set hour/minute on today explicitly.
  const hm = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
    return m ? dayjs().hour(+m[1]).minute(+m[2]).second(0).millisecond(0) : null;
  };

  const connected = status.state === 'connected';
  const connecting = status.state === 'connecting';

  // ── Activity-feed helpers ──
  const initials = (s) => {
    const str = String(s || '').trim();
    if (!str || str.startsWith('+')) return '#';
    const p = str.split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || str[0].toUpperCase();
  };
  const avatarColor = (s) => {
    let h = 0; const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return `hsl(${h}, 42%, 40%)`;
  };
  const amountFromCaption = (c) => (String(c || '').match(/₹[\d,]+(?:\.\d+)?/) || [])[0] || '';
  const sentToday = outbox.filter((o) =>
    ['sent', 'delivered', 'read'].includes(o.status) && o.sent_at &&
    new Date(o.sent_at).toDateString() === new Date().toDateString()).length;
  const methodLabel = provider === 'web' ? 'WhatsApp Web' : provider === 'official' ? 'Official API' : 'Off';
  const statusText = provider === 'off' ? 'Sending is off'
    : connected ? 'Active' : connecting ? 'Waiting for scan…' : 'Not connected';

  return (
    <div className="wa-page">
      <header className="wa-head">
        <div>
          <h1 className="wa-title">WhatsApp</h1>
          <p className="wa-sub">Send invoices &amp; statements to customers on WhatsApp — automatically and paced to stay safe.</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => { loadSettings(); loadStatus(); loadOutbox(); }} loading={loading}>Refresh</Button>
      </header>

      <div className="wa-layout">
        {/* ════════ Left column — configuration ════════ */}
        <div className="wa-main">

      {/* ── Provider switch ─────────────────────────────────────────── */}
      <div className="wa-card">
        <div className="wa-kicker">How to send</div>
        <Segmented
          block
          value={provider}
          onChange={(v) => patch({ provider: v, enabled: v !== 'off' ? true : false },
            v === 'off' ? 'WhatsApp sending turned off' : `Switched to ${v === 'web' ? 'WhatsApp Web' : 'Official API'}`)}
          options={[
            { label: 'Off', value: 'off' },
            { label: 'WhatsApp Web (free)', value: 'web' },
            { label: 'Official API (paid)', value: 'official' },
          ]}
        />
        <p className="wa-provider-desc">
          {provider === 'off' && 'WhatsApp sending is off. Bills fall back to the “open chat + attach” share.'}
          {provider === 'web' && 'Link the shop’s own WhatsApp by QR — free, no per-message cost. Unofficial connection; the Safety settings below keep it ban-resistant.'}
          {provider === 'official' && 'Use the official WhatsApp Cloud API (Meta direct) or any BSP that gives a Cloud-API endpoint. Zero ban risk; per-message cost applies.'}
        </p>
      </div>

      {/* ── WEB: QR connect / status ────────────────────────────────── */}
      {provider === 'web' && (
        <div className={`wa-card wa-conn ${connected ? 'is-on' : ''}`}>
          <div className="wa-conn-head">
            <span className="wa-conn-icon"><WhatsAppOutlined /></span>
            <div className="wa-conn-body">
              <div className="wa-conn-row">
                <span className="wa-conn-ttl">Device link</span>
                <Tag color={connected ? 'success' : connecting ? 'processing' : 'default'}>
                  {connected ? 'Connected' : connecting ? 'Waiting for scan…' : 'Not connected'}
                </Tag>
              </div>
              {connected
                ? <p className="wa-conn-desc">Linked as <b>+{status.me}</b>. Bills will be sent from this WhatsApp number.</p>
                : <p className="wa-conn-desc">Open WhatsApp on your phone → <b>Settings → Linked devices → Link a device</b> → scan the code.</p>}
            </div>
            {connected
              ? <Button danger icon={<DisconnectOutlined />} loading={busy} onClick={logout}>Disconnect</Button>
              : !connecting && <Button type="primary" icon={<WhatsAppOutlined />} loading={busy} onClick={connect}>Connect</Button>}
          </div>

          {connecting && (
            <div className="wa-qr-wrap">
              {status.qr
                ? <QRCode value={status.qr} size={220} bordered={false} />
                : <div className="wa-qr-loading"><Skeleton.Image active style={{ width: 200, height: 200 }} /></div>}
              <div className="wa-qr-cap">
                Scan within ~60 seconds. The code refreshes automatically.
                <Button type="link" size="small" onClick={logout}>Cancel</Button>
              </div>
            </div>
          )}

          {!connected && !connecting && status.last_error && (
            <Alert
              className="wa-warn" type="error" showIcon
              message="Couldn't link WhatsApp"
              description={status.last_error}
            />
          )}

          {!connected && (
            <Alert
              className="wa-warn" type="warning" showIcon
              message="Use a number you can spare"
              description="This is an unofficial link to your own WhatsApp. To protect your main line, prefer a dedicated/secondary number, let it warm up, and keep volume sensible — the Safety settings below do this for you."
            />
          )}
        </div>
      )}

      {/* ── OFFICIAL: Cloud-API config ──────────────────────────────── */}
      {provider === 'official' && (
        <div className="wa-card">
          <div className="wa-kicker">Cloud-API credentials</div>
          <p className="wa-provider-desc" style={{ marginTop: 0 }}>
            Paste from Meta (graph.facebook.com) or your BSP. Token is stored securely and never shown again after saving.
          </p>
          <div className="wa-grid">
            <label className="wa-field">
              <span>API base URL</span>
              <Input value={cfg?.official_api_base || ''} onChange={setE('official_api_base')} placeholder="https://graph.facebook.com/v21.0" />
            </label>
            <label className="wa-field">
              <span>Phone number ID</span>
              <Input value={cfg?.official_phone_number_id || ''} onChange={setE('official_phone_number_id')} placeholder="1234567890" />
            </label>
            <label className="wa-field">
              <span>Access token {cfg?.official_token_set && <Tag color="success" style={{ marginLeft: 6 }}>configured</Tag>}</span>
              <Input.Password value={cfg?.official_access_token || ''} onChange={setE('official_access_token')}
                placeholder={cfg?.official_token_set ? '•••••••• (leave blank to keep)' : 'Bearer token'} />
            </label>
            <label className="wa-field">
              <span>Template name <Tooltip title="An approved template with a DOCUMENT header is required for business-initiated invoices. Leave blank to send free-form (only valid inside a 24h reply window)."><InfoCircleOutlined /></Tooltip></span>
              <Input value={cfg?.official_template_name || ''} onChange={setE('official_template_name')} placeholder="invoice_document" />
            </label>
            <label className="wa-field">
              <span>Template language</span>
              <Input value={cfg?.official_template_lang || ''} onChange={setE('official_template_lang')} placeholder="en" style={{ maxWidth: 120 }} />
            </label>
          </div>
        </div>
      )}

      {/* ── Message templates ───────────────────────────────────────── */}
      {provider !== 'off' && (
        <div className="wa-card">
          <div className="wa-kicker">Message text</div>
          <div className="wa-tpl">
            <label className="wa-field">
              <span>Invoice / bill</span>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={cfg?.msg_template_bill || ''} onChange={setE('msg_template_bill')} />
            </label>
            <label className="wa-field">
              <span>Statement</span>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={cfg?.msg_template_ledger || ''} onChange={setE('msg_template_ledger')} />
            </label>
            <label className="wa-field">
              <span>Receipt</span>
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={cfg?.msg_template_receipt || ''} onChange={setE('msg_template_receipt')} />
            </label>
          </div>

          {/* What each placeholder fills in */}
          <div className="wa-ph-head">Placeholders — type these and they’re filled in automatically:</div>
          <div className="wa-ph-legend">
            {PLACEHOLDERS.map((p) => (
              <div className="wa-ph-item" key={p.token}>
                <code>{p.token}</code>
                <span className="wa-ph-desc">{p.desc}{p.note && <em> — {p.note}</em>}</span>
              </div>
            ))}
          </div>
          <div className="wa-ph-tip">Tip: wrap text in *asterisks* to make it <b>bold</b> in WhatsApp.</div>
        </div>
      )}

      {/* ── Safety / pacing (ban-resistance) ────────────────────────── */}
      {provider !== 'off' && (
        <div className="wa-card">
          <div className="wa-kicker"><SafetyOutlined /> Safety &amp; pacing</div>
          <p className="wa-provider-desc" style={{ marginTop: 0 }}>
            These keep sending human-like so a number is far less likely to be flagged. Sensible defaults are already set.
          </p>
          <div className="wa-grid">
            <label className="wa-field">
              <span>Daily limit <Tooltip title="Hard ceiling of messages per day."><InfoCircleOutlined /></Tooltip></span>
              <InputNumber min={1} max={100000} value={cfg?.daily_cap} onChange={set('daily_cap')} style={{ width: '100%' }} />
            </label>
            <label className="wa-field">
              <span>Warm-up start / step <Tooltip title="A fresh number ramps up gradually: start at this many per day, add the step each day until the daily limit."><InfoCircleOutlined /></Tooltip></span>
              <div className="wa-pair">
                <InputNumber min={1} max={100000} value={cfg?.warmup_start} onChange={set('warmup_start')} />
                <span>+</span>
                <InputNumber min={0} max={100000} value={cfg?.warmup_step} onChange={set('warmup_step')} />
                <span className="wa-pair-hint">/day</span>
              </div>
            </label>
            <label className="wa-field">
              <span>Gap between sends (sec) <Tooltip title="A random delay in this range is used between each send so it never looks like a burst."><InfoCircleOutlined /></Tooltip></span>
              <div className="wa-pair">
                <InputNumber min={1} max={120} value={cfg?.min_delay_s} onChange={set('min_delay_s')} />
                <span>to</span>
                <InputNumber min={1} max={300} value={cfg?.max_delay_s} onChange={set('max_delay_s')} />
              </div>
            </label>
            <label className="wa-field">
              <span><ClockCircleOutlined /> Quiet hours (no sending)</span>
              <div className="wa-pair">
                <TimePicker format="HH:mm" value={hm(cfg?.quiet_start)} onChange={(d) => setCfg((c) => ({ ...c, quiet_start: d ? d.format('HH:mm') : '' }))} allowClear={false} />
                <span>to</span>
                <TimePicker format="HH:mm" value={hm(cfg?.quiet_end)} onChange={(d) => setCfg((c) => ({ ...c, quiet_end: d ? d.format('HH:mm') : '' }))} allowClear={false} />
              </div>
            </label>
          </div>
          <div className="wa-toggle-row">
            <Switch checked={cfg?.validate_numbers !== false} onChange={(v) => patch({ validate_numbers: v })} />
            <span>Skip numbers that aren’t on WhatsApp (recommended — avoids bounce flags)</span>
          </div>
          <div className="wa-toggle-row">
            <Switch checked={!!cfg?.auto_send_default} onChange={(v) => patch({ auto_send_default: v })} />
            <span>Pre-tick “Send on WhatsApp” on the after-save print prompt</span>
          </div>
        </div>
      )}

      {/* ── Save + Test ─────────────────────────────────────────────── */}
      {provider !== 'off' && (
        <div className="wa-actions">
          <Button type="primary" loading={saving} onClick={saveForm}>Save settings</Button>
          <div className="wa-test">
            <Input
              addonBefore={<ThunderboltOutlined />} placeholder="Number to test (e.g. 9876543210)"
              value={testNo} onChange={(e) => setTestNo(e.target.value)} style={{ maxWidth: 320 }}
              disabled={provider === 'web' && !connected}
            />
            <Button icon={<SendOutlined />} loading={busy} onClick={sendTest} disabled={provider === 'web' && !connected}>
              Send test
            </Button>
          </div>
        </div>
      )}

        </div>{/* /wa-main */}

        {/* ════════ Right column — status + activity ════════ */}
        <aside className="wa-side">
          {/* At-a-glance status */}
          <section className="wa-card wa-status">
            <div className="wa-card-h"><span className="wa-card-t">Status</span></div>
            <div className="wa-status-hero">
              <span className={`wa-dot ${connected ? 'on' : connecting ? 'wait' : 'off'}`} />
              <span className="wa-status-text">{statusText}</span>
            </div>
            <dl className="wa-meta">
              <div><dt>Method</dt><dd>{methodLabel}</dd></div>
              {connected && (
                <div><dt>Sender</dt><dd className="wa-meta-mono">{provider === 'web' ? `+${status.me || ''}` : 'Cloud API'}</dd></div>
              )}
              {provider !== 'off' && (
                <div><dt>Sent today</dt><dd>{sentToday}{cfg?.daily_cap ? <span className="wa-meta-dim"> / {cfg.daily_cap}</span> : ''}</dd></div>
              )}
              {provider !== 'off' && cfg?.quiet_start && (
                <div><dt>Quiet hours</dt><dd>{cfg.quiet_start}–{cfg.quiet_end}</dd></div>
              )}
            </dl>
          </section>

          {/* Recent activity — a clean feed, not a chat */}
          <section className="wa-card wa-activity">
            <div className="wa-card-h">
              <span className="wa-card-t">Recent activity</span>
              {outbox.length > 0 && <span className="wa-count">{outbox.length}</span>}
            </div>
            {outbox.length === 0 ? (
              <div className="wa-empty"><WhatsAppOutlined /><span>No messages sent yet.</span></div>
            ) : (
              <>
                <div className="wa-act-list">
                  {outbox.slice(0, 30).map((o) => {
                    const who = o.party?.party_name || `+${o.to_number}`;
                    const kind = DOC_KIND[o.doc_type] || 'Document';
                    const amt = amountFromCaption(o.caption);
                    return (
                      <div key={o.outbox_id} className={`wa-act${o.status === 'failed' ? ' is-failed' : ''}`}>
                        <span className="wa-act-av" style={{ background: avatarColor(who) }}>{initials(who)}</span>
                        <div className="wa-act-body">
                          <div className="wa-act-top">
                            <span className="wa-act-name">{who}</span>
                            <DeliveryTicks status={o.status} />
                          </div>
                          <div className="wa-act-sub">
                            <span>{kind}</span>
                            {amt && <><span className="wa-sep">·</span><span>{amt}</span></>}
                            <span className="wa-sep">·</span><span>{chatTime(o.sent_at || o.created_date)}</span>
                          </div>
                          {o.status === 'failed' && (
                            <div className="wa-act-err"><InfoCircleOutlined /> {o.error || 'Failed to send'}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="wa-legend">
                  <ClockCircleOutlined /> waiting<span className="wa-sep">·</span>✓ sent<span className="wa-sep">·</span>✓✓ delivered<span className="wa-sep">·</span><span className="wa-read-dot">✓✓ read</span>
                </div>
              </>
            )}
          </section>

          {/* Help */}
          <section className="wa-notes">
            <div className="wa-note"><CheckCircleFilled style={{ color: 'var(--success,#16a34a)' }} /><span>Only sent to customers who just transacted — never bulk marketing. Customers reply <b>STOP</b> to opt out.</span></div>
            <div className="wa-note"><ApiOutlined /><span>This PC must stay on for queued messages to go out — sends trickle, never blast.</span></div>
            <div className="wa-note"><SafetyOutlined /><span>Official API has <b>zero ban risk</b> (per-message cost); Web is free but uses your own number.</span></div>
          </section>
        </aside>
      </div>{/* /wa-layout */}
    </div>
  );
}
