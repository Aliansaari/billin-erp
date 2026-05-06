import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
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

function MenuPopupBody({ title, items, onPick, onCancel }) {
  const [activeIdx, setActiveIdx] = useState(0);

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

  return (
    <div className="mp-backdrop" onMouseDown={onCancel}>
      <div className="mp-popup" onMouseDown={(e) => e.stopPropagation()} role="menu" aria-label={title}>
        <div className="mp-head">
          <span className="mp-title">{title}</span>
          <span className="mp-hint">Letter to pick · Esc to close</span>
        </div>
        <ul className="mp-list">
          {items.map((it, i) => (
            <li
              key={it.letter + ':' + (it.route || it.label)}
              className={`mp-item${i === activeIdx ? ' active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => onPick(it)}
              role="menuitem"
            >
              <span className="mp-letter">{it.letter}</span>
              <span className="mp-label">{labelWithUnderline(it.label, it.letter)}</span>
              {it.sub && <span className="mp-sub">{it.sub}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Render the label with the first occurrence of the chosen letter
// underlined (case-insensitive). Falls back to plain text if the
// letter doesn't appear in the label.
function labelWithUnderline(label, letter) {
  if (!letter) return label;
  const lower = label.toLowerCase();
  const idx = lower.indexOf(letter.toLowerCase());
  if (idx < 0) return label;
  return (
    <>
      {label.slice(0, idx)}
      <u>{label[idx]}</u>
      {label.slice(idx + 1)}
    </>
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
