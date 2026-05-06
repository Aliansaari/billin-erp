import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useLocation } from 'react-router-dom';
import { getRouteIcon } from '../Layout/menuConfig';
import './MenuPopup.css';

// ── Tally-style Alt-letter menu popup ──────────────────────────────
//
// Press Alt+S → this opens, listing the Sales sub-items (Sale ·
// Sales List · New Sales Return · Sales Returns). Each item carries
// an UNDERLINED letter; pressing that letter picks the item. Arrow
// keys navigate; Enter picks the highlighted row; Esc closes. Same
// model as Tally Prime's classic menu.
//
// Mounted once at the app root via MenuPopupProvider; pages don't
// render anything themselves. The provider is kept independent of
// the DatePopup provider so they nest cleanly when both are open.
//
//   const { openMenu } = useMenuPopup();
//   openMenu({
//     title: 'Sales',
//     items: [
//       { letter: 'S', label: 'Sale',         sub: 'New customer invoice', route: '/sale/new' },
//       { letter: 'L', label: 'Sales List',   sub: 'All customer bills',   route: '/sales' },
//       …
//     ],
//     onPick: (item) => navigate(item.route),
//   });

// Resolve the on-screen position for a popup anchored to a top-level
// nav item (Sidebar collapsed icon, Sidebar expanded Antd Menu, or
// TopNav pill). Walks the DOM in order of preference:
//   1. Custom data-shortcut-key attribute we add on Sidebar
//      CollapsedItem and TopNav pills.
//   2. Antd Menu's auto-generated data-menu-id="...-sales-menu"
//      attribute on the inline submenu (expanded sidebar).
// Returns { left, top } in viewport coordinates, or null if no anchor
// is found — caller falls back to the centered layout.
function findAnchorRect(anchorKey) {
  if (!anchorKey || typeof document === 'undefined') return null;
  const explicit = document.querySelector(`[data-shortcut-key="${CSS.escape(anchorKey)}"]`);
  if (explicit) return explicit.getBoundingClientRect();
  // Antd-generated id ends with "-{key}". CSS attribute substring match.
  const antd = document.querySelector(`[data-menu-id$="-${CSS.escape(anchorKey)}"]`);
  if (antd) return antd.getBoundingClientRect();
  return null;
}

