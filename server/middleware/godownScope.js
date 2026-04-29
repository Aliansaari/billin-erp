/*
 * Godown access scoping for request handlers.
 *
 * Two responsibilities:
 *   1. Compute the effective set of godown_ids a given user can read/write.
 *      Super Admin and Admin role-name short-circuit to "all godowns" —
 *      same fast-path as middleware/permissions.js hasPermission. A user's
 *      allowed_godowns of [] (empty array, not NULL) means "no godowns" —
 *      a deliberate lockout.
 *
 *   2. Apply that filter to a Sequelize where-clause object so list
 *      endpoints (GET /sales, GET /purchases, GET /reports/stock-summary)
 *      automatically scope to the caller's reachable godowns.
 *
 * Admin-bypass note (the gotcha):
 *   Admins bypass allowed_godowns even if the field is set on their user
 *   row. This matches the existing permissions semantics where an Admin
 *   without explicit permissions still has all permissions. Locking an
 *   admin out of a godown via allowed_godowns is intentionally
 *   impossible — use a non-Admin role for that.
 */

const { Op } = require('sequelize');

/**
 * Returns the list of godown_ids this user can access, or null for
 * unrestricted access.
 *
 *   null           → all godowns visible/writable
 *   []             → no godowns at all (locked out)
 *   [1, 3]         → exactly these godowns
 */
function effectiveGodownIds(user) {
  if (!user) return [];
  const role = user.Role || user.role || null;
  const roleName = (role && role.role_name) || user.role_name || user.role || null;

  // Super Admin / Admin always sees everything.
  if (roleName === 'Super Admin' || roleName === 'Admin') return null;

  // No allowlist set → unrestricted (default for freshly-created users).
  if (user.allowed_godowns == null) return null;

  return Array.isArray(user.allowed_godowns) ? user.allowed_godowns : null;
}

/**
 * Mutates `where` to add `godown_id IN (...)` when the user is restricted.
 * No-op when the user has unrestricted access. Returns `where` for chaining.
 *
 *   const where = await scopeWhereByGodown({}, req.user);
 *   const bills = await SalesBill.findAll({ where });
 */
function scopeWhereByGodown(where, user, fieldName = 'godown_id') {
  const ids = effectiveGodownIds(user);
  if (ids === null) return where;       // unrestricted
  // An empty allowlist → match nothing. Use IN of empty array semantics
  // (Sequelize translates IN () to a guaranteed-false predicate).
  where[fieldName] = { [Op.in]: ids };
  return where;
}

/**
 * Special variant for stock_transfers: a transfer is visible if EITHER
 * its from_godown_id OR its to_godown_id is in the user's allowed set.
 * This is the only table where two godown columns matter for visibility.
 */
function scopeWhereByGodownEither(where, user) {
  const ids = effectiveGodownIds(user);
  if (ids === null) return where;
  where[Op.or] = [
    { from_godown_id: { [Op.in]: ids } },
    { to_godown_id:   { [Op.in]: ids } },
  ];
  return where;
}

/**
 * Reject a write that targets a godown the user can't access. Returns
 * an error string (truthy) or null (allowed).
 *
 * Pattern in controller:
 *   const denied = denyIfGodownInaccessible(req.body.godown_id, req.user);
 *   if (denied) return res.status(403).json({ error: denied });
 */
function denyIfGodownInaccessible(godown_id, user) {
  const ids = effectiveGodownIds(user);
  if (ids === null) return null;       // unrestricted
  if (godown_id == null) return null;  // no godown specified — caller's resolver handles
  if (ids.includes(parseInt(godown_id, 10))) return null;
  return 'You do not have access to that godown.';
}

module.exports = {
  effectiveGodownIds,
  scopeWhereByGodown,
  scopeWhereByGodownEither,
  denyIfGodownInaccessible,
};
