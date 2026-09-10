/**
 * ZEHEN control plane
 * ───────────────────
 *
 * A directory and a gate — never a data store. It knows which customers
 * exist, which branch PCs they own, and which phones may talk to them. It
 * holds no bills, parties, stock or balances.
 *
 * The invariant that governs every line below: THE DESKTOP APP NEVER CALLS
 * THIS SERVICE. ZEHEN's core promise is that a shop can bill all day with
 * the internet unplugged, so the desktop keeps using its own offline
 * Ed25519-signed licence file exactly as it always has. This service gates
 * only `mobile_access` and `cross_branch` — features that require internet
 * by their nature, so checking them online costs an offline shop nothing.
 *
 * Consequence worth stating plainly: if this Worker is down, every shop
 * keeps billing normally and existing phones keep working against their
 * tunnels. Only new pairing and branch-switching pause.
 *
 * Routes
 *   POST /v1/provision        desktop → mint tunnel + DNS for this install
 *   POST /v1/site/heartbeat   desktop → "I'm online"
 *   POST /v1/pair/start       desktop → short code to render as a QR
 *   POST /v1/pair/claim       mobile  → redeem code, receive device token
 *   GET  /v1/sites            mobile  → branches this device may open
 *   POST /v1/device/manage    desktop → list / revoke this licence's devices
 *   GET  /v1/gate             mobile  → current entitlements
 *   POST /v1/admin/*          vendor  → flip entitlements, revoke devices
 */

/* CORS.
 *
 * The mobile app calls this service directly from its WebView, whose origin
 * is `capacitor://localhost` on iOS and `http://localhost` on Android — and
 * an ordinary web origin during development. Without these headers the
 * browser blocks every pairing, branch-list and snapshot request, and the
 * app fails with an opaque "Failed to fetch".
 *
 * A wildcard origin is safe HERE specifically because every authenticated
 * route uses a Bearer token and this service sets no cookies: there is no
 * ambient credential for another origin to ride on. `Allow-Credentials` is
 * deliberately absent, which is also what makes the wildcard legal.
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  ...CORS_HEADERS,
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const fail = (code, message, status = 400) => json({ error: message, code }, status);

// ── small crypto/id helpers ──────────────────────────────────────────
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const randHex = (bytes) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a ZEHEN licence envelope with the same Ed25519 public key the
 * desktop embeds. Accepts the same prefixed formats the desktop accepts so
 * a customer can paste the identical string here and on the PC.
 *
 * Returns the parsed payload, or null when the signature does not verify.
 * A licence this service cannot verify is simply not a customer.
 */
const LICENSE_PREFIXES = ['ZEHEN-LIC-V1:', 'ZEHEN-LIC:', 'BILLINGERP-LIC-V1:', 'BILLINGERP-LIC:'];

async function verifyLicense(licenseText, publicKeyB64) {
  let envelope;
  try {
    const trimmed = String(licenseText || '').trim();
    const prefix = LICENSE_PREFIXES.find((p) => trimmed.startsWith(p));
    envelope = JSON.parse(
      prefix ? atob(trimmed.slice(prefix.length)) : trimmed,
    );
  } catch { return null; }

  if (!envelope?.payload || !envelope?.signature) return null;

  try {
    const key = await crypto.subtle.importKey(
      'raw', b64ToBytes(publicKeyB64), { name: 'Ed25519' }, false, ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'Ed25519', key,
      b64ToBytes(envelope.signature),
      new TextEncoder().encode(envelope.payload),
    );
    if (!ok) return null;
    return JSON.parse(envelope.payload);
  } catch { return null; }
}

// ── Cloudflare API ───────────────────────────────────────────────────
async function cfApi(env, path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!body?.success) {
    const detail = JSON.stringify(body?.errors || body).slice(0, 300);
    throw new Error(`cloudflare_api ${path}: ${detail}`);
  }
  return body.result;
}

/**
 * Confirm a hostname actually resolves on the public internet before we
 * hand it to any client, using DNS-over-HTTPS against two independent
 * resolvers.
 *
 * This exists because of a real failure seen in testing: query a hostname
 * before its record exists and some ISP resolvers negative-cache the
 * NXDOMAIN for minutes, so the shop's brand-new install looks broken even
 * after the record appears. Create first, verify, and only then release
 * the hostname — a client then never has cause to ask too early.
 */
async function dnsResolves(hostname) {
  const resolvers = [
    `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`,
    `https://dns.google/resolve?name=${hostname}&type=A`,
  ];
  for (const url of resolvers) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/dns-json' } });
      const body = await res.json();
      if (body?.Status === 0 && Array.isArray(body.Answer) && body.Answer.length) return true;
    } catch { /* try the next resolver */ }
  }
  return false;
}

/**
 * Re-fetch a tunnel's connector token. The token is not stored here — the
 * desktop keeps it — but a PC that lost its copy (reinstall, restore from
 * backup) must be able to recover without us tearing down a working tunnel.
 */
