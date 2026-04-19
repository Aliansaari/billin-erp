import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Global nav guard — a form sets { dirty: true, message } while it has
 * unsaved work. Sidebar / any app-level navigator reads and confirms
 * before switching routes.
 */
export const useNavGuard = create((set) => ({
  dirty: false,
  message: 'You have unsaved changes. Leave this page anyway?',
  setGuard: (dirty, message) => set({ dirty, message: message || 'You have unsaved changes. Leave this page anyway?' }),
  clearGuard: () => set({ dirty: false }),
  confirmLeave: () => {
    const { dirty, message } = useNavGuard.getState();
    return !dirty || window.confirm(message);
  },
}));

/**
 * Warn the user before closing/refreshing the tab OR navigating via the
 * app sidebar/menu when `dirty` is true. Returns a helper that in-form
 * navigation handlers (Back buttons) can call directly.
 */
export function useUnsavedChangesWarning(dirty, message = 'You have unsaved changes. Leave this page anyway?') {
  // Register with the global guard so sidebar navigation can check.
  useEffect(() => {
    useNavGuard.getState().setGuard(dirty, message);
    return () => useNavGuard.getState().clearGuard();
  }, [dirty, message]);

  // Browser-level (tab close/refresh).
  useEffect(() => {
    if (!dirty) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = message;
      return message;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, message]);

  return () => !dirty || window.confirm(message);
}
