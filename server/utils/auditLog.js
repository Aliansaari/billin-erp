/**
 * Audit Log — central recorder for sensitive admin actions (audit H11).
 *
 * Stores append-only rows in the `audit_logs` master-DB table. Every
 * controller call site that mutates users, roles, permissions, system
 * settings, or runs destructive maintenance (data cleanup, backup restore)
 * should record a row here so a forensic auditor can reconstruct who did
 * what when.
 *
 * Design:
 *   - master-DB only (single audit trail across companies)
 *   - append-only — no UPDATE / DELETE from application code
 *   - non-blocking on persist failure — operational continuity beats
 *     audit integrity for a single missed row; the issue gets logged
 *
 * The `actor` is keyed by user_id + username (denormalized so a renamed
 * or deleted user still has a recognisable trail).
 *
 * `before`/`after` are JSONB columns. Pass plain objects. Don't dump
 * password_hash, OTP codes, or other secrets — sensitive fields are
 * filtered out below as a safety net.
 */

const sequelize = require('../config/database');

// Field names we NEVER want in an audit row, even if the caller passes
// them by accident. Acts as a safety net so a sloppy log call can't leak
// secrets to anyone with audit-log read access.
const SECRET_FIELDS = new Set([
  'password_hash', 'password', 'new_password', 'current_password',
  'jwt_secret', 'developer_password', 'token', 'access_token',
  'refresh_token', 'api_key', 'license_signature',
]);

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELDS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Record an audit log entry. Non-blocking — failures are logged to
 * stderr but do not throw to the caller. The action_type values are
 * controlled-vocabulary strings so reports can filter on them:
 *
 *   user.create | user.update | user.delete | user.activate | user.deactivate
 *   role.create | role.update | role.delete | role.permissions_changed
 *   settings.cleanup | settings.backup_create | settings.backup_restore
 *   license.activate | license.deactivate
 *   company.create | company.update | company.delete | company.switch
 *
 * @param {object} args
 * @param {object} [args.req]         - Express request (for actor + IP). Optional.
 * @param {number} [args.actorUserId] - Override actor id (e.g., system actor).
 * @param {string} [args.actorUsername] - Override actor name.
 * @param {string} args.action        - Action verb from the controlled vocab.
 * @param {string} [args.entityType]  - 'user' | 'role' | 'settings' | …
 * @param {number|string} [args.entityId] - The thing being acted on.
 * @param {object} [args.before]      - Pre-state snapshot (redacted).
 * @param {object} [args.after]       - Post-state snapshot (redacted).
 * @param {string} [args.notes]       - Free-form description.
 */
async function recordAudit({
  req,
  actorUserId,
  actorUsername,
  action,
  entityType = null,
  entityId   = null,
  before     = null,
  after      = null,
  notes      = null,
}) {
  const aId   = actorUserId   ?? req?.user?.user_id    ?? null;
  const aName = actorUsername ?? req?.user?.username   ?? null;
  const ip    = req?.ip || req?.connection?.remoteAddress || null;
  const ua    = req?.headers?.['user-agent'] || null;
  const companyId = req?.companyId || null;

  try {
    await sequelize.query(
      `INSERT INTO audit_logs
         (action, entity_type, entity_id, actor_user_id, actor_username,
          ip_address, user_agent, company_id, before_state, after_state,
          notes, created_at)
       VALUES (:action, :etype, :eid, :auid, :auname, :ip, :ua, :cid,
               :before::jsonb, :after::jsonb, :notes, NOW())`,
      {
        replacements: {
          action,
          etype:  entityType,
          eid:    entityId != null ? String(entityId) : null,
          auid:   aId,
          auname: aName,
          ip,
          ua:     ua ? String(ua).slice(0, 500) : null,
          cid:    companyId,
          before: before ? JSON.stringify(redact(before)) : null,
          after:  after  ? JSON.stringify(redact(after))  : null,
          notes:  notes ? String(notes).slice(0, 1000) : null,
        },
      },
    );
  } catch (err) {
    // Non-blocking — log to stderr so an admin sees it without failing
    // the underlying mutation. The most common reason: table not yet
    // migrated on a fresh install.
    if (!recordAudit._warned) {
      console.error('[auditLog] persist failed (table missing or DB issue):', err.message);
      recordAudit._warned = true;
    }
  }
}

module.exports = { recordAudit, redact };
