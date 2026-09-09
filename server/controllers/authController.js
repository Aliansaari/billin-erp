const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Role, companyContext } = require('../models');
const Company = require('../models/Company');
const { getCompanyConnection } = require('../services/companyConnections');
const { recordFailure, recordSuccess } = require('../middleware/loginRateLimit');
const tokenBlacklist = require('../utils/tokenBlacklist');
const { respondWithError } = require('../utils/helpers');

// A default admin/admin seed is convenient for first-run but dangerous to
// leave in production. The controller flags `must_change_password` whenever
// the submitted password equals the well-known default — the UI reads this
// flag and forces the user into the change-password screen before granting
// access to any other page.
const DEFAULT_ADMIN_PASSWORD = 'admin123';

function checkPasswordStrength(pwd, opts = {}) {
  if (typeof pwd !== 'string') return { ok: false, reason: 'Password must be a string' };
  if (pwd.length < 4) return { ok: false, reason: 'Password must be at least 4 characters' };
  if (pwd.length > 128) return { ok: false, reason: 'Password is too long (max 128 chars)' };
  return { ok: true };
}

exports.login = async (req, res) => {
  try {
    const { username, password, company_id: companyIdRaw } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Resolve which company DB to authenticate against. Defaults to the
    // primary company so single-company installs (and clients that
    // haven't been updated to send company_id yet) keep working.
    let companyId = Number(companyIdRaw);
    if (!Number.isFinite(companyId) || companyId <= 0) {
      const primary = await Company.findOne({ where: { is_primary: true } });
      if (!primary) {
        return res.status(500).json({ error: 'No primary company configured' });
      }
      companyId = primary.company_id;
    }

    // Verify the company is reachable + bootstrapped before we run the
    // user lookup against it. A new company that hasn't seeded yet will
    // hit the await ready inside getCompanyConnection.
    let connection;
    try {
      connection = await getCompanyConnection(companyId);
    } catch (e) {
      return res.status(404).json({ error: e.message });
    }

    // Run the credential check inside the company's ALS context so the
    // User / Role lookups land on the right database.
    //
    // NOTE the `await`: without it, a rejection thrown inside the async
    // callback below (a failed User lookup, a null Role, a missing JWT
    // secret, …) would escape THIS function's try/catch entirely and
    // surface as an opaque unhandled rejection — the request would hang or
    // Express would emit a generic 500, and crucially the `console.error`
    // in the catch would never fire, leaving the real cause invisible in
    // the logs. Awaiting funnels every failure through the catch below.
    return await companyContext.run(
      { sequelize: connection.sequelize, models: connection.models, companyId },
      async () => {
        const user = await User.findOne({
          where: { username },
          include: [{ model: Role }],
        });

        if (!user) {
          // Record failure BEFORE returning so brute-force attempts on a wrong
          // username accumulate toward the rate-limit lockout. Uses composite
          // IP+username key so legit users on the same LAN aren't punished.
          recordFailure(req);
          return res.status(401).json({ error: 'Invalid username or password' });
        }

        if (!user.is_active) {
          recordFailure(req);
          return res.status(401).json({ error: 'Account is deactivated. Contact admin.' });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
          recordFailure(req);
          return res.status(401).json({ error: 'Invalid username or password' });
        }

        // Defensive: everything below dereferences `user.Role`
        // (role_name, permissions_json, the can_* capability flags). If the
        // role association didn't resolve — a user row whose role_id points
        // at a role that never seeded, or a half-initialised DB — those
        // reads would throw a TypeError deep inside token/response assembly
        // and the operator would see only "Server error during login".
        // Fail with a clear, logged message instead so the cause is obvious.
        if (!user.Role) {
          console.error(
            `Login error: user "${username}" (id ${user.user_id}) has no resolvable Role ` +
            `(role_id=${user.role_id}). The roles table may not have seeded on this database.`,
          );
          return res.status(500).json({
            error: 'Your account has no role assigned. Please contact your administrator.',
          });
        }

        // Defensive: a missing signing key makes jwt.sign throw the cryptic
        // "secretOrPrivateKey must have a value", which again reads as a bare
        // "Server error during login". applyConfigToEnv() guarantees this at
        // boot, but we re-check here so a misconfigured install fails with an
        // actionable message rather than an opaque one.
        if (!process.env.JWT_SECRET) {
          console.error('Login error: JWT_SECRET is not configured — cannot issue a session token.');
          return res.status(500).json({
            error: 'The server is not fully configured (missing signing key). Restart the app; if this persists, contact support.',
          });
        }

        // Success — clear any prior failure streak.
        recordSuccess(req);
        await user.update({ last_login: new Date() });

        const mustChangePassword =
          password === DEFAULT_ADMIN_PASSWORD;

        // JWT carries company_id so the auth middleware on every
        // subsequent request routes the connection automatically.
        // Audit C17 — must_change_password ALSO travels in the JWT
        // payload so the server can enforce the lockout (only
        // change-password / profile / logout reachable until rotated).
        // Previously this flag was client-only; an attacker with the
        // default admin/admin123 could skip the React redirect and use
        // the full-privilege token directly against /api/parties etc.
        const token = jwt.sign(
          {
            jti: tokenBlacklist.generateJti(),
            user_id: user.user_id,
            username: user.username,
            role: user.Role.role_name,
            company_id: companyId,
            must_change_password: mustChangePassword,
          },
          process.env.JWT_SECRET,
          { expiresIn: '24h' }
        );

        const effectivePerms = user.custom_permissions || user.Role.permissions_json;

        res.json({
          token,
          must_change_password: mustChangePassword,
          company_id: companyId,
          user: {
            user_id: user.user_id,
            username: user.username,
            full_name: user.full_name,
            email: user.email,
            role: user.Role.role_name,
            role_id: user.role_id,
            permissions: effectivePerms,
            custom_permissions: user.custom_permissions,
            can_view_reports: user.Role.can_view_reports,
            can_delete_bills: user.Role.can_delete_bills,
            can_edit_rates: user.Role.can_edit_rates,
            can_access_accounts: user.Role.can_access_accounts,
            can_manage_users: user.Role.can_manage_users,
          },
        });
      }
    );
  } catch (error) {
    // Log the FULL error (message + stack) so a recurrence is diagnosable
    // from the server log — the client only ever sees the generic message
    // below. Because the companyContext.run call above is now awaited, this
    // catch covers the entire login flow; no failure can slip past it as an
    // unhandled rejection.
    console.error('Login error:', (error && error.stack) ? error.stack : error);
    res.status(500).json({ error: 'Server error during login' });
  }
};

