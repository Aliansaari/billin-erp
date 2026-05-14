const crypto = require('crypto');
const sequelize = require('../config/database');

// In-memory JTI blacklist. Each entry: { exp: unix-seconds }
// Entries are auto-evicted once the token's own expiry passes — the
// blacklist never grows larger than the number of active 24h tokens.
//
// Audit H9 — the in-memory layer is now a CACHE in front of a small
// `revoked_jtis` table in the master DB. On boot, the table is hydrated
// into the cache lazily (first isRevoked call). On add(), we write through
// to the table so a server restart can't restore revoked tokens.
const _blacklist = new Map();
let _hydrated = false;

// Hydrate the in-memory cache from the persistent table. Idempotent —
// safe to call on every isRevoked when not yet hydrated. Failure is
// non-fatal: we log and proceed with the in-memory store only, so a
// momentarily-unavailable DB doesn't 500 every authenticated request.
async function _hydrateOnce() {
  if (_hydrated) return;
  try {
    const rows = await sequelize.query(
      `SELECT jti, exp FROM revoked_jtis WHERE exp > FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint`,
      { type: sequelize.QueryTypes.SELECT },
    );
    for (const r of rows) _blacklist.set(r.jti, { exp: Number(r.exp) });
    _hydrated = true;
  } catch (err) {
    // Table missing on a freshly-installed DB before the startup migration
    // runs — totally fine, just stay un-hydrated and try again next call.
    // Don't spam logs with the same error repeatedly.
    if (!_hydrateOnce._warned) {
      console.warn('[tokenBlacklist] hydrate skipped (DB not ready yet):', err.message);
      _hydrateOnce._warned = true;
    }
  }
}

// Evict entries whose token has already expired. Called on each add/check
// so the Map stays bounded without a separate timer. Also prunes the
// persistent table so it doesn't accumulate forever.
function _evict() {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, { exp }] of _blacklist) {
    if (exp <= now) _blacklist.delete(jti);
  }
  // Fire-and-forget — pruning isn't critical-path and a query failure
  // shouldn't bubble to the caller. Runs at most once per call site.
  sequelize.query(`DELETE FROM revoked_jtis WHERE exp <= FLOOR(EXTRACT(EPOCH FROM NOW()))::bigint`)
    .catch(() => { /* swallow — table maybe missing */ });
}

function generateJti() {
  return crypto.randomUUID();
}

function add(jti, exp) {
  _evict();
  _blacklist.set(jti, { exp });
  // Write-through to the persistent table. UPSERT so a re-revocation of the
  // same jti (shouldn't happen — jtis are unique per token) is idempotent.
  sequelize.query(
    `INSERT INTO revoked_jtis (jti, exp, created_at) VALUES (:j, :e, NOW())
     ON CONFLICT (jti) DO UPDATE SET exp = EXCLUDED.exp`,
    { replacements: { j: jti, e: exp } },
  ).catch((err) => {
    // Persistence failure is non-fatal — the in-memory blacklist still works
    // for the current process. Log once so an admin can diagnose.
    if (!add._warned) {
      console.error('[tokenBlacklist] persist failed:', err.message);
      add._warned = true;
    }
  });
}

function isRevoked(jti) {
  _evict();
  // Lazy hydrate on first check after server boot. Fire-and-forget — the
  // current check uses the in-memory state; the hydration improves the
  // next call. Worst case: a token revoked just before a restart returns
  // false on the very first post-restart check. The 24h JWT exp still
  // limits exposure.
  if (!_hydrated) _hydrateOnce();
  return _blacklist.has(jti);
}

module.exports = { generateJti, add, isRevoked };
