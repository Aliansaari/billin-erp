require('dotenv').config();
const { Sequelize } = require('sequelize');

/* Connection pool sizing for LAN deployments
 * ──────────────────────────────────────────
 *
 * Default max=10 was fine for a single-machine Electron install but
 * starves 10–20 concurrent LAN clients: each in-flight request holds
 * one connection, so once 10 dashboards refresh in parallel everyone
 * else queues for up to `acquire`ms (=30 s by default — feels like a
 * frozen app).
 *
 * Sizing rule of thumb for Postgres on commodity Indian retail PCs:
 *   - default Postgres max_connections = 100
 *   - reserve ~10 for psql / superuser
 *   - we get ~90, but we only need a few per user
 *   - 30 covers 20 active LAN clients with headroom for backup +
 *     import-worker + dashboard refreshes
 *
 * Both values are env-tuneable so a small shop (5 PCs) can lower it
 * and a big one (40 PCs) can raise it without a code change.
 *
 * acquire 35 s  — Audit P2-N: must be LONGER than statement_timeout
 *                 (default 30 s) so a slow report hitting its query
 *                 timeout yields its connection back to the pool BEFORE
 *                 a queued request gives up. Pre-fix this was 10 s, so
 *                 a single 30-s report would starve every other LAN
 *                 client (they got SequelizeConnectionAcquireTimeoutError
 *                 after 10 s even though the system was about to recover).
 * idle    10 s   — close idle conns quickly so we don't keep dozens
 *                  open during quiet periods
 * evict    1 s   — sweep dead/stale conns every second
 */
const masterSequelize = new Sequelize(
  process.env.DB_NAME || 'billing_erp',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASSWORD || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
    pool: {
      max: Number(process.env.DB_POOL_MAX || 30),
      min: Number(process.env.DB_POOL_MIN || 2),
      acquire: Number(process.env.DB_POOL_ACQUIRE || 35000),
      idle: Number(process.env.DB_POOL_IDLE || 10000),
      evict: Number(process.env.DB_POOL_EVICT || 1000),
    },
    // Lift TCP-level keepalive on the pg socket so a Wi-Fi AP
    // disconnect (common on laptops returning from sleep) is detected
    // within ~30 s instead of after the next query times out.
    dialectOptions: {
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      // 30s statement timeout protects against a runaway report query
      // pinning a connection forever while every other LAN client waits.
      // Long-running operations (backup, import) run outside Sequelize
      // (raw pg_dump / streaming ingest) so this cap doesn't affect them.
      statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30_000),
    },
    retry: {
      // Transient network glitches on the LAN — auto-retry connection
      // errors but NOT statement errors (those usually mean a bug).
      max: 3,
      match: [/ETIMEDOUT/i, /ECONNRESET/i, /ECONNREFUSED/i, /ENETUNREACH/i, /SequelizeConnectionError/],
    },
  },
);

/* ── Multi-tenant Proxy ─────────────────────────────────────────────────
 *
 * Controllers across the codebase do `const sequelize = require('../config/database')`
 * and then `sequelize.transaction(...)`, `sequelize.query(...)`, etc.
 *
 * Without a Proxy, those calls would always hit the master DB regardless
 * of which company the request belongs to — breaking multi-company
 * isolation since transactions wouldn't run against the right database.
 *
 * The Proxy below transparently routes every property access to whichever
 * sequelize is set in the per-request AsyncLocalStorage (companyContext).
 * Boot code, scheduled jobs, and anything outside a request still get the
 * master sequelize because their ALS store is empty.
 *
 * Identity-preserving: `sequelize.transaction(cb)` calls cb with a
 * Transaction bound to whichever underlying sequelize is active —
 * Sequelize's own internals do `transaction.sequelize` → the active one,
 * so subsequent queries inside the transaction stay on the same DB.
 *
 * The companyContext store has shape:
 *   { sequelize: <SequelizeInstance>, models: <bag>, companyId: <number> }
 *
 * Boot code that needs the literal master (model definition, the master
 * DB's bootstrap routines) imports `masterSequelize` directly via the
 * named export below; that bypasses the proxy.
 */
const { companyContext } = require('../services/companyContext');

const sequelize = new Proxy(masterSequelize, {
  get(target, prop, receiver) {
    const ctx = companyContext.getStore();
    const active = (ctx && ctx.sequelize) || target;
    const val = active[prop];
    // Bind functions to the active instance so `this` inside Sequelize
    // internals (e.g. transaction managers) stays correct.
    if (typeof val === 'function') return val.bind(active);
    return val;
  },
});

module.exports = sequelize;
// Named export for boot / model-definition code that legitimately needs
// the literal master, untouched by the ALS proxy.
module.exports.masterSequelize = masterSequelize;
