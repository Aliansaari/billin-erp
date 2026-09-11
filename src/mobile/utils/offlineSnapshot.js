/**
 * Offline snapshot — what the phone shows when the shop PC is off.
 *
 * The shop's server is the only source of live data. When it is unreachable
 * (PC off, broadband down, tunnel restarting) the app falls back to the last
 * snapshot the desktop uploaded, and every screen that does so MUST say how
 * old it is. A stale balance presented as current is worse than no balance:
 * it is the kind of number someone extends credit against.
 *
 * Strictly read-only. Nothing here is ever used to build a voucher — issuing
 * an invoice needs the live number series, live stock and a live credit
 * limit, none of which a snapshot can provide.
 */
import { getDeviceToken } from '../../api';
import { controlPlaneUrl } from './controlPlane';



const CACHE_KEY = 'zehen_snapshot_cache';

export function readCachedSnapshot() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}

/**
 * Pull the latest snapshot for a branch. Falls back to the on-device copy
 * when even the control plane is unreachable — a phone with no signal at all
 * should still show last night's figures rather than an empty screen.
 */
export async function fetchSnapshot(siteId) {
  const token = getDeviceToken();
  if (!token) return readCachedSnapshot();

  try {
    const qs = siteId ? `?site_id=${encodeURIComponent(siteId)}` : '';
    const res = await fetch(`${controlPlaneUrl()}/v1/snapshot${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return readCachedSnapshot();
    const body = await res.json();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(body)); } catch {}
    return body;
  } catch {
    return readCachedSnapshot();
  }
}

/**
 * Which company is this session signed into?
 * Returns null when it cannot tell, in which case nothing is blocked.
 */
/* Exported so the on-device mirror partitions its databases by the SAME
 * rule this file uses to decide whose figures may be shown. Two copies of
 * "which company is this session" is precisely how one shop's balances end
 * up under another shop's name. */
export function sessionCompanyId() {
  // The JWT is authoritative: the stored `user` object carries the profile,
  // not the company, and after a company switch the token is the thing that
  // changed. Reading the claim is a base64 decode of our own token — no
  // verification is implied or needed, the server checks the signature on
  // every request; this only decides which saved figures may be shown.
  try {
    const claims = JSON.parse(atob(localStorage.getItem('token').split('.')[1]));
    const id = Number(claims?.company_id);
    if (Number.isFinite(id)) return id;
  } catch { /* no token, or not a JWT — fall through */ }

  try {
    const u = JSON.parse(localStorage.getItem('user') || 'null');
    const id = Number(u?.company_id);
    return Number.isFinite(id) ? id : null;
  } catch { return null; }
}

/**
 * The slice of the snapshot belonging to the company this session is in.
 *
 * A current payload (`format: 2`) carries one entry per company. The phone is
 * signed into exactly one at a time, and rendering any other entry would put
 * someone else's money under this company's name — which is exactly what
 * happened while the snapshot described the primary company and nothing else.
 *
 * Returns null when this company is not in the snapshot at all. That is a real
 * state, not an error: the desktop sheds non-primary companies when the
 * payload will not fit, and a company added since the last push is not in it
 * yet either.
 */
function entryForSession(snapshot) {
  const snap = snapshot?.snapshot;
  if (!snap) return null;
  const mine = sessionCompanyId();

  if (Array.isArray(snap.companies)) {
    if (mine === null) {
      // Cannot tell which company we are in — take the one the snapshot calls
      // primary rather than guessing at the list order.
      return snap.companies.find((e) => e.is_primary) || snap.companies[0] || null;
    }
    return snap.companies.find((e) => Number(e.company_id) === mine) || null;
  }

  /* format 1 — one company's sections at the top level. Kept so the phone
   * still works against a desktop that has not been updated yet. Those
   * snapshots may carry no company stamp at all; they are trusted, because
   * refusing them would blank out every single-company shop on an older
   * desktop and gain nothing. */
  if (!snap.sections) return null;
  const stamped = snap.company_id;
  if (stamped !== undefined && stamped !== null && mine !== null && Number(stamped) !== mine) {
    return null;
  }
  return {
    company_id: stamped ?? mine,
    missing: snap.missing,
    partial: snap.partial,
    sections: snap.sections,
  };
}

/**
 * Are there saved figures for the company the user is looking at?
 *
 * False means the snapshot exists but holds nothing for this company. Screens
 * say so rather than rendering an empty list, which would read as "this
 * company has no stock" instead of "we never saved it".
 */
export function snapshotMatchesSession(snapshot) {
  return entryForSession(snapshot) !== null;
}

/** One section of this company's slice, shaped like the live API response so
 *  a screen can render it without a second code path. */
export function sectionOf(snapshot, key) {
  return entryForSession(snapshot)?.sections?.[key] ?? null;
}

/** True when this section was shed to fit the size cap — the screen should
 *  say "not saved for offline" rather than render an empty list as if the
 *  shop genuinely had no stock. */
export function sectionWasTrimmed(snapshot, key) {
  const missing = entryForSession(snapshot)?.missing;
  return Array.isArray(missing) && missing.includes(key);
}

/** True when this section IS present but holds only the first N rows,
 *  because the full list would not fit the upload cap. The screen may render
 *  it — it just must not imply the list is complete. */
export function sectionIsPartial(snapshot, key) {
  const partial = entryForSession(snapshot)?.partial;
  return Array.isArray(partial) && partial.includes(key);
}

/** Human age of the snapshot, e.g. "12 minutes ago". */
export function snapshotAge(snapshot) {
  const ts = snapshot?.snapshot?.generated_at;
  if (!ts) return '';
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Did this failure mean "the shop server is unreachable"?
 *
 * Two distinct shapes count, and getting this wrong in either direction is
 * costly.
 *
 *   1. A transport error — no response at all (phone has no signal).
 *
 *   2. A response from something IN FRONT of the shop server saying it could
 *      not reach it. This is the common case in production and is easy to
 *      miss: when the billing PC is off, Cloudflare answers the phone with
 *      530 (and 521-524 for the neighbouring failure modes), while a dev
 *      proxy answers 500/502. Treating those as "the server replied" would
 *      mean the offline snapshot never showed at exactly the moment it
 *      exists for.
 *
 * A 4xx is deliberately NOT unreachable: the server answered and said the
 * user is logged out or lacks permission. Papering over that with yesterday's
 * figures would hide a real problem behind numbers that look fine.
 */
const UNREACHABLE_STATUSES = new Set([500, 502, 503, 504, 521, 522, 523, 524, 525, 526, 530]);

export function isUnreachable(err) {
  if (!err) return false;

  const status = err.response?.status ?? err.status;
  if (status) return UNREACHABLE_STATUSES.has(Number(status));

  const msg = String(err.message || '').toLowerCase();
  return /network|timeout|failed to fetch|load failed|econn|abort/.test(msg);
}

/**
 * Turn any thrown request error into something a shopkeeper can act on.
 *
 * axios messages are written for the developer holding the stack trace:
 * "Request failed with status code 530" tells the person at the counter
 * nothing, and 530 in particular is Cloudflare's way of saying the shop PC
 * is not answering — which the app already knows how to explain in words.
 *
 * The server's own `error` text always wins when there is one: it is written
 * for the operator ("Receipt amount ₹25.00 exceeds outstanding balance…")
 * and is more specific than anything that can be inferred out here.
 */
const RAW_AXIOS = /^(request failed with status code|network error|timeout of|xhr error)/i;

export function friendlyError(err, fallback = 'Something went wrong') {
  const fromServer = err?.response?.data?.error || err?.response?.data?.message;
  if (fromServer && typeof fromServer === 'string') return fromServer;

  if (err?.code === 'OFFLINE_READONLY') return err.message;
  if (isUnreachable(err)) return 'Shop computer is not reachable right now';

  const msg = String(err?.message || '');
  if (!msg || RAW_AXIOS.test(msg)) return fallback;
  return msg;
}
