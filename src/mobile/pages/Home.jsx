import React from 'react';
import { Navigate } from 'react-router-dom';
import useAuthStore from '../../store/authStore';
import SalesmanHome from './SalesmanHome';

// Role-based landing. Salesman → field-sale flow (separate from the owner
// dashboard because their daily job is sale-entry, not browsing reports).
// Everyone else (admin / owner / manager / staff) → the Dashboard tab.
export default function Home() {
  const user = useAuthStore((s) => s.user);
  const role = String(user?.role || '').toLowerCase();
  if (role.includes('sales')) return <SalesmanHome />;
  return <Navigate to="/dashboard" replace />;
}
