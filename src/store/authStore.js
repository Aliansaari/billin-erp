import { create } from 'zustand';

// `must_change_password` is set by the server when the user is logging in with
// a well-known default password (e.g. the seeded admin/admin123). The UI uses
// this flag to force a change-password redirect before any other route is
// reachable — we treat shipping with a default password as a hard failure
// for production readiness.
const readFlag = () => localStorage.getItem('must_change_password') === '1';

// Defensive JSON read — an earlier bug (or manual devtools tampering) could
// leave the literal string "undefined" under this key; JSON.parse('undefined')
// throws and would blank the entire app on boot. Swallowing the error and
// returning null is the right call: worst case the user has to log in again.
function readUser() {
  const raw = localStorage.getItem('user');
  if (!raw || raw === 'undefined' || raw === 'null') return null;
  try { return JSON.parse(raw); }
  catch { localStorage.removeItem('user'); return null; }
}

/* ── Offline mode (mobile) ──────────────────────────────────────────────
 *
 * When the shop's computer is switched off, its server is unreachable and no
 * session can be minted — the app previously just failed at sign-in with a
 * raw gateway error, which made it look like the whole product needed the
 * shop's Wi-Fi after all.
 *
 * Instead we let the person in READ-ONLY, backed by the last snapshot the
 * desktop uploaded. There is no token, so nothing can be written: every
 * screen either renders snapshot data or says it needs the shop computer.
 * The banner stays on screen for as long as the stale figures do.
 */
const readOffline = () => localStorage.getItem('zehen_offline_mode') === '1';

const useAuthStore = create((set) => ({
  user: readUser(),
  token: localStorage.getItem('token') || null,
  // An offline session counts as authenticated for routing purposes — the
  // person proved who they are against the account service — but it carries
  // no token, so the API layer can never write anything.
  isAuthenticated: !!localStorage.getItem('token') || readOffline(),
  offline: readOffline(),
  mustChangePassword: readFlag(),

  login: (user, token, mustChangePassword = false) => {
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('token', token);
    localStorage.removeItem('zehen_offline_mode');
    if (mustChangePassword) localStorage.setItem('must_change_password', '1');
    else localStorage.removeItem('must_change_password');
    set({ user, token, isAuthenticated: true, offline: false, mustChangePassword: !!mustChangePassword });
  },

  /** Sign in read-only against the last uploaded snapshot. */
  loginOffline: (user) => {
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('zehen_offline_mode', '1');
    // Deliberately no token: an offline session must not be able to write,
    // and leaving a stale one here would let requests through the moment the
    // shop came back without re-checking anything.
    localStorage.removeItem('token');
    localStorage.removeItem('must_change_password');
    set({ user, token: null, isAuthenticated: true, offline: true, mustChangePassword: false });
  },

  // Cleared once the user successfully rotates their password.
  clearMustChangePassword: () => {
    localStorage.removeItem('must_change_password');
    set({ mustChangePassword: false });
  },

  logout: () => {
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    localStorage.removeItem('must_change_password');
    // Drop the FY cache too — next user might be in a different
    // company/FY, and we don't want their pickers showing the
    // previous user's FY values during the brief window before login.
    localStorage.removeItem('zehen_offline_mode');
    try { localStorage.removeItem('fy_start_v1'); localStorage.removeItem('fy_end_v1'); } catch {}
    set({ user: null, token: null, isAuthenticated: false, offline: false, mustChangePassword: false });
  },

  updateUser: (user) => {
    localStorage.setItem('user', JSON.stringify(user));
    set({ user });
  },
}));

export default useAuthStore;
