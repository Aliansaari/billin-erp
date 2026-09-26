-- ZEHEN control plane — D1 schema
-- ───────────────────────────────
--
-- This database holds ACCOUNTS, never business data. No bills, no parties,
-- no stock, no money figures ever land here. That separation is deliberate:
-- if the control plane is down or compromised, no shop's books are exposed
-- and no shop stops billing — their data lives on their own PC behind their
-- own tunnel, and the desktop app never consults this service at all.
--
-- Three tables, one hierarchy:
--   orgs    — one paying customer (keyed off license `customer_id`)
--   sites   — one desktop install / branch PC, each with its own tunnel
--   devices — one paired phone

CREATE TABLE IF NOT EXISTS orgs (
  org_id        TEXT PRIMARY KEY,          -- internal id, e.g. "org_7f3a…"
  customer_id   TEXT NOT NULL UNIQUE,      -- from the signed license payload
  name          TEXT,
  -- Entitlements. These are the ONLY things the control plane gates; the
  -- desktop's own offline signed license still governs the desktop itself,
  -- so revoking here can never take a shop offline.
  mobile_access INTEGER NOT NULL DEFAULT 1,
  cross_branch  INTEGER NOT NULL DEFAULT 0,
  max_sites     INTEGER NOT NULL DEFAULT 1,
  max_devices   INTEGER NOT NULL DEFAULT 3,
  suspended     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS sites (
  site_id     TEXT PRIMARY KEY,            -- random 12-hex; also the subdomain
  org_id      TEXT NOT NULL REFERENCES orgs(org_id),
  name        TEXT,                        -- "Main Shop", "Andheri Branch"
  hostname    TEXT NOT NULL UNIQUE,        -- <site_id>.api.zehenapp.com
  tunnel_id   TEXT,                        -- Cloudflare tunnel UUID
  machine_fp  TEXT,                        -- pins a site to one PC
  -- 'provisioning' → tunnel+DNS being created
  -- 'ready'        → DNS verified as publicly resolvable; safe to hand out
  -- 'disabled'     → vendor switched it off
  --
  -- Mobile is only ever given 'ready' hostnames. A client must never query
  -- a hostname before its DNS record exists: some ISP resolvers (Jio, seen
  -- in testing) negative-cache the NXDOMAIN and the shop looks broken for
  -- minutes afterwards. Verify first, hand out second.
  status      TEXT NOT NULL DEFAULT 'provisioning',
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);
CREATE INDEX IF NOT EXISTS sites_org_idx ON sites(org_id);

CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(org_id),
  home_site   TEXT REFERENCES sites(site_id),  -- where it was paired
  -- Only the SHA-256 of the bearer token is stored. A control-plane DB leak
  -- must not yield working device tokens.
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT,                        -- "Rahul's iPhone"
  platform    TEXT,
  -- Revocation is by DEVICE, never by IP. Phones on mobile data sit behind
  -- carrier CGNAT, so an IP block would kick unrelated customers and would
  -- not stick anyway once the phone's address rotates.
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);
CREATE INDEX IF NOT EXISTS devices_org_idx ON devices(org_id);

