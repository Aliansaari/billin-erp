import React, { useState, useCallback, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useParams, useNavigate } from 'react-router-dom';
import useAuthStore from './store/authStore';
import useCompanyStore from './store/companyStore';
import confirmDialog from './utils/confirmDialog';
import { partyAPI } from './api';
import { refreshFinancialYear } from './hooks/useFinancialYear';
import { useMultiWarehouseEnabled } from './hooks/useSystemSettings';
import { useGlobalShortcuts, SHORTCUTS_LIST, SHORTCUTS_CATEGORIES } from './hooks/useKeyboardShortcuts';
import AppLayout from './components/Layout/AppLayout';
import OnboardingWizard, { shouldShowOnboarding } from './components/OnboardingWizard';
import RoleRoute from './components/RoleRoute';
import { GlobalSearchModal } from './components/GlobalSearch';
import MasterChooser from './components/MasterChooser';
import DeveloperGateMount from './components/DeveloperGateMount';
// DatePopup + MenuPopup providers are mounted in main.jsx (above this
// component) so that useGlobalShortcuts called from App's body can
// reach them via useContext.
import Login from './pages/Login';
import LicenseActivation from './pages/LicenseActivation';
import PostgresSetup from './pages/PostgresSetup';
import ChangePassword from './pages/ChangePassword';
import ServerSetup, { useNeedsServerSetup } from './pages/ServerSetup';
import Home from './pages/Home';
import Dashboard from './pages/Dashboard';
import DashboardClassic from './pages/DashboardClassic';
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
import ExpenseEntry  from './pages/expenses/ExpenseEntry';
import ExpenseList   from './pages/expenses/ExpenseList';
import ExpenseReport from './pages/expenses/ExpenseReport';
import SalesReport from './pages/reports/SalesReport';
import SalesmanReport from './pages/reports/SalesmanReport';
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
import StockByColor from './pages/reports/StockByColor';
import StockByColorDetail from './pages/reports/StockByColorDetail';
import ReportsHub from './pages/reports/ReportsHub';
import JournalVoucherList from './pages/accounts/JournalVoucherList';
import JournalVoucherForm from './pages/accounts/JournalVoucherForm';
import LedgerIntegrity from './pages/accounts/LedgerIntegrity';
import BankList            from './pages/banks/BankList';
import BankStatement       from './pages/banks/BankStatement';
import BankReconciliation  from './pages/banks/BankReconciliation';
import ChequeRegister      from './pages/banks/ChequeRegister';
import LoanList            from './pages/loans/LoanList';
import LoanStatement       from './pages/loans/LoanStatement';
import LoanSchedule        from './pages/loans/LoanSchedule';
import ImportV2 from './pages/settings/ImportV2';
import CompanyProfile from './pages/settings/CompanyProfile';
import FinancialYearSettings from './pages/settings/FinancialYearSettings';
import MyAccount from './pages/settings/MyAccount';
import NotificationsSettings from './pages/settings/NotificationsSettings';
import UserManagement from './pages/settings/UserManagement';
import GodownList from './pages/settings/GodownList';
import SalesmanList from './pages/settings/SalesmanList';
import LanSettings from './pages/settings/LanSettings';
import WhatsappSettings from './pages/settings/WhatsappSettings';
import WhatsappBotSettings from './pages/settings/WhatsappBotSettings';
import BarcodeSettingsPage from './pages/settings/BarcodeSettings';
import ModuleSettings from './pages/settings/ModuleSettings';
import BackupRestore from './pages/settings/BackupRestore';
import ThemeSettings from './pages/settings/ThemeSettings';
import ImportExport from './pages/settings/ImportExport';
import TallySync from './pages/settings/TallySync';
import PrintSettings from './pages/settings/PrintSettings';
import HomeSettings from './pages/settings/HomeSettings';
import DashboardSettings from './pages/settings/DashboardSettings';
import DefaultsSettings from './pages/settings/DefaultsSettings';
import CustomerInsightSettings from './pages/settings/CustomerInsightSettings';
import SettingsLayout from './pages/settings/SettingsLayout';
import EntityFormModalDemo from './pages/dev/EntityFormModalDemo';
import DeveloperSettings from './pages/settings/DeveloperSettings';
import LicenseSettings from './pages/settings/LicenseSettings';
import CompanyList from './pages/settings/CompanyList';
import {
  useShowLedgerIntegrity, useShowImportExport, useShowTallySync,
  useShowServerSettings, useDeveloperMode,
} from './hooks/useSystemSettings';

