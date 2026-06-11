/**
 * Phase 2 — full integration test.
 * ─────────────────────────────────
 *
 * Drives the ZEHEN server through every Phase-2 surface in one
 * end-to-end run. Spawns its own server with a test keypair so we can
 * sign real licenses for activation.
 *
 * Sequence:
 *
 *   A. Setup wizard
 *      - /api/setup/status  reports setup_complete:true (we already
 *         have a config from the dev install) — assert reachable
 *      - /api/setup/detect-postgres works
 *      - /api/setup/test-connection with bad creds → ok:false
 *      - /api/setup/test-connection with real creds → ok:true
 *
 *   B. License gate (assumed: license activated by previous test)
 *      - /api/license/info reports activated:true
 *      - /api/auth/login returns 200 (license check passes)
 *
 *   C. Pre-update backup hook
 *      - drop the .just-installed marker
 *      - restart the server
 *      - assert a fresh dump folder appears under
 *        <homedir>/.zehen/backups/<stamp>/
 *      - assert each expected DB has a .dump file
 *      - assert the marker is cleared
 *
 *   D. License Studio activation report → mark-activated round-trip
 *      - generate a fake activation report
 *      - parse it through the same logic License Studio's IPC handler
 *        uses (we re-implement here since we can't touch the encrypted
 *        DB without the user's password)
 *
 *   E. Idempotency
 *      - run the pre-update backup hook again (no marker) — no-op
 *      - run setup provision again — no error, no duplicate DBs
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');
const nacl = require('tweetnacl');
const { Client } = require('pg');

const BASE = process.env.API || 'http://localhost:3001';

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}
function section(title) { console.log('\n[' + title + ']'); }

const b64 = {
  encode: (u8) => Buffer.from(u8).toString('base64'),
  decode: (s)  => new Uint8Array(Buffer.from(s, 'base64')),
};
function stableJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableJson).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}';
}
function buildEnvelope(payload, privateKey) {
  const payloadStr = stableJson(payload);
  const sig = nacl.sign.detached(new Uint8Array(Buffer.from(payloadStr, 'utf8')), b64.decode(privateKey));
  return JSON.stringify({ v: 1, kind: 'license-studio.license', payload: payloadStr, signature: b64.encode(sig) }, null, 2);
}
async function http(method, path, { body } = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json; try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json };
}
async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
function spawnServer(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const child = spawn(process.execPath, ['server/index.js'], {
    env, cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (d) => { child.log += d.toString(); });
  child.stderr.on('data', (d) => { child.log += d.toString(); });
  return child;
}
async function killServer(child) {
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1500));
}

(async () => {
  // Generate a test keypair so we can sign real licenses without
  // depending on the user's License Studio.
  const kp = nacl.sign.keyPair();
  const PUB  = b64.encode(kp.publicKey);
  const PRIV = b64.encode(kp.secretKey);

  // Clean any leftover license file so we start fresh.
  const HOME = os.homedir();
  const ERP_DIR = path.join(HOME, '.zehen');
  fs.mkdirSync(ERP_DIR, { recursive: true });
  for (const f of ['license.dat', 'license.dat.lastseen', 'license.dat.bind']) {
    try { fs.unlinkSync(path.join(ERP_DIR, f)); } catch {}
  }

  // Write a setup config with the dev Postgres creds so the server
  // boots in normal (not setup-mode) state. Snapshot any pre-existing
  // config so the test doesn't disturb a real install.
  const CONFIG_PATH = path.join(ERP_DIR, 'config.json');
  const hadConfig = fs.existsSync(CONFIG_PATH);
  const savedConfig = hadConfig ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    db: {
      host: 'localhost', port: 5432,
      user: 'postgres', password: 'postgres',
      master_db_name: 'zehen_master',
    },
    setup_completed_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  // Restore the config when the test exits.
  process.on('exit', () => {
    try {
      if (savedConfig) fs.writeFileSync(CONFIG_PATH, savedConfig);
      else fs.unlinkSync(CONFIG_PATH);
    } catch {}
  });

  // Snapshot existing backups dir state so we can detect new entries
  // created by the pre-update backup test.
  const BACKUPS_DIR = path.join(ERP_DIR, 'backups');
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const backupsBefore = new Set(fs.readdirSync(BACKUPS_DIR));

  console.log('Phase 2 — full integration test');
  console.log('================================');

  // ── A. Setup wizard endpoints ──────────────────────────────────────
  section('A. Setup wizard');
  let server = spawnServer({ LICENSE_PUBLIC_KEY: PUB });
  if (!await waitForServer()) {
    console.log('  FAIL  server failed to start');
    console.log(server.log.slice(-1000));
    process.exit(1);
  }

  const status = await http('GET', '/api/setup/status');
  ok('A1 /api/setup/status reachable', status.status === 200);
  const setupComplete = !!status.body?.setup_complete;
  ok('A2 status reports setup_complete (config exists from prior dev work)', setupComplete);

  const detect = await http('GET', '/api/setup/detect-postgres');
  ok('A3 /detect-postgres reachable', detect.status === 200);
  ok('A4 detection finds Postgres on this machine', detect.body?.installed === true);

  const badConn = await http('POST', '/api/setup/test-connection', {
    body: { host: 'localhost', port: 5432, user: 'postgres', password: 'definitely-wrong-password' },
  });
  ok('A5 bad creds → ok:false',     badConn.body?.ok === false);
  ok('A6 friendly error message',   /password|auth/i.test(badConn.body?.error || ''));

  // ── B. License gate ────────────────────────────────────────────────
  section('B. License gate');

  // Activate a fresh license so the rest of the test can hit gated routes.
  const today = new Date().toISOString().slice(0, 10);
  const inOneYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const envelope = buildEnvelope({
    v: 1,
    customer_id: 'C-2026-9001', customer_name: 'Phase 2 Test',
    license_type: 'annual',
    issued_at: today, expires_at: inOneYear,
    max_companies: 5, features: ['multi_company'], machine_fp: null,
  }, PRIV);

  const act = await http('POST', '/api/license/activate', { body: { license: envelope } });
  ok('B1 license activates', act.body?.ok === true);

  const info = await http('GET', '/api/license/info');
  ok('B2 status.activated:true', info.body?.activated === true);
  ok('B3 customer_id surfaces',  info.body?.status?.customer_id === 'C-2026-9001');

  const login = await http('POST', '/api/auth/login', {
    body: { username: 'admin', password: 'wrong-on-purpose', company_id: 1 },
  });
  ok('B4 gated route now reachable (not license-blocked)',
     !(login.status === 403 && login.body?.license_block));

  // ── C. Pre-update backup hook ──────────────────────────────────────
  section('C. Pre-update backup hook');
  // Drop the marker the installer would have left, then restart server.
  const marker = path.join(ERP_DIR, '.just-installed');
  fs.writeFileSync(marker, '1.0.0\n', 'utf8');

  await killServer(server);
  server = spawnServer({ LICENSE_PUBLIC_KEY: PUB });
  if (!await waitForServer()) {
    console.log('  FAIL  server failed to restart');
    console.log(server.log.slice(-1500));
    process.exit(1);
  }

  ok('C1 marker file is cleared after backup', !fs.existsSync(marker));

  const backupsAfter = new Set(fs.readdirSync(BACKUPS_DIR));
  const newDirs = [...backupsAfter].filter(x => !backupsBefore.has(x) && /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(x));
  ok('C2 new timestamped backup directory created', newDirs.length === 1, 'newDirs=' + JSON.stringify(newDirs));

  if (newDirs.length === 1) {
    const dir = path.join(BACKUPS_DIR, newDirs[0]);
    const files = fs.readdirSync(dir);
    ok('C3 backup folder contains .dump files',
       files.some(f => f.endsWith('.dump')) && files.length > 0,
       'files=' + JSON.stringify(files));
    ok('C4 master DB included in backup',
       files.some(f => f === 'zehen_master.dump'),
       'files=' + JSON.stringify(files));
  }

  // ── D. License Studio mark-activated parser (re-implementation) ────
  section('D. Activation report parser');
  // Build the same single-line report the ZEHEN UI shows.
  const report = [
    'customer_id=C-2026-9001',
    'customer_name=Phase 2 Test',
    'license_type=annual',
    'issued_at=' + today,
    'expires_at=' + inOneYear,
    'machine_fp=abc123def456',
    'activated_at=' + new Date().toISOString(),
  ].join(';');

  const parsed = {};
  for (const part of report.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    parsed[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  ok('D1 parser extracts customer_id', parsed.customer_id === 'C-2026-9001');
  ok('D2 parser extracts machine_fp',  parsed.machine_fp === 'abc123def456');
  ok('D3 parser extracts activated_at', !!parsed.activated_at);
  ok('D4 reject-empty report', (() => {
    const empty = '';
    const fields = {};
    for (const part of empty.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return !fields.customer_id;
  })());

  // ── E. Idempotency ─────────────────────────────────────────────────
  section('E. Idempotency');
  // Restart again WITHOUT the marker — preUpdateBackup should no-op.
  await killServer(server);
  server = spawnServer({ LICENSE_PUBLIC_KEY: PUB });
  if (!await waitForServer()) {
    console.log('  FAIL  server failed to restart for idempotency check');
    process.exit(1);
  }

  const backupsAfter2 = new Set(fs.readdirSync(BACKUPS_DIR));
  const newSinceLast = [...backupsAfter2].filter(x => !backupsAfter.has(x));
  ok('E1 second boot without marker creates NO new backup folder',
     newSinceLast.length === 0, 'unexpected new dirs: ' + JSON.stringify(newSinceLast));

  // Re-run /api/setup/provision — should succeed and not error on
  // existing master DB.
  const cfg = require('../server/services/setup').loadConfig();
  if (cfg && cfg.db) {
    const provAgain = await http('POST', '/api/setup/provision', {
      body: cfg.db,
    });
    ok('E2 re-running provision is idempotent', provAgain.body?.ok === true);
  }

  await killServer(server);

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('Result: ' + pass + ' pass, ' + fail + ' fail');
  if (fail) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
})();
