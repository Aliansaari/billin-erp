import { createElement, useEffect } from 'react';
import { create } from 'zustand';
import { Modal } from 'antd';
import { ExclamationCircleFilled } from '@ant-design/icons';

/**
 * Global nav guard. A form sets { dirty: true, message } while it has
 * unsaved work; the sidebar and Back buttons call confirmLeave(onConfirm)
 * which shows an AntD-themed modal and invokes onConfirm when the user
 * chooses to discard.
 *
 * API is callback-based (not a sync boolean) because the AntD modal is
 * async — the old window.confirm() blocked the JS thread and returned a
 * boolean, but that's the system popup the user wanted replaced.
 */
export const useNavGuard = create((set) => ({
  dirty: false,
  message: 'You have unsaved changes. Leave this page anyway?',
  setGuard: (dirty, message) => set({ dirty, message: message || 'You have unsaved changes. Leave this page anyway?' }),
  clearGuard: () => set({ dirty: false }),
  confirmLeave: (onConfirm) => {
    const { dirty, message } = useNavGuard.getState();
    if (!dirty) { onConfirm?.(); return; }
    // Swap ok/cancel semantics so the destructive action sits on the LEFT
    // and the safe default (Stay) sits on the RIGHT — matches the chosen
    // layout. AntD Modal always renders cancel on the left and ok on the
    // right, so we put "Discard and leave" in the cancel slot and treat
    // its click as the confirmed leave.
    Modal.confirm({
      title: 'Unsaved changes',
      icon: createElement(ExclamationCircleFilled, { style: { color: 'var(--warning)' } }),
      content: message,
      okText: 'Stay',
      cancelText: 'Discard and leave',
      cancelButtonProps: { danger: true, size: 'large', style: { minWidth: 160 } },
      okButtonProps: { size: 'large', style: { minWidth: 120 } },
      centered: true,
      onCancel: onConfirm,
    });
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
export function useUnsavedChangesWarning(dirty, message = 'You have unsaved changes. Leave this page anyway?') {
  useEffect(() => {
    useNavGuard.getState().setGuard(dirty, message);
    return () => useNavGuard.getState().clearGuard();
  }, [dirty, message]);

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
