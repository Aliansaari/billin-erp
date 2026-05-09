/**
 * License verification + activation for Billing ERP.
 * ────────────────────────────────────────────────────
 *
 * Every authenticated request runs through licenseGate which calls
 * `getStatus()` here. Status reflects what we know about the on-disk
 * license file:
 *
 *   { ok: true,  customer_id, expires_at, ... }       ← valid
 *   { ok: false, code: 'no_license' }                 ← never activated
 *   { ok: false, code: 'invalid_signature' }          ← tampered file
 *   { ok: false, code: 'expired',  expires_at }       ← past expiry (FULL BLOCK)
 *   { ok: false, code: 'machine_mismatch' }           ← copied to a new PC
 *   { ok: false, code: 'clock_tampered' }             ← system clock rolled back
 *
 * The full-block policy (per Sabina's Phase-2 requirement):
 *   - Any non-`ok` status blocks every API route except /api/license/*,
 *     /api/health, and /api/server-info.
 *   - The frontend redirects to a license screen and refuses to render
 *     any feature.
 *
 * Anti-tamper guards:
 *   1. Signature verified with the embedded public key on every check.
 *   2. Machine fingerprint pinned at activation; mismatched on re-launch.
 *   3. Clock-rollback detected via a monotonic "last seen" timestamp
 *      written to the license sidecar after every successful check.
 *
 * Status is cached for a few minutes — verification is cheap (1 ms) but
 * disk reads are not, and we don't want every API call hitting the file
 * system. The cache invalidates on activation/deactivation or after
 * RECHECK_INTERVAL_SECONDS.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const { LICENSE_PUBLIC_KEY, resolveLicensePath, RECHECK_INTERVAL_SECONDS } = require('../config/license');

// ── State (in-process cache) ─────────────────────────────────────────
let _cache = null;
let _cacheExpiresAt = 0;
let _machineFingerprintCache = null;

// ── Helpers ─────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compute a stable per-machine fingerprint. We hash:
 *   - hostname           (rarely changes, identifies the box)
 *   - platform + arch    (sanity / cross-OS guard)
 *   - first non-loopback MAC address
 *
 * This is deliberately NOT a hardware-locked HWID — we don't read
 * motherboard serials or BIOS UUIDs. Those require admin / specific
 * native modules. For a small-shop ERP, host+MAC is plenty of
 * "different machine" signal: a copy-pasted install on another PC
 * gets a different MAC and trips the mismatch.
 *
 * If the user re-installs Windows on the SAME hardware, the MAC stays
 * but hostname might change → fingerprint differs → license fails →
 * customer calls vendor → vendor issues new license. That's the
 * intended flow.
 */
function machineFingerprint() {
  if (_machineFingerprintCache) return _machineFingerprintCache;
  const os = require('os');
  const ifaces = os.networkInterfaces();
  let firstMac = '';
  outer: for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.mac && i.mac !== '00:00:00:00:00:00' && !i.internal) {
        firstMac = i.mac;
        break outer;
      }
    }
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    hostname: os.hostname(),
    platform: os.platform(),
    arch:     os.arch(),
    mac:      firstMac,
  })).digest('hex');
  _machineFingerprintCache = hash.slice(0, 32); // 16 bytes = enough
  return _machineFingerprintCache;
}

/**
 * Read the on-disk license file and parse the envelope. Returns
 * { ok: true, envelope, payload, sidecar } on success, or
 * { ok: false, code } on any failure (missing, malformed, etc.).
 *
 * The "sidecar" tracks the last-seen timestamp for clock-tamper
 * detection. It lives next to the license file as `.lastseen`.
 */
