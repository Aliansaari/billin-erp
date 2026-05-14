/*
 * Detector registry.
 *
 * Each detector is a small module exporting an async function with
 * the signature:
 *
 *   async function detect(ctx) -> Candidate[]
 *
 * `ctx` is what notificationService.runDetectors() passes through:
 *   { user, today, models, dateUtil }
 *
 * A Candidate is the raw notification shape — see service.js for the
 * full schema. Most detectors just produce { key, type, severity,
 * label, sub, actionRoute, actionLabel, occurred_at }.
 *
 * The registry is plain require()s so node's module cache reuses the
 * function across requests. There's no dynamic discovery — adding a
 * detector means adding a line here and in ../types.js.
 *
 * Order in this object only matters when two detectors emit the same
 * key (they shouldn't). The service treats the union as a set keyed
 * on `key`.
 */

module.exports = {
  // Risk (state-change) — implemented first because they're stateless
  // queries against existing tables with no calendar math.
  'cheque-bounced':   require('./chequeBounced'),
  'credit-limit':     require('./creditLimit'),
  'bill-long-overdue': require('./billLongOverdue'),
  'stock-negative':   require('./stockNegative'),
  'duplicate-bill':   require('./duplicateBill'),
  'refund-pending':   require('./refundPending'),

  // System (operational)
  'backup-failed':       require('./backupFailed'),
  'tally-sync-failed':   require('./tallySyncFailed'),

  // Today (calendar-driven)
  'pdc-due':         require('./pdcDue'),
  'emi-due':         require('./emiDue'),
  'purchase-due':    require('./purchaseDue'),
  'gst-filing-due':  require('./gstFilingDue'),
  'fy-end-near':     require('./fyEndNear'),
  'license-expiry':  require('./licenseExpiry'),
};
