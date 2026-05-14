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
const { hasPermission } = require('./perms');

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

  // ── Hard lock — strictest. Beyond this only Super Admin can post,
  // and we log every break with is_hard_override=true so external
  // auditors can pull just those rows. Same path the soft lock takes,
  // but with the no-perm message swapped for the hard-lock copy.
  if (hardLock && billDateStr <= hardLock) {
    if (user.role !== 'Super Admin') {
      return {
        ok: false,
        status: 'hard_no_perm',
        lockDate: hardLock,
        message: `This period is hard-locked (after ITR filing). Only Super Admin can post in ${hardLock} or earlier.`,
      };
    }
    if (!ctx.overrideReason) {
      return {
        ok: false,
        status: 'hard',
        requiresOverride: true,
        lockDate: hardLock,
        message: `Hard lock — provide an override reason to record this Super-Admin break.`,
      };
    }
    // Super Admin + reason provided → allow. Caller is responsible for
    // calling logComplianceEvent({ event_type: 'hard_override', ... })
    // AFTER the underlying save succeeds, so a failed save doesn't leave
    // a hanging log entry.
    return { ok: true, status: 'hard_override_granted', lockDate: hardLock };
  }

  // ── Soft lock — less strict. Configurable role gate; the wider
  // settings.fy_lock.override_soft permission OR Admin/Accountant role
  // both pass. Reason is required and gets logged.
  if (softLock && billDateStr <= softLock) {
    const canOverride =
      user.role === 'Super Admin' ||
      user.role === 'Admin' ||
      user.role === 'Accountant' ||
      hasPermission(user, 'fy_lock.override_soft');
    if (!canOverride) {
      return {
        ok: false,
        status: 'soft_no_perm',
        lockDate: softLock,
        message: `FY ${softLock.slice(0, 4)} is closed. Contact an admin/accountant to backdate.`,
      };
    }
    if (!ctx.overrideReason) {
      return {
        ok: false,
        status: 'soft',
        requiresOverride: true,
        lockDate: softLock,
        requirePassword: requirePw,
        message: `This date is in a closed period. Provide an override reason to proceed.`,
      };
    }
    // Reason supplied → allow. (Password verification, if required,
    // happens in the controller before this is called — we don't have
    // the user's plaintext password here.)
    return { ok: true, status: 'soft_override_granted', lockDate: softLock };
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
    await ComplianceAuditLog.create({
      event_type:       event.event_type,
      event_at:         event.event_at || new Date(),
      user_id:          event.user?.user_id || event.user_id || null,
      user_name:        event.user?.full_name || event.user_name || null,
      user_role:        event.user?.role || event.user_role || null,
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
