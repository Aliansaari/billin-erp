import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMenuPopup } from '../components/keyboard/MenuPopup';
import { CTRL_DIRECT } from '../components/keyboard/menuCatalog';
import useFilteredAltMenus from './useFilteredAltMenus';

export const SHORTCUTS_LIST = [
  { keys: 'Cmd/Ctrl + K', description: 'Open global search' },
  { keys: 'Alt + G', description: 'Open global search' },
  { keys: 'Alt + H', description: 'Home menu' },
  { keys: 'Alt + S', description: 'Sales menu' },
  { keys: 'Alt + P', description: 'Purchase menu' },
  { keys: 'Alt + E', description: 'Parties menu' },
  { keys: 'Alt + I', description: 'Inventory menu' },
  { keys: 'Alt + M', description: 'Payments menu' },
  { keys: 'Alt + B', description: 'Bank menu' },
  { keys: 'Alt + A', description: 'Accounts menu' },
  { keys: 'Alt + R', description: 'Reports menu' },
  { keys: 'Alt + T', description: 'Settings menu' },
  { keys: 'Alt + D', description: 'Dashboard' },
  { keys: 'Ctrl + Alt + C', description: 'Manage Companies' },
  { keys: 'F9', description: 'Switch company' },
  { keys: 'Ctrl + S', description: 'New Sale (direct)' },
  { keys: 'Ctrl + P', description: 'New Purchase (direct)' },
  { keys: 'Ctrl + M', description: 'New Payment (direct)' },
  { keys: 'Ctrl + N', description: 'New Receipt (direct)' },
  { keys: 'Ctrl + H', description: 'Home (direct)' },
  { keys: 'Ctrl + D', description: 'Dashboard (direct)' },
  { keys: 'F6', description: 'Receipt (money in)' },
  { keys: 'F7', description: 'Payment (money out)' },
  { keys: 'Ctrl + Shift + ?', description: 'Show Shortcuts Help' },
  { keys: 'Escape', description: 'Close dialog / Cancel' },
  { keys: 'F5', description: 'Refresh data' },
  { keys: 'Enter', description: 'Move to next field (in forms)' },
  { keys: 'Ctrl + Enter', description: 'Save / Submit form' },
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

      // ── Alt + letter → open the Tally-style menu popup.
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

      // F6 / F7 — Receipt / Payment quick-create. These match the
      // Home Command Center's "money keys" cards. F-keys fire even
      // when focus is in an input (search box, party picker, etc.)
      // so the operator can press F6 from anywhere on the page. On
      // pages that bind F6 / F7 in their own ActionStrip (e.g. bill
      // lists where F6 = "Receipt against this cursored bill"), the
      // strip's stopImmediatePropagation suppresses this listener so
      // the page-level handler wins.
      if (e.key === 'F6' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        navigate('/receipt/new');
        return;
      }
      if (e.key === 'F7' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        navigate('/payment/new');
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
