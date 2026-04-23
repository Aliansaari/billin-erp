import React from 'react';
import usePermission from '../hooks/usePermission';

/*
 * Conditional-render wrapper for permission-gated UI.
 *
 *   <Gate perm="sales.create">
 *     <Button>New Sale</Button>
 *   </Gate>
 *
 *   <Gate perm={['sales.create', 'sales.edit']}>...</Gate>
 *     → renders if ANY of the perms pass (hasAny semantics)
 *
 *   <Gate perm="reports.view" fallback={<em>Access denied</em>}>...</Gate>
 *
 * Intentionally tiny — the heavy lifting is in usePermission / perms.js.
 * Avoid using Gate for security; it only hides UI. Server still enforces.
 */
export default function Gate({ perm, children, fallback = null }) {
  const { can, canAny } = usePermission();
  const ok = Array.isArray(perm) ? canAny(perm) : can(perm);
  return ok ? <>{children}</> : fallback;
}
