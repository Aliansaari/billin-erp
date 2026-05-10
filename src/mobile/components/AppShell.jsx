import React, { useCallback, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';
import TabBar from './TabBar';
import SidePanel from './SidePanel';

export default function AppShell() {
  const [panelOpen, setPanelOpen] = useState(false);

  const touchRef = useRef({ startX: 0, startY: 0 });
  const onTouchStart = useCallback((e) => {
    const t = e.touches[0];
    touchRef.current = { startX: t.clientX, startY: t.clientY };
  }, []);
  const onTouchEnd = useCallback((e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - touchRef.current.startX;
    const dy = Math.abs(t.clientY - touchRef.current.startY);
    if (dx > 80 && dy < 60 && touchRef.current.startX < 50) {
      setPanelOpen(true);
    }
  }, []);

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
