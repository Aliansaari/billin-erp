/**
 * Company-system bootstrap
 * ────────────────────────
 *
 * Runs at server start, BEFORE the regular sequelize sync. Idempotent:
 * safe to run on every boot, on fresh installs, on legacy single-DB
 * installs, and on already-migrated multi-company installs.
 *
 * Three things happen here:
 *
 *   1. Ensure the master Postgres database (zehen_master) exists.
 *      We connect to the default `postgres` admin DB to issue a
 *      CREATE DATABASE if missing. Same credentials as the app — if
 *      the user can connect to zehen, they can create new DBs.
 *
 *   2. Sync the master schema (companies table, dev_max_companies
 *      column on a master_settings table later, audit log).
 *
 *   3. If the companies table is empty AND a legacy `zehen`
 *      database has data, register it as the primary company. No
 *      data is moved — we just record the mapping.
 *
 * Failures here are FATAL — without the master DB the app can't tell
 * which company a user belongs to. The boot path logs and exits with
 * a clear message rather than starting up half-broken.
 */

const { Client } = require('pg');
const masterSequelize = require('../config/masterDatabase');
const Company = require('../models/Company');

const MASTER_DB_NAME = process.env.MASTER_DB_NAME || 'zehen_master';
const PRIMARY_DB_NAME = process.env.DB_NAME || 'zehen';
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || 5432;
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';

/**
 * Connect to the cluster-level admin DB (`postgres`) so we can issue
 * CREATE DATABASE for the master DB without an existing connection
 * to it. Same credentials as the rest of the app.
 */
async function withAdminClient(fn) {
  const client = new Client({
    host: DB_HOST, port: DB_PORT,
    user: DB_USER, password: DB_PASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureMasterDatabaseExists() {
  await withAdminClient(async (client) => {
    const r = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [MASTER_DB_NAME],
    );
    if (r.rows.length === 0) {
      // Identifier interpolation isn't safe via parameters — pg-format
      // would be cleanest but adding a dependency for one CREATE is
      // overkill. The DB name comes from env / a constant, not user
      // input, so concatenation is fine here.
      await client.query(`CREATE DATABASE "${MASTER_DB_NAME}"`);
      console.log(`[bootstrap] created master database "${MASTER_DB_NAME}"`);
    }
  });
}

async function syncMasterSchema() {
  // alter:false here matches the rest of the app — we never auto-alter
  // existing tables. New columns get added via explicit IF NOT EXISTS
  // ALTER blocks below.
  await Company.sync({ alter: false });

  // Master-only settings (currently just dev_max_companies). Stored as
  // a single-row table same shape as system_settings, so the developer
  // page can read/write through a familiar pattern.
  await masterSequelize.query(`
    CREATE TABLE IF NOT EXISTS master_settings (
      setting_id            INTEGER PRIMARY KEY DEFAULT 1,
      dev_max_companies     INTEGER DEFAULT 3,
      created_date          TIMESTAMPTZ DEFAULT NOW(),
      modified_date         TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO master_settings (setting_id) VALUES (1) ON CONFLICT DO NOTHING;
  `);

  // Audit P3-F — at most one row can have is_primary=true at a time.
  // Pre-fix, the Company model just had `is_primary: BOOLEAN DEFAULT false`
  // with no constraint, so a second row flipped to true would silently
  // break Company.findOne({ where: { is_primary: true } }) (which returns
  // an arbitrary row out of the two). The partial unique enforces the
  // invariant at the database. Idempotent CREATE IF NOT EXISTS.
  await masterSequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_one_primary
      ON companies (is_primary)
      WHERE is_primary = true;
  `);
}

/**
 * Returns true iff the legacy `zehen` database exists AND has at
 * least one row in `system_settings` (i.e., it's been used as a real
 * install, not just an empty placeholder). Conservative on purpose —
 * we'd rather miss a fresh install than register an empty DB that the
 * user wanted to discard.
 */
async function legacyInstallExists() {
  return withAdminClient(async (client) => {
    const r = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [PRIMARY_DB_NAME],
    );
    if (r.rows.length === 0) return false;

    // Connect to that DB and check for any tables. A genuinely-empty
    // zehen from a half-finished install we DON'T register; the
    // user is expected to create a real first company through the UI.
    const probe = new Client({
      host: DB_HOST, port: DB_PORT,
      user: DB_USER, password: DB_PASSWORD,
      database: PRIMARY_DB_NAME,
    });
    try {
      await probe.connect();
      const t = await probe.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='system_settings' LIMIT 1`,
      );
      return t.rows.length > 0;
    } catch {
      return false;
    } finally {
      try { await probe.end(); } catch {}
    }
  });
}

