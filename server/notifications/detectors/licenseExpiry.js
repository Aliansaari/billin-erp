/*
 * license-expiry detector.
 *
 * Reads the cached license status from server/services/license.js
 * and fires when expires_at is within 30 days. We escalate severity
 * at 7 days (red) and within 24h (still red, harsher copy).
 *
 * If the license is unbounded (no expires_at) or already expired,
 * we emit nothing — the expired case is handled by the licenseGate
 * middleware which blocks every protected API call. No point
 * notifying about something that already blocks the whole app.
 *
 * One notification, one stable key per `expires_at` date, so the
 * row persists across days as it escalates. Replacing the license
 * (new expires_at) produces a fresh key.
 */

const licenseService = require('../../services/license');

module.exports = async function detect(/* ctx */) {
  let status;
  try {
    status = licenseService.getStatus();
  } catch {
    return [];
  }
  // We only emit for valid licenses that are about to expire.
  if (!status || !status.ok) return [];
  const expiresAt = status.expires_at;
  if (!expiresAt) return [];

  const today = new Date();
  const exp   = new Date(expiresAt + 'T23:59:59');
  if (Number.isNaN(exp.getTime())) return [];
  const daysLeft = Math.ceil((exp.getTime() - today.getTime()) / 86400000);

  // Fire only inside the warning window. Beyond 30 days the operator
  // doesn't need to think about renewal yet.
  if (daysLeft < 0 || daysLeft > 30) return [];

  let severity = 'amber';
  let label;
  if (daysLeft <= 1) {
    severity = 'red';
    label = daysLeft === 0 ? 'License expires today' : 'License expires tomorrow';
  } else if (daysLeft <= 7) {
    severity = 'red';
    label = `License expires in ${daysLeft} days`;
  } else {
    label = `License expires in ${daysLeft} days`;
  }

  return [{
    key:         `license-expiry:${expiresAt}`,
    type:        'license-expiry',
    section:     'today',
    severity,
    label,
    sub:         `Renew before ${exp.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} to avoid disruption.`,
    occurredAt:  new Date(),
    actionRoute: '/settings/license',
    actionLabel: 'View license',
  }];
};
