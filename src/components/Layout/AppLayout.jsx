import React, { useState, useEffect } from 'react';
import { Layout } from 'antd';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';

const { Content } = Layout;

const SIDEBAR_KEY = 'sidebar_collapsed';

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_KEY);
    return stored === 'true';
  });
  const location = useLocation();

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
  const isFullPage = /^\/(sales-return|purchase-return|sale|purchase|payment|receipt)\//.test(location.pathname) || [
    '/products', '/stock-report', '/stock-report-pro', '/categories', '/customers', '/suppliers',
    '/sales', '/purchases', '/payments',
    '/sales-returns', '/purchase-returns',
    '/reports/sales', '/reports/purchases', '/reports/stock',
    '/reports/party-ledger', '/reports/profit-loss',
  ].includes(location.pathname);

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
          height:     isFullPage ? '100vh' : undefined,
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
