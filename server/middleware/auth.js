const jwt = require('jsonwebtoken');
const { User, Role, companyContext } = require('../models');
const Company = require('../models/Company');
const { getCompanyConnection } = require('../services/companyConnections');

/**
 * authenticateToken
 *
 * 1. Verify the JWT.
 * 2. Resolve the company_id claim (defaults to the primary company for
 *    legacy tokens issued before multi-company support).
 * 3. Look up the per-company connection from the pool and pin it to
 *    AsyncLocalStorage so every model query inside this request
 *    automatically routes to the right database. The proxies in
 *    server/models/index.js read this ALS slot.
 * 4. Resolve the user inside the ALS context — User lives in the
 *    company DB, not the master DB.
 *
 * Order matters: ALS must be set BEFORE the User.findByPk so the
 * lookup hits the right connection. We do that by wrapping `next()`
 * (and the user lookup) inside companyContext.run().
 *
 * Failure semantics unchanged: 401 for any auth-level failure
 * (missing token, invalid signature, expired, missing user, missing
 * company). 403 stays reserved for requirePermission.
 */
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Session expired — please sign in again' : 'Invalid token',
      expired: !!expired,
    });
  }

  // Resolve the company. Legacy tokens (issued before multi-company)
  // have no company_id claim — fall back to the primary company so
  // existing sessions don't get logged out the moment this code ships.
  let companyId = Number(decoded.company_id);
  if (!Number.isFinite(companyId) || companyId <= 0) {
    try {
      const primary = await Company.findOne({ where: { is_primary: true } });
      companyId = primary?.company_id;
    } catch { /* falls through to error below */ }
    if (!companyId) {
      return res.status(401).json({ error: 'No active company configured' });
    }
  }

  let connection;
  try {
    connection = await getCompanyConnection(companyId);
  } catch (e) {
    return res.status(401).json({ error: `Company ${companyId} unavailable: ${e.message}` });
  }

  // Run the rest of the request inside the company's ALS context. Every
  // model query made by downstream middleware / controllers will route
  // to this company's database via the model proxies.
  //
  // CRITICAL: AsyncLocalStorage scopes only persist while the .run()
  // callback is alive. Express's next() dispatches the next handler
  // via internal scheduling that may not propagate ALS reliably across
  // every Promise hop (express.json, error handlers, the routing
  // layer's own Promise wrappers).
  //
  // We keep the .run() callback alive until the response actually
  // finishes by awaiting a Promise that resolves on res.finish /
  // res.close. That way EVERY downstream handler runs INSIDE the
  // callback's lexical async context, and ALS is guaranteed visible.
  companyContext.run({ sequelize: connection.sequelize, models: connection.models, companyId }, async () => {
    try {
      const user = await User.findByPk(decoded.user_id, {
        include: [{ model: Role }],
        attributes: { exclude: ['password_hash'] },
      });

      if (!user || !user.is_active) {
        return res.status(401).json({ error: 'Invalid or inactive user' });
      }

      req.user = user;
      req.companyId = companyId;
      req.companyDb = connection;

      // Keep the ALS context alive for the entire request. Without the
      // pending Promise, the .run() callback would resolve as soon as
      // we exit this synchronous block, and async handlers downstream
      // may not see the store. The 'finish'/'close' resolution ties
      // the ALS scope to the response lifecycle.
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        res.once('finish', done);
        res.once('close', done);
        next();
      });
    } catch (e) {
      console.error('[auth] User lookup failed:', e.message);
      res.status(500).json({ error: 'Server error during authentication' });
    }
  });
};

module.exports = { authenticateToken };
