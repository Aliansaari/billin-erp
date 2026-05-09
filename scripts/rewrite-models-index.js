#!/usr/bin/env node
/**
 * Rewrites server/models/index.js into a multi-tenant factory pattern.
 *
 * The new index.js exports:
 *
 *   defineModels(sequelize)   — factory that takes any Sequelize instance
 *                               and returns a fresh model bag (39 models +
 *                               associations registered on that instance).
 *                               Used by the connection pool to build a
 *                               per-company model bag for each company DB.
 *
 *   sequelize                  — Proxy over the master sequelize that
 *                               routes sequelize.transaction(),
 *                               sequelize.query(), etc. to the active
 *                               company's connection (via AsyncLocalStorage)
 *                               or master if no ALS context is set.
 *
 *   Role, User, Party, ...     — Proxies over the master models that
 *                               route every method call to the active
 *                               company's equivalent model. Boot code
 *                               and the seeder use master directly when
 *                               ALS is empty.
 *
 *   companyContext             — the AsyncLocalStorage. Middleware calls
 *                               .run({ sequelize, models }, next).
 *
 *   masterSequelize, masterModels  — direct references for boot/seed.
 *
 * The 39 model files have already been refactored into factories:
 *   module.exports = (sequelize) => sequelize.define(...)
 *
 * This script reads the existing associations block from index.js (which
 * starts after the master requires and ends just before module.exports),
 * wraps it in a function, and assembles the new index.js. It uses the
 * extracted associations text verbatim, so nothing about the
 * relationship logic changes — only the binding does.
 */

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'server', 'models', 'index.js');
const orig = fs.readFileSync(INDEX, 'utf8');

// Pull the associations block. Starts at "// ── Associations ──" and ends
// at the line that begins module.exports.
const startMarker = '// ── Associations ──';
const startIdx = orig.indexOf(startMarker);
const exportIdx = orig.indexOf('module.exports = {');
if (startIdx < 0 || exportIdx < 0) {
  console.error('Could not find association block markers — index.js shape changed?');
  process.exit(1);
}
const assocBlock = orig.slice(startIdx, exportIdx).trimEnd();

// The list of model files (excluding index.js + Company.js which lives
// only in the master DB).
const MODELS = [
  'Role', 'User', 'Party', 'Category', 'Product',
  'PurchaseBill', 'PurchaseBillItem', 'PurchaseBillDraft',
  'SalesBill', 'SalesBillItem', 'SalesBillDraft',
  'SalesReturnBill', 'SalesReturnBillItem',
  'PurchaseReturnBill', 'PurchaseReturnBillItem',
  'PaymentReceipt', 'PaymentSplit',
  'StockLedger', 'LedgerAccount', 'LedgerEntry', 'JournalVoucher',
  'ImportJob', 'ImportBatch', 'TallyLedgerMapping',
  'BarcodeSettings', 'SystemSettings', 'PrintProfile',
  'Godown', 'ProductGodownStock', 'ProductColor',
  'StockTransfer', 'StockTransferItem',
  'ProductBatch', 'ProductBatchStock',
  'UserReportFavorite', 'LoanAccount', 'Cheque',
  'ExpenseVoucher', 'ExpenseVoucherItem',
];

// Indent the associations block by 2 spaces — it's now inside a function.
const indented = assocBlock
  .split('\n')
  .map((l) => (l.length ? '  ' + l : l))
  .join('\n');

const requireLines = MODELS.map((m) => `const ${m}Factory = require('./${m}');`).join('\n');
const callLines    = MODELS.map((m) => `  const ${m} = ${m}Factory(sequelize);`).join('\n');
const returnLines  = MODELS.map((m) => `    ${m},`).join('\n');
const proxyLines   = MODELS.map((m) =>
  `  ${m}: makeProxy('${m}'),`
).join('\n');

