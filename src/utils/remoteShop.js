/**
 * Working in another shop from this computer.
 *
 * A ZEHEN install is welded to its own Postgres, so "open another shop" can
 * never mean "ask this server for that shop's data" — it means pointing this
 * renderer at THAT shop's server over its tunnel, exactly as the phone does.
 * That is why cross-shop needs no sync engine: each shop's own server stays
 * the only writer of its stock, its invoice numbers and its ledger, so a
 * purchase entered from another counter cannot duplicate a number or oversell
 * a shelf. This computer is just a client that changed address.
 *
 * Each shop is its own organisation in the control plane, so each is reached
 * with ITS OWN account (email or phone + password). Signing in to a shop tells
 * us three things: a device token for that shop's tunnel gate, the shop's
 * hostname, and a one-shot assertion to trade for a real session on it.
 *
 * The session on THIS computer is saved before we leave and restored when we
 * come back, so stepping over to another shop and back does not cost the
 * owner a re-login on their own machine.
 */
import axios from 'axios';
import {
  SERVER_URL_KEY, setDeviceToken, getServerUrl, setServerUrl,
} from '../api';
import { controlPlaneUrl, installId } from '../mobile/utils/controlPlane';

/** The shop this renderer is currently pointed at, when it is not our own. */
const REMOTE_KEY   = 'zehen_remote_shop';
/** Where "come back" goes: this computer's own server URL. */
const HOME_URL_KEY = 'zehen_home_server_url';
/** The session we had on this computer before leaving. */
const HOME_SESSION_KEY = 'zehen_home_session';
/** Shops signed into before, so returning to one is a click, not a password. */
const SHOPS_KEY = 'zehen_known_shops';
/** Device tokens are per shop — one token cannot open another shop's gate. */
const TOKENS_KEY = 'zehen_shop_tokens';

const read = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k) || 'null') ?? fallback; }
  catch { return fallback; }
};
const write = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ }
};

/** { site_id, hostname, name, identifier } while away, null while home. */
export function getRemoteShop() { return read(REMOTE_KEY, null); }
export function isRemoteShop()  { return !!getRemoteShop(); }

/** Shops signed into before on this computer, most recent first. */
export function getKnownShops() {
  const list = read(SHOPS_KEY, []);
  return Array.isArray(list) ? list : [];
}

function rememberShop(shop) {
  const list = getKnownShops().filter((s) => s.site_id !== shop.site_id);
  list.unshift({ ...shop, last_used: Date.now() });
  write(SHOPS_KEY, list.slice(0, 8));
}

/** Forget a shop entirely — its saved login and its device token. */
export function forgetShop(siteId) {
  write(SHOPS_KEY, getKnownShops().filter((s) => s.site_id !== siteId));
  const tokens = read(TOKENS_KEY, {});
  delete tokens[siteId];
  write(TOKENS_KEY, tokens);
}

function tokenFor(siteId) { return read(TOKENS_KEY, {})[siteId] || ''; }
function storeToken(siteId, token) {
  const tokens = read(TOKENS_KEY, {});
  tokens[siteId] = token;
  write(TOKENS_KEY, tokens);
}

/**
 * Sign in to a shop's account and open it on this computer.
 *
 * Nothing is changed until the shop's own server has issued a session: a
 * half-applied switch — this computer pointed at another shop but not signed
 * in to it — is the state most likely to end with a bill in the wrong books.
 */
export async function connectToShop({ identifier, password }) {
  const id = String(identifier || '').trim();
  if (!id || !password) throw new Error('Enter the shop’s sign-in and password.');

  const { data: acct } = await axios.post(`${controlPlaneUrl()}/v1/account/login`, {
    identifier: id,
    password,
    platform: 'desktop',
    // Keyed on (account, install), so signing in again from this computer
    // reuses its device slot instead of evicting the owner's phone.
    install_id: installId(),
  }, { timeout: 25000 });

  const site = acct?.site;
  if (!site?.hostname) {
    throw new Error('That shop’s computer has not been set up for remote access yet.');
  }

  // Trade the assertion for a real session ON that shop's server. Done before
  // anything local changes, so a failure here leaves this computer untouched.
  const { data: session } = await axios.post(
    `https://${site.hostname}/api/auth/sso`,
    { assertion: acct.assertion },
    { headers: { 'X-Zehen-Device': acct.device_token }, timeout: 25000 },
  );
  if (!session?.token || !session?.user) throw new Error('Sign-in failed on that shop’s computer.');

  applyShop({
    site_id: site.site_id,
    hostname: site.hostname,
    name: site.name || site.hostname,
    identifier: acct.account?.identifier || id,
  }, acct.device_token, session);

  return { site, session, sites: acct.sites || [] };
}

/* There is deliberately no silent reconnect.
 *
 * A device token would be enough to mint an assertion, and an assertion buys
 * a full session with write access to that shop's books. Today a device token
 * on its own opens only the tunnel gate and the read-only snapshot — the
 * password is what buys a session. Trading the token for one would mean a
 * copied localStorage folder could bill into someone's shop, so opening a
 * shop asks for its password every time. The remembered entry supplies the
 * name and pre-fills the sign-in; the password stays a password. */

/** Commit the switch: remember home, point at the shop, take its session. */
function applyShop(shop, deviceToken, session) {
  // Remember this computer exactly once — a second hop (shop A → shop B)
  // must still come home to US, not to shop A.
  if (!isRemoteShop()) {
    try {
      localStorage.setItem(HOME_URL_KEY, getServerUrl() || '');
      write(HOME_SESSION_KEY, {
        token: localStorage.getItem('token'),
        user: localStorage.getItem('user'),
      });
    } catch { /* private mode */ }
  }

  storeToken(shop.site_id, deviceToken);
  rememberShop(shop);
  write(REMOTE_KEY, shop);

  setDeviceToken(deviceToken);
  setServerUrl(`https://${shop.hostname}`);
  localStorage.setItem('token', session.token);
  localStorage.setItem('user', JSON.stringify(session.user));

  // Anything cached under a bare key belongs to the shop we are leaving.
  for (const k of ['zehen_last_company', 'zehen_last_company_name', 'zehen_company_profile']) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

/**
 * Come back to this computer.
 *
 * Restores the session we had here, so the owner is not asked to sign in to
 * their own machine after stepping across to another shop. If that session
 * expired while we were away they land on the sign-in screen, which is the
 * honest outcome rather than a half-authenticated one.
 */
export function returnHome() {
  const homeUrl = localStorage.getItem(HOME_URL_KEY);
  const saved = read(HOME_SESSION_KEY, null);

  if (homeUrl) setServerUrl(homeUrl);
  else { try { localStorage.removeItem(SERVER_URL_KEY); } catch { /* ignore */ } }

  if (saved?.token && saved?.user) {
    localStorage.setItem('token', saved.token);
    localStorage.setItem('user', saved.user);
  } else {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }

  // The device token is per shop; ours is not one, so clear the active slot.
  setDeviceToken('');

  for (const k of [REMOTE_KEY, HOME_SESSION_KEY, HOME_URL_KEY,
                   'zehen_last_company', 'zehen_last_company_name', 'zehen_company_profile']) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}
