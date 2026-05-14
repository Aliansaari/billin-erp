/*
 * gst-filing-due detector.
 *
 * Indian GST deadlines for monthly filers:
 *   - GSTR-1   : 11th of the following month (outward supplies)
 *   - GSTR-3B  : 20th of the following month (summary + tax payment)
 *
 * We fire when within 3 days of either deadline, escalating to red at
 * D-1 / D-0. The detector emits TWO notifications max (one per
 * return) so the operator sees both deadlines coming distinctly.
 *
 * Only fires when gst_enabled is true on system_settings. Composition-
 * scheme firms (different cadence, GSTR-4 quarterly) aren't supported
 * here yet — would need a system_settings flag to disambiguate, which
 * doesn't exist today. Skipping is honest.
 *
 * No state machine: we never persist "this filing was completed."
 * The window auto-rolls into the next month — the deadline for
 * May 2026 (GSTR-1 = Jun-11) becomes the next month's window once
 * Jun-11 passes. Operators who already filed early just dismiss the
 * row.
 */

const { SystemSettings } = require('../../models');

function deadlineForMonth(year, monthZeroIdx, day) {
  // monthZeroIdx is the month OF the filing deadline (not the month
  // being reported on). For May-2026 sales, GSTR-1 due Jun-11 →
  // year=2026, monthZeroIdx=5 (Jun), day=11.
  const mm = String(monthZeroIdx + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}
function daysBetween(today, deadline) {
  const t = new Date(today    + 'T00:00:00');
  const d = new Date(deadline + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

module.exports = async function detect(ctx) {
  const s = await SystemSettings.findOne({ attributes: ['gst_enabled'] });
  if (!s || !s.gst_enabled) return [];

  const today = new Date(ctx.today + 'T00:00:00');
  const out = [];

  // Look at THIS month and NEXT month's deadlines — covers both
  // "early in the month, last month's deadlines are coming" and
  // "near month-end, next month's are within window."
  for (let offset = 0; offset <= 1; offset++) {
    const base = new Date(today);
    base.setMonth(base.getMonth() + offset);
    const y = base.getFullYear();
    const m = base.getMonth();
    const filings = [
      { type: 'GSTR-1',  day: 11, route: '/reports/gstr1',  label: 'GSTR-1 due' },
      { type: 'GSTR-3B', day: 20, route: '/reports/gstr3b', label: 'GSTR-3B due' },
    ];
    for (const f of filings) {
      const deadline = deadlineForMonth(y, m, f.day);
      const daysLeft = daysBetween(ctx.today, deadline);
      if (daysLeft < 0 || daysLeft > 3) continue;
      const severity = daysLeft <= 1 ? 'red' : 'amber';
      const dueText  = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
      out.push({
        key:         `gst-filing-due:${f.type}:${deadline}`,
        type:        'gst-filing-due',
        section:     'today',
        severity,
        label:       `${f.label} ${dueText}`,
        sub:         `Deadline ${new Date(deadline + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}. Reconcile sales / purchases before filing.`,
        occurredAt:  new Date(),
        actionRoute: f.route,
        actionLabel: 'Open report',
      });
    }
  }
  return out;
};
