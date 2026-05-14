/*
 * tally-sync-failed detector.
 *
 * Detects ImportJob rows with source='tally' that ended in
 * status='failed' within the last N days. Each failure produces one
 * notification, keyed by job id so two failures from the same source
 * don't collapse into one.
 *
 * We bound to 14 days so an ancient failed import doesn't keep
 * haunting the operator forever — by then they've either re-run it
 * successfully or accepted the loss.
 */

const { Op } = require('sequelize');
const { ImportJob } = require('../../models');

const STALE_AFTER_DAYS = 14;

module.exports = async function detect(/* ctx */) {
  const since = new Date(Date.now() - STALE_AFTER_DAYS * 86400000);
  const rows = await ImportJob.findAll({
    where: {
      source: 'tally',
      status: 'failed',
      created_at: { [Op.gte]: since },
    },
    order: [['created_at', 'DESC']],
    limit: 10,    // server-side cap; the bell only shows a few per section anyway
  });

  return rows.map((j) => {
    const at = j.completed_at || j.created_at;
    const ageMs = Math.max(0, Date.now() - new Date(at).getTime());
    const ageDays = Math.floor(ageMs / 86400000);
    const ageLabel =
      ageDays === 0 ? 'today' :
      ageDays === 1 ? 'yesterday' :
      `${ageDays} days ago`;
    return {
      key:         `tally-sync-failed:${j.id}`,
      type:        'tally-sync-failed',
      section:     'system',
      severity:    'amber',
      label:       `Tally sync failed ${ageLabel}`,
      sub:         (j.error_message || j.phase_message || 'Re-run the sync from Settings → TallyPrime Sync.').slice(0, 140),
      occurredAt:  at,
      actionRoute: '/settings/tally',
      actionLabel: 'Open Tally',
    };
  });
};
