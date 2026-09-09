/**
 * The company's own profile — the single source of truth for its NAME.
 *
 * Three different names exist for the same company and they are not
 * interchangeable:
 *
 *   system_settings.company_name  the business name the owner types into
 *                                 Settings → Company Profile. This is what the
 *                                 desktop shows everywhere, and what belongs
 *                                 on an invoice.
 *   companies.name (master DB)    a short branch label used by the company
 *                                 switcher ("SD", "AD").
 *   users.company_name            historical, often unset.
 *
 * The app was showing the branch label, so a shop that had carefully set
 * "Modern Dresses" still saw "SD" — or, before that, the seeder's placeholder.
 * Fetch the real one and keep it per company, since switching branches must
 * not carry the previous company's name across.
 */
import { settingsAPI } from '../../api';

const KEY = 'zehen_company_profile';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

function activeId() {
  const raw = Number(localStorage.getItem('zehen_company_id'));
  return Number.isFinite(raw) && raw > 0 ? String(raw) : '_';
}

/** Cached profile name for the company currently open, or ''. */
export function profileCompanyName() {
  const entry = readAll()[activeId()];
  return entry?.company_name || '';
}

export function profileCompanyMeta() {
  const entry = readAll()[activeId()] || {};
  return { gstin: entry.gstin || '', city: entry.city || '' };
}

/**
 * Refresh from the server. Safe to call on every app start and after a
 * company switch; failures are swallowed because a missing display name must
 * never block the screen behind it.
 */
export async function refreshCompanyProfile() {
  try {
    const res = await settingsAPI.getSystem();
    const s = res.data?.data || res.data || {};
    const name = String(s.company_name || '').trim();
    if (!name) return '';

    const all = readAll();
    all[activeId()] = {
      company_name: name,
      gstin: s.gstin || s.company_gstin || '',
      city: s.company_city || s.city || '',
    };
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode */ }
    return name;
  } catch {
    return '';
  }
}

/** Forget everything — used on sign-out so the next user starts clean. */
export function clearCompanyProfile() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
