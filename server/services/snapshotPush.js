/**
 * Offline snapshot push
 * ─────────────────────
 *
 * When the shop's PC is switched off, its tunnel goes down and the phone can
 * reach nothing. This service periodically uploads the shop's HEADLINE
 * FIGURES to the control plane so the owner can still open the app and see
 * where the business stands — read-only, clearly timestamped.
 *
 * ══ Why it calls its own HTTP API instead of querying the database ══
 *
 * Every figure here is produced by the SAME controller that serves the live
 * screen. That is the entire point. Re-deriving "today's sales" or "party
 * outstanding" with fresh SQL would create a second implementation of the
 * money math, and the two would drift — the phone would eventually show a
 * different number than the desktop for the same day, which for an
 * accounting product is the worst possible failure. One implementation, two
 * delivery paths.
 *
 * What is deliberately NOT here: arbitrary date-range reports. Those need
 * transactional rows, which would make this a replica rather than a
 * snapshot. Reports require the PC to be on, and the app says so.
 *
 * Writes never block anything. A shop with no internet simply never uploads,
 * and nothing about billing changes.
 */

const fs   = require('fs');
const os   = require('os');
const jwt  = require('jsonwebtoken');

const remoteAccess = require('./remoteAccess');
const license = require('./license');
const { resolveLicensePath } = require('../config/license');

// Ten minutes: frequent enough that "as of" is never embarrassing, rare
// enough to stay far inside every free-tier limit even with many shops.
const PUSH_INTERVAL_MS = 10 * 60_000;

// Stay a little under the control plane's 512 KB hard cap so a payload that
// grew slightly between measuring and sending is not rejected at the edge.
const SNAPSHOT_SOFT_LIMIT = 460 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

// The sections a phone can open with the PC off. Each is one call to this
// server's own API — same code path as the live screen.
const SECTIONS = [
  { key: 'dashboard',   path: '/api/reports/dashboard' },
  { key: 'insights',    path: '/api/reports/dashboard/insights' },
  { key: 'outstanding', path: '/api/reports/party-outstanding' },
  { key: 'dayBook',     path: '/api/reports/day-book' },
  { key: 'stock',       path: '/api/products?limit=500' },
  { key: 'parties',     path: '/api/parties?limit=500' },
];

let timer = null;
let lastResult = null;

/**
 * Mint a short-lived token for an admin user so the internal calls go through
 * the ordinary auth + permission stack rather than around it. Sixty seconds,
 * never written to disk, never leaves this process.
 */
async function systemToken() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');

  // Models are per-company factories behind an AsyncLocalStorage proxy, so
  // they must come from the models bag — requiring the file directly yields
  // the definition function, not a bound model.
  const { User, Role } = require('../models');
  const user = await User.findOne({
    where: { is_active: true },
    include: [{ model: Role }],
    order: [['user_id', 'ASC']],
  });
  if (!user) throw new Error('No active user to sign a snapshot token for');

  return jwt.sign(
    {
      user_id: user.user_id,
      username: user.username,
      role: user.Role?.role_name || 'Admin',
      company_id: 1,
      snapshot: true,          // marks provenance in any audit log
    },
    process.env.JWT_SECRET,
    { expiresIn: '60s' },
  );
}

async function collect(port, token) {
  const sections = {};
  const failed = [];

  for (const section of SECTIONS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${section.path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) { failed.push(section.key); continue; }
      sections[section.key] = await res.json();
    } catch {
      // One slow report must not cost us the whole snapshot — push what we
      // have and record which parts are missing, so the app can grey out
      // exactly those and keep showing the rest.
      failed.push(section.key);
    }
  }
  return { sections, failed };
}

async function pushOnce() {
  const status = remoteAccess.getStatus();
  if (!status.enabled || !status.site_id) return { skipped: 'remote access is off' };

  let licenseText;
  try {
    licenseText = fs.readFileSync(resolveLicensePath(), 'utf8').trim();
  } catch {
    return { skipped: 'no licence file' };
  }

  const port = process.env.SERVER_PORT || 3001;
  const token = await systemToken();
  const { sections, failed } = await collect(port, token);

  if (!Object.keys(sections).length) return { skipped: 'every section failed' };

  const payload = {
    generated_at: Date.now(),
    host: os.hostname(),
    missing: failed,
    sections,
  };

  // Keep the upload under the server's cap by shedding the bulky, least
  // essential sections first.
  //
  // Without this, a shop with a few thousand products would exceed the limit,
  // be rejected outright, and end up with NO offline data — the large shops
  // that most need it would be the ones that silently never got it. Degrading
  // to "balances and today's figures, but no full item list" is far better
  // than degrading to nothing.
  const SHED_ORDER = ['stock', 'parties', 'dayBook', 'insights'];
  for (const key of SHED_ORDER) {
    if (JSON.stringify(payload).length <= SNAPSHOT_SOFT_LIMIT) break;
    if (payload.sections[key] === undefined) continue;
    delete payload.sections[key];
    payload.missing.push(key);
    payload.trimmed = true;
  }

  const res = await fetch(`${remoteAccess.CONTROL_PLANE_URL}/v1/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      license: licenseText,
      machine_fp: license.machineFingerprint(),
      payload,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Snapshot upload failed (${res.status})`);

  lastResult = { at: Date.now(), bytes: body.bytes, missing: failed };
  return lastResult;
}

/** Fire-and-forget wrapper — a failed push is logged and forgotten. */
function safePush() {
  pushOnce().catch((e) => {
    lastResult = { at: Date.now(), error: e.message };
    console.error('[snapshot] push failed:', e.message);
  });
}

function start() {
  if (timer) return;
  // First push is delayed: at boot the server is still warming caches and
  // running migrations, and a snapshot is never urgent.
  const first = setTimeout(safePush, 60_000);
  if (first.unref) first.unref();
  timer = setInterval(safePush, PUSH_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function getLast() { return lastResult; }

module.exports = { start, stop, pushOnce, getLast };