function readLicenseFromDisk() {
  const file = resolveLicensePath();
  if (!fs.existsSync(file)) return { ok: false, code: 'no_license' };

  let raw, env, payload;
  try {
    raw = fs.readFileSync(file, 'utf8');
    env = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: 'invalid_format', detail: e.message };
  }
  if (!env || env.kind !== 'license-studio.license' || env.v !== 1) {
    return { ok: false, code: 'invalid_format' };
  }
  try {
    payload = JSON.parse(env.payload);
  } catch (e) {
    return { ok: false, code: 'invalid_format', detail: 'payload not JSON' };
  }

  // Read sidecar (best-effort)
  let lastSeen = null;
  const sidecarPath = file + '.lastseen';
  try {
    if (fs.existsSync(sidecarPath)) {
      lastSeen = fs.readFileSync(sidecarPath, 'utf8').trim();
    }
  } catch {}

  return { ok: true, file, sidecarPath, raw, envelope: env, payload, lastSeen };
}

/**
 * Verify the Ed25519 signature on the envelope's payload string.
 * The payload was signed verbatim — see License Studio's
 * crypto.buildLicensePayload (canonical sorted JSON).
 */
function verifySignature(envelope) {
  if (LICENSE_PUBLIC_KEY === 'REPLACE_ME_WITH_LICENSE_STUDIO_PUBLIC_KEY') {
    // Defence-in-depth: refuse to run a "valid" check while the
    // placeholder is still in source. Otherwise any malformed key would
    // accidentally pass.
    return { ok: false, code: 'public_key_not_configured' };
  }
  try {
    const pub = Buffer.from(LICENSE_PUBLIC_KEY, 'base64');
    const sig = Buffer.from(envelope.signature, 'base64');
    const msg = Buffer.from(envelope.payload, 'utf8');
    const ok = nacl.sign.detached.verify(
      new Uint8Array(msg),
      new Uint8Array(sig),
      new Uint8Array(pub),
    );
    return ok ? { ok: true } : { ok: false, code: 'invalid_signature' };
  } catch (e) {
    return { ok: false, code: 'invalid_signature', detail: e.message };
  }
}

/**
 * Full status computation. Used by the gate and the /api/license/info
 * route. Caches its result for RECHECK_INTERVAL_SECONDS so the gate
 * doesn't hammer the disk on every request.
 */
function getStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now < _cacheExpiresAt) return _cache;

  const result = computeStatusUncached();
  _cache = result;
  _cacheExpiresAt = now + RECHECK_INTERVAL_SECONDS * 1000;
  return result;
}

function invalidateCache() {
  _cache = null;
  _cacheExpiresAt = 0;
}

function computeStatusUncached() {
  const read = readLicenseFromDisk();
  if (!read.ok) return read;

  const sig = verifySignature(read.envelope);
  if (!sig.ok) return sig;

  const today = todayISO();
  const { payload, sidecarPath, lastSeen } = read;

  // Clock-tamper detection: current time must NOT precede the last
  // recorded check. If it does, someone rolled the clock back to bypass
  // the expiry check.
  const nowIso = new Date().toISOString();
  if (lastSeen && nowIso < lastSeen) {
    return {
      ok: false, code: 'clock_tampered',
      lastSeen, now: nowIso,
    };
  }

  // Machine fingerprint check (only if the license has a fingerprint
  // pinned; floating licenses without one bind on first activation).
  if (payload.machine_fp) {
    const fp = machineFingerprint();
    if (payload.machine_fp !== fp) {
      return {
        ok: false, code: 'machine_mismatch',
        expected: payload.machine_fp, actual: fp,
      };
    }
  }

  // Expiry check (FULL BLOCK — no grace, per requirement)
  if (payload.expires_at && today > payload.expires_at) {
    return {
      ok: false, code: 'expired',
      customer_id: payload.customer_id,
      customer_name: payload.customer_name,
      expires_at: payload.expires_at,
    };
  }

  // ✓ Valid. Stamp the last-seen timestamp for the next clock-tamper
  // check, ignoring write errors (read-only filesystems happen).
  try { fs.writeFileSync(sidecarPath, nowIso, 'utf8'); } catch {}

  return {
    ok: true,
    customer_id:    payload.customer_id,
    customer_name:  payload.customer_name,
    license_type:   payload.license_type,
    issued_at:      payload.issued_at,
    expires_at:     payload.expires_at,
    max_companies:  payload.max_companies,
    features:       payload.features || [],
    machine_fp:     payload.machine_fp,
    machine_match:  !payload.machine_fp || payload.machine_fp === machineFingerprint(),
  };
}

