import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMenuPopup } from '../components/keyboard/MenuPopup';
import { CTRL_DIRECT } from '../components/keyboard/menuCatalog';
import useFilteredAltMenus from './useFilteredAltMenus';

/* Master cheat-sheet — every keyboard shortcut + every F-key action strip
 * surface the operator can reach. Categorised so the help overlay can
 * group them; flat array stays the source of truth so search/filter is
 * trivial.
 *
 * Adding a shortcut? Add the row here with the correct `category` and a
 * one-line `description`. The overlay (App.jsx → ShortcutsOverlay) reads
 * this list directly — no separate registration step.
 */
export const SHORTCUTS_LIST = [
  // ── Global ─────────────────────────────────────────────────────────────
  { category: 'Global',     keys: 'Alt + G',              description: 'Open global search palette',
    note: 'Cmd+K / Ctrl+K also work — Alt+G is the cross-platform display key' },
  { category: 'Global',     keys: 'Cmd/Ctrl + Shift + N', description: 'Open Master Chooser (Customer · Supplier · Product · Category · Bank)' },
  { category: 'Global',     keys: 'Cmd/Ctrl + Shift + ?', description: 'Show this keyboard cheat-sheet' },
  { category: 'Global',     keys: 'Escape',               description: 'Close modal · cancel · clear search · else step back toward Home' },
  { category: 'Global',     keys: 'F5',                   description: 'Refresh the current page / list' },
  { category: 'Global',     keys: 'F9',                   description: 'Open company switcher' },

  // ── Top-level navigation (Alt + letter → menu popup) ───────────────────
  { category: 'Navigation', keys: 'Alt + H',              description: 'Home' },
  { category: 'Navigation', keys: 'Alt + D',              description: 'Dashboard' },
  { category: 'Navigation', keys: 'Alt + S',              description: 'Sales menu' },
  { category: 'Navigation', keys: 'Alt + P',              description: 'Purchase menu' },
  { category: 'Navigation', keys: 'Alt + E',              description: 'Parties menu (customers · suppliers)' },
  { category: 'Navigation', keys: 'Alt + I',              description: 'Inventory menu' },
  { category: 'Navigation', keys: 'Alt + B',              description: 'Bank menu (banks · loans · reconcile)' },
  { category: 'Navigation', keys: 'Alt + A',              description: 'Books menu (journals · ledgers · audit)' },
  { category: 'Navigation', keys: 'Alt + R',              description: 'Reports hub' },
  { category: 'Navigation', keys: 'Alt + T',              description: 'Settings (direct)' },
  { category: 'Navigation', keys: 'Cmd/Ctrl + Alt + C',   description: 'Manage Companies' },

  // ── Quick create (Ctrl + letter → one-keystroke jump) ─────────────────
  { category: 'Quick create', keys: 'Ctrl + S',           description: 'New Sale bill' },
  { category: 'Quick create', keys: 'Ctrl + P',           description: 'New Purchase bill' },
  { category: 'Quick create', keys: 'Ctrl + M',           description: 'New Payment (money out)' },
  { category: 'Quick create', keys: 'Ctrl + N',           description: 'New Receipt (money in)' },
  { category: 'Quick create', keys: 'Ctrl + H',           description: 'Home (direct)' },
  { category: 'Quick create', keys: 'Ctrl + D',           description: 'Dashboard (direct)' },
  { category: 'Quick create', keys: 'F6',                 description: 'New Receipt — alternate' },
  { category: 'Quick create', keys: 'F7',                 description: 'New Payment — alternate' },

  // ── Bill form (sale / purchase / return entry) ────────────────────────
  { category: 'Bill form',  keys: 'F1',                   description: 'Save (with optional print prompt)' },
  { category: 'Bill form',  keys: 'Ctrl + Enter',         description: 'Save — alias for F1' },
  { category: 'Bill form',  keys: 'F2',                   description: 'Open Date picker (classic accounting-style smart input)' },
  { category: 'Bill form',  keys: 'F3',                   description: 'Toggle focus between Barcode and Items table' },
  { category: 'Bill form',  keys: 'F4',                   description: 'Hold bill (save as draft, resume later)' },
  { category: 'Bill form',  keys: 'F5',                   description: 'Reset form to a blank bill' },
  { category: 'Bill form',  keys: 'F6',                   description: 'Pay — collect money for this bill' },
  { category: 'Bill form',  keys: 'F7',                   description: 'Convert to Return / credit note' },
  { category: 'Bill form',  keys: 'Enter',                description: 'Move to next field (form-wide)' },
  { category: 'Bill form',  keys: 'Escape',               description: 'Back without saving (prompts if dirty)' },

  // ── List pages (action strip at the bottom) ───────────────────────────
  { category: 'List page',  keys: 'F1',                   description: 'Open the selected row' },
  { category: 'List page',  keys: 'F2',                   description: 'Edit the selected row' },
  { category: 'List page',  keys: 'F3',                   description: 'New row — context-aware (New Sale on Sales list, New Product on Products list, …)' },
  { category: 'List page',  keys: 'F4',                   description: 'Find (focus the search input)' },
  { category: 'List page',  keys: 'F5',                   description: 'Refresh the list' },
  { category: 'List page',  keys: 'F8',                   description: 'Cancel / deactivate the selected row' },
  { category: 'List page',  keys: 'F9',                   description: 'Print (sales / purchase / return lists)' },
  { category: 'List page',  keys: 'F10',                  description: 'Export PDF' },
  { category: 'List page',  keys: 'Esc',                  description: 'Back — up one level; from a list it lands on Home' },
  { category: 'List page',  keys: '↑ / ↓',                description: 'Move cursor between rows' },

  // ── Global search palette (⌘K / Alt+G) ────────────────────────────────
  { category: 'Search palette', keys: '/c',               description: 'Scope to Customers' },
  { category: 'Search palette', keys: '/s',               description: 'Scope to Suppliers' },
  { category: 'Search palette', keys: '/p',               description: 'Scope to Products' },
  { category: 'Search palette', keys: '/l',               description: 'Scope to Ledgers' },
  { category: 'Search palette', keys: '/r',               description: 'Scope to Reports' },
  { category: 'Search palette', keys: '/a',               description: 'Scope to Actions / commands' },
  { category: 'Search palette', keys: '↑ / ↓',            description: 'Move highlight through results' },
  { category: 'Search palette', keys: '↵',                description: 'Open the highlighted row' },
  { category: 'Search palette', keys: 'Cmd/Ctrl + ↵',     description: 'Open the highlighted row in a new window' },
  { category: 'Search palette', keys: 'Cmd/Ctrl + B',     description: 'Pin / unpin the highlighted row' },

  // ── Master chooser (Cmd/Ctrl + Shift + N) ─────────────────────────────
  { category: 'Master chooser', keys: 'C',                description: 'New Customer' },
  { category: 'Master chooser', keys: 'S',                description: 'New Supplier' },
  { category: 'Master chooser', keys: 'P',                description: 'New Product' },
  { category: 'Master chooser', keys: 'G',                description: 'New Category (Group)' },
  { category: 'Master chooser', keys: 'B',                description: 'New Bank' },
];