/**
 * Gate a route on the global Multi-warehouse toggle. When the flag is
 * OFF every godown surface (Stock Transfers, Settings → Godowns, the
 * two godown reports) should be inaccessible — even by direct URL or
 * stale bookmark. Renders nothing while the system-settings cache is
 * still loading to avoid a flicker-redirect on cold load.
 */
function MultiWarehouseRoute({ children }) {
  const enabled = useMultiWarehouseEnabled();
  if (enabled === null) return null;
  if (!enabled) return <Navigate to="/" replace />;
  return children;
}

/**
 * Gate a route on a developer-tier feature flag. Identical pattern to
 * MultiWarehouseRoute — bouncer redirects to / when the flag is off
 * AND developer mode isn't unlocked. Use the `flag` prop with one of
 * the dev_show_* selector hooks. Stops a stale bookmark or copy-pasted
 * URL from reaching a hidden destructive page.
 */
function DevGatedRoute({ flag, children }) {
  // Evaluate every selector unconditionally (rules of hooks). The `flag`
  // string picks which one applies. Adding a new gate is a 2-line
  // change here + a hook in useSystemSettings.
  const ledger    = useShowLedgerIntegrity();
  const importExp = useShowImportExport();
  const tally     = useShowTallySync();
  const server    = useShowServerSettings();
  const visible = {
    ledger_integrity: ledger,
    import_export:    importExp,
    tally_sync:       tally,
    server_settings:  server,
  }[flag];
  if (!visible) return <Navigate to="/" replace />;
  return children;
}

/**
 * Gate a route on developer-mode unlock specifically (not a flag).
 * Used for the Developer Settings page itself — it's reachable only
 * by users who've entered the developer password.
 */
function DevModeOnlyRoute({ children }) {
  const isDev = useDeveloperMode();
  if (!isDev) return <Navigate to="/" replace />;
  return children;
}

// UI-C2 — 404 page. Plain inline component so we don't have to add a new
// file for what's a 30-line panel. Renders inside AppLayout when matched
// inside the authenticated tree; renders standalone for top-level matches.
function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '60vh', padding: 32, textAlign: 'center',
    }}>
      <h1 style={{ fontSize: 64, margin: 0, lineHeight: 1 }}>404</h1>
      <p style={{ fontSize: 18, margin: '16px 0 24px', color: 'var(--erp-fg-2, #aaa)' }}>
        The page you're looking for doesn't exist.
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button
          onClick={() => navigate(-1)}
          style={{ padding: '8px 20px', cursor: 'pointer' }}
        >
          ← Go back
        </button>
        <button
          onClick={() => navigate('/')}
          style={{ padding: '8px 20px', cursor: 'pointer' }}
        >
          Home
        </button>
      </div>
    </div>
  );
}

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

/* OnboardingGate — sits above AppLayout once the user is past the
 * password-rotation gate. Checks whether the firm has set up Company
 * Profile yet; if not, surfaces the wizard as an overlay that the
 * underlying app stays interactive beneath (the wizard captures focus
 * via its modal overlay). Once dismissed or finished, the overlay
 * disappears and the user is on whatever route they navigated to.
 *
 * Re-runs the detection on EVERY company switch (companyStore.currentId
 * changes), so creating a brand-new company and switching to it
 * surfaces the wizard for that company even if a prior company was
 * already dismissed. */
function OnboardingGate({ children }) {
  const [show, setShow] = React.useState(false);
  const [checked, setChecked] = React.useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const mustChangePassword = useAuthStore((s) => s.mustChangePassword);
  // Subscribing to currentId triggers a re-run of the effect below when
  // the operator switches companies via the topbar pill.
  const currentCompanyId = useCompanyStore((s) => s.currentId);

  React.useEffect(() => {
    // Only probe once per mount, and only when the user is fully signed in
    // (past both auth and the must_change_password gate). Without these
    // guards the wizard would flash briefly on the login page on a fresh
    // boot before redirecting elsewhere.
    if (!isAuthenticated || mustChangePassword) return;
    let cancelled = false;
    setChecked(false);
    shouldShowOnboarding(currentCompanyId).then((v) => {
      if (!cancelled) { setShow(v); setChecked(true); }
    });
    return () => { cancelled = true; };
  }, [isAuthenticated, mustChangePassword, currentCompanyId]);

  return (
    <>
      {children}
      {checked && show && <OnboardingWizard onComplete={() => setShow(false)} />}
    </>
  );
}

