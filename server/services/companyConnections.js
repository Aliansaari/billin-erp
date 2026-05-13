/**
 * Per-company connection pool.
 * ────────────────────────────
 *
 * Caches one Sequelize instance + its model bag per company. Each
 * connection is created lazily on first use; the schema migration runs
 * against the new connection before the first request can hit it, so
 * the per-company DB always has the right tables.
 *
 * Audit P2-C — entries that haven't been touched for IDLE_EVICTION_MS
 * are closed by a periodic sweeper. Without eviction, a long-running
 * LAN host that switches between companies over weeks would hold 30
 * connections × N companies open against the cluster, eventually
 * hitting Postgres `max_connections=100` (default) and freezing. The
 * master/primary connection is exempt — every request needs it to look
 * up the Company directory and per-route auth.
 *
 * Two key entry points:
 *
 *   getCompanyConnection(companyId)
 *     → resolves to { sequelize, models, ready }
 *     `ready` is a Promise that fulfils after schema migration +
 *     default-data seeding finish for a brand-new company database.
 *     Routes that need a fully-bootstrapped connection (login,
 *     anything that touches roles or system_settings) await ready.
 *
 *   companyContext.run({ sequelize, models }, callback)
 *     Stores the active connection in AsyncLocalStorage so the
 *     model proxies in server/models/index.js auto-route every
 *     query to the right database. Called by the auth middleware
 *     for every authenticated request.
 *
 * Master DB note: companyId === 1 always returns the master / primary
 * company connection (defined statically in server/config/database.js).
 * That keeps the existing single-company install working unchanged —
 * a fresh install is registered as Company 1 by the bootstrap, and
 * every legacy code path lands on it through this pool.
 */

const { Sequelize } = require('sequelize');
const Company = require('../models/Company');
// Pull the RAW master sequelize, not the ALS proxy. If we used the
// proxy, primary-company connections would have ctx.sequelize === proxy,
// and the proxy.get(...) trap would recurse into itself looking up
// target → ctx.sequelize → proxy → ... → stack overflow.
const databaseModule = require('../config/database');
const masterSequelize = databaseModule.masterSequelize || databaseModule;
const { defineModels, masterModels, companyContext } = require('../models');
const { runCompanySchemaMigrations } = require('./companySchemaMigrations');

const POOL = new Map();   // companyId -> { sequelize, models, ready, company, lastUsedAt, isPrimary }

// How long a per-company connection can sit idle before the sweeper
// closes it. 30 minutes is comfortably longer than the inactivity gap
// between operator actions on a busy day (so we don't churn) but short
// enough that a forgotten / archived company doesn't tie up its slots
// indefinitely. Tunable via env for stress testing.
const IDLE_EVICTION_MS = Number(process.env.DB_COMPANY_IDLE_EVICTION_MS || 30 * 60 * 1000);
const SWEEPER_INTERVAL_MS = Number(process.env.DB_COMPANY_SWEEPER_INTERVAL_MS || 5 * 60 * 1000);

let _sweeperHandle = null;

function buildSequelize(dbName) {
  return new Sequelize(
    dbName,
    process.env.DB_USER     || 'postgres',
    process.env.DB_PASSWORD || 'postgres',
    {
      host:    process.env.DB_HOST || 'localhost',
      port:    process.env.DB_PORT || 5432,
      dialect: 'postgres',
      logging: false,
      pool: {
        // Per-company pool — same shape as master but smaller, since
        // we expect each company to have ~5-10 active users at most.
        max:     Number(process.env.DB_POOL_MAX || 30),
        min:     Number(process.env.DB_POOL_MIN || 1),
        acquire: Number(process.env.DB_POOL_ACQUIRE || 35000),
        idle:    Number(process.env.DB_POOL_IDLE || 10000),
        evict:   Number(process.env.DB_POOL_EVICT || 1000),
      },
      dialectOptions: {
        keepAlive: true,
        keepAliveInitialDelayMillis: 30_000,
        statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30_000),
      },
      retry: {
        max: 3,
        match: [/ETIMEDOUT/i, /ECONNRESET/i, /ECONNREFUSED/i, /ENETUNREACH/i, /SequelizeConnectionError/],
      },
    },
  );
}

/**
 * Ensure a company id has a usable connection + model bag. The first
 * call for a given id triggers connect + schema migration; subsequent
 * calls return the cached entry instantly.
 *
 * For the primary company, the master sequelize is reused so a
 * single-company install behaves identically to before — no extra
 * connections, no extra migrations.
 */