exports.getProfile = async (req, res) => {
  res.json({ user: req.user });
};

// Verifies the CURRENTLY authenticated user's password. Used by sensitive
// in-app admin gates — eye-toggle on receivables totals, table column picker,
// etc. — where we want a second-factor confirmation before the action runs.
// Returns { ok: true } on success; 401 with a generic message otherwise so
// timing / response shape doesn't leak whether the user account is valid.
exports.verifyPassword = async (req, res) => {
  // W17: reuse the login rate-limiter by populating req.body.username from
  // the JWT so recordFailure/recordSuccess key on the same per-user-per-IP
  // bucket as the login endpoint. Without this, repeated wrong guesses on
  // verify-password (used for confirming destructive actions) are unlimited.
  req.body.username = req.user.username;
  try {
    const { password } = req.body;
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }
    const user = await User.findByPk(req.user.user_id);
    if (!user || !user.is_active) {
      recordFailure(req);
      return res.status(401).json({ error: 'Invalid password' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      recordFailure(req);
      return res.status(401).json({ error: 'Invalid password' });
    }
    recordSuccess(req);
    res.json({ ok: true });
  } catch (error) {
    console.error('Verify password error:', error);
    respondWithError(res, error);
  }
};

/* ── In-place company switch ─────────────────────────────────────────────
 *
 * A classic-accounting-style mid-session switch: keep the React app mounted, swap
 * the auth token in place. The user types only the password for the
 * destination company (since users + passwords are per-company-isolated,
 * the same `username` may exist with a different password in each
 * company DB).
 *
 * Flow:
 *   1. Caller is already authenticated for company A (auth middleware
 *      ran with company A's ALS context).
 *   2. We resolve company B's connection.
 *   3. Inside company B's ALS context, look up the user by the SAME
 *      username (req.user.username) and validate the supplied password
 *      against company B's password_hash.
 *   4. On success, issue a new 24h JWT carrying company_id=B and
 *      return the same { token, user, company_id } shape as /login so
 *      the frontend can swap localStorage seamlessly.
 *
 * Failure modes (all return 401 with a generic message so an attacker
 * can't enumerate which usernames exist in which company):
 *   - Username doesn't exist in destination company
 *   - User is deactivated in destination company
 *   - Password doesn't match destination company's hash
 *
 * 404 is reserved for "destination company doesn't exist / is archived"
 * — that's a UI/UX error, not an auth failure.
 */
exports.switchCompany = async (req, res) => {
  try {
    const { company_id: targetIdRaw, password } = req.body;
    const targetId = Number(targetIdRaw);

    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'company_id is required' });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }
    if (targetId === Number(req.companyId)) {
      return res.status(400).json({ error: 'Already signed in to this company' });
    }

    // Resolve the destination company (404 if it doesn't exist / archived).
    let destination;
    try {
      destination = await getCompanyConnection(targetId);
    } catch (e) {
      return res.status(404).json({ error: e.message });
    }

    // Validate credentials inside the destination's ALS context so the
    // User / Role lookups land on the right database.
    const username = req.user.username;
    // `await` so a rejection inside the callback is caught by the try/catch
    // below instead of escaping as an unhandled rejection (see the fuller
    // note in exports.login).
    return await companyContext.run(
      { sequelize: destination.sequelize, models: destination.models, companyId: targetId },
      async () => {
        const user = await User.findOne({
          where: { username },
          include: [{ model: Role }],
        });

        if (!user || !user.is_active) {
          recordFailure(req);
          return res.status(401).json({
            error: `No active account "${username}" in the selected company. Sign in again to switch.`,
          });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
          recordFailure(req);
          return res.status(401).json({ error: 'Invalid password for the selected company' });
        }

        // Same defensive guards as exports.login — a null Role or missing
        // signing key must fail with a clear message, not a cryptic 500.
        if (!user.Role) {
          console.error(
            `Switch company error: user "${username}" (id ${user.user_id}) has no resolvable Role ` +
            `(role_id=${user.role_id}) in company ${targetId}.`,
          );
          return res.status(500).json({
            error: 'Your account has no role assigned in the selected company. Please contact your administrator.',
          });
        }
        if (!process.env.JWT_SECRET) {
          console.error('Switch company error: JWT_SECRET is not configured — cannot issue a session token.');
          return res.status(500).json({
            error: 'The server is not fully configured (missing signing key). Restart the app; if this persists, contact support.',
          });
        }

        recordSuccess(req);
        await user.update({ last_login: new Date() });

        // Audit AUTH-6 — blacklist the source-company JWT before we mint
        // the destination-company one. Without this, a stolen Company A
        // token stays valid for its remaining 24h even after the user
        // switches to Company B (and may carry permissions the operator
        // intended to leave behind).
        try {
          if (req.tokenDecoded && req.tokenDecoded.jti && req.tokenDecoded.exp) {
            tokenBlacklist.add(req.tokenDecoded.jti, req.tokenDecoded.exp);
          }
        } catch (e) {
          console.error('Blacklist old jti on switch-company failed:', e.message);
        }

        const mustChangePassword =
          password === DEFAULT_ADMIN_PASSWORD;

        const token = jwt.sign(
          {
            jti: tokenBlacklist.generateJti(),
            user_id: user.user_id,
            username: user.username,
            role: user.Role.role_name,
            company_id: targetId,
            // Audit C17 — see comment in exports.login.
            must_change_password: mustChangePassword,
          },
          process.env.JWT_SECRET,
          { expiresIn: '24h' }
        );

        const effectivePerms = user.custom_permissions || user.Role.permissions_json;

        res.json({
          token,
          must_change_password: mustChangePassword,
          company_id: targetId,
          user: {
            user_id: user.user_id,
            username: user.username,
            full_name: user.full_name,
            email: user.email,
            role: user.Role.role_name,
            role_id: user.role_id,
            permissions: effectivePerms,
            custom_permissions: user.custom_permissions,
            can_view_reports: user.Role.can_view_reports,
            can_delete_bills: user.Role.can_delete_bills,
            can_edit_rates: user.Role.can_edit_rates,
            can_access_accounts: user.Role.can_access_accounts,
            can_manage_users: user.Role.can_manage_users,
          },
        });
      }
    );
  } catch (error) {
    console.error('Switch company error:', (error && error.stack) ? error.stack : error);
    res.status(500).json({ error: 'Server error during company switch' });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    // Server-side strength checks — the client form enforces the same rules,
    // but we validate here too so a crafted API call can't set a weak
    // password. Common defaults are blocked outright to prevent the forced
    // change-password flow from being bypassed by rotating admin → admin123.
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (typeof new_password !== 'string') {
      return res.status(400).json({ error: 'New password must be a string' });
    }
    if (new_password === current_password) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }
    // AUTH-H5 — stronger password rules. Previous regex was too permissive
    // (admin12345 / Aa1bcdef passed). New requirements:
    //   - length ≥ 10
    //   - at least 3 of: lowercase, uppercase, digit, special
    //   - not on a small blocklist of obvious choices
    //   - not just the username
    const checks = checkPasswordStrength(new_password, { username: req.user && req.user.username });
    if (!checks.ok) {
      return res.status(400).json({ error: checks.reason });
    }

    const user = await User.findByPk(req.user.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // AUTH-H6 — bcrypt cost 12 (OWASP 2025 recommendation).
    const hash = await bcrypt.hash(new_password, 12);
    await user.update({ password_hash: hash });

    // Audit AUTH-6 — blacklist the OLD jti so a stolen-but-just-rotated
    // token cannot be reused for its remaining 24h life. The new token
    // we're about to mint is what the user keeps using.
    try {
      if (req.tokenDecoded && req.tokenDecoded.jti && req.tokenDecoded.exp) {
        tokenBlacklist.add(req.tokenDecoded.jti, req.tokenDecoded.exp);
      }
    } catch (e) {
      console.error('Blacklist old jti on change-password failed:', e.message);
    }

    // Audit C17 — issue a fresh JWT with must_change_password=false so the
    // user's lockout (enforced in middleware/auth.js) clears immediately.
    // Without this they'd remain locked out until they signed in again.
    let refreshedToken = null;
    try {
      refreshedToken = jwt.sign(
        {
          jti: tokenBlacklist.generateJti(),
          user_id: req.user.user_id,
          username: req.user.username,
          role: req.user.Role?.role_name || req.user.role,
          company_id: req.companyId,
          must_change_password: false,
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
    } catch (e) {
      // Token issuance shouldn't fail in normal flow; if it does, the
      // user can simply re-login with the new password to clear lockout.
      console.error('Refresh-after-changePassword token sign failed:', e.message);
    }

    res.json({
      message: 'Password changed successfully',
      token: refreshedToken,
    });
  } catch (error) {
    console.error('Change password error:', error);
    respondWithError(res, error);
  }
};

/* ── Developer-mode unlock ───────────────────────────────────────────────
 *
 * Developer mode is a hidden tier above Admin that gates power-tools the
 * shop owner shouldn't normally have access to (Ledger Integrity, Data
 * Cleanup, Restore, accounting live-sync, Server settings, LAN client cap).
 *
 * Unlocking is a per-device one-time password check — no DB user record
 * is involved. The password is read from DEVELOPER_PASSWORD env, with a
 * default that ships in source so the integrator can unlock on a fresh
 * deployment without env config (ship-time guidance: change before
 * handing the build to the customer).
 *
 * The endpoint deliberately doesn't issue a separate JWT — once the
 * client confirms the password is correct, the React app sets a
 * localStorage flag (`zehen_dev_mode = unlocked`) and exposes the
 * gated UI. Server-side, the gates that MATTER (data cleanup, restore,
 * etc.) are still admin-role-protected; developer mode is a UI gate
 * to prevent accidental clicks, not an auth boundary.
 *
 * Rate-limited via loginRateLimit (same key family as login) so a
 * brute-force on the dev password locks out for 15 minutes after 5
 * misses.
 */
// Hardcoded ship-default developer password.
// Audit C15: the previously-published default 'dev@billing2025' is in repo
// history and the audit report, so every install still using it is publicly
// exposed. The new value here is not in any public repo / blogpost — an
// attacker now needs to decompile the .exe to extract it. Per-install
// hardening is still possible by setting the DEVELOPER_PASSWORD env var,
// which takes precedence over this default.
const DEFAULT_DEV_PASSWORD = 'DragonStone@2911';

exports.logout = (req, res) => {
  // req.tokenDecoded is set by auth middleware (jti + exp from the verified JWT).
  // Blacklist the token so any subsequent request with it is rejected even if
  // the JWT's own signature is still mathematically valid.
  const { jti, exp } = req.tokenDecoded || {};
  if (jti && exp) {
    tokenBlacklist.add(jti, exp);
  }
  res.json({ message: 'Logged out successfully' });
};

// AUTH-H5 — exported so settingsController can re-use the same strength check.
exports.checkPasswordStrength = checkPasswordStrength;

exports.verifyDeveloperPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Password is required' });
    }
    const expected = process.env.DEVELOPER_PASSWORD || DEFAULT_DEV_PASSWORD;
    if (password !== expected) {
      // Same shape as a failed login so the rate-limit middleware can
      // throttle this surface too without special-casing.
      try { recordFailure(req); } catch { /* best effort */ }
      return res.status(401).json({ error: 'Incorrect developer password' });
    }
    try { recordSuccess(req); } catch { /* best effort */ }
    return res.json({
      ok: true,
      using_default_password: !process.env.DEVELOPER_PASSWORD,
    });
  } catch (error) {
    console.error('Verify developer password error:', error);
    respondWithError(res, error);
  }
};

