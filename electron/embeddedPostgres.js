// ── Embedded PostgreSQL (bundled portable engine) ──────────────────────
//
// Makes the HOST install truly one-click: the shop PC no longer needs a
// separately-installed PostgreSQL. We ship the PG binaries as
// extraResources (resources/pgsql), run `initdb` once into a data dir
// that lives in the user's HOME (~/.billing-erp/pgdata) — NOT in
// Program Files — so an uninstall/reinstall keeps every bill and ledger.
// The app starts/stops this private postgres as it opens/quits.
//
// Design rules:
//   • Localhost only. LAN clients talk to the host's HTTP API (:3001),
//     never to Postgres directly, so the DB never needs to be exposed.
//   • Never throw. If anything fails (no binaries, initdb error, port
//     trouble) we log and return {used:false}; boot continues and the
//     existing manual "Postgres Setup" wizard still works. We never ship
//     something worse than before.
//   • Dev (not packaged) and CLIENT_MODE builds skip this entirely.
//
// The data dir is intentionally the same ~/.billing-erp the rest of the
// app already uses for config/license/uploads, and electron-builder is
// configured with deleteAppDataOnUninstall:false, so the database
// survives uninstall → reinstall.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFileSync } = require('child_process');

const HOME_DIR    = path.join(os.homedir(), '.billing-erp');
const DATA_DIR    = path.join(HOME_DIR, 'pgdata');
const STATE_FILE  = path.join(HOME_DIR, 'embedded-pg.json');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
const PG_LOG      = path.join(HOME_DIR, 'pg.log');

let binDir = null; // resolved at start; reused by stop().

function log(...a)  { try { console.log('[embedded-pg]', ...a); } catch {} }
function warn(...a) { try { console.warn('[embedded-pg]', ...a); } catch {} }

function resolveBinDir() {
  // Packaged: electron-builder extraResources {from:'vendor/pgsql', to:'pgsql'}
  const p = path.join(process.resourcesPath || '', 'pgsql', 'bin');
  return fs.existsSync(path.join(p, 'pg_ctl.exe')) ? p : null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// Is a TCP port already accepting connections on 127.0.0.1?
function portBusy(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (busy) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(busy); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error',   () => fin(false));
    s.connect(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  const candidates = [preferred, 5433, 5434, 5435, 5436, 5437, 5438].filter(Boolean);
  for (const p of candidates) {
    // If our own data dir is already running here we'd want to reuse it,
    // but pg_ctl start is idempotent enough; just avoid colliding with a
    // foreign service. Treat a busy port as "skip" unless it's our saved
    // one (then we reuse and let pg_ctl status sort it out).
    if (p === preferred) return p;
    if (!(await portBusy(p))) return p;
  }
  return preferred || 5433;
}

function pgEnv() {
  // Keep PG's own env clean & deterministic.
  return { ...process.env, PGCLIENTENCODING: 'UTF8', TZ: process.env.TZ || 'UTC' };
}

function runPg(exe, args, opts = {}) {
  return execFileSync(path.join(binDir, exe), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || 60000,
    env: pgEnv(),
    windowsHide: true,
  });
}

function dataDirInitialised() {
  return fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));
}

function initdb(password) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const pwFile = path.join(HOME_DIR, '.pg_init_pw.tmp');
  fs.writeFileSync(pwFile, password, 'utf8');
  try {
    runPg('initdb.exe', [
      '-D', DATA_DIR,
      '-U', 'postgres',
      '-A', 'scram-sha-256',
      '--pwfile', pwFile,
      '-E', 'UTF8',
      '--no-instructions',
    ], { timeoutMs: 120000 });
  } finally {
    try { fs.unlinkSync(pwFile); } catch {}
  }
}

function pgCtl(action, extraArgs = [], timeoutMs = 60000) {
  return runPg('pg_ctl.exe', ['-D', DATA_DIR, ...extraArgs, action], { timeoutMs });
}

function isRunning() {
  try { pgCtl('status', [], 8000); return true; }
  catch (e) {
    // pg_ctl status exits non-zero when not running — that's expected.
    return false;
  }
}