const tunnelToken = (env, tunnelId) =>
  cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`);

// ── org helpers ──────────────────────────────────────────────────────
async function findOrCreateOrg(env, payload) {
  const customerId = String(payload.customer_id ?? payload.customer_name ?? '').trim();
  if (!customerId) return null;

  const existing = await env.DB
    .prepare('SELECT * FROM orgs WHERE customer_id = ?').bind(customerId).first();
  if (existing) return existing;

  const org = {
    org_id: `org_${randHex(8)}`,
    customer_id: customerId,
    name: payload.customer_name || customerId,
    created_at: Date.now(),
  };
  await env.DB.prepare(
    `INSERT INTO orgs (org_id, customer_id, name, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(org.org_id, org.customer_id, org.name, org.created_at).run();

  return env.DB.prepare('SELECT * FROM orgs WHERE org_id = ?').bind(org.org_id).first();
}

/** Resolve a mobile bearer token to its device row, or null. */
async function deviceFromRequest(env, request) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const hash = await sha256Hex(auth.slice(7));
  return env.DB.prepare(
    `SELECT d.*, o.mobile_access, o.cross_branch, o.suspended, o.max_devices
       FROM devices d JOIN orgs o ON o.org_id = d.org_id
      WHERE d.token_hash = ? AND d.revoked = 0`,
  ).bind(hash).first();
}

// ── route handlers ───────────────────────────────────────────────────

/**
 * POST /v1/provision  { license, machine_fp, site_name }
 *
 * Idempotent per machine: a desktop that re-provisions gets its existing
 * site back rather than leaking a second tunnel. That matters because this
 * runs on every app start, not just first install.
 */
async function handleProvision(env, body) {
  const payload = await verifyLicense(body.license, env.LICENSE_PUBLIC_KEY);
  if (!payload) return fail('invalid_license', 'Licence signature did not verify.', 403);

  const today = new Date().toISOString().slice(0, 10);
  if (payload.expires_at && today > payload.expires_at) {
    return fail('license_expired', `Licence expired on ${payload.expires_at}.`, 403);
  }

  const machineFp = String(body.machine_fp || '').trim();
  if (!machineFp) return fail('missing_machine_fp', 'machine_fp is required.');

  const org = await findOrCreateOrg(env, payload);
  if (!org) return fail('invalid_license', 'Licence carries no customer id.', 403);
  if (org.suspended) return fail('org_suspended', 'This account is suspended.', 403);

  // Same PC asking again — hand back what it already has, but ONLY if that
  // site actually finished provisioning. A half-provisioned row must never
  // be returned as though it were usable: the desktop would sit forever on
  // a hostname whose DNS record was never created. Anything not 'ready' is
  // torn down and provisioned afresh below.
  const existing = await env.DB.prepare(
    'SELECT * FROM sites WHERE org_id = ? AND machine_fp = ?',
  ).bind(org.org_id, machineFp).first();

  if (existing && existing.status === 'disabled') {
    return fail('site_disabled', 'This site has been disabled.', 403);
  }

  if (existing && existing.status === 'ready') {
    return json({
      site_id: existing.site_id,
      hostname: existing.hostname,
      status: 'ready',
      already_provisioned: true,
      tunnel_token: await tunnelToken(env, existing.tunnel_id).catch(() => null),
    });
  }

  if (existing && existing.tunnel_id) {
    // Still 'provisioning'. That is NOT proof of failure: DNS routinely
    // takes longer to go live than the provisioning request itself, so a
    // healthy brand-new site sits in this state for a minute or so. Tearing
    // it down here would destroy a working tunnel every time the desktop
    // restarted — so re-check reality before touching anything.
    if (await dnsResolves(existing.hostname)) {
      await env.DB.prepare("UPDATE sites SET status = 'ready' WHERE site_id = ?")
        .bind(existing.site_id).run();
      return json({
        site_id: existing.site_id,
        hostname: existing.hostname,
        status: 'ready',
        already_provisioned: true,
        tunnel_token: await tunnelToken(env, existing.tunnel_id).catch(() => null),
      });
    }

    // DNS still not answering. Distinguish "record exists, propagation is
    // slow" from "the record was never created" — only the latter warrants
    // scrapping the site and starting over.
    const records = await cfApi(
      env, `/zones/${env.CF_ZONE_ID}/dns_records?name=${existing.hostname}`,
    ).catch(() => null);

    if (records && records.length) {
      return json({
        site_id: existing.site_id,
        hostname: existing.hostname,
        status: 'provisioning',
        already_provisioned: true,
        tunnel_token: await tunnelToken(env, existing.tunnel_id).catch(() => null),
      });
    }

    // Genuinely broken: tunnel exists, DNS record does not. Bin it and
    // re-provision cleanly below rather than leaking another tunnel.
    await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${existing.tunnel_id}`,
      { method: 'DELETE' }).catch(() => {});
    await env.DB.prepare('DELETE FROM sites WHERE site_id = ?')
      .bind(existing.site_id).run();
  } else if (existing) {
    await env.DB.prepare('DELETE FROM sites WHERE site_id = ?')
      .bind(existing.site_id).run();
  }

  const siteCount = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sites WHERE org_id = ?',
  ).bind(org.org_id).first();
  if ((siteCount?.n ?? 0) >= org.max_sites) {
    return fail('site_limit', `Licence allows ${org.max_sites} site(s).`, 403);
  }

  // Unguessable subdomain — hostnames must not be enumerable.
  //
  // Deliberately ONE level deep (s-<id>.zehenapp.com, never <id>.api.
  // zehenapp.com). Cloudflare's free Universal SSL issues a single wildcard
  // level, so `*.zehenapp.com` is covered but `*.api.zehenapp.com` is not —
  // a third-level host fails the TLS handshake outright and would need
  // Advanced Certificate Manager at $10/month to fix. The `s-` prefix keeps
  // these clear of real subdomains like www / license / download.
  const siteId = randHex(6);
  const hostname = `s-${siteId}.${env.SITE_DOMAIN}`;

  const tunnel = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, {
    method: 'POST',
    // config_src 'cloudflare' = remotely-managed: the ingress rules live in
    // the account (set just below) rather than in a config file on the shop's
    // PC, so we can repair a tunnel's routing without touching the machine.
    // No tunnel_secret is needed on this path — the API returns the connector
    // token, which is the only credential cloudflared needs.
    body: JSON.stringify({ name: `zehen-${siteId}`, config_src: 'cloudflare' }),
  });

  // From here on the tunnel exists in the account, so every failure path has
  // to delete it again. Without this a transient DNS error would strand an
  // orphan tunnel on the account on every retry.
  try {
    await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/configurations`, {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname, service: 'http://localhost:3001' },
            { service: 'http_status:404' },
          ],
        },
      }),
    });

    await cfApi(env, `/zones/${env.CF_ZONE_ID}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'CNAME',
        name: hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
        comment: `ZEHEN site ${siteId}`,
      }),
    });
  } catch (err) {
    await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}`,
      { method: 'DELETE' }).catch(() => {});
    throw err;
  }

  await env.DB.prepare(
    `INSERT INTO sites (site_id, org_id, name, hostname, tunnel_id, machine_fp, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?)`,
  ).bind(
    siteId, org.org_id, body.site_name || 'Main', hostname,
    tunnel.id, machineFp, Date.now(),
  ).run();

  const resolved = await dnsResolves(hostname);
  if (resolved) {
    await env.DB.prepare("UPDATE sites SET status = 'ready' WHERE site_id = ?")
      .bind(siteId).run();
  }

  return json({
    site_id: siteId,
    hostname,
    status: resolved ? 'ready' : 'provisioning',
    tunnel_token: tunnel.token,
  });
}

