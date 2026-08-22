import dayjs from 'dayjs';

/*
 * Pure helpers for the sales-bill membership integration.
 *
 * These are deliberately side-effect-free and framework-agnostic so the
 * billing decision — "is this customer an eligible member, and what tier
 * discount (if any) should be pre-filled" — is unit-testable without a
 * browser. The React layer (SalesBillForm) calls these and, when
 * autoDiscountToApply returns a number, writes it into the EXISTING
 * `discount_percentage` form field. No money math lives here or there: the
 * existing bill pipeline computes everything from that field exactly as if
 * the operator had typed the percentage.
 */

/**
 * Normalise a membership row (as returned by /api/membership by-party) into
 * a compact badge descriptor. Returns null when there's no membership.
 *
 * `now` is injectable for deterministic tests.
 */
export function evaluateMembership(membership, now = new Date()) {
  if (!membership) return null;
  const expired = !!(
    membership.expiry_date &&
    dayjs(membership.expiry_date).endOf('day').isBefore(dayjs(now))
  );
  const eligible = membership.status === 'Active' && !expired;
  const discount = Number(membership.plan && membership.plan.discount_percent) || 0;
  return {
    plan: membership.plan ? membership.plan.plan_name : '—',
    // Surface a past-expiry membership as Expired even if its stored status
    // hasn't been swept to 'Expired' yet (that sweep is a later phase).
    status: expired ? 'Expired' : membership.status,
    points: Number(membership.points_balance) || 0,
    discount,
    pointsPer100: Number(membership.plan && membership.plan.points_per_100) || 0,
    membershipNo: membership.membership_no || '',
    expiryDate: membership.expiry_date || null,
    eligible,
  };
}

/**
 * Decide whether to auto-fill the bill's tier discount, and to what value.
 * Returns a positive number to set `discount_percentage` to, or null to
 * leave the field untouched.
 *
 * Guards (all must pass to apply):
 *   · not editing an existing bill — a saved bill's discount is authoritative
 *   · the auto-discount setting is on
 *   · the member is eligible (Active + not expired) with a positive tier %
 *   · the operator hasn't already set a bill discount — never override manual
 */
export function autoDiscountToApply({ evalResult, autoDiscountEnabled, isEdit, currentDiscountPct }) {
  if (isEdit) return null;
  if (!autoDiscountEnabled) return null;
  if (!evalResult || !evalResult.eligible) return null;
  const d = Number(evalResult.discount) || 0;
  if (d <= 0) return null;
  if ((Number(currentDiscountPct) || 0) !== 0) return null;
  return d;
}
