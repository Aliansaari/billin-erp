/**
 * WhatsApp WEB provider — Baileys 7.x (ESM, loaded via dynamic import).
 * ────────────────────────────────────────────────────────────────────
 * Baileys 7.x is ESM-only and needs Node ≥20 (provided by Electron 29+). Our
 * server is CommonJS, so we load it with dynamic import() (CJS can import ESM).
 *
 * Why 7.x: WhatsApp now addresses incoming 1:1 chats by a privacy "LID" instead
 * of the phone number. 7.x resolves LID→phone (msg.key.remoteJidAlt, and
 * signalRepository.lidMapping.getPNForLID), which is what lets the self-service
 * bot identify the customer. 6.x could not.
 *
 * The manager owns the socket lifecycle; this file is the transport: spin up a
 * socket, surface events via callbacks, validate a number, and send a PDF.
 */

// Node ≥20 exposes the Web Crypto global Baileys' handshake needs; this is a
// no-op there but kept as a defensive guard.
if (typeof globalThis.crypto === 'undefined') {
  try { globalThis.crypto = require('crypto').webcrypto; } catch { /* ignore */ }
}

// Minimal pino-compatible logger — avoids bundling pino (which is finicky inside
// an asar due to its worker-thread transports). Baileys only needs these methods.
const logger = { level: 'silent', child() { return logger; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

// ── Lazy ESM load (cached) ──
let _baileys = null;
async function getBaileys() {
  if (_baileys) return _baileys;
  _baileys = await import('@whiskeysockets/baileys');
  // Surface the enum for the manager (property access on the exports object).
  if (_baileys.DisconnectReason) module.exports.DisconnectReason = _baileys.DisconnectReason;
  return _baileys;
}

// Current WhatsApp Web version (cached) — a stale baked-in version means no QR.
let _cachedVersion = null;
async function getWAVersion(B) {
  if (_cachedVersion) return _cachedVersion;
  try {
    const { version } = await B.fetchLatestBaileysVersion();
    _cachedVersion = version;
    console.log('[whatsapp] using WhatsApp Web version', JSON.stringify(version));
  } catch (e) {
    console.error('[whatsapp] could not fetch latest WA version (using baked default):', e.message);
  }
  return _cachedVersion;
}
function resetVersionCache() { _cachedVersion = null; }

function numberFromJid(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0];
}

function mapAck(status) {
  if (status >= 4) return 'read';
  if (status === 3) return 'delivered';
  if (status === 2) return 'sent';
  return null;
}

function extractText(msg) {
  const m = msg && msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.ephemeralMessage && m.ephemeralMessage.message && (m.ephemeralMessage.message.conversation || (m.ephemeralMessage.message.extendedTextMessage && m.ephemeralMessage.message.extendedTextMessage.text))) ||
    ''
  );
}

// Resolve the sender's real phone-number JID. 7.x attaches the PN as
// remoteJidAlt/participantAlt on a LID-addressed message; fall back to the
// async LID→PN map for anything that slips through.
async function resolvePhoneJid(sock, k) {
  let pn = k.remoteJidAlt || k.participantAlt || k.senderPn || k.participantPn || k.senderAlt || '';
  const jid = k.remoteJid || '';
  if (!pn && jid.endsWith('@lid')) {
    try {
      const lm = sock.signalRepository && sock.signalRepository.lidMapping;
      if (lm && typeof lm.getPNForLID === 'function') {
        const r = await lm.getPNForLID(jid);
        if (r) pn = r;
      }
    } catch { /* best effort */ }
  }
  if (!pn && !jid.endsWith('@lid')) pn = jid;
  return pn;
}

/**
 * Start a socket. `handlers`: onQR, onConnected, onDisconnected, onAck,
 * onInbound(fromNumber, text, replyJid).
 */
async function startSocket(authDir, handlers = {}) {
  const B = await getBaileys();
  const makeWASocket = (B.default && B.default.default) || B.default || B.makeWASocket;
  const DR = B.DisconnectReason || {};
  const { state, saveCreds } = await B.useMultiFileAuthState(authDir);
  const version = await getWAVersion(B);

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    browser: ['ZEHEN', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr && handlers.onQR) handlers.onQR(qr);
    if (connection === 'open') {
      if (handlers.onConnected) handlers.onConnected(numberFromJid(sock.user && sock.user.id));
    } else if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error
        && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      const loggedOut = code === DR.loggedOut;
      if (handlers.onDisconnected) handlers.onDisconnected(code, !loggedOut);
    }
  });

  sock.ev.on('messages.update', (updates) => {
    if (!handlers.onAck) return;
    for (const up of updates) {
      const id = up.key && up.key.id;
      const status = up.update && up.update.status;
      if (id && status != null) {
        const mapped = mapAck(status);
        if (mapped) handlers.onAck(id, mapped);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!handlers.onInbound) return;
    for (const msg of (messages || [])) {
      const k = msg.key || {};
      const jid = k.remoteJid || '';
      const fromMe = !!k.fromMe;
      const text = extractText(msg);
      let phoneJid = '';
      try { phoneJid = await resolvePhoneJid(sock, k); } catch { /* ignore */ }
      const from = numberFromJid(phoneJid || jid);
      const isLid = jid.endsWith('@lid') && !phoneJid;
      console.log(`[whatsapp] inbound type=${type} jid=${jid} fromMe=${fromMe} resolvedFrom=${from} lid=${isLid} text=${JSON.stringify((text || '').slice(0, 60))}`);
      if (type !== 'notify' || fromMe || jid.endsWith('@g.us') || !text) continue;
      // Reply on the SAME thread the message arrived on (works for LID + PN).
      handlers.onInbound(from, text, jid);
    }
  });

  return sock;
}

async function resolveJid(sock, number) {
  try {
    const res = await sock.onWhatsApp(number);
    if (Array.isArray(res) && res[0] && res[0].exists) return res[0].jid;
    return null;
  } catch {
    return null;
  }
}

async function sendDocument(sock, jid, buffer, fileName, caption) {
  const sent = await sock.sendMessage(jid, {
    document: buffer,
    mimetype: 'application/pdf',
    fileName: fileName || 'document.pdf',
    caption: caption || undefined,
  });
  return (sent && sent.key && sent.key.id) || null;
}

async function sendText(sock, jid, body) {
  const sent = await sock.sendMessage(jid, { text: String(body || '') });
  return (sent && sent.key && sent.key.id) || null;
}

async function logoutSocket(sock) {
  try { await sock.logout(); } catch { /* already gone */ }
  try { if (sock.end) sock.end(undefined); } catch { /* ignore */ }
}

function resetCaches() { resetVersionCache(); }

module.exports = {
  startSocket,
  resolveJid,
  sendDocument,
  sendText,
  logoutSocket,
  numberFromJid,
  resetVersionCache,
  resetCaches,
  DisconnectReason: {}, // populated after the first getBaileys()
};
