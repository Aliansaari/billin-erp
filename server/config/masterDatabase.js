// Fixed-path .env load (see config/database.js) — never read ./.env from
// the process CWD, so launching the packaged app from a dir with a stray
// dev .env can't override the real DB config.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Sequelize } = require('sequelize');

/* ── Master database ───────────────────────────────────────────────────
 *
 * Multi-company architecture (classic accounting-style):
 *
 *   zehen_master       — this connection. Holds the companies
 *                              directory, dev-tier flags, app-level
 *                              audit log. Small + rarely written.
 *
 *   zehen_co_<id>      — one database per company. Holds every
 *                              transactional table the app already
 *                              has (parties, products, sales_bills,
 *                              users, roles, …). The existing global
 *                              connection in `./database` continues to
 *                              point at the user's PRIMARY company so
 *                              every existing controller / model
 *                              keeps working unchanged.
 *
 * Both connections share the same Postgres host + credentials; only
 * the database name differs. Defaults preserve a smooth migration
 * path: if MASTER_DB_NAME isn't set, we use "zehen_master".
 *
 * For a fresh install: the bootstrap routine in
 *   server/services/companyBootstrap.js
 * creates this DB on first server start, runs the master-side schema,
 * and registers any pre-existing single-DB install as "Company 1"
 * pointing at zehen.
 */
const masterSequelize = new Sequelize(
  process.env.MASTER_DB_NAME || 'zehen_master',
  process.env.DB_USER     || 'postgres',
  process.env.DB_PASSWORD || 'postgres',
  {
    host:    process.env.DB_HOST || 'localhost',
    port:    process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
    pool: {
      // Master DB sees very low traffic — list-companies on login
      // and the occasional CRUD. Tiny pool is plenty.
      max:     5,
      min:     0,
      acquire: 10000,
      idle:    10000,
    },
    dialectOptions: {
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    },
    retry: {
      max: 3,
      match: [/ETIMEDOUT/i, /ECONNRESET/i, /ECONNREFUSED/i, /ENETUNREACH/i, /SequelizeConnectionError/],
    },
  },
);

module.exports = masterSequelize;
