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

// Sliding-window of recent client IDs.
//   Map<clientId, lastSeenMs>
const recent = new Map();
const WINDOW_MS = 10 * 60 * 1000;          // 10 min "still active"
let cachedSettings = null;
let cachedAt = 0;
const SETTINGS_TTL_MS = 60 * 1000;          // refresh once per minute

// Background sweeper — drops clients that haven't been seen in WINDOW_MS
// so the cap counts only currently-active machines. Runs every 30s.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, ts] of recent) {
    if (ts < cutoff) recent.delete(id);
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

// Map an incoming request to a stable "client identity" for cap counting.
// Prefers the JWT user_id (machine-independent — same user on two devices
// counts twice because their tokens differ; same machine across reloads
// counts once because the token persists in localStorage). Falls back to
// IP for unauthenticated routes.
function clientIdFor(req) {
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET || 'dev-secret-change-me');
      // Token + user_id makes each "session" a distinct client even if
      // two staff log in from the same PC at different times. The JTI
      // would be cleaner but we don't issue one — using the iat (issued
      // at) as a session-stable per-token discriminator is good enough.
      return `user:${payload.user_id}:${payload.iat || 0}`;
    } catch { /* invalid token — fall through to IP */ }
  }
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').toString();
  return `ip:${ip}`;
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

  // Track activity from non-loopback requests for cap accounting.
  if (!isLoopback(req)) {
    const id = clientIdFor(req);
    const now = Date.now();
    if (!recent.has(id) && Number(settings.dev_lan_max_clients) > 0) {
      // New client — would they exceed the cap?
      const activeCount = recent.size;
      if (activeCount >= Number(settings.dev_lan_max_clients)) {
        return res.status(503).json({
          error: `Maximum LAN client limit reached (${settings.dev_lan_max_clients}). Wait for an existing client to go idle, or ask the administrator to raise the cap in Developer Settings.`,
          code: 'LAN_MAX_CLIENTS',
          active: activeCount,
          limit: Number(settings.dev_lan_max_clients),
        });
      }
    }
    recent.set(id, now);
  }

  next();
}

// Diagnostic helper — exposed via /api/server-info for the Developer
// Settings page to show "X clients active right now".
function getActiveClients() {
  return {
    active_count: recent.size,
    window_ms: WINDOW_MS,
  };
}

module.exports = { lanGate, invalidateLanGateCache, getActiveClients };
