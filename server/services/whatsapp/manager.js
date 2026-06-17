/**
 * WhatsApp manager — orchestration + the paced outbox worker.
 * ──────────────────────────────────────────────────────────
 * Owns the per-company live state (web socket, connection status, QR, daily
 * counters) and a single background worker that drains each company's
 * whatsapp_outbox ONE message at a time with human-like pacing, caps,
 * warm-up ramp, quiet-hours, number validation and opt-out. The UI can only
 * ENQUEUE — it can never blast — which is the core of the ban-resistance design.
 *
 * Multi-tenant: every DB touch goes through withCompany() →
 * getCompanyConnection() + companyContext.run(), because Baileys event handlers
 * (acks / inbound) fire OUTSIDE any request context and must resolve the right
 * company DB explicitly (never the ALS fallback proxies).
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Op } = require('sequelize');

const { getCompanyConnection, companyContext } = require('../companyConnections');
const web = require('./providerWeb');
const official = require('./providerOfficial');
const pacing = require('./pacing');
const bot = require('./bot');
const { upgradePatch } = require('./templates');

// ── Live per-company state (in memory) ──
// companyId -> { provider, state, qr, me, sock, shouldRun, registered, draining, nextEligibleAt }
const STATE = new Map();

function ensureState(companyId) {
  const id = Number(companyId);
  let s = STATE.get(id);
  if (!s) {
    s = { provider: null, state: 'disconnected', qr: null, me: null, sock: null,
          shouldRun: false, registered: false, draining: false, nextEligibleAt: 0 };
    STATE.set(id, s);
  }
  return s;
}

function authDir(companyId) {
  const baseDir = process.env.WHATSAPP_DATA_DIR || path.join(os.homedir(), '.zehen', 'whatsapp');
  return path.join(baseDir, String(companyId));
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Human-readable reason for a web disconnect, surfaced in the Settings UI so a
// failed link isn't a silent black box.
function disconnectReason(code) {
  const R = web.DisconnectReason || {};
  switch (code) {
    case R.loggedOut:          return 'Logged out on the phone — scan again to re-link.';
    case R.connectionReplaced: return 'This number is linked in another session. Disconnect it there, or use a dedicated number.';
    case R.connectionLost:     return 'Lost connection to WhatsApp — check this PC’s internet and try again.';
    case R.timedOut:           return 'Connection timed out — check this PC’s internet and try again.';
    case R.badSession:         return 'The saved session was invalid — it has been cleared. Please scan again.';
    case R.multideviceMismatch:return 'Update WhatsApp on your phone, then try again (multi-device mismatch).';
    case R.restartRequired:    return null;   // normal mid-link restart; not an error
    case R.connectionClosed:   return null;   // transient; auto-retrying
    default:                   return code ? `Disconnected (code ${code}) — check internet and try again.` : null;
  }
}

// "Optional" placeholders represent balance figures that may not apply (e.g. a
// cash-paid bill has no previous balance / outstanding). When one of these is
// empty, the WHOLE line it sits on is dropped — so "Previous balance: {previous}"
// vanishes entirely rather than leaving a dangling label. Essential placeholders
// ({name}/{billno}/{amount}/{shop}/{date}) never drop a line; they just blank out.
const OPTIONAL_VARS = new Set(['previous', 'outstanding', 'balance']);

function fillTemplate(tpl, vars) {
  const kept = [];
  for (const line of String(tpl || '').split('\n')) {
    let drop = false;
    const filled = line.replace(/\{(\w+)\}/g, (_, k) => {
      const v = vars[k];
      const empty = (v == null || v === '');
      if (empty && OPTIONAL_VARS.has(k)) drop = true;
      return empty ? '' : String(v);
    });
    if (!drop) kept.push(filled);
  }
  return kept.join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')   // collapse gaps left by dropped lines
    .trim();
}

// Pick the right message template for the document being sent.
function templateFor(settings, docType) {
  const t = String(docType || '').toLowerCase();
  if (t === 'ledger' || t === 'statement') return settings.msg_template_ledger;
  if (t === 'receipt' || t === 'payment') return settings.msg_template_receipt;
  return settings.msg_template_bill; // sales / purchase / returns / default
}

// Build the message caption. An explicit caption (legacy callers) wins;
// otherwise fill the configurable template, sourcing {shop} from the company's
// own name so the operator never has to type it.
async function resolveCaption(companyId, settings, { caption, vars, doc_type }) {
  if (caption) return caption;
  if (!vars) return null;
  const tpl = templateFor(settings, doc_type);
  if (!tpl) return null;
  let shop = '';
  try {
    shop = await withCompany(companyId, async (models) => {
      const sys = await models.SystemSettings.findOne();
      return (sys && sys.company_name) || '';
    });
  } catch { /* shop stays blank */ }
  return fillTemplate(tpl, { shop, ...vars });
}

