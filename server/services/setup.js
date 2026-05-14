/**
 * First-run setup service for Billing ERP.
 * ─────────────────────────────────────────
 *
 * Helps the user get from "fresh install" to "working app" without
 * needing to touch psql or pgAdmin. Three steps the wizard drives:
 *
 *   1. Detect — is Postgres installed and reachable on this machine?
 *   2. Connect — try the supplied credentials against `postgres` admin DB.
 *   3. Provision — create the `billing_erp_master` database if missing,
 *      write the resolved settings into a config file the server reads
 *      on next boot, then signal "done".
 *
 * The wizard is reachable WITHOUT the license gate (the gate exempts
 * /api/setup/*) because a brand-new install has no license yet AND no
 * way to authenticate (no admin user yet either).
 *
 * The config file written here lives at:
 *   <homedir>/.billing-erp/config.json
 *
 * The server reads it on startup BEFORE Postgres connect, so a freshly-
 * installed app loads the user-chosen credentials instead of the
 * shipped defaults.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client } = require('pg');
const { execFileSync } = require('child_process');

const CONFIG_DIR  = path.join(os.homedir(), '.billing-erp');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return null;
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * Look for a Postgres install on this machine. We don't try to be
 * clever about it — just a few probes that cover ~99% of Windows
 * installs:
 *
 *   1. PATH lookup for pg_isready / psql
 *   2. Common install dirs ("C:\Program Files\PostgreSQL\<ver>\bin")
 *   3. Service manager check (best-effort; not all builds register)
 *
 * Returns { installed, version, binDir, candidates }.
 */
function detectPostgres() {
  const result = { installed: false, version: null, binDir: null, candidates: [] };

  // First: try invoking psql --version straight from PATH.
  // windowsHide: true prevents a flash of cmd.exe on every probe — without
  // it the customer sees a tiny console window pop and disappear, which
  // looks broken even though it's harmless.
  try {
    const out = execFileSync('psql', ['--version'], { encoding: 'utf8', windowsHide: true });
    const m = /psql\s+\(.*?\)\s+(\d+(\.\d+)*)/i.exec(out);
    if (m) {
      result.installed = true;
      result.version = m[1];
      result.binDir = '<PATH>';
      return result;
    }
  } catch { /* not on PATH */ }

  // Probe common Windows install locations.
  if (process.platform === 'win32') {
    const roots = ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL'];
    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) continue;
        const versions = fs.readdirSync(root)
          .filter(d => /^\d+/.test(d))
          .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
        for (const v of versions) {
          const bin = path.join(root, v, 'bin');
          const psql = path.join(bin, 'psql.exe');
          if (fs.existsSync(psql)) {
            result.candidates.push({ version: v, binDir: bin });
            if (!result.installed) {
              result.installed = true;
              result.version = v;
              result.binDir = bin;
            }
          }
        }
      } catch {}
    }
  } else {
    // *nix: try a few common locations.
    for (const bin of ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/pgsql/bin', '/opt/homebrew/bin']) {
      if (fs.existsSync(path.join(bin, 'psql'))) {
        result.installed = true;
        result.binDir = bin;
        break;
      }
    }
  }

  return result;
}

/**
 * Try to connect to the cluster's `postgres` admin DB with the
 * supplied creds. Returns { ok, error, version }.
 */
async function testConnection({ host, port, user, password }) {
  const client = new Client({
    host:     host || 'localhost',
    port:     Number(port || 5432),
    user:     user || 'postgres',
    password: password || '',
    database: 'postgres',
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const r = await client.query('SELECT version() AS v');
    return { ok: true, version: r.rows[0]?.v || null };
  } catch (e) {
    return { ok: false, error: friendlyPgError(e) };
  } finally {
    try { await client.end(); } catch {}
  }
}

/**
 * Provision the master database if it doesn't exist yet, and persist
 * the credentials so the server picks them up on next boot.
 *
 * Idempotent — re-running after a successful first run is a no-op
 * (the DB already exists, the config is already on disk).
 */
async function provision({ host, port, user, password, masterDbName }) {
  const dbName = masterDbName || 'billing_erp_master';

  // Audit C19 — the marker-file check (isSetupComplete() in setup.js:234)
  // is the primary guard against re-provisioning, but a missing/corrupted
  // <home>/.billing-erp/config.json would let the unauthenticated provision
  // endpoint run again and clobber JWT_SECRET. Defense-in-depth: ALSO
  // probe the master DB; if it has user rows, the install has already
  // been bootstrapped and we refuse to overwrite. Combined with the
  // marker-file guard at the route level, an attacker on the LAN can no
  // longer factory-reset a working install by deleting one file.
  {
    const probeClient = new Client({
      host:     host || 'localhost',
      port:     Number(port || 5432),
      user:     user || 'postgres',
      password: password || '',
      database: 'postgres',
      connectionTimeoutMillis: 5000,
    });
    try {
      await probeClient.connect();
      const exists = await probeClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName],
      );
      if (exists.rows.length > 0) {
        // Master DB exists — check whether it has been bootstrapped
        // (any users row means yes). If yes, refuse to provision again.
        await probeClient.end();
        const masterClient = new Client({
          host:     host || 'localhost',
          port:     Number(port || 5432),
          user:     user || 'postgres',
          password: password || '',
          database: dbName,
          connectionTimeoutMillis: 5000,
        });
        try {
          await masterClient.connect();
          const tableCheck = await masterClient.query(
            `SELECT 1 FROM information_schema.tables WHERE table_name = 'users' LIMIT 1`,
          );
          if (tableCheck.rows.length > 0) {
            const userRows = await masterClient.query('SELECT 1 FROM users LIMIT 1');
            if (userRows.rows.length > 0) {
              throw new Error(
                `Master database "${dbName}" already contains user data. Refusing to re-provision (would clobber JWT_SECRET and orphan all sessions). If this is genuinely a fresh install, drop the database manually first.`,
              );
            }
          }
        } finally {
          try { await masterClient.end(); } catch {}
        }
      }
    } finally {
      try { await probeClient.end(); } catch {}
    }
  }

  const client = new Client({
    host:     host || 'localhost',
    port:     Number(port || 5432),
    user:     user || 'postgres',
    password: password || '',
    database: 'postgres',
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const existing = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName],
    );
    if (existing.rows.length === 0) {
      // Identifier interpolation isn't safe via parameters; the name
      // comes from a config we control, not user input.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    try { await client.end(); } catch {}
  }

  // Generate a per-install JWT secret. Required by jsonwebtoken's
  // sign/verify; without it, every login attempt throws once it
  // gets past credential check ("secretOrPrivateKey must have a
  // value"). Each install gets its own random secret so a token
  // issued on machine A can't be replayed on machine B even by the
  // same user.
  const jwtSecret = require('crypto').randomBytes(32).toString('hex');

  // Persist the resolved creds so the server reads them on boot.
  const cfg = {
    db: {
      host: host || 'localhost',
      port: Number(port || 5432),
      user: user || 'postgres',
      password: password || '',
      master_db_name: dbName,
      // Note: per-company DB name pattern stays `billing_erp_co_<id>`,
      // baked into companyConnections.js.
    },
    jwt_secret: jwtSecret,
    setup_completed_at: new Date().toISOString(),
  };
  saveConfig(cfg);
  return { ok: true, masterDb: dbName };
}

