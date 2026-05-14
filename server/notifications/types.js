/*
 * Notification type catalog — single source of truth for what kinds of
 * notifications exist, their defaults, and metadata used by both the
 * server and the settings UI.
 *
 * Adding a new detector: add an entry here AND drop a file in
 * ./detectors/<type>.js exporting an async function that takes the
 * context and returns candidate notification objects. The framework
 * picks it up automatically — no other registrations needed.
 *
 * Schema for one entry:
 *   {
 *     type:        kebab-case identifier; matches detectors/<type>.js
 *                  filename and the `type_toggles` JSONB key.
 *     label:       human-readable name shown in settings.
 *     description: one-liner shown under the toggle in settings.
 *     section:     which UI section the row sorts into.
 *                  'today' | 'risk' | 'system'
 *     defaultOn:   whether new users get this toggle ON by default.
 *                  We default everything to ON so first-time operators
 *                  see the full feature; they can mute what they don't
 *                  want. Setting to false here is reserved for genuinely
 *                  noisy detectors that aren't worth surfacing without
 *                  explicit opt-in.
 *   }
 *
 * IMPORTANT: keep `type` stable. It's the key under which user
 * settings persist. Renaming a type orphans every user's preference
 * for it. If a rename is unavoidable, write a one-shot migration
 * that copies the old key to the new in `type_toggles`.
 */

const NOTIFICATION_TYPES = [
  // ── Today (calendar-driven) ───────────────────────────────────────
  {
    type:        'pdc-due',
    label:       'PDC cheque matures today',
    description: 'Postdated cheque (inward or outward) reaches its date — deposit / ensure balance.',
    section:     'today',
    defaultOn:   true,
  },
  {
    type:        'emi-due',
    label:       'Loan EMI due today',
    description: 'Loan instalment date reaches today.',
    section:     'today',
    defaultOn:   true,
  },
  {
    type:        'purchase-due',
    label:       'Purchase bill due today',
    description: 'Supplier bill whose payment due date is today.',
    section:     'today',
    defaultOn:   true,
  },
  {
    type:        'gst-filing-due',
    label:       'GST filing window approaching',
    description: 'GSTR-1 / GSTR-3B deadline in the next 3 days.',
    section:     'today',
    defaultOn:   true,
  },
  {
    type:        'fy-end-near',
    label:       'Financial year-end approaching',
    description: 'Last 30 / 15 / 7 days before the FY closes.',
    section:     'today',
    defaultOn:   true,
  },
  {
    type:        'license-expiry',
    label:       'License expires soon',
    description: 'Software license has 30 / 15 / 7 days remaining.',
    section:     'today',
    defaultOn:   true,
  },

  // ── Risk (state-change alerts) ────────────────────────────────────
  {
    type:        'cheque-bounced',
    label:       'Cheque bounced',
    description: 'Cheque status changed to BOUNCED — needs follow-up.',
    section:     'risk',
    defaultOn:   true,
  },
  {
    type:        'credit-limit',
    label:       'Customer crossed credit limit',
    description: 'Outstanding balance exceeded the credit limit on a customer account.',
    section:     'risk',
    defaultOn:   true,
  },
  {
    type:        'bill-long-overdue',
    label:       'Bill aged past 60 days',
    description: 'Receivable bill first crosses the long-overdue threshold.',
    section:     'risk',
    defaultOn:   true,
  },
  {
    type:        'stock-negative',
    label:       'Stock went negative',
    description: 'A product\'s current stock dropped below zero — likely a data-entry issue.',
    section:     'risk',
    defaultOn:   true,
  },
  {
    type:        'duplicate-bill',
    label:       'Duplicate supplier bill detected',
    description: 'Same bill number from the same supplier within 30 days.',
    section:     'risk',
    defaultOn:   true,
  },
  {
    type:        'refund-pending',
    label:       'Sales return without refund',
    description: 'Credit note created N days ago, refund still not paid.',
    section:     'risk',
    defaultOn:   true,
  },

  // ── System (operational) ──────────────────────────────────────────
  {
    type:        'backup-failed',
    label:       'Backup failed',
    description: 'The most recent scheduled backup did not complete.',
    section:     'system',
    defaultOn:   true,
  },
  {
    type:        'tally-sync-failed',
    label:       'Tally sync errored',
    description: 'A Tally push or pull job ended in failure.',
    section:     'system',
    defaultOn:   true,
  },
];

// Lookup helpers — used by the service to filter candidates by the
// user's per-type toggles. Missing keys default to true (opt-out).
const TYPE_BY_KEY = Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t.type, t]));

function isTypeEnabled(type, toggles) {
  if (!toggles) return true;
  const v = toggles[type];
  return v === undefined || v === null ? true : !!v;
}

function defaultToggles() {
  // Build the default toggle map from the catalog. Used when seeding
  // a brand-new user row. Returns a fresh object each call so callers
  // can mutate without poisoning the shared default.
  const out = {};
  for (const t of NOTIFICATION_TYPES) out[t.type] = !!t.defaultOn;
  return out;
}

module.exports = {
  NOTIFICATION_TYPES,
  TYPE_BY_KEY,
  isTypeEnabled,
  defaultToggles,
};
