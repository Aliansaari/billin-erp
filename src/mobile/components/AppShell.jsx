import React, { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import TabBar from './TabBar';
import SidePanel from './SidePanel';

export default function AppShell() {
  const [panelOpen, setPanelOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // Refs so the document listener (mounted once) always sees current values
  const isHomeRef   = useRef(location.pathname === '/');
  const navigateRef = useRef(navigate);
  const lastNavAt   = useRef(0);
  const touchStart  = useRef({ x: 0, y: 0 });
  const setPanelRef = useRef(setPanelOpen);

  useEffect(() => {
    const p = location.pathname;
    isHomeRef.current = p === '/' || p === '/dashboard';
    lastNavAt.current = Date.now();
  }, [location.pathname]);
  useEffect(() => { navigateRef.current = navigate; },     [navigate]);
  useEffect(() => { setPanelRef.current = setPanelOpen; }, [setPanelOpen]);

  // Capture phase so child stopPropagation can't block us
  useEffect(() => {
    const onStart = (e) => {
      touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
    const onEnd = (e) => {
      const dx = e.changedTouches[0].clientX - touchStart.current.x;
      const dy = Math.abs(e.changedTouches[0].clientY - touchStart.current.y);
      // Must start within 80px of left edge, travel 50px+ right, stay horizontal
      if (touchStart.current.x > 80 || dx < 50 || dy > 80) return;
      if (isHomeRef.current) {
        setPanelRef.current(true);
      } else {
        navigateRef.current(-1);
      }
    };
    document.addEventListener('touchstart', onStart, { capture: true, passive: true });
    document.addEventListener('touchend',   onEnd,   { capture: true, passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart, { capture: true });
      document.removeEventListener('touchend',   onEnd,   { capture: true });
    };
  }, []); // mount once — reads values through refs

  return (
    <>
      <div className="app-shell">
        <div className="app-shell-body">
          <Outlet context={{ setPanelOpen }} />
        </div>
        <TabBar />
      </div>
      <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </>
  );
}