function officialCfg(s) {
  return {
    apiBase: s.official_api_base,
    phoneNumberId: s.official_phone_number_id,
    accessToken: s.official_access_token,
    templateName: s.official_template_name,
    templateLang: s.official_template_lang,
  };
}

// ── DB helpers (always inside the right company context) ──
async function withCompany(companyId, fn) {
  const conn = await getCompanyConnection(companyId);
  return companyContext.run(
    { sequelize: conn.sequelize, models: conn.models, companyId: Number(companyId) },
    () => fn(conn.models, conn.sequelize),
  );
}

async function getOrCreateSettings(models) {
  const [s] = await models.WhatsappSettings.findOrCreate({
    where: { whatsapp_settings_id: 1 },
    defaults: { whatsapp_settings_id: 1 },
  });
  // One-time wording refresh: if a template is still an untouched old default,
  // upgrade it to the current polished default. Customised text is left as-is.
  const patch = upgradePatch(s);
  if (Object.keys(patch).length) { try { await s.update(patch); } catch { /* non-fatal */ } }
  return s;
}

function loadSettings(companyId) {
  return withCompany(companyId, (models) => getOrCreateSettings(models));
}

// ── Public: status ──
async function getStatus(companyId) {
  const settings = await loadSettings(companyId);
  const s = STATE.get(Number(companyId)) || {};
  let state;
  if (settings.provider === 'official') {
    state = official.isConfigured(officialCfg(settings)) ? 'connected' : 'disconnected';
  } else if (settings.provider === 'web') {
    state = s.state || settings.connection_state || 'disconnected';
  } else {
    state = 'disconnected';
  }
  return {
    provider: settings.provider,
    enabled: !!settings.enabled,
    state,
    qr: s.qr || null,
    me: s.me || settings.linked_number || null,
    // Surfaced in the Settings UI when a link attempt fails — no silent spinner.
    last_error: s.lastError || null,
    // Non-sensitive — lets the send surfaces (operators, who can't read the
    // full settings) decide whether to pre-tick "Also send on WhatsApp".
    auto_send_default: !!settings.auto_send_default,
  };
}