/**
 * GET /v1/sites — the branch directory a phone is allowed to open.
 *
 * Without `cross_branch` a device sees only the site it paired with. Only
 * 'ready' sites are ever listed, so a phone can never query a hostname
 * whose DNS record is not yet live.
 */
async function handleSites(env, device) {
  if (!device.mobile_access) {
    return fail('mobile_disabled', 'Mobile access is not enabled for this account.', 403);
  }
  const query = device.cross_branch
    ? env.DB.prepare(
        `SELECT site_id, name, hostname, status, last_seen FROM sites
          WHERE org_id = ? AND status = 'ready' ORDER BY created_at`,
      ).bind(device.org_id)
    : env.DB.prepare(
        `SELECT site_id, name, hostname, status, last_seen FROM sites
          WHERE org_id = ? AND site_id = ? AND status = 'ready'`,
      ).bind(device.org_id, device.home_site);

  const { results } = await query.all();
  return json({ sites: results || [], cross_branch: !!device.cross_branch });
}

/** POST /v1/pair/start — desktop mints a short code to show as a QR. */
async function handlePairStart(env, body) {
  const site = await env.DB.prepare('SELECT * FROM sites WHERE site_id = ?')
    .bind(String(body.site_id || '')).first();
  if (!site) return fail('unknown_site', 'No such site.', 404);

  const code = randHex(4).toUpperCase();
  const expiresAt = Date.now() + 10 * 60 * 1000;   // 10 minutes
  await env.DB.prepare(
    'INSERT INTO pairing_codes (code, site_id, expires_at) VALUES (?, ?, ?)',
  ).bind(code, site.site_id, expiresAt).run();

  return json({ code, expires_at: expiresAt, hostname: site.hostname });
}

