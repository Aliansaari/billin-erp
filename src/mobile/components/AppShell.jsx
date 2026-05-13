import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import TabBar from './TabBar';
import SidePanel from './SidePanel';

const ROOT_PATHS = new Set(['/', '/dashboard', '/vouchers', '/stock', '/reports', '/search', '/day-book', '/outstanding', '/items']);

export default function AppShell() {
  const [panelOpen, setPanelOpen] = useState(false);
  const location = useLocation();
  const lastNavAt = useRef(0);

  useEffect(() => {
    lastNavAt.current = Date.now();
  }, [location.pathname]);

  const touchRef = useRef({ startX: 0, startY: 0 });
  const onTouchStart = useCallback((e) => {
    const t = e.touches[0];
    touchRef.current = { startX: t.clientX, startY: t.clientY };
  }, []);
  const onTouchEnd = useCallback((e) => {
    if (!ROOT_PATHS.has(location.pathname)) return;
    if (Date.now() - lastNavAt.current < 800) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchRef.current.startX;
    const dy = Math.abs(t.clientY - touchRef.current.startY);
    if (dx > 80 && dy < 60 && touchRef.current.startX < 50) {
      setPanelOpen(true);
    }
  }, [location.pathname]);

  return (
    <>
      <div className="app-shell" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="app-shell-body">
          <Outlet context={{ setPanelOpen }} />
        </div>
        <TabBar />
      </div>
      <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </>
  );
}
