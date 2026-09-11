// ── ZEHEN headless server (Windows service entry) ──────────────────────
//
// This file is what the "always-on server" Windows service runs. It is
// launched by the bundled ZEHEN.exe in Node mode:
//
//     ZEHEN.exe  (with ELECTRON_RUN_AS_NODE=1)  electron/service-headless.js
//
// i.e. the SAME binary the app already ships, but with no window and no
// Chromium — just the Node runtime. That means we don't have to bundle a
// second Node.exe, and asar/require resolution behaves exactly as it does
// for electron/main.js.
//
// Responsibilities (in order):
//   1. Redirect all "home dir" lookups to the SHOP OWNER's profile, so the
//      service (which runs as LocalSystem, whose own profile is empty)
//      reads the real database at C:\Users\<owner>\.zehen — NOT a fresh
//      empty one. The service installer sets USERPROFILE for us; we assert
//      it here and fail loudly if it's wrong, rather than silently spin up
//      an empty database.
//   2. Start the bundled Postgres (serviceMode → bypasses the dev gate).
//   3. Boot the existing API server (server/index.js), which listens on
//      0.0.0.0:3001 exactly as it does inside the app today.
//
// SAFETY: this never runs initdb against the wrong folder. If the resolved
// home doesn't already contain a database cluster AND no owner profile was
// injected, it refuses to start (exit 4) so a misconfigured service can
// never create a second, empty set of books next to the real one.

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// ── 1. Resolve + verify the data home ────────────────────────────────────
// os.homedir() on Windows honours the USERPROFILE env var (libuv), so the
// installer pins USERPROFILE to the owner's profile and every module in the
// codebase — embeddedPostgres, setup.js, backups — lands on the same folder
// without any per-file path plumbing.
const HOME_DIR = path.join(os.homedir(), '.zehen');
const PGDATA   = path.join(HOME_DIR, 'pgdata');
const LOG_PATH = path.join(HOME_DIR, 'service.log');

// ── File logging (LocalSystem has no console anyone can see) ──────────────
let logStream = null;
(function setupLogging() {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    // Trim to the last ~500 KB if the log has grown past 1 MB.
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1_000_000) {
        const tail = fs.readFileSync(LOG_PATH, 'utf8').slice(-500_000);
        fs.writeFileSync(LOG_PATH, tail);
      }
    } catch { /* non-fatal */ }
    logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    const stamp = () => new Date().toISOString();
    const tee = (orig, level) => (...args) => {
      try {
        const line = `[${stamp()}][${level}] ` + args.map(a =>
          typeof a === 'string' ? a : (a && a.stack ? a.stack : JSON.stringify(a))
        ).join(' ') + '\n';
        if (logStream) logStream.write(line);
      } catch { /* never crash on logging */ }
      try { orig.apply(console, args); } catch {}
    };
    console.log   = tee(console.log,   'log');
    console.info  = tee(console.info,  'info');
    console.warn  = tee(console.warn,  'warn');
    console.error = tee(console.error, 'error');
  } catch { /* if logging can't init, continue with plain console */ }
})();

// Log but DON'T force-exit on these — mirrors electron/main.js so a single
// transient error doesn't drop the whole shop offline in a restart loop.
// Request-level errors are handled inside the Express app.
process.on('uncaughtException',  (err) => console.error('[service][uncaughtException]', err && err.stack || err));
process.on('unhandledRejection', (err) => console.error('[service][unhandledRejection]', err && err.stack || err));

async function main() {
  console.log('──────────────────────────────────────────────');
  console.log(`[service] ZEHEN server service starting`);
  console.log(`[service] home      = ${HOME_DIR}`);
  console.log(`[service] USERPROFILE= ${process.env.USERPROFILE || '(unset)'}`);
  console.log(`[service] pgdata     = ${PGDATA}`);

  // ── Guard: never create a second, empty database by mistake ────────────
  // If there's no existing cluster here, the ONLY safe reason to proceed is
  // a genuine brand-new server install. We detect that via an explicit
  // opt-in file the installer drops (.service-fresh-ok). Absent both the
  // cluster and that flag, we bail loudly instead of running initdb into a
  // possibly-wrong home.
  const clusterExists = fs.existsSync(path.join(PGDATA, 'PG_VERSION'));
  const freshOk       = fs.existsSync(path.join(HOME_DIR, '.service-fresh-ok'));
  if (!clusterExists && !freshOk) {
    console.error('[service] REFUSING TO START: no database found at', PGDATA,
      'and no fresh-install flag. This usually means USERPROFILE is not pointing',
      'at the shop owner\'s profile. Fix the service configuration — NOT starting',
      'so we never create an empty second database beside the real one.');
    process.exit(4);
  }

  // ── 2. Start the bundled Postgres ──────────────────────────────────────
  const { startEmbeddedPostgres } = require('./embeddedPostgres');
  let pg;
  try {
    pg = await startEmbeddedPostgres({ serviceMode: true });
  } catch (e) {
    console.error('[service] startEmbeddedPostgres threw:', e && e.stack || e);
    process.exit(2);
  }
  console.log('[service] embedded postgres result:', JSON.stringify(pg));

  if (!pg || pg.used !== true) {
    if (pg && pg.reason === 'port-conflict') {
      // A DIFFERENT Postgres holds the port — starting the API would just
      // authenticate-fail. Exit with a distinct code the installer/logs can
      // spot; the service manager will retry after its restart delay.
      console.error('[service] database port conflict — not booting API:', pg.message);
      process.exit(3);
    }
    console.error('[service] embedded postgres unavailable (reason:',
      (pg && pg.reason) || 'unknown', ') — cannot serve. Exiting for restart.');
    process.exit(2);
  }

  // ── 3. Boot the existing API server ────────────────────────────────────
  // server/index.js reads DB_* from the env we just set (embeddedPostgres
  // exported the creds into process.env) and calls app.listen(3001,'0.0.0.0').
  // Requiring it here is exactly what the app's bootstrapServer() does.
  console.log('[service] booting API server (server/index.js)…');
  require('../server/index.js');
  console.log('[service] API server module loaded — app.listen will bind shortly.');
  // Keep the process alive; the HTTP server's listener holds the event loop.
}

main().catch((e) => {
  console.error('[service] fatal during startup:', e && e.stack || e);
  process.exit(1);
});
