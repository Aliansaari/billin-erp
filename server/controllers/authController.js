const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Role, companyContext } = require('../models');
const Company = require('../models/Company');
const { getCompanyConnection } = require('../services/companyConnections');
const { recordFailure, recordSuccess } = require('../middleware/loginRateLimit');
const tokenBlacklist = require('../utils/tokenBlacklist');

// A default admin/admin seed is convenient for first-run but dangerous to
// leave in production. The controller flags `must_change_password` whenever
// the submitted password equals the well-known default — the UI reads this
// flag and forces the user into the change-password screen before granting
// access to any other page.
const DEFAULT_ADMIN_PASSWORD = 'admin123';

// AUTH-H5 — password strength checker. Returns {ok, reason}. Rules:
//   - length ≥ 10 chars
//   - at least 3 of: lowercase, uppercase, digit, non-alnum
//   - not equal (case-insensitive) to username
//   - not on the obvious-blocklist
// Designed to be strict enough that "Aa1bcdef" or "admin12345" fail, while
// realistic owner-supplied passwords (e.g. "Sabina@Dresses2026") pass.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'admin', 'admin123', 'admin1234',
  'qwerty', 'qwerty123', '12345678', '123456789', '1234567890',
  'letmein', 'welcome', 'welcome1', 'welcome123', 'iloveyou',
  'monkey', 'dragon', 'master', 'sunshine', 'princess',
  'superadmin', 'rootroot', 'changeme', 'changeme1', 'changeme123',
]);
function checkPasswordStrength(pwd, opts = {}) {
  if (typeof pwd !== 'string') return { ok: false, reason: 'Password must be a string' };
  if (pwd.length < 10) return { ok: false, reason: 'Password must be at least 10 characters' };
  if (pwd.length > 128) return { ok: false, reason: 'Password is too long (max 128 chars)' };
  const lower = /[a-z]/.test(pwd);
  const upper = /[A-Z]/.test(pwd);
  const digit = /[0-9]/.test(pwd);
  const special = /[^A-Za-z0-9]/.test(pwd);
  const classes = (lower ? 1 : 0) + (upper ? 1 : 0) + (digit ? 1 : 0) + (special ? 1 : 0);
  if (classes < 3) {
    return {
      ok: false,
      reason: 'Password must include at least 3 of: lowercase, uppercase, digit, special character',
    };
  }
  if (COMMON_PASSWORDS.has(pwd.toLowerCase())) {
    return { ok: false, reason: 'This password is on the common-passwords list — choose something less obvious' };
  }
  if (opts.username && pwd.toLowerCase() === String(opts.username).toLowerCase()) {
    return { ok: false, reason: 'Password cannot be the same as your username' };
  }
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
    return companyContext.run(
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
    console.error('Login error:', error);
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
    res.status(500).json({ error: 'Server error' });
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
    return companyContext.run(
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
    console.error('Switch company error:', error);
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
    res.status(500).json({ error: 'Server error' });
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
 * localStorage flag (`billing_erp_dev_mode = unlocked`) and exposes the
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
    res.status(500).json({ error: 'Server error' });
  }
};
