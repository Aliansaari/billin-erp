import api from '../api';
import useAuthStore from '../store/authStore';

/*
 * Session keeper — an open, in-use ZEHEN never signs itself out.
 *
 * Sign-in sessions last 24 hours. A counter left signed in overnight (the PC
 * switched off instead of exiting ZEHEN) used to keep yesterday's session,
 * and it ran out at the same time the next day, in the middle of billing:
 * "Access token required", the bill on screen gone. Now, while ZEHEN is open
 * it trades a still-valid session for a fresh 24-hour one — at start-up,
 * every 10 minutes, when the window comes back into focus (the PC woke from
 * sleep) and when the network returns.
 *
 * A session that has already expired is left alone: that needs a real
 * sign-in, and the 401 handler takes care of it.
 */
const EVERY_MS = 10 * 60 * 1000;
const MIN_AGE_S = 20 * 60;          // don't renew a session issued in the last 20 minutes

function claims(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')));
  } catch { return null; }
}

let busy = false;
export async function renewSession({ force = false } = {}) {
  if (busy) return;
  const token = localStorage.getItem('token');
  if (!token) return;
  if (localStorage.getItem('zehen_offline_mode') === '1') return;
  if (localStorage.getItem('must_change_password') === '1') return;
  const c = claims(token);
  if (!c || !c.exp) return;
  const now = Date.now() / 1000;
  if (c.exp <= now + 5) return;                         // already over: needs a real sign-in
  if (!force && c.iat && now - c.iat < MIN_AGE_S) return;
  busy = true;
  try {
    const { data } = await api.post('/auth/refresh');
    // Only replace the token we renewed — the user may have signed out or
    // switched company while the request was in flight.
    if (data?.token && localStorage.getItem('token') === token) {
      localStorage.setItem('token', data.token);
      try { useAuthStore.setState({ token: data.token }); } catch { /* store not ready */ }
    }
  } catch { /* server unreachable: try again on the next tick */ }
  finally { busy = false; }
}

let started = false;
export function startSessionKeeper() {
  if (started || typeof window === 'undefined') return;
  started = true;
  renewSession();
  setInterval(() => renewSession(), EVERY_MS);
  window.addEventListener('focus', () => renewSession());
  window.addEventListener('online', () => renewSession());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renewSession(); });
}
