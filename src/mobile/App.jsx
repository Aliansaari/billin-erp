import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider } from 'antd-mobile';
import enUS from 'antd-mobile/es/locales/en-US';
import useAuthStore from '../store/authStore';
import useThemeStore from '../store/themeStore';
import Login from './pages/Login';
import Home from './pages/Home';
import Dashboard from './pages/Dashboard';
import VouchersList from './pages/VouchersList';
import BillDetail from './pages/BillDetail';
import DayBook from './pages/DayBook';
import Search from './pages/Search';
import Stock from './pages/Stock';
import StockMovement from './pages/StockMovement';
import SimpleScreen from './pages/SimpleScreen';
import Outstanding from './pages/Outstanding';
import Reports from './pages/Reports';
import BillForm from './pages/BillForm';
import VoucherForm from './pages/VoucherForm';
import PartyForm from './pages/PartyForm';
import AppShell from './components/AppShell';

function ProtectedRoute({ children }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function MobileThemeSync() {
  const appearance = useThemeStore((s) => s.appearance);
  const themeStyle = useThemeStore((s) => s.themeStyle);
  useEffect(() => {
    const apply = (mode) => {
      document.documentElement.setAttribute('data-mobile-theme', mode);
    };
    if (appearance === 'light' || appearance === 'dark') {
      apply(appearance);
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    apply(mq.matches ? 'dark' : 'light');
    const handler = (e) => apply(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [appearance]);
  useEffect(() => {
    document.documentElement.setAttribute('data-mobile-style', themeStyle === 'modern' ? 'modern' : 'classic');
  }, [themeStyle]);
  return null;
}

export default function MobileApp() {
  return (
    <ConfigProvider locale={enUS}>
      <MobileThemeSync />
      <Routes>
        <Route path="/login" element={<Login />} />

        {/* Authenticated routes — wrapped in AppShell which renders the
            persistent bottom TabBar. Drill-down screens (BillDetail, DayBook)
            sit inside the same shell so the tab bar stays accessible. */}
        <Route
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        >
          <Route path="/"           element={<Home />} />
          <Route path="/dashboard"  element={<Dashboard />} />
          <Route path="/day-book"   element={<DayBook />} />
          <Route path="/vouchers"   element={<VouchersList />} />
          <Route path="/vouchers/:type/:id" element={<BillDetail />} />
          <Route path="/sale/new"      element={<BillForm type="sale" />} />
          <Route path="/purchase/new"  element={<BillForm type="purchase" />} />
          <Route path="/receipt/new"   element={<VoucherForm type="Receipt" />} />
          <Route path="/payment/new"   element={<VoucherForm type="Payment" />} />
          <Route path="/customer/new"  element={<PartyForm type="Customer" />} />
          <Route path="/supplier/new"  element={<PartyForm type="Supplier" />} />
          <Route path="/outstanding" element={<Outstanding />} />
          <Route path="/stock"      element={<Stock />} />
          <Route path="/stock/:id"  element={<StockMovement />} />
          <Route path="/items"      element={<SimpleScreen title="Items" />} />
          <Route path="/reports"    element={<Reports />} />
          <Route path="/search"     element={<Search />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ConfigProvider>
  );
}