/* Ordered category list for the overlay. Categories not in this list
   render at the bottom in alphabetical order — defensive so a new
   category in SHORTCUTS_LIST never accidentally disappears from the
   help overlay if someone forgets to update this constant. */
export const SHORTCUTS_CATEGORIES = [
  'Global',
  'Navigation',
  'Quick create',
  'Bill form',
  'List page',
  'Search palette',
  'Master chooser',
];

export function useGlobalShortcuts({ onRefresh, onToggleHelp } = {}) {
  const navigate = useNavigate();
  const { openMenu } = useMenuPopup();
  // Use the filtered version so Alt+A → I (Ledger Integrity) etc.
  // respect the developer-tier toggles. Without filtering here, the
  // sidebar would hide an entry but the keyboard shortcut would still
  // jump to it.
  const altMenus = useFilteredAltMenus();

  useEffect(() => {
    const handler = (e) => {
      // Cmd/Ctrl + K — open the global search palette. Highest-priority
      // verb on the page, so it lives at the top of the handler before
      // the Alt / Ctrl letter blocks to avoid conflicting.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        window.dispatchEvent(new Event('global-search:open'));
        return;
      }

      // Cmd/Ctrl + Shift + N — open the master chooser. Opens a small
      // modal listing the 5 master types you add most often (Customer,
      // Supplier, Product, Category, Bank). Pick one → navigates to its
      // list with ?new=1 which every list page already reads to auto-
      // open its F3 form modal. Sits next to ⌘K in the keyboard layer
      // because the two palettes are siblings — find existing thing
      // vs. create new thing. Uses e.code so it survives macOS dead-key
      // transformations on Option-modified keys.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        window.dispatchEvent(new Event('master-chooser:open'));
        return;
      }

      // Alt + G — alternate trigger for the global search palette.
      // Pinned to G for "Global" so it's discoverable via the help
      // overlay alongside Cmd/Ctrl+K. Handled before the ALT_MENUS
      // lookup so it can't be accidentally swallowed by a future
      // section that starts with G.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyG') {
        e.preventDefault();
        window.dispatchEvent(new Event('global-search:open'));
        return;
      }

      // Ctrl + Alt + C — open the company switcher / Manage Companies.
      // The chord is rare enough not to clash with anything else; "C"
      // for Company. Alt is on the chord so a single Ctrl+C stays as
      // copy. Routes to /settings/companies which holds the full
      // switcher + manage UI.
      if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.code === 'KeyC') {
        e.preventDefault();
        navigate('/settings/companies');
        return;
      }

      // F9 — single-key shortcut for switching company. Alone on its row
      // (F5/F6/F7 are taken by refresh/receipt/payment), so muscle
      // memory doesn't clash. No modifiers required, fires from
      // anywhere except active text inputs (the keydown listener for
      // form fields runs after this so a user typing in a textarea
      // still gets the F-keys).
      //
      // Behaviour: dispatch a window event the topbar CompanySwitcher
      // listens for to open its dropdown in place. If no switcher is
      // currently mounted (e.g. only one company exists, the component
      // returns null), nothing happens — that's correct, there's
      // nothing to switch to.
      if (e.key === 'F9' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('company-switcher:open'));
          return;
        }
      }

      // ── Alt + letter → open the classic keyboard menu popup.
      // Uses e.code (the PHYSICAL key) instead of e.key because macOS
      // Option is a dead key (Option+S generates "ß", Option+P → "π",
      // Option+D → "∂"). e.code is "KeyS" / "KeyP" / "KeyD" regardless
      // of the OS's transformation.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const menu = altMenus[e.code];
        if (menu) {
          e.preventDefault();
          // Single-item menus (Alt+H / Alt+D) skip the popup and just
          // navigate — opening a menu with one option would be friction.
          if (menu.items.length === 1) {
            navigate(menu.items[0].route);
          } else {
            openMenu({
              title: menu.title,
              items: menu.items,
              anchorKey: menu.anchorKey,
              onPick: (it) => navigate(it.route),
            });
          }
          return;
        }
      }

      // ── Ctrl + letter → direct jump to the most-common action of
      // each section. No popup, no extra keystroke. Use e.code so
      // macOS's Cmd key behaves identically to Ctrl on Win/Linux.
      // (Note: Ctrl+R is browser reload — intentionally NOT in the
      // catalog; user gets Alt+R for the menu instead.)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const route = CTRL_DIRECT[e.code];
        if (route) {
          e.preventDefault();
          navigate(route);
          return;
        }
      }

      if (e.ctrlKey && e.shiftKey && e.key === '?') {
        e.preventDefault();
        onToggleHelp?.();
        return;
      }

      if (e.key === 'Escape') {
        onToggleHelp?.(false);
        return;
      }

      if (e.key === 'F5') {
        e.preventDefault();
        onRefresh?.();
        return;
      }

      // F6 / F7 — Receipt / Payment quick-create from anywhere. BUT a
      // page's ActionStrip may declare the same key (the Sales/Purchase
      // lists bind F6 = Payment/Receipt vs the cursored bill, F7 =
      // Barcodes / WhatsApp). This global listener is registered at app
      // mount — BEFORE any page strip — so it runs first, which means
      // the strip's stopImmediatePropagation can't retroactively cancel
      // it. So instead of navigating now, defer one macrotask and only
      // navigate if nothing consumed the key. ActionStrip calls
      // preventDefault when it claims a key (even a disabled action is a
      // deliberate no-op), so e.defaultPrevented tells us the page owns
      // it. Without this, F7 on the Purchase list opened Payment.
      if (e.key === 'F6' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setTimeout(() => { if (!e.defaultPrevented) navigate('/receipt/new'); }, 0);
        return;
      }
      if (e.key === 'F7' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setTimeout(() => { if (!e.defaultPrevented) navigate('/payment/new'); }, 0);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, onRefresh, onToggleHelp, openMenu, altMenus]);
}

