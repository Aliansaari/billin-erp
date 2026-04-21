import React, { useState, useCallback } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import useAuthStore from './store/authStore';
import { useGlobalShortcuts, SHORTCUTS_LIST } from './hooks/useKeyboardShortcuts';
import AppLayout from './components/Layout/AppLayout';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/Dashboard';
import CustomerList from './pages/parties/CustomerList';
import SupplierList from './pages/parties/SupplierList';
import PartyDetail from './pages/parties/PartyDetail';
import ProductList from './pages/inventory/ProductList';
import CategoryList from './pages/inventory/CategoryList';
import StockReport from './pages/inventory/StockReport';
import StockReportPro from './pages/inventory/StockReportPro';
import PurchaseBillForm from './pages/purchase/PurchaseBillForm';
import PurchaseList from './pages/purchase/PurchaseList';
import SalesBillForm from './pages/sales/SalesBillForm';
import SalesList from './pages/sales/SalesList';
import SalesReturnForm from './pages/returns/SalesReturnForm';
import SalesReturnList from './pages/returns/SalesReturnList';
import PurchaseReturnForm from './pages/returns/PurchaseReturnForm';
import PurchaseReturnList from './pages/returns/PurchaseReturnList';
import PaymentEntry from './pages/payments/PaymentEntry';
import ReceiptEntry from './pages/payments/ReceiptEntry';
import PaymentList from './pages/payments/PaymentList';
import SalesReport from './pages/reports/SalesReport';
import PurchaseReport from './pages/reports/PurchaseReport';
import StockReportPage from './pages/reports/StockReportPage';
import PartyLedger from './pages/reports/PartyLedger';
import ProfitLoss from './pages/reports/ProfitLoss';
import CompanyProfile from './pages/settings/CompanyProfile';
import UserManagement from './pages/settings/UserManagement';
import BarcodeSettingsPage from './pages/settings/BarcodeSettings';
import ModuleSettings from './pages/settings/ModuleSettings';
import BackupRestore from './pages/settings/BackupRestore';
import ThemeSettings from './pages/settings/ThemeSettings';

function PrivateRoute({ children }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const mustChangePassword = useAuthStore((s) => s.mustChangePassword);
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  // Force the password-change flow before any other authenticated route
  // becomes reachable. Only `/change-password` itself is exempt, otherwise
  // we'd loop. The server sets this flag on login when the user authenticated
  // with the seeded default password (admin/admin123).
  if (mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return children;
}

function ShortcutsOverlay({ visible, onClose }) {
  if (!visible) return null;
  return (
    <div className="erp-shortcuts-overlay" onClick={onClose}>
      <div className="erp-shortcuts-panel" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1f2937' }}>⌨️ Keyboard Shortcuts</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', fontSize: 20, color: '#9ca3af' }}>✕</span>
        </div>
        <div>
          {SHORTCUTS_LIST.map((s, i) => (
            <div key={i} className="erp-shortcut-row">
              <span style={{ color: '#374151', fontSize: 14 }}>{s.description}</span>
              <span>
                {s.keys.split(' + ').map((k, j) => (
                  <span key={j}>
                    {j > 0 && <span style={{ color: '#9ca3af', margin: '0 4px' }}>+</span>}
                    <kbd className="erp-kbd">{k}</kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        <p style={{ marginTop: 20, marginBottom: 0, color: '#9ca3af', fontSize: 12, textAlign: 'center' }}>
          Press <kbd className="erp-kbd">Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [showShortcuts, setShowShortcuts] = useState(false);

  const toggleHelp = useCallback((val) => {
    if (typeof val === 'boolean') setShowShortcuts(val);
    else setShowShortcuts((p) => !p);
  }, []);

  useGlobalShortcuts({ onToggleHelp: toggleHelp });

  return (
    <>
      <ShortcutsOverlay visible={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/change-password" element={<PrivateRoute><ChangePassword /></PrivateRoute>} />
        <Route path="/" element={<PrivateRoute><AppLayout /></PrivateRoute>}>
          <Route index element={<Dashboard />} />
          <Route path="customers" element={<CustomerList />} />
          <Route path="suppliers" element={<SupplierList />} />
          <Route path="parties/:id" element={<PartyDetail />} />
          <Route path="products" element={<ProductList />} />
          <Route path="categories" element={<CategoryList />} />
          <Route path="stock-report" element={<StockReport />} />
          <Route path="stock-report-pro" element={<StockReportPro />} />
          <Route path="purchase/new" element={<PurchaseBillForm />} />
          <Route path="purchase/edit/:id" element={<PurchaseBillForm />} />
          <Route path="purchases" element={<PurchaseList />} />
          <Route path="sale/new" element={<SalesBillForm />} />
          <Route path="sale/edit/:id" element={<SalesBillForm />} />
          <Route path="sales" element={<SalesList />} />
          <Route path="sales-return/new" element={<SalesReturnForm />} />
          <Route path="sales-return/edit/:id" element={<SalesReturnForm />} />
          <Route path="sales-returns" element={<SalesReturnList />} />
          <Route path="purchase-return/new" element={<PurchaseReturnForm />} />
          <Route path="purchase-return/edit/:id" element={<PurchaseReturnForm />} />
          <Route path="purchase-returns" element={<PurchaseReturnList />} />
          <Route path="payment/new" element={<PaymentEntry />} />
          <Route path="receipt/new" element={<ReceiptEntry />} />
          <Route path="payments" element={<PaymentList />} />
          <Route path="reports/sales" element={<SalesReport />} />
          <Route path="reports/purchases" element={<PurchaseReport />} />
          <Route path="reports/stock" element={<StockReportPage />} />
          <Route path="reports/party-ledger" element={<PartyLedger />} />
          <Route path="reports/profit-loss" element={<ProfitLoss />} />
          <Route path="settings/company" element={<CompanyProfile />} />
          <Route path="settings/users" element={<UserManagement />} />
          <Route path="settings/barcode" element={<BarcodeSettingsPage />} />
          <Route path="settings/modules" element={<ModuleSettings />} />
          <Route path="settings/backup" element={<BackupRestore />} />
          <Route path="settings/theme" element={<ThemeSettings />} />
        </Route>
      </Routes>
    </>
  );
}
