import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Routes, useLocation, useNavigate,
  UNSAFE_NavigationContext as NavigationContext, UNSAFE_RouteContext as RouteContext,
  UNSAFE_LocationContext as LocationContext,
} from 'react-router-dom';
import { Button } from 'antd';
import useTabStore, { pathOf, toLocation } from './tabStore';
import { TabIdContext, isTabLive } from './tabContext';
import { bindTabNavigate, requestClose } from './tabActions';
import { useNavGuard } from '../hooks/useUnsavedChangesWarning';
import { getDataVersion } from './dataVersion';
import { isEntryScreen } from './tabMeta';
import { noteNav, takeArmedBack } from './backTrail';

/*
 * Renders every open tab's screen and shows only the active one.
 *
 * Hidden tabs stay mounted (their state, scroll and half-typed bill are kept)
 * but are `visibility: hidden` + `inert`: not clickable, not focusable, and
 * their layout keeps its size, so nothing re-measures or flickers when you
 * come back. Each tab gets its own navigator, so a hidden tab that navigates
 * (a save finishing in the background) moves only itself, never the screen
 * you are looking at.
 */

// Each tab matches the app's routes from the root, on its own. A fixed
// route context cuts the link to the URL's match, so navigating in one tab
// does not redraw the screens in the others.
const ROOT_ROUTE = { outlet: null, matches: [], isDataRoute: false };

const MARGIN = 'clamp(6px, 2vw, 20px)';
const PADDING = 'clamp(10px, 2vw, 24px)';

function tabNavigator(tabId, outer) {
  const go = (to, state, replace) => {
    const cur = useTabStore.getState().tabs.find((t) => t.id === tabId)?.loc || null;
    let loc = toLocation(typeof to === 'string' ? to : { ...to, state }, state);
    // A page's own Back goes to the screen this one was opened from, when
    // there is one (src/tabs/backTrail.js).
    const back = takeArmedBack(tabId, loc.pathname, cur);
    if (back && !back.keep) {
      to = { pathname: back.pathname, search: back.search, hash: back.hash };
      state = back.state;
      loc = toLocation({ ...to, state }, state);
    }
    noteNav(tabId, loc, replace ? 'replace' : 'page', cur);
    useTabStore.getState().patchLoc(tabId, loc);
    if (isTabLive(tabId)) outer[replace ? 'replace' : 'push'](to, state);
  };
  return {
    createHref: (to) => outer.createHref(to),
    encodeLocation: outer.encodeLocation ? (to) => outer.encodeLocation(to) : undefined,
    go: (n) => { if (isTabLive(tabId)) outer.go(n); },
    push: (to, state) => go(to, state, false),
    replace: (to, state) => go(to, state, true),
  };
}

/** One tab's crash stays in that tab. */
class TabErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[tab]', error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="tab-crash">
        <h3>This tab ran into a problem</h3>
        <p>Your other tabs are fine. Reload this screen, or close the tab.</p>
        <div className="tab-crash-actions">
          <Button type="primary" onClick={() => { this.setState({ error: null }); this.props.onReload(); }}>Reload screen</Button>
          <Button onClick={this.props.onClose}>Close tab</Button>
        </div>
      </div>
    );
  }
}

