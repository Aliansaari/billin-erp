// ── useVirtualizedReport ───────────────────────────────────────────────
//
// Data layer for any long-list page (Sales/Purchase/Day Book/PaymentList/
// ProductList/etc). Pairs with <VirtualReportTable> in src/components.
//
// Goal: the user perceives a single seamless list of N rows even when N
// is in the hundreds of thousands. Server returns a `total` up front; we
// allocate a sparse client-side view sized to `total`, and lazily fetch
// chunks as the user scrolls. While a chunk is in flight, missing slots
// render as skeleton placeholders. Prefetching one chunk ahead masks all
// but the very first network round-trip.
//
// Usage:
//
//   const {
//     rows, totalCount, summary, ensureChunk, loading, refresh,
//   } = useVirtualizedReport({
//     fetcher: ({ page, limit, ...filters }) =>
//       reportAPI.getSalesReport({ page, limit, ...filters }),
//     filters,
//     chunkSize: 200,
//   });
//
//   // Hand `rows`, `totalCount`, and `ensureChunk` to <VirtualReportTable>.
//
// Server contract:
//   fetcher must return { data: { data: Row[], total: number, summary?: object } }
//   — i.e. an axios response whose body has `data` (the chunk), `total`
//   (the full filtered count), and optionally `summary` (aggregates over
//   the entire filtered set, not just the page). Existing report endpoints
//   in this codebase already match this shape.
//
// Invalidation:
//   When `filters` (deep-equal via JSON.stringify) changes, the cache is
//   cleared and the first chunk is re-fetched. There is also a 60-second
//   freshness window on the most-recently-used cache key — if the user
//   filters away and back within 60s, scroll position is lost but rows
//   are reused (no re-fetch). Older keys are dropped to keep memory
//   bounded across many filter changes.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';

// ── Tunable constants ──────────────────────────────────────────────────
//
// CHUNK_SIZE_DEFAULT: balanced between request volume and per-request
// payload. 200 keeps a typical payload under 100 KB so even a slow LAN
// link returns a chunk under 100 ms.
//
// PREFETCH_DISTANCE: number of chunks AHEAD of the visible range to
// prefetch. 1 is enough on LAN; 2 hides cloud RTTs on aggressive scrolls
// without wasting bandwidth. Set to 2 by default.
//
// CACHE_TTL_MS: how long a stale cache key stays in memory. After this,
// the chunk Map is dropped on next filter change. 60 s is the typical
// "user is comparing two filters" window; anything longer just leaks.
//
// MAX_CACHED_KEYS: upper bound on distinct filter snapshots kept warm.
// Caps memory if the user thrashes through many filter combinations.
const CHUNK_SIZE_DEFAULT = 200;
const PREFETCH_DISTANCE  = 2;
const CACHE_TTL_MS       = 60_000;
const MAX_CACHED_KEYS    = 4;

// Singleton placeholder shared across the entire app — every "still
// loading" row reference-equals this object so React diffing is cheap
// and memory stays bounded. The wrapper component checks `__loading`
// to decide whether to render skeleton cells.
export const PLACEHOLDER_ROW = Object.freeze({ __loading: true });

