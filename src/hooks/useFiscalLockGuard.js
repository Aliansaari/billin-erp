import { useCallback, useState } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
 * useFiscalLockGuard — shared override-modal flow for every voucher form.
 *
 * Every voucher controller now returns a structured `403 FY_LOCKED` body
 * when the user is saving a date that falls in a closed FY (and compliance
 * mode is on). This hook centralises the client-side reaction so a Sales
 * form, a Purchase form, a Payment form, etc. all behave identically:
 *
 *    1. Form's save handler wraps its API call in `guardedSave(body, doSave)`.
 *    2. If the server returns 403 FY_LOCKED with `requires_override`, the
 *       hook stashes the lock metadata into local state and the form's
 *       JSX (which mounts <FiscalLockOverrideModal open={!!lockModal} …/>)
 *       pops up the modal.
 *    3. The operator types a reason (+ password if required), clicks
 *       Confirm. The hook retries the same body with `_override_reason`
 *       and `_override_password` appended.
 *    4. On password failure, the modal stays open with an updated message.
 *       On success, the modal closes and the original save's resolved
 *       value is returned to the caller's awaited promise.
 *    5. If the server returns 403 FY_LOCKED WITHOUT override affordances
 *       (the operator's role can't break the lock at all), the hook does
 *       NOT open the modal — it surfaces the server's friendly message
 *       via the `onBlocked` callback (typically wired to a toast).
 *    6. Any other error rethrows so the form's existing catch handles it.
 *
 * Usage:
 *
 *   const { lockModal, setLockModal, guardedSave } = useFiscalLockGuard({
 *     vouchTypeLabel: 'Sale',
 *     onBlocked: (msg) => message.error(msg),
 *   });
 *
 *   const onSave = async () => {
 *     try {
 *       const result = await guardedSave(body, (b) => salesAPI.create(b));
 *       // success — result is the API response
 *     } catch (e) {
 *       // generic non-FY error
 *     }
 *   };
 *
 *   <FiscalLockOverrideModal
 *     open={!!lockModal}
 *     lock={lockModal?.lock}
 *     billDate={billDate}
 *     vouchTypeLabel="Sale"
 *     onConfirm={lockModal?.onConfirm}
 *     onCancel={lockModal?.onCancel}
 *   />
 *
 * The hook is presentation-free — it owns one piece of state (`lockModal`)
 * and one function (`guardedSave`). The modal component itself is rendered
 * by the form, which keeps the per-form layout intact.
 * ────────────────────────────────────────────────────────────────────── */

export function useFiscalLockGuard({ onBlocked } = {}) {
  // { lock, onConfirm, onCancel } — null when no override is pending.
  const [lockModal, setLockModal] = useState(null);

  const guardedSave = useCallback(async (body, doSave) => {
    // Run the save once. If it succeeds, hand the result back. If it
    // 403s with FY_LOCKED + override affordances, fall into the modal
    // loop. Anything else rethrows so the caller's existing error path
    // takes over.
    try {
      return await doSave(body);
    } catch (firstErr) {
      const data = firstErr?.response?.data;
      const is403Lock = firstErr?.response?.status === 403 && data?.error === 'FY_LOCKED';
      if (!is403Lock) throw firstErr;

      // No override allowed for this role/date combo — show the
      // friendly server message and surface the original error so the
      // caller's catch still runs (loading state cleanup, etc.).
      if (!data.requires_override && !data.requires_password) {
        if (typeof onBlocked === 'function') {
          onBlocked(data.message || 'This date is in a closed financial year.');
        }
        throw firstErr;
      }

      // Override path. Return a promise that resolves/rejects based on
      // whether the user confirms (and the retry succeeds) or cancels.
      return new Promise((resolve, reject) => {
        const initialLock = {
          status:           data.lock_type,
          lockDate:         data.lock_date,
          requiresPassword: !!data.requires_password,
          message:          data.message,
        };

        // Retry handler — invoked by the modal's onConfirm. Re-runs
        // doSave with the override fields attached. On password-invalid
        // it keeps the modal open with an updated message; on any other
        // error it closes the modal and reject()s.
        const onConfirm = async ({ reason, password }) => {
          try {
            const retryBody = { ...body, _override_reason: reason };
            if (password !== undefined) retryBody._override_password = password;
            const result = await doSave(retryBody);
            setLockModal(null);
            resolve(result);
          } catch (retryErr) {
            const rd = retryErr?.response?.data;
            if (rd?.error === 'FY_LOCKED' && rd.password_invalid) {
              // Wrong password — keep the modal open with a clear hint.
              setLockModal((prev) => prev ? { ...prev, lock: { ...prev.lock, message: 'Password did not match. Try again.' } } : null);
              return;
            }
            if (rd?.error === 'FY_LOCKED' && rd.requires_password && !rd.password_invalid) {
              // Server now demands a password the first attempt missed.
              setLockModal((prev) => prev ? { ...prev, lock: { ...prev.lock, requiresPassword: true, message: rd.message || 'Password required.' } } : null);
              return;
            }
            // Different error class — surface to the caller.
            setLockModal(null);
            reject(retryErr);
          }
        };

        const onCancel = () => {
          setLockModal(null);
          // Reject with the original 403 so the caller's catch path
          // (loading flag cleanup, etc.) runs as if the save simply
          // failed. Mark as cancelled so callers can opt-out of error
          // toasts.
          reject(Object.assign(firstErr, { _fiscalLockCancelled: true }));
        };

        setLockModal({ lock: initialLock, onConfirm, onCancel });
      });
    }
  }, [onBlocked]);

  return { lockModal, setLockModal, guardedSave };
}

/**
 * Type-narrowing helper for callers that want to swallow only the
 * cancel-rejection without losing real errors.
 *
 *   try { ... } catch (e) {
 *     if (isFiscalLockCancel(e)) return;
 *     message.error(e?.response?.data?.message || 'Failed to save');
 *   }
 */
export function isFiscalLockCancel(err) {
  return !!(err && err._fiscalLockCancelled);
}