// Memoised: a hidden tab does not redraw when you work in another one.
const TabPane = React.memo(function TabPane({ tab, active, pages, isFullPage, horizontal }) {
  const outer = useContext(NavigationContext);
  const nav = useMemo(() => ({ ...outer, navigator: tabNavigator(tab.id, outer.navigator) }), [outer, tab.id]);
  // The tab's own location, stable until the tab itself navigates.
  const loc = useMemo(() => ({ location: tab.loc, navigationType: 'POP' }), [tab.loc]);
  const paneRef = useRef(null);
  const { pathname } = tab.loc;
  const full = isFullPage(pathname);
  // Same remount rules as before tabs: vertical layout per path, top-nav
  // layout per section. mountKey forces a fresh screen (wake / refresh).
  const pageKey = `${tab.mountKey}:${horizontal ? '/' + (pathname.split('/')[1] || '') : pathname}`;

  // `inert` is not a React 18 prop: set it on the element.
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    if (active) el.removeAttribute('inert'); else el.setAttribute('inert', '');
  }, [active]);

  return (
    <div
      ref={paneRef}
      className={`erp-tab-pane${active ? ' is-active' : ''}`}
      data-tab-id={tab.id}
      aria-hidden={active ? undefined : true}
      style={{ overflow: full ? 'hidden' : 'auto' }}
    >
      {!tab.sleeping && (
        <TabIdContext.Provider value={tab.id}>
          <NavigationContext.Provider value={nav}>
            <TabErrorBoundary
              key={pageKey}
              onReload={() => useTabStore.getState().remount(tab.id)}
              onClose={() => requestClose(tab.id)}
            >
              <div
                className="erp-page-content"
                data-fullpage={full ? '' : undefined}
                style={full
                  ? { height: '100%', overflow: 'hidden' }
                  : { margin: MARGIN, padding: PADDING, minHeight: `calc(100% - 2 * ${MARGIN})`, boxSizing: 'border-box' }}
              >
                <LocationContext.Provider value={loc}>
                  <RouteContext.Provider value={ROOT_ROUTE}>
                    <Routes location={tab.loc}>{pages}</Routes>
                  </RouteContext.Provider>
                </LocationContext.Provider>
              </div>
            </TabErrorBoundary>
          </NavigationContext.Provider>
        </TabIdContext.Provider>
      )}
    </div>
  );
});

export default function TabHost({ pages, isFullPage, horizontal }) {
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = useTabStore((s) => s.tabs);
  const activeId = useTabStore((s) => s.activeId);

  bindTabNavigate(navigate);

  // First mount (and after a sign-in as someone else): load this login's tabs.
  useLayoutEffect(() => {
    const to = useTabStore.getState().init(location);
    if (to && pathOf(to) !== pathOf(location)) navigate(pathOf(to), { replace: true, state: to.state });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Navigation from outside any tab (sidebar, shortcuts, search) moves the
  // visible tab. A tab switch moves the URL to that tab's own path, so the
  // two already agree and nothing is copied.
  // Only real navigations count: not the first render, when the URL is
  // still where the app started and the restored tab is about to move it.
  const seenLoc = useRef(null);
  useLayoutEffect(() => {
    if (seenLoc.current === location) return;   // StrictMode re-run
    const first = seenLoc.current === null;
    seenLoc.current = location;
    if (first) return;
    const st = useTabStore.getState();
    const act = st.tabs.find((t) => t.id === st.activeId);
    if (act && pathOf(act.loc) !== pathOf(location)) {
      noteNav(act.id, location, 'chrome', act.loc);
      st.patchLoc(act.id, location);
    }
  }, [location]);

  // Focus follows the tab: remember where the cursor was, put it back on return.
  const lastFocus = useRef(new Map());
  const prevActive = useRef(activeId);
  useLayoutEffect(() => {
    const prev = prevActive.current;
    prevActive.current = activeId;
    if (prev === activeId) return;
    const ae = document.activeElement;
    const prevPane = prev && document.querySelector(`.erp-tab-pane[data-tab-id="${prev}"]`);
    if (prevPane && ae && prevPane.contains(ae)) { lastFocus.current.set(prev, ae); ae.blur(); }
    const el = lastFocus.current.get(activeId);
    if (el && el.isConnected) requestAnimationFrame(() => { if (el.isConnected) el.focus({ preventScroll: true }); });
    // Lists and reports catch up with entries saved in another tab.
    const ver = getDataVersion();
    const st = useTabStore.getState();
    if (prev) st.markSeen(prev, ver);
    const now = st.tabs.find((t) => t.id === activeId);
    if (now && !now.sleeping && now.seenVersion < ver
        && !isEntryScreen(now.loc.pathname) && !useNavGuard.getState().isDirty(now.id)) {
      st.remount(now.id);
    }
    if (now) st.markSeen(now.id, ver);
  }, [activeId]);

  // Forget focus memory of closed tabs.
  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    for (const k of lastFocus.current.keys()) if (!ids.has(k)) lastFocus.current.delete(k);
  }, [tabs]);

  if (!tabs.length) return <div className="erp-tab-stage" />;
  return (
    <div className="erp-tab-stage">
      {tabs.map((t) => (
        <TabPane key={t.id} tab={t} active={t.id === activeId} pages={pages} isFullPage={isFullPage} horizontal={horizontal} />
      ))}
    </div>
  );
}
