/**
 * LAN client gate
 * ─────────────────
 *
 * Enforces the developer-controlled LAN deployment knobs from
 * system_settings:
 *
 *   dev_lan_enabled       — when false, every request from a non-loopback
 *                           IP is rejected (503). Still permits localhost
 *                           so the host machine itself stays usable.
 *
 *   dev_lan_max_clients   — when > 0, caps the number of distinct active
 *                           clients in a sliding 10-minute window. The
 *                           (n+1)th client gets a 503 with a
 *                           "license cap reached" message. A "client" is
 *                           keyed on the bearer-JWT user_id; if the JWT
 *                           is missing (anonymous /api/health, /server-info
 *                           probes), the IP is used instead.
 *
 * The flags are read once per minute via the shared system-settings
 * cache so the middleware doesn't hit Postgres on every API call. A
 * developer flipping a toggle in DeveloperSettings sees the new
 * behaviour within a minute (or instantly via refreshSystemSettings()
 * which the page calls on save).
 *
 * Loopback IPs are NEVER counted: the host machine running the server
 * needs to be able to bill from its own Electron window without
 * consuming a license slot.
 */

const jwt = require('jsonwebtoken');
const SystemSettings = require('../models/SystemSettings');

// Sliding-window of recent clients.
//   Map<clientId, { ip, userId, username, firstSeen, lastSeen }>
const recent = new Map();
// Admin-disconnected devices, keyed by normalised IP. A blocked IP's
// requests are rejected (503) until the admin re-allows it (or the
// server restarts). Deliberately NOT auto-expired so a "disconnect"
// sticks until explicitly undone.
const blocked = new Map();
const WINDOW_MS = 10 * 60 * 1000;          // 10 min "still active"
let cachedSettings = null;
let cachedAt = 0;
const SETTINGS_TTL_MS = 60 * 1000;          // refresh once per minute

// Background sweeper — drops clients that haven't been seen in WINDOW_MS
// so the cap counts only currently-active machines. Runs every 30s.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, e] of recent) {
    if ((e?.lastSeen || 0) < cutoff) recent.delete(id);
  }
}, 30 * 1000).unref();

async function loadSettings() {
  const now = Date.now();
  if (cachedSettings && now - cachedAt < SETTINGS_TTL_MS) return cachedSettings;
  try {
    const row = await SystemSettings.findByPk(1);
    cachedSettings = row ? row.toJSON() : {};
    cachedAt = now;
  } catch (e) {
    // If we can't read settings, fall back to permissive defaults so a DB
    // hiccup doesn't lock everyone out of the system.
    cachedSettings = { dev_lan_enabled: true, dev_lan_max_clients: 0 };
    cachedAt = now;
  }
  return cachedSettings;
}

// Drop the cache so the next request re-reads. Call this from the
// settings controller on save so toggle changes take effect instantly.
function invalidateLanGateCache() {
  cachedSettings = null;
  cachedAt = 0;
}

// Normalise an IP for display + matching: strip the IPv6-mapped prefix
// and collapse loopback to 127.0.0.1.
function normIp(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') s = '127.0.0.1';
  return s;
}

// Identify the device/session behind a request. Prefers the JWT
// (user_id + iat → a stable per-session id, and the username for the
// admin's device list); falls back to the IP for unauthenticated routes.
// Always returns the normalised client IP so a device can be shown and
// disconnected.
//
// Audit C16 — only ever verify with the real JWT_SECRET pinned to HS256
// (same as middleware/auth.js); a missing secret means we treat the
// request as anonymous rather than trusting a forgeable token.
function identify(req) {
  const ip = normIp(req.ip || req.connection?.remoteAddress || 'unknown');
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ') && process.env.JWT_SECRET) {
    try {
      const p = jwt.verify(auth.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
      return { id: `user:${p.user_id}:${p.iat || 0}`, userId: p.user_id ?? null, username: p.username || null, ip };
    } catch { /* invalid token — fall through to IP identity */ }
  }
  return { id: `ip:${ip}`, userId: null, username: null, ip };
}

