import React, { useEffect, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  UserOutlined, ShopOutlined, AppstoreOutlined,
  FolderOpenOutlined, BankOutlined,
} from '@ant-design/icons';
import { useNavGuard } from '../hooks/useUnsavedChangesWarning';
import './master-chooser.css';

/* ──────────────────────────────────────────────────────────────────────────
 * MasterChooser — Cmd / Ctrl + Shift + N from anywhere.
 *
 * Opens a small command-palette-style picker for the five master types
 * that get added most often: Customer · Supplier · Product · Category · Bank.
 *
 * Each option navigates to its list page with `?new=1` — the existing
 * convention every list page already reads to auto-open its F3 create-form
 * modal (PartyListView L114, ProductList L177, CategoryList L48, BankList
 * after this commit). So the chooser adds one new key + one new component
 * without duplicating a single form.
 *
 * Mounted once in App.jsx behind the auth gate. Listens for the
 * `'master-chooser:open'` window event dispatched from useKeyboardShortcuts.
 * Sibling pattern to GlobalSearchModal (same backdrop, same elevation, same
 * fade) — find existing thing (⌘K) and create new thing (⌘⇧N) read as the
 * two halves of one keyboard verb.
 * ──────────────────────────────────────────────────────────────────────── */

const OPTIONS = [
  { id: 'cust', letter: 'C', label: 'Customer', sub: 'Add a new customer record', icon: <UserOutlined />,        route: '/customers'  },
  { id: 'supp', letter: 'S', label: 'Supplier', sub: 'Add a new supplier record', icon: <ShopOutlined />,        route: '/suppliers'  },
  { id: 'prod', letter: 'P', label: 'Product',  sub: 'Add a new inventory item',  icon: <AppstoreOutlined />,    route: '/products'   },
  // Category uses "G" (for Group) — "C" is taken by Customer above.
  // Matches the common "Stock Group" naming, which Indian operators know.
  { id: 'cat',  letter: 'G', label: 'Category', sub: 'Add a product group',       icon: <FolderOpenOutlined />,  route: '/categories' },
  { id: 'bank', letter: 'B', label: 'Bank',     sub: 'Add a new bank account',    icon: <BankOutlined />,        route: '/banks'      },
];

export default function MasterChooser() {
  const [open, setOpen]     = useState(false);
  const [cursor, setCursor] = useState(0);
  const rawNavigate         = useNavigate();

  // Guarded navigate — bills with unsaved changes pop the discard modal
  // before we leave them. Matches every other in-app navigate; without
  // this a Cmd+Shift+N inside a half-typed Sale would silently lose work.
  const goCreate = useCallback((opt) => {
    setOpen(false);
    useNavGuard.getState().confirmLeave(() => {
      rawNavigate(`${opt.route}?new=1`);
    });
  }, [rawNavigate]);

  // Listen for the global trigger dispatched by the keyboard hook.
  useEffect(() => {
    const onOpen = () => { setCursor(0); setOpen(true); };
    window.addEventListener('master-chooser:open', onOpen);
    return () => window.removeEventListener('master-chooser:open', onOpen);
  }, []);

  // Keyboard while open: ↑↓ navigate, Enter pick, Esc close, direct letter.
  // Capture phase so we beat any page-level handlers (Sale bill form etc.).
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); setOpen(false); return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => (c + 1) % OPTIONS.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => (c - 1 + OPTIONS.length) % OPTIONS.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); goCreate(OPTIONS[cursor]); return;
      }
      // Direct letter shortcut — classic keyboard-driven, matches the MenuPopup pattern.
      // Ignore if a modifier is held (so Cmd+Shift+N itself, which keeps
      // firing as long as the chooser is open, doesn't re-fire navigation).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const letter = (e.key || '').toUpperCase();
      const direct = OPTIONS.find((o) => o.letter === letter);
      if (direct) {
        e.preventDefault(); goCreate(direct); return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, cursor, goCreate]);

  // Scroll-lock the body while the chooser is up — matches GlobalSearchModal
  // (line 628-632) so the page beneath can't scroll under the dim layer.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <div
      className="mc-backdrop"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="mc-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Create new master"
        aria-modal="true"
      >
        <div className="mc-head">
          <div>
            <div className="mc-title">Create new</div>
            <div className="mc-subtitle">Pick a master type — opens its quick-create form.</div>
          </div>
          <button
            type="button"
            className="mc-close"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >Esc</button>
        </div>

        <ul className="mc-list" role="menu">
          {OPTIONS.map((opt, i) => (
            <li
              key={opt.id}
              className={`mc-item${i === cursor ? ' is-cursor' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => goCreate(opt)}
              role="menuitem"
              aria-label={`Create ${opt.label}`}
            >
              <span className="mc-icon">{opt.icon}</span>
              <div className="mc-text">
                <div className="mc-label">{opt.label}</div>
                <div className="mc-sub">{opt.sub}</div>
              </div>
              <kbd className="mc-letter">{opt.letter}</kbd>
            </li>
          ))}
        </ul>

        <div className="mc-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>C S P G B</kbd> direct</span>
          <span className="mc-foot-spacer" />
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
