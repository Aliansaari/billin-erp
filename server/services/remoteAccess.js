/**
 * Remote Access — expose this install to its own phones via Cloudflare Tunnel
 * ──────────────────────────────────────────────────────────────────────────
 *
 * A shop's mobile app can only reach the LAN IP of the billing PC, which means
 * it stops working the moment the phone leaves the shop's Wi-Fi. This service
 * runs `cloudflared` as a child process, giving the install a stable HTTPS
 * hostname (`s-<id>.zehenapp.com`) that reaches THIS machine from anywhere —
 * outbound-only, so there is no port forwarding and no static IP.
 *
 * ══ THE RULE THAT OUTRANKS EVERYTHING HERE ══
 *
 * ZEHEN's core promise is that a shop can bill all day with the internet
 * unplugged. Nothing in this file may weaken that. Concretely:
 *
 *   - It is never on the request path of a bill.
 *   - It is started fire-and-forget AFTER the server is already listening.
 *   - Every failure is caught, recorded in `state.lastError`, and dropped.
 *     A shop with no internet sees "offline" in Settings and nothing else
 *     changes: no boot delay, no error toast, no blocked route.
 *   - The licence check stays entirely offline. The control plane is asked
 *     only to mint a tunnel — a thing that needs internet by definition.
 *
 * If you are editing this file, the airplane-mode test is the gate: turn the
 * Wi-Fi off, then boot, log in, create a sale, print it, and reopen the app.
 * Any regression there fails the build regardless of what else works.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const nacl    = require('tweetnacl');
const license = require('./license');
const { resolveLicensePath } = require('../config/license');

const CONFIG_DIR  = path.join(os.homedir(), '.zehen');
const CONFIG_FILE = path.join(CONFIG_DIR, 'remote-access.json');

const CONTROL_PLANE_URL = (
  process.env.ZEHEN_CONTROL_PLANE_URL
  || 'https://zehen-control-plane.aliansari7131.workers.dev'
).replace(/\/+$/, '');

// Restart backoff for the cloudflared child. Starts at 5s and doubles to a
// 5-minute ceiling: a shop whose broadband is down should retry politely
// forever, not hammer the connection or spin the CPU.
const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 5 * 60_000;

// How often to refresh the device allow-list from the control plane. Five
// minutes is the worst-case delay between an owner revoking a lost phone and
// that phone losing access — short enough to matter, long enough to be free.
const DEVICE_SYNC_MS = 5 * 60_000;

const state = {
  status: 'off',        // off | starting | connected | error | disabled
  hostname: null,
  siteId: null,
  lastError: null,
  lastConnectedAt: null,
  proc: null,
  restartDelay: RESTART_MIN_MS,
  restartTimer: null,
  stopping: false,

  // Allow-list of SHA-256(device token) permitted to reach us through the
  // tunnel. Empty means "reject every remote request" — the correct default,
  // since a desktop that has never successfully synced has no way to tell a
  // paired phone from an attacker who guessed the hostname.
  deviceHashes: new Set(),
  devicesSyncedAt: null,
  // Ed25519 public key the control plane signs login assertions with.
  ssoPublicKey: null,
  deviceSyncTimer: null,
};

// ── config persistence ───────────────────────────────────────────────

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};   // absent or unreadable — treat as "never set up"
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // 0600: the tunnel token is a bearer credential for this site.
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (e) {
    state.lastError = `Could not save remote-access config: ${e.message}`;
  }
  return next;
}

// ── cloudflared binary ───────────────────────────────────────────────

/**
 * Locate the cloudflared binary. Packaged builds ship it as an
 * electron-builder extraResource; development falls back to whatever is on
 * PATH. Returns null when it cannot be found, which surfaces as a clear
 * status message rather than a crash.
 */
function resolveCloudflaredPath() {
  if (process.env.ZEHEN_CLOUDFLARED_PATH) return process.env.ZEHEN_CLOUDFLARED_PATH;

  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'cloudflared', exe));
    candidates.push(path.join(process.resourcesPath, exe));
  }
  candidates.push(
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  );
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

// ── control plane ────────────────────────────────────────────────────

/**
 * Ask the control plane for this machine's tunnel. Idempotent: the same PC
 * gets the same site back rather than a second tunnel, so this is safe to
 * call on every enable.
 */
async function provision(siteName) {
  const licensePath = resolveLicensePath();
  let licenseText;
  try {
    licenseText = fs.readFileSync(licensePath, 'utf8').trim();
  } catch {
    throw new Error('No licence file found on this installation.');
  }

  const res = await fetch(`${CONTROL_PLANE_URL}/v1/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      license: licenseText,
      machine_fp: license.machineFingerprint(),
      site_name: siteName || os.hostname(),
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Provisioning failed (${res.status}).`);

  return writeConfig({
    site_id:        body.site_id,
    hostname:       body.hostname,
    status:         body.status || null,
    tunnel_token:   body.tunnel_token || readConfig().tunnel_token,
    provisioned_at: Date.now(),
  });
}

