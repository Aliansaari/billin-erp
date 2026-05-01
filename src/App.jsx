import React, { useState, useCallback, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import useAuthStore from './store/authStore';
import { refreshFinancialYear } from './hooks/useFinancialYear';
import { useGlobalShortcuts, SHORTCUTS_LIST } from './hooks/useKeyboardShortcuts';
import AppLayout from './components/Layout/AppLayout';
import RoleRoute from './components/RoleRoute';
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
import StockMovement from './pages/inventory/StockMovement';
import StockTransferList from './pages/inventory/StockTransferList';
import StockTransferForm from './pages/inventory/StockTransferForm';
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
import DayBook from './pages/reports/DayBook';
import StockReportPage from './pages/reports/StockReportPage';
import PartyLedger from './pages/reports/PartyLedger';
import ProfitLoss from './pages/reports/ProfitLoss';
import AgingReport from './pages/reports/AgingReport';
import BillsReceivable from './pages/reports/BillsReceivable';
import BillsPayable from './pages/reports/BillsPayable';
import MonthlySalesRegister    from './pages/reports/MonthlySalesSummary';
import MonthlyPurchaseRegister from './pages/reports/MonthlyPurchaseSummary';
import MonthlyPaymentRegister  from './pages/reports/MonthlyPaymentRegister';
import MonthlyReceiptRegister  from './pages/reports/MonthlyReceiptRegister';
import ProductSalesReport      from './pages/reports/ProductSalesReport';
import ProductPurchaseReport   from './pages/reports/ProductPurchaseReport';
import GSTR1Report from './pages/reports/GSTR1Report';
import GSTR3BReport from './pages/reports/GSTR3BReport';
import TrialBalance from './pages/reports/TrialBalance';
import BalanceSheet from './pages/reports/BalanceSheet';
import CashFlow from './pages/reports/CashFlow';
import HsnSummary from './pages/reports/HsnSummary';
import StockSummary from './pages/reports/StockSummary';
import Movers from './pages/reports/Movers';
import GodownTransferRegister from './pages/reports/GodownTransferRegister';
import GodownValuation from './pages/reports/GodownValuation';
import ReportsHub from './pages/reports/ReportsHub';
import JournalVoucherList from './pages/accounts/JournalVoucherList';
import JournalVoucherForm from './pages/accounts/JournalVoucherForm';
import LedgerIntegrity from './pages/accounts/LedgerIntegrity';
import ImportV2 from './pages/settings/ImportV2';
import CompanyProfile from './pages/settings/CompanyProfile';
import UserManagement from './pages/settings/UserManagement';
import GodownList from './pages/settings/GodownList';
import BarcodeSettingsPage from './pages/settings/BarcodeSettings';
import ModuleSettings from './pages/settings/ModuleSettings';
import BackupRestore from './pages/settings/BackupRestore';
import ThemeSettings from './pages/settings/ThemeSettings';
import ImportExport from './pages/settings/ImportExport';
import TallySync from './pages/settings/TallySync';
import PrintSettings from './pages/settings/PrintSettings';

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
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const toggleHelp = useCallback((val) => {
    if (typeof val === 'boolean') setShowShortcuts(val);
    else setShowShortcuts((p) => !p);
  }, []);

  useGlobalShortcuts({ onToggleHelp: toggleHelp });

  // Refresh the cached Financial Year on every authenticated boot.
  // The cache (localStorage) hydrates pickers synchronously on first
  // paint, so this background fetch only updates the values if admin
  // changed them since the last login. No flicker.
  useEffect(() => {
    if (isAuthenticated) refreshFinancialYear();
  }, [isAuthenticated]);

  return (
    <>
      <ShortcutsOverlay visible={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/change-password" element={<PrivateRoute><ChangePassword /></PrivateRoute>} />
        <Route path="/" element={<PrivateRoute><AppLayout /></PrivateRoute>}>
          {/*
            Dashboard is always reachable — it's the redirect target for
            users whose starting route is gated off.
          */}
          <Route index element={<Dashboard />} />

          {/* Parties */}
          <Route path="customers"    element={<RoleRoute perm="parties.view"><CustomerList /></RoleRoute>} />
          <Route path="suppliers"    element={<RoleRoute perm="parties.view"><SupplierList /></RoleRoute>} />
          <Route path="parties/:id"  element={<RoleRoute perm="parties.view"><PartyDetail /></RoleRoute>} />

          {/* Inventory */}
          <Route path="products"                       element={<RoleRoute perm="inventory.view"><ProductList /></RoleRoute>} />
          <Route path="categories"                     element={<RoleRoute perm="inventory.view"><CategoryList /></RoleRoute>} />
          <Route path="stock-report"                   element={<RoleRoute perm="inventory.view"><StockReport /></RoleRoute>} />
          <Route path="stock-report-pro"               element={<RoleRoute perm="inventory.view"><StockReportPro /></RoleRoute>} />
          {/* Splat route — keeps StockMovement mounted when navigating
               from /stock-movement to /stock-movement/:productId, so
               clicking a product doesn't remount the whole page (which
               previously re-ran loadProducts and caused a visible blink). */}
          <Route path="stock-movement/*"               element={<RoleRoute perm="inventory.view"><StockMovement /></RoleRoute>} />
          <Route path="stock-transfers"                element={<RoleRoute perm="stock_transfers.view"><StockTransferList /></RoleRoute>} />
          <Route path="stock-transfer/new"             element={<RoleRoute perm="stock_transfers.create"><StockTransferForm /></RoleRoute>} />
          <Route path="stock-transfer/edit/:id"        element={<RoleRoute perm="stock_transfers.view"><StockTransferForm /></RoleRoute>} />

          {/* Purchase */}
          <Route path="purchase/new"     element={<RoleRoute perm="purchase.create"><PurchaseBillForm /></RoleRoute>} />
          <Route path="purchase/edit/:id" element={<RoleRoute perm="purchase.edit"><PurchaseBillForm /></RoleRoute>} />
          <Route path="purchases"        element={<RoleRoute perm="purchase.view"><PurchaseList /></RoleRoute>} />

          {/* Sales */}
          <Route path="sale/new"      element={<RoleRoute perm="sales.create"><SalesBillForm /></RoleRoute>} />
          <Route path="sale/edit/:id" element={<RoleRoute perm="sales.edit"><SalesBillForm /></RoleRoute>} />
          <Route path="sales"         element={<RoleRoute perm="sales.view"><SalesList /></RoleRoute>} />

          {/* Returns — split by module so sales staff can't touch supplier returns */}
          <Route path="sales-return/new"      element={<RoleRoute perm="sales_returns.create"><SalesReturnForm /></RoleRoute>} />
          <Route path="sales-return/edit/:id" element={<RoleRoute perm="sales_returns.edit"><SalesReturnForm /></RoleRoute>} />
          <Route path="sales-returns"         element={<RoleRoute perm="sales_returns.view"><SalesReturnList /></RoleRoute>} />
          <Route path="purchase-return/new"      element={<RoleRoute perm="purchase_returns.create"><PurchaseReturnForm /></RoleRoute>} />
          <Route path="purchase-return/edit/:id" element={<RoleRoute perm="purchase_returns.edit"><PurchaseReturnForm /></RoleRoute>} />
          <Route path="purchase-returns"         element={<RoleRoute perm="purchase_returns.view"><PurchaseReturnList /></RoleRoute>} />

          {/* Payments */}
          <Route path="payment/new" element={<RoleRoute perm="payments.create"><PaymentEntry /></RoleRoute>} />
          <Route path="receipt/new" element={<RoleRoute perm="payments.create"><ReceiptEntry /></RoleRoute>} />
          <Route path="payments"    element={<RoleRoute perm="payments.view"><PaymentList /></RoleRoute>} />

          {/* Reports */}
          {/* Reports hub — landing for all reports. Cluttered flat dropdown
              has been replaced by this page + a favorites-only nav menu. */}
          <Route path="reports"               element={<ReportsHub />} />
          <Route path="reports/sales"         element={<RoleRoute perm="reports.view"><SalesReport /></RoleRoute>} />
          <Route path="reports/purchases"     element={<RoleRoute perm="reports.view"><PurchaseReport /></RoleRoute>} />
          <Route path="reports/stock"         element={<RoleRoute perm="reports.view"><StockReportPage /></RoleRoute>} />
          <Route path="reports/party-ledger"  element={<RoleRoute perm="accounts.view"><PartyLedger /></RoleRoute>} />
          <Route path="reports/profit-loss"   element={<RoleRoute perm="accounts.view"><ProfitLoss /></RoleRoute>} />
          <Route path="reports/aging"         element={<RoleRoute perm="reports.view"><AgingReport /></RoleRoute>} />
          <Route path="reports/bills-receivable" element={<RoleRoute perm="reports.view"><BillsReceivable /></RoleRoute>} />
          <Route path="reports/bills-payable"    element={<RoleRoute perm="reports.view"><BillsPayable /></RoleRoute>} />
          <Route path="reports/monthly-sales"     element={<RoleRoute perm="reports.view"><MonthlySalesRegister /></RoleRoute>} />
          <Route path="reports/monthly-purchases" element={<RoleRoute perm="reports.view"><MonthlyPurchaseRegister /></RoleRoute>} />
          <Route path="reports/monthly-payments"  element={<RoleRoute perm="reports.view"><MonthlyPaymentRegister /></RoleRoute>} />
          <Route path="reports/monthly-receipts"  element={<RoleRoute perm="reports.view"><MonthlyReceiptRegister /></RoleRoute>} />
          <Route path="reports/product-sales"     element={<RoleRoute perm="reports.view"><ProductSalesReport /></RoleRoute>} />
          <Route path="reports/product-purchases" element={<RoleRoute perm="reports.view"><ProductPurchaseReport /></RoleRoute>} />
          <Route path="reports/gstr1"         element={<RoleRoute perm="reports.view"><GSTR1Report /></RoleRoute>} />
          <Route path="reports/gstr3b"        element={<RoleRoute perm="reports.view"><GSTR3BReport /></RoleRoute>} />
          <Route path="reports/trial-balance"     element={<RoleRoute perm="accounts.view"><TrialBalance /></RoleRoute>} />
          <Route path="reports/balance-sheet"     element={<RoleRoute perm="accounts.view"><BalanceSheet /></RoleRoute>} />
          <Route path="reports/cash-flow"         element={<RoleRoute perm="accounts.view"><CashFlow /></RoleRoute>} />
          <Route path="reports/day-book"          element={<RoleRoute perm="accounts.view"><DayBook /></RoleRoute>} />
          <Route path="reports/hsn-summary"        element={<RoleRoute perm="reports.view"><HsnSummary /></RoleRoute>} />
          <Route path="reports/stock-summary"      element={<RoleRoute perm="reports.view"><StockSummary /></RoleRoute>} />
          <Route path="reports/movers"             element={<RoleRoute perm="reports.view"><Movers /></RoleRoute>} />
          <Route path="reports/transfer-register"  element={<RoleRoute perm="reports.view"><GodownTransferRegister /></RoleRoute>} />
          <Route path="reports/godown-valuation"   element={<RoleRoute perm="reports.view"><GodownValuation /></RoleRoute>} />

          {/* Accounts (double-entry) */}
          <Route path="accounts/journal"          element={<RoleRoute perm="accounts.view"><JournalVoucherList /></RoleRoute>} />
          <Route path="accounts/journal/new"      element={<RoleRoute perm="accounts.view"><JournalVoucherForm /></RoleRoute>} />
          <Route path="accounts/journal/edit/:id" element={<RoleRoute perm="accounts.view"><JournalVoucherForm /></RoleRoute>} />
          <Route path="accounts/integrity"        element={<RoleRoute perm="accounts.view"><LedgerIntegrity /></RoleRoute>} />

          {/* Settings */}
          <Route path="settings/company"        element={<RoleRoute perm="settings.manage_company"><CompanyProfile /></RoleRoute>} />
          <Route path="settings/users"          element={<RoleRoute perm="settings.manage_users"><UserManagement /></RoleRoute>} />
          <Route path="settings/barcode"        element={<RoleRoute perm="settings.barcode"><BarcodeSettingsPage /></RoleRoute>} />
          <Route path="settings/modules"        element={<RoleRoute perm="settings.manage_company"><ModuleSettings /></RoleRoute>} />
          <Route path="settings/backup"         element={<RoleRoute perm="settings.backup"><BackupRestore /></RoleRoute>} />
          {/* Theme is per-user UX — anyone can pick light/dark. */}
          <Route path="settings/theme"          element={<ThemeSettings />} />
          <Route path="settings/import-export"  element={<RoleRoute perm="settings.import_export"><ImportExport /></RoleRoute>} />
          <Route path="settings/import"         element={<RoleRoute perm="settings.import_export"><ImportV2 /></RoleRoute>} />
          <Route path="settings/tally"          element={<RoleRoute perm="settings.tally"><TallySync /></RoleRoute>} />
          <Route path="settings/print"          element={<RoleRoute perm="settings.print"><PrintSettings /></RoleRoute>} />
          <Route path="settings/godowns"        element={<RoleRoute perm="godowns.view"><GodownList /></RoleRoute>} />
        </Route>
      </Routes>
    </>
  );
}
