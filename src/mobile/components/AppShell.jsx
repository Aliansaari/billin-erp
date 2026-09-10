import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType, useOutlet } from 'react-router-dom';
import TabBar from './TabBar';
import { ShellContext } from './ShellContext';
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
/* The four bottom-bar destinations. These stay mounted for the life of the
 * session; everything else is a push.
 *
 * '/' is deliberately NOT here even though it is where the app lands. For
 * every role except salesman it renders <Navigate to="/dashboard">, and a
 * redirect that is kept mounted re-fires on every render of the shell — so
 * caching it silently dragged the app back to Home from whichever tab you
 * pressed. A screen is only safe to keep alive if rendering it again is a
 * no-op; anything that navigates as a side effect of rendering is not. */
const TAB_PATHS = new Set(['/dashboard', '/vouchers', '/stock', '/reports']);

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

  /* ── Tab screens are objects, not functions ─────────────────────────
   *
   * A native tab bar does not rebuild a screen when you come back to it: your
   * scroll position, your filters, your half-typed search are all still there,
   * and the switch is instantaneous because nothing had to be recreated.
   *
   * A route is the opposite. `<Outlet/>` renders only the matched screen, so
   * Home → Stock → Home destroyed Home and built it again from nothing —
   * scroll lost, filters cleared, every request re-fired. That single
   * difference is the loudest "this is a web page" tell in the app, and it is
   * felt every few seconds.
   *
   * So the four tabs are kept mounted and merely hidden. `useOutlet()` hands
   * back the element for the current route; we keep the ones belonging to tabs
   * in a map and render them all, in a stable order, so React reconciles each
   * to the same instance it had before.
   *
   * Hidden means `visibility: hidden`, NOT `display: none` — display:none
   * discards the scroll offset of a scroll container, which is the very thing
   * this exists to preserve.
   *
   * Drill-down screens are not cached: they are pushed on top, they animate,
   * and coming back should genuinely leave them behind. */
  const outlet = useOutlet();
  // Memoised so a shell re-render does not invalidate it for every screen.
  const shellCtx = useMemo(() => ({ setPanelOpen }), [setPanelOpen]);
  const isTab  = TAB_PATHS.has(location.pathname);
  const tabCache = useRef(new Map());
  if (isTab && outlet) tabCache.current.set(location.pathname, outlet);
  const tabs = [...tabCache.current.entries()];

  return (
    <>
      <div className="app-shell">
        <ShellContext.Provider value={shellCtx}>
        <div className="app-shell-body">
          {tabs.map(([path, el]) => (
            <div
              key={path}
              className={`tab-pane${path === location.pathname ? ' is-active' : ''}`}
              // Inert while hidden, so a stray tap or a focus jump can never
              // land on a screen the user cannot see.
              aria-hidden={path !== location.pathname}
            >
              <Suspense fallback={<RouteFallback />}>{el}</Suspense>
            </div>
          ))}

          {/* Keyed on the PATH, never on location.key.

              location.key changes on every history entry — including a
              `replace` that only rewrites the query string. Several screens
              (VouchersList, PartyStatement) sync their filters into the URL
              from an effect whose deps include setSearchParams, which React
              Router does not keep referentially stable. Keying on location.key
              therefore remounted the page on its own URL write, the effect ran
              again, and the screen locked into an infinite remount loop —
              blinking, never loading, taking the app down with it.

              Keying on pathname is also simply correct: a transition belongs
              to a NAVIGATION, not to a filter change on the screen you are
              already looking at. */}
          {!isTab && (
            <PageStage
              key={location.pathname}
              direction={navType === 'POP' ? 'back' : 'forward'}
            >
              <Suspense fallback={<RouteFallback />}>
                {outlet}
              </Suspense>
            </PageStage>
          )}
        </div>
        </ShellContext.Provider>
        <TabBar />
      </div>
      <SidePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </>
  );
}