const out = `/**
 * Models module — multi-tenant.
 *
 * See scripts/rewrite-models-index.js for the design notes. Briefly:
 *
 *   - Each individual model file is a factory: \`(sequelize) => sequelize.define(...)\`
 *   - This file orchestrates them: a defineModels(sequelize) factory
 *     returns a fully-associated model bag for any sequelize instance.
 *   - Master models are defined once on the global sequelize at module
 *     load (preserving existing behaviour for boot / seed).
 *   - Per-company models are created on demand by the connection pool
 *     (server/services/companyConnections.js).
 *   - Controllers continue to do \`const { SalesBill } = require('../models')\`
 *     unchanged — the destructured value is a Proxy that forwards every
 *     method call to the active company's real model via AsyncLocalStorage.
 *
 * If no AsyncLocalStorage context is set (boot, seeders, scheduled
 * jobs, integration tests), the proxy falls back to the master models.
 * That keeps every existing code path working without changes.
 */

const { AsyncLocalStorage } = require('async_hooks');
const masterSequelize = require('../config/database');

${requireLines}

/**
 * Define all models + associations on a given Sequelize instance.
 * Returns the model bag + the sequelize itself for symmetry with the
 * old export shape.
 *
 * Idempotent ONLY when called with distinct sequelize instances.
 * Calling twice on the same instance would re-register associations
 * and Sequelize would warn / throw.
 */
function defineModels(sequelize) {
${callLines}

${indented}

  return {
    sequelize,
${returnLines}
  };
}

// Master model bag — defined once at module load on the global
// sequelize. Used as the fallback target when no ALS context is set
// AND as the boot-time target for sequelize.sync() + the seeder.
const masterBag = defineModels(masterSequelize);

// AsyncLocalStorage for per-request company routing. The middleware
// calls companyContext.run({ sequelize, models }, next) before
// invoking the route handler. Anything inside that callback (and any
// async work it awaits) sees the right per-company connection through
// the proxies below.
const companyContext = new AsyncLocalStorage();

// Build a Proxy over a master model that forwards every property
// access to the ACTIVE per-company model (or master if no ALS ctx).
// Method calls are bound to the active model so \`this\` resolves
// correctly inside Sequelize internals.
function makeProxy(modelName) {
  const masterModel = masterBag[modelName];
  return new Proxy(masterModel, {
    get(target, prop, receiver) {
      const ctx = companyContext.getStore();
      const m = (ctx && ctx.models && ctx.models[modelName]) || target;
      const val = m[prop];
      // Bind functions to the active model so 'this' works inside
      // Sequelize's chained calls (e.g. \`Model.findOne().then(row => row.update())\`).
      if (typeof val === 'function') return val.bind(m);
      return val;
    },
    // Forward instanceof / Symbol.hasInstance / set / has so the proxy
    // is observationally identical to the underlying model. Most callers
    // don't poke these, but the few that do (Sequelize internals around
    // includes) will work without surprises.
    set(target, prop, value, receiver) {
      const ctx = companyContext.getStore();
      const m = (ctx && ctx.models && ctx.models[modelName]) || target;
      m[prop] = value;
      return true;
    },
    has(target, prop) {
      const ctx = companyContext.getStore();
      const m = (ctx && ctx.models && ctx.models[modelName]) || target;
      return prop in m;
    },
    getPrototypeOf(target) {
      const ctx = companyContext.getStore();
      const m = (ctx && ctx.models && ctx.models[modelName]) || target;
      return Object.getPrototypeOf(m);
    },
  });
}

// Sequelize instance proxy — same idea but for the bare sequelize
// object that controllers use for transactions + raw queries.
const sequelizeProxy = new Proxy(masterSequelize, {
  get(target, prop) {
    const ctx = companyContext.getStore();
    const s = (ctx && ctx.sequelize) || target;
    const val = s[prop];
    if (typeof val === 'function') return val.bind(s);
    return val;
  },
});

module.exports = {
  // Backward-compatible exports — these are the Proxies. Controllers
  // that did \`const { SalesBill } = require('../models')\` continue to
  // work unchanged; the destructured value just routes via ALS.
  sequelize: sequelizeProxy,
${proxyLines}

  // Multi-tenant escape hatches — used by the connection pool +
  // middleware. Don't import these from controllers; stick with the
  // proxied models above so the routing stays automatic.
  defineModels,
  companyContext,
  masterSequelize,
  masterModels: masterBag,
};
`;

fs.writeFileSync(INDEX, out);
console.log(`✓ rewrote ${INDEX} (${out.length} bytes)`);
