import React, { useState, useEffect } from 'react';
import { Layout } from 'antd';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import AppHeader from './Header';

const { Content } = Layout;

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

  // Auto-collapse sidebar on small screens
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 900) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Full-page views: bill forms, lists, reports
  const isFullPage = /^\/(sale|purchase|payment|receipt)\//.test(location.pathname) || [
    '/products', '/stock-report', '/stock-report-pro', '/categories', '/customers', '/suppliers',
    '/sales', '/purchases', '/payments',
    '/reports/sales', '/reports/purchases', '/reports/stock',
    '/reports/party-ledger', '/reports/profit-loss',
  ].includes(location.pathname);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sidebar collapsed={collapsed} />
      <Layout style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <AppHeader collapsed={collapsed} setCollapsed={setCollapsed} />
        <Content style={{
          margin:     isFullPage ? 0 : 'clamp(8px, 2vw, 20px)',
          padding:    isFullPage ? 0 : 'clamp(12px, 2vw, 24px)',
          background: 'transparent',
          overflow:   isFullPage ? 'hidden' : 'auto',
          flex:       1,
          minWidth:   0,
          height:     isFullPage ? 'calc(100vh - 64px)' : undefined,
          minHeight:  isFullPage ? 0 : 'calc(100vh - 64px - 40px)',
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
