import { useEffect } from 'react';
import { create } from 'zustand';
import confirmDialog from '../utils/confirmDialog';
import { useTabId } from '../tabs/tabContext';
import useTabStore from '../tabs/tabStore';

const DEFAULT_MSG =
  "You have unsaved changes on this page. If you leave now, they will be lost.";

/**
 * Global nav guard. A form sets { dirty: true, message } while it has
 * unsaved work; the sidebar and Back buttons call confirmLeave(onConfirm)
 * which shows the shared themed confirm dialog and invokes onConfirm only
 * when the user deliberately chooses to discard.
 *
 * Keyboard-safe: Enter and Esc both KEEP editing (the safe choice).
 * Discarding requires an explicit click on the danger button, so a
 * reflexive keypress can never throw away a half-typed bill.
 */
export const useNavGuard = create((set, get) => ({
  // One guard per tab (key 'root' outside tabs): two open bills must not
  // overwrite or clear each other's unsaved state.
  guards: {},
  setGuard: (dirty, message, tabId = 'root') => set({ guards: { ...get().guards, [tabId]: { dirty, message: message || DEFAULT_MSG } } }),
  clearGuard: (tabId = 'root') => {
    if (!get().guards[tabId]) return;
    const guards = { ...get().guards }; delete guards[tabId]; set({ guards });
  },
  isDirty: (tabId) => !!get().guards[tabId]?.dirty,
  /** The guard of the screen on view. */
  current: () => {
    const g = get().guards;
    return g[useTabStore.getState().activeId] || g.root || { dirty: false, message: DEFAULT_MSG };
  },
  confirmLeave: (onConfirm) => {
    const { dirty, message } = get().current();
    if (!dirty) { onConfirm?.(); return; }
    confirmDialog({
      title: 'Discard unsaved changes?',
      message,
      confirmText: 'Discard & leave',
      cancelText:  'Keep editing',
      danger: true,
      safeDefault: true,
    }).then((discard) => { if (discard) onConfirm?.(); });
  },
}));

/**
 * Warn the user before closing/refreshing the tab when `dirty` is true.
 * Returns a helper — confirmLeave(onConfirm) — that in-form Back buttons
 * call to confirm navigation. The returned helper forwards to the shared
 * store so the sidebar and Back buttons share the same modal.
 *
 * Note: the tab-close/refresh prompt uses the browser's beforeunload API,
 * which browsers render with their own native dialog for security — that
 * one cannot be styled. Only in-app navigation uses the themed modal.
 */
export function useUnsavedChangesWarning(dirty, message = DEFAULT_MSG) {
  const tabId = useTabId() ?? 'root';
  useEffect(() => {
    useNavGuard.getState().setGuard(dirty, message, tabId);
    return () => useNavGuard.getState().clearGuard(tabId);
  }, [dirty, message, tabId]);

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

  return (onConfirm) => useNavGuard.getState().confirmLeave(onConfirm);
}
