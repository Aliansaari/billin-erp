/**
 * Who am I, and whose books am I looking at?
 *
 * Both answers were being invented when the real value was missing: the side
 * panel showed a literal "My Company", and it manufactured an email address
 * like `admin@zehen.in` for any user without one — which looks exactly like a
 * real address and is not. Showing nothing is better than showing a plausible
 * lie in a financial app.
 */

/** Companies this sign-in can open, as stored at login. */
export function storedCompanies() {
  try { return JSON.parse(localStorage.getItem('zehen_companies') || '[]'); } catch { return []; }
}

export function activeCompanyId() {
  const raw = Number(localStorage.getItem('zehen_company_id'));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Name of the company currently open. Resolution order runs from most
 * authoritative to least; returns '' rather than a placeholder so callers can
 * decide what an unknown company should look like.
 */
/** Names the first-run seeder writes; they are placeholders, not real names. */
const SEEDED_PLACEHOLDERS = new Set(['my company', 'company', 'default company', '']);
const isPlaceholder = (n) => SEEDED_PLACEHOLDERS.has(String(n || '').trim().toLowerCase());

export function activeCompanyName(currentCompany, user) {
  // A company whose profile was never filled in still carries the seeder's
  // "My Company". Showing that is worse than showing the branch label the
  // owner actually chose, so treat the placeholder as absent.
  const fromProfile = currentCompany?.company_name;
  if (fromProfile && !isPlaceholder(fromProfile)) return fromProfile;

  const id = activeCompanyId();
  const match = storedCompanies().find((c) => c.company_id === id);
  if (match?.name) return match.name;

  // A single-company install still knows its one company.
  const all = storedCompanies();
  if (all.length === 1 && all[0]?.name) return all[0].name;

  try {
    const stored = localStorage.getItem('zehen_last_company_name');
    if (stored) return stored;
  } catch { /* private mode */ }

  const fromUser = user?.company_name;
  if (fromUser && !isPlaceholder(fromUser)) return fromUser;

  // Last resort: the placeholder itself is still better than an empty header,
  // but callers can spot it and offer to set a real name.
  return isPlaceholder(fromProfile) ? '' : '';
}

/**
 * A contact line for the signed-in user — their real email, or their real
 * phone, or their role. Never a synthesised address.
 */
/**
 * Addresses the first-run seeder writes. They are real rows in the database,
 * but they are not anyone's address — showing one looks like the app invented
 * an account, which is exactly how it reads to an owner who never set one.
 */
const SEEDED_EMAILS = new Set([
  'admin@company.com', 'admin@example.com', 'user@company.com',
  'admin@zehen.in', 'admin@localhost',
]);

export function userContactLine(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (email && email.includes('@') && !SEEDED_EMAILS.has(email)) {
    return String(user.email).trim();
  }

  const phone = String(user?.mobile_number || user?.phone || '').trim();
  if (phone) return phone;

  return user?.role || '';
}
