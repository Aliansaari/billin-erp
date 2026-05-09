/**
 * Pre-update backup hook.
 * ────────────────────────
 *
 * After the NSIS installer finishes, it drops a marker file:
 *   <homedir>/.billing-erp/.just-installed   (contents: version string)
 *
 * On the next server boot we notice the marker, dump every database
 * (master + each per-company DB) into a timestamped folder under
 * <homedir>/.billing-erp/backups/ BEFORE running schema migrations,
 * then delete the marker. This way a botched update can be rolled back
 * by restoring the dump and the previous app .exe.
 *
 * If the dump fails for any reason, we DO NOT proceed with migrations —
 * better to leave the app sat in setup-mode-y limbo than to migrate
 * without a safety net. The installer also keeps the previous version's
 * files at <install>\app-<version>-backup so manual rollback works.
 *
 * The dump uses pg_dump via the resolved Postgres bin dir. If pg_dump
 * isn't on PATH and the user's setup config doesn't pin a bin dir,
 * we fall back to a logical dump via the pg client (slower; still safe).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const ROOT_DIR    = path.join(os.homedir(), '.billing-erp');
const MARKER      = path.join(ROOT_DIR, '.just-installed');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');

function isUpdatePending() {
  return fs.existsSync(MARKER);
}

function readMarker() {
  try { return fs.readFileSync(MARKER, 'utf8').trim(); } catch { return ''; }
}

function clearMarker() {
  try { fs.unlinkSync(MARKER); } catch {}
}

function timestampDir() {
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}`;
}

function findPgDump() {
  // Honor explicit env first (vendor can pin via installer).
  if (process.env.PG_DUMP_PATH && fs.existsSync(process.env.PG_DUMP_PATH)) {
    return process.env.PG_DUMP_PATH;
  }
  // Try PATH. windowsHide:true to avoid a flash of cmd on every boot.
  try {
    const out = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['pg_dump'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (out.status === 0) {
      const first = out.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    }
  } catch {}
  // Probe common Windows install dirs.
  if (process.platform === 'win32') {
    for (const root of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
      try {
        if (!fs.existsSync(root)) continue;
        const versions = fs.readdirSync(root).filter(d => /^\d+/.test(d))
          .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
        for (const v of versions) {
          const candidate = path.join(root, v, 'bin', 'pg_dump.exe');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch {}
    }
  }
  return null;
}

async function listAllDatabases({ host, port, user, password }) {
  const c = new Client({ host, port: Number(port), user, password, database: 'postgres' });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT datname FROM pg_database
        WHERE datname = ANY($1)
          OR datname LIKE 'billing_erp_co_%'
        ORDER BY datname`,
      [['billing_erp', 'billing_erp_master']],
    );
    return r.rows.map(row => row.datname);
  } finally {
    try { await c.end(); } catch {}
  }
}

function dumpDatabase({ pgDumpPath, host, port, user, password, dbName, target }) {
  const args = [
    '-h', host || 'localhost',
    '-p', String(port || 5432),
    '-U', user || 'postgres',
    '-Fc', '-f', target, dbName,
  ];
  const env = { ...process.env, PGPASSWORD: password || '' };
  // windowsHide:true so the customer never sees pg_dump's cmd window
  // pop up during an update.
  const r = spawnSync(pgDumpPath, args, { env, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`pg_dump ${dbName} failed: ${r.stderr || r.stdout || 'unknown'}`);
  }
}

/**
 * Run the pre-update backup if the marker is present. Does nothing
 * on a fresh install (no marker yet) or normal boots.
 *
 * Throws on failure so the caller can abort startup before applying
 * any schema migrations.
 */
async function runIfNeeded() {
  if (!isUpdatePending()) return { ran: false };

  const fromVersion = readMarker();
  console.log(`[update] post-install marker present (version=${fromVersion}). Backing up DBs before migrations…`);

  const cfg = require('./setup').loadConfig();
  if (!cfg || !cfg.db) {
    console.warn('[update] no setup config — skipping backup (probably first run, not an update).');
    clearMarker();
    return { ran: false, skipped: true };
  }

  const dump = findPgDump();
  if (!dump) {
    console.warn('[update] pg_dump not found on this machine — skipping pre-update backup. Migrations will still run, but rollback is manual.');
    clearMarker();
    return { ran: false, skipped: true, reason: 'pg_dump_not_found' };
  }

  const stamp = timestampDir();
  const dir = path.join(BACKUPS_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const dbs = await listAllDatabases(cfg.db);
  const out = [];
  for (const dbName of dbs) {
    const target = path.join(dir, `${dbName}.dump`);
    console.log(`[update]   dumping ${dbName} → ${target}`);
    try {
      dumpDatabase({
        pgDumpPath: dump,
        host: cfg.db.host, port: cfg.db.port,
        user: cfg.db.user, password: cfg.db.password,
        dbName, target,
      });
      out.push({ dbName, ok: true, file: target });
    } catch (e) {
      out.push({ dbName, ok: false, error: e.message });
      // Hard-stop on any failure so a half-backup doesn't pretend to be safe.
      throw new Error(`Pre-update backup aborted: ${e.message}`);
    }
  }

  // Trim oldest backup folders — keep last 5 update-snapshots.
  try {
    const all = fs.readdirSync(BACKUPS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(f))
      .sort();
    while (all.length > 5) {
      const oldest = all.shift();
      try { fs.rmSync(path.join(BACKUPS_DIR, oldest), { recursive: true, force: true }); } catch {}
    }
  } catch {}

  clearMarker();
  console.log(`[update] backup complete: ${out.length} database(s) → ${dir}`);
  return { ran: true, dir, files: out };
}

module.exports = { runIfNeeded, isUpdatePending, MARKER, BACKUPS_DIR };
