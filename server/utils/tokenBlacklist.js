const crypto = require('crypto');

// In-memory JTI blacklist. Each entry: { exp: unix-seconds }
// Entries are auto-evicted once the token's own expiry passes — the
// blacklist never grows larger than the number of active 24h tokens.
const _blacklist = new Map();

// Evict entries whose token has already expired. Called on each add/check
// so the Map stays bounded without a separate timer.
function evict() {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, { exp }] of _blacklist) {
    if (exp <= now) _blacklist.delete(jti);
  }
}

function generateJti() {
  return crypto.randomUUID();
}

function add(jti, exp) {
  evict();
  _blacklist.set(jti, { exp });
}

function isRevoked(jti) {
  evict();
  return _blacklist.has(jti);
}

module.exports = { generateJti, add, isRevoked };
