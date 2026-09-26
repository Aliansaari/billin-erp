/* ── Where "Back" goes ────────────────────────────────────────────────
 *
 * Esc in ZEHEN closes the screen you are on and moves ONE step up the
 * menu tree, exactly like the accounting software this replaces: voucher
 * → register → Home, and at Home it stops. Two people pressing Esc on
 * the same screen always land in the same place.
 *
 * WHY NOT BROWSER HISTORY
 *
 * Esc used to be `navigate(-1)` — a browser Back button. It felt like a
 * glitch rather than software, for three reasons:
 *
 *   1. It replayed the session. Open a bill, close it, open another,
 *      close it, and Esc walked back through every screen you had
 *      already finished with, in reverse, for as long as you kept
 *      pressing. There was no "the screen is closed, we're done".
 *   2. The destination depended on how you arrived, so the same key on
 *      the same screen did something different each time.
 *   3. It never terminated — history has no top, so Esc kept going.
 *
 * Walking a fixed tree fixes all three: it is predictable, it is short
 * (two or three presses from anywhere to Home), and it ends.
 *
 * HOW A DESTINATION IS RESOLVED, in order:
 *
 *   1. The screen's own declared Back (an ActionStrip action with
 *      `id: 'back'` and an `onAction`). Pages that must confirm unsaved
 *      work, or that drill up inside themselves, own this.
 *   2. PARENT_OF — an explicit parent for routes whose parent is not
 *      their URL prefix (`/sale/new` lives under `/sales`).
 *   3. The nearest ancestor path that is a real landing page, so
 *      `/reports/day-book` → `/reports` and `/banks/7/statement` →
 *      `/banks` without either being listed.
 *   4. Home.
 * ────────────────────────────────────────────────────────────────── */

export const HOME_PATH = '/';

/* Screens that ARE the top of a branch. Esc from one of these goes Home;
 * they are also what rule 3 walks up to. Keep in step with the sidebar —
 * a section landing page belongs here, a detail screen does not. */
export const SECTION_ROOTS = new Set([
  '/dashboard',
  '/sales', '/purchases',
  '/sales-returns', '/purchase-returns',
  '/payments',
  '/expenses',
  '/customers', '/suppliers',
  '/products', '/categories',
  '/stock-report', '/stock-report-pro', '/stock-movement',
  '/stock-transfers', '/inventory/batches',
  '/banks', '/loans',
  '/accounts/journal', '/accounts/integrity',
  '/members', '/membership-plans',
  '/reports',
]);

/* Routes whose parent is not simply their URL prefix. Entry forms are the
 * bulk of it: `/sale/new` is a child of the Sales list, not of `/sale`. */
const PARENT_OF = {
  // Sales
  '/sale/new':             '/sales',
  '/receipt/new':          '/payments',
  '/sales-return/new':     '/sales-returns',
  // Purchase
  '/purchase/new':         '/purchases',
  '/payment/new':          '/payments',
  '/purchase-return/new':  '/purchase-returns',
  // Money
  '/expenses/new':         '/expenses',
  '/expenses/report':      '/expenses',
  '/accounts/journal/new': '/accounts/journal',
  // Stock
  '/stock-transfer/new':   '/stock-transfers',
  // Banking
  '/banks/cheques':        '/banks',
  '/banks/reconciliation': '/banks',
  '/loans/schedule':       '/loans',
  // Members
  '/members/report':       '/members',
  // Legacy party detail — the customer list is the honest parent.
  '/parties':              '/customers',
  // Branch tops that sit under another path but ARE tops.
  '/dashboard/classic':    '/dashboard',
};

/* Same, for routes carrying an :id. First match wins, so order matters
 * only where one pattern could shadow another. */
const PARENT_PATTERNS = [
  [/^\/sale\/edit\//,             '/sales'],
  [/^\/receipt\/edit\//,          '/payments'],
  [/^\/sales-return\/edit\//,     '/sales-returns'],
  [/^\/purchase\/edit\//,         '/purchases'],
  [/^\/payment\/edit\//,          '/payments'],
  [/^\/purchase-return\/edit\//,  '/purchase-returns'],
  [/^\/expenses\/edit\//,         '/expenses'],
  [/^\/accounts\/journal\/edit\//, '/accounts/journal'],
  [/^\/stock-transfer\/edit\//,   '/stock-transfers'],
  [/^\/parties\//,                '/customers'],
  // Drill-downs that live under a report rather than under the hub: the
  // per-product colour breakdown belongs to the colour report, not to
  // /reports. Listed explicitly because the walk-up rule would otherwise
  // skip the intermediate page (it is not a section root).
  [/^\/reports\/stock-by-color\/./, '/reports/stock-by-color'],
  // Settings has no hub screen of its own: /settings redirects straight
  // to /settings/company, and the settings nav is a permanent sidebar
  // rather than a page you land on. So "up" from any settings screen is
  // Home — routing to /settings would bounce the operator back to the
  // page they just tried to close.
  [/^\/settings(\/|$)/,           HOME_PATH],
];

/** Strip the query/hash and any trailing slash. */
function clean(pathname) {
  const p = String(pathname || '/').split('?')[0].split('#')[0];
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** True when Esc has nowhere further up to go. */
export function isTopLevel(pathname) {
  return clean(pathname) === HOME_PATH;
}

/**
 * The screen one step up from `pathname`. Always returns a path; Home is
 * the floor, and Home resolves to itself so a caller can detect "nowhere
 * left to go" with `resolveBack(p) === p`.
 */
export function resolveBack(pathname) {
  const path = clean(pathname);
  if (path === HOME_PATH) return HOME_PATH;

  if (PARENT_OF[path]) return PARENT_OF[path];
  for (const [re, parent] of PARENT_PATTERNS) {
    if (re.test(path)) return parent;
  }
  // A section landing page's parent is Home — checked before the walk so
  // that e.g. /accounts/journal doesn't climb to /accounts.
  if (SECTION_ROOTS.has(path)) return HOME_PATH;

  // Walk up the URL until something real is found.
  const parts = path.split('/');
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join('/') || HOME_PATH;
    if (candidate === HOME_PATH) return HOME_PATH;
    if (SECTION_ROOTS.has(candidate) || PARENT_OF[candidate]) return candidate;
  }
  return HOME_PATH;
}
