import React, { useState, useCallback, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import useAuthStore from './store/authStore';
import { partyAPI } from './api';
import { refreshFinancialYear } from './hooks/useFinancialYear';
import { useGlobalShortcuts, SHORTCUTS_LIST } from './hooks/useKeyboardShortcuts';
import AppLayout from './components/Layout/AppLayout';
import RoleRoute from './components/RoleRoute';
import { GlobalSearchModal } from './components/GlobalSearch';
// DatePopup + MenuPopup providers are mounted in main.jsx (above this
// component) so that useGlobalShortcuts called from App's body can
// reach them via useContext.
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import Home from './pages/Home';
import Dashboard from './pages/Dashboard';
import CustomerList from './pages/parties/CustomerList';
import SupplierList from './pages/parties/SupplierList';
import ProductList from './pages/inventory/ProductList';
import CategoryList from './pages/inventory/CategoryList';
import StockReport from './pages/inventory/StockReport';
import StockReportPro from './pages/inventory/StockReportPro';
import SmartStockCategory from './pages/inventory/SmartStockCategory';
import StockMovement from './pages/inventory/StockMovement';
import StockTransferList from './pages/inventory/StockTransferList';
import StockTransferForm from './pages/inventory/StockTransferForm';
import BatchesList       from './pages/inventory/BatchesList';
import BatchDetail       from './pages/inventory/BatchDetail';
import ExpiryReport      from './pages/reports/ExpiryReport';
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
import CustomerStatement from './pages/reports/CustomerStatement';
import SupplierStatement from './pages/reports/SupplierStatement';
import Ledger from './pages/reports/Ledger';
import ProfitLoss from './pages/reports/ProfitLoss';
import AgingReport from './pages/reports/AgingReport';
import ReceivablesAging from './pages/reports/ReceivablesAging';
import PayablesAging from './pages/reports/PayablesAging';
import BillsReceivable from './pages/reports/BillsReceivable';
import BillsPayable from './pages/reports/BillsPayable';
import CustomerOutstanding from './pages/reports/CustomerOutstanding';
import SupplierOutstanding from './pages/reports/SupplierOutstanding';
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
import FundFlow from './pages/reports/FundFlow';
import HsnSummary from './pages/reports/HsnSummary';
import FastSlowStock from './pages/reports/FastSlowStock';
import GodownTransferRegister from './pages/reports/GodownTransferRegister';
import GodownValuation from './pages/reports/GodownValuation';
import ReportsHub from './pages/reports/ReportsHub';
import JournalVoucherList from './pages/accounts/JournalVoucherList';
import JournalVoucherForm from './pages/accounts/JournalVoucherForm';
import LedgerIntegrity from './pages/accounts/LedgerIntegrity';
import BankList            from './pages/banks/BankList';
import BankStatement       from './pages/banks/BankStatement';
import BankReconciliation  from './pages/banks/BankReconciliation';
import LoanList            from './pages/loans/LoanList';
import LoanStatement       from './pages/loans/LoanStatement';
import LoanSchedule        from './pages/loans/LoanSchedule';
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
import HomeSettings from './pages/settings/HomeSettings';
import SettingsLayout from './pages/settings/SettingsLayout';

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

// Legacy /reports/party-ledger redirect. The page was split into
// Customer Statement / Supplier Statement; this component resolves the
// destination so old bookmarks AND existing in-app drills land on the
// correct flavor.
//
// Param conventions seen in the wild (all preserved):
//   ?id=<party_id>        — what the new pages emit
//   ?party_id=<party_id>  — what BillsOutstanding / TrialBalance emit
//   ?ledger_id=<id>       — what TrialBalance emits for COA-side rows
//                            (Sales A/c, Bank, etc.) → goes to /reports/ledger
//   ?from=&to=            — preserved through the redirect either way
//
// Empty querystring → default to Customer Statement (more common).
// Removing the route entirely would 404 every printed/emailed link
// and every drill on Aging / BillsOutstanding / TrialBalance, so the
// redirect stays for the long haul.
function PartyLedgerRedirect() {
  const [search] = useSearchParamsHack();
  const partyId  = search.get('id') || search.get('party_id');
  const ledgerId = search.get('ledger_id');
  const passthrough = (() => {
    const qs = new URLSearchParams();
    if (search.get('from')) qs.set('from', search.get('from'));
    if (search.get('to'))   qs.set('to',   search.get('to'));
    return qs.toString();
  })();
  const [target, setTarget] = useState(null);
  useEffect(() => {
    // COA-side drill (TrialBalance row that's NOT a party). Bypass the
    // party API; go straight to /reports/ledger with the ledger_id.
    if (ledgerId) {
      const qs = new URLSearchParams(passthrough);
      qs.set('id', ledgerId);
      setTarget(`/reports/ledger?${qs.toString()}`);
      return;
    }
    // No identity at all → blank Customer Statement.
    if (!partyId) {
      setTarget('/reports/customer-statement' + (passthrough ? `?${passthrough}` : ''));
      return;
    }
    // Party id → fetch type → bounce. partyAPI is already in the
    // main bundle (used widely), so a static import here is the
    // cheapest path; a dynamic import would just confuse the bundler
    // without saving any bytes.
    partyAPI.getById(partyId)
      .then(res => {
        const p = res.data?.data || res.data;
        const route = p?.party_type === 'Supplier'
          ? '/reports/supplier-statement'
          : '/reports/customer-statement';
        const qs = new URLSearchParams(passthrough);
        qs.set('id', String(partyId));
        setTarget(`${route}?${qs.toString()}`);
      })
      .catch(() => {
        // Unknown party — land on Customer Statement so the picker
        // is at least visible. Don't dead-end on an error.
        setTarget('/reports/customer-statement');
      });
  }, [partyId, ledgerId, passthrough]);
  if (!target) return null;          // brief blank while resolving
  return <Navigate to={target} replace />;
}
// Tiny shim so the redirect component can read the URL search params
// without dragging react-router-dom's hook into App.jsx's top-level
// imports list (which already pulls Routes/Route/Navigate). Reading
// window.location.search is fine here — the component runs once on
// mount, doesn't subscribe to changes.
function useSearchParamsHack() {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  return [params];
}

// Legacy /parties/:id redirect. The old PartyDetail page (a Ledger/Info
// tab view at /parties/:id) has been retired in favour of the unified
// Customer / Supplier Statement pages. Old bookmarks, deep links, and
// any in-app navigation that hadn't been rewired all land here, get
// the party type resolved, and bounce to the correct statement page
// with ?id=<party_id> so the picker comes up pre-selected.
function PartyDetailRedirect() {
  const { id } = useParams();
  const [target, setTarget] = useState(null);
  useEffect(() => {
    if (!id) { setTarget('/customers'); return; }
    partyAPI.getById(id)
      .then(res => {
        const p = res.data?.data || res.data;
        const route = p?.party_type === 'Supplier'
          ? '/reports/supplier-statement'
          : '/reports/customer-statement';
        setTarget(`${route}?id=${id}`);
      })
      .catch(() => setTarget('/customers'));
  }, [id]);
  if (!target) return null;
  return <Navigate to={target} replace />;
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
      {/* Global ⌘K palette — mounted once for all authenticated routes; opens
          via the `global-search:open` window event dispatched by callers
          like the keyboard hook or any topbar trigger. The modal manages
          its own visibility and Esc handling. Only render when authenticated
          so the login screen stays clean and the palette never tries to
          fetch parties unauthed. */}
      {isAuthenticated && <GlobalSearchModal />}
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/change-password" element={<PrivateRoute><ChangePassword /></PrivateRoute>} />
        <Route path="/" element={<PrivateRoute><AppLayout /></PrivateRoute>}>
          {/*
            / is the Command Center (Home) — greeting, global search, quick
            actions, KPI strip. The deep 9-up Dashboard moved to /dashboard
            so the home page stays a single-screen launchpad. Both routes
            are always reachable; either is a safe fallback when an
            operator's intended starting route is gated off.
          */}
          <Route index element={<Home />} />
          <Route path="dashboard" element={<Dashboard />} />

          {/* Parties */}
          <Route path="customers"    element={<RoleRoute perm="parties.view"><CustomerList /></RoleRoute>} />
          <Route path="suppliers"    element={<RoleRoute perm="parties.view"><SupplierList /></RoleRoute>} />
          {/* /parties/:id — legacy detail page retired. The redirect below
              resolves party type and bounces to Customer / Supplier
              Statement (with ?id= so the picker pre-selects). */}
          <Route path="parties/:id"  element={<RoleRoute perm="parties.view"><PartyDetailRedirect /></RoleRoute>} />

          {/* Inventory */}
          <Route path="products"                       element={<RoleRoute perm="inventory.view"><ProductList /></RoleRoute>} />
          <Route path="categories"                     element={<RoleRoute perm="inventory.view"><CategoryList /></RoleRoute>} />
          <Route path="stock-report"                   element={<RoleRoute perm="inventory.view"><StockReport /></RoleRoute>} />
          <Route path="stock-report-pro"               element={<RoleRoute perm="inventory.view"><StockReportPro /></RoleRoute>} />
          <Route path="stock-report-pro/:categoryId"   element={<RoleRoute perm="inventory.view"><SmartStockCategory /></RoleRoute>} />
          {/* Splat route — keeps StockMovement mounted when navigating
               from /stock-movement to /stock-movement/:productId, so
               clicking a product doesn't remount the whole page (which
               previously re-ran loadProducts and caused a visible blink). */}
          <Route path="stock-movement/*"               element={<RoleRoute perm="inventory.view"><StockMovement /></RoleRoute>} />
          <Route path="stock-transfers"                element={<RoleRoute perm="stock_transfers.view"><StockTransferList /></RoleRoute>} />
          <Route path="stock-transfer/new"             element={<RoleRoute perm="stock_transfers.create"><StockTransferForm /></RoleRoute>} />
          <Route path="stock-transfer/edit/:id"        element={<RoleRoute perm="stock_transfers.view"><StockTransferForm /></RoleRoute>} />

          {/* Batches (Commit 5) — list + per-batch detail. Same
              .report-editorial shell as Stock Transfers list / Sales
              Report so cross-page navigation feels uniform. */}
          <Route path="inventory/batches"              element={<RoleRoute perm="batches.view"><BatchesList /></RoleRoute>} />
          <Route path="inventory/batches/:batch_id"    element={<RoleRoute perm="batches.view"><BatchDetail /></RoleRoute>} />
          <Route path="reports/expiry"                 element={<RoleRoute perm="batches.view"><ExpiryReport /></RoleRoute>} />

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
          {/* /reports/stock removed — Stock Report lives at /stock-report
              (inventory menu). Old links rewired in BalanceSheet + the
              reports-hub config. */}
          {/* Customer / Supplier Statement + COA Ledger replace the
              old single Party Ledger page. The legacy /reports/party-
              ledger route is preserved as a redirect so old bookmarks,
              deep links from Aging / Outstanding, and any external
              references (printed reports, emails) keep working. The
              <PartyLedgerRedirect> component below resolves the party
              type when ?id=<party_id> is present and bounces to the
              correct flavor. */}
          <Route path="reports/customer-statement" element={<RoleRoute perm="accounts.view"><CustomerStatement /></RoleRoute>} />
          <Route path="reports/supplier-statement" element={<RoleRoute perm="accounts.view"><SupplierStatement /></RoleRoute>} />
          <Route path="reports/ledger"             element={<RoleRoute perm="accounts.view"><Ledger /></RoleRoute>} />
          <Route path="reports/party-ledger"       element={<RoleRoute perm="accounts.view"><PartyLedgerRedirect /></RoleRoute>} />
          <Route path="reports/profit-loss"   element={<RoleRoute perm="accounts.view"><ProfitLoss /></RoleRoute>} />
          <Route path="reports/receivables-aging" element={<RoleRoute perm="reports.view"><ReceivablesAging /></RoleRoute>} />
          <Route path="reports/payables-aging"    element={<RoleRoute perm="reports.view"><PayablesAging /></RoleRoute>} />
          {/* Legacy /reports/aging — keep alive for old bookmarks; lands
              on Receivables (the more common workflow). */}
          <Route path="reports/aging"             element={<RoleRoute perm="reports.view"><ReceivablesAging /></RoleRoute>} />
          <Route path="reports/bills-receivable"    element={<RoleRoute perm="reports.view"><BillsReceivable /></RoleRoute>} />
          <Route path="reports/bills-payable"       element={<RoleRoute perm="reports.view"><BillsPayable /></RoleRoute>} />
          <Route path="reports/customer-outstanding" element={<RoleRoute perm="reports.view"><CustomerOutstanding /></RoleRoute>} />
          <Route path="reports/supplier-outstanding" element={<RoleRoute perm="reports.view"><SupplierOutstanding /></RoleRoute>} />
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
          <Route path="reports/fund-flow"         element={<RoleRoute perm="accounts.view"><FundFlow /></RoleRoute>} />
          <Route path="reports/day-book"          element={<RoleRoute perm="accounts.view"><DayBook /></RoleRoute>} />
          <Route path="reports/hsn-summary"        element={<RoleRoute perm="reports.view"><HsnSummary /></RoleRoute>} />
          {/* /reports/stock-summary removed — opening / inward / outward
              now live on the inventory Stock Report via the movement-
              period range picker. Drill-down from ProfitLoss rewired. */}
          <Route path="reports/fast-slow-stock"    element={<RoleRoute perm="reports.view"><FastSlowStock /></RoleRoute>} />
          {/* Redirect — keep the legacy /reports/movers slug alive
              forever so any user-saved bookmark, copy-pasted URL, or
              cached favourite resolves to the new path.  Replace=true
              so the redirect doesn't pollute history. */}
          <Route path="reports/movers"             element={<Navigate to="/reports/fast-slow-stock" replace />} />
          <Route path="reports/transfer-register"  element={<RoleRoute perm="reports.view"><GodownTransferRegister /></RoleRoute>} />
          <Route path="reports/godown-valuation"   element={<RoleRoute perm="reports.view"><GodownValuation /></RoleRoute>} />

          {/* Accounts (double-entry) */}
          <Route path="accounts/journal"          element={<RoleRoute perm="accounts.view"><JournalVoucherList /></RoleRoute>} />
          <Route path="accounts/journal/new"      element={<RoleRoute perm="accounts.view"><JournalVoucherForm /></RoleRoute>} />
          <Route path="accounts/journal/edit/:id" element={<RoleRoute perm="accounts.view"><JournalVoucherForm /></RoleRoute>} />
          <Route path="accounts/integrity"        element={<RoleRoute perm="accounts.view"><LedgerIntegrity /></RoleRoute>} />
          <Route path="banks"                      element={<RoleRoute perm="accounts.view"><BankList /></RoleRoute>} />
          {/* /banks/reconciliation must come before /banks/:ledger_id/statement —
              otherwise React Router would try to use 'reconciliation' as a ledger_id. */}
          <Route path="banks/reconciliation"       element={<RoleRoute perm="accounts.view"><BankReconciliation /></RoleRoute>} />
          <Route path="banks/:ledger_id/statement" element={<RoleRoute perm="accounts.view"><BankStatement /></RoleRoute>} />

          {/* Loans — same shape as banks. /loans/schedule is the cross-loan
              upcoming-EMI dashboard (mirror of bank reconciliation). */}
          <Route path="loans"                      element={<RoleRoute perm="accounts.view"><LoanList /></RoleRoute>} />
          <Route path="loans/schedule"             element={<RoleRoute perm="accounts.view"><LoanSchedule /></RoleRoute>} />
          <Route path="loans/:ledger_id/statement" element={<RoleRoute perm="accounts.view"><LoanStatement /></RoleRoute>} />

          {/* Settings hub — macOS-style layout with grouped left rail
              and the active page rendering in the right pane via
              <Outlet />. Bare /settings lands on Company so the hub
              is never empty. */}
          <Route path="settings" element={<SettingsLayout />}>
            <Route index                      element={<Navigate to="/settings/company" replace />} />
            <Route path="company"             element={<RoleRoute perm="settings.manage_company"><CompanyProfile /></RoleRoute>} />
            <Route path="users"               element={<RoleRoute perm="settings.manage_users"><UserManagement /></RoleRoute>} />
            <Route path="barcode"             element={<RoleRoute perm="settings.barcode"><BarcodeSettingsPage /></RoleRoute>} />
            <Route path="modules"             element={<RoleRoute perm="settings.manage_company"><ModuleSettings /></RoleRoute>} />
            <Route path="backup"              element={<RoleRoute perm="settings.backup"><BackupRestore /></RoleRoute>} />
            {/* Theme is per-user UX — anyone can pick light/dark. */}
            <Route path="theme"               element={<ThemeSettings />} />
            <Route path="import-export"       element={<RoleRoute perm="settings.import_export"><ImportExport /></RoleRoute>} />
            <Route path="import"              element={<RoleRoute perm="settings.import_export"><ImportV2 /></RoleRoute>} />
            <Route path="tally"               element={<RoleRoute perm="settings.tally"><TallySync /></RoleRoute>} />
            <Route path="print"               element={<RoleRoute perm="settings.print"><PrintSettings /></RoleRoute>} />
            <Route path="godowns"             element={<RoleRoute perm="godowns.view"><GodownList /></RoleRoute>} />
            {/* Home page customization — no perm gate; every operator can
                pick what shows on their own landing page. */}
            <Route path="home"                element={<HomeSettings />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}
