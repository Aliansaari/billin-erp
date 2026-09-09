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
