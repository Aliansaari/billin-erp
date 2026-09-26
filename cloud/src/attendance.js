/**
 * Staff attendance — control-plane side
 * ─────────────────────────────────────
 *
 * Staff punch IN/OUT from their own phone's browser at staff.zehenapp.com.
 * The shop PC does not need to be on: the punch lands here, stamped with
 * this service's clock, and the desktop collects it whenever it next runs.
 *
 * ══ What makes a punch trustworthy ══
 *
 * Only three things are PROOF, because this service establishes each one
 * itself and the phone cannot influence them:
 *
 *   1. Passkey signature — made inside the phone's secure hardware after a
 *      fingerprint / Face ID check, over a single-use challenge issued here.
 *   2. Network address — read from the connection (cf-connecting-ip), then
 *      compared with the address the licence-authenticated shop PC reports
 *      from. Being on the shop Wi-Fi is the "you are at the door" signal.
 *   3. Time — this service's clock. The phone's clock is never read.
 *
 * GPS and the selfie are sent BY the phone, so they are stored as evidence
 * for the owner and never used to accept or reject anything on their own.
 *
 * ══ Who owns what ══
 *
 * The desktop owns the staff list, PINs (as hashes), settings and every
 * judgement about attendance (late, absent, corrections). This file only
 * gates the phone and records raw punches. Staff-facing summaries are
 * computed on the desktop and pushed back (`att_views`), so the phone and the
 * owner's register can never disagree.
 */

import { verifyRegistration, verifyAssertion, b64urlToBytes, bytesToB64url } from './webauthn.js';
import STAFF_PAGE from './staffPage.html';

const SESSION_TTL_MS    = 180 * 24 * 60 * 60_000;   // staff stay signed in ~6 months
const CHALLENGE_TTL_MS  = 3 * 60_000;
const MATCH_WINDOW_MS   = 18 * 60 * 60_000;          // how long a shop address stays "the shop"
const LIVE_WINDOW_MS    = 15 * 60_000;               // shop PC counts as online if seen this recently
const RETRO_WINDOW_MS   = 18 * 60 * 60_000;          // how far back a late shop report can verify punches
const PUNCH_COOLDOWN_MS = 60_000;
const PUNCH_RETENTION_MS = 90 * 24 * 60 * 60_000;
const SELFIE_MAX_CHARS  = 280_000;                   // ≈ 200 KB of JPEG as base64
const VIEW_MAX_CHARS    = 40_000;
const PULL_LIMIT        = 200;
const SELFIE_PULL_LIMIT = 40;

// Shown on the camera screen and stored with the punch. A static photo
// cannot follow a prompt it has never seen, and the owner can see at a
// glance whether the picture matches the instruction.
const LIVENESS_PROMPTS = [
  'Show 1 finger', 'Show 2 fingers', 'Show 3 fingers', 'Show 4 fingers',
  'Show an open palm', 'Give a thumbs up', 'Touch your ear', 'Touch your nose',
];

const DEFAULT_SETTINGS = {
  wifi_mode: 'require',        // off | flag | require
  passkey: 'required',         // optional | required
  selfie: 'in',                // off | in | both
  geo: { enabled: false, lat: null, lng: null, radius_m: 150 },
  open_time: '10:00',
  close_time: '21:00',
  grace_min: 15,
  tz_offset_min: 330,          // IST
  show_salary: false,
};

// ── small helpers ───────────────────────────────────────────────────

function settingsOf(shop) {
  let s = {};
  try { s = JSON.parse(shop?.settings || '{}'); } catch { /* fall back to defaults */ }
  return { ...DEFAULT_SETTINGS, ...s, geo: { ...DEFAULT_SETTINGS.geo, ...(s.geo || {}) } };
}

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.length === 10) digits = '91' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function cleanDeviceId(raw) {
  const id = String(raw || '');
  return /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
}

/** Start of the shop's local day containing `now`, in epoch ms. */
function dayStart(now, tzOffsetMin) {
  const off = (Number(tzOffsetMin) || 0) * 60_000;
  return Math.floor((now + off) / 86_400_000) * 86_400_000 - off;
}

