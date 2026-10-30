import { message } from 'antd';
import useTabStore, { MAX_TABS, pathOf, toLocation } from './tabStore';
import { useNavGuard } from '../hooks/useUnsavedChangesWarning';
import { flushTabBill, tabOfDraft } from '../hooks/useBillAutosave';
import confirmDialog from '../utils/confirmDialog';

/*
 * Everything that opens, switches or closes a tab goes through here, so the
 * sidebar, the keyboard, the search palette and the tab strip all behave
 * the same way.
 *
 * The visible tab mirrors the real URL; switching tabs replaces the URL
 * (it never grows history), and TabHost copies any outside navigation into
 * the visible tab.
 */

let rootNavigate = null;      // the app router's navigate, bound by TabHost
let switching = false;        // a switch is moving the URL: don't copy it back

export const bindTabNavigate = (fn) => { rootNavigate = fn; };
export const isSwitching = () => switching;

/** Show tab `id`. */
export function switchTo(id) {
  const st = useTabStore.getState();
  const t = st.tabs.find((x) => x.id === id);
  if (!t || id === st.activeId) return;
  switching = true;
  st.activate(id);
  rootNavigate?.(pathOf(t.loc), { replace: true, state: t.loc.state });
  switching = false;
  st.sleepExcess((tid) => useNavGuard.getState().isDirty(tid));
}

const tooMany = () => message.warning({ content: `${MAX_TABS} tabs are open. Close one to open another.`, key: 'tabs-max' });

/** Open `to` in a new tab next to the current one. Returns the id or null. */
export function openTab(to, { activate = true, state = null } = {}) {
  const st = useTabStore.getState();
  if (st.tabs.length >= MAX_TABS) { tooMany(); return null; }
  const id = st.open(to, { activate: false, state });
  if (id && activate) switchTo(id);
  return id;
}

/** A new tab on Home (Ctrl+T). Home puts the cursor on its search card. */
export function newTab() {
  openTab('/');
}

export function nextTab(step) {
  const { tabs, activeId } = useTabStore.getState();
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  switchTo(tabs[(i + step + tabs.length) % tabs.length].id);
}

export function tabAt(n) {
  const { tabs } = useTabStore.getState();
  const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
  if (t) switchTo(t.id);
}

/**
 * Close a tab. A tab with unsaved work asks first; a bill is written to
 * Drafts before its tab goes, so closing never loses it.
 */
export async function requestClose(id) {
  const st = useTabStore.getState();
  if (st.tabs.length <= 1 || !st.tabs.some((t) => t.id === id)) return false;
  const guard = useNavGuard.getState().guards[id];
  if (guard?.dirty) {
    if (id !== st.activeId) switchTo(id);
    const t = useTabStore.getState().tabs.find((x) => x.id === id);
    const isBill = /^\/(sale|purchase)\/new/.test(t?.loc.pathname || '');
    const ok = await confirmDialog(isBill ? {
      title: 'Close this bill?',
      message: 'It stays in Drafts, so you can finish it later from the Drafts list.',
      confirmText: 'Close tab',
      cancelText: 'Keep open',
    } : {
      title: 'Discard unsaved changes?',
      message: guard.message,
      confirmText: 'Discard & close',
      cancelText: 'Keep editing',
      danger: true,
      safeDefault: true,
    });
    if (!ok) return false;
    if (isBill) await flushTabBill(id);
  }
  const before = useTabStore.getState().activeId;
  const next = useTabStore.getState().close(id);
  if (next && next !== before) {
    const t = useTabStore.getState().tabs.find((x) => x.id === next);
    switching = true;
    rootNavigate?.(pathOf(t.loc), { replace: true, state: t.loc.state });
    switching = false;
  }
  return true;
}

export const closeCurrent = () => requestClose(useTabStore.getState().activeId);

/** Close several tabs one by one (each may ask). */
export async function closeMany(ids) {
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await requestClose(id))) break;
  }
}

export function reopenClosed() {
  const c = useTabStore.getState().popClosed();
  if (c) openTab(c.path);
}

export function duplicateTab(id) {
  const t = useTabStore.getState().tabs.find((x) => x.id === id);
  if (t) openTab(pathOf(t.loc));
}

/* ── "Open in a new tab" intent ───────────────────────────────────────
 * Ctrl+click, middle-click or the right-click menu on a menu entry asks
 * for a new tab. The click handler then calls chromeNavigate, which reads
 * the intent. It lives for one click only. */
let intent = null;
export function setNewTabIntent(foreground) {
  intent = { foreground };
  setTimeout(() => { intent = null; }, 0);
}
const takeIntent = () => { const i = intent; intent = null; return i; };
/** Is the click being handled right now asking for a new tab? */
export const isNewTabClick = () => !!intent;

/** Menu entries that can open in a new tab (Ctrl+click / middle / right-click). */
export const TAB_LINK_SELECTOR = [
  '[data-tab-link]',
  '.erp-sidebar li.ant-menu-item',
  '.erp-topnav li.ant-menu-item',
  '.ant-menu-submenu-popup li.ant-menu-item',
  '.mp-item',
  '.cc-action',
].join(', ');

if (typeof window !== 'undefined') {
  window.addEventListener('click', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.target.closest?.(TAB_LINK_SELECTOR)) setNewTabIntent(e.shiftKey);
  }, true);
  // Middle-click: stop the autoscroll cursor, then click with intent.
  window.addEventListener('mousedown', (e) => {
    if (e.button === 1 && e.target.closest?.(TAB_LINK_SELECTOR)) e.preventDefault();
  }, true);
  window.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const el = e.target.closest?.(TAB_LINK_SELECTOR);
    if (!el) return;
    e.preventDefault();
    setNewTabIntent(false);
    el.click();
  }, true);
}

/**
 * Navigation from the app's chrome (sidebar, top menu, Alt menus, Ctrl+
 * shortcuts, search palette, Home tiles):
 *   • asked for a new tab  → open it (Ctrl+click: behind; Ctrl+Shift: in front)
 *   • screen has unsaved work → keep it, open the destination in a new tab
 *   • otherwise             → go there in this tab, as before
 */
export function chromeNavigate(to, opts = {}, navigate = rootNavigate) {
  const want = takeIntent();
  const st = useTabStore.getState();
  if (want && st.tabs.length) {
    openTab(to, { activate: want.foreground, state: opts.state || null });
    return 'tab';
  }
  const { dirty } = useNavGuard.getState().current();
  if (dirty && st.tabs.length) {
    const target = toLocation(to);
    const same = st.tabs.find((t) => t.id !== st.activeId && pathOf(t.loc) === pathOf(target)
      && !useNavGuard.getState().isDirty(t.id));
    if (same) { switchTo(same.id); return 'tab'; }
    if (st.tabs.length < MAX_TABS) {
      openTab(to, { state: opts.state || null });
      message.info({ content: 'Your unsaved screen stays open in its own tab.', key: 'tabs-kept', duration: 2.5 });
      return 'tab';
    }
    useNavGuard.getState().confirmLeave(() => navigate?.(to, opts));
    return 'here';
  }
  navigate?.(to, opts);
  return 'here';
}

/**
 * A held bill can be open in one tab only. If `draftId` is open in another
 * tab, bring that tab forward and return true.
 */
export function showDraftIfOpenElsewhere(draftId, hereTabId) {
  const there = tabOfDraft(draftId);
  if (there == null || there === (hereTabId ?? 'root') || !useTabStore.getState().tabs.some((t) => t.id === there)) return false;
  switchTo(there);
  message.info({ content: 'That bill is already open in this tab.', key: 'tabs-draft-open', duration: 2.5 });
  return true;
}
