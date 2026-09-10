import React, { useState, useEffect } from 'react';
import { Layout } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import useThemeStore from '../../store/themeStore';
import Sidebar from './Sidebar';
import TopNav from './TopNav';
import PastFYBanner from '../PastFYBanner';
import RemoteShopBanner from '../RemoteShopBanner';

const { Content } = Layout;

const SIDEBAR_KEY = 'sidebar_collapsed';
// Height of the horizontal top-nav bar (keep in sync with .erp-topnav height
// in top-nav.css). Used to clamp the Content column so full-page routes get
// exactly viewport-minus-nav and the bottom action bars land flush.
const TOP_NAV_H = 56;

// Viewport-width breakpoints driving auto-collapse. Tuned for the ERP's
// content density: a typical bill form needs ~880-1000 px of horizontal
// content space, so anything narrower than ~1100 px (sidebar 270 + content
// 880 + chrome) is too tight unless the sidebar collapses. Below ~700 px
// the collapsed sidebar (68 px) eats too much; we hide it entirely behind
// a hamburger toggle the user can open as an overlay.
const COLLAPSE_BREAKPOINT = 1100;
const HIDE_BREAKPOINT     = 700;

// ── Escape → cascade up to Home ───────────────────────────────────────────
// An Esc that nothing else consumes walks the operator back up the
// hierarchy and finally lands on Home (Command Center). Pages that own Esc
// (bill / return / payment forms, detail pages via their ActionStrip
// "Back") call preventDefault, so they still go one level up — e.g. the
// Sales form → Sales list. The NEXT Esc on that list, which has no Esc
// handler of its own, falls through to this rule and goes Home. One
// central rule instead of an Esc handler bolted onto ~40 list pages.
const HOME_PATH = '/';
// Already at the top of the tree — Esc has nowhere further up to go.
const ESC_HOME_SKIP_PATHS = new Set(['/', '/dashboard', '/dashboard/classic']);
// If any of these is in the DOM when Esc is pressed, that Esc belongs to
// the overlay (Esc closes it). A second Esc — overlay now gone — cascades
// Home. Covers the app's custom popups + every AntD overlay layer.
const ESC_OVERLAY_SELECTOR = [
  '.gs-modal-backdrop',          // ⌘K global search palette
  '.mc-backdrop',                // Master chooser
  '.mp-popup',                   // Alt-letter menu popup
  '.dp-backdrop',                // F2 date popup
  '.erp-shortcuts-overlay',      // keyboard cheat-sheet
  '.ant-modal-wrap:not([style*="display: none"])',
  '.ant-drawer-open',
  '.ant-dropdown:not(.ant-dropdown-hidden)',
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  '.ant-popover:not(.ant-popover-hidden)',
  '.ant-image-preview-wrap',
].join(', ');

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const menuOrientation = useThemeStore((s) => s.menuOrientation);
  const isHorizontal = menuOrientation === 'horizontal';

  // User preference for sidebar collapse — read from localStorage ONCE on
  // mount and kept in state. Reading on every render (previous IIFE approach)
  // combined with the localStorage-write effect below caused a re-render loop
  // during the AntD Sider's width transition: localStorage write → next render
  // re-read → useEffect dep flip → setCollapsed → animation restart → flicker.
  const [userPreferredCollapsed, setUserPreferredCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === 'true'; }
    catch { return false; }
  });

  // Track viewport width via matchMedia rather than a raw resize listener.
  // matchMedia only fires when the breakpoint actually crosses, which avoids
  // the rapid-fire callbacks a continuous resize would cause (e.g. when the
  // sidebar animation briefly perturbs scrollbar visibility) — that fast
  // re-fire was visible as a blinking sidebar in some setups.
  const matchesQuery = (q) => typeof window !== 'undefined' && window.matchMedia(q).matches;
  const COLLAPSE_Q = `(max-width: ${COLLAPSE_BREAKPOINT - 1}px)`;
  const HIDE_Q     = `(max-width: ${HIDE_BREAKPOINT - 1}px)`;
  const [autoCollapsed, setAutoCollapsed] = useState(() => matchesQuery(COLLAPSE_Q));
  const [autoHidden,    setAutoHidden]    = useState(() => matchesQuery(HIDE_Q));
  useEffect(() => {
    const mqCollapse = window.matchMedia(COLLAPSE_Q);
    const mqHide     = window.matchMedia(HIDE_Q);
    const onCollapse = (e) => setAutoCollapsed(e.matches);
    const onHide     = (e) => setAutoHidden(e.matches);
    mqCollapse.addEventListener('change', onCollapse);
    mqHide.addEventListener('change', onHide);
    return () => {
      mqCollapse.removeEventListener('change', onCollapse);
      mqHide.removeEventListener('change', onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Collapsed state shown to Sidebar. Auto-collapse wins; otherwise the
  // user's persisted preference stands. Effect only depends on autoCollapsed
  // (not on userPreferredCollapsed) so user toggles flow through the
  // explicit handler below without bouncing through this effect.
  const [collapsed, setCollapsed] = useState(() => userPreferredCollapsed);
  useEffect(() => {
    if (autoCollapsed) setCollapsed(true);
    else setCollapsed(userPreferredCollapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCollapsed]);

  // Single entry point for collapse toggles (passed to Sidebar). Updates the
  // visible collapse state AND the persisted preference together — except
  // when auto-collapse is active, in which case we don't overwrite the user's
  // saved preference so it comes back when the window grows.
  const setCollapsedSticky = (next) => {
    setCollapsed(next);
    if (!autoCollapsed) {
      setUserPreferredCollapsed(next);
      try { localStorage.setItem(SIDEBAR_KEY, String(next)); } catch {}
    }
  };

  // Mobile-overlay: when vw < HIDE_BREAKPOINT the sidebar is taken out of
  // the layout flow entirely and rendered as a slide-in panel triggered
  // by a hamburger button in the top bar. Always close the overlay nav
  // on route change so a tap-link-then-page flow doesn't leave the menu
  // sitting open over the new page.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);

  // Global Esc handling. Three tiers, first match wins:
  //   1. Search-back — reached this page via the global search palette →
  //      Esc returns to where the search started.
  //   2. Reports-hub back — a report opened from the /reports hub bounces
  //      back to the hub (search query intact).
  //   3. Cascade-to-Home fallback — anything else: if no page-level
  //      handler / modal consumed the Esc, walk up to Home. This is what
  //      makes "Esc on the Sales list goes Home" work without bolting an
  //      Esc handler onto every list / report / settings page.
  //
  // Guard: never fight TEXT inputs / textareas / contenteditable — they
  // own Esc for their own clear/dismiss. Non-text inputs (the hidden
  // radio AntD's Segmented control parks focus on, etc.) must NOT block
  // Esc-back.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;

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

      // (1) Search-back. The palette stashed the source route in
      // `search_back_from` before navigating; consume it so a second Esc
      // doesn't loop.
      const here = location.pathname + location.search;
      const searchBack = sessionStorage.getItem('search_back_from');
      if (searchBack && searchBack !== here) {
        e.preventDefault();
        sessionStorage.removeItem('search_back_from');
        navigate(searchBack);
        return;
      }

      // (2) Reports-hub back — only for a report opened from the hub.
      // (A directly-opened report URL falls through to tier 3 → Home.)
      const path = location.pathname;
      if (path.startsWith('/reports/') && path !== '/reports/' &&
          sessionStorage.getItem('reports_hub_back') === '1') {
        e.preventDefault();
        window.history.back();
        return;
      }

      // (3) Cascade-to-Home fallback.
      // Already at the top of the tree — nowhere further up.
      if (ESC_HOME_SKIP_PATHS.has(path)) return;
      // An overlay is open — this Esc closes it, it doesn't navigate.
      // The next Esc (overlay gone) cascades.
      if (document.querySelector(ESC_OVERLAY_SELECTOR)) return;
      // Defer one macrotask so page-level Esc owners (a bill form's
      // ActionStrip "Back", AntD modals, the custom popups) run first.
      // They call preventDefault when they handle it — e.g. the Sales
      // form navigates to the Sales list. Only an Esc that NOBODY
      // consumed reaches Home, turning Form → List → Home into one rule.
      setTimeout(() => {
        if (e.defaultPrevented) return;
        navigate(HOME_PATH);
      }, 0);
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
  const isFullPage = /^\/(sales-return|purchase-return|sale|purchase|payment|receipt|expenses|stock-movement|stock-report-pro|stock-transfer|banks|loans|inventory\/batches|settings|reports\/stock-by-color)(\/|$)/.test(location.pathname) || [
    // Home (Command Center) — pinned viewport shell. The KPI ribbon, hero,
    // and action ribbon need to land flush against the viewport edges and
    // never scroll, so it joins the full-page list rather than rendering
    // inside the padded card frame.
    '/',
    // Editorial Dashboard — sticky topbar (Dashboard heading + period
    // controls + date picker) pins flush against the viewport edges.
    // Without full-page treatment, main's margin + padding leave visible
    // gaps above and on both sides of the topbar.
    '/dashboard',
    // Home settings — sticky title + restore-defaults button stay fixed
    // at the top of the Content while the toggle sections scroll below.
    // Without /settings/home in the full-page list, the whole app-level
    // Content scroller engages instead of the page's own.
    '/settings/home',
    '/products', '/stock-report', '/stock-report-pro', '/stock-movement', '/categories', '/customers', '/suppliers',
    '/sales', '/purchases', '/payments',
    '/sales-returns', '/purchase-returns',
    '/reports/sales', '/reports/purchases',
    // Sales by Salesman — same editorial-report shell as Sales Report
    // (.report-editorial → sticky header + KPI strip + filter row +
    // internally-scrolling table panel + ActionStrip pinned to the
    // viewport bottom). Must be full-page so .erp-page-content gets an
    // explicit 100dvh height; otherwise .report-editorial's height:100%
    // collapses to content height, leaving a void below the table panel
    // and the F-bar floating mid-page instead of flush at the bottom.
    '/reports/sales-by-salesman',
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
    // Stock by Color — same shell as Stock Report (sr-page CSS):
    // sticky header + KPI strip + filter chips + virtualized table.
    // Detail page (/stock-by-color/:productId) is caught by the
    // regex via the leading ^/reports — wait, it's not. Both paths
    // need to be listed explicitly here so the drill-in shares the
    // full-page treatment.
    '/reports/stock-by-color',
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
  // 100dvh handles dynamic browser chrome (mobile URL bars) without leaving
  // a gap or overshooting on resize.
  const fullPageH = isHorizontal ? `calc(100dvh - ${TOP_NAV_H}px)` : '100dvh';

  // Page wrapper key. Keyed on the top-level route segment — NOT the full
  // pathname — so in-page navigation (e.g. /stock-movement → /stock-movement/42
  // or /sale/edit/1 → /sale/edit/2) does NOT unmount and remount the page,
  // which previously re-ran every useEffect (most visibly, the product list
  // fetch in StockMovement) and showed as a whole-page "blink" on every
  // product click. Cross-section navigation (/products → /sales) still
  // changes the key, giving route transitions a clean state reset.
  const pageKey = '/' + (location.pathname.split('/')[1] || '');

  // Horizontal mode: stack TopNav + Content vertically.
  // `height: 100dvh` (not minHeight) clamps the shell to the viewport so the
  // TopNav stays pinned and only the <Content> body scrolls — without this,
  // a tall page grows the outer Layout and the browser scrolls everything.
  if (isHorizontal) {
    return (
      <Layout className="app-layout-horizontal" style={{ height: '100dvh', flexDirection: 'column' }}>
        <TopNav />
        {/* Past-FY banner — amber strip between the topnav and the page
            body when viewingFY !== currentFY. Renders null otherwise, so
            no reserved space in the common case. */}
        <PastFYBanner />
        <RemoteShopBanner />
        <Layout style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Content style={{
            margin:        isFullPage ? 0 : 'clamp(6px, 2vw, 20px)',
            padding:       isFullPage ? 0 : 'clamp(10px, 2vw, 24px)',
            background:    'transparent',
            overflow:      isFullPage ? 'hidden' : 'auto',
            flex:          1,
            minWidth:      0,
            // maxHeight pins Content to the viewport so flex children (like
            // bill lists / party ledger) can't push the body to overflow.
            // 100dvh adapts to dynamic browser chrome (mobile URL bars).
            height:        isFullPage ? fullPageH : undefined,
            maxHeight:     isFullPage ? fullPageH : undefined,
            minHeight:     isFullPage ? 0 : `calc(100dvh - ${TOP_NAV_H + 40}px)`,
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
  //
  // On very narrow viewports (autoHidden), the Sidebar is rendered in a
  // wrapper that's positioned fixed off-screen by default. A hamburger
  // button shown via .erp-mobile-nav-toggle (CSS-only, in global.css)
  // toggles `mobileNavOpen` to slide it in. The .erp-mobile-nav-scrim
  // covers the page so a tap outside dismisses the menu.
  return (
    <Layout className={`erp-app-layout${autoHidden ? ' is-mobile' : ''}${mobileNavOpen ? ' nav-open' : ''}`}
            style={{ height: '100dvh' }}>
      {autoHidden && (
        <button
          type="button"
          className="erp-mobile-nav-toggle"
          aria-label="Open menu"
          onClick={() => setMobileNavOpen(o => !o)}
        >
          <span /><span /><span />
        </button>
      )}
      {autoHidden && mobileNavOpen && (
        <div
          className="erp-mobile-nav-scrim"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <Sidebar collapsed={collapsed} setCollapsed={setCollapsedSticky} />
      <Layout style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Past-FY banner — amber strip above the page body when the
            user is viewing a past FY context. Null in the common case. */}
        <PastFYBanner />
        <RemoteShopBanner />
        <Content style={{
          margin:        isFullPage ? 0 : 'clamp(6px, 2vw, 20px)',
          padding:       isFullPage ? 0 : 'clamp(10px, 2vw, 24px)',
          background:    'transparent',
          overflow:      isFullPage ? 'hidden' : 'auto',
          flex:          1,
          minWidth:      0,
          // dvh (dynamic viewport height) keeps the layout fitted when
          // mobile address bars expand/collapse and when Electron's
          // window menu changes the chrome height. Falls back to vh on
          // older browsers via the dual declaration in CSS.
          height:        isFullPage ? '100dvh' : undefined,
          maxHeight:     isFullPage ? '100dvh' : undefined,
          minHeight:     isFullPage ? 0 : 'calc(100dvh - 40px)',
        }}>
          <div
            key={location.pathname}
            className="erp-page-content"
            data-fullpage={isFullPage ? '' : undefined}
            // Explicit height (not 100%) — see the horizontal branch for why:
            // percentage heights collapse inside AntD's flex-basis-0 main column.
            style={isFullPage ? { height: '100dvh', overflow: 'hidden' } : undefined}
          >
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
