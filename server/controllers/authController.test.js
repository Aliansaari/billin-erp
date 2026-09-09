/*
 * Regression tests for the login hardening (fresh-install "Server error
 * during login" incident). Run with:
 *   node --test server/controllers/authController.test.js
 *
 * These do NOT touch a database. Every dependency the controller requires
 * is replaced with an in-memory mock via require.cache BEFORE the
 * controller module is loaded, so we exercise the real login() code path
 * with fully controllable inputs.
 *
 * What each test locks in:
 *   1. A user whose Role association is null no longer crashes with an
 *      opaque 500 — it returns a clear, specific message. (Role guard +
 *      the `await` that funnels callback errors through the try/catch.)
 *   2. A missing JWT_SECRET returns a clear config message instead of the
 *      cryptic jwt.sign "secretOrPrivateKey must have a value".
 *   3. An error thrown deep inside the ALS callback is CAUGHT (returns the
 *      generic JSON 500) rather than escaping as an unhandled rejection —
 *      this is the core bug the `await` fixes.
 *   4. The happy path still issues a real signed token.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const CONTROLLER_DIR = __dirname;
const CONTROLLER_PATH = path.join(CONTROLLER_DIR, 'authController.js');

// Mutable handles the mocks read from, so each test can steer behaviour.
const state = {
  userFindOne: async () => null,
  primaryCompany: { company_id: 1, is_primary: true },
};

function resolveFrom(request) {
  return require.resolve(request, { paths: [CONTROLLER_DIR] });
}

// Install a fake module into the require cache so the controller picks it
// up instead of the real file.
function stub(request, exports) {
  const filename = resolveFrom(request);
  require.cache[filename] = new Module(filename);
  require.cache[filename].filename = filename;
  require.cache[filename].loaded = true;
  require.cache[filename].exports = exports;
}

// A no-op ALS shim whose run() actually invokes the callback (so the login
// body executes) — mirrors AsyncLocalStorage.run(store, cb) → cb().
const companyContext = { run: (_store, cb) => cb() };

// Marker class used as the `include: [{ model: Role }]` target. Its
// identity doesn't matter to the mocks, only that it exists.
class Role {}
class User {}

// ── Install mocks BEFORE requiring the controller ──────────────────────
stub('../models', { User, Role, companyContext });
stub('../models/Company', { findOne: async () => state.primaryCompany });
stub('../services/companyConnections', {
  getCompanyConnection: async () => ({ sequelize: {}, models: {} }),
});
stub('../middleware/loginRateLimit', {
  recordFailure: () => {},
  recordSuccess: () => {},
});
stub('../utils/tokenBlacklist', { generateJti: () => 'test-jti' });
stub('../utils/helpers', { respondWithError: () => {} });
stub('bcryptjs', { compare: async () => true, hash: async () => 'x' });

// The mocked models module exposes User.findOne via the state handle so a
// test can swap the implementation between cases.
User.findOne = (...args) => state.userFindOne(...args);

const authController = require(CONTROLLER_PATH);

// Minimal Express req/res doubles.
function makeReq(body) {
  return { body, ip: '127.0.0.1', headers: {}, connection: {} };
}
function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('login: user with null Role returns a clear 500, not an opaque crash', async () => {
  process.env.JWT_SECRET = 'test-secret';
  state.userFindOne = async () => ({
    user_id: 7, username: 'admin', is_active: true,
    password_hash: 'hash', role_id: 99, Role: null,
    update: async () => {},
  });
  const res = makeRes();
  await authController.login(makeReq({ username: 'admin', password: 'admin123' }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /no role assigned/i);
});

test('login: missing JWT_SECRET returns a config message, not a jwt throw', async () => {
  delete process.env.JWT_SECRET;
  state.userFindOne = async () => ({
    user_id: 7, username: 'admin', is_active: true,
    password_hash: 'hash', role_id: 1,
    Role: { role_name: 'Super Admin', permissions_json: {} },
    custom_permissions: null,
    update: async () => {},
  });
  const res = makeRes();
  await authController.login(makeReq({ username: 'admin', password: 'admin123' }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /not fully configured|signing key/i);
});

test('login: an error inside the ALS callback is CAUGHT (generic 500, no unhandled rejection)', async () => {
  process.env.JWT_SECRET = 'test-secret';
  state.userFindOne = async () => { throw new Error('boom inside callback'); };
  const res = makeRes();
  // If the `await` were missing, this would reject (unhandled) and res
  // would stay null. Asserting the generic 500 body proves the catch ran.
  await authController.login(makeReq({ username: 'admin', password: 'admin123' }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Server error during login');
});

test('login: happy path issues a signed token', async () => {
  process.env.JWT_SECRET = 'test-secret';
  state.userFindOne = async () => ({
    user_id: 7, username: 'admin', is_active: true,
    password_hash: 'hash', role_id: 1, full_name: 'Admin', email: 'a@b.c',
    custom_permissions: null,
    Role: {
      role_name: 'Super Admin', permissions_json: { all: true },
      can_view_reports: true, can_delete_bills: true, can_edit_rates: true,
      can_access_accounts: true, can_manage_users: true,
    },
    update: async () => {},
  });
  const res = makeRes();
  await authController.login(makeReq({ username: 'admin', password: 'admin123' }), res);
  assert.equal(res.statusCode, null); // res.json() called without status() → 200
  assert.ok(res.body.token, 'a token should be issued');
  assert.equal(res.body.user.role, 'Super Admin');
  assert.equal(res.body.must_change_password, true); // password === admin123 default
});
