/*
 * Permission helper — mirror of server/middleware/permissions.js hasPermission.
 *
 * Keep the semantics byte-identical across the stack. The backend is still
 * the source of truth: UI gates here are for UX (hide things users can't
 * use), not security — every action is re-checked server-side.
 *
 * Path syntax: dot-separated module.action, e.g. "sales.create",
 * "settings.manage_users". Any level that evaluates to `true` short-
 * circuits and grants all nested permissions (so `{ sales: true }`
 * grants `sales.create`, `sales.edit`, etc. and `{ all: true }` grants
 * everything).
 *
 * Role-name fast-paths for "Super Admin" and "Admin" match the backend so
 * a freshly-seeded admin account can always reach everything even if
 * their permissions_json somehow arrives empty.
 */

export function hasPermission(user, path) {
  if (!user) return false;
  const roleName = user.role_name || user.role || null;
  if (roleName === 'Super Admin' || roleName === 'Admin') return true;

  const perms = user.permissions || user.permissions_json || {};
  if (perms.all === true) return true;
  if (!path) return false;

  const parts = String(path).split('.');
  let cur = perms;
  for (const part of parts) {
    if (cur === true) return true;
    if (!cur || typeof cur !== 'object') return false;
    cur = cur[part];
  }
  return cur === true;
}

// Test the user against any of a list of permission paths. Useful when a
// page surfaces many actions and the question is "should the page exist
// at all for this user" — if any permission passes, keep the page.
export function hasAnyPermission(user, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true;
  return paths.some(p => hasPermission(user, p));
}