/**
 * Pull the org's live device-token hashes.
 *
 * Kept deliberately quiet: a shop whose broadband is down keeps its last
 * known list rather than locking out phones that were working a minute ago.
 * Losing internet takes the tunnel down anyway, so there is nothing to guard
 * against in that window.
 */
async function refreshDeviceAllowList() {
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.site_id) return;

  let licenseText;
  try {
    licenseText = fs.readFileSync(resolveLicensePath(), 'utf8').trim();
  } catch { return; }

  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/v1/site/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ license: licenseText, machine_fp: license.machineFingerprint() }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return;
    const body = await res.json();
    if (!Array.isArray(body.device_hashes)) return;

    // A successful sync is authoritative, INCLUDING an empty list — that is
    // how a suspended account or a revoked mobile entitlement reaches us.
    state.deviceHashes = new Set(body.device_hashes);
    state.devicesSyncedAt = Date.now();
    if (body.sso_public_key) state.ssoPublicKey = body.sso_public_key;
    // Persist so a restart does not lock out already-paired phones. Without
    // this, a PC rebooting while the broadband is still coming up would come
    // back with an empty allow-list and reject every phone until the next
    // sync — up to five minutes of "not paired" errors for a shop that did
    // nothing wrong. Hashes only; these cannot be turned back into tokens.
    writeConfig({
      device_hashes: body.device_hashes,
      devices_synced_at: state.devicesSyncedAt,
      sso_public_key: body.sso_public_key || null,
    });
  } catch {
    // Offline or control plane down — keep the previous list.
  }
}

function startDeviceSync() {
  if (state.deviceSyncTimer) return;

  // Seed from the last good sync so paired phones keep working from the
  // first request after a restart, rather than waiting for the network.
  const cfg = readConfig();
  if (Array.isArray(cfg.device_hashes) && state.deviceHashes.size === 0) {
    state.deviceHashes = new Set(cfg.device_hashes);
    state.devicesSyncedAt = cfg.devices_synced_at || null;
  }
  // Cached so a phone can still sign in during the window after a restart
  // when the control plane has not been reached yet.
  if (!state.ssoPublicKey && cfg.sso_public_key) state.ssoPublicKey = cfg.sso_public_key;

  refreshDeviceAllowList();
  state.deviceSyncTimer = setInterval(refreshDeviceAllowList, DEVICE_SYNC_MS);
  if (state.deviceSyncTimer.unref) state.deviceSyncTimer.unref();
}

/**
 * Re-check the allow-list on a short ramp.
 *
 * Called right after the owner displays a pairing QR. The phone will claim
 * that code within seconds, but the regular sync runs every five minutes —
 * so without this the user pairs a phone, watches it get rejected, and
 * reasonably concludes the feature is broken. The ramp costs four tiny
 * requests and closes the window to a couple of seconds.
 */
function nudgeDeviceSync() {
  [2_000, 6_000, 15_000, 40_000].forEach((delay) => {
    const t = setTimeout(() => { refreshDeviceAllowList().catch(() => {}); }, delay);
    if (t.unref) t.unref();
  });
}

function stopDeviceSync() {
  if (state.deviceSyncTimer) { clearInterval(state.deviceSyncTimer); state.deviceSyncTimer = null; }
  state.deviceHashes = new Set();
  state.devicesSyncedAt = null;
  // Drop the cached list too: remote access is off, so nothing should be
  // able to walk back in from a stale file.
  writeConfig({ device_hashes: [], devices_synced_at: null });
}

/**
 * Verify a login assertion issued by the control plane.
 *
 * This is what lets someone sign in with one email/phone + password from
 * anywhere, with no QR code and no typed IP address. The control plane
 * checked the password; this proves it did, cryptographically, so the shop
 * server can mint its own session without ever seeing that password.
 *
 * Returns the claims, or null. Every failure returns null — a caller must not
 * be able to tell a bad signature from an expired one.
 */
function verifyAssertion(assertion) {
  try {
    if (!state.ssoPublicKey) return null;
    const [payloadB64, sigB64] = String(assertion || '').split('.');
    if (!payloadB64 || !sigB64) return null;

    const payloadText = Buffer.from(payloadB64, 'base64').toString('utf8');
    const ok = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(payloadText, 'utf8')),
      new Uint8Array(Buffer.from(sigB64, 'base64')),
      new Uint8Array(Buffer.from(state.ssoPublicKey, 'base64')),
    );
    if (!ok) return null;

    const claims = JSON.parse(payloadText);
    // Short-lived by design; also reject anything issued in the future, which
    // would mean a clock problem or a replay attempt.
    const now = Date.now();
    if (!claims.exp || claims.exp < now) return null;
    if (claims.iat && claims.iat > now + 120_000) return null;
    if (!claims.sub) return null;

    // Must be addressed to THIS site, so an assertion for one branch cannot
    // be replayed against another.
    const cfg = readConfig();
    if (cfg.site_id && claims.site_id && claims.site_id !== cfg.site_id) return null;

    return claims;
  } catch { return null; }
}

