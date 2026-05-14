/*
 * fy-end-near detector.
 *
 * Fires at 30 / 15 / 7 days before financial_year_end on
 * system_settings. The intent is compliance prep, not blocking —
 * accountants want time to reconcile, reconcile bank statements,
 * close pending journals, and post adjusting entries before the
 * year-end roll.
 *
 * Three escalation milestones produce three distinct stable keys
 * keyed by both the FY-end date AND the milestone, so the operator
 * sees a fresh nudge as the date approaches. The bell de-dupes
 * within each milestone (one row per "30d to go" notification).
 *
 * If financial_year_end is null or unset (very rare; the system
 * settings hub forces a default), we emit nothing.
 */

const { SystemSettings } = require('../../models');

const MILESTONES = [30, 15, 7];

module.exports = async function detect(ctx) {
  const s = await SystemSettings.findOne({ attributes: ['financial_year_end'] });
  if (!s || !s.financial_year_end) return [];
  const fyEnd = new Date(s.financial_year_end + 'T00:00:00');
  if (Number.isNaN(fyEnd.getTime())) return [];

  const todayD = new Date(ctx.today + 'T00:00:00');
  const daysLeft = Math.round((fyEnd - todayD) / 86400000);
  if (daysLeft < 0) return [];   // already past — out of scope

  const out = [];
  for (const m of MILESTONES) {
    if (daysLeft <= m && daysLeft > (m === 7 ? -1 : MILESTONES[MILESTONES.indexOf(m) - 1] ?? 0)) {
      // Only the lowest crossed milestone fires per request. Stops
      // overlapping notifications when the operator is at 12 days
      // (within the 30 AND 15 brackets).
    }
  }
  // Simpler approach: pick the tightest milestone we've crossed.
  const milestone = MILESTONES.find((m) => daysLeft <= m);
  if (!milestone) return [];

  const severity = milestone <= 7 ? 'red' : milestone <= 15 ? 'amber' : 'amber';
  const dueText  = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  out.push({
    key:         `fy-end-near:${s.financial_year_end}:m${milestone}`,
    type:        'fy-end-near',
    section:     'today',
    severity,
    label:       `Financial year closes ${dueText}`,
    sub:         `Reconcile bank statements, post adjusting journals, and resolve pending vouchers before ${fyEnd.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}.`,
    occurredAt:  new Date(),
    actionRoute: '/reports/trial-balance',
    actionLabel: 'Trial balance',
  });
  return out;
};