async function registerPrimaryIfNeeded() {
  const existing = await Company.count();
  if (existing > 0) return;            // already migrated

  if (!(await legacyInstallExists())) {
    // Fresh install: register a default primary company pointing at the
    // base DB so the seeded admin can log in immediately (one-click /
    // single-shop experience — the packaged build seeds the admin user
    // into this DB right after bootstrap). Without a primary company
    // row the login endpoint hard-500s with "No primary company
    // configured". The operator renames it + fills GSTIN afterwards via
    // onboarding / Settings → Company Profile.
    await Company.create({
      name:       'My Company',
      db_name:    PRIMARY_DB_NAME,
      legal_name: 'My Company',
      is_primary: true,
      is_active:  true,
    });
    console.log(`[bootstrap] fresh install — registered default primary company (db "${PRIMARY_DB_NAME}")`);
    return;
  }

  // Pull a friendly name + GSTIN from the legacy company-profile so the
  // first picker entry is recognisable instead of "Company 1".
  const probe = new Client({
    host: DB_HOST, port: DB_PORT,
    user: DB_USER, password: DB_PASSWORD,
    database: PRIMARY_DB_NAME,
  });
  let legacyName = 'Primary Company';
  let legacyGstin = null;
  let legacyAddress = null;
  try {
    await probe.connect();
    const r = await probe.query(
      `SELECT company_name, gstin, company_address FROM system_settings LIMIT 1`,
    );
    if (r.rows[0]) {
      legacyName    = r.rows[0].company_name    || legacyName;
      legacyGstin   = r.rows[0].gstin           || null;
      legacyAddress = r.rows[0].company_address || null;
    }
  } catch (e) {
    console.warn('[bootstrap] couldn\'t read legacy company profile:', e.message);
  } finally {
    try { await probe.end(); } catch {}
  }

  await Company.create({
    name:      legacyName,
    db_name:   PRIMARY_DB_NAME,
    legal_name: legacyName,
    gstin:     legacyGstin,
    address:   legacyAddress,
    is_primary: true,
    is_active:  true,
  });
  console.log(`[bootstrap] registered legacy "${PRIMARY_DB_NAME}" as primary company "${legacyName}"`);
}

/**
 * Migrate every existing non-primary company DB up to the latest
 * schema. Called once on server boot so a code update that adds a
 * new table / column propagates to every company without manual
 * intervention. Idempotent — each migration block is IF NOT EXISTS.
 *
 * Primary company is migrated by the existing master-DB IF NOT EXISTS
 * blocks in server/index.js (those run against the master sequelize),
 * so we skip it here.
 */
async function migrateExistingCompanyDatabases() {
  // Lazy-require to avoid circular: companyConnections imports models
  // imports config/database imports companyContext.
  const { Sequelize } = require('sequelize');
  const { runCompanySchemaMigrations } = require('./companySchemaMigrations');

  const rows = await Company.findAll({
    where: { is_active: true, db_dropped_at: null, is_primary: false },
  });
  if (rows.length === 0) return;

  console.log(`[bootstrap] migrating ${rows.length} existing company DB(s)…`);
  for (const co of rows) {
    let seq;
    try {
      seq = new Sequelize(
        co.db_name,
        process.env.DB_USER || 'postgres',
        process.env.DB_PASSWORD || 'postgres',
        {
          host: process.env.DB_HOST || 'localhost',
          port: process.env.DB_PORT || 5432,
          dialect: 'postgres',
          logging: false,
          pool: { max: 1, min: 0, acquire: 10000, idle: 5000 },
        }
      );
      await seq.authenticate();
      await runCompanySchemaMigrations(seq);
      console.log(`[bootstrap]   ✓ ${co.db_name} (company "${co.name}")`);
    } catch (e) {
      // Don't abort boot — log and continue. A misconfigured / missing
      // company DB shouldn't take down the whole server.
      console.error(`[bootstrap]   ✗ ${co.db_name}: ${e.message}`);
    } finally {
      if (seq) try { await seq.close(); } catch {}
    }
  }
}

/**
 * Public entry point — call this from server/index.js on boot, before
 * sequelize.sync runs.
 */
async function runCompanyBootstrap() {
  try {
    await ensureMasterDatabaseExists();
    await masterSequelize.authenticate();
    await syncMasterSchema();
    await registerPrimaryIfNeeded();
    // Backfill schema migrations on every existing non-primary company
    // DB. New code with new columns/tables auto-applies; if we don't
    // do this, a customer with two companies upgrading the app would
    // see Company 1 working and Company 2 broken until they re-create
    // it.
    await migrateExistingCompanyDatabases();
  } catch (e) {
    console.error('[bootstrap] FATAL — could not initialise master DB:', e.message);
    console.error('Make sure your Postgres user has CREATE DATABASE permission.');
    throw e;
  }
}

module.exports = {
  runCompanyBootstrap,
  // Exported for tests / manual repair scripts.
  ensureMasterDatabaseExists,
  syncMasterSchema,
  legacyInstallExists,
  registerPrimaryIfNeeded,
};
