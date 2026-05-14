/*
 * backup-failed detector.
 *
 * Reads the auto-backup status from the backup-settings.json file
 * (the same file backupController.js writes to). When the most
 * recent run was `failed` we emit one notification per scheduled run
 * that fell over.
 *
 * Stable key includes the failure timestamp so a NEW failure (later
 * scheduled run) produces a different key — the operator sees both
 * if they didn't dismiss the first.
 *
 * Why a file read instead of querying a controller endpoint:
 *   - The detector runs inside the express process anyway.
 *   - Re-reading the JSON costs ~0.1ms; cheaper than a fetch.
 *   - Single source of truth — the backup scheduler writes here too.
 *
 * Trust caveats: a failure recorded weeks ago without a subsequent
 * success would keep showing up. We bound the window to 14 days so
 * the operator isn't haunted by an ancient one-off failure.
 */

const fs   = require('fs');
const path = require('path');
const { IN_ASAR, USER_DATA } = require('../../utils/paths');

const BACKUPS_DIR   = IN_ASAR ? path.join(USER_DATA, 'app-backups') : path.join(__dirname, '../../backups');
const SETTINGS_FILE = path.join(BACKUPS_DIR, 'backup-settings.json');
const STALE_AFTER_DAYS = 14;

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = async function detect(/* ctx */) {
  const s = readSettings();
  if (!s) return [];
  if (s.lastBackupStatus !== 'failed') return [];
  if (!s.lastBackup) return [];

  const failedAt = new Date(s.lastBackup);
  if (Number.isNaN(failedAt.getTime())) return [];

  // Clamp to non-negative — the stored timestamp can be a few seconds
  // / hours in the "future" relative to the request if the clock drifts
  // (servers in transit between TZs, slightly skewed VMs). We never
  // want a "-1 days ago" label.
  const ageDays = Math.max(0, Math.floor((Date.now() - failedAt.getTime()) / 86400000));
  if (ageDays > STALE_AFTER_DAYS) return [];

  // Key includes the timestamp (ISO date only) so each distinct
  // failure produces its own key. A new failure tomorrow won't be
  // merged with today's row.
  const dayKey = failedAt.toISOString().slice(0, 10);

  return [{
    key:          `backup-failed:${dayKey}`,
    type:         'backup-failed',
    section:      'system',
    severity:     'red',
    label:        ageDays === 0
      ? 'Last automatic backup failed'
      : `Backup failed ${ageDays} day${ageDays === 1 ? '' : 's'} ago`,
    sub:          (s.lastBackupError || 'Unknown error. Try a manual backup to confirm.').slice(0, 140),
    occurredAt:   failedAt,
    actionRoute:  '/settings/backup',
    actionLabel:  'Open backup',
  }];
};
