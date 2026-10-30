import { createContext, useCallback, useContext, useEffect } from 'react';
import useTabStore from './tabStore';

/*
 * Which tab a component lives in. Screens render inside a tab; the sidebar,
 * search palette and other app chrome render outside any tab (id null) and
 * are always live.
 */
export const TabIdContext = createContext(null);

export const useTabId = () => useContext(TabIdContext);

/** Is this tab the one on screen? Outside a tab: always true. */
export const isTabLive = (id) => id == null || useTabStore.getState().activeId === id;

/**
 * For window / document key listeners in screens: a hidden tab must not
 * react to keys meant for the visible one (F1 would save a bill you cannot
 * see). Call the returned function first thing in the handler:
 *
 *   const live = useTabLive();
 *   ... const onKey = (e) => { if (!live()) return; ... }
 */
export function useTabLive() {
  const id = useTabId();
  return useCallback(() => isTabLive(id), [id]);
}

/** True while this component's tab is on screen (re-renders on change). */
export function useTabShown() {
  const id = useTabId();
  return useTabStore((s) => id == null || s.activeId === id);
}

/**
 * Name this tab after what is in it, e.g. useTabTitle('Sale', 'ASHIYA DRESSES').
 * Falls back to the screen's own name when both are empty.
 */
export function useTabTitle(title, detail) {
  const id = useTabId();
  useEffect(() => {
    if (id == null) return;
    useTabStore.getState().setMeta(id, title || null, detail || null);
  }, [id, title, detail]);
  useEffect(() => () => { if (id != null) useTabStore.getState().setMeta(id, null, null); }, [id]);
}
