import React, { useState, useEffect } from 'react';
import { Layout } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import useThemeStore from '../../store/themeStore';
import Sidebar from './Sidebar';
import TopNav from './TopNav';

const { Content } = Layout;

const SIDEBAR_KEY = 'sidebar_collapsed';
// Height of the horizontal top-nav bar (keep in sync with .erp-topnav height
// in top-nav.css). Used to clamp the Content column so full-page routes get
// exactly viewport-minus-nav and the bottom action bars land flush.
const TOP_NAV_H = 56;

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    return stored === 'true';
  });
  const location = useLocation();
  const navigate = useNavigate();
  const menuOrientation = useThemeStore((s) => s.menuOrientation);
  const isHorizontal = menuOrientation === 'horizontal';

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

  // Global ESC-back when on a report page that was opened from the
  // /reports hub. The hub sets sessionStorage 'reports_hub_back' = '1'
  // when it navigates the operator into a report; ESC then triggers
  // history.back() which lands on /reports?q=<previous-search>, with
  // the URL query intact + the hub's mount effect refocusing the
  // search input.
  //
  // Guard: only fires for /reports/<slug>, never on the hub itself
  // (the hub's own onKeyDown owns ESC there to clear search).
  // Guard: only when the flag is set, so ESC on a directly-opened
  // report URL (bookmark, deep link from sidebar) does nothing.
  // Guard: ignore ESC when the user is typing in an input/textarea,
  // since most report pages use ESC to dismiss modals/search inputs
  // of their own — we shouldn't override that.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;

      // Don't fight TEXT-entry inputs (text/search/email/etc) and
      // textareas — they own Esc for their own cancel/dismiss/clear
      // behavior. But non-text inputs (radio/checkbox/range) and
      // buttons should NOT block Esc-back: AntD's Segmented control,
      // for example, holds focus on a hidden <input type="radio"> after
      // a click, which previously absorbed the Esc on pages like
      // Settings → Theme.
      const ae  = document.activeElement;
      const tag = (ae?.tagName || '').toLowerCase();
      if (ae?.isContentEditable) return;
      if (tag === 'textarea') return;
      if (tag === 'input') {
        const type = (ae.type || 'text').toLowerCase();
        const TEXT_TYPES = new Set([
          'text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'datetime-local', 'time', 'month', 'week',
        ]);
        if (TEXT_TYPES.has(type)) return;
      }

      // Search-back: if the operator reached this page via the global
      // search palette (hero or ⌘K modal), Esc returns them to where
      // they searched from. The palette stashed the source route in
      // `search_back_from` before navigating; we consume it here so a
      // second Esc does nothing instead of looping.
      const here = location.pathname + location.search;
      const searchBack = sessionStorage.getItem('search_back_from');
      if (searchBack && searchBack !== here) {
        e.preventDefault();
        sessionStorage.removeItem('search_back_from');
        navigate(searchBack);
        return;
      }

      // Reports-hub back — existing behavior. The hub sets
      // sessionStorage 'reports_hub_back' = '1' when navigating into a
      // report; Esc on that report bounces back to the hub.
      const path = location.pathname;
      if (!path.startsWith('/reports/') || path === '/reports/') return;
      if (sessionStorage.getItem('reports_hub_back') !== '1') return;
      e.preventDefault();
      window.history.back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [location.pathname, location.search, navigate]);

  // Full-page views: bill forms, lists, reports. The regex below matches
  // new/edit routes that need the full viewport (height: 100vh, overflow:
  // hidden). ORDER MATTERS: sales-return must come before sale and
  // purchase-return before purchase — otherwise `/sales-return/new` would
  // partial-match `sale` and then fail the trailing \/, falling through to
  // the padded layout. That made the return forms visibly shrink to content
  // height instead of filling the screen.
  const isFullPage = /^\/(sales-return|purchase-return|sale|purchase|payment|receipt|expenses|stock-movement|stock-report-pro|stock-transfer|banks|loans|inventory\/batches|settings)(\/|$)/.test(location.pathname) || [
    // Home (Command Center) — pinned viewport shell. The KPI ribbon, hero,
    // and action ribbon need to land flush against the viewport edges and
    // never scroll, so it joins the full-page list rather than rendering
    // inside the padded card frame.
    '/',
    // Home settings — sticky title + restore-defaults button stay fixed
    // at the top of the Content while the toggle sections scroll below.
    // Without /settings/home in the full-page list, the whole app-level
    // Content scroller engages instead of the page's own.
    '/settings/home',
    '/products', '/stock-report', '/stock-report-pro', '/stock-movement', '/categories', '/customers', '/suppliers',
    '/sales', '/purchases', '/payments',
    '/sales-returns', '/purchase-returns',
    '/reports/sales', '/reports/purchases',
    '/reports/party-ledger',                   // legacy redirect — keep listed so flash-of-padded-frame doesn't show during the bounce
    '/reports/customer-statement',
    '/reports/supplier-statement',
    '/reports/ledger',
    '/reports/profit-loss',
    '/reports/aging', '/reports/receivables-aging', '/reports/payables-aging',
    '/reports/gstr1', '/reports/day-book',
    '/reports/bills-receivable', '/reports/bills-payable',
    '/reports/customer-outstanding', '/reports/supplier-outstanding',
    '/reports/monthly-sales', '/reports/monthly-purchases',
    '/reports/monthly-payments', '/reports/monthly-receipts',
    '/reports/product-sales', '/reports/product-purchases',
    '/reports/transfer-register',
    '/reports/godown-valuation',
    // Fast & Slow Stock — full-bleed table with sticky header /
    // tabs / footer; same layout discipline as the other reports.
    // The legacy /reports/movers slug also resolves (via a Navigate
    // in App.jsx) but only the canonical path needs to be in
    // isFullPage — the redirect renders before this check runs.
    '/reports/fast-slow-stock',
    // Editorial financial reports — full-page shells with sticky
    // total bar + F-bar pinned to viewport bottom. Without these
    // listed, the wrapper paints them as a padded card and the
    // sticky bottom drifts up into the middle of the page.
    '/reports/balance-sheet', '/reports/trial-balance', '/reports/cash-flow',
    '/reports/fund-flow',
    // Ledger Integrity — sticky page header (title + Refresh +
    // Run Reconciliation badge) with collapsible cards scrolling
    // beneath it.
    '/accounts/integrity',
    // Banks — list view, statement view, and cross-bank reconciliation,
    // all full-bleed flex shells with sticky header / table / footer.
    // Bare /banks lands the list; /banks/reconciliation and
    // /banks/:id/statement are caught by the regex above.
    '/banks',
    // Loans — same shape as banks: list, per-loan statement+schedule,
    // and cross-loan upcoming EMIs page. The regex above catches the
    // child routes; this entry covers the bare /loans landing.
    '/loans',
    // Stock Transfers — list view uses the shared .blist-page shell
    // (sticky title + KPIs + internally scrolling table + sticky
    // footer). Form routes /stock-transfer/new and /stock-transfer/edit
    // are caught by the regex above.
    '/stock-transfers',
    // Batches (Commit 5) — list + detail use the same .report-editorial
    // shell with sticky header + KPIs + scrolling body + sticky footer.
    // The /:batch_id detail route is caught by the regex below.
    '/inventory/batches',
    // Expiry Report — same editorial-report shell as Sales Report.
    '/reports/expiry',
    // Reports Hub — sticky title strip; search + pinned strip +
    // category grid scroll beneath. Without /reports here, the
    // page reverts to padded auto-scroll where the title slides
    // off-screen on long category lists.
    '/reports',
    // (/settings and any child route are matched by the regex above
    // so the SettingsLayout's two-pane shell fills the viewport.)
  ].includes(location.pathname);

  // In horizontal mode the top-nav eats TOP_NAV_H px; fullpage needs the rest.
  const fullPageH = isHorizontal ? `calc(100vh - ${TOP_NAV_H}px)` : '100vh';

  // Page wrapper key. Keyed on the top-level route segment — NOT the full
  // pathname — so in-page navigation (e.g. /stock-movement → /stock-movement/42
  // or /sale/edit/1 → /sale/edit/2) does NOT unmount and remount the page,
  // which previously re-ran every useEffect (most visibly, the product list
  // fetch in StockMovement) and showed as a whole-page "blink" on every
  // product click. Cross-section navigation (/products → /sales) still
  // changes the key, giving route transitions a clean state reset.
  const pageKey = '/' + (location.pathname.split('/')[1] || '');

  // Horizontal mode: stack TopNav + Content vertically.
  if (isHorizontal) {
    return (
      <Layout className="app-layout-horizontal" style={{ minHeight: '100vh', flexDirection: 'column' }}>
        <TopNav />
        <Layout style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Content style={{
            margin:        isFullPage ? 0 : 'clamp(8px, 2vw, 20px)',
            padding:       isFullPage ? 0 : 'clamp(12px, 2vw, 24px)',
            background:    'transparent',
            overflow:      isFullPage ? 'hidden' : 'auto',
            flex:          1,
            minWidth:      0,
            // maxHeight pins Content to the viewport so flex children (like
            // bill lists / party ledger) can't push the body to overflow.
            height:        isFullPage ? fullPageH : undefined,
            maxHeight:     isFullPage ? fullPageH : undefined,
            minHeight:     isFullPage ? 0 : `calc(100vh - ${TOP_NAV_H + 40}px)`,
          }}>
            <div
              key={pageKey}
              className="erp-page-content"
              data-fullpage={isFullPage ? '' : undefined}
              // Use the same explicit pixel-resolvable height as Content rather
              // than `height: 100%`. AntD's `<main>` sits in a flex column with
              // flex-basis 0%, and descendants using percentage heights inside
              // that chain (`.erp-page-content` → `.sbf-page` → …) fall back to
              // intrinsic content height instead of the computed box. That made
              // bill forms paint shorter than the viewport in horizontal mode
              // ("shrinking" artifact). An explicit height breaks the chain.
              style={isFullPage ? { height: fullPageH, overflow: 'hidden' } : undefined}
            >
              <Outlet />
            </div>
          </Content>
        </Layout>
      </Layout>
    );
  }

  // Default: vertical sidebar layout.
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sidebar collapsed={collapsed} setCollapsed={setCollapsed} />
      <Layout style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Content style={{
          margin:        isFullPage ? 0 : 'clamp(8px, 2vw, 20px)',
          padding:       isFullPage ? 0 : 'clamp(12px, 2vw, 24px)',
          background:    'transparent',
          overflow:      isFullPage ? 'hidden' : 'auto',
          flex:          1,
          minWidth:      0,
          // maxHeight pins Content to the viewport so flex children (like
          // bill lists / party ledger) can't push the body to overflow.
          height:        isFullPage ? '100vh' : undefined,
          maxHeight:     isFullPage ? '100vh' : undefined,
          minHeight:     isFullPage ? 0 : 'calc(100vh - 40px)',
        }}>
          <div
            key={location.pathname}
            className="erp-page-content"
            data-fullpage={isFullPage ? '' : undefined}
            // Explicit height (not 100%) — see the horizontal branch for why:
            // percentage heights collapse inside AntD's flex-basis-0 main column.
            style={isFullPage ? { height: '100vh', overflow: 'hidden' } : undefined}
          >
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