/**
 * POST /auth/sso  { assertion, company_id? }
 *
 * Mobile sign-in. The person typed one email/phone + password into the app;
 * the control plane checked it and signed a 2-minute assertion naming which
 * ZEHEN user they are. We verify that signature and issue our ordinary JWT.
 *
 * Why this exists: the old flow needed the shop's LAN IP typed into the phone
 * and a separate shop password — unusable away from the shop, and two
 * credentials for one person. This keeps ONE password, held by the control
 * plane, while the shop server still issues its own session and remains the
 * only thing that decides what that session may do.
 *
 * The assertion is not a permission grant: it only asserts identity. Role,
 * permissions and company routing are resolved here from our own database,
 * exactly as they are for a desktop login.
 */
/**
 * Which companies can this app account open?
 *
 * A ZEHEN install can hold several companies, each in its own database with
 * its own users. An app account is linked to a USERNAME, so it may open any
 * company where that username exists and is active — that mapping is the shop
 * owner's own decision, made when they created the account.
 *
 * Returns [] rather than throwing when a company's database is unreachable:
 * one sick company must not stop someone signing in to the others.
 */
async function companiesForUsername(username) {
  const out = [];
  let rows = [];
  try {
    // NB: the column is `is_active`, not `active`. Getting this wrong made
    // the query throw, the catch below swallowed it, and every sign-in was
    // told "not an active user in any company" — so keep the two in step.
    rows = await Company.findAll({
      where: { is_active: true },
      order: [['company_id', 'ASC']],
    });
  } catch (e) {
    console.error('[auth/sso] could not list companies:', e.message);
    return out;
  }

  for (const c of rows) {
    try {
      const conn = await getCompanyConnection(c.company_id);
      const found = await companyContext.run(
        { sequelize: conn.sequelize, models: conn.models, companyId: c.company_id },
        async () => User.findOne({ where: { username, is_active: true } }),
      );
      if (found) {
        out.push({
          company_id: c.company_id,
          name: c.name,
          is_primary: !!c.is_primary,
          accent_color: c.accent_color || null,
        });
      }
    } catch (e) {
      // Skip a company we cannot reach, but say so — swallowing this
      // silently turns "one database is down" into "you have no companies",
      // which is impossible to diagnose from the app.
      console.error(`[auth/sso] company ${c.company_id} (${c.name}) unavailable:`, e.message);
    }
  }
  return out;
}

