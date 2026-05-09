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
