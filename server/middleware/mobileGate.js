/**
 * Remote (tunnel) request gate
 * ───────────────────────────
 *
 * Turning on Remote Access publishes this server at a public HTTPS hostname.
 * Without this middleware, anyone who learned that hostname and a password
 * would reach the shop's books from anywhere, and "revoke this phone" in the
 * control plane would be decorative — the control plane is not in the request
 * path, so it cannot stop anything on its own.
 *
 * So every request that arrives through the tunnel must additionally present
 * a device token that the owner paired, and that the control plane still
 * lists as live. LAN and localhost traffic is untouched: this is purely an
 * extra lock on the new door, not a change to the existing one.
 *
 * ── Distinguishing tunnel traffic from LAN traffic ──
 *
 * Cloudflare's edge stamps `cf-ray` on everything it proxies, and cloudflared
 * passes it through. A LAN client cannot cause that header to be absent from
 * genuinely-proxied traffic, so its presence is a sound signal of "came from
 * the internet".
 *
 * A LAN client *could* forge `cf-ray` on its own request — but that only
 * subjects it to MORE checks, never fewer, so there is no privilege to gain.
 * The direction that would matter — a remote attacker stripping the header to
 * masquerade as LAN — is impossible, because the header is added at the edge
 * after the attacker's request leaves them.
 */

const remoteAccess = require('../services/remoteAccess');

// Reachability probes a phone needs BEFORE it holds a device token. These
// leak nothing beyond "a ZEHEN server is here", which the hostname already
// implies.
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/server-info',
  // The SSO exchange authenticates itself with a signed assertion, which is
  // stronger evidence than a device token. It also has to work on a phone's
  // very first sign-in, before this server has synced that phone's token —
  // requiring the token here would make first login impossible.
  '/api/auth/sso',
  // The login screen populates its company picker before any session exists.
  '/api/companies/list-public',
]);

/**
 * Routes that must never be reachable from the internet, even with a valid
 * device token. These administer the installation itself — restoring a
 * backup, re-pointing the licence, bulk-importing or exporting the whole
 * dataset. They are owner-at-the-PC operations, and none of them is
 * something the mobile app asks for.
 */
const REMOTE_FORBIDDEN_PREFIXES = [
  '/api/setup',
  '/api/license',
  '/api/backup',
  '/api/data',
  '/api/imports',
  '/api/compliance',
];

/** Path as the caller wrote it, undoing Express's mount-prefix stripping. */
function fullPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}` || (req.originalUrl || '').split('?')[0];
}

function isRemoteRequest(req) {
  return !!(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
}

function mobileGate(req, res, next) {
  if (!isRemoteRequest(req)) return next();

  // Flag it so downstream middleware (notably lanGate) can tell a phone on
  // mobile data apart from a PC on the office LAN.
  req.isRemoteClient = true;

  // NOTE: this middleware is mounted with app.use('/api', ...), and Express
  // strips the mount prefix from req.path — inside here, a request for
  // /api/health has req.path === '/health'. Comparing req.path against
  // '/api/...' therefore never matches. Rebuild the full path from baseUrl.
  const path = fullPath(req);
  if (PUBLIC_PATHS.has(path)) return next();

  if (REMOTE_FORBIDDEN_PREFIXES.some((p) => path.startsWith(p))) {
    return res.status(403).json({
      error: 'This action can only be performed on the shop computer.',
      code: 'REMOTE_FORBIDDEN',
    });
  }

  const token = req.headers['x-zehen-device'];
  if (!remoteAccess.isDeviceAllowed(token)) {
    return res.status(401).json({
      error: 'This device is not paired with this shop, or its access was removed.',
      code: 'DEVICE_NOT_PAIRED',
    });
  }

  return next();
}

module.exports = { mobileGate, isRemoteRequest, REMOTE_FORBIDDEN_PREFIXES };