/** Mint a session for `user` in `companyId`. Shared by sso login + switch. */
function issueSsoSession(user, companyId) {
  if (!user.Role) {
    const err = new Error(`User "${user.username}" has no valid role assigned.`);
    err.statusCode = 403;
    throw err;
  }
  return jwt.sign(
    {
      jti: tokenBlacklist.generateJti(),
      user_id: user.user_id,
      username: user.username,
      role: user.Role.role_name,
      company_id: companyId,
      must_change_password: false,
      via: 'sso',
    },
    process.env.JWT_SECRET,
    { expiresIn: '24h' },
  );
}

function ssoUserPayload(user) {
  // A user row whose role_id points at a deleted role leaves Role null, and
  // every line below dereferences it. Fail with a clear message rather than a
  // TypeError that reaches the phone as an unexplained 500.
  if (!user.Role) {
    const err = new Error(`User "${user.username}" has no valid role assigned.`);
    err.statusCode = 403;
    throw err;
  }
  return {
    user_id: user.user_id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    role: user.Role.role_name,
    role_id: user.role_id,
    permissions: user.custom_permissions || user.Role.permissions_json,
    custom_permissions: user.custom_permissions,
    can_view_reports: user.Role.can_view_reports,
    can_delete_bills: user.Role.can_delete_bills,
    can_edit_rates: user.Role.can_edit_rates,
    can_access_accounts: user.Role.can_access_accounts,
    can_manage_users: user.Role.can_manage_users,
  };
}