/**
 * Is this device token allowed to reach us through the tunnel?
 * Constant-time comparison is unnecessary — we hash first and look the digest
 * up in a Set, so no comparison leaks timing about the token itself.
 */
function isDeviceAllowed(token) {
  if (!token) return false;
  const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
  return state.deviceHashes.has(hash);
}

// ── cloudflared supervision ──────────────────────────────────────────

function scheduleRestart() {
  if (state.stopping || state.restartTimer) return;
  const delay = state.restartDelay;
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    state.restartDelay = Math.min(state.restartDelay * 2, RESTART_MAX_MS);
    startTunnel();
  }, delay);
  // Never hold the process open for a retry timer.
  if (state.restartTimer.unref) state.restartTimer.unref();
}

function startTunnel() {
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.tunnel_token) return;

  const bin = resolveCloudflaredPath();
  if (!bin) {
    state.status = 'error';
    state.lastError = 'cloudflared is not installed with this build.';
    return;
  }

  if (state.proc) return;   // already running

  state.status   = 'starting';
  state.hostname = cfg.hostname || null;
  state.siteId   = cfg.site_id || null;
  state.stopping = false;

  let proc;
  try {
    proc = spawn(bin, [
      'tunnel', '--no-autoupdate',
      // cloudflared's own retry is fine, but we supervise restarts ourselves
      // so a token that has been revoked doesn't spin silently forever.
      'run', '--token', cfg.tunnel_token,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    state.status = 'error';
    state.lastError = `Could not start cloudflared: ${e.message}`;
    scheduleRestart();
    return;
  }

  state.proc = proc;

  const onOutput = (buf) => {
    const text = buf.toString();
    if (text.includes('Registered tunnel connection')) {
      state.status = 'connected';
      state.lastError = null;
      state.lastConnectedAt = Date.now();
      state.restartDelay = RESTART_MIN_MS;   // healthy again — reset backoff
    }
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);   // cloudflared logs to stderr by default

  proc.on('error', (e) => {
    state.status = 'error';
    state.lastError = e.message;
  });

  proc.on('exit', (code) => {
    state.proc = null;
    if (state.stopping) { state.status = 'off'; return; }
    state.status = 'error';
    state.lastError = `cloudflared exited (code ${code}). Retrying.`;
    scheduleRestart();
  });
}

function stopTunnel() {
  state.stopping = true;
  if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
  if (state.proc) {
    try { state.proc.kill(); } catch { /* already gone */ }
    state.proc = null;
  }
  state.status = 'off';
  state.restartDelay = RESTART_MIN_MS;
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Called once from server boot, AFTER the HTTP listener is up. Deliberately
 * returns nothing and throws nothing: a shop with no internet must not be
 * delayed or degraded by this.
 */
function boot() {
  try {
    const cfg = readConfig();
    if (cfg.enabled) {
      startTunnel();
      startDeviceSync();

      // Re-run provisioning if this site never reached 'ready'.
      //
      // A brand-new site sits in 'provisioning' until its DNS is verifiably
      // live, which usually takes longer than the request that created it.
      // Nothing else promotes it, and until it is 'ready' the control plane
      // will not hand its address to a phone — so the shop would look
      // permanently unavailable in the app despite a perfectly healthy
      // tunnel. Provisioning is idempotent and repairs the status.
      if (cfg.site_id && cfg.status !== 'ready') {
        setTimeout(() => {
          provision().then((c) => {
            if (c?.status) writeConfig({ status: c.status });
          }).catch(() => { /* offline — try again next boot */ });
        }, 15_000).unref?.();
      }
    }
  } catch (e) {
    state.status = 'error';
    state.lastError = e?.message || String(e);
  }
}

async function enable(siteName) {
  const cfg = await provision(siteName);
  writeConfig({ enabled: true });
  state.restartDelay = RESTART_MIN_MS;
  startTunnel();
  startDeviceSync();
  return { hostname: cfg.hostname, site_id: cfg.site_id };
}

function disable() {
  writeConfig({ enabled: false });
  stopTunnel();
  stopDeviceSync();
  return { ok: true };
}

function getStatus() {
  const cfg = readConfig();
  return {
    enabled:  !!cfg.enabled,
    status:   cfg.enabled ? state.status : 'off',
    hostname: cfg.hostname || null,
    site_id:  cfg.site_id || null,
    url:      cfg.hostname ? `https://${cfg.hostname}` : null,
    last_error: state.lastError,
    last_connected_at: state.lastConnectedAt,
    cloudflared_available: !!resolveCloudflaredPath(),
    control_plane: CONTROL_PLANE_URL,
    paired_devices: state.deviceHashes.size,
    devices_synced_at: state.devicesSyncedAt,
  };
}

module.exports = {
  boot, enable, disable, getStatus, provision,
  isDeviceAllowed, refreshDeviceAllowList, nudgeDeviceSync, verifyAssertion,
  CONTROL_PLANE_URL,
};