// ── Web: connect / reconnect ──
async function connectWeb(companyId) {
  const id = Number(companyId);
  const s = ensureState(id);
  if (s.sock && (s.state === 'connected' || s.state === 'connecting')) return getStatus(id);
  s.provider = 'web';
  s.state = 'connecting';
  s.qr = null;
  s.lastError = null;
  s.shouldRun = true;
  s.registered = true;
  fs.mkdirSync(authDir(id), { recursive: true });

  const sock = await web.startSocket(authDir(id), {
    onQR: (qr) => { s.qr = qr; s.state = 'connecting'; s.lastError = null; },
    onConnected: (me) => {
      s.state = 'connected'; s.me = me; s.qr = null; s.lastError = null;
      console.log(`[whatsapp] company ${id} connected as ${me}`);
      persistConn(id, 'connected', me).catch(() => {});
    },
    onDisconnected: (code, willReconnect) => {
      s.state = 'disconnected'; s.sock = null;
      s.lastError = disconnectReason(code);
      console.log(`[whatsapp] company ${id} disconnected (code ${code}); reconnect=${willReconnect && s.shouldRun}`);
      persistConn(id, 'disconnected', s.me).catch(() => {});
      // Invalid saved session → wipe it so the reconnect shows a fresh QR.
      if (code === (web.DisconnectReason || {}).badSession) {
        try { fs.rmSync(authDir(id), { recursive: true, force: true }); } catch { /* ignore */ }
      }
      if (willReconnect && s.shouldRun) {
        // Refetch the WA version on reconnect so a version bump self-heals.
        web.resetVersionCache();
        setTimeout(() => { connectWeb(id).catch(() => {}); }, 3000);
      }
    },
    onAck: (msgId, status) => { handleAck(id, msgId, status).catch(() => {}); },
    onInbound: (from, text, replyJid) => { handleInbound(id, from, text, replyJid).catch(() => {}); },
  });
  s.sock = sock;
  ensureWorker();
  return getStatus(id);
}

async function logoutWeb(companyId) {
  const id = Number(companyId);
  const s = ensureState(id);
  s.shouldRun = false;
  if (s.sock) { try { await web.logoutSocket(s.sock); } catch { /* ignore */ } }
  s.sock = null; s.state = 'disconnected'; s.qr = null; s.me = null;
  try { fs.rmSync(authDir(id), { recursive: true, force: true }); } catch { /* ignore */ }
  await persistConn(id, 'disconnected', null);
  await withCompany(id, async (models) => {
    const set = await getOrCreateSettings(models);
    await set.update({ linked_number: null });
  });
  return getStatus(id);
}

async function persistConn(companyId, state, me) {
  await withCompany(companyId, async (models) => {
    const set = await getOrCreateSettings(models);
    await set.update({
      connection_state: state,
      linked_number: me || set.linked_number,
      connected_at: state === 'connected' ? new Date() : set.connected_at,
    });
  });
}

// Register a company with the worker and lazily reconnect a saved web session
// (so a send works even if the user never opened the WhatsApp settings tab).
async function ensureRegistered(companyId) {
  const id = Number(companyId);
  const settings = await loadSettings(id);
  const s = ensureState(id);
  s.provider = settings.provider;
  if (!settings.enabled || settings.provider === 'off') return;
  s.registered = true;
  if (settings.provider === 'web' && !s.sock) {
    const hasSession = fs.existsSync(path.join(authDir(id), 'creds.json'));
    if (hasSession) connectWeb(id).catch(() => {});
  }
  ensureWorker();
}

// ── Acks + inbound (STOP) ──
const ACK_RANK = { queued: 0, sending: 0, sent: 1, delivered: 2, read: 3 };
async function handleAck(companyId, msgId, status) {
  await withCompany(companyId, async (models) => {
    const row = await models.WhatsappOutbox.findOne({ where: { wa_message_id: msgId } });
    if (!row) return;
    if ((ACK_RANK[status] || 0) <= (ACK_RANK[row.status] || 0)) return; // never downgrade
    const patch = { status };
    if (status === 'delivered') patch.delivered_at = new Date();
    if (status === 'read') patch.read_at = new Date();
    await row.update(patch);
  });
}

