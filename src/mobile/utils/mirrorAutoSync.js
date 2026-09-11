/**
 * Keeping the mirror current, without keeping the phone busy.
 *
 * ── THE IDEA ─────────────────────────────────────────────────────────
 *
 * Pulling a 30,000-item catalogue every few minutes would be absurd: 0.7 MB
 * a time, on a connection the shop pays for, to discover that nothing
 * changed. So the loop does not pull — it ASKS.
 *
 * /mirror/checksum returns about a hundred bytes: a row count and the sums
 * the device already holds. If they match, the mirror is provably current
 * and there is nothing to do. Only a disagreement triggers a full pull.
 *
 * The result is that "current" costs roughly a hundred bytes per set per
 * tick, and the expensive transfer happens exactly when something actually
 * changed. This is the same checksum that guards correctness, used a second
 * time to decide freshness — which is why it can be trusted for this: the
 * device is not guessing whether it is stale, it is comparing.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────
 *
 * It never syncs while the app is in the background. iOS throttles timers
 * there anyway, and a sync that half-runs as the app is suspended is exactly
 * how a partially-written set would arise — the one failure the atomic
 * rewrite exists to prevent. Work happens on resume instead, when the app is
 * alive and the user is about to look at something.
 *
 * It never runs two syncs at once, and it backs off when the shop is
 * unreachable rather than retrying on a fixed beat into a PC that is off.
 */
import { syncSet, confirmSet, mirrorState } from './mirrorSync';
import { mirrorAvailable } from './mirrorDb';

const SETS = ['parties', 'products'];

/* How often to ASK. Not how often to pull — asking is ~100 bytes. */
const TICK_MS = 3 * 60_000;

/* After a failure, wait longer each time rather than hammering a shop PC
 * that is switched off. Capped so a shop coming back online is noticed
 * within a few minutes rather than an hour. */
const BACKOFF_MS = [30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];

let timer = null;
let stop = () => {};       // set when the loop starts
let running = false;        // one sync at a time, ever
let failures = 0;
let nextAllowedAt = 0;
let listeners = [];

const notify = () => { listeners.forEach((f) => { try { f(); } catch {} }); };

/* Whether a sync is in flight right now.
 *
 * Exposed because the first one on a large shop is not instant — tens of
 * thousands of rows have to arrive and be written — and during it the mirror
 * is legitimately empty. Without this the footer says "not synced", which is
 * true and reads as broken. "Syncing" is the same fact told usefully. */
export const isSyncing = () => running;

/* Why the last pass failed, or null. Surfaced in the side panel because the
 * two likeliest causes — the PC is off, the PC is on an older build — look
 * identical from the outside and have completely different remedies. */
let lastReason = null;
export const lastSyncProblem = () => lastReason;

/** Subscribe to "the mirror changed" so a screen can refresh itself. */
export function onMirrorUpdated(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

/**
 * One pass over every set.
 *
 * `force` skips the backoff and the cheap check, and is what an explicit
 * user action uses — pull-to-refresh means "go and look", not "go and look
 * if you feel like it".
 */
export async function syncTick({ force = false } = {}) {
  if (!mirrorAvailable()) return { skipped: 'not native' };
  if (running) return { skipped: 'already running' };
  if (!force && Date.now() < nextAllowedAt) return { skipped: 'backing off' };
  if (document.visibilityState === 'hidden') return { skipped: 'backgrounded' };

  running = true;
  notify();                 // so a watcher can show "syncing" at once
  const result = {};
  let changed = false;
  let unreachable = false;

  try {
    for (const set of SETS) {
      const { trusted } = await mirrorState(set);

      /* Never synced, or the last attempt left it untrusted — a cheap
       * checksum cannot repair either, so go straight to a full pull. */
      if (!trusted || force) {
        const r = await syncSet(set);
        result[set] = r;
        if (r.ok) changed = true;
        if (r.reason === 'shop unreachable') unreachable = true;
        continue;
      }

      const c = await confirmSet(set);
      if (c.state === 'current') { result[set] = { ok: true, unchanged: true }; continue; }
      if (c.state === 'unreachable') { result[set] = { ok: false, reason: 'shop unreachable' }; unreachable = true; continue; }
      if (c.state === 'unsupported') {
        // The desktop predates the mirror endpoints. Pulling would 404 too,
        // so back off rather than spending a request proving it again.
        result[set] = { ok: false, reason: 'shop PC is on an older build' };
        unreachable = true;
        continue;
      }

      // 'changed' or 'unknown' — the hundred-byte check says the device and
      // the shop disagree, so now the transfer is worth its cost.
      const r = await syncSet(set);
      result[set] = r;
      if (r.ok) changed = true;
      if (r.reason === 'shop unreachable') unreachable = true;
    }
  } finally {
    running = false;
    notify();
  }

  lastReason = Object.values(result).find((r) => r && r.ok === false)?.reason || null;

  if (unreachable) {
    nextAllowedAt = Date.now() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
    failures += 1;
  } else {
    failures = 0;
    nextAllowedAt = 0;
  }

  return result;
}

/**
 * Start the loop. Safe to call more than once; returns a stop function.
 *
 * Mounted for the authenticated session only — there is nothing to mirror
 * before a company is known, and syncing on the login screen would be a
 * request for someone else's data.
 */
export function startAutoSync() {
  if (!mirrorAvailable()) return () => {};
  if (timer) return stop;

  failures = 0; nextAllowedAt = 0; lastReason = null;
  // At once on start: the first thing after opening the app is usually
  // looking at something, and that should not be the moment a stale figure
  // is read out.
  syncTick();

  timer = setInterval(() => { syncTick(); }, TICK_MS);

  /* Resume is the important trigger, not the timer.
   *
   * A phone goes in a pocket at 11am and comes out at 4pm. iOS has been
   * throttling or suspending timers the whole time, so the interval cannot
   * be relied on to have run — but the app is alive again now, and the
   * operator is about to look at something. */
  /* Coming back clears the backoff before retrying.
   *
   * The backoff exists so a switched-off PC is not hammered on a fixed beat,
   * and it grows to ten minutes. But it also outlives the thing it was
   * waiting for: fix the shop — update it, turn it on, plug the router back
   * in — and the app would sit out the rest of the delay still reporting the
   * old failure, which reads as the fix not having worked. Someone opening
   * the app is the best signal available that circumstances changed. */
  const retryNow = () => { failures = 0; nextAllowedAt = 0; lastReason = null; syncTick(); };

  const onResumed = retryNow;
  window.addEventListener('zehen:resumed', onResumed);

  const onVisible = () => {
    if (document.visibilityState === 'visible') retryNow();
  };
  document.addEventListener('visibilitychange', onVisible);

  stop = () => {
    clearInterval(timer);
    timer = null;
    window.removeEventListener('zehen:resumed', onResumed);
    document.removeEventListener('visibilitychange', onVisible);
    stop = () => {};
  };
  return stop;
}