-- Short-lived codes shown as a QR on the desktop for phone pairing.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code        TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(site_id),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- Read-only snapshot of a site's headline figures, pushed by the desktop so
-- the owner can still SEE the shop when the billing PC is off.
--
-- Deliberately one row per site holding pre-rendered JSON, not a replica of
-- transactional tables. The desktop computes these payloads by calling its
-- OWN report endpoints, so the figures on the phone are produced by exactly
-- the same code (and the same rounding, GST and FIFO logic) as the figures on
-- the desktop. A second implementation of the money math is the one thing
-- this design refuses to have.
CREATE TABLE IF NOT EXISTS snapshots (
  site_id    TEXT PRIMARY KEY REFERENCES sites(site_id),
  org_id     TEXT NOT NULL,
  payload    TEXT NOT NULL,      -- JSON: { generated_at, sections: {...} }
  bytes      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- App accounts: how a person signs in to the mobile app.
--
-- Deliberately separate from the shop's own `users` table. A phone must be
-- able to sign in from anywhere BEFORE it knows which shop it belongs to —
-- that is the whole point of not depending on a QR code or a typed IP. So
-- identity lives here, and `shop_username` maps the account onto the real
-- user in that shop's database once we know which server to talk to.
--
-- The control plane never sees the shop's password. After a successful login
-- it issues a short-lived signed assertion; the shop server verifies that
-- signature and mints its own ordinary JWT. One password for the person, no
-- shared secret between the two systems.
CREATE TABLE IF NOT EXISTS accounts (
  account_id    TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(org_id),
  site_id       TEXT NOT NULL REFERENCES sites(site_id),
  -- Normalised email or phone (lowercased; phones digits-only with country
  -- code) so "+91 98765 43210" and "919876543210" are the same person.
  identifier    TEXT NOT NULL UNIQUE,
  identifier_kind TEXT NOT NULL,            -- 'email' | 'phone'
  password_hash TEXT NOT NULL,              -- pbkdf2$<iterations>$<salt>$<hash>
  shop_username TEXT NOT NULL,              -- the user row in that shop's DB
  label         TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login    INTEGER,
  -- Throttling: a login endpoint reachable from the whole internet needs a
  -- lockout, and it must survive Worker isolate recycling, so it lives here
  -- rather than in memory.
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER
);
CREATE INDEX IF NOT EXISTS accounts_org_idx ON accounts(org_id);

-- ═══ Staff attendance ═══════════════════════════════════════════════
--
-- Staff punch IN/OUT from their own phone's browser (staff.zehenapp.com),
-- so attendance works while the shop PC is still switched off. The desktop
-- is the source of truth for WHO the staff are and HOW strict the checks
-- are; it pushes both here and pulls the punches down whenever it is on.
--
-- Still no business data: names, phone numbers, punch times and (briefly)
-- a selfie. Selfies are deleted as soon as the shop PC has collected them,
-- and collected punches are pruned after 90 days.
--
-- Trust model, in one line: a punch counts because of what THIS service
-- verified itself (passkey signature, the network address the request came
-- from, its own clock). GPS and the selfie are reported by the phone, so
-- they are recorded as evidence for the owner, never treated as proof.

-- One attendance "shop" per (site, company). A single install can serve
-- several companies; each has its own staff list and its own settings.
CREATE TABLE IF NOT EXISTS att_shops (
  shop_code     TEXT PRIMARY KEY,           -- 6 chars, typed or scanned by staff
  site_id       TEXT NOT NULL REFERENCES sites(site_id),
  org_id        TEXT NOT NULL,
  company_id    INTEGER NOT NULL,
  company_name  TEXT,
  settings      TEXT NOT NULL DEFAULT '{}',  -- JSON, owned by the desktop
  enabled       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  UNIQUE (site_id, company_id)
);

CREATE TABLE IF NOT EXISTS att_staff (
  staff_uid       TEXT PRIMARY KEY,
  shop_code       TEXT NOT NULL REFERENCES att_shops(shop_code),
  ext_id          INTEGER NOT NULL,          -- staff_members.staff_id on the desktop
  name            TEXT NOT NULL,
  phone           TEXT,                      -- digits with country code
  pin_hash        TEXT,                      -- pbkdf2$…, computed on the desktop
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- The one phone this person may punch from. Set on first login; cleared
  -- only by the owner ("Reset phone"), which bumps reset_seq on the desktop.
  device_id       TEXT,
  device_bound_at INTEGER,
  reset_seq       INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  last_login      INTEGER,
  updated_at      INTEGER NOT NULL,
  UNIQUE (shop_code, ext_id)
);
CREATE INDEX IF NOT EXISTS att_staff_phone_idx ON att_staff(shop_code, phone);

CREATE TABLE IF NOT EXISTS att_passkeys (
  credential_id TEXT PRIMARY KEY,            -- base64url
  staff_uid     TEXT NOT NULL REFERENCES att_staff(staff_uid),
  public_key    TEXT NOT NULL,               -- JWK JSON
  alg           INTEGER NOT NULL,            -- COSE alg: -7 ES256, -257 RS256, -8 EdDSA
  sign_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used     INTEGER
);
CREATE INDEX IF NOT EXISTS att_passkeys_staff_idx ON att_passkeys(staff_uid);

CREATE TABLE IF NOT EXISTS att_sessions (
  token_hash  TEXT PRIMARY KEY,
  staff_uid   TEXT NOT NULL REFERENCES att_staff(staff_uid),
  device_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS att_sessions_staff_idx ON att_sessions(staff_uid);

-- Single-use, short-lived. A punch is only accepted against a challenge
-- this service issued moments earlier, so nothing can be pre-signed or
-- replayed.
CREATE TABLE IF NOT EXISTS att_challenges (
  challenge   TEXT PRIMARY KEY,              -- base64url, 32 random bytes
  staff_uid   TEXT NOT NULL,
  purpose     TEXT NOT NULL,                 -- 'register' | 'in' | 'out'
  prompt      TEXT,                          -- liveness prompt shown for the selfie
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- The shop's internet address(es), as seen on requests from the shop PC.
-- IPv4 is stored whole; IPv6 as its /64 prefix, which identifies one
-- router. Learned only from the licence-authenticated desktop, never from
-- a staff phone, so a punch cannot vouch for itself.
CREATE TABLE IF NOT EXISTS att_site_ips (
  site_id     TEXT NOT NULL,
  ip_key      TEXT NOT NULL,
  family      INTEGER NOT NULL,              -- 4 | 6
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (site_id, ip_key)
);

CREATE TABLE IF NOT EXISTS att_punches (
  punch_id     TEXT PRIMARY KEY,
  shop_code    TEXT NOT NULL,
  staff_uid    TEXT NOT NULL,
  ext_id       INTEGER NOT NULL,
  kind         TEXT NOT NULL,                -- 'in' | 'out'
  at           INTEGER NOT NULL,             -- THIS service's clock, ms
  ip_key       TEXT,
  ip_family    INTEGER,
  -- 'match'   same network the shop PC reports from
  -- 'pending' shop PC not seen yet today; re-checked when it reports in
  -- 'mismatch' shop PC was online on a different network at that moment
  -- 'off'     Wi-Fi check disabled by the owner
  net_status   TEXT NOT NULL,
  lat          REAL,
  lng          REAL,
  accuracy_m   REAL,
  distance_m   REAL,
  geo_status   TEXT NOT NULL,                -- 'inside' | 'outside' | 'none' | 'off'
  passkey      INTEGER NOT NULL DEFAULT 0,   -- 1 = verified passkey signature
  device_id    TEXT,
  device_shared INTEGER NOT NULL DEFAULT 0,  -- same phone used by another staff member
  prompt       TEXT,
  has_selfie   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  -- NULL = the desktop has not collected (or must re-collect) this row.
  -- Reset to NULL when a pending network check resolves later.
  collected_at INTEGER
);
CREATE INDEX IF NOT EXISTS att_punches_staff_idx ON att_punches(staff_uid, at);
CREATE INDEX IF NOT EXISTS att_punches_shop_idx  ON att_punches(shop_code, collected_at);

-- Kept apart from att_punches so the punch rows stay small; deleted the
-- moment the desktop acknowledges it has the photo.
CREATE TABLE IF NOT EXISTS att_selfies (
  punch_id  TEXT PRIMARY KEY,
  data      TEXT NOT NULL                    -- base64 JPEG, ≤ 200 KB
);

-- What the staff page shows under "My Attendance": computed on the desktop
-- (same code as the owner's register, including corrections) and pushed
-- here, so the phone never works out attendance or pay on its own.
CREATE TABLE IF NOT EXISTS att_views (
  staff_uid   TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