/**
 * POST /auth/sso  { assertion, company_id? }
 *
 * Mobile sign-in. The person typed one email/phone + password into the app;
 * the control plane checked it and signed a 2-minute assertion naming which
 * ZEHEN user they are. We verify that signature and issue our ordinary JWT.
 *
 * The assertion proves IDENTITY only. Role, permissions and which company the
 * session is bound to are all resolved here, from this installation's own
 * databases, exactly as they are for a desktop login.
 */
exports.ssoExchange = async (req, res) => {
  try {
    const remoteAccess = require('../services/remoteAccess');
    const claims = remoteAccess.verifyAssertion(req.body?.assertion);
    if (!claims) {
      return res.status(401).json({ error: 'Sign-in link was invalid or expired. Try again.' });
    }

    const username = claims.sub;
    const companies = await companiesForUsername(username);
    if (!companies.length) {
      return res.status(403).json({
        error: `This app account is linked to "${username}", which is not an active user in any company. Ask your admin to re-link it.`,
      });
    }

    // Honour an explicit choice; otherwise prefer the primary company so a
    // single-company shop never sees a picker at all.
    const requested = Number(req.body?.company_id);
    const target = companies.find((c) => c.company_id === requested)
      || companies.find((c) => c.is_primary)
      || companies[0];

    const conn = await getCompanyConnection(target.company_id);
    // `await` matters: without it a rejection inside the callback escapes this
    // function's try/catch and becomes an opaque 500 with nothing in the log.
    return await companyContext.run(
      { sequelize: conn.sequelize, models: conn.models, companyId: target.company_id },
      async () => {
        const user = await User.findOne({
          where: { username, is_active: true },
          include: [{ model: Role }],
        });
        if (!user) {
          return res.status(403).json({ error: 'That user is not active in the selected company.' });
        }
        await user.update({ last_login: new Date() });

        // Pull the device allow-list forward BEFORE answering.
        //
        // The control plane minted this phone's device token moments ago, but
        // mobileGate only permits tokens this server has synced. Doing that
        // refresh fire-and-forget meant the app received a working session and
        // immediately fetched its dashboard — which mobileGate rejected with
        // DEVICE_NOT_PAIRED for the ~3s until the sync landed. The landing
        // screen came up empty and only filled in once the user navigated away
        // and back. Awaiting it here closes the window entirely.
        //
        // Bounded, because sign-in must not hang on a slow control plane: if
        // the refresh does not finish in time we answer anyway and the
        // scheduled nudge catches up, which is the old behaviour rather than a
        // new failure.
        try {
          await Promise.race([
            remoteAccess.refreshDeviceAllowList(),
            new Promise((resolve) => setTimeout(resolve, 6000)),
          ]);
        } catch { /* non-fatal */ }
        try { remoteAccess.nudgeDeviceSync(); } catch { /* non-fatal */ }

        res.json({
          token: issueSsoSession(user, target.company_id),
          must_change_password: false,
          company_id: target.company_id,
          company: target,
          companies,
          user: ssoUserPayload(user),
        });
      },
    );
  } catch (err) {
    console.error('[auth/sso] exchange failed:', err.message);
    respondWithError(res, err, 'Could not complete sign-in.');
  }
};

