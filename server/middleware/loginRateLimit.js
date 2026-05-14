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
 *
 * Audit H9 — the in-memory map is now a CACHE in front of a small
 * `login_attempts` table in the master DB. Server restart no longer clears
 * the lockout: failures and lockedUntil are persisted, and the cache is
 * hydrated lazily on first request per key.
 */

const sequelize = require('../config/database');

const WINDOW_MS   = 15 * 60 * 1000;   // sliding window / lockout duration
const MAX_FAILED  = 5;

// key -> { attempts: [timestamp, ...], lockedUntil: ts|null, hydrated: bool }
const attempts = new Map();

// Periodically evict stale entries so the Map doesn't grow unboundedly over
// the lifetime of a long-running server process. Runs every 5 minutes.
// Also prunes the persistent table.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, rec] of attempts) {
    rec.attempts = rec.attempts.filter(ts => ts > cutoff);
    if (rec.attempts.length === 0 && (!rec.lockedUntil || rec.lockedUntil < Date.now())) {
      attempts.delete(key);
    }
  }
  // Prune persistent rows whose window has fully elapsed AND the lockout
  // has expired. Fire-and-forget; failure is non-fatal.
  const cutoffSecs = Math.floor(cutoff / 1000);
  sequelize.query(
    `DELETE FROM login_attempts
       WHERE last_attempt < to_timestamp(:c)
         AND (locked_until IS NULL OR locked_until < NOW())`,
    { replacements: { c: cutoffSecs } },
  ).catch(() => { /* swallow */ });
}, 5 * 60 * 1000).unref();  // .unref() so the timer doesn't keep the process alive during tests

function keyFor(req) {
  // Prefer the real IP when behind a proxy (trust-proxy set on Express).
  // Fall back to req.connection.remoteAddress for legacy compat.
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').toString();
  const uname = (req.body?.username || '').toString().toLowerCase().trim();
  return `${ip}|${uname}`;
}

// Hydrate one cache key from the persistent table. Idempotent: marks the
// rec.hydrated=true so we don't hit the DB again for the same key in the
// process lifetime (subsequent hits use the in-memory state, which is the
// source of truth after first hydration).
async function _hydrateOne(key) {
  let rec = attempts.get(key);
  if (rec && rec.hydrated) return rec;
  try {
    const rows = await sequelize.query(
      `SELECT attempts_json, locked_until FROM login_attempts WHERE key = :k`,
      { replacements: { k: key }, type: sequelize.QueryTypes.SELECT },
    );
    if (rows.length > 0) {
      const row = rows[0];
      const stamps = Array.isArray(row.attempts_json) ? row.attempts_json : [];
      const lu = row.locked_until ? new Date(row.locked_until).getTime() : null;
      rec = { attempts: stamps, lockedUntil: lu, hydrated: true };
      attempts.set(key, rec);
      return rec;
    }
  } catch (err) {
    if (!_hydrateOne._warned) {
      console.warn('[loginRateLimit] hydrate skipped (DB not ready):', err.message);
      _hydrateOne._warned = true;
    }
  }
  rec = { attempts: [], lockedUntil: null, hydrated: true };
  attempts.set(key, rec);
  return rec;
}

// Persist one record. Fire-and-forget — persistence failure is non-fatal
// for the current process (in-memory state still enforces the lockout).
function _persist(key, rec) {
  const lu = rec.lockedUntil ? new Date(rec.lockedUntil).toISOString() : null;
  sequelize.query(
    `INSERT INTO login_attempts (key, attempts_json, last_attempt, locked_until)
       VALUES (:k, :a::jsonb, NOW(), ${lu ? ':lu' : 'NULL'})
     ON CONFLICT (key) DO UPDATE
       SET attempts_json = EXCLUDED.attempts_json,
           last_attempt  = EXCLUDED.last_attempt,
           locked_until  = EXCLUDED.locked_until`,
    { replacements: { k: key, a: JSON.stringify(rec.attempts), lu } },
  ).catch((err) => {
    if (!_persist._warned) {
      console.error('[loginRateLimit] persist failed:', err.message);
      _persist._warned = true;
    }
  });
}

/** Express middleware — reject locked accounts before the controller runs. */
async function loginRateLimit(req, res, next) {
  const key = keyFor(req);
  let rec = attempts.get(key);
  if (!rec || !rec.hydrated) rec = await _hydrateOne(key);
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
  const rec = attempts.get(key) || { attempts: [], lockedUntil: null, hydrated: true };
  // Drop attempts outside the window so counts reflect recent activity.
  rec.attempts = rec.attempts.filter(ts => ts > cutoff);
  rec.attempts.push(now);
  if (rec.attempts.length >= MAX_FAILED) {
    rec.lockedUntil = now + WINDOW_MS;
  }
  rec.hydrated = true;
  attempts.set(key, rec);
  _persist(key, rec);
}

/** Called by the controller on a SUCCESSFUL login — clears the counter. */
function recordSuccess(req) {
  const key = keyFor(req);
  attempts.delete(key);
  // Clear persistent row too.
  sequelize.query(`DELETE FROM login_attempts WHERE key = :k`, { replacements: { k: key } })
    .catch(() => { /* swallow */ });
}

module.exports = { loginRateLimit, recordFailure, recordSuccess };
