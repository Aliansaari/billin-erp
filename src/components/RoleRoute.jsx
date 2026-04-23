import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import usePermission from '../hooks/usePermission';

/*
 * Route-level permission gate.
 *
 *   <Route path="/settings/users" element={
 *     <RoleRoute perm="settings.manage_users"><UserManagement /></RoleRoute>
 *   } />
 *
 * If the user lacks the permission, they're bounced to the dashboard (or
 * a custom `redirectTo`) with a small banner message. We don't render a
 * hard 403 page because every page in this app lives inside the AppLayout
 * shell — the soft redirect keeps them in the working app and lets them
 * pick a different menu item.
 *
 * For actions that should show a page but disable a button, use <Gate>
 * instead of this.
 */
export default function RoleRoute({ perm, redirectTo = '/', children }) {
  const { can, canAny, user } = usePermission();
  const location = useLocation();

  const ok = Array.isArray(perm) ? canAny(perm) : can(perm);
  if (ok) return <>{children}</>;

  // Pass the attempted path + perm to the dashboard so it can surface a
  // toast. We stash via state rather than query string to avoid polluting
  // the URL bar with "?denied=..." on every refresh.
  return (
    <Navigate
      to={redirectTo}
      replace
      state={{
        __denied: {
          perm: Array.isArray(perm) ? perm.join(' / ') : perm,
          path: location.pathname,
          role: user?.role || user?.role_name || 'your role',
        },
      }}
    />
  );
}
