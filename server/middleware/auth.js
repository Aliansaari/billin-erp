const jwt = require('jsonwebtoken');
const { User, Role } = require('../models');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.user_id, {
      include: [{ model: Role }],
      attributes: { exclude: ['password_hash'] },
    });

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid or inactive user' });
    }

    req.user = user;
    next();
  } catch (err) {
    // Auth-level failures must surface as 401, NOT 403 — the frontend
    // axios interceptor only auto-redirects to /login on 401. Earlier
    // this was returning 403 on expired tokens, so the operator got
    // stuck on a working-looking page where every API call quietly
    // 403'd (favorites, settings/system, …) until they manually
    // reloaded or cleared localStorage. 403 is reserved for
    // requirePermission — i.e. authenticated but missing a capability.
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Session expired — please sign in again' : 'Invalid token',
      expired: !!expired,
    });
  }
};

module.exports = { authenticateToken };
