import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

export const SHORTCUTS_LIST = [
  { keys: 'Alt + S', description: 'New Sales Bill' },
  { keys: 'Alt + P', description: 'New Purchase Bill' },
  { keys: 'Alt + D', description: 'Dashboard' },
  { keys: 'Alt + M', description: 'Payments' },
  { keys: 'Alt + C', description: 'Customers' },
  { keys: 'Alt + I', description: 'Inventory / Products' },
  { keys: 'Alt + R', description: 'Reports' },
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

      if (e.altKey) {
        switch (e.key.toLowerCase()) {
          case 's': e.preventDefault(); navigate('/sale/new'); break;
          case 'p': e.preventDefault(); navigate('/purchase/new'); break;
          case 'd': e.preventDefault(); navigate('/'); break;
          case 'm': e.preventDefault(); navigate('/payments'); break;
          case 'c': e.preventDefault(); navigate('/customers'); break;
          case 'i': e.preventDefault(); navigate('/products'); break;
          case 'r': e.preventDefault(); navigate('/reports/sales'); break;
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
