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
    '/reports/party-ledger', '/reports/profit-loss',
  ].includes(location.pathname);

  // In horizontal mode the top-nav eats TOP_NAV_H px; fullpage needs the rest.
  const fullPageH = isHorizontal ? `calc(100vh - ${TOP_NAV_H}px)` : '100vh';

  // Horizontal mode: stack TopNav + Content vertically.
  if (isHorizontal) {
    return (
      <Layout className="app-layout-horizontal" style={{ minHeight: '100vh', flexDirection: 'column' }}>
        <TopNav />
        <Layout style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Content style={{
            margin:     isFullPage ? 0 : 'clamp(8px, 2vw, 20px)',
            padding:    isFullPage ? 0 : 'clamp(12px, 2vw, 24px)',
            background: 'transparent',
            overflow:   isFullPage ? 'hidden' : 'auto',
            flex:       1,
            minWidth:   0,
            // maxHeight pins Content to the viewport so flex children (like
            // bill lists / party ledger) can't push the body to overflow.
            // Without this, `height: 100vh` acts only as a flex basis and
            // tall internal content grows the column past the window, making
            // the outer page scrollable.
            height:     isFullPage ? fullPageH : undefined,
            maxHeight:  isFullPage ? fullPageH : undefined,
            minHeight:  isFullPage ? 0 : `calc(100vh - ${TOP_NAV_H + 40}px)`,
          }}>
            <div
              key={location.pathname}
              className="erp-page-content"
              style={isFullPage ? { height: '100%', overflow: 'hidden' } : undefined}
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
          margin:     isFullPage ? 0 : 'clamp(8px, 2vw, 20px)',
          padding:    isFullPage ? 0 : 'clamp(12px, 2vw, 24px)',
          background: 'transparent',
          overflow:   isFullPage ? 'hidden' : 'auto',
          flex:       1,
          minWidth:   0,
          // maxHeight pins Content to the viewport so flex children (like
          // bill lists / party ledger) can't push the body to overflow.
          // Without this, `height: 100vh` acts only as a flex basis and
          // tall internal content grows the column past the window, making
          // the outer page scrollable.
          height:     isFullPage ? '100vh' : undefined,
          maxHeight:  isFullPage ? '100vh' : undefined,
          minHeight:  isFullPage ? 0 : 'calc(100vh - 40px)',
        }}>
          <div
            key={location.pathname}
            className="erp-page-content"
            style={isFullPage ? { height:'100%', overflow:'hidden' } : undefined}
          >
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
