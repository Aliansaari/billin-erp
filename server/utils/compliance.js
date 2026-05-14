/* ============================================================================
 * compliance.js — fiscal-lock enforcement + audit-log writer.
 *
 * Two responsibilities:
 *
 *   1. checkFiscalLock(billDate, user, ctx)
 *      - Reads SystemSettings to see if compliance is on and what the
 *        soft / hard lock dates are.
 *      - Compares billDate against the locks.
 *      - Returns one of:
 *          { ok: true }                                  → save can proceed
 *          { ok: false, status: 'soft', requiresOverride: true, lockDate, message }
 *          { ok: false, status: 'soft_no_perm', message } → user lacks role
 *          { ok: false, status: 'hard', message }        → blocked entirely
 *          { ok: false, status: 'hard_no_perm', message } → only super-admin
 *      - Voucher controllers call this BEFORE saving and translate the
 *        result into either a 403 with structured body OR a save.
 *
 *   2. logComplianceEvent({ event_type, ... })
 *      - Writes a row into compliance_audit_logs. Snapshot fields
 *        (user_name, user_role, target_label) are taken at write time.
 *      - Never throws — audit log is best-effort; a write failure must
 *        not block the actual save the caller is trying to do.
 *
 * Both functions are stateless utilities — no module-level cache,
 * because the data they read is admin-controlled and changes rarely.
 * The SystemSettings row is one DB hit per save; trivial overhead.
 * ============================================================================ */

const { SystemSettings, ComplianceAuditLog } = require('../models');
const { hasPermission } = require('../middleware/permissions');

/**
 * Resolve the role name from a Sequelize User instance.
 *
 * The User model has `role_id` (FK to roles) and a `Role` belongsTo
 * association. The Sequelize accessor is `user.Role` (PascalCase,
 * matches the model name) — there is NO `user.role` property on the
 * instance. Earlier versions of this file compared `user.role` directly
 * to strings like 'Super Admin', which always evaluated to false
 * because `user.role` was undefined; the result was that the hard-lock
 * branch unconditionally returned `hard_no_perm` (blocking even Super
 * Admin) and the soft-lock branch only worked for Super Admin / default
 * Admin via the hasPermission fallback. Accountant always failed.
 *
 * Matches the canonical extraction pattern in middleware/permissions.js
 * and middleware/godownScope.js so the three places agree on how to
 * read a role name off a user object — regardless of whether the user
 * came in via Sequelize include (Role object), a flattened JWT-derived
 * shape (role_name / role string), or a hand-built test stub.
 */
function roleNameOf(user) {
  if (!user) return null;
  const role = user.Role || user.role || null;
  if (role && typeof role === 'object' && role.role_name) return role.role_name;
  return user.role_name || (typeof user.role === 'string' ? user.role : null);
}

/**
 * Check whether `billDate` (YYYY-MM-DD string or Date) is permitted
 * under the current fiscal-lock configuration. Returns a structured
 * result the controller can act on.
 *
 * @param {string|Date} billDate     The voucher's date.
 * @param {object}      user          { user_id, full_name, role }
 * @param {object}      ctx           { overrideReason, overridePassword, allowHardOverride }
 *                                    overrideReason — present when the client retries with reason.
 *                                    overridePassword — present when require-password is on.
 *                                    allowHardOverride — true ONLY for Super Admin save paths
 *                                    that have already verified role.
 * @returns {object} { ok, status, requiresOverride?, lockDate?, message? }
 */
