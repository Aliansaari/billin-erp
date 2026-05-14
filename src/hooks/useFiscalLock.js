// ── useFiscalLock ──────────────────────────────────────────────────────
//
// Client-side helper for the audit-mode fiscal-lock check.
//
// In Simple mode (compliance toggle OFF), this hook returns a no-op result:
//   { status: 'open', blocked: false, requiresOverride: false }
// for every date — so bill forms can call it unconditionally and get the
// right answer without branching on the compliance state themselves.
//
// In Audit mode (compliance toggle ON), the hook compares the given date
// against the soft/hard lock dates from useFYCompliance(), plus the
// current user's role, and returns:
//   { status: 'open' | 'soft' | 'soft_no_perm' | 'hard' | 'hard_no_perm',
//     blocked: boolean,                — true if the user can't save
//     requiresOverride: boolean,       — true if the user CAN save with a reason
//     lockDate: 'YYYY-MM-DD' | null,
//     requiresPassword: boolean }
//
// Important — this is the CLIENT-side check. The server has its own
// independent check (server/utils/compliance.js → checkFiscalLock) that's
// the real source of truth. The client check exists purely for UX:
// show the override modal upfront instead of letting the user hit
// "Save" and get a 403 back. A bypass of the client check is harmless
// — the server still rejects it.
//
// Two ways callers consume this:
//   1. const lock = useFiscalLock(billDate);
//      if (lock.blocked) { show "contact admin" toast; return; }
//      if (lock.requiresOverride) { open override modal; ... }
//      ...else save normally
//
//   2. const lock = useFiscalLock(billDate);
//      <Banner visible={lock.requiresOverride}>This date is locked …</Banner>
//
// Pure derivation from useFYCompliance + the user's role, no network.

import { useFYCompliance } from './useFinancialYear';
import useAuthStore from '../store/authStore';

export function useFiscalLock(billDate) {
  const { complianceMode, softLockDate, hardLockDate, requireOverridePassword } = useFYCompliance();
  const user = useAuthStore((s) => s.user);

  // Compliance OFF → simple mode. Always open.
  if (!complianceMode) {
    return { status: 'open', blocked: false, requiresOverride: false, lockDate: null, requiresPassword: false };
  }

  // No date entered yet — neutral. The bill-form validators will catch
  // the missing date with their own messaging; this hook stays quiet.
  if (!billDate) {
    return { status: 'open', blocked: false, requiresOverride: false, lockDate: null, requiresPassword: false };
  }

  const billStr = typeof billDate === 'string'
    ? billDate.slice(0, 10)
    : (billDate?.format ? billDate.format('YYYY-MM-DD') : new Date(billDate).toISOString().slice(0, 10));
  const role = user?.role || '';

  // ── Hard lock — only Super Admin can break, and even then we record
  // the event with is_hard_override=true. Beyond this date, regular
  // users see a "contact super admin" message; SAs see the override
  // modal so they can supply a reason.
  if (hardLockDate && billStr <= hardLockDate) {
    if (role !== 'Super Admin') {
      return {
        status: 'hard_no_perm',
        blocked: true,
        requiresOverride: false,
        lockDate: hardLockDate,
        requiresPassword: false,
        message: 'This period is hard-locked (after ITR filing). Contact Super Admin to backdate.',
      };
    }
    return {
      status: 'hard',
      blocked: false,
      requiresOverride: true,
      lockDate: hardLockDate,
      requiresPassword: false,        // SAs override hard locks without the password challenge
      message: 'Hard lock — provide a reason to record this Super-Admin break.',
    };
  }

  // ── Soft lock — admin / accountant / explicit override perm can break.
  if (softLockDate && billStr <= softLockDate) {
    const canOverride = role === 'Super Admin' || role === 'Admin' || role === 'Accountant';
    if (!canOverride) {
      return {
        status: 'soft_no_perm',
        blocked: true,
        requiresOverride: false,
        lockDate: softLockDate,
        requiresPassword: false,
        message: 'This period is closed. Contact an admin or accountant to backdate.',
      };
    }
    return {
      status: 'soft',
      blocked: false,
      requiresOverride: true,
      lockDate: softLockDate,
      requiresPassword: requireOverridePassword,
      message: 'This date is in a closed period. Provide a reason to proceed.',
    };
  }

  // No applicable lock → free to save.
  return { status: 'open', blocked: false, requiresOverride: false, lockDate: null, requiresPassword: false };
}