export function useEnterNavigation(containerRef, onLastField) {
  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;

    const handler = (e) => {
      if (e.key !== 'Enter') return;

      const tag = e.target.tagName;
      // Don't intercept Enter on buttons or textareas
      if (tag === 'BUTTON' || tag === 'TEXTAREA') return;
      // Don't intercept if Ctrl is held (Ctrl+Enter = submit)
      if (e.ctrlKey || e.metaKey) return;

      e.preventDefault();

      // Get all focusable elements inside container
      const focusable = Array.from(container.querySelectorAll(
        'input:not([disabled]):not([readonly]):not([type="hidden"]), ' +
        '.ant-select:not(.ant-select-disabled) .ant-select-selection-search-input, ' +
        '.ant-input-number-input:not([disabled]), ' +
        '.ant-picker-input input:not([disabled])'
      ));

      const currentIndex = focusable.indexOf(e.target);

      if (currentIndex === -1) return;

      if (currentIndex === focusable.length - 1) {
        // Last field - trigger callback (e.g. add item)
        onLastField?.();
      } else {
        // Move to next field
        const next = focusable[currentIndex + 1];
        if (next) {
          next.focus();
          if (next.select) next.select();
        }
      }
    };

    container.addEventListener('keydown', handler);
    return () => container.removeEventListener('keydown', handler);
  }, [containerRef, onLastField]);
}

// Hook to handle Ctrl+Enter for form submission
export function useCtrlEnterSubmit(callback) {
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        callback?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [callback]);
}

export default useGlobalShortcuts;