async function checkFiscalLock(billDate, user, ctx = {}) {
  // No date → can't evaluate. Treat as ok (the voucher-side validator
  // will reject a missing date with its own error).
  if (!billDate) return { ok: true };

  const settings = await SystemSettings.findByPk(1);
  if (!settings) return { ok: true };

  // Compliance off → everyone passes. This is the simple-mode default.
  if (!settings.fy_compliance_mode) return { ok: true };

  const billDateStr = typeof billDate === 'string'
    ? billDate.slice(0, 10)
    : new Date(billDate).toISOString().slice(0, 10);
  const softLock    = settings.fy_soft_lock_date && String(settings.fy_soft_lock_date).slice(0, 10);
  const hardLock    = settings.fy_hard_lock_date && String(settings.fy_hard_lock_date).slice(0, 10);
  const requirePw   = !!settings.fy_require_override_password;

  // Resolve the role name once. See roleNameOf() above for why
  // `user.role` (the lowercase property) is not a reliable accessor on a
  // Sequelize User instance.
  const roleName = roleNameOf(user);

  // Reason must be more than whitespace + meaningful — a malicious
  // client can bypass the UI's 8-char minimum by hitting the API
  // directly. Enforce here so the audit log never carries a useless
  // " " or "x" as the recorded justification.
  const MIN_REASON_LEN = 8;
  const trimmedReason  = typeof ctx.overrideReason === 'string'
    ? ctx.overrideReason.trim()
    : '';
  const hasValidReason = trimmedReason.length >= MIN_REASON_LEN;

  // ── Hard lock — strictest. Beyond this only Super Admin can post,
  // and we log every break with is_hard_override=true so external
  // auditors can pull just those rows. Same path the soft lock takes,
  // but with the no-perm message swapped for the hard-lock copy.
  if (hardLock && billDateStr <= hardLock) {
    if (roleName !== 'Super Admin') {
      return {
        ok: false,
        status: 'hard_no_perm',
        lockDate: hardLock,
        message: `This period is hard-locked (after ITR filing). Only Super Admin can post in ${hardLock} or earlier.`,
      };
    }
    if (!hasValidReason) {
      return {
        ok: false,
        status: 'hard',
        requiresOverride: true,
        lockDate: hardLock,
        message: trimmedReason.length === 0
          ? `Hard lock — provide an override reason to record this Super-Admin break.`
          : `Reason is too short (need at least ${MIN_REASON_LEN} characters). Be specific — auditors will read this.`,
      };
    }
    // Super Admin + reason provided → allow. Caller is responsible for
    // calling logComplianceEvent({ event_type: 'hard_override', ... })
    // AFTER the underlying save succeeds, so a failed save doesn't leave
    // a hanging log entry.
    return { ok: true, status: 'hard_override_granted', lockDate: hardLock, reason: trimmedReason };
  }

  // ── Soft lock — less strict. Configurable role gate; the wider
  // settings.fy_lock.override_soft permission OR Admin/Accountant role
  // both pass. Reason is required and gets logged.
  if (softLock && billDateStr <= softLock) {
    const canOverride =
      roleName === 'Super Admin' ||
      roleName === 'Admin' ||
      roleName === 'Accountant' ||
      hasPermission(user, 'fy_lock.override_soft');
    if (!canOverride) {
      return {
        ok: false,
        status: 'soft_no_perm',
        lockDate: softLock,
        message: `FY ${softLock.slice(0, 4)} is closed. Contact an admin/accountant to backdate.`,
      };
    }
    if (!hasValidReason) {
      return {
        ok: false,
        status: 'soft',
        requiresOverride: true,
        lockDate: softLock,
        requirePassword: requirePw,
        message: trimmedReason.length === 0
          ? `This date is in a closed period. Provide an override reason to proceed.`
          : `Reason is too short (need at least ${MIN_REASON_LEN} characters). Be specific — auditors will read this.`,
      };
    }
    // Reason supplied + valid → allow. (Password verification, if
    // required, happens in the controller AFTER this — we don't have
    // the user's plaintext password here.) Trimmed reason is returned
    // so the caller passes the cleaned value to the audit-log writer.
    return { ok: true, status: 'soft_override_granted', lockDate: softLock, reason: trimmedReason };
  }

  // No applicable lock → fine.
  return { ok: true };
}

/**
 * Append an event to compliance_audit_logs. Best-effort — swallows
 * errors so a transient DB hiccup never blocks the underlying save.
 * The audit log is reconstructable from voucher timestamps if it
 * fails; better to lose a log row than lose the voucher.
 *
 * @param {object} event  fields matching the ComplianceAuditLog model
 * @returns {Promise<void>}
 */
async function logComplianceEvent(event) {
  try {
    // Resolve the role name via the same extractor used by the lock
    // check; previously this used `event.user?.role` which is always
    // undefined on a Sequelize User instance, so every audit row was
    // stamped with user_role=null and the auditor lost the role
    // attribution.
    const resolvedRole = roleNameOf(event.user) || event.user_role || null;
    await ComplianceAuditLog.create({
      event_type:       event.event_type,
      event_at:         event.event_at || new Date(),
      user_id:          event.user?.user_id || event.user_id || null,
      user_name:        event.user?.full_name || event.user_name || null,
      user_role:        resolvedRole,
      target_type:      event.target_type || null,
      target_id:        event.target_id || null,
      target_label:     event.target_label || null,
      target_date:      event.target_date || null,
      reason:           event.reason || null,
      from_value:       event.from_value || null,
      to_value:         event.to_value || null,
      is_hard_override: !!event.is_hard_override,
      metadata:         event.metadata || null,
    });
  } catch (e) {
    // Log to console for ops visibility; never re-throw.
    // eslint-disable-next-line no-console
    console.error('[compliance] audit-log write failed:', e?.message || e);
  }
}

/**
 * Translate a checkFiscalLock failure into a structured 403 JSON the
 * client can act on. Voucher controllers call this for clean DRY-up.
 */
function send403FromLock(res, lockResult) {
  return res.status(403).json({
    error: 'FY_LOCKED',
    lock_type:         lockResult.status,
    lock_date:         lockResult.lockDate,
    requires_override: !!lockResult.requiresOverride,
    requires_password: !!lockResult.requirePassword,
    message:           lockResult.message,
  });
}

module.exports = {
  checkFiscalLock,
  logComplianceEvent,
  send403FromLock,
};
