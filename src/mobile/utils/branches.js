/**
 * Branch (multi-site) support for the mobile app.
 *
 * A ZEHEN customer may run several shops, each with its own billing PC, its
 * own Postgres and its own tunnel. Switching branch therefore means pointing
 * the app at a DIFFERENT SERVER — not asking one server for another shop's
 * data.
 *
 * That is the whole reason cross-branch needed no sync engine: branch B's
 * own server stays the only writer of B's stock, invoice numbers and ledger,
 * so billing into B from a phone in A cannot produce a duplicate number or
 * oversell a shelf. The phone is just a client that changed address.
 *
 * The device token is issued per PHONE and scoped to the ORG, so it works
 * against every branch the licence permits and does not change on switch.
 */
import { setServerUrl, getServerUrl, getDeviceToken } from '../../api';
import { controlPlaneUrl } from './controlPlane';



const ACTIVE_SITE_KEY = 'zehen_active_site';
const SITES_CACHE_KEY = 'zehen_sites_cache';

export function getActiveSiteId() {
  try { return localStorage.getItem(ACTIVE_SITE_KEY) || ''; } catch { return ''; }
}

/** Last known branch list, so the switcher renders instantly and still works
 *  when the control plane is briefly unreachable. */
export function getCachedSites() {
  try { return JSON.parse(localStorage.getItem(SITES_CACHE_KEY) || '[]'); } catch { return []; }
}

/**
 * Ask the control plane which branches this phone may open.
 *
 * Returns only sites whose DNS the control plane has verified as live, so
 * the app can never be handed a hostname that does not resolve yet. Throws
 * when the device is unpaired or its access was revoked — the caller should
 * surface that rather than silently showing an empty list.
 */
export async function fetchSites() {
  const token = getDeviceToken();
  if (!token) throw new Error('This phone is not paired yet.');

  const res = await fetch(`${controlPlaneUrl()}/v1/sites`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not load your branches.');

  const sites = Array.isArray(body.sites) ? body.sites : [];
  try { localStorage.setItem(SITES_CACHE_KEY, JSON.stringify(sites)); } catch {}
  return { sites, crossBranch: !!body.cross_branch };
}

/**
 * Point the app at another branch.
 *
 * A hard reload is deliberate rather than lazy. Every store in the app holds
 * data from the previous branch — parties, products, the open day book — and
 * quietly swapping the base URL underneath them would leave one branch's
 * figures on screen while writes went to another. For money, a visible
 * restart is the honest behaviour.
 */
export function switchToSite(site) {
  if (!site?.hostname) return false;
  const next = `https://${site.hostname}`;
  if (getServerUrl() === next) return false;

  try { localStorage.setItem(ACTIVE_SITE_KEY, site.site_id || ''); } catch {}
  // Anything cached from the branch we are leaving must not survive.
  try {
    localStorage.removeItem('zehen_last_company');
    localStorage.removeItem('zehen_last_company_name');
  } catch {}
  setServerUrl(next);
  return true;
}