export function useVirtualizedReport({
  fetcher,
  filters,
  chunkSize = CHUNK_SIZE_DEFAULT,
  // If the caller already knows the total (e.g. computed elsewhere) it
  // can pass `initialTotal` so the sparse view is allocated before the
  // first fetch resolves. Optional — server response is the source of
  // truth either way.
  initialTotal = 0,
}) {
  // Per-cacheKey state lives in a ref-backed dictionary. We don't use
  // useState for chunks because the data structure is mutated in place
  // (Map.set) — re-renders are triggered explicitly via a version bump.
  const cacheRef = useRef(new Map()); // cacheKey -> { chunks: Map, total, summary, lastUsed }
  const inFlightRef = useRef(new Map()); // `${cacheKey}:${chunkIdx}` -> Promise

  const [version, setVersion]       = useState(0);
  const [totalCount, setTotalCount] = useState(initialTotal);
  const [summary, setSummary]       = useState({});
  // `meta` holds everything from the response body except `data` and
  // `total` — i.e. summary + reconciliation + any future ad-hoc fields
  // the report controller wants to surface alongside paginated rows.
  // Pages that need more than just `summary` (e.g. SalesReport's
  // reconciliation banner) read from here.
  const [meta, setMeta]             = useState({});
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);

  // Stable cache key from filters. JSON.stringify is good enough — every
  // value we send to the server is JSON-serialisable by construction.
  const cacheKey = useMemo(() => JSON.stringify(filters || {}), [filters]);

  // Latest values captured for the fetch loop (avoids re-creating
  // ensureChunk on every render and breaking the inFlight dedupe map).
  const fetcherRef  = useRef(fetcher);
  const filtersRef  = useRef(filters);
  const cacheKeyRef = useRef(cacheKey);
  useEffect(() => { fetcherRef.current  = fetcher;  }, [fetcher]);
  useEffect(() => { filtersRef.current  = filters;  }, [filters]);
  useEffect(() => { cacheKeyRef.current = cacheKey; }, [cacheKey]);

  // Internal fetch. Idempotent on (cacheKey, chunkIdx) via inFlightRef.
  const fetchChunk = useCallback(async (chunkIdx) => {
    const key = cacheKeyRef.current;
    const k = `${key}:${chunkIdx}`;

    // Already in flight — return the existing promise so callers
    // collapse onto the same fetch.
    if (inFlightRef.current.has(k)) return inFlightRef.current.get(k);

    // Already resolved and present — done.
    const entry = cacheRef.current.get(key);
    if (entry && entry.chunks.has(chunkIdx)) return entry.chunks.get(chunkIdx);

    const promise = (async () => {
      try {
        const res = await fetcherRef.current({
          ...(filtersRef.current || {}),
          page:  chunkIdx + 1,
          limit: chunkSize,
        });
        const body = res?.data || {};
        const rows  = body.data    || [];
        const total = body.total   != null ? body.total : rows.length;
        const sum   = body.summary || {};
        // Strip data + total + page from the body; everything else is
        // metadata the consuming page may want (reconciliation, gstin
        // mismatch counts, etc.).
        const { data: _d, total: _t, page: _p, ...rest } = body;
        const metaPayload = rest;

        // Race guard: if the cacheKey changed during the fetch (user
        // switched filters mid-flight), drop the result on the floor.
        // The new filter's own first-chunk fetch is already running.
        if (cacheKeyRef.current !== key) return rows;

        let e = cacheRef.current.get(key);
        if (!e) {
          e = { chunks: new Map(), total: 0, summary: {}, meta: {}, lastUsed: 0 };
          cacheRef.current.set(key, e);
        }
        e.chunks.set(chunkIdx, rows);
        e.total    = total;
        e.summary  = sum;
        e.meta     = metaPayload;
        e.lastUsed = Date.now();

        // Bound memory: prune oldest cache keys past the limit.
        if (cacheRef.current.size > MAX_CACHED_KEYS) {
          const entries = [...cacheRef.current.entries()]
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
          while (cacheRef.current.size > MAX_CACHED_KEYS) {
            cacheRef.current.delete(entries.shift()[0]);
          }
        }

        // Only push state for the active key — stale fetches from a
        // previous filter are kept warm in cache but don't trigger
        // re-renders against the current view.
        if (cacheKeyRef.current === key) {
          setTotalCount(total);
          setSummary(sum);
          setMeta(metaPayload);
          setVersion((v) => v + 1);
        }
        return rows;
      } catch (err) {
        if (cacheKeyRef.current === key) setError(err);
        throw err;
      } finally {
        inFlightRef.current.delete(k);
      }
    })();

    inFlightRef.current.set(k, promise);
    return promise;
  }, [chunkSize]);

  // Public API — given a row index (0-based), make sure its chunk plus
  // PREFETCH_DISTANCE following chunks are loaded. Cheap when already
  // present (Map lookups). Caller is the table component, which calls
  // this whenever the visible range changes during scroll.
  const ensureChunk = useCallback((rowIdx) => {
    if (rowIdx < 0) return;
    const total = cacheRef.current.get(cacheKeyRef.current)?.total ?? totalCount;
    if (total > 0 && rowIdx >= total) return;

    const startChunk = Math.max(0, Math.floor(rowIdx / chunkSize));
    const lastChunk  = total > 0
      ? Math.floor((total - 1) / chunkSize)
      : startChunk + PREFETCH_DISTANCE;

    for (let c = startChunk; c <= Math.min(lastChunk, startChunk + PREFETCH_DISTANCE); c++) {
      // Fire and forget — errors land in setError, fetchChunk dedupes.
      fetchChunk(c).catch(() => { /* surfaced via state.error */ });
    }
  }, [chunkSize, totalCount, fetchChunk]);

  // Filter change → reset visible state and kick off chunk 0. We DON'T
  // wipe cacheRef — a recently-used filter that the user toggles back
  // to is reused without re-fetching (within MAX_CACHED_KEYS).
  useEffect(() => {
    setError(null);
    const cached = cacheRef.current.get(cacheKey);
    const fresh  = cached && (Date.now() - cached.lastUsed < CACHE_TTL_MS);

    if (fresh) {
      // Reuse: surface the cached values immediately.
      cached.lastUsed = Date.now();
      setTotalCount(cached.total);
      setSummary(cached.summary);
      setMeta(cached.meta || {});
      setVersion((v) => v + 1);
      return;
    }

    // Cold or stale — reset and fetch chunk 0.
    setTotalCount(initialTotal);
    setSummary({});
    setMeta({});
    setVersion((v) => v + 1);
    setLoading(true);
    fetchChunk(0).finally(() => {
      // Only clear the spinner if the user hasn't filtered again.
      if (cacheKeyRef.current === cacheKey) setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Sparse rows view — length === totalCount, missing slots === PLACEHOLDER_ROW.
  // Rebuilt only when version / totalCount / chunkSize / cacheKey change
  // (NOT on every render of the consuming component).
  const rows = useMemo(() => {
    if (!totalCount) return [];
    const arr = new Array(totalCount);
    const entry = cacheRef.current.get(cacheKey);
    const chunks = entry ? entry.chunks : null;

    for (let i = 0; i < totalCount; i++) {
      const cIdx = Math.floor(i / chunkSize);
      const off  = i - cIdx * chunkSize;
      const c    = chunks ? chunks.get(cIdx) : null;
      arr[i] = (c && c[off]) || PLACEHOLDER_ROW;
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, totalCount, chunkSize, cacheKey]);

  // Force a full reload (ignores cache). Used by an explicit "Refresh"
  // button or after a mutation the page knows invalidates the data.
  const refresh = useCallback(() => {
    cacheRef.current.delete(cacheKeyRef.current);
    setError(null);
    setTotalCount(initialTotal);
    setSummary({});
    setMeta({});
    setVersion((v) => v + 1);
    setLoading(true);
    fetchChunk(0).finally(() => setLoading(false));
  }, [fetchChunk, initialTotal]);

  return { rows, totalCount, summary, meta, ensureChunk, loading, error, refresh };
}