/* ShortcutsOverlay — the keyboard cheat-sheet, rendered at the root.
 *
 * Reads SHORTCUTS_LIST + SHORTCUTS_CATEGORIES from useKeyboardShortcuts.
 * Groups rows by category in the order SHORTCUTS_CATEGORIES declares;
 * any row whose category isn't in that list falls into an "Other" bucket
 * at the end (defensive — never drops rows).
 *
 * A filter input at the top lets the operator narrow the list. Matches
 * are case-insensitive against EITHER the description or the keys, so
 * typing "F1" or "save" both jump straight to the right rows.
 * ESC closes; backdrop click closes. */
function ShortcutsOverlay({ visible, onClose }) {
  const [query, setQuery] = useState('');
  const inputRef = React.useRef(null);

  // Focus the filter input the moment the overlay opens, so the user can
  // start typing immediately. Reset query on close so reopening starts
  // clean.
  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 30);
    } else {
      setQuery('');
    }
  }, [visible]);

  // Filtered + grouped rows — recomputed only when the query changes.
  // Matches against description AND keys so "F1" finds bill-form Save AND
  // list-page Open, while "save" finds Ctrl+Enter + F1 together.
  const grouped = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? SHORTCUTS_LIST.filter((s) =>
          s.description.toLowerCase().includes(q) ||
          s.keys.toLowerCase().includes(q) ||
          (s.category || '').toLowerCase().includes(q))
      : SHORTCUTS_LIST;
    const buckets = {};
    for (const s of filtered) {
      const cat = s.category || 'Other';
      (buckets[cat] ||= []).push(s);
    }
    // Ordered emit: declared categories first, then any leftovers
    // alphabetically (defensive — see the constant's comment).
    const ordered = [];
    for (const c of SHORTCUTS_CATEGORIES) {
      if (buckets[c]) { ordered.push([c, buckets[c]]); delete buckets[c]; }
    }
    for (const c of Object.keys(buckets).sort()) ordered.push([c, buckets[c]]);
    return ordered;
  }, [query]);

  if (!visible) return null;

  // Splits "Cmd/Ctrl + Shift + N" into renderable parts. Keeps "/c" /
  // "↑ / ↓" / "↵" intact (no "+" inside). Handles "Cmd/Ctrl" alternates
  // by emitting them as a single chip so the row reads naturally.
  const renderKeys = (keys) => {
    const parts = keys.split('+').map((p) => p.trim());
    return parts.map((part, j) => (
      <React.Fragment key={j}>
        {j > 0 && <span className="erp-cheat-plus">+</span>}
        <kbd className="erp-cheat-kbd">{part}</kbd>
      </React.Fragment>
    ));
  };

  return (
    <div className="erp-shortcuts-overlay" onClick={onClose}>
      <div className="erp-cheat-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <header className="erp-cheat-head">
          <div>
            <div className="erp-cheat-eyebrow">Keyboard cheat sheet</div>
            <h2 className="erp-cheat-title">Every shortcut, one place.</h2>
          </div>
          <button type="button" className="erp-cheat-close" onClick={onClose} aria-label="Close">esc</button>
        </header>

        <div className="erp-cheat-search-wrap">
          <input
            ref={inputRef}
            type="text"
            className="erp-cheat-search"
            placeholder={`Filter ${SHORTCUTS_LIST.length} shortcuts — try "save", "F1", or "alt"…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button type="button" className="erp-cheat-search-clear" onClick={() => setQuery('')} aria-label="Clear">✕</button>
          )}
        </div>

        <div className="erp-cheat-body">
          {grouped.length === 0 ? (
            <div className="erp-cheat-empty">
              No shortcuts match <strong>"{query}"</strong>.<br />
              Try a different word, or clear the filter.
            </div>
          ) : (
            grouped.map(([category, rows]) => (
              <section key={category} className="erp-cheat-section">
                <div className="erp-cheat-section-head">
                  <span className="erp-cheat-section-name">{category}</span>
                  <span className="erp-cheat-section-count">{rows.length}</span>
                </div>
                <ul className="erp-cheat-list">
                  {rows.map((s, i) => (
                    <li key={`${category}-${i}`} className="erp-cheat-row">
                      <div className="erp-cheat-row-desc">
                        <span>{s.description}</span>
                        {s.note && <span className="erp-cheat-row-note">{s.note}</span>}
                      </div>
                      <span className="erp-cheat-row-keys">{renderKeys(s.keys)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        <footer className="erp-cheat-foot">
          <span>{SHORTCUTS_LIST.length} shortcuts</span>
          <span className="erp-cheat-foot-tip">
            Press <kbd className="erp-cheat-kbd">Cmd</kbd>
            <span className="erp-cheat-plus">+</span>
            <kbd className="erp-cheat-kbd">Shift</kbd>
            <span className="erp-cheat-plus">+</span>
            <kbd className="erp-cheat-kbd">?</kbd> anywhere to open this
          </span>
        </footer>
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

  // Listen for an in-app event so callers outside App.jsx (e.g. avatar
  // dropdown items) can open the cheat-sheet without prop-drilling the
  // setter. Mirrors the pattern GlobalSearchModal and MasterChooser use
  // (`global-search:open`, `master-chooser:open`).
  useEffect(() => {
    const onOpen  = () => setShowShortcuts(true);
    const onClose = () => setShowShortcuts(false);
    window.addEventListener('shortcuts:open',  onOpen);
    window.addEventListener('shortcuts:close', onClose);
    return () => {
      window.removeEventListener('shortcuts:open',  onOpen);
      window.removeEventListener('shortcuts:close', onClose);
    };
  }, []);

  // Electron: confirm + sign out before the window actually closes.
  // main.js intercepts the X / Alt+F4 and pings `app:confirm-exit`; we
  // show the app-themed dialog, and only on confirm do we clear the
  // session and tell main to close. De-duped so mashing the X doesn't
  // stack modals.
  const exitPromptOpen = React.useRef(false);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onConfirmExit) return;
    const off = api.onConfirmExit(async () => {
      if (exitPromptOpen.current) return;
      exitPromptOpen.current = true;
      const ok = await confirmDialog({
        title: 'Exit ZEHEN?',
        message: 'You will be signed out and the app will close.',
        confirmText: 'Exit & sign out',
        cancelText:  'Stay',
        danger: true,
      });
      exitPromptOpen.current = false;
      if (ok) {
        try { useAuthStore.getState().logout(); } catch {}
        api.confirmExit();
      }
    });
    return off;
  }, []);
  // First-launch gate: when running under file:// (Electron prod) and the
  // user hasn't picked a server URL yet, force the Server Setup screen
  // ahead of every other route. Browser clients on http(s):// implicitly
  // know the server URL (it's the same origin) so this returns false and
  // they go straight to login.
  const needsServerSetup = useNeedsServerSetup();

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

  // Pre-flight chain — order matters:
  //   1. Server URL (handled by useNeedsServerSetup above)
  //   2. Postgres setup (`/api/setup/status`) — if not complete, /setup
  //   3. License (`/api/license/info`)         — if not activated, /license
  //
  // Both endpoints are exempt from the LAN + license gates so they're
  // reachable on a brand-new install without any prior state.
  //
  // Redirect-loop guard: stash a flag in sessionStorage when a redirect
  // happens. If we're invoked again within the same tab session AND
  // we'd redirect to a URL we've already redirected to, skip — the
  // user is presumably on that page now and should be able to complete
  // it without us bouncing them. The flag clears when the user
  // navigates anywhere else. This was a real problem during the
  // post-activation transition where reloading ended up flickering
  // between /license and / repeatedly.
  useEffect(() => {
    if (needsServerSetup) return;
    const here = window.location.pathname;
    if (here.startsWith('/license') || here === '/server-setup' || here === '/setup') {
      try { sessionStorage.setItem('boot_probe_at', here); } catch {}
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { default: api } = await import('./api');
        const lastTarget = (() => { try { return sessionStorage.getItem('boot_probe_redirect'); } catch { return null; } })();

        // Setup first — without a master DB, license info would also
        // 503 on the DB connection that sequelize hasn't established.
        const sr = await api.get('/setup/status');
        if (cancelled) return;
        if (!sr.data?.setup_complete) {
          if (lastTarget === '/setup') return;     // already bounced here once; don't loop
          try { sessionStorage.setItem('boot_probe_redirect', '/setup'); } catch {}
          window.location.href = '/setup';
          return;
        }
        const r = await api.get('/license/info');
        if (cancelled) return;
        if (!r.data?.activated) {
          if (lastTarget === '/license') return;
          try { sessionStorage.setItem('license_block_status', JSON.stringify(r.data?.status || { code: 'no_license' })); } catch {}
          try { sessionStorage.setItem('boot_probe_redirect', '/license'); } catch {}
          window.location.href = '/license';
          return;
        }
        // All gates passed — clear the redirect-loop flag so a future
        // reload (e.g. user logs out and back in) gets a fresh probe.
        try { sessionStorage.removeItem('boot_probe_redirect'); } catch {}
      } catch {
        // network errors handled elsewhere; don't block boot on a
        // probe that may not be reachable yet.
      }
    })();
    return () => { cancelled = true; };
  }, [needsServerSetup]);

  // Pre-auth, pre-everything: if Electron has no server URL configured
  // yet, the user picks one before they can even see the login screen.
  if (needsServerSetup) {
    return <ServerSetup />;
  }

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
      {/* Master chooser — Cmd/Ctrl+Shift+N opens a 5-item picker
          (Customer · Supplier · Product · Category · Bank) that
          navigates to the right list with ?new=1 to open its form
          modal. Same auth gate as the search palette. */}
      {isAuthenticated && <MasterChooser />}
      {/* Developer-access password modal + the `dev-gate:open` listener
          (fired by GlobalSearch's hidden "/__dev" string). Global so it
          works in BOTH the sidebar and top-nav layouts — it previously
          lived in Sidebar.jsx and was dead in horizontal mode. */}
      {isAuthenticated && <DeveloperGateMount />}
      <Routes>
        {/* Manual access to Server Setup is dev-gated — once the office
            is configured, regular staff shouldn't be able to re-point
            the app at a different host. Cold-boot (no saved URL on
            file://) still triggers ServerSetup directly via the
            useNeedsServerSetup gate above this Routes block. */}
        <Route path="/server-setup" element={<DevGatedRoute flag="server_settings"><ServerSetup allowSkip /></DevGatedRoute>} />
        {/* /setup — first-run Postgres wizard. Reachable without auth
            and exempt from the license gate so a brand-new install can
            provision its master DB before anything else. */}
        <Route path="/setup" element={<PostgresSetup />} />
        {/* /license — activation / expired / mismatch screen. Reachable
            without auth (the gate fires before login) so a brand-new
            install or an expired customer can self-serve activation
            without us being remote-connected. */}
        <Route path="/license" element={<LicenseActivation />} />
        <Route path="/login" element={<Login />} />
        <Route path="/change-password" element={<PrivateRoute><ChangePassword /></PrivateRoute>} />
        <Route path="/" element={<PrivateRoute><OnboardingGate><AppLayout /></OnboardingGate></PrivateRoute>}>
          {/*
            / is the Command Center (Home) — greeting, global search, quick
            actions, KPI strip. The deep 9-up Dashboard moved to /dashboard
            so the home page stays a single-screen launchpad. Both routes
            are always reachable; either is a safe fallback when an
            operator's intended starting route is gated off.
          */}
          <Route index element={<Home />} />
          <Route path="dashboard"          element={<Dashboard />} />
          <Route path="dashboard/classic"  element={<DashboardClassic />} />

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
          <Route path="stock-transfers"                element={<MultiWarehouseRoute><RoleRoute perm="stock_transfers.view"><StockTransferList /></RoleRoute></MultiWarehouseRoute>} />
          <Route path="stock-transfer/new"             element={<MultiWarehouseRoute><RoleRoute perm="stock_transfers.create"><StockTransferForm /></RoleRoute></MultiWarehouseRoute>} />
          <Route path="stock-transfer/edit/:id"        element={<MultiWarehouseRoute><RoleRoute perm="stock_transfers.view"><StockTransferForm /></RoleRoute></MultiWarehouseRoute>} />

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
          {/* Edit-existing routes — same component, different mode. Component
              reads :id from useParams and switches to update() instead of create(). */}
          <Route path="payment/edit/:id" element={<RoleRoute perm="payments.create"><PaymentEntry /></RoleRoute>} />
          <Route path="receipt/edit/:id" element={<RoleRoute perm="payments.create"><ReceiptEntry /></RoleRoute>} />
          <Route path="payments"    element={<RoleRoute perm="payments.view"><PaymentList /></RoleRoute>} />

          {/* Expenses — Indirect / Direct expense bookings with full
              double-entry. List + entry + report all hang off the
              Expenses dropdown in the sidebar. */}
          <Route path="expenses"            element={<RoleRoute perm="expenses.view"><ExpenseList /></RoleRoute>} />
          <Route path="expenses/new"        element={<RoleRoute perm="expenses.create"><ExpenseEntry /></RoleRoute>} />
          <Route path="expenses/edit/:id"   element={<RoleRoute perm="expenses.view"><ExpenseEntry /></RoleRoute>} />
          <Route path="expenses/report"     element={<RoleRoute perm="expenses.view"><ExpenseReport /></RoleRoute>} />

          {/* Reports */}
          {/* Reports hub — landing for all reports. Cluttered flat dropdown
              has been replaced by this page + a favorites-only nav menu. */}
          <Route path="reports"               element={<ReportsHub />} />
          <Route path="reports/sales"         element={<RoleRoute perm="reports.view"><SalesReport /></RoleRoute>} />
          <Route path="reports/sales-by-salesman" element={<RoleRoute perm="reports.view"><SalesmanReport /></RoleRoute>} />
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
          <Route path="reports/stock-by-color"             element={<RoleRoute perm="reports.view"><StockByColor /></RoleRoute>} />
          {/* Dev-only preview route for the new EntityFormModal shell.
           *  Not linked from any menu. Visit /dev/efm directly to test. */}
          <Route path="dev/efm"                            element={<EntityFormModalDemo />} />
          <Route path="reports/stock-by-color/:productId"  element={<RoleRoute perm="reports.view"><StockByColorDetail /></RoleRoute>} />
          {/* Redirect — keep the legacy /reports/movers slug alive
              forever so any user-saved bookmark, copy-pasted URL, or
              cached favourite resolves to the new path.  Replace=true
              so the redirect doesn't pollute history. */}
          <Route path="reports/movers"             element={<Navigate to="/reports/fast-slow-stock" replace />} />
          <Route path="reports/transfer-register"  element={<MultiWarehouseRoute><RoleRoute perm="reports.view"><GodownTransferRegister /></RoleRoute></MultiWarehouseRoute>} />
          <Route path="reports/godown-valuation"   element={<MultiWarehouseRoute><RoleRoute perm="reports.view"><GodownValuation /></RoleRoute></MultiWarehouseRoute>} />

          {/* Accounts (double-entry) */}
          <Route path="accounts/journal"          element={<RoleRoute perm="accounts.view"><JournalVoucherList /></RoleRoute>} />
          <Route path="accounts/journal/new"      element={<RoleRoute perm="accounts.view"><JournalVoucherForm /></RoleRoute>} />
          <Route path="accounts/journal/edit/:id" element={<RoleRoute perm="accounts.view"><JournalVoucherForm /></RoleRoute>} />
          <Route path="accounts/integrity"        element={<DevGatedRoute flag="ledger_integrity"><RoleRoute perm="accounts.view"><LedgerIntegrity /></RoleRoute></DevGatedRoute>} />
          <Route path="banks"                      element={<RoleRoute perm="accounts.view"><BankList /></RoleRoute>} />
          {/* /banks/reconciliation and /banks/cheques must both come
              before /banks/:ledger_id/statement — otherwise React Router
              would try to use 'reconciliation' / 'cheques' as a
              ledger_id. */}
          <Route path="banks/reconciliation"       element={<RoleRoute perm="accounts.view"><BankReconciliation /></RoleRoute>} />
          <Route path="banks/cheques"              element={<RoleRoute perm="cheques.view"><ChequeRegister /></RoleRoute>} />
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
            <Route path="financial-year"      element={<RoleRoute perm="settings.manage_company"><FinancialYearSettings /></RoleRoute>} />
            {/* My Account — every logged-in user can reach this; no permission gate. */}
            <Route path="account"             element={<PrivateRoute><MyAccount /></PrivateRoute>} />
            {/* Notifications preferences — per-user, no permission gate. */}
            <Route path="notifications"       element={<PrivateRoute><NotificationsSettings /></PrivateRoute>} />
            <Route path="users"               element={<RoleRoute perm="settings.manage_users"><UserManagement /></RoleRoute>} />
            <Route path="barcode"             element={<RoleRoute perm="settings.barcode"><BarcodeSettingsPage /></RoleRoute>} />
            <Route path="modules"             element={<RoleRoute perm="settings.manage_company"><ModuleSettings /></RoleRoute>} />
            <Route path="defaults"            element={<RoleRoute perm="settings.manage_company"><DefaultsSettings /></RoleRoute>} />
            <Route path="customer-insight"    element={<RoleRoute perm="settings.manage_company"><CustomerInsightSettings /></RoleRoute>} />
            <Route path="salesmen"            element={<RoleRoute perm="settings.manage_company"><SalesmanList /></RoleRoute>} />
            <Route path="network"             element={<RoleRoute perm="settings.manage_company"><LanSettings /></RoleRoute>} />
            <Route path="whatsapp"            element={<RoleRoute perm="settings.manage_company"><WhatsappSettings /></RoleRoute>} />
            <Route path="whatsapp-bot"        element={<RoleRoute perm="settings.manage_company"><WhatsappBotSettings /></RoleRoute>} />
            <Route path="backup"              element={<RoleRoute perm="settings.backup"><BackupRestore /></RoleRoute>} />
            {/* Theme is per-user UX — anyone can pick light/dark. */}
            <Route path="theme"               element={<ThemeSettings />} />
            <Route path="import-export"       element={<DevGatedRoute flag="import_export"><RoleRoute perm="settings.import_export"><ImportExport /></RoleRoute></DevGatedRoute>} />
            <Route path="import"              element={<DevGatedRoute flag="import_export"><RoleRoute perm="settings.import_export"><ImportV2 /></RoleRoute></DevGatedRoute>} />
            <Route path="tally"               element={<DevGatedRoute flag="tally_sync"><RoleRoute perm="settings.tally"><TallySync /></RoleRoute></DevGatedRoute>} />
            <Route path="print"               element={<RoleRoute perm="settings.print"><PrintSettings /></RoleRoute>} />
            <Route path="godowns"             element={<MultiWarehouseRoute><RoleRoute perm="godowns.view"><GodownList /></RoleRoute></MultiWarehouseRoute>} />
            {/* Home page customization — no perm gate; every operator can
                pick what shows on their own landing page. */}
            <Route path="home"                element={<HomeSettings />} />
            {/* Dashboard customization — same per-user UX gate (none); the
                /dashboard route renders whatever tiles the operator has
                pinned in their localStorage settings. */}
            <Route path="dashboard"           element={<DashboardSettings />} />
            {/* Developer Settings — only reachable when developer mode is
                unlocked on this device. The page itself shows the toggle
                grid and the LAN-deployment knobs. */}
            <Route path="developer"           element={<DevModeOnlyRoute><DeveloperSettings /></DevModeOnlyRoute>} />
            {/* License panel — anyone can view their own license status
                (so they know when it's about to expire); the Replace
                flow inside the page is dev-gated separately. */}
            <Route path="license"             element={<LicenseSettings />} />
            {/* Manage Companies — list / create / archive. Visible to
                every authenticated user (the sidebar entry is). The
                CREATE button is implicitly gated by the dev_max_companies
                cap on the server. */}
            <Route path="companies"           element={<CompanyList />} />
            {/* UI-C2 — catch-all 404 inside the authenticated/onboarded
                shell. Without this a typo in any sidebar link or stale
                bookmark renders a blank <Outlet/> with no feedback. */}
            <Route path="*"                   element={<NotFoundPage />} />
          </Route>
        </Route>
        {/* Top-level catch-all — covers any path not matched above
            (login, license, setup pages also fall through here when
            already authenticated and onboarded). */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}
