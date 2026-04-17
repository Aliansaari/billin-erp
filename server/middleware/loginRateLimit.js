/**
 * Login rate-limiter — protects /auth/login against brute-force attacks.
 *
 * Why not express-rate-limit? The ERP is sold as an all-in-one package with
 * minimal dependencies (one node_modules/ to audit). A simple in-memory
 * sliding-window counter is enough for a single-tenant desktop ERP — the app
 * runs as one process, so there's no cross-instance sync to worry about.
 *
 * Tracking key: `ip + username` (composite). Tracking by IP alone punishes
 * the whole office when one user mistypes; tracking by username alone lets
 * an attacker spray a million guesses from one IP across fresh usernames.
 * Composite key gives per-account-per-IP isolation.
 *
 * Defaults: 5 failures within 15 minutes → 15 min lockout.
 * Successful login clears the counter for that key (on the authController side).
 */

const WINDOW_MS   = 15 * 60 * 1000;   // sliding window / lockout duration
const MAX_FAILED  = 5;

// key -> { attempts: [timestamp, ...], lockedUntil: ts|null }
const attempts = new Map();

// Periodically evict stale entries so the Map doesn't grow unboundedly over
// the lifetime of a long-running server process. Runs every 5 minutes.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, rec] of attempts) {
    rec.attempts = rec.attempts.filter(ts => ts > cutoff);
    if (rec.attempts.length === 0 && (!rec.lockedUntil || rec.lockedUntil < Date.now())) {
      attempts.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();  // .unref() so the timer doesn't keep the process alive during tests

function keyFor(req) {
  // Prefer the real IP when behind a proxy (trust-proxy set on Express).
  // Fall back to req.connection.remoteAddress for legacy compat.
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').toString();
  const uname = (req.body?.username || '').toString().toLowerCase().trim();
  return `${ip}|${uname}`;
}

/** Express middleware — reject locked accounts before the controller runs. */
function loginRateLimit(req, res, next) {
  const key = keyFor(req);
  const rec = attempts.get(key);
  const now = Date.now();
  if (rec?.lockedUntil && rec.lockedUntil > now) {
    const secs = Math.ceil((rec.lockedUntil - now) / 1000);
    const mins = Math.ceil(secs / 60);
    return res.status(429).json({
      error: `Too many failed login attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      retry_after_seconds: secs,
    });
  }
  next();
}

/** Called by the controller on a FAILED login — records the attempt. */
function recordFailure(req) {
  const key = keyFor(req);
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const rec = attempts.get(key) || { attempts: [], lockedUntil: null };
  // Drop attempts outside the window so counts reflect recent activity.
  rec.attempts = rec.attempts.filter(ts => ts > cutoff);
  rec.attempts.push(now);
  if (rec.attempts.length >= MAX_FAILED) {
    rec.lockedUntil = now + WINDOW_MS;
  }
  attempts.set(key, rec);
}

/** Called by the controller on a SUCCESSFUL login — clears the counter. */
function recordSuccess(req) {
  attempts.delete(keyFor(req));
}

module.exports = { loginRateLimit, recordFailure, recordSuccess };
