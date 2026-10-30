import { create } from 'zustand';
import { currentScope } from '../store/prefSync';
import { getDataVersion } from './dataVersion';

/*
 * Tabs — several screens open at once, each keeping its place.
 *
 * Every tab is a live copy of a screen: a half-typed bill, a scrolled
 * report, a filtered list all stay exactly as they were while you work in
 * another tab. Only the visible tab is "live"; hidden tabs keep their state
 * but ignore the keyboard (see useTabLive) and never steal focus.
 *
 * The visible tab mirrors the app's real URL, so the sidebar highlight, Esc
 * and every existing `navigate()` keep working unchanged. Hidden tabs hold
 * their own location here.
 *
 * Memory: at most MAX_TABS tabs; beyond LIVE_LIMIT, the tabs you have not
 * looked at for longest (and that hold no unsaved work) go to sleep — their
 * screen is unmounted and comes back fresh when you click the tab.
 *
 * Open tabs are remembered per login on this computer, so they come back
 * after a restart (sleeping, except the one you were on).
 */

export const MAX_TABS = 10;
export const LIVE_LIMIT = 6;
const CLOSED_KEEP = 10;

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
const rnd = () => Math.random().toString(36).slice(2, 10);

export const pathOf = (loc) => `${loc.pathname || '/'}${loc.search || ''}${loc.hash || ''}`;

/** A router-shaped location from a path string or a partial location. */
export function toLocation(to, state = null) {
  if (typeof to !== 'string') {
    return { pathname: to.pathname || '/', search: to.search || '', hash: to.hash || '', state: to.state ?? state ?? null, key: to.key || rnd() };
  }
  const u = new URL(to, 'http://x');
  return { pathname: u.pathname, search: u.search, hash: u.hash, state, key: rnd() };
}

const storageKey = () => {
  const scope = currentScope();
  return scope ? `zehen_tabs:${scope}` : null;
};

function readSaved() {
  const k = storageKey();
  if (!k) return null;
  try {
    const v = JSON.parse(localStorage.getItem(k) || 'null');
    if (!v || !Array.isArray(v.tabs) || !v.tabs.length) return null;
    return v;
  } catch { return null; }
}

function makeTab(loc, extra = {}) {
  return { id: newId(), loc, title: null, detail: null, sleeping: false, mountKey: 0, lastSeen: Date.now(), seenVersion: getDataVersion(), ...extra };
}