// True iff the request originated on the same machine as the server.
// Skipped from gating so the host PC can always bill regardless of
// LAN limits.
function isLoopback(req) {
  const ip = (req.ip || req.connection?.remoteAddress || '').toString();
  // Express normalises IPv6-mapped IPv4 to ::ffff:127.0.0.1
  return /^(::1|::ffff:127\.0\.0\.1|127\.|::ffff:::1)/.test(ip) || ip === 'localhost';
}

async function lanGate(req, res, next) {
  // Health/info endpoints never gate — clients need to be able to confirm
  // server reachability before login or LAN-limit kicks in.
  // /api/companies/list-public is similarly exempt: the login screen
  // needs to populate the picker BEFORE the user has any token, and
  // that population shouldn't itself burn a license slot.
  const path = req.path || req.url;
  if (
    path === '/api/health' ||
    path === '/api/server-info' ||
    path === '/api/companies/list-public' ||
    path.startsWith('/api/setup/') ||      // first-run wizard bypasses LAN cap
    path.startsWith('/api/license/')        // activation flow bypasses LAN cap
  ) return next();

  const settings = await loadSettings();

  // Master kill-switch.
  if (settings.dev_lan_enabled === false && !isLoopback(req)) {
    return res.status(503).json({
      error: 'LAN access has been disabled by the administrator.',
      code: 'LAN_DISABLED',
    });
  }

  // Track activity from non-loopback requests for cap accounting +
  // admin disconnect/blocklist.
  if (!isLoopback(req)) {
    const who = identify(req);
    const now = Date.now();

    // Admin-disconnected device — reject every request until re-allowed.
    if (blocked.has(who.ip)) {
      return res.status(503).json({
        error: 'This device was disconnected by the administrator.',
        code: 'LAN_DEVICE_BLOCKED',
      });
    }

    if (!recent.has(who.id) && Number(settings.dev_lan_max_clients) > 0) {
      // New client — would they exceed the cap?
      const activeCount = recent.size;
      if (activeCount >= Number(settings.dev_lan_max_clients)) {
        return res.status(503).json({
          error: `Maximum LAN device limit reached (${settings.dev_lan_max_clients}). Wait for one to go idle, or raise the cap in Settings → LAN & Network.`,
          code: 'LAN_MAX_CLIENTS',
          active: activeCount,
          limit: Number(settings.dev_lan_max_clients),
        });
      }
    }
    const existing = recent.get(who.id);
    recent.set(who.id, {
      ip: who.ip,
      userId: who.userId,
      username: who.username,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
    });
  }

  next();
}

// Diagnostic helper — exposed via /api/server-info to show the count.
function getActiveClients() {
  return {
    active_count: recent.size,
    window_ms: WINDOW_MS,
  };
}

// Full list for the admin LAN page: one row per active device/session,
// plus the currently-blocked devices.
function listActiveClients() {
  const now = Date.now();
  const clients = [];
  for (const [id, e] of recent) {
    clients.push({
      id,
      ip: e.ip || null,
      user_id: e.userId ?? null,
      username: e.username || null,
      first_seen: e.firstSeen || null,
      last_seen: e.lastSeen || null,
      idle_ms: now - (e.lastSeen || now),
    });
  }
  clients.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  const blockedList = [];
  for (const [ip, b] of blocked) blockedList.push({ ip, since: b.since || null });
  return { active_count: recent.size, window_ms: WINDOW_MS, clients, blocked: blockedList };
}

// Disconnect (kick) a device by IP: block its future requests and drop
// any active sessions it has so the count + cap free up immediately. The
// block persists until allowClient() or a server restart.
function disconnectClient(ip) {
  const ipNorm = normIp(ip);
  if (!ipNorm) return { ok: false };
  blocked.set(ipNorm, { since: Date.now() });
  for (const [id, e] of recent) {
    if (normIp(e.ip) === ipNorm) recent.delete(id);
  }
  return { ok: true, ip: ipNorm };
}

// Re-allow a previously-disconnected device.
function allowClient(ip) {
  const ipNorm = normIp(ip);
  blocked.delete(ipNorm);
  return { ok: true, ip: ipNorm };
}

module.exports = {
  lanGate, invalidateLanGateCache, getActiveClients,
  listActiveClients, disconnectClient, allowClient,
};
