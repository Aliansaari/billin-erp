/*
 * Lightweight idempotency cache for short-lived "did this client already
 * succeed?" lookups (audit P2-L).
 *
 * Use case: a sales-bill save where the client retried after a network
 * blip — without this, the server can't tell the second POST is the same
 * logical attempt and creates a duplicate bill. The client sends an
 * `idempotency_key` (UUID) on every save attempt; the server stashes the
 * resulting bill_id keyed by this UUID for TTL_MS, and on retry returns
 * the cached bill_id instead of re-creating.
 *
 * In-memory by design — fits 5-10 LAN users with a few bills per minute
 * comfortably under 1 MB even with the slowest TTL (default 60 s).
 * Cleared on server restart, which is OK: a client retrying THROUGH a
 * server restart would also hit the same `unique bill_number` race
 * elsewhere, so there's no new exposure.
 *
 * Per-bucket so different operations (sales, purchase, payment) don't
 * collide on the same key value.
 */

'use strict';

const TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 60_000);
const MAX_ENTRIES = Number(process.env.IDEMPOTENCY_MAX_ENTRIES || 5_000);

const _buckets = new Map();   // bucket -> Map<key, { value, expiresAt }>

function _getBucket(name) {
  let b = _buckets.get(name);
  if (!b) { b = new Map(); _buckets.set(name, b); }
  return b;
}

// Look up a value by bucket + key. Returns undefined for misses /
// expired entries. Expired entries are evicted opportunistically.
function get(bucket, key) {
  if (!key) return undefined;
  const b = _getBucket(bucket);
  const entry = b.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    b.delete(key);
    return undefined;
  }
  return entry.value;
}

// Store a value. Trims oldest entries when the bucket exceeds MAX_ENTRIES.
function set(bucket, key, value) {
  if (!key) return;
  const b = _getBucket(bucket);
  if (b.size >= MAX_ENTRIES) {
    // Evict the oldest insertion (Map keys are insertion-ordered).
    const oldest = b.keys().next().value;
    if (oldest !== undefined) b.delete(oldest);
  }
  b.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

module.exports = { get, set };
