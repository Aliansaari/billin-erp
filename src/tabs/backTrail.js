import { resolveBack, SECTION_ROOTS, HOME_PATH } from '../utils/escBack';

/* ── Esc puts you back where you opened the screen from ───────────────
 *
 * Each tab keeps a short trail of the screens that are "open" in it, one
 * on top of the other, like papers on a desk. Opening a screen from
 * another one puts it on top; Esc takes the top one off and shows the
 * one underneath — the screen you opened it from:
 *
 *   Home → New sale            Esc → Home        (not the Sales list)
 *   Products → Stock movement  Esc → Products    (not the Stock report)
 *   Dashboard → Sales report   Esc → Dashboard   (not the Reports hub)
 *   Bill → Customer ledger     Esc → the bill
 *
 * It never replays the session, which is what made the old browser-Back
 * design feel like a glitch:
 *   • a screen you closed is gone from the trail, so Esc never visits it
 *     again;
 *   • going to a screen already in the trail cuts the trail back to it,
 *     so the trail can't loop or grow without limit;
 *   • a screen that sends you up to its own parent (a bill saved → its
 *     list) closes itself on the way;
 *   • picking a section from the menu (Sales, Purchase, Reports …) starts
 *     a fresh trail — Esc from there goes Home;
 *   • moving between settings pages, or from one bill to the next, swaps
 *     the top paper instead of stacking another.
 *
 * With nothing underneath (a fresh tab, after a restart) Esc falls back to
 * one step up the menu tree (src/utils/escBack.js), ending at Home.
 * ────────────────────────────────────────────────────────────────── */

const MAX = 30;
const trails = new Map();      // tabId → [{ pathname, search, hash, state }]
const pendingBack = new Set(); // tabs whose next navigation is a Back

const keyOf = (id) => (id == null ? 'root' : id);
const shape = (p) => p.replace(/\/\d+(?=\/|$)/g, '/:id');
const isTop = (p) => p === HOME_PATH || SECTION_ROOTS.has(p);
const sameSlot = (a, b) => a === b
  || shape(a) === shape(b)
  || (a.startsWith('/settings/') && b.startsWith('/settings/'));
const slim = (loc) => ({ pathname: loc.pathname || '/', search: loc.search || '', hash: loc.hash || '', state: loc.state ?? null });

/**
 * Record a navigation in a tab.
 *   how: 'page'    — the screen itself opened something (link, button)
 *        'replace' — the screen swapped itself (redirect, filter in URL)
 *        'chrome'  — sidebar, menus, shortcuts, search, Home tiles
 */
export function noteNav(tabId, loc, how, fromLoc = null) {
  const k = keyOf(tabId);
  const p = loc.pathname || '/';
  let t = trails.get(k) || [];
  // First navigation in this tab: the screen it started on is underneath.
  if (!t.length && fromLoc) t = [slim(fromLoc)];
  const back = pendingBack.delete(k);
  const top = t[t.length - 1];

  if (!back && how === 'chrome' && isTop(p)) {
    t = [];
  } else if (top) {
    if (back || how === 'replace') t = t.slice(0, -1);
    else if (sameSlot(top.pathname, p)) t = t.slice(0, -1);
    // A screen sending you to its own parent closes itself on the way.
    else if (resolveBack(top.pathname) === p) t = t.slice(0, -1);
  }
  const i = t.findIndex((e) => e.pathname === p);
  if (i >= 0) t = t.slice(0, i);
  t.push(slim(loc));
  trails.set(k, t.slice(-MAX));
}

/**
 * Where Esc goes from `loc` in this tab: the screen underneath on the
 * trail, else one step up the tree. `null` at the top (Home).
 * `opener` says whether it came from the trail (the screen the user
 * opened this one from) rather than from the menu tree.
 */
export function backTarget(tabId, loc) {
  const p = loc.pathname || '/';
  const t = trails.get(keyOf(tabId)) || [];
  const top = t[t.length - 1];
  if (top && top.pathname === p && t.length >= 2) {
    return { ...t[t.length - 2], opener: true };
  }
  const up = resolveBack(p);
  if (up === p) return null;
  return { pathname: up, search: '', hash: '', state: null, opener: false };
}

/** The next navigation in this tab is a Back (pops the trail). */
export function markBack(tabId) { pendingBack.add(keyOf(tabId)); }

export function forgetTab(tabId) { trails.delete(keyOf(tabId)); pendingBack.delete(keyOf(tabId)); }

/* ── A page's own Back handler ────────────────────────────────────────
 * Most screens declare Back themselves (to confirm unsaved work first)
 * and navigate to a fixed parent: the Sale form goes to the Sales list.
 * ActionStrip arms this when it runs a page's Back; the tab's navigator
 * then sends that navigation to the screen the user came from instead,
 * if there is one. A drill-up inside the same screen (same path) is left
 * alone. The arm lasts until the next navigation or until the user does
 * something outside a confirm dialog (so a cancelled "Discard changes?"
 * can't redirect a later click). */
let armed = null; // { tab, from, at }
const OVERLAY = '.ant-modal-root, .ant-modal-wrap, .ant-popover, .ant-popconfirm, [role="dialog"], [role="alertdialog"]';

export function armBack(tabId, fromPath) {
  armed = { tab: keyOf(tabId), from: fromPath, at: Date.now() };
}

/** Called by the tab navigator: rewrite a page's Back destination. */
export function takeArmedBack(tabId, toPathname, currentLoc) {
  if (!armed || armed.tab !== keyOf(tabId)) return null;
  const a = armed;
  armed = null;
  if (Date.now() - a.at > 5 * 60 * 1000) return null;
  if (!currentLoc || currentLoc.pathname !== a.from) return null;
  if (toPathname === a.from) return null;           // drill-up inside the screen
  const tgt = backTarget(tabId, currentLoc);
  markBack(tabId);
  return tgt && tgt.opener ? tgt : { keep: true };
}

if (typeof window !== 'undefined') {
  const disarm = (e) => {
    if (!armed) return;
    const el = e.target;
    if (el && el.closest && el.closest(OVERLAY)) return;
    armed = null;
  };
  window.addEventListener('pointerdown', disarm, true);
  window.addEventListener('keydown', disarm, true);
}