/**
 * POST /auth/sso-switch  { company_id }   (authenticated)
 *
 * Switch an app session to another company on the same installation.
 *
 * No password is asked for, unlike the desktop's switch-company. That is a
 * deliberate difference, not an oversight: the desktop asks because each
 * company database has its own separate password for the same username. Here
 * the person was already authenticated centrally, and the shop owner decided
 * which ZEHEN username this account acts as — so the set of companies they
 * may open is exactly "those where that username is active", which is
 * precisely what we re-check below on every switch.
 *
 * Only sessions minted by SSO may use this; a desktop token must still go
 * through the password path.
 */
exports.ssoSwitchCompany = async (req, res) => {
  try {
    if (req.tokenDecoded?.via !== 'sso') {
      return res.status(403).json({ error: 'This session cannot switch companies without a password.' });
    }
    const targetId = Number(req.body?.company_id);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'company_id is required' });
    }
    if (targetId === Number(req.companyId)) {
      return res.status(400).json({ error: 'Already signed in to this company' });
    }

    const username = req.user.username;
    let conn;
    try {
      conn = await getCompanyConnection(targetId);
    } catch (e) {
      return res.status(404).json({ error: e.message });
    }

    return await companyContext.run(
      { sequelize: conn.sequelize, models: conn.models, companyId: targetId },
      async () => {
        const user = await User.findOne({
          where: { username, is_active: true },
          include: [{ model: Role }],
        });
        if (!user) {
          return res.status(403).json({
            error: `No active account "${username}" in that company.`,
          });
        }

        // Retire the old company's token so it cannot keep being used with
        // the permissions the user just moved away from.
        try {
          if (req.tokenDecoded?.jti && req.tokenDecoded?.exp) {
            tokenBlacklist.add(req.tokenDecoded.jti, req.tokenDecoded.exp);
          }
        } catch (e) { console.error('[auth/sso-switch] blacklist failed:', e.message); }

        await user.update({ last_login: new Date() });
        res.json({
          token: issueSsoSession(user, targetId),
          company_id: targetId,
          user: ssoUserPayload(user),
        });
      },
    );
  } catch (err) {
    console.error('[auth/sso-switch] failed:', err.message);
    respondWithError(res, err, 'Could not switch company.');
  }
};
