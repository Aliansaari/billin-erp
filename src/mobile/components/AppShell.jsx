import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import TabBar from './TabBar';
import SidePanel from './SidePanel';
import './page-transition.css';

// On the home screen, an edge-swipe-right opens the side panel.
// On every other page, the same gesture goes back one step in history.
// Capacitor's WKWebView doesn't ship the native iOS swipe-back gesture
// out of the box, so we implement it here in JS.
const HOME_PATHS = new Set(['/', '/dashboard']);

export default function AppShell() {
  const [panelOpen, setPanelOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const lastNavAt = useRef(0);

  useEffect(() => {
    lastNavAt.current = Date.now();
  }, [location.pathname]);

  const touchRef = useRef({ startX: 0, startY: 0, fromEdge: false });
  const onTouchStart = useCallback((e) => {
    const t = e.touches[0];
    touchRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      // Only count it as an edge-swipe if the touch starts within the
      // leftmost 28px — keeps normal horizontal scrolling (carousels,
      // chip rows) from triggering navigation.
      fromEdge: t.clientX < 28,
    };
  }, []);
  const onTouchEnd = useCallback((e) => {
    const { startX, startY, fromEdge } = touchRef.current;
    if (!fromEdge) return;
    // Ignore a swipe that fires right after a route change — a freshly
    // mounted screen shouldn't re-trigger the gesture from the same
    // touch sequence carried over by the previous page.
    if (Date.now() - lastNavAt.current < 400) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    if (dx < 70 || dy > 60) return;

    if (HOME_PATHS.has(location.pathname)) {
      setPanelOpen(true);
    } else {
      navigate(-1);
    }
  }, [location.pathname, navigate]);

  // iOS-style page transitions: forward navigations slide in from the
  // right, POP (back) slides out to the right. The key on .pt-stage
  // forces React to remount on path change so the CSS animation fires.
  const navType = useNavigationType();
  const transitionClass = navType === 'POP' ? 'pt-stage pt-stage--back' : 'pt-stage pt-stage--forward';

  return (
    <>
      <div className="app-shell" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="app-shell-body">
          <div key={location.pathname} className={transitionClass}>
            <Outlet context={{ setPanelOpen }} />
          </div>
        </div>
        <TabBar />
      </div>
      <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </>
  );
}
