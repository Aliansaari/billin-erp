const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Role } = require('../models');
const { recordFailure, recordSuccess } = require('../middleware/loginRateLimit');

// A default admin/admin seed is convenient for first-run but dangerous to
// leave in production. The controller flags `must_change_password` whenever
// the submitted password equals the well-known default — the UI reads this
// flag and forces the user into the change-password screen before granting
// access to any other page.
const DEFAULT_ADMIN_PASSWORD = 'admin123';

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

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

    // Success — clear any prior failure streak so the user isn't locked out
    // later in the session by their own mistypes.
    recordSuccess(req);

    await user.update({ last_login: new Date() });

    // Flag default-password users: the client must force a change-password
    // redirect before letting them use the app. We compare the PLAINTEXT
    // submitted password (never the hash) because bcrypt hashes aren't
    // reversible — and we only know the default matches the hash here.
    const mustChangePassword =
      user.username === 'admin' && password === DEFAULT_ADMIN_PASSWORD;

    const token = jwt.sign(
      { user_id: user.user_id, username: user.username, role: user.Role.role_name },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      must_change_password: mustChangePassword,
      user: {
        user_id: user.user_id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        role: user.Role.role_name,
        role_id: user.role_id,
        permissions: user.Role.permissions_json,
        can_view_reports: user.Role.can_view_reports,
        can_delete_bills: user.Role.can_delete_bills,
        can_edit_rates: user.Role.can_edit_rates,
        can_access_accounts: user.Role.can_access_accounts,
        can_manage_users: user.Role.can_manage_users,
      },
    });
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
  try {
    const { password } = req.body;
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }
    const user = await User.findByPk(req.user.user_id);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Verify password error:', error);
    res.status(500).json({ error: 'Server error' });
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
    if (typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (new_password === current_password) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }
    if (/^(admin|admin123|password|123456|qwerty)$/i.test(new_password)) {
      return res.status(400).json({ error: 'Please choose a stronger password — avoid common defaults' });
    }

    const user = await User.findByPk(req.user.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await user.update({ password_hash: hash });

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