// Merge our connection creds into ~/.billing-erp/config.json in the exact
// shape setup.js expects, so applyConfigToEnv() stays consistent AND the
// first-run "Postgres Setup" wizard is skipped (setup_completed_at set).
// Never clobber an existing jwt_secret.
function writeAppConfig(port, password) {
  const cfg = readJson(CONFIG_FILE) || {};
  cfg.db = {
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password,
    master_db_name: (cfg.db && cfg.db.master_db_name) || 'billing_erp_master',
  };
  if (!cfg.jwt_secret) {
    cfg.jwt_secret = require('crypto').randomBytes(32).toString('hex');
  }
  if (!cfg.setup_completed_at) cfg.setup_completed_at = new Date().toISOString();
  cfg.embedded_pg = true;
  writeJson(CONFIG_FILE, cfg);
}

/**
 * Start the bundled Postgres. Returns { used:boolean, port?, reason? }.
 * NEVER throws — a false result just means "fall back to manual setup".
 */
async function startEmbeddedPostgres({ clientMode } = {}) {
  try {
    if (!app.isPackaged) return { used: false, reason: 'dev' };
    if (clientMode)      return { used: false, reason: 'client' };

    binDir = resolveBinDir();
    if (!binDir) { warn('bundled binaries not found — manual Postgres setup remains available'); return { used: false, reason: 'no-binaries' }; }

    fs.mkdirSync(HOME_DIR, { recursive: true });
    const state = readJson(STATE_FILE) || {};
    let password = state.password;
    let port     = state.port;

    if (!dataDirInitialised()) {
      // Fresh install (or post-uninstall with a wiped data dir): create
      // the cluster. A pre-existing pgdata (reinstall) is reused as-is —
      // this is what preserves data across uninstall/reinstall.
      password = require('crypto').randomBytes(18).toString('hex');
      log('initialising new database cluster at', DATA_DIR);
      initdb(password);
      port = await pickPort(port || 5433);
      writeJson(STATE_FILE, { port, password });
    } else {
      // Existing cluster from a previous install. Creds must come from
      // the saved state; if it's missing we cannot authenticate, so bail
      // to the manual flow rather than risk a broken loop.
      if (!password || !port) {
        warn('existing pgdata but no saved creds — deferring to manual setup');
        return { used: false, reason: 'state-missing' };
      }
      log('reusing existing database cluster at', DATA_DIR);
    }

    // Start (idempotent: pg_ctl handles a stale postmaster.pid). -w waits
    // for "ready to accept connections".
    try {
      pgCtl('start', [
        '-w', '-t', '60',
        '-l', PG_LOG,
        '-o', `-p ${port} -c listen_addresses=127.0.0.1`,
      ], 75000);
    } catch (e) {
      // Could be "already running" (fine) or a real failure. Probe.
      if (!isRunning()) {
        warn('pg_ctl start failed:', (e && e.message) || e, '— see', PG_LOG);
        return { used: false, reason: 'start-failed' };
      }
      log('postgres already running');
    }

    // Wire creds into env BEFORE the server boots, and persist so the
    // setup wizard is skipped and applyConfigToEnv() agrees.
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(port);
    process.env.DB_USER = 'postgres';
    process.env.DB_PASSWORD = password;
    try { writeAppConfig(port, password); } catch (e) { warn('writeAppConfig:', e.message); }

    log(`ready on 127.0.0.1:${port} (data: ${DATA_DIR})`);
    return { used: true, port };
  } catch (e) {
    warn('unexpected failure — falling back to manual setup:', (e && e.stack) || e);
    return { used: false, reason: 'exception' };
  }
}

/** Stop the bundled Postgres cleanly (fast shutdown). Best-effort. */
function stopEmbeddedPostgres() {
  try {
    if (!binDir || !dataDirInitialised()) return;
    log('stopping postgres (fast)…');
    pgCtl('stop', ['-m', 'fast', '-w', '-t', '30'], 35000);
  } catch (e) {
    // If it wasn't running / already stopped, that's fine.
    warn('stop (non-fatal):', (e && e.message) || e);
  }
}

module.exports = { startEmbeddedPostgres, stopEmbeddedPostgres };
