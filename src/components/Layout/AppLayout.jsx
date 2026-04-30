import React, { useState, useEffect } from 'react';
import { Layout } from 'antd';
import { Outlet, useLocation } from 'react-router-dom';
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
      const path = location.pathname;
      if (!path.startsWith('/reports/') || path === '/reports/') return;
      if (sessionStorage.getItem('reports_hub_back') !== '1') return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      window.history.back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [location.pathname]);

  // Full-page views: bill forms, lists, reports. The regex below matches
  // new/edit routes that need the full viewport (height: 100vh, overflow:
  // hidden). ORDER MATTERS: sales-return must come before sale and
  // purchase-return before purchase — otherwise `/sales-return/new` would
  // partial-match `sale` and then fail the trailing \/, falling through to
  // the padded layout. That made the return forms visibly shrink to content
  // height instead of filling the screen.
  const isFullPage = /^\/(sales-return|purchase-return|sale|purchase|payment|receipt|stock-movement)\//.test(location.pathname) || [
    '/products', '/stock-report', '/stock-report-pro', '/stock-movement', '/categories', '/customers', '/suppliers',
    '/sales', '/purchases', '/payments',
    '/sales-returns', '/purchase-returns',
    '/reports/sales', '/reports/purchases', '/reports/stock',
    '/reports/party-ledger', '/reports/profit-loss', '/reports/aging',
    '/reports/gstr1', '/reports/day-book',
    '/reports/bills-receivable', '/reports/bills-payable',
    // Editorial financial reports — full-page shells with sticky
    // total bar + F-bar pinned to viewport bottom. Without these
    // listed, the wrapper paints them as a padded card and the
    // sticky bottom drifts up into the middle of the page.
    '/reports/balance-sheet', '/reports/trial-balance',
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