/** POST /v1/pair/claim — mobile redeems the code for a device token. */
async function handlePairClaim(env, body) {
  const code = String(body.code || '').trim().toUpperCase();
  const row = await env.DB.prepare(
    'SELECT * FROM pairing_codes WHERE code = ? AND used_at IS NULL',
  ).bind(code).first();
  if (!row) return fail('bad_code', 'That pairing code is not valid.', 403);
  if (row.expires_at < Date.now()) return fail('code_expired', 'That pairing code has expired.', 403);

  const site = await env.DB.prepare('SELECT * FROM sites WHERE site_id = ?')
    .bind(row.site_id).first();
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE org_id = ?')
    .bind(site.org_id).first();
  if (org.suspended) return fail('org_suspended', 'This account is suspended.', 403);
  if (!org.mobile_access) return fail('mobile_disabled', 'Mobile access is not enabled.', 403);

  const active = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM devices WHERE org_id = ? AND revoked = 0',
  ).bind(org.org_id).first();
  if ((active?.n ?? 0) >= org.max_devices) {
    return fail('device_limit', `Licence allows ${org.max_devices} paired device(s).`, 403);
  }

  const token = randHex(32);
  await env.DB.prepare(
    `INSERT INTO devices (device_id, org_id, home_site, token_hash, label, platform, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `dev_${randHex(8)}`, org.org_id, site.site_id, await sha256Hex(token),
    body.label || 'Phone', body.platform || 'unknown', Date.now(),
  ).run();

  await env.DB.prepare('UPDATE pairing_codes SET used_at = ? WHERE code = ?')
    .bind(Date.now(), code).run();

  return json({ device_token: token, site: { site_id: site.site_id, hostname: site.hostname } });
}


/**
 * POST /v1/site/devices  { license, machine_fp }
 *
 * The allow-list a desktop enforces on tunnel traffic.
 *
 * Without this, a tunnel hostname plus a stolen password would be enough to
 * reach a shop's books from anywhere, and revoking a phone here would not
 * actually stop it — the control plane is not in the request path. So each
 * desktop pulls the hashes of its org's live device tokens and refuses any
 * tunnel request that does not present one.
 *
 * Only hashes leave this service, never the tokens themselves, so a desktop
 * (or anyone reading its cache) cannot mint a working device credential.
 */
async function handleSiteDevices(env, body) {
  const payload = await verifyLicense(body.license, env.LICENSE_PUBLIC_KEY);
  if (!payload) return fail('invalid_license', 'Licence signature did not verify.', 403);

  const customerId = String(payload.customer_id ?? payload.customer_name ?? '').trim();
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE customer_id = ?')
    .bind(customerId).first();
  if (!org) return fail('unknown_org', 'This licence has no account yet.', 404);

  const site = await env.DB.prepare(
    'SELECT * FROM sites WHERE org_id = ? AND machine_fp = ?',
  ).bind(org.org_id, String(body.machine_fp || '')).first();
  if (!site) return fail('unknown_site', 'This machine is not provisioned.', 404);

  await env.DB.prepare('UPDATE sites SET last_seen = ? WHERE site_id = ?')
    .bind(Date.now(), site.site_id).run();

  // Suspended or mobile-disabled orgs get an EMPTY allow-list rather than an
  // error: the desktop then rejects every remote request, which is exactly
  // what revocation should do, and it happens without the desktop needing to
  // interpret any status code.
  const revokeAll = org.suspended || !org.mobile_access;
  const { results } = revokeAll
    ? { results: [] }
    : await env.DB.prepare(
        'SELECT token_hash FROM devices WHERE org_id = ? AND revoked = 0',
      ).bind(org.org_id).all();

  return json({
    device_hashes: (results || []).map((r) => r.token_hash),
    // The desktop verifies SSO assertions with this. Shipped on the sync it
    // already makes, so there is no extra fetch and no key to configure.
    sso_public_key: env.SSO_PUBLIC_KEY || null,
    mobile_access: !!org.mobile_access && !org.suspended,
    cross_branch:  !!org.cross_branch && !org.suspended,
    site_id: site.site_id,
    fetched_at: Date.now(),
  });
}


// Cap on a single snapshot. Generous for headline figures, small enough that
// a bug in the desktop cannot fill the account's database.
const SNAPSHOT_MAX_BYTES = 512 * 1024;

/**
 * POST /v1/snapshot  { license, machine_fp, payload }
 *
 * The desktop pushes its pre-rendered headline figures here every few
 * minutes so the owner can still see the shop when the billing PC is off.
 *
 * Authenticated by the same signed licence as provisioning — a snapshot is
 * written by a MACHINE, not by a phone, so a stolen device token cannot
 * poison what other phones read.
 */
async function handleSnapshotPut(env, body) {
  const payload = await verifyLicense(body.license, env.LICENSE_PUBLIC_KEY);
  if (!payload) return fail('invalid_license', 'Licence signature did not verify.', 403);

  const customerId = String(payload.customer_id ?? payload.customer_name ?? '').trim();
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE customer_id = ?')
    .bind(customerId).first();
  if (!org) return fail('unknown_org', 'This licence has no account yet.', 404);

  const site = await env.DB.prepare(
    'SELECT * FROM sites WHERE org_id = ? AND machine_fp = ?',
  ).bind(org.org_id, String(body.machine_fp || '')).first();
  if (!site) return fail('unknown_site', 'This machine is not provisioned.', 404);

  const text = JSON.stringify(body.payload ?? {});
  if (text.length > SNAPSHOT_MAX_BYTES) {
    return fail('snapshot_too_large', `Snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes.`, 413);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO snapshots (site_id, org_id, payload, bytes, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site_id) DO UPDATE SET
       payload = excluded.payload, bytes = excluded.bytes, updated_at = excluded.updated_at`,
  ).bind(site.site_id, org.org_id, text, text.length, now).run();

  await env.DB.prepare('UPDATE sites SET last_seen = ? WHERE site_id = ?')
    .bind(now, site.site_id).run();

  return json({ ok: true, bytes: text.length, updated_at: now });
}

