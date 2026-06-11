// ── Embedded PostgreSQL (bundled portable engine) ──────────────────────
//
// Makes the HOST install truly one-click: the shop PC no longer needs a
// separately-installed PostgreSQL. We ship the PG binaries as
// extraResources (resources/pgsql), run `initdb` once into a data dir
// that lives in the user's HOME (~/.zehen/pgdata) — NOT in
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
// The data dir is intentionally the same ~/.zehen the rest of the
// app already uses for config/license/uploads, and electron-builder is
// configured with deleteAppDataOnUninstall:false, so the database
// survives uninstall → reinstall.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFileSync, execFile } = require('child_process');

const HOME_DIR    = path.join(os.homedir(), '.zehen');
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

// Async poll until postgres accepts TCP connections — used instead of
// pg_ctl -w so the event loop stays free during the (potentially long)
// postgres startup (Windows Defender scanning binaries can delay this
// 30-75 s on some machines).
function waitForPort(port, totalMs = 90000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function attempt() {
      portBusy(port, 500).then((ready) => {
        if (ready) return resolve(true);
        if (Date.now() - start >= totalMs) return resolve(false);
        setTimeout(attempt, 300);
      });
    }
    attempt();
  });
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

// Merge our connection creds into ~/.zehen/config.json in the exact
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
    master_db_name: (cfg.db && cfg.db.master_db_name) || 'zehen_master',
  };
  if (!cfg.jwt_secret) {
    cfg.jwt_secret = require('crypto').randomBytes(32).toString('hex');
  }
  if (!cfg.setup_completed_at) cfg.setup_completed_at = new Date().toISOString();
  cfg.embedded_pg = true;
  writeJson(CONFIG_FILE, cfg);
}

// The server's default Sequelize connection targets
// `process.env.DB_NAME` (|| 'zehen'). companyBootstrap creates
// zehen_master and the per-company DBs, but NOT this base DB — on
// a brand-new cluster it's absent and server/index.js treats that as a
// FATAL "database zehen does not exist" and never starts (the app
// then won't open). Create it idempotently here, before the server
// boots. Best-effort: failure just falls through to the server's own
// error path / manual flow.
function ensureDefaultDatabase(port, password) {
  const dbName = process.env.DB_NAME || 'zehen';
  const env = { ...pgEnv(), PGPASSWORD: password };
  const base = ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-w'];
  const psql = path.join(binDir, 'psql.exe');
  try {
    const out = execFileSync(psql,
      [...base, '-tAc', `SELECT 1 FROM pg_database WHERE datname='${dbName}'`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env, windowsHide: true },
    ).toString().trim();
    if (out === '1') { log(`default database "${dbName}" already present`); return; }
    execFileSync(psql,
      [...base, '-c', `CREATE DATABASE "${dbName}"`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, env, windowsHide: true },
    );
    log(`created default database "${dbName}"`);
  } catch (e) {
    warn(`ensureDefaultDatabase("${dbName}") failed (continuing):`, (e && e.message) || e);
  }
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

    // ── Fast path ──────────────────────────────────────────────────────
    // If postgres is already accepting connections (i.e. the app was
    // reopened without a Windows reboot), skip pg_ctl entirely and return
    // in under a second. This avoids Windows Defender re-scanning
    // pg_ctl.exe + postgres.exe on every launch, which costs 30-75 s.
    if (await portBusy(port, 800)) {
      log(`port ${port} already accepting connections — skipping pg_ctl`);
      process.env.DB_HOST = '127.0.0.1';
      process.env.DB_PORT = String(port);
      process.env.DB_USER = 'postgres';
      process.env.DB_PASSWORD = password;
      try { writeAppConfig(port, password); } catch (e) { warn('writeAppConfig:', e.message); }
      return { used: true, port };
    }

    // Start postgres without -w so pg_ctl exits immediately after forking
    // the postgres process. Previously we used execFileSync with -w -t 60,
    // which blocked the Electron main-process event loop for the entire
    // postgres startup (30-75 s on machines where Windows Defender scans
    // the binaries). With execFile (async) the event loop stays free:
    // IPC from the renderer can fire, so the loading-screen window appears
    // while postgres boots in the background.
    await new Promise((resolve) => {
      execFile(
        path.join(binDir, 'pg_ctl.exe'),
        ['-D', DATA_DIR, '-l', PG_LOG, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, 'start'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, env: pgEnv(), windowsHide: true },
        () => resolve() // always resolve — readiness confirmed via TCP below
      );
    });

    // Poll until postgres accepts TCP connections (up to 90 s).
    log('waiting for postgres on port', port, '…');
    const ready = await waitForPort(port, 90000);
    if (!ready) {
      warn('postgres did not become ready within 90 s — see', PG_LOG);
      if (!isRunning()) return { used: false, reason: 'start-failed' };
      log('pg_ctl status confirms running despite TCP poll timeout');
    }

    // companyBootstrap makes zehen_master + per-company DBs, but
    // not the server's base DB — create it now or the server hard-fails
    // on a fresh cluster ("database zehen does not exist").
    ensureDefaultDatabase(port, password);

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
