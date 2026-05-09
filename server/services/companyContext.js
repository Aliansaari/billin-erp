/**
 * Shared AsyncLocalStorage instance for per-company request routing.
 *
 * Lives in its own file (instead of inside server/models/index.js) so
 * server/config/database.js can import it without creating a circular
 * dependency: models/index.js needs config/database for the master
 * connection, and config/database needs companyContext to be a Proxy
 * that routes per-request.
 *
 * The middleware (server/middleware/auth.js) calls
 *   companyContext.run({ sequelize, models }, next)
 * so every model query and every direct sequelize.transaction() /
 * sequelize.query() call inside a request handler routes to the
 * active company's database via the Proxies in models/index.js and
 * config/database.js.
 */
const { AsyncLocalStorage } = require('async_hooks');

const companyContext = new AsyncLocalStorage();

module.exports = { companyContext };