/**
 * GET /v1/snapshot[?site_id=…]  (device token)
 *
 * What a phone reads when it cannot reach the shop server. Returns the last
 * pushed figures plus the timestamp they were generated — the app must show
 * that age, because a stale balance presented as live is worse than no
 * balance at all.
 */
async function handleSnapshotGet(env, device, url) {
  if (!device.mobile_access) {
    return fail('mobile_disabled', 'Mobile access is not enabled for this account.', 403);
  }

  const requested = url.searchParams.get('site_id');
  // Without cross_branch a phone may only read the site it paired with.
  const siteId = (requested && device.cross_branch) ? requested : device.home_site;

  const row = await env.DB.prepare(
    'SELECT s.*, si.name FROM snapshots s JOIN sites si ON si.site_id = s.site_id WHERE s.site_id = ? AND s.org_id = ?',
  ).bind(siteId, device.org_id).first();

  if (!row) return fail('no_snapshot', 'No offline data has been saved for this branch yet.', 404);

  let parsed = null;
  try { parsed = JSON.parse(row.payload); } catch { /* corrupt row */ }
  if (!parsed) return fail('no_snapshot', 'Saved offline data could not be read.', 404);

  return json({
    site_id: row.site_id,
    site_name: row.name,
    updated_at: row.updated_at,
    snapshot: parsed,
  });
}


/* ── Account identity ────────────────────────────────────────────────
 *
 * Passwords are hashed with PBKDF2-SHA256 (WebCrypto). bcrypt/argon2 are not
 * available in a Worker without shipping WASM, and PBKDF2 at 210k iterations
 * is the accepted floor for this setting. Format is self-describing so the
 * iteration count can be raised later without invalidating existing rows.
 */
// 100k is the Workers platform ceiling — WebCrypto there refuses anything
// higher ("iteration counts above 100000 are not supported"). That is below
// the 600k OWASP currently suggests for PBKDF2-SHA256, so the online attack
// surface is closed off separately: five failures locks the account for 15
// minutes, persisted in D1 so recycling an isolate does not reset the budget.
// An offline attack needs a database breach first.
//
// The stored format carries its own iteration count, so this can be raised
// later without invalidating a single existing password.
const PBKDF2_ITERATIONS = 100_000;

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256,
  );
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, iters, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const bits = await pbkdf2(password, b64ToBytes(saltB64), Number(iters));
    const a = new Uint8Array(bits);
    const b = b64ToBytes(hashB64);
    if (a.length !== b.length) return false;
    // Constant-time compare — a timing oracle here would leak the hash.
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch { return false; }
}

/**
 * Normalise what the user typed so the same person is the same row.
 * "  Ali@Shop.COM " and "ali@shop.com" match; "+91 98765 43210",
 * "098765 43210" and "919876543210" all collapse to one phone identity.
 */
function normalizeIdentifier(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (text.includes('@')) {
    const email = text.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
    return { value: email, kind: 'email' };
  }

  let digits = text.replace(/[^\d]/g, '');
  if (digits.length === 10) digits = '91' + digits;            // bare Indian mobile
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  if (digits.length < 10 || digits.length > 15) return null;
  return { value: digits, kind: 'phone' };
}

/**
 * Sign a short-lived assertion the SHOP server can verify.
 *
 * This is what removes the need for a second password. The control plane
 * proves "this person authenticated, and they are `shop_username` at this
 * site"; the shop server checks the Ed25519 signature against a public key it
 * already syncs, then mints its own ordinary JWT. No shared secret, and a
 * leak of the control plane's database still cannot forge one of these.
 *
 * 120 seconds: long enough to survive a slow handover, short enough that a
 * captured assertion is worthless.
 */
async function signAssertion(env, claims) {
  const body = { ...claims, iat: Date.now(), exp: Date.now() + 120_000 };
  const payload = JSON.stringify(body);
  const key = await crypto.subtle.importKey(
    'pkcs8', b64ToBytes(env.SSO_PRIVATE_KEY), { name: 'Ed25519' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload));
  return `${btoa(payload)}.${toB64(sig)}`;
}

