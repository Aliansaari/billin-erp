import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType, useOutlet } from 'react-router-dom';
import TabBar from './TabBar';
import { ShellContext } from './ShellContext';
import { onResume, bindHardwareBack } from '../utils/nativeShell';
import SidePanel from './SidePanel';
import PageStage from './PageStage';
import { refreshCompanyProfile } from '../utils/companyProfile';
import { tap as hapticTap } from '../utils/haptics';

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
const TAB_ORDER = ['/dashboard', '/vouchers', '/stock', '/reports'];
const TAB_PATHS = new Set(TAB_ORDER);

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

  /* Coming back to the app.
   *
   * A phone goes in a pocket at 11am and comes out at 4pm still showing 11am's
   * figures, with nothing to say they are old — and if the shop computer came
   * back online in between, the app never noticed. Native apps refresh on
   * resume. Screens listen for this event and reload themselves; the shell
   * just broadcasts it, so no screen has to know about Capacitor.
   *
   * Throttled, because iOS fires a state change for every glance at the
   * notification shade and a wholesaler's dashboard is not free to rebuild.
   */
  useEffect(() => {
    let last = Date.now();
    return onResume(() => {
      const now = Date.now();
      if (now - last < 45_000) return;
      last = now;
      window.dispatchEvent(new CustomEvent('zehen:resumed'));
    });
  }, []);

  /* Android's hardware back button. Unhandled it closes the app from
   * anywhere — including from the middle of a half-entered bill. It should
   * mean what the back gesture means. */
  useEffect(() => bindHardwareBack(
    () => !isHomeRef.current,
    () => navigateRef.current(-1),
  ), []);

  /* ── Back gesture, following the thumb ──────────────────────────────
   *
   * This used to be a trigger: touchstart, touchend, "did it travel 50px?",
   * navigate. Nothing moved while your finger was down, so the screen jumped
   * only after you let go. People are more attuned to this one gesture than to
   * any other on iOS, and a binary version of it is the tell that survives
   * every other polish pass.
   *
   * Now the pushed screen tracks the finger, the tab underneath is really
   * there (see visiblePane above), and releasing below the threshold springs
   * back — so you can peek at what is behind and change your mind, which is
   * the part that makes it feel like an object rather than a command.
   *
   * Deliberately document-level and capture-phase, so a child calling
   * stopPropagation cannot silently kill it. Passive: we never preventDefault
   * — the gesture starts from the screen edge where there is nothing to
   * scroll, and taking over the touch stream would break scrolling everywhere
   * else if the drag were ever mis-detected.
   */
  useEffect(() => {
    const EDGE       = 40;   // px from the left edge that arms the gesture
    const SLOP       = 8;    // px of travel before we commit to dragging
    const COMMIT     = 0.32; // fraction of the width that counts as "back"
    const FLICK      = 0.45; // px/ms — a fast flick commits at any distance

    let drag = null;

    const stageEl = () => document.querySelector('.pt-stage');

    const paint = (x, w) => {
      if (!drag) return;
      const p = Math.min(1, x / w);
      drag.stage.style.transform = `translate3d(${x}px,0,0)`;
      // A shadow that thins as the screen leaves reads as depth rather than
      // as a rectangle sliding over another rectangle.
      drag.stage.style.boxShadow = `-14px 0 34px rgba(0,0,0,${(0.22 * (1 - p)).toFixed(3)})`;
      if (drag.beneath) {
        // iOS parallax: the screen underneath is already partly moved when the
        // one on top starts to leave, so they arrive together.
        drag.beneath.style.transform = `translate3d(${(-0.22 * (1 - p) * w).toFixed(1)}px,0,0)`;
      }
    };

    const release = (commit) => {
      if (!drag) return;
      const { stage, beneath, w } = drag;
      stage.style.transition = 'transform 0.26s cubic-bezier(0.22,0.9,0.24,1), box-shadow 0.26s linear';
      if (beneath) beneath.style.transition = 'transform 0.26s cubic-bezier(0.22,0.9,0.24,1)';
      if (commit) {
        stage.style.transform = `translate3d(${w}px,0,0)`;
        stage.style.boxShadow = 'none';
        if (beneath) beneath.style.transform = 'translate3d(0,0,0)';
        hapticTap();
        // Navigate when the screen has actually left, not before — otherwise
        // the route swaps under a half-moved element and it snaps.
        setTimeout(() => navigateRef.current(-1), 210);
      } else {
        stage.style.transform = 'translate3d(0,0,0)';
        stage.style.boxShadow = 'none';
        if (beneath) beneath.style.transform = 'translate3d(0,0,0)';
        const el = stage;
        const bn = beneath;
        setTimeout(() => {
          el.style.transition = '';
          el.style.transform = '';
          el.style.boxShadow = '';
          if (bn) { bn.style.transition = ''; bn.style.transform = ''; }
        }, 280);
      }
      drag = null;
    };

    const onStart = (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      touchStart.current = { x: t.clientX, y: t.clientY };
      if (t.clientX > EDGE) return;
      if (isHomeRef.current) return;          // home swipe opens the panel instead
      const stage = stageEl();
      if (!stage) return;
      drag = {
        stage,
        beneath: document.querySelector('.tab-pane.is-beneath'),
        x0: t.clientX,
        y0: t.clientY,
        w: window.innerWidth || 390,
        started: false,
        lastX: t.clientX,
        lastT: e.timeStamp,
        v: 0,
      };
      stage.style.transition = 'none';
      if (drag.beneath) drag.beneath.style.transition = 'none';
    };

    const onMove = (e) => {
      if (!drag) return;
      const t = e.touches[0];
      const dx = t.clientX - drag.x0;
      const dy = Math.abs(t.clientY - drag.y0);

      if (!drag.started) {
        // Vertical intent wins — the user is scrolling, not going back.
        if (dy > SLOP && dy > Math.abs(dx)) { release(false); return; }
        if (dx < SLOP) return;
        drag.started = true;
      }

      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.v = (t.clientX - drag.lastX) / dt;
      drag.lastX = t.clientX;
      drag.lastT = e.timeStamp;

      paint(Math.max(0, dx), drag.w);
    };

    const onEnd = (e) => {
      /* No drag was armed. Two cases, and both used to work before the
       * interactive version existed, so both are kept:
       *
       *   Home — the edge swipe opens the side panel. Still a trigger,
       *   because there is nothing underneath to reveal; the panel is its
       *   own surface arriving from the edge.
       *
       *   A tab screen — there is no pushed screen to drag, but going back
       *   to whatever you were on before is still what the gesture means.
       *   Dropping this silently took away behaviour the app already had. */
      if (!drag) {
        const dx = e.changedTouches[0].clientX - touchStart.current.x;
        const dy = Math.abs(e.changedTouches[0].clientY - touchStart.current.y);
        if (touchStart.current.x > 80 || dx < 50 || dy > dx) return;
        if (isHomeRef.current) setPanelRef.current(true);
        else navigateRef.current(-1);
        return;
      }
      if (!drag.started) { release(false); return; }
      const dx = Math.max(0, e.changedTouches[0].clientX - drag.x0);
      release(dx > drag.w * COMMIT || drag.v > FLICK);
    };

    const onCancel = () => release(false);

    document.addEventListener('touchstart',  onStart,  { capture: true, passive: true });
    document.addEventListener('touchmove',   onMove,   { capture: true, passive: true });
    document.addEventListener('touchend',    onEnd,    { capture: true, passive: true });
    document.addEventListener('touchcancel', onCancel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('touchstart',  onStart,  { capture: true });
      document.removeEventListener('touchmove',   onMove,   { capture: true });
      document.removeEventListener('touchend',    onEnd,    { capture: true });
      document.removeEventListener('touchcancel', onCancel, { capture: true });
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
  /* Keep tabs alive, but not all of them for ever.
   *
   * Every live pane is a full screen's worth of DOM and data held in a
   * WebView that iOS will restart the moment it wants the memory back — and a
   * restart is invisible except that everything blanks and comes back from
   * nothing. Stock is the heavy one: hundreds of rows, each with its own
   * chips and figures.
   *
   * Three is the number that matters. It covers going back and forth between
   * two tabs, and the one you touched longest ago rebuilds — from the
   * persisted cache, so it paints rather than spins. Unbounded felt better
   * right up until the phone disagreed. */
  const MAX_LIVE_PANES = 3;
  const tabCache = useRef(new Map());
  if (isTab && outlet) {
    // Re-inserting moves the key to the end, which is what makes this LRU.
    tabCache.current.delete(location.pathname);
    tabCache.current.set(location.pathname, outlet);
    while (tabCache.current.size > MAX_LIVE_PANES) {
      const oldest = tabCache.current.keys().next().value;
      if (oldest === location.pathname) break;
      tabCache.current.delete(oldest);
    }
  }
  /* Rendered in a STABLE order, not in recency order. React reconciles
   * children by position, so reordering them on every tab change would move
   * each pane to a different slot and remount the very screens this exists to
   * keep alive. */
  const tabs = [...tabCache.current.entries()]
    .sort((a, b) => TAB_ORDER.indexOf(a[0]) - TAB_ORDER.indexOf(b[0]));

  /* Which pane is showing. While a detail screen is pushed, the tab it was
   * opened from stays VISIBLE underneath rather than hidden with the rest —
   * otherwise dragging the pushed screen aside during a back-swipe reveals an
   * empty shell instead of the list you are going back to, which is the whole
   * point of the gesture. The pushed screen is opaque, so nothing shows until
   * the drag actually starts. */
  const lastTabRef = useRef('/dashboard');
  if (isTab) lastTabRef.current = location.pathname;
  // Remembered so a WebView restart reopens the tab the operator was on rather
  // than the dashboard — see lastRoute() in main.mobile.jsx.
  useEffect(() => {
    if (!isTab) return;
    try { localStorage.setItem('zehen_last_tab', location.pathname); } catch { /* private mode */ }
  }, [isTab, location.pathname]);
  const visiblePane = isTab ? location.pathname : lastTabRef.current;

  /* Tab changes were a hard cut — one pane's visibility off, the next one's
   * on, in the same frame. That reads as a blink rather than as a change of
   * screen, and it is the one place left where nothing moves at all.
   *
   * A short move-and-fade is enough. Deliberately NOT the full push/pop slide:
   * tabs are siblings, not a stack, and animating them like a stack would
   * imply a history that is not there. Going BACK to a tab comes from the
   * left, matching where it went; a tap comes up from below, which is what
   * the tab bar itself suggests. */
  const prevPaneRef = useRef(visiblePane);
  const paneDirRef  = useRef(null);
  if (prevPaneRef.current !== visiblePane) {
    paneDirRef.current = navType === 'POP' ? 'back' : 'tap';
    prevPaneRef.current = visiblePane;
  }
  const paneDir = paneDirRef.current;

  return (
    <>
      <div className="app-shell">
        <ShellContext.Provider value={shellCtx}>
        <div className="app-shell-body">
          {tabs.map(([path, el]) => (
            <div
              key={path}
              className={`tab-pane${path === visiblePane ? ' is-active' : ''}`
                + (path === visiblePane && !isTab ? ' is-beneath' : '')
                + (path === visiblePane && isTab && paneDir ? ` pane-in-${paneDir}` : '')}
              // Inert unless it is the screen actually being used, so a stray
              // tap or a focus jump can never land on a screen behind another.
              aria-hidden={!isTab || path !== location.pathname}
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