function MenuPopupBody({ title, items, anchorKey, onPick, onCancel }) {
  const { pathname } = useLocation();

  // Which item matches the current route — used both for the bold
  // "you are here" label and to pre-position the cursor so opening
  // the menu while on /sales lands on Sales List, ready to confirm
  // with Enter or move with arrow keys.
  const currentIdx = useMemo(() => {
    const exact = items.findIndex((it) => it.route === pathname);
    if (exact >= 0) return exact;
    return items.findIndex((it) => it.route && pathname.startsWith(it.route + '/'));
  }, [items, pathname]);

  const [activeIdx, setActiveIdx] = useState(currentIdx >= 0 ? currentIdx : 0);
  const popupRef = useRef(null);

  // Compute popup position once on mount (and on window resize).
  // TopNav pills live in the ~55px-tall top bar, so the popup drops
  // BELOW them; sidebar items hug the LEFT edge, so the popup unfolds
  // to the RIGHT. Use anchor.top first (topnav check) so left-edge
  // topnav pills like Home/Dashboard don't get mistaken for sidebar
  // items just because their x is small. Clamp so the popup never
  // clips off-screen.
  const [pos, setPos] = useState(() => null);
  useEffect(() => {
    const compute = () => {
      const anchor = findAnchorRect(anchorKey);
      if (!anchor) { setPos(null); return; }
      const popupW = popupRef.current?.offsetWidth || 320;
      const popupH = popupRef.current?.offsetHeight || 280;
      const margin = 6;
      const inTopBar = anchor.top < 80;
      const onLeftEdge = !inTopBar && anchor.left < 200;
      let left, top;
      if (inTopBar) {
        // TopNav — drop below, left-aligned with the pill.
        left = anchor.left;
        top  = anchor.bottom + margin;
      } else if (onLeftEdge) {
        // Sidebar — unfold to the right, top-aligned with the icon.
        left = anchor.right + margin;
        top  = anchor.top;
      } else {
        // Anything else — drop below.
        left = anchor.left;
        top  = anchor.bottom + margin;
      }
      // Clamp to viewport (8px gutter).
      left = Math.max(8, Math.min(left, window.innerWidth  - popupW - 8));
      top  = Math.max(8, Math.min(top,  window.innerHeight - popupH - 8));
      setPos({ left, top });
    };
    compute();
    // Re-measure after first paint when the popup has actual dimensions.
    const r = requestAnimationFrame(compute);
    window.addEventListener('resize', compute);
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener('resize', compute);
    };
  }, [anchorKey]);

  // Click-outside / Esc / Enter / letter shortcuts. Capture phase so
  // we run BEFORE any other window keydown listener (e.g. the global
  // shortcut hook that opened us in the first place would otherwise
  // re-fire and stack-open menus). stopImmediatePropagation kills
  // any other capture-phase listener attached after us.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onCancel();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const it = items[activeIdx];
        if (it) onPick(it);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setActiveIdx((i) => Math.min(i + 1, items.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setActiveIdx(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setActiveIdx(items.length - 1);
        return;
      }

      // Letter shortcuts — match the underlined letter on each item.
      // Match against e.code (KeyS / KeyL / etc.) so it works the
      // same on macOS where Alt is a dead key — but the menu has
      // already eaten the modifier; here we just look at single-key
      // presses without modifiers. e.key works fine for the no-Alt
      // case. We also accept Alt+letter for users who keep holding
      // Alt while pressing the sub-letter (like Tally).
      if (!e.ctrlKey && !e.metaKey) {
        // Strip the Alt-dead-key transformation: prefer e.code
        // ("KeyS") which is identical regardless of Option/Alt.
        const codeLetter = /^Key([A-Z])$/.exec(e.code)?.[1];
        const ch = (codeLetter || e.key).toUpperCase();
        if (ch.length === 1 && /[A-Z]/.test(ch)) {
          const idx = items.findIndex((it) => it.letter?.toUpperCase() === ch);
          if (idx >= 0) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            onPick(items[idx]);
            return;
          }
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  // When the menu opens, we WANT to keep focus on the document so
  // letter shortcuts fire from window. Don't focus into any item; the
  // capture-phase listener handles everything.

  // Anchored mode (positioned next to a sidebar/topnav item) uses
  // absolute coords; fallback (no anchor found) uses the original
  // centered overlay positioning via .mp-backdrop's flex layout.
  const popupStyle = pos ? { position: 'fixed', left: pos.left, top: pos.top } : undefined;

  return (
    <div className={`mp-backdrop${pos ? ' anchored' : ''}`} onMouseDown={onCancel}>
      <div ref={popupRef} className="mp-popup" style={popupStyle} onMouseDown={(e) => e.stopPropagation()} role="menu" aria-label={title}>
        <div className="mp-head">
          <span className="mp-title">{title}</span>
          <span className="mp-hint">Esc</span>
        </div>
        <ul className="mp-list">
          {items.map((it, i) => {
            const isCurrent = i === currentIdx;
            return (
              <li
                key={it.letter + ':' + (it.route || it.label)}
                className={`mp-item${i === activeIdx ? ' active' : ''}${isCurrent ? ' is-current' : ''}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => onPick(it)}
                role="menuitem"
                aria-current={isCurrent ? 'page' : undefined}
              >
                <span className="mp-icon">{getRouteIcon(it.route)}</span>
                <span className="mp-label">{it.label}</span>
                {it.letter && <span className="mp-shortcut">{it.letter}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ── Provider + hook ───────────────────────────────────────────────
const MenuPopupContext = createContext(null);

export function MenuPopupProvider({ children }) {
  const [state, setState] = useState({ open: false, opts: null });

  const openMenu = useCallback((opts) => {
    setState({ open: true, opts });
  }, []);
  const closeMenu = useCallback(() => {
    setState({ open: false, opts: null });
  }, []);

  const handlePick = useCallback((item) => {
    const opts = state.opts;
    closeMenu();
    try { opts?.onPick?.(item); }
    catch (err) { console.error('[MenuPopup]', err); }
  }, [state.opts, closeMenu]);
  const handleCancel = useCallback(() => {
    const opts = state.opts;
    closeMenu();
    try { opts?.onCancel?.(); }
    catch (err) { console.error('[MenuPopup]', err); }
  }, [state.opts, closeMenu]);

  const node = !state.open ? null : ReactDOM.createPortal(
    <MenuPopupBody
      title={state.opts?.title}
      items={state.opts?.items || []}
      anchorKey={state.opts?.anchorKey}
      onPick={handlePick}
      onCancel={handleCancel}
    />,
    document.body,
  );

  return (
    <MenuPopupContext.Provider value={{ openMenu, closeMenu, isOpen: state.open }}>
      {children}
      {node}
    </MenuPopupContext.Provider>
  );
}

export function useMenuPopup() {
  const ctx = useContext(MenuPopupContext);
  if (!ctx) {
    return {
      openMenu: () => console.warn('[MenuPopup] no provider'),
      closeMenu: () => {},
      isOpen: false,
    };
  }
  return ctx;
}
