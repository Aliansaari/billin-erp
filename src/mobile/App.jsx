import React, { useEffect, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, setDefaultConfig } from 'antd-mobile';
import enUS from 'antd-mobile/es/locales/en-US';

// <ConfigProvider> only reaches components rendered inside the React tree.
// The imperative APIs — Dialog.confirm, Dialog.alert, Toast — render into
// their own root, never see that provider, and fall back to antd-mobile's
// built-in locale, which is Chinese. That is why a "Switch company?" dialog
// showed a 取消 button next to an English one. setDefaultConfig is the global
// switch those imperative calls actually read.
setDefaultConfig({ locale: enUS });

// A company switch sets a flag that makes the API layer ignore 401s while the
// old token is being retired. Reaching this line means the app has re-mounted,
// so the switch is finished — clear it immediately rather than waiting for its
// safety timeout, during which a genuine 401 would be swallowed.
try { sessionStorage.removeItem('zehen_switching'); } catch { /* private mode */ }
import useAuthStore from '../store/authStore';
import useThemeStore from '../store/themeStore';
import AppShell from './components/AppShell';

// Eager — needed for first paint after launch / login. Keeping these in the
// main bundle means the landing screen renders without a chunk round-trip.
import Login from './pages/Login';
import Home from './pages/Home';
import Dashboard from './pages/Dashboard';
import { syncStatusBar } from './utils/nativeShell';
import AppLock from './components/AppLock';

// Lazy — every other screen is code-split into its own chunk, loaded on
// first visit. This keeps the boot bundle small (the heavy PDF/report pages
// that pull in jspdf + html2canvas no longer load at startup), which is the
// single biggest win for cold-start time and main-thread smoothness.
const VouchersList       = lazy(() => import('./pages/VouchersList'));
const BillDetail         = lazy(() => import('./pages/BillDetail'));
const DayBook            = lazy(() => import('./pages/DayBook'));
const Search             = lazy(() => import('./pages/Search'));
const Stock              = lazy(() => import('./pages/Stock'));
const StockMovement      = lazy(() => import('./pages/StockMovement'));
const StockMovementPicker = lazy(() => import('./pages/StockMovementPicker'));
const SimpleScreen       = lazy(() => import('./pages/SimpleScreen'));
const Outstanding        = lazy(() => import('./pages/Outstanding'));
const Reports            = lazy(() => import('./pages/Reports'));
const BillForm           = lazy(() => import('./pages/BillForm'));
const VoucherForm        = lazy(() => import('./pages/VoucherForm'));
const PartyForm          = lazy(() => import('./pages/PartyForm'));
const SalesReport        = lazy(() => import('./pages/SalesReport'));
const PurchaseReport     = lazy(() => import('./pages/PurchaseReport'));
const MonthlySummary     = lazy(() => import('./pages/MonthlySummary'));
const LedgerPage         = lazy(() => import('./pages/LedgerPage'));
const PartyStatement     = lazy(() => import('./pages/PartyStatement'));
const TrialBalanceMobile = lazy(() => import('./pages/TrialBalanceMobile'));
const ProfitLossMobile   = lazy(() => import('./pages/ProfitLossMobile'));
const BalanceSheetMobile = lazy(() => import('./pages/BalanceSheetMobile'));
const GstSummary         = lazy(() => import('./pages/GstSummary'));
const Gstr1Mobile        = lazy(() => import('./pages/Gstr1Mobile'));
const Gstr3bMobile       = lazy(() => import('./pages/Gstr3bMobile'));
const CashFlowMobile     = lazy(() => import('./pages/CashFlowMobile'));
const BillsOutstanding   = lazy(() => import('./pages/BillsOutstanding'));
const SalesReturn        = lazy(() => import('./pages/SalesReturn'));
const PurchaseReturn     = lazy(() => import('./pages/PurchaseReturn'));
const SalesByItem        = lazy(() => import('./pages/SalesByItem'));
const PurchaseByItem     = lazy(() => import('./pages/PurchaseByItem'));
const FastSlowMovers     = lazy(() => import('./pages/FastSlowMovers'));
const ReorderAlert       = lazy(() => import('./pages/ReorderAlert'));

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
      // The status bar is part of the app's surface on a phone: leave it on
      // the Info.plist default and dark mode puts black glyphs on a near-black
      // header, so the clock and the battery disappear.
      syncStatusBar(mode === 'dark');
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
    // 'glass' layers on top of the editorial palette rather than replacing it,
    // so it inherits every colour decision and only changes the material.
    const style = ['modern', 'glass'].includes(themeStyle) ? themeStyle : 'classic';
    document.documentElement.setAttribute('data-mobile-style', style === 'glass' ? 'modern' : style);
    document.documentElement.setAttribute('data-mobile-material', style === 'glass' ? 'glass' : 'solid');
  }, [themeStyle]);
  return null;
}

export default function MobileApp() {
  return (
    <ConfigProvider locale={enUS}>
      <MobileThemeSync />

      <AppLock />
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
          <Route path="/reports"         element={<Reports />} />
          <Route path="/reports/sales"   element={<SalesReport />} />
          <Route path="/reports/purchases" element={<PurchaseReport />} />
          <Route path="/reports/monthly" element={<MonthlySummary />} />
          <Route path="/reports/ledger"  element={<LedgerPage />} />
          <Route path="/reports/stock-movement" element={<StockMovementPicker />} />
          <Route path="/reports/customer-statement" element={<PartyStatement partyType="Customer" />} />
          <Route path="/reports/supplier-statement" element={<PartyStatement partyType="Supplier" />} />
          <Route path="/reports/bills-receivable" element={<BillsOutstanding partyType="Customer" />} />
          <Route path="/reports/bills-payable"    element={<BillsOutstanding partyType="Supplier" />} />
          <Route path="/reports/sales-return"     element={<SalesReturn />} />
          <Route path="/reports/purchase-return"  element={<PurchaseReturn />} />
          <Route path="/reports/sales-by-item"    element={<SalesByItem />} />
          <Route path="/reports/purchase-by-item" element={<PurchaseByItem />} />
          <Route path="/reports/fast-slow"        element={<FastSlowMovers />} />
          <Route path="/reports/reorder-alert"    element={<ReorderAlert />} />
          <Route path="/reports/trial-balance"  element={<TrialBalanceMobile />} />
          <Route path="/reports/profit-loss"    element={<ProfitLossMobile />} />
          <Route path="/reports/balance-sheet"  element={<BalanceSheetMobile />} />
          <Route path="/reports/gst-summary"   element={<GstSummary />} />
          <Route path="/reports/gstr1"          element={<Gstr1Mobile />} />
          <Route path="/reports/gstr3b"         element={<Gstr3bMobile />} />
          <Route path="/reports/cash-flow"      element={<CashFlowMobile />} />
          <Route path="/search"     element={<Search />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ConfigProvider>
  );
}