/**
 * Activate a license file. Called by POST /api/license/activate.
 *
 * Steps:
 *   1. Validate envelope shape + signature
 *   2. Validate not-already-expired
 *   3. If license has no machine_fp pinned, bind it to this machine
 *   4. Write to disk at the resolved license path
 *   5. Invalidate the cache so the next status read picks it up
 *
 * Returns { ok: true, info: <getStatus> } on success.
 */
function activateFromEnvelope(envelopeText) {
  let envelope, payload;
  try {
    envelope = JSON.parse(envelopeText);
    if (envelope.kind !== 'license-studio.license' || envelope.v !== 1) {
      return { ok: false, code: 'invalid_format', message: 'Not a License Studio license file' };
    }
    payload = JSON.parse(envelope.payload);
  } catch (e) {
    return { ok: false, code: 'invalid_format', message: 'License file is not valid JSON' };
  }

  const sig = verifySignature(envelope);
  if (!sig.ok) {
    return { ok: false, code: sig.code, message: 'License signature does not match.' };
  }

  const today = todayISO();
  if (payload.expires_at && today > payload.expires_at) {
    return {
      ok: false, code: 'expired',
      message: `This license already expired on ${payload.expires_at}. Ask for a fresh one.`,
    };
  }

  // Machine binding. If the issuer left machine_fp null (a "floating"
  // license), we bind it to THIS machine on first activation. If it's
  // already pinned to a fingerprint and we're not that machine, refuse.
  const fp = machineFingerprint();
  if (payload.machine_fp && payload.machine_fp !== fp) {
    return {
      ok: false, code: 'machine_mismatch',
      message: 'This license is bound to a different machine. Contact your vendor for a new one.',
    };
  }

  // Persist exactly what we received (signed envelope is the source of
  // truth). Machine-binding is layered on via a sidecar so we don't
  // mutate the signed body.
  const file = resolveLicensePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, envelopeText, 'utf8');
    if (!payload.machine_fp) {
      // Floating license — pin to this machine via a binding sidecar.
      // The status check reads the binding alongside the payload.
      fs.writeFileSync(file + '.bind', JSON.stringify({ machine_fp: fp, bound_at: new Date().toISOString() }, null, 2), 'utf8');
    }
    fs.writeFileSync(file + '.lastseen', new Date().toISOString(), 'utf8');
  } catch (e) {
    return { ok: false, code: 'write_failed', message: e.message };
  }

  invalidateCache();
  return { ok: true, info: getStatus({ force: true }) };
}

/**
 * Remove the license. For developer / vendor use during testing —
 * NOT exposed to customers. The route requires the developer-mode
 * password.
 */
function deactivate() {
  const file = resolveLicensePath();
  for (const p of [file, file + '.lastseen', file + '.bind']) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
  invalidateCache();
  return { ok: true };
}

/**
 * Status check that ALSO honours the optional .bind sidecar. Used by
 * the gate; getStatus() reads the binding to enforce machine match
 * even when the signed payload had a null fingerprint.
 */
function getEffectiveStatus({ force = false } = {}) {
  const base = getStatus({ force });
  if (!base.ok) return base;

  const file = resolveLicensePath();
  const bindPath = file + '.bind';
  if (!fs.existsSync(bindPath)) return base;

  try {
    const bind = JSON.parse(fs.readFileSync(bindPath, 'utf8'));
    if (bind.machine_fp && bind.machine_fp !== machineFingerprint()) {
      return {
        ok: false, code: 'machine_mismatch',
        expected: bind.machine_fp, actual: machineFingerprint(),
      };
    }
  } catch {
    // Binding sidecar is corrupted — refuse rather than bypass.
    return { ok: false, code: 'machine_mismatch', detail: 'binding sidecar corrupted' };
  }
  return base;
}

module.exports = {
  getStatus: getEffectiveStatus,
  invalidateCache,
  activateFromEnvelope,
  deactivate,
  machineFingerprint,
  // Exported for tests
  _verifySignature: verifySignature,
};