const OPT_OUT_WORDS = new Set(['stop', 'unsubscribe', 'optout', 'opt out', 'stop promotions', 'band karo', 'rok do']);
async function handleInbound(companyId, fromNumber, text, replyJid) {
  const t = String(text || '').trim().toLowerCase();

  // 1) Opt-out keywords take priority — honour STOP and don't bot-reply.
  if (OPT_OUT_WORDS.has(t)) {
    const last10 = String(fromNumber).slice(-10);
    if (last10.length < 10) return;
    await withCompany(companyId, async (models) => {
      const parties = await models.Party.findAll({
        where: { [Op.or]: [
          { mobile_1: { [Op.like]: `%${last10}` } },
          { mobile_2: { [Op.like]: `%${last10}` } },
        ] },
      });
      for (const p of parties) { try { await p.update({ whatsapp_opt_out: true }); } catch { /* ignore */ } }
      await models.WhatsappOutbox.update(
        { status: 'skipped', error: 'recipient opted out (STOP)' },
        { where: { to_number: fromNumber, status: 'queued' } },
      );
      console.log(`[whatsapp] company ${companyId} opt-out from ${fromNumber} (${parties.length} party rows)`);
    });
    return;
  }

  // 2) Self-service bot (only if enabled + connected).
  try {
    const settings = await loadSettings(companyId);
    const s = STATE.get(Number(companyId));
    console.log(`[whatsapp] bot route: from=${fromNumber} text=${JSON.stringify(String(text || '').slice(0, 40))} enabled=${!!settings.bot_enabled} state=${s && s.state}`);
    if (!settings.bot_enabled) { console.log('[whatsapp] bot: disabled — no reply'); return; }
    if (!s || !s.sock || s.state !== 'connected') { console.log('[whatsapp] bot: not connected — no reply'); return; }
    const target = replyJid || pacing.toJid(fromNumber);
    await bot.handle({
      companyId, fromNumber, text, settings, withCompany,
      // Reply on the SAME thread the message arrived on (handles LID + phone).
      sendText: (msg) => s.sock.sendMessage(target, { text: msg }),
      sendDoc: (buffer, fileName, caption) => s.sock.sendMessage(target, {
        document: buffer, mimetype: 'application/pdf', fileName: fileName || 'document.pdf', caption: caption || undefined,
      }),
    });
    console.log('[whatsapp] bot: handled');
  } catch (e) {
    console.error('[whatsapp] bot error:', e.message, e.stack);
  }
}

// ── Enqueue ──
async function enqueue(companyId, { to, pdfBase64, fileName, caption, vars, party_id, doc_type, doc_id }) {
  const number = pacing.normalizeNumber(to);
  if (!number) { const e = new Error('Invalid phone number'); e.code = 'BAD_NUMBER'; throw e; }
  if (!pdfBase64) { const e = new Error('Missing PDF payload'); e.code = 'NO_PAYLOAD'; throw e; }
  const settings = await loadSettings(companyId);
  if (settings.provider === 'off' || !settings.enabled) {
    const e = new Error('WhatsApp is not connected'); e.code = 'NOT_CONNECTED'; throw e;
  }
  // Resolve the message text from the configurable template (with the company
  // name filled in) so what goes out matches Settings → WhatsApp → Message text.
  const finalCaption = await resolveCaption(companyId, settings, { caption, vars, doc_type });
  const row = await withCompany(companyId, (models) => models.WhatsappOutbox.create({
    provider: settings.provider,
    to_number: number,
    to_jid: pacing.toJid(number),
    party_id: party_id || null,
    doc_type: doc_type || null,
    doc_id: doc_id || null,
    file_name: fileName || 'document.pdf',
    caption: finalCaption || null,
    payload_base64: pdfBase64,
    status: 'queued',
    scheduled_at: new Date(),
  }));
  await ensureRegistered(companyId);
  return { outbox_id: row.outbox_id, status: 'queued' };
}

// ── Test message (text) ──
async function sendTest(companyId, to) {
  const number = pacing.normalizeNumber(to);
  if (!number) throw new Error('Invalid phone number');
  const settings = await loadSettings(companyId);
  const body = 'WhatsApp connected successfully — this is a test message from ZEHEN.';
  if (settings.provider === 'web') {
    const s = ensureState(companyId);
    if (!s.sock || s.state !== 'connected') throw new Error('WhatsApp Web is not connected');
    const jid = (settings.validate_numbers ? await web.resolveJid(s.sock, number) : null) || pacing.toJid(number);
    await s.sock.sendMessage(jid, { text: body });
    return { ok: true };
  }
  if (settings.provider === 'official') {
    await official.sendText(officialCfg(settings), number, body);
    return { ok: true };
  }
  throw new Error('WhatsApp is not connected');
}

