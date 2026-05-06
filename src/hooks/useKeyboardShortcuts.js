import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

export const SHORTCUTS_LIST = [
  { keys: 'Cmd/Ctrl + K', description: 'Open global search' },
  { keys: 'Alt + H', description: 'Home (Command Center)' },
  { keys: 'Alt + S', description: 'Sale (new customer invoice)' },
  { keys: 'Alt + P', description: 'Purchase (new supplier bill)' },
  { keys: 'Alt + D', description: 'Dashboard' },
  { keys: 'Alt + M', description: 'Payments' },
  { keys: 'Alt + C', description: 'Customers' },
  { keys: 'Alt + I', description: 'Inventory / Products' },
  { keys: 'Alt + R', description: 'Reports' },
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

  useEffect(() => {
    const handler = (e) => {
      // Skip if user is typing in a text field and not using Alt/Ctrl combos
      const tag = e.target.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;

      // Cmd/Ctrl + K — open the global search palette. Highest-priority
      // verb on the page, so it lives at the top of the handler before the
      // Alt block to avoid conflicting with any future Alt+K binding.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        window.dispatchEvent(new Event('global-search:open'));
        return;
      }

      if (e.altKey) {
        // Use e.code (the PHYSICAL key) instead of e.key — on macOS,
        // Option+S generates "ß", Option+P generates "π", etc.
        // e.code is "KeyS" / "KeyP" / "KeyD" regardless of the OS's
        // dead-key transformation, so it works the same on Mac and
        // Windows/Linux.
        switch (e.code) {
          case 'KeyH': e.preventDefault(); navigate('/'); break;
          case 'KeyS': e.preventDefault(); navigate('/sale/new'); break;
          case 'KeyP': e.preventDefault(); navigate('/purchase/new'); break;
          // Alt+D is Dashboard — / is now the Command Center (Home), so
          // the deep 9-tile dashboard moved to /dashboard.
          case 'KeyD': e.preventDefault(); navigate('/dashboard'); break;
          case 'KeyM': e.preventDefault(); navigate('/payments'); break;
          case 'KeyC': e.preventDefault(); navigate('/customers'); break;
          case 'KeyI': e.preventDefault(); navigate('/products'); break;
          // Alt+R lands on the Reports hub (catalog), not the legacy
          // /reports/sales register — matches the Home card.
          case 'KeyR': e.preventDefault(); navigate('/reports'); break;
        }
        return;
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

      // F6 / F7 — Receipt / Payment quick-create. These are GLOBAL
      // navigation shortcuts that match the Home Command Center cards.
      // F-keys fire even when focus is in an input (search box, party
      // picker, etc.) so the operator can press F6 from anywhere on
      // the page — no need to click out first. On pages that bind
      // F6 / F7 in their own ActionStrip (e.g. bill lists where F6
      // means "Receipt against this cursored bill"), the strip's
      // stopImmediatePropagation suppresses this listener so the
      // page-level handler wins.
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
  }, [navigate, onRefresh, onToggleHelp]);
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