function randomCode(len, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/**
 * The part of an address that identifies ONE shop connection.
 *
 * IPv4 is kept whole. IPv6 is cut to its /64 prefix: every device behind a
 * home or shop router shares that prefix, while each device's own suffix
 * differs and rotates for privacy — so comparing whole v6 addresses would
 * make the owner's PC and a staff phone on the same Wi-Fi look unrelated.
 */
export function ipKey(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return null;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return { key: `v4:${mapped[1]}`, family: 4 };
  if (!raw.includes(':')) return { key: `v4:${raw}`, family: 4 };

  const [head, tail = ''] = raw.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = raw.includes('::')
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    : h;
  const prefix = groups.slice(0, 4).map((g) => (parseInt(g || '0', 16) || 0).toString(16)).join(':');
  return { key: `v6:${prefix}`, family: 6 };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function rpConfig(env) {
  const rpId = env.STAFF_RP_ID || 'zehenapp.com';
  const origins = String(env.STAFF_ORIGINS || 'https://staff.zehenapp.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { rpId, origins };
}

// ── the shop's own network ──────────────────────────────────────────

/**
 * Remember the address a licence-authenticated request came from, then
 * confirm any of today's punches that were waiting for exactly this address.
 *
 * This is the only way an address becomes "the shop": staff requests never
 * write here, so a punch can never vouch for itself.
 */
async function recordSiteIp(env, siteId, request) {
  const k = ipKey(request.headers.get('cf-connecting-ip'));
  if (!k) return null;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO att_site_ips (site_id, ip_key, family, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(site_id, ip_key) DO UPDATE SET last_seen = excluded.last_seen`,
    ).bind(siteId, k.key, k.family, now, now),
    // Re-deliver (collected_at = NULL) so the desktop sees the upgrade.
    env.DB.prepare(
      `UPDATE att_punches SET net_status = 'match', collected_at = NULL
        WHERE net_status = 'pending' AND ip_key = ? AND at >= ?
          AND shop_code IN (SELECT shop_code FROM att_shops WHERE site_id = ?)`,
    ).bind(k.key, now - RETRO_WINDOW_MS, siteId),
  ]);
  return k;
}

/**
 * How this punch's network compares with the shop's.
 *
 *   match    — same connection the shop PC reports from
 *   mismatch — the shop PC is online RIGHT NOW on a different connection of
 *              the same address family, so this phone is elsewhere
 *   pending  — the shop PC has not reported recently (it is probably still
 *              switched off); decided later by recordSiteIp()
 *
 * Families are compared separately because a phone may reach us over IPv6
 * while the PC uses IPv4 on the very same router. Only a same-family
 * difference is evidence of being somewhere else.
 */
async function netStatusFor(env, siteId, k, settings, now) {
  if (settings.wifi_mode === 'off') return 'off';
  if (!k) return 'pending';
  const { results } = await env.DB.prepare(
    'SELECT ip_key, family, last_seen FROM att_site_ips WHERE site_id = ? AND last_seen >= ?',
  ).bind(siteId, now - MATCH_WINDOW_MS).all();
  const rows = results || [];
  if (rows.some((r) => r.ip_key === k.key)) return 'match';
  if (rows.some((r) => r.family === k.family && r.last_seen >= now - LIVE_WINDOW_MS)) return 'mismatch';
  return 'pending';
}

// ── auth ────────────────────────────────────────────────────────────

async function siteFromDesktop(env, body, deps) {
  const payload = await deps.verifyLicense(body.license, env.LICENSE_PUBLIC_KEY);
  if (!payload) return { error: deps.fail('invalid_license', 'Licence signature did not verify.', 403) };
  const customerId = String(payload.customer_id ?? payload.customer_name ?? '').trim();
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE customer_id = ?').bind(customerId).first();
  if (!org) return { error: deps.fail('unknown_org', 'This licence has no account yet.', 404) };
  if (org.suspended) return { error: deps.fail('org_suspended', 'This account is suspended.', 403) };
  const site = await env.DB.prepare('SELECT * FROM sites WHERE org_id = ? AND machine_fp = ?')
    .bind(org.org_id, String(body.machine_fp || '')).first();
  if (!site) return { error: deps.fail('unknown_site', 'This machine is not provisioned.', 404) };
  return { org, site };
}

/** Staff bearer token → { staff, shop, session }, or null. */
async function staffFromRequest(env, request, deps) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const hash = await deps.sha256Hex(auth.slice(7));
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.device_id AS session_device, s.expires_at,
            st.*, sh.site_id, sh.company_name, sh.settings, sh.enabled AS shop_enabled
       FROM att_sessions s
       JOIN att_staff st ON st.staff_uid = s.staff_uid
       JOIN att_shops sh ON sh.shop_code = st.shop_code
      WHERE s.token_hash = ?`,
  ).bind(hash).first();
  if (!row) return null;
  // A session dies with its binding: when the owner resets the phone, the
  // staff row's device_id changes and every older session stops working.
  if (row.expires_at < Date.now() || !row.enabled || !row.shop_enabled
      || row.device_id !== row.session_device) {
    return null;
  }
  return row;
}

// ── staff: login ────────────────────────────────────────────────────

/**
 * POST /v1/staff/login  { shop_code, phone, pin, device_id }
 *
 * The PIN is only a front door. The first successful login binds the
 * account to this phone; after that the same PIN on any other phone is
 * refused until the owner presses "Reset phone" in ZEHEN. So a leaked or
 * shared PIN cannot be used to punch for someone from elsewhere.
 */
async function handleStaffLogin(env, body, deps) {
  const DENY = () => deps.fail('bad_credentials', 'Wrong shop code, mobile number or PIN.', 401);
  const shopCode = String(body.shop_code || '').trim().toUpperCase();
  const phone = normalizePhone(body.phone);
  const pin = String(body.pin || '');
  const deviceId = cleanDeviceId(body.device_id);
  if (!shopCode || !phone || !pin) return DENY();
  if (!deviceId) return deps.fail('bad_device', 'This browser could not be identified. Reload and try again.');

  const staff = await env.DB.prepare(
    `SELECT st.*, sh.enabled AS shop_enabled, sh.company_name, sh.settings
       FROM att_staff st JOIN att_shops sh ON sh.shop_code = st.shop_code
      WHERE st.shop_code = ? AND st.phone = ?`,
  ).bind(shopCode, phone).first();
  if (!staff || !staff.enabled || !staff.pin_hash || !staff.shop_enabled) return DENY();

  const now = Date.now();
  if (staff.locked_until && staff.locked_until > now) {
    return deps.fail('locked', 'Too many attempts. Try again in 15 minutes.', 429);
  }
  if (!(await deps.verifyPassword(pin, staff.pin_hash))) {
    const failed = (staff.failed_count || 0) + 1;
    await env.DB.prepare('UPDATE att_staff SET failed_count = ?, locked_until = ? WHERE staff_uid = ?')
      .bind(failed, failed >= 5 ? now + 15 * 60_000 : null, staff.staff_uid).run();
    return DENY();
  }

  if (staff.device_id && staff.device_id !== deviceId) {
    return deps.fail(
      'other_device',
      'Your account is linked to another phone. Ask the owner to press "Reset phone" for you in ZEHEN.',
      403,
    );
  }

  const token = await openSession(env, staff.staff_uid, deviceId, deps);
  return deps.json({ token, name: staff.name, company_name: staff.company_name });
}

/**
 * Bind the account to `deviceId` and start a session there. Any session on a
 * previously bound device stops working at once (staffFromRequest compares
 * the session's device with the account's).
 */
async function openSession(env, staffUid, deviceId, deps) {
  const now = Date.now();
  const token = deps.randHex(32);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE att_staff SET failed_count = 0, locked_until = NULL, last_login = ?,
              device_id = ?, device_bound_at = CASE WHEN device_id = ? THEN COALESCE(device_bound_at, ?) ELSE ? END
        WHERE staff_uid = ?`,
    ).bind(now, deviceId, deviceId, now, now, staffUid),
    env.DB.prepare(
      'INSERT INTO att_sessions (token_hash, staff_uid, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(await deps.sha256Hex(token), staffUid, deviceId, now, now + SESSION_TTL_MS),
  ]);
  return token;
}

/**
 * GET /v1/staff/shop?code=XXXXXX → { company_name }
 *
 * Lets the sign-in screen say "Signing in to Aafiya Dresses" instead of
 * asking staff to type a code the link already carried. Returns the shop
 * name only, and nothing for a shop that has attendance switched off.
 */
async function handleShopLookup(env, url, deps) {
  const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) return deps.fail('not_found', 'Shop not found.', 404);
  const shop = await env.DB.prepare('SELECT company_name, enabled FROM att_shops WHERE shop_code = ?').bind(code).first();
  if (!shop || !shop.enabled) return deps.fail('not_found', 'Shop not found.', 404);
  return deps.json({ shop_code: code, company_name: shop.company_name || 'Your shop' });
}

/**
 * Sign in with the phone's fingerprint / Face ID alone — no shop code,
 * mobile number or PIN.
 *
 * POST /v1/staff/login/passkey/begin   { credential_id? } → WebAuthn options
 * POST /v1/staff/login/passkey/finish  { challenge, assertion, device_id }
 *
 * The passkey IS the identity: it was enrolled after a PIN sign-in on a phone
 * the account was bound to, and only the enrolled person's biometric unlocks
 * it. So a verified passkey may also move the binding to a new browser
 * context on that person's phone — which is exactly what an iPhone needs,
 * where Safari and the home-screen app keep separate storage and so look
 * like two different devices. "Reset phone" deletes the passkey, so after a
 * reset only the PIN path (and the owner) can bind a phone again.
 */
async function handlePasskeyLoginBegin(env, body, deps) {
  const { rpId } = rpConfig(env);
  // Anyone can ask for a sign-in challenge, so expired ones are swept here
  // too rather than waiting for a desktop sync.
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM att_challenges WHERE expires_at < ?').bind(Date.now() - 3_600_000).run();
  }
  const challenge = await issueChallenge(env, '', 'login');
  const hint = typeof body.credential_id === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(body.credential_id)
    ? [{ type: 'public-key', id: body.credential_id }] : [];
  return deps.json({
    publicKey: { challenge, rpId, allowCredentials: hint, userVerification: 'required', timeout: 60_000 },
  });
}

async function handlePasskeyLoginFinish(env, body, deps) {
  const DENY = (msg = 'That fingerprint / Face ID is not set up for ZEHEN Staff on this phone. Sign in with your PIN.') =>
    deps.fail('passkey_unknown', msg, 401);
  const deviceId = cleanDeviceId(body.device_id);
  if (!deviceId) return deps.fail('bad_device', 'This browser could not be identified. Reload and try again.');
  const challengeRow = await consumeChallenge(env, body.challenge, '', 'login');
  if (!challengeRow) return deps.fail('challenge_expired', 'That took too long. Please try again.', 400);

  const stored = await env.DB.prepare('SELECT * FROM att_passkeys WHERE credential_id = ?')
    .bind(String(body.assertion?.id || '')).first();
  if (!stored) return DENY();

  const { rpId, origins } = rpConfig(env);
  let res;
  try {
    res = await verifyAssertion(body.assertion, stored, { challenge: challengeRow.challenge, rpId, origins, requireUV: true });
  } catch {
    return DENY('Fingerprint / Face ID check failed. Try again, or sign in with your PIN.');
  }

  const staff = await env.DB.prepare(
    `SELECT st.*, sh.enabled AS shop_enabled, sh.company_name
       FROM att_staff st JOIN att_shops sh ON sh.shop_code = st.shop_code
      WHERE st.staff_uid = ?`,
  ).bind(stored.staff_uid).first();
  if (!staff || !staff.enabled || !staff.shop_enabled) {
    return deps.fail('disabled', 'Your attendance account is switched off. Ask your manager.', 403);
  }

  await env.DB.prepare('UPDATE att_passkeys SET sign_count = ?, last_used = ? WHERE credential_id = ?')
    .bind(res.signCount, Date.now(), stored.credential_id).run();
  const token = await openSession(env, staff.staff_uid, deviceId, deps);
  return deps.json({ token, name: staff.name, company_name: staff.company_name, shop_code: staff.shop_code });
}

// ── staff: profile ──────────────────────────────────────────────────

async function lastPunchToday(env, staff, settings, now) {
  return env.DB.prepare(
    'SELECT kind, at FROM att_punches WHERE staff_uid = ? AND at >= ? ORDER BY at DESC LIMIT 1',
  ).bind(staff.staff_uid, dayStart(now, settings.tz_offset_min)).first();
}

async function handleStaffMe(env, staff, deps) {
  const settings = settingsOf(staff);
  const now = Date.now();
  const [pk, last, recent, view] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM att_passkeys WHERE staff_uid = ?').bind(staff.staff_uid).first(),
    lastPunchToday(env, staff, settings, now),
    env.DB.prepare(
      `SELECT kind, at, net_status, geo_status, passkey FROM att_punches
        WHERE staff_uid = ? AND at >= ? ORDER BY at DESC LIMIT 200`,
    ).bind(staff.staff_uid, now - 45 * 86_400_000).all(),
    env.DB.prepare('SELECT payload, updated_at FROM att_views WHERE staff_uid = ?').bind(staff.staff_uid).first(),
  ]);

  let viewPayload = null;
  try { viewPayload = view ? JSON.parse(view.payload) : null; } catch { /* ignore */ }

  return deps.json({
    name: staff.name,
    company_name: staff.company_name,
    shop_code: staff.shop_code,
    // Last 4 digits only: enough for "is this my account?", nothing more.
    phone_hint: staff.phone ? staff.phone.slice(-4) : null,
    has_passkey: (pk?.n || 0) > 0,
    next_kind: last?.kind === 'in' ? 'out' : 'in',
    server_time: now,
    settings: {
      passkey: settings.passkey,
      selfie: settings.selfie,
      wifi_mode: settings.wifi_mode,
      geo: !!settings.geo.enabled,
      open_time: settings.open_time,
      close_time: settings.close_time,
      tz_offset_min: settings.tz_offset_min,
    },
    punches: recent.results || [],
    view: viewPayload,
    view_updated_at: view?.updated_at || null,
  });
}

// ── staff: passkey enrolment ────────────────────────────────────────

async function issueChallenge(env, staffUid, purpose, prompt = null) {
  const challenge = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    'INSERT INTO att_challenges (challenge, staff_uid, purpose, prompt, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(challenge, staffUid, purpose, prompt, Date.now() + CHALLENGE_TTL_MS).run();
  return challenge;
}

/** Claim a challenge exactly once. Returns the row, or null. */
async function consumeChallenge(env, challenge, staffUid, purpose) {
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE att_challenges SET used_at = ?
      WHERE challenge = ? AND staff_uid = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`,
  ).bind(now, String(challenge || ''), staffUid, purpose, now).run();
  if (!res.meta?.changes) return null;
  return env.DB.prepare('SELECT * FROM att_challenges WHERE challenge = ?').bind(challenge).first();
}

async function handlePasskeyBegin(env, staff, request, deps) {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM att_passkeys WHERE staff_uid = ?')
    .bind(staff.staff_uid).first();
  if ((existing?.n || 0) > 0) {
    return deps.fail('already_enrolled', 'Fingerprint / Face ID is already set up on your phone.', 409);
  }

  // Enrolment is the moment the phone becomes "the" phone, so when the owner
  // requires the shop Wi-Fi, it must happen on the shop Wi-Fi too.
  const settings = settingsOf(staff);
  const k = ipKey(request.headers.get('cf-connecting-ip'));
  if (settings.wifi_mode === 'require'
      && (await netStatusFor(env, staff.site_id, k, settings, Date.now())) === 'mismatch') {
    return deps.fail('not_on_shop_wifi', 'Connect to the shop Wi-Fi to set this up.', 403);
  }

  const { rpId } = rpConfig(env);
  const challenge = await issueChallenge(env, staff.staff_uid, 'register');
  return deps.json({
    publicKey: {
      challenge,
      rp: { id: rpId, name: 'ZEHEN Staff' },
      user: {
        id: bytesToB64url(new TextEncoder().encode(staff.staff_uid)),
        name: staff.phone || staff.name,
        displayName: staff.name,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',   // this phone's own sensor, not a USB key
        userVerification: 'required',
        residentKey: 'preferred',
      },
      attestation: 'none',
      timeout: 120_000,
    },
  });
}

async function handlePasskeyFinish(env, staff, body, deps) {
  const challengeRow = await consumeChallenge(env, body.challenge, staff.staff_uid, 'register');
  if (!challengeRow) return deps.fail('challenge_expired', 'That took too long. Please try again.', 400);

  const { rpId, origins } = rpConfig(env);
  let reg;
  try {
    reg = await verifyRegistration(body.credential, { challenge: challengeRow.challenge, rpId, origins, requireUV: true });
  } catch (e) {
    return deps.fail('passkey_invalid', `Could not verify the phone's response (${e.message}).`, 400);
  }

  await env.DB.prepare(
    `INSERT INTO att_passkeys (credential_id, staff_uid, public_key, alg, sign_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(reg.credentialId, staff.staff_uid, JSON.stringify(reg.jwk), reg.alg, reg.signCount, Date.now()).run();
  return deps.json({ ok: true });
}

// ── staff: punch ────────────────────────────────────────────────────

function needsSelfie(settings, kind) {
  return settings.selfie === 'both' || (settings.selfie === 'in' && kind === 'in');
}

/**
 * POST /v1/staff/punch/begin
 *
 * Decides which punch comes next (IN or OUT) — the phone does not choose —
 * and issues the challenge the passkey must sign.
 */
async function handlePunchBegin(env, staff, deps) {
  const settings = settingsOf(staff);
  const now = Date.now();
  const last = await lastPunchToday(env, staff, settings, now);
  if (last && last.at > now - PUNCH_COOLDOWN_MS) {
    return deps.fail('too_soon', 'You just punched. Wait a minute before punching again.', 429);
  }
  const kind = last?.kind === 'in' ? 'out' : 'in';

  const { results: keys } = await env.DB.prepare('SELECT credential_id FROM att_passkeys WHERE staff_uid = ?')
    .bind(staff.staff_uid).all();
  if (settings.passkey === 'required' && !(keys || []).length) {
    return deps.fail('passkey_required', 'Set up fingerprint / Face ID first.', 409);
  }

  const selfie = needsSelfie(settings, kind);
  const prompt = selfie ? LIVENESS_PROMPTS[crypto.getRandomValues(new Uint8Array(1))[0] % LIVENESS_PROMPTS.length] : null;
  const { rpId } = rpConfig(env);
  const challenge = await issueChallenge(env, staff.staff_uid, kind, prompt);

  return deps.json({
    kind,
    challenge,
    prompt,
    needs: { passkey: (keys || []).length > 0, selfie, geo: !!settings.geo.enabled },
    publicKey: (keys || []).length ? {
      challenge,
      rpId,
      allowCredentials: keys.map((k) => ({ type: 'public-key', id: k.credential_id })),
      userVerification: 'required',
      timeout: 60_000,
    } : null,
  });
}

/**
 * POST /v1/staff/punch/finish  { challenge, kind, assertion?, geo?, selfie? }
 *
 * Every check runs here, server-side, in this order: challenge (single use,
 * right person, right punch), passkey signature, network, then the evidence
 * (location, selfie). Only the first three can refuse a punch.
 */
async function handlePunchFinish(env, staff, body, request, deps) {
  const settings = settingsOf(staff);
  const kind = body.kind === 'out' ? 'out' : 'in';
  const challengeRow = await consumeChallenge(env, body.challenge, staff.staff_uid, kind);
  if (!challengeRow) return deps.fail('challenge_expired', 'That took too long. Please try again.', 400);

  const now = Date.now();

  // 1. Passkey. Once a staff member has one, it is required on every punch
  //    regardless of the owner's setting — an enrolled phone never falls
  //    back to "just the session".
  const { results: keys } = await env.DB.prepare('SELECT * FROM att_passkeys WHERE staff_uid = ?')
    .bind(staff.staff_uid).all();
  let passkeyOk = false;
  if ((keys || []).length) {
    const stored = keys.find((k) => k.credential_id === body.assertion?.id);
    if (!stored) return deps.fail('passkey_invalid', 'This phone\'s fingerprint / Face ID key was not recognised.', 403);
    const { rpId, origins } = rpConfig(env);
    try {
      const res = await verifyAssertion(body.assertion, stored, {
        challenge: challengeRow.challenge, rpId, origins, requireUV: true,
      });
      await env.DB.prepare('UPDATE att_passkeys SET sign_count = ?, last_used = ? WHERE credential_id = ?')
        .bind(res.signCount, now, stored.credential_id).run();
      passkeyOk = true;
    } catch (e) {
      return deps.fail('passkey_invalid', `Fingerprint / Face ID check failed (${e.message}).`, 403);
    }
  } else if (settings.passkey === 'required') {
    return deps.fail('passkey_required', 'Set up fingerprint / Face ID first.', 409);
  }

  // 2. Network.
  const k = ipKey(request.headers.get('cf-connecting-ip'));
  const net = await netStatusFor(env, staff.site_id, k, settings, now);
  if (net === 'mismatch' && settings.wifi_mode === 'require') {
    return deps.fail('not_on_shop_wifi', 'You are not on the shop Wi-Fi. Connect to it and try again.', 403);
  }

  // 3. Evidence: location.
  let geoStatus = settings.geo.enabled ? 'none' : 'off';
  let lat = null; let lng = null; let acc = null; let dist = null;
  const g = body.geo;
  if (g && Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lng))) {
    lat = Number(g.lat); lng = Number(g.lng);
    acc = Number.isFinite(Number(g.accuracy)) ? Number(g.accuracy) : null;
    if (settings.geo.enabled && Number.isFinite(Number(settings.geo.lat)) && Number.isFinite(Number(settings.geo.lng))) {
      dist = Math.round(haversineMeters(lat, lng, Number(settings.geo.lat), Number(settings.geo.lng)));
      geoStatus = dist <= (Number(settings.geo.radius_m) || 150) ? 'inside' : 'outside';
    }
  }

  // 4. Evidence: selfie.
  let selfie = null;
  if (needsSelfie(settings, kind)) {
    selfie = String(body.selfie || '').replace(/^data:image\/jpeg;base64,/, '');
    if (!selfie.startsWith('/9j/')) return deps.fail('selfie_required', 'A photo is required for this punch.', 400);
    if (selfie.length > SELFIE_MAX_CHARS) return deps.fail('selfie_too_large', 'The photo is too large. Try again.', 413);
  }

  // Same phone recently used by someone else → flag for the owner (not
  // blocked: a staff member without a phone may borrow one with permission).
  const shared = await env.DB.prepare(
    'SELECT 1 FROM att_sessions WHERE device_id = ? AND staff_uid != ? AND expires_at > ? LIMIT 1',
  ).bind(staff.session_device, staff.staff_uid, now).first();

  const punchId = `pch_${deps.randHex(10)}`;
  const stmts = [
    env.DB.prepare(
      `INSERT INTO att_punches (punch_id, shop_code, staff_uid, ext_id, kind, at, ip_key, ip_family,
                                net_status, lat, lng, accuracy_m, distance_m, geo_status, passkey,
                                device_id, device_shared, prompt, has_selfie, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(punchId, staff.shop_code, staff.staff_uid, staff.ext_id, kind, now,
           k?.key || null, k?.family || null, net, lat, lng, acc, dist, geoStatus,
           passkeyOk ? 1 : 0, staff.session_device, shared ? 1 : 0,
           challengeRow.prompt, selfie ? 1 : 0, now),
  ];
  if (selfie) {
    stmts.push(env.DB.prepare('INSERT INTO att_selfies (punch_id, data) VALUES (?, ?)').bind(punchId, selfie));
  }
  await env.DB.batch(stmts);

  return deps.json({
    ok: true,
    punch: { kind, at: now, net_status: net, geo_status: geoStatus, passkey: passkeyOk },
  });
}

// ── desktop: sync ───────────────────────────────────────────────────

async function ensureShop(env, site, org, companyId, companyName) {
  const existing = await env.DB.prepare('SELECT * FROM att_shops WHERE site_id = ? AND company_id = ?')
    .bind(site.site_id, companyId).first();
  if (existing) return existing;
  // No 0/O/1/I: staff read this code off a screen or a poster.
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode(6, ALPHABET);
    try {
      await env.DB.prepare(
        `INSERT INTO att_shops (shop_code, site_id, org_id, company_id, company_name, settings, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', 0, ?)`,
      ).bind(code, site.site_id, org.org_id, companyId, companyName || null, Date.now()).run();
      return env.DB.prepare('SELECT * FROM att_shops WHERE shop_code = ?').bind(code).first();
    } catch { /* code collision — try another */ }
  }
  throw new Error('could not allocate a shop code');
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * POST /v1/att/sync
 *   { license, machine_fp, company_id, company_name, enabled, settings,
 *     staff: [{ ext_id, name, phone, pin_hash, enabled, reset_seq }],
 *     views: { <ext_id>: {...} }, ack: [punch_id, …] }
 *
 * One round trip does everything, in a fixed order: remember the shop's
 * address (which may confirm pending punches), apply the owner's settings
 * and staff list, drop what the desktop has already stored, and hand back
 * whatever it has not collected yet.
 */
async function handleAttSync(env, body, request, deps) {
  const auth = await siteFromDesktop(env, body, deps);
  if (auth.error) return auth.error;
  const { org, site } = auth;

  await recordSiteIp(env, site.site_id, request);

  const companyId = Math.trunc(Number(body.company_id));
  if (!Number.isFinite(companyId) || companyId < 1) return deps.fail('bad_company', 'company_id is required.');
  const shop = await ensureShop(env, site, org, companyId, body.company_name);
  const now = Date.now();

  // Settings — stored whole; the desktop is authoritative.
  const settings = { ...DEFAULT_SETTINGS, ...(body.settings || {}) };
  await env.DB.prepare(
    'UPDATE att_shops SET settings = ?, enabled = ?, company_name = ?, updated_at = ? WHERE shop_code = ?',
  ).bind(JSON.stringify(settings), body.enabled ? 1 : 0, body.company_name || shop.company_name, now, shop.shop_code).run();

  // Staff roster.
  const incoming = Array.isArray(body.staff) ? body.staff.slice(0, 500) : [];
  const { results: currentRows } = await env.DB.prepare('SELECT * FROM att_staff WHERE shop_code = ?')
    .bind(shop.shop_code).all();
  const byExt = new Map((currentRows || []).map((r) => [r.ext_id, r]));
  const seen = new Set();
  const stmts = [];

  for (const s of incoming) {
    const extId = Math.trunc(Number(s.ext_id));
    if (!Number.isFinite(extId)) continue;
    seen.add(extId);
    const phone = normalizePhone(s.phone);
    const name = String(s.name || '').slice(0, 100) || `Staff ${extId}`;
    const pinHash = s.pin_hash ? String(s.pin_hash) : null;
    const enabled = s.enabled ? 1 : 0;
    const resetSeq = Math.trunc(Number(s.reset_seq)) || 0;
    const row = byExt.get(extId);

    if (!row) {
      stmts.push(env.DB.prepare(
        `INSERT INTO att_staff (staff_uid, shop_code, ext_id, name, phone, pin_hash, enabled, reset_seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(`stf_${deps.randHex(8)}`, shop.shop_code, extId, name, phone, pinHash, enabled, resetSeq, now));
      continue;
    }

    // A new PIN also clears any lockout: the owner just handed out a fresh one.
    const pinChanged = pinHash !== row.pin_hash;
    stmts.push(env.DB.prepare(
      `UPDATE att_staff SET name = ?, phone = ?, pin_hash = ?, enabled = ?, updated_at = ?,
              failed_count = CASE WHEN ? THEN 0 ELSE failed_count END,
              locked_until = CASE WHEN ? THEN NULL ELSE locked_until END
        WHERE staff_uid = ?`,
    ).bind(name, phone, pinHash, enabled, now, pinChanged ? 1 : 0, pinChanged ? 1 : 0, row.staff_uid));

    // "Reset phone": forget the bound phone, its passkey and every session.
    if (resetSeq > (row.reset_seq || 0)) {
      stmts.push(
        env.DB.prepare('UPDATE att_staff SET device_id = NULL, device_bound_at = NULL, reset_seq = ? WHERE staff_uid = ?')
          .bind(resetSeq, row.staff_uid),
        env.DB.prepare('DELETE FROM att_passkeys WHERE staff_uid = ?').bind(row.staff_uid),
        env.DB.prepare('DELETE FROM att_sessions WHERE staff_uid = ?').bind(row.staff_uid),
      );
    }
  }
  // Removed on the desktop → switched off here (rows kept for punch history).
  for (const row of currentRows || []) {
    if (!seen.has(row.ext_id) && row.enabled) {
      stmts.push(env.DB.prepare('UPDATE att_staff SET enabled = 0, updated_at = ? WHERE staff_uid = ?')
        .bind(now, row.staff_uid));
    }
  }

  // Acknowledged punches: mark collected, drop their selfies.
  //
  // Each ack names the net_status the desktop actually stored. A punch whose
  // status changed after it was sent (a late network match) no longer
  // matches, stays uncollected, and is delivered again — otherwise the ack
  // would swallow the upgrade and the desktop would keep "pending" forever.
  // The desktop only acks a punch once it holds its selfie, so deleting the
  // photo here never loses one.
  const ack = (Array.isArray(body.ack) ? body.ack : [])
    .filter((a) => a && /^pch_[0-9a-f]+$/.test(String(a.punch_id)))
    .slice(0, 1000);
  for (const a of ack) {
    stmts.push(
      env.DB.prepare(
        `UPDATE att_punches SET collected_at = ?
          WHERE punch_id = ? AND shop_code = ? AND net_status = ? AND collected_at IS NULL`,
      ).bind(now, String(a.punch_id), shop.shop_code, String(a.net_status || '')),
      env.DB.prepare(
        `DELETE FROM att_selfies WHERE punch_id = ?
           AND punch_id IN (SELECT punch_id FROM att_punches WHERE shop_code = ?)`,
      ).bind(String(a.punch_id), shop.shop_code),
    );
  }

  if (stmts.length) {
    for (const part of chunks(stmts, 90)) await env.DB.batch(part);
  }

  // Staff-page summaries computed by the desktop.
  if (body.views && typeof body.views === 'object') {
    const { results: staffNow } = await env.DB.prepare('SELECT staff_uid, ext_id FROM att_staff WHERE shop_code = ?')
      .bind(shop.shop_code).all();
    const uidByExt = new Map((staffNow || []).map((r) => [r.ext_id, r.staff_uid]));
    const viewStmts = [];
    for (const [ext, payload] of Object.entries(body.views)) {
      const uid = uidByExt.get(Math.trunc(Number(ext)));
      const text = JSON.stringify(payload ?? null);
      if (!uid || text.length > VIEW_MAX_CHARS) continue;
      viewStmts.push(env.DB.prepare(
        `INSERT INTO att_views (staff_uid, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(staff_uid) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      ).bind(uid, text, now));
    }
    for (const part of chunks(viewStmts, 90)) await env.DB.batch(part);
  }

  // Occasional housekeeping, spread across syncs instead of a cron.
  if (Math.random() < 0.05) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM att_challenges WHERE expires_at < ?').bind(now - 3_600_000),
      env.DB.prepare('DELETE FROM att_sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM att_punches WHERE collected_at IS NOT NULL AND at < ?').bind(now - PUNCH_RETENTION_MS),
      env.DB.prepare('DELETE FROM att_site_ips WHERE last_seen < ?').bind(now - 30 * 86_400_000),
    ]);
  }

  // Everything not yet collected (or re-opened by a late network match).
  const { results: pending } = await env.DB.prepare(
    `SELECT punch_id, ext_id, kind, at, net_status, lat, lng, accuracy_m, distance_m, geo_status,
            passkey, device_id, device_shared, prompt, has_selfie
       FROM att_punches WHERE shop_code = ? AND collected_at IS NULL ORDER BY at LIMIT ?`,
  ).bind(shop.shop_code, PULL_LIMIT + 1).all();
  const punches = (pending || []).slice(0, PULL_LIMIT);

  // `selfie_waiting` = a photo still exists here for this punch. Photos are
  // heavy, so only the first SELFIE_PULL_LIMIT travel per sync; the desktop
  // leaves the rest un-acked and they arrive, photo included, next time.
  const withPhoto = punches.filter((p) => p.has_selfie).map((p) => p.punch_id);
  const waiting = new Set();
  for (const part of chunks(withPhoto, 90)) {
    const { results } = await env.DB.prepare(
      `SELECT punch_id FROM att_selfies WHERE punch_id IN (${part.map(() => '?').join(',')})`,
    ).bind(...part).all();
    for (const r of results || []) waiting.add(r.punch_id);
  }
  const sendPhotos = withPhoto.filter((id) => waiting.has(id)).slice(0, SELFIE_PULL_LIMIT);
  if (sendPhotos.length) {
    const { results: photos } = await env.DB.prepare(
      `SELECT punch_id, data FROM att_selfies WHERE punch_id IN (${sendPhotos.map(() => '?').join(',')})`,
    ).bind(...sendPhotos).all();
    const byId = new Map((photos || []).map((p) => [p.punch_id, p.data]));
    for (const p of punches) if (byId.has(p.punch_id)) p.selfie = byId.get(p.punch_id);
  }
  for (const p of punches) p.selfie_waiting = waiting.has(p.punch_id);

  const { results: status } = await env.DB.prepare(
    `SELECT st.ext_id, st.device_id IS NOT NULL AS phone_linked, st.device_bound_at, st.last_login,
            st.locked_until, (SELECT COUNT(*) FROM att_passkeys p WHERE p.staff_uid = st.staff_uid) AS passkeys
       FROM att_staff st WHERE st.shop_code = ?`,
  ).bind(shop.shop_code).all();

  const { results: fam } = await env.DB.prepare(
    'SELECT DISTINCT family FROM att_site_ips WHERE site_id = ? AND last_seen >= ?',
  ).bind(site.site_id, now - LIVE_WINDOW_MS).all();

  return deps.json({
    shop_code: shop.shop_code,
    punches,
    has_more: (pending || []).length > PULL_LIMIT,
    staff_status: (status || []).map((r) => ({
      ext_id: r.ext_id,
      phone_linked: !!r.phone_linked,
      device_bound_at: r.device_bound_at,
      last_login: r.last_login,
      locked: !!(r.locked_until && r.locked_until > now),
      passkey: (r.passkeys || 0) > 0,
    })),
    network: { v4: (fam || []).some((f) => f.family === 4), v6: (fam || []).some((f) => f.family === 6) },
    server_time: now,
  });
}

/**
 * POST /v1/att/beacon  { license, machine_fp }
 *
 * The desktop calls this once over IPv4 and once over IPv6, so the shop's
 * address is known in BOTH families even though its regular requests only
 * use one. Without it a phone that happens to connect over IPv6 could never
 * be matched against a PC that talks IPv4 on the same router.
 */
async function handleAttBeacon(env, body, request, deps) {
  const auth = await siteFromDesktop(env, body, deps);
  if (auth.error) return auth.error;
  const k = await recordSiteIp(env, auth.site.site_id, request);
  return deps.json({ ok: true, family: k?.family || null });
}

// ── staff page ──────────────────────────────────────────────────────

const MANIFEST = {
  id: '/staff/',
  name: 'ZEHEN Staff',
  short_name: 'ZEHEN Staff',
  description: 'Check in and out at work, and see your attendance.',
  start_url: '/staff/',
  scope: '/staff/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#F6F1E7',
  theme_color: '#B0492A',
  icons: [
    { src: '/staff/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/staff/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
};

// Keeps the app shell available so the icon opens instantly and can say
// "you're offline" instead of the browser's error page. API calls are never
// cached: a check-in must always reach the server.
const SERVICE_WORKER = `
const CACHE = 'zehen-staff-v2';
const SHELL = ['/staff/', '/staff/manifest.webmanifest', '/staff/icon-192.png'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/v1/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); }
    return res;
  }).catch(() => caches.match(url.pathname).then((r) => r || caches.match('/staff/'))));
});
`;

function staticResponse(body, type) {
  return new Response(body, {
    headers: {
      'content-type': type,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(self), geolocation=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)',
      'x-frame-options': 'DENY',
    },
  });
}

// ── router ──────────────────────────────────────────────────────────

/**
 * Returns a Response for attendance routes, or null so the main router
 * carries on with its own. `deps` are the shared helpers from index.js.
 */
export async function routeAttendance(request, env, url, deps) {
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && (path === '/staff' || path === '/staff/' || path === '/staff/index.html')) {
    if (path === '/staff') return Response.redirect(`${url.origin}/staff/${url.search}`, 301);
    return staticResponse(STAFF_PAGE, 'text/html; charset=utf-8');
  }
  if (method === 'GET' && path === '/staff/manifest.webmanifest') {
    return staticResponse(JSON.stringify(MANIFEST), 'application/manifest+json');
  }
  if (method === 'GET' && path === '/staff/sw.js') {
    return staticResponse(SERVICE_WORKER, 'text/javascript; charset=utf-8');
  }
  // App icons served from this origin: Android only offers "Install app"
  // for a manifest whose icons it can fetch, and same-origin is the safe bet.
  const icon = path.match(/^\/staff\/icon-(192|512)\.png$/);
  if (method === 'GET' && icon) {
    const upstream = await fetch(`https://zehenapp.com/android-chrome-${icon[1]}.png`, { cf: { cacheTtl: 86_400 } });
    if (!upstream.ok) return new Response('not found', { status: 404 });
    return new Response(upstream.body, {
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' },
    });
  }

  if (!path.startsWith('/v1/staff/') && !path.startsWith('/v1/att/')) return null;

  const body = method === 'POST' ? await request.json().catch(() => ({})) : {};

  if (path === '/v1/att/sync' && method === 'POST')   return handleAttSync(env, body, request, deps);
  if (path === '/v1/att/beacon' && method === 'POST') return handleAttBeacon(env, body, request, deps);
  if (path === '/v1/staff/login' && method === 'POST') return handleStaffLogin(env, body, deps);
  if (path === '/v1/staff/shop' && method === 'GET') return handleShopLookup(env, url, deps);
  if (path === '/v1/staff/login/passkey/begin' && method === 'POST') return handlePasskeyLoginBegin(env, body, deps);
  if (path === '/v1/staff/login/passkey/finish' && method === 'POST') return handlePasskeyLoginFinish(env, body, deps);

  const staff = await staffFromRequest(env, request, deps);
  if (!staff) return deps.fail('unauthorized', 'Please sign in again.', 401);

  if (path === '/v1/staff/me' && method === 'GET')               return handleStaffMe(env, staff, deps);
  if (path === '/v1/staff/passkey/begin' && method === 'POST')   return handlePasskeyBegin(env, staff, request, deps);
  if (path === '/v1/staff/passkey/finish' && method === 'POST')  return handlePasskeyFinish(env, staff, body, deps);
  if (path === '/v1/staff/punch/begin' && method === 'POST')     return handlePunchBegin(env, staff, deps);
  if (path === '/v1/staff/punch/finish' && method === 'POST')    return handlePunchFinish(env, staff, body, request, deps);
  if (path === '/v1/staff/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM att_sessions WHERE token_hash = ?').bind(staff.token_hash).run();
    return deps.json({ ok: true });
  }

  return deps.fail('not_found', 'No such route.', 404);
}

// Exposed for tests.
export const _internal = { ipKey, dayStart, normalizePhone, settingsOf, b64urlToBytes };
