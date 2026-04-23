/*
 * Permission checks for authenticated routes.
 *
 * Three entry points, kept around so we don't have to rewrite every route
 * at once:
 *
 *   hasPermission(user, 'sales.create')
 *     Pure function. Source of truth for "can this user do X". Also used
 *     by the frontend via a shared implementation — keep the semantics
 *     identical on both sides.
 *
 *   requirePermission('sales.create')
 *     Modern middleware. Returns 403 if the current user lacks the
 *     permission path. Handles super-admin (`all: true`), module-level
 *     (`sales: true`), and per-action (`sales.create: true`) grants.
 *
 *   checkPermission('Admin', 'Manager')          [legacy]
 *   checkSpecificPermission('can_view_reports')  [legacy]
 *     Pre-permission-matrix gates that a few routes still use. Kept
 *     compatible so I don't need to flip everything in one commit. New
 *     routes should use requirePermission.
 *
 * "Super Admin" and "Admin" role names always short-circuit to allow —
 * this matches the implicit behaviour the old checkPermission had for
 * 'Admin' and is the safe-by-default choice (an admin without a perm bit
 * set on their role row is still an admin).
 */

function hasPermission(user, path) {
  if (!user) return false;
  const role = user.Role || user.role || null;
  const roleName = (role && role.role_name) || user.role_name || user.role || null;

  // Super Admin always wins — no per-user override can lock a super-admin
  // out of their own system (we'd have no way back in if someone did).
  if (roleName === 'Super Admin') return true;

  // Permission source precedence:
  //   1. user.custom_permissions (explicit per-user override, NULL = inherit)
  //   2. role.permissions_json   (the template for the role)
  //   3. user.permissions / user.permissions_json (flattened payload from login)
  // The first non-null source is used exclusively — we do NOT merge, so an
  // admin who ticks fewer boxes for this specific user really does restrict
  // them even if the role template would have allowed it.
  const perms = (user.custom_permissions && user.custom_permissions !== null)
    ? user.custom_permissions
    : ((role && role.permissions_json)
        || user.permissions_json
        || user.permissions
        || {});

  if (perms.all === true) return true;

  // Admin role-name fast-path runs AFTER the override check so a
  // deliberately-restricted Admin account still gets its restrictions.
  if (roleName === 'Admin' && !user.custom_permissions) return true;

  if (!path) return false;

  const parts = String(path).split('.');
  let cur = perms;
  for (const part of parts) {
    if (cur === true) return true;         // module-level grant covers all actions
    if (!cur || typeof cur !== 'object') return false;
    cur = cur[part];
  }
  return cur === true;
}

function requirePermission(path) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (hasPermission(req.user, path)) return next();
    return res.status(403).json({ error: 'Insufficient permissions', required: path });
  };
}

// ─── Legacy helpers ──────────────────────────────────────────────────────
const checkPermission = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.Role) return res.status(403).json({ error: 'Access denied' });
    const userRole = req.user.Role.role_name;
    if (userRole === 'Super Admin' || userRole === 'Admin') return next();
    if (allowedRoles.includes(userRole)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
};

const checkSpecificPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user || !req.user.Role) return res.status(403).json({ error: 'Access denied' });
    if (req.user.Role.role_name === 'Super Admin' || req.user.Role.role_name === 'Admin') return next();
    if (req.user.Role[permission]) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
};

module.exports = { hasPermission, requirePermission, checkPermission, checkSpecificPermission };
