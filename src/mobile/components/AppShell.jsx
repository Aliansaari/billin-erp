import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import TabBar from './TabBar';
import SidePanel from './SidePanel';
import PageStage from './PageStage';
import { refreshCompanyProfile } from '../utils/companyProfile';

// Lightweight fallback shown while a lazily-loaded route chunk arrives.
// Keeps the tab bar visible and just fills the body with a quiet spinner.
function RouteFallback() {
  return (
    <div className="route-fallback" aria-busy="true" aria-label="Loading">
      <span className="route-fallback-spin" />
    </div>
  );
}

// Keep the displayed company name in step with Settings → Company Profile,
// including after a company switch (which reloads the app).
function useCompanyProfileSync() {
  useEffect(() => { refreshCompanyProfile().catch(() => {}); }, []);
}

export default function AppShell() {
  useCompanyProfileSync();
  const [panelOpen, setPanelOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  // PUSH / REPLACE go forward, POP comes back — the router already knows
  // which, so the direction never has to be inferred from path depth.
  const navType = useNavigationType();

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
      // Start within 80px of the left edge, travel 50px+ to the right, and
      // stay mostly horizontal (vertical drift must be under the horizontal
      // distance). The proportional check lets slightly-diagonal swipes
      // through, which is why the gesture used to feel flaky.
      if (touchStart.current.x > 80 || dx < 50 || dy > dx) return;
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
          {/* Keyed on location.key so each navigation restarts the animation.
              Without a changing key React reuses the element and the keyframes
              never replay, which is how this ended up applied to nothing at
              all. The stage holds no transform at rest — see
              page-transition.css for why that matters. */}
          <PageStage
            key={location.key}
            direction={navType === 'POP' ? 'back' : 'forward'}
          >
            <Suspense fallback={<RouteFallback />}>
              <Outlet context={{ setPanelOpen }} />
            </Suspense>
          </PageStage>
        </div>
        <TabBar />
      </div>
      <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </>
  );
}