async function getCompanyConnection(companyId) {
  const id = Number(companyId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Invalid company_id: ${companyId}`);
  }

  // Cache hit.
  const cached = POOL.get(id);
  if (cached) {
    cached.lastUsedAt = Date.now();
    await cached.ready;
    return cached;
  }

  // Cache miss — look up the company in the master directory.
  const company = await Company.findByPk(id);
  if (!company) throw new Error(`Company ${id} not found`);
  if (company.db_dropped_at) throw new Error(`Company ${id} has been deleted`);
  if (!company.is_active)    throw new Error(`Company ${id} is archived`);

  // Primary company reuses the master sequelize so the existing single-
  // DB install works exactly as before. Master models were already
  // associated at module load.
  let sequelize, models;
  let isPrimary = false;
  if (company.is_primary || company.db_name === (process.env.DB_NAME || 'billing_erp')) {
    sequelize = masterSequelize;
    models = masterModels;
    isPrimary = true;
  } else {
    sequelize = buildSequelize(company.db_name);
    models = defineModels(sequelize);
  }

  // ready Promise — fulfils after schema migration + seed run for a
  // fresh company DB. Master is already migrated so we skip the work.
  const ready = (async () => {
    if (sequelize === masterSequelize) return; // master already initialised
    await sequelize.authenticate();
    await sequelize.sync({ alter: false });
    await runCompanySchemaMigrations(sequelize);
    // Seed default data (roles, default ledger accounts, etc.) for a
    // brand-new DB. The seeder uses the proxied models from
    // ../models — to make it operate on THIS company's connection we
    // have to run it inside the ALS context.
    await companyContext.run({ sequelize, models }, async () => {
      const seedDefaultData = require('../seeders/defaultData');
      await seedDefaultData();
    });
  })().catch((e) => {
    // Don't poison the cache on transient failures. Drop the entry
    // so a retry can rebuild from scratch.
    POOL.delete(id);
    throw e;
  });

  const entry = { sequelize, models, ready, company, lastUsedAt: Date.now(), isPrimary };
  POOL.set(id, entry);
  // Start the idle sweeper on first use, not at module load — keeps the
  // background tick out of unit-test boots that import this file.
  ensureSweeperStarted();
  await ready;
  return entry;
}

// Periodic sweeper: closes the Sequelize instance for any non-primary
// company entry that hasn't been touched for IDLE_EVICTION_MS. The
// master/primary entry is exempt (every request loads Company from it).
async function sweepIdleConnections() {
  const cutoff = Date.now() - IDLE_EVICTION_MS;
  for (const [id, entry] of POOL.entries()) {
    if (entry.isPrimary) continue;
    if (entry.lastUsedAt > cutoff) continue;
    POOL.delete(id);
    try {
      await entry.sequelize.close();
      console.log(`[connection-pool] evicted idle company ${id} (idle ${Math.round((Date.now() - entry.lastUsedAt) / 60000)}m)`);
    } catch (e) {
      console.error(`[connection-pool] failed to close company ${id}:`, e.message);
    }
  }
}

function ensureSweeperStarted() {
  if (_sweeperHandle) return;
  _sweeperHandle = setInterval(() => {
    sweepIdleConnections().catch((e) => console.error('[connection-pool] sweeper error:', e.message));
  }, SWEEPER_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweeper — graceful
  // shutdown should still work.
  if (typeof _sweeperHandle.unref === 'function') _sweeperHandle.unref();
}

/**
 * Diagnostic helper for /api/server-info — reports which companies
 * have warm connections (without exposing the company DBs themselves).
 */
function getPoolStats() {
  return {
    cached_companies: POOL.size,
    company_ids: Array.from(POOL.keys()).sort((a, b) => a - b),
  };
}

/**
 * Drop a cached connection — used by the Manage Companies page when
 * a company is renamed / archived so subsequent connections get a
 * fresh entry. Closes the underlying Sequelize instance (unless this
 * is the master/primary, which is shared with every request).
 * Audit P2-C: pre-fix this only deleted the cache entry, leaving the
 * connection pool open against the cluster — a leak.
 */
function invalidateCompany(companyId) {
  const id = Number(companyId);
  const entry = POOL.get(id);
  POOL.delete(id);
  if (entry && !entry.isPrimary) {
    entry.sequelize.close().catch((e) => {
      console.error(`[connection-pool] invalidateCompany ${id} close failed:`, e.message);
    });
  }
}

module.exports = {
  getCompanyConnection,
  getPoolStats,
  invalidateCompany,
  // Re-export the AsyncLocalStorage for the middleware. Same instance
  // as exported by server/models/index.js — the Proxies are bound to
  // it.
  companyContext,
};