/**
 * Apply the config to the running process's env so the rest of the
 * server picks up the user-chosen creds. Called by server/index.js at
 * the very top — BEFORE any module reads DB env vars.
 */
function applyConfigToEnv() {
  const cfg = loadConfig();
  if (!cfg || !cfg.db) return false;
  // env vars take precedence over config file (so a deploy with custom
  // creds via env still wins).
  if (!process.env.DB_HOST)            process.env.DB_HOST         = cfg.db.host;
  if (!process.env.DB_PORT)            process.env.DB_PORT         = String(cfg.db.port);
  if (!process.env.DB_USER)            process.env.DB_USER         = cfg.db.user;
  if (!process.env.DB_PASSWORD)        process.env.DB_PASSWORD     = cfg.db.password;
  if (!process.env.MASTER_DB_NAME)     process.env.MASTER_DB_NAME  = cfg.db.master_db_name;

  // JWT secret. Treat a missing OR placeholder value as "unset" so a
  // stray .env containing the shipped default (audit B1) does not pin a
  // publicly-known signing key. The literal placeholder strings to
  // refuse are intentionally narrow — a customer who happens to pick
  // "your-super-secret-real-secret" is left alone — but any value
  // matching the historically-shipped templates is rotated to a
  // process-local random 32-byte hex string and persisted to the
  // user's per-machine config so the secret is stable across restarts.
  const isPlaceholder = (s) => {
    if (!s) return true;
    return /your-super-secret-jwt-key-change-in-production|change-me-to-a-long-random-string|change-me|dev-secret-change-me/i.test(s);
  };
  if (isPlaceholder(process.env.JWT_SECRET)) {
    if (cfg.jwt_secret && !isPlaceholder(cfg.jwt_secret)) {
      process.env.JWT_SECRET = cfg.jwt_secret;
    } else {
      const fresh = require('crypto').randomBytes(32).toString('hex');
      process.env.JWT_SECRET = fresh;
      try {
        cfg.jwt_secret = fresh;
        saveConfig(cfg);
      } catch { /* read-only filesystem etc. — env var still set for this run */ }
      // One-line console warning so an operator running `node server/index.js`
      // sees that a fresh secret was minted (helpful when chasing 401s).
      console.warn('[setup] JWT_SECRET was missing or placeholder — generated a fresh per-install secret. All existing JWTs are now invalid; users will need to re-login.');
    }
  }

  return true;
}

function isSetupComplete() {
  const cfg = loadConfig();
  return !!(cfg && cfg.setup_completed_at);
}

// Map common pg connection failures to actionable messages — these
// drive the wizard's "Try again" hints.
function friendlyPgError(err) {
  const m = String(err.message || '');
  if (/ECONNREFUSED/i.test(m))                 return 'Postgres is not running on this host/port. Start the Postgres service.';
  if (/password authentication failed/i.test(m)) return 'Wrong password for that Postgres user.';
  if (/does not exist/i.test(m))               return 'Postgres user does not exist. Use "postgres" or create the user first.';
  if (/getaddrinfo/i.test(m))                  return 'Could not reach that host. Check the hostname / IP.';
  if (/timeout/i.test(m))                      return 'Connection timed out. Check the host/port and firewall.';
  return m;
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  applyConfigToEnv,
  isSetupComplete,
  detectPostgres,
  testConnection,
  provision,
};
