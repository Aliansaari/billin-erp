import useAuthStore from '../store/authStore';
import { hasPermission, hasAnyPermission } from '../utils/perms';

/*
 * Hook for permission checks. Returns both a single-path checker and a
 * hasAny helper plus the user/role for display purposes. Subscribes to
 * the auth store so UI re-renders when the user changes (log out/in,
 * role reassignment).
 *
 * Typical usage:
 *   const { can, role } = usePermission();
 *   if (!can('sales.create')) return null;
 *   <Button disabled={!can('sales.delete')}>Delete</Button>
 */
export default function usePermission() {
  const user = useAuthStore((s) => s.user);
  return {
    user,
    role: user?.role || user?.role_name || null,
    can: (path) => hasPermission(user, path),
    canAny: (paths) => hasAnyPermission(user, paths),
  };
}