const useTabStore = create((set, get) => ({
  tabs: [],
  activeId: null,
  closed: [],         // recently closed paths, newest first (Ctrl+Shift+T)
  scope: null,        // whose tabs these are (company + user)
  flash: null,        // id of a tab just opened in the background (pulse)

  /** Start (or restart after a sign-in) from the router's current location. */
  init(loc) {
    const scope = currentScope();
    if (get().scope === scope && get().tabs.length) return null;
    const saved = readSaved();
    if (saved) {
      const tabs = saved.tabs.map((t) => makeTab(toLocation(t.path), { title: t.title || null, detail: t.detail || null, sleeping: true }));
      let idx = Math.min(Math.max(0, saved.active | 0), tabs.length - 1);
      // Opened on a specific screen (not the landing page): that wins.
      if (loc.pathname !== '/' && pathOf(loc) !== pathOf(tabs[idx].loc)) {
        const same = tabs.findIndex((t) => pathOf(t.loc) === pathOf(loc));
        if (same >= 0) idx = same; else tabs[idx] = makeTab(loc);
      }
      tabs[idx] = { ...tabs[idx], sleeping: false };
      set({ tabs, activeId: tabs[idx].id, scope, closed: [] });
      return tabs[idx].loc;
    }
    const first = makeTab(loc);
    set({ tabs: [first], activeId: first.id, scope, closed: [] });
    return null;
  },

  reset() { set({ tabs: [], activeId: null, closed: [], scope: null }); },

  /** Open a tab. Returns its id, or null when the limit is reached. */
  open(to, { activate = true, state = null, after } = {}) {
    const { tabs, activeId } = get();
    if (tabs.length >= MAX_TABS) return null;
    const tab = makeTab(toLocation(to, state));
    const at = tabs.findIndex((t) => t.id === (after || activeId));
    const next = [...tabs];
    next.splice(at < 0 ? next.length : at + 1, 0, tab);
    set({ tabs: next, flash: activate ? null : tab.id });
    if (activate) get().activate(tab.id);
    return tab.id;
  },

  activate(id) {
    const { tabs, activeId } = get();
    if (id === activeId || !tabs.some((t) => t.id === id)) return;
    const now = Date.now();
    set({
      activeId: id,
      tabs: tabs.map((t) => {
        if (t.id === activeId) return { ...t, lastSeen: now };
        if (t.id === id && t.sleeping) return { ...t, sleeping: false, mountKey: t.mountKey + 1, lastSeen: now };
        return t;
      }),
    });
  },

  /** Remove a tab; the neighbour on the right (else left) takes over. */
  close(id) {
    const { tabs, activeId, closed } = get();
    if (tabs.length <= 1) return null;
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const gone = tabs[i];
    const rest = tabs.filter((t) => t.id !== id);
    const nextActive = id === activeId ? (rest[i] || rest[i - 1]).id : activeId;
    set({
      tabs: rest,
      closed: [{ path: pathOf(gone.loc), title: gone.title, detail: gone.detail }, ...closed].slice(0, CLOSED_KEEP),
    });
    if (nextActive !== activeId) get().activate(nextActive);
    return nextActive;
  },

  move(id, toIndex) {
    const tabs = [...get().tabs];
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [t] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, t);
    set({ tabs });
  },

  patchLoc(id, loc) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, loc } : t)) });
  },

  setMeta(id, title, detail) {
    const t = get().tabs.find((x) => x.id === id);
    if (!t || (t.title === title && t.detail === detail)) return;
    set({ tabs: get().tabs.map((x) => (x.id === id ? { ...x, title, detail } : x)) });
  },

  /** Throw the screen away and draw it again (fresh data). */
  remount(id) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, mountKey: t.mountKey + 1 } : t)) });
  },

  markSeen(id, version) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, seenVersion: version } : t)) });
  },

  /** Put the least-recently-seen clean tabs to sleep beyond LIVE_LIMIT. */
  sleepExcess(isDirty) {
    const { tabs, activeId } = get();
    const live = tabs.filter((t) => !t.sleeping);
    if (live.length <= LIVE_LIMIT) return;
    const victims = live
      .filter((t) => t.id !== activeId && !isDirty(t.id))
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .slice(0, live.length - LIVE_LIMIT)
      .map((t) => t.id);
    if (!victims.length) return;
    set({ tabs: tabs.map((t) => (victims.includes(t.id) ? { ...t, sleeping: true } : t)) });
  },

  clearFlash() { if (get().flash) set({ flash: null }); },

  popClosed() {
    const [first, ...rest] = get().closed;
    if (!first) return null;
    set({ closed: rest });
    return first;
  },
}));

// Remember the open tabs for this login on this computer.
let saveTimer = null;
useTabStore.subscribe((s, prev) => {
  if (s.tabs === prev.tabs && s.activeId === prev.activeId) return;
  if (!s.scope || !s.tabs.length) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const k = storageKey();
    if (!k || currentScope() !== s.scope) return;
    const { tabs, activeId } = useTabStore.getState();
    try {
      localStorage.setItem(k, JSON.stringify({
        tabs: tabs.map((t) => ({ path: pathOf(t.loc), title: t.title, detail: t.detail })),
        active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
      }));
    } catch { /* storage full or blocked: tabs just won't come back */ }
  }, 400);
});

export const activeTab = () => {
  const { tabs, activeId } = useTabStore.getState();
  return tabs.find((t) => t.id === activeId) || null;
};

export default useTabStore;