// ── Outbox worker ──
let _tick = null;
function ensureWorker() {
  if (_tick) return;
  _tick = setInterval(() => { tick().catch((e) => console.error('[whatsapp] tick error:', e.message)); }, 3000);
  if (_tick.unref) _tick.unref();
}

async function tick() {
  for (const [companyId, s] of STATE.entries()) {
    maybeSendDigest(companyId, s).catch((e) => console.error('[whatsapp] digest:', e.message));
    if (!s.registered || s.draining) continue;
    if (Date.now() < (s.nextEligibleAt || 0)) continue;
    await drainOne(companyId).catch((e) => console.error(`[whatsapp] drain ${companyId}:`, e.message));
  }
}

// ── Daily owner digest ──
// Checked once per clock-minute per company. Sends within a 3-hour window
// after the configured time, exactly once per day (the date is persisted so a
// restart inside the window doesn't re-send).
function _pad2(n) { return String(n).padStart(2, '0'); }
function _parseList(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
async function maybeSendDigest(companyId, s) {
  if (!s.sock || s.state !== 'connected' || s.digestBusy) return;
  const now = new Date();
  const minuteKey = `${now.getHours()}:${now.getMinutes()}`;
  if (s.digestMinute === minuteKey) return;       // throttle: one check per minute
  s.digestMinute = minuteKey;
  s.digestBusy = true;
  try {
    await withCompany(companyId, async (models) => {
      const set = await getOrCreateSettings(models);
      if (!set.bot_enabled || !set.bot_daily_digest) return;
      const owners = _parseList(set.bot_owner_numbers);
      if (!owners.length) return;
      const [hh, mm] = String(set.bot_digest_time || '21:00').split(':').map((x) => parseInt(x, 10) || 0);
      const targetMin = hh * 60 + mm;
      const curMin = now.getHours() * 60 + now.getMinutes();
      if (curMin < targetMin || curMin > targetMin + 180) return;   // only in a 3h window
      const today = `${now.getFullYear()}-${_pad2(now.getMonth() + 1)}-${_pad2(now.getDate())}`;
      const last = set.bot_digest_last_sent ? String(set.bot_digest_last_sent).slice(0, 10) : null;
      if (last === today) return;                  // already sent today
      await set.update({ bot_digest_last_sent: today }); // persist BEFORE sending → no dup
      const sys = await models.SystemSettings.findOne();
      const shop = (sys && sys.company_name) || 'us';
      const msg = await bot.buildDailyDigest(models, shop);
      for (const num of owners) {
        try { await s.sock.sendMessage(pacing.toJid(num), { text: msg }); }
        catch (e) { console.error('[whatsapp] digest send:', e.message); }
      }
      console.log(`[whatsapp] daily digest sent to ${owners.length} owner(s) — company ${companyId}`);
    });
  } finally { s.digestBusy = false; }
}

async function drainOne(companyId) {
  const s = ensureState(companyId);
  s.draining = true;
  try {
    await withCompany(companyId, async (models) => {
      const settings = await getOrCreateSettings(models);
      if (settings.provider === 'off' || !settings.enabled) return;
      if (settings.provider === 'web' && s.state !== 'connected') return;
      if (settings.provider === 'official' && !official.isConfigured(officialCfg(settings))) return;

      // Quiet hours — defer 10 min.
      if (pacing.isQuietHours(settings)) { s.nextEligibleAt = Date.now() + 10 * 60000; return; }

      // Daily cap (with warm-up ramp) — count today's successful sends.
      const cap = pacing.effectiveDailyCap(settings);
      const sentToday = await models.WhatsappOutbox.count({
        where: { status: { [Op.in]: ['sent', 'delivered', 'read'] }, sent_at: { [Op.gte]: startOfToday() } },
      });
      if (sentToday >= cap) { s.nextEligibleAt = Date.now() + 30 * 60000; return; }

      const row = await models.WhatsappOutbox.findOne({
        where: { status: 'queued', [Op.or]: [{ scheduled_at: null }, { scheduled_at: { [Op.lte]: new Date() } }] },
        order: [['created_date', 'ASC']],
      });
      if (!row) return;
      await processRow(s, models, settings, row);
    });
  } finally {
    s.draining = false;
  }
}

async function processRow(s, models, settings, row) {
  // Opt-out guard.
  if (row.party_id) {
    const party = await models.Party.findByPk(row.party_id, { attributes: ['party_id', 'whatsapp_opt_out'] });
    if (party && party.whatsapp_opt_out) { await row.update({ status: 'skipped', error: 'recipient opted out' }); return; }
  }
  // Text rows (e.g. paced payment reminders) carry their message in `caption`
  // and have no PDF payload; document rows carry base64 bytes. Same queue, same
  // pacing/caps/opt-out — only the send call differs.
  const isText = !row.payload_base64;
  let buffer = null;
  if (isText) {
    if (!row.caption) { await row.update({ status: 'failed', error: 'empty text' }); return; }
  } else {
    buffer = Buffer.from(row.payload_base64, 'base64');
    if (!buffer.length) { await row.update({ status: 'failed', error: 'empty payload' }); return; }
  }

  await row.update({ status: 'sending', attempts: row.attempts + 1 });
  try {
    let messageId = null;
    if (settings.provider === 'web') {
      if (!s.sock) throw new Error('not connected');
      let jid = row.to_jid;
      if (settings.validate_numbers) {
        const resolved = await web.resolveJid(s.sock, row.to_number);
        if (!resolved) { await row.update({ status: 'skipped', error: 'number not on WhatsApp' }); return; }
        jid = resolved;
      }
      jid = jid || pacing.toJid(row.to_number);
      messageId = isText
        ? await web.sendText(s.sock, jid, row.caption)
        : await web.sendDocument(s.sock, jid, buffer, row.file_name, row.caption);
    } else {
      messageId = isText
        ? await official.sendText(officialCfg(settings), row.to_number, row.caption)
        : await official.sendDocument(officialCfg(settings), row.to_number, buffer, row.file_name, row.caption);
    }
    await row.update({ status: 'sent', sent_at: new Date(), wa_message_id: messageId, payload_base64: null, error: null });
    if (!settings.warmup_started_on) { await settings.update({ warmup_started_on: new Date() }); }
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    if (row.attempts >= 3) {
      await row.update({ status: 'failed', error: msg });
    } else {
      // Backoff: requeue with a growing delay.
      await row.update({ status: 'queued', scheduled_at: new Date(Date.now() + row.attempts * 60000), error: msg });
    }
  } finally {
    // Pace the NEXT send regardless of outcome.
    s.nextEligibleAt = Date.now() + pacing.randomDelayMs(settings);
  }
}

// ── Boot: reconnect the primary company's saved web session (single-shop case) ──
async function bootReconnect() {
  try {
    const Company = require('../../models/Company');
    const primary = await Company.findOne({ where: { is_primary: true } });
    const id = primary && primary.company_id;
    if (!id) return;
    if (fs.existsSync(path.join(authDir(id), 'creds.json'))) {
      console.log(`[whatsapp] boot: found saved session for company ${id} — reconnecting`);
      await ensureRegistered(id);
    }
  } catch (e) {
    console.error('[whatsapp] bootReconnect skipped:', e.message);
  }
}

module.exports = {
  getStatus,
  connectWeb,
  logoutWeb,
  ensureRegistered,
  enqueue,
  sendTest,
  bootReconnect,
};
