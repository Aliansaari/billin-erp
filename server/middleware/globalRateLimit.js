/*
 * Global rate-limiter — caps total request volume per IP (audit P2-M).
 *
 * Pre-fix, only /auth/login was rate-limited. A leaked JWT could scrape
 * /api/parties or any other data endpoint at full speed (gigabytes per
 * minute on a LAN), or an unauthenticated user could pummel /api/health
 * and other public endpoints to deny service. This adds a coarse-grained
 * per-IP cap that catches abuse without interfering with normal use.
 *
 * Defaults: 300 requests per 60 s per IP. A normal operator on a busy
 * day issues ~30-50 API calls per minute (page loads + autocomplete);
 * 300 leaves room for power users and admin panels without letting an
 * attacker scrape thousands of records.
 *
 * In-memory only — same trade-off as loginRateLimit.js. Single-process
 * ERP, no cluster, no cross-instance sync.
 */

const WINDOW_MS = Number(process.env.GLOBAL_RATE_WINDOW_MS || 60_000);
const MAX_PER_IP = Number(process.env.GLOBAL_RATE_MAX || 300);

// ip -> { timestamps: [ts, ...] }
const buckets = new Map();

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, rec] of buckets) {
    rec.timestamps = rec.timestamps.filter((ts) => ts > cutoff);
    if (rec.timestamps.length === 0) buckets.delete(ip);
  }
}, Math.min(WINDOW_MS, 30_000)).unref();

function ipFor(req) {
  return (req.ip || req.connection?.remoteAddress || 'unknown').toString();
}

function globalRateLimit(req, res, next) {
  // Skip non-/api/ requests so the SPA / static asset loads aren't capped.
  if (!req.path || !req.path.startsWith('/api/')) return next();
  // Health checks and license-info bypass the limiter — Electron and LAN
  // hosts ping these regularly.
  if (req.path === '/api/health' || req.path === '/api/license/info') return next();

  const ip = ipFor(req);
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const rec = buckets.get(ip) || { timestamps: [] };
  rec.timestamps = rec.timestamps.filter((ts) => ts > cutoff);
  if (rec.timestamps.length >= MAX_PER_IP) {
    const oldest = rec.timestamps[0];
    const retryAfter = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
    return res.status(429).json({
      error: 'Too many requests. Please slow down.',
      retry_after_seconds: retryAfter,
    });
  }
  rec.timestamps.push(now);
  buckets.set(ip, rec);
  next();
}

module.exports = { globalRateLimit };