/**
 * POST /v1/account/login  { identifier, password }
 *
 * The mobile app's front door. Returns everything the phone needs to reach a
 * shop it has never seen: which servers it may open, a device token for the
 * tunnel gate, and a one-shot assertion to exchange for a shop session.
 */
async function handleAccountLogin(env, body) {
  const id = normalizeIdentifier(body.identifier);
  const password = String(body.password || '');
  // One message for every failure below, so this endpoint cannot be used to
  // discover which emails or phone numbers are registered.
  const DENY = () => fail('bad_credentials', 'Wrong email/phone or password.', 401);
  if (!id || !password) return DENY();

  const acct = await env.DB.prepare(
    `SELECT a.*, o.mobile_access, o.cross_branch, o.suspended, o.max_devices
       FROM accounts a JOIN orgs o ON o.org_id = a.org_id
      WHERE a.identifier = ?`,
  ).bind(id.value).first();
  if (!acct || acct.disabled) return DENY();

  const now = Date.now();
  if (acct.locked_until && acct.locked_until > now) {
    return fail('locked', 'Too many attempts. Try again in a few minutes.', 429);
  }

  if (!(await verifyPassword(password, acct.password_hash))) {
    const failed = (acct.failed_count || 0) + 1;
    // 5 strikes → 15 minutes. Persisted, so recycling the isolate does not
    // hand an attacker a fresh budget.
    const lock = failed >= 5 ? now + 15 * 60_000 : null;
    await env.DB.prepare('UPDATE accounts SET failed_count = ?, locked_until = ? WHERE account_id = ?')
      .bind(failed, lock, acct.account_id).run();
    return DENY();
  }

  if (acct.suspended || !acct.mobile_access) {
    return fail('mobile_disabled', 'Mobile access is not enabled for this account.', 403);
  }

  await env.DB.prepare(
    'UPDATE accounts SET failed_count = 0, locked_until = NULL, last_login = ? WHERE account_id = ?',
  ).bind(now, acct.account_id).run();

  // One device row per (account, INSTALL) — not per account.
  //
  // Keying on the account alone meant a second phone signing in with the same
  // email silently replaced the first one's token, and that phone simply
  // stopped working a few minutes later with no explanation. An owner could
  // not use a phone and a tablet, and it bought no security: a leaked
  // password would just make the two sides kick each other off in a loop.
  //
  // The install id is generated once by the app and kept in its storage, so
  // re-signing-in on the SAME device reuses its slot rather than consuming
  // another. Devices are still capped by the licence's max_devices, which is
  // where the limit belongs.
  const install = String(body.install_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const deviceLabel = install
    ? `account:${acct.account_id}:${install}`
    : `account:${acct.account_id}`;   // older app builds send no install id

  let device = await env.DB.prepare(
    'SELECT * FROM devices WHERE org_id = ? AND label = ? AND revoked = 0',
  ).bind(acct.org_id, deviceLabel).first();

  // Upgrade path: a phone that previously signed in from a build with no
  // install id owns a row under the bare `account:<id>` label. Claim that row
  // rather than opening a second one — otherwise simply updating the app
  // would burn an extra device slot and strand the old row forever.
  if (!device && install) {
    const legacy = await env.DB.prepare(
      'SELECT * FROM devices WHERE org_id = ? AND label = ? AND revoked = 0',
    ).bind(acct.org_id, `account:${acct.account_id}`).first();
    if (legacy) {
      await env.DB.prepare('UPDATE devices SET label = ? WHERE device_id = ?')
        .bind(deviceLabel, legacy.device_id).run();
      device = { ...legacy, label: deviceLabel };
    }
  }

  let deviceToken = null;
  if (!device) {
    const active = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM devices WHERE org_id = ? AND revoked = 0',
    ).bind(acct.org_id).first();
    if ((active?.n ?? 0) >= acct.max_devices) {
      return fail('device_limit', `Licence allows ${acct.max_devices} device(s). Remove one first.`, 403);
    }
    deviceToken = randHex(32);
    await env.DB.prepare(
      `INSERT INTO devices (device_id, org_id, home_site, token_hash, label, platform, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`dev_${randHex(8)}`, acct.org_id, acct.site_id,
           await sha256Hex(deviceToken), deviceLabel,
           body.platform || 'unknown', now).run();
  } else {
    // The stored hash cannot be reversed, so a returning phone that lost its
    // token gets a fresh one and the old row is retired.
    deviceToken = randHex(32);
    await env.DB.prepare('UPDATE devices SET token_hash = ?, last_seen = ? WHERE device_id = ?')
      .bind(await sha256Hex(deviceToken), now, device.device_id).run();
  }

  const sitesQuery = acct.cross_branch
    ? env.DB.prepare(`SELECT site_id, name, hostname FROM sites WHERE org_id = ? AND status = 'ready' ORDER BY created_at`).bind(acct.org_id)
    : env.DB.prepare(`SELECT site_id, name, hostname FROM sites WHERE site_id = ? AND status = 'ready'`).bind(acct.site_id);
  const { results: sites } = await sitesQuery.all();

  const home = (sites || []).find((x) => x.site_id === acct.site_id) || (sites || [])[0] || null;

  return json({
    device_token: deviceToken,
    account: { label: acct.label, identifier: acct.identifier, kind: acct.identifier_kind },
    site: home,
    sites: sites || [],
    cross_branch: !!acct.cross_branch,
    assertion: home
      ? await signAssertion(env, { sub: acct.shop_username, site_id: home.site_id, account_id: acct.account_id })
      : null,
  });
}

/**
 * POST /v1/account/manage  { license, machine_fp, action, ... }
 *
 * Account administration, driven from the shop's own desktop and
 * authenticated by its signed licence. The shop owner decides who may open
 * the app; the vendor is not in that loop.
 */
async function handleAccountManage(env, body) {
  const payload = await verifyLicense(body.license, env.LICENSE_PUBLIC_KEY);
  if (!payload) return fail('invalid_license', 'Licence signature did not verify.', 403);

  const customerId = String(payload.customer_id ?? payload.customer_name ?? '').trim();
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE customer_id = ?').bind(customerId).first();
  if (!org) return fail('unknown_org', 'This licence has no account yet.', 404);

  const site = await env.DB.prepare('SELECT * FROM sites WHERE org_id = ? AND machine_fp = ?')
    .bind(org.org_id, String(body.machine_fp || '')).first();
  if (!site) return fail('unknown_site', 'This machine is not provisioned.', 404);

  const action = String(body.action || 'list');

  if (action === 'list') {
    const { results } = await env.DB.prepare(
      `SELECT account_id, identifier, identifier_kind, shop_username, label, disabled, created_at, last_login
         FROM accounts WHERE org_id = ? ORDER BY created_at`,
    ).bind(org.org_id).all();
    return json({ accounts: results || [] });
  }

  if (action === 'create') {
    const id = normalizeIdentifier(body.identifier);
    if (!id) return fail('bad_identifier', 'Enter a valid email address or phone number.');
    const password = String(body.password || '');
    if (password.length < 8) return fail('weak_password', 'Password must be at least 8 characters.');
    if (!String(body.shop_username || '').trim()) {
      return fail('missing_user', 'Pick which ZEHEN user this account signs in as.');
    }

    const clash = await env.DB.prepare('SELECT account_id FROM accounts WHERE identifier = ?')
      .bind(id.value).first();
    if (clash) return fail('exists', 'That email or phone is already in use.', 409);

    await env.DB.prepare(
      `INSERT INTO accounts (account_id, org_id, site_id, identifier, identifier_kind,
                             password_hash, shop_username, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`acc_${randHex(8)}`, org.org_id, site.site_id, id.value, id.kind,
           await hashPassword(password), String(body.shop_username).trim(),
           body.label || null, Date.now()).run();
    return json({ ok: true });
  }

  if (action === 'set_password') {
    const password = String(body.password || '');
    if (password.length < 8) return fail('weak_password', 'Password must be at least 8 characters.');
    await env.DB.prepare(
      'UPDATE accounts SET password_hash = ?, failed_count = 0, locked_until = NULL WHERE account_id = ? AND org_id = ?',
    ).bind(await hashPassword(password), String(body.account_id), org.org_id).run();
    return json({ ok: true });
  }

  if (action === 'delete') {
    // Retire the paired device too, so removing someone's access actually
    // ends their session instead of leaving a working tunnel credential.
    // LIKE so every install belonging to this account is revoked, not only a
    // legacy row that happens to carry the bare label.
    await env.DB.prepare(
      "UPDATE devices SET revoked = 1 WHERE org_id = ? AND (label = ? OR label LIKE ?)",
    ).bind(org.org_id, `account:${String(body.account_id)}`,
           `account:${String(body.account_id)}:%`).run();
    await env.DB.prepare('DELETE FROM accounts WHERE account_id = ? AND org_id = ?')
      .bind(String(body.account_id), org.org_id).run();
    return json({ ok: true });
  }

  return fail('bad_action', 'Unknown action.');
}

/**
 * POST /v1/device/manage  { license, machine_fp, action, device_id? }
 *
 * The owner's list of paired devices, and the way to take one off.
 *
 * Device slots are finite (a licence allows N), and until this existed there
 * was no way to free one: the desktop could see a COUNT and nothing more, so
 * a shop that filled its slots with a replaced phone and a couple of stale
 * sign-ins was simply stuck. Authenticated by the licence plus this machine's
 * fingerprint, exactly like account management — an owner sitting at the shop
 * computer, which is the only place this should be possible from.
 *
 * `revoke` is soft: the row stays for audit and the token hash stops being
 * handed to the desktop's allow-list, which is what actually ends access.
 */
async function handleDeviceManage(env, body) {
  const payload = await verifyLicense(body.license, env.LICENSE_PUBLIC_KEY);
  if (!payload) return fail('invalid_license', 'Licence signature did not verify.', 403);

  const customerId = String(payload.customer_id ?? payload.customer_name ?? '').trim();
  const org = await env.DB.prepare('SELECT * FROM orgs WHERE customer_id = ?').bind(customerId).first();
  if (!org) return fail('unknown_org', 'This licence has no account yet.', 404);

  const site = await env.DB.prepare('SELECT * FROM sites WHERE org_id = ? AND machine_fp = ?')
    .bind(org.org_id, String(body.machine_fp || '')).first();
  if (!site) return fail('unknown_site', 'This machine is not provisioned.', 404);

  const action = String(body.action || 'list');

  if (action === 'list') {
    // Label is written as `account:<account_id>:<install_id>`; join the
    // account so the owner sees "Ali's phone — aliansari@…" rather than an
    // opaque id they cannot match to a person.
    const { results } = await env.DB.prepare(
      `SELECT d.device_id, d.label, d.platform, d.revoked, d.created_at, d.last_seen,
              d.home_site, a.identifier, a.label AS account_label
         FROM devices d
    LEFT JOIN accounts a
           ON d.label = 'account:' || a.account_id
           OR d.label LIKE 'account:' || a.account_id || ':%'
        WHERE d.org_id = ?
     ORDER BY d.revoked ASC, d.last_seen DESC, d.created_at DESC`,
    ).bind(org.org_id).all();

    return json({
      devices: (results || []).map((d) => ({
        device_id: d.device_id,
        platform: d.platform || 'unknown',
        revoked: !!d.revoked,
        created_at: d.created_at,
        last_seen: d.last_seen,
        identifier: d.identifier || null,
        account_label: d.account_label || null,
        home_site: d.home_site,
      })),
      max_devices: org.max_devices,
      used: (results || []).filter((d) => !d.revoked).length,
    });
  }

  if (action === 'revoke') {
    const id = String(body.device_id || '');
    if (!id) return fail('bad_device', 'Which device?');
    const row = await env.DB.prepare('SELECT device_id FROM devices WHERE device_id = ? AND org_id = ?')
      .bind(id, org.org_id).first();
    // Scoped to this org on purpose: a licence must never be able to revoke
    // another customer's device by guessing an id.
    if (!row) return fail('unknown_device', 'That device is not on this account.', 404);
    await env.DB.prepare('UPDATE devices SET revoked = 1 WHERE device_id = ? AND org_id = ?')
      .bind(id, org.org_id).run();
    return json({ ok: true });
  }

  return fail('bad_action', 'Unknown action.');
}

// ── router ───────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight. Must answer before any auth check — the browser sends this
    // without the Authorization header by design.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === '/health') return json({ status: 'ok', service: 'zehen-control-plane' });

    try {
      const body = request.method === 'POST'
        ? await request.json().catch(() => ({}))
        : {};

      if (path === '/v1/provision'   && request.method === 'POST') return await handleProvision(env, body);
      if (path === '/v1/account/login'  && request.method === 'POST') return await handleAccountLogin(env, body);
      if (path === '/v1/account/manage' && request.method === 'POST') return await handleAccountManage(env, body);
      if (path === '/v1/device/manage'  && request.method === 'POST') return await handleDeviceManage(env, body);
      if (path === '/v1/site/devices'&& request.method === 'POST') return await handleSiteDevices(env, body);
      if (path === '/v1/snapshot'    && request.method === 'POST') return await handleSnapshotPut(env, body);
      if (path === '/v1/pair/start'  && request.method === 'POST') return await handlePairStart(env, body);
      if (path === '/v1/pair/claim'  && request.method === 'POST') return await handlePairClaim(env, body);

      // Device-authenticated routes.
      if (path === '/v1/sites' || path === '/v1/gate' || path === '/v1/snapshot') {
        const device = await deviceFromRequest(env, request);
        if (!device) return fail('unauthorized', 'Unknown or revoked device.', 401);
        if (device.suspended) return fail('org_suspended', 'This account is suspended.', 403);

        await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?')
          .bind(Date.now(), device.device_id).run();

        if (path === '/v1/sites') return await handleSites(env, device);
        if (path === '/v1/snapshot') return await handleSnapshotGet(env, device, url);
        return json({
          mobile_access: !!device.mobile_access,
          cross_branch:  !!device.cross_branch,
        });
      }

      return fail('not_found', 'No such route.', 404);
    } catch (err) {
      // Never leak Cloudflare API detail to a caller; log it for `wrangler tail`.
      console.error('control-plane error:', err?.stack || String(err));
      return fail('internal_error', 'Something went wrong.', 500);
    }
  },
};
