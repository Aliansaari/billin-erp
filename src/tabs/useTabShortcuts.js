import { useEffect } from 'react';
import { newTab, closeCurrent, reopenClosed, nextTab, tabAt } from './tabActions';
import { ESC_OVERLAY_SELECTOR } from '../utils/overlays';

/*
 * Tab keys, the same as a web browser:
 *   Ctrl+T new tab · Ctrl+W close · Ctrl+Shift+T reopen closed
 *   Ctrl+Tab / Ctrl+Shift+Tab or Ctrl+PgDn / PgUp next / previous
 *   Ctrl+1…8 that tab · Ctrl+9 last tab
 *
 * Capture phase, so a screen's own key handling can never swallow them.
 * Ignored while a dialog, dropdown or popup is open: those belong to the
 * screen you are on and must not be left behind in a hidden tab.
 * (In the desktop app Ctrl+W arrives from the main process; see preload.)
 */
export default function useTabShortcuts() {
  useEffect(() => {
    const overlayOpen = () => !!document.querySelector(ESC_OVERLAY_SELECTOR);
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      let act = null;
      if (e.code === 'KeyT') act = e.shiftKey ? reopenClosed : newTab;
      else if (e.code === 'KeyW' && !e.shiftKey) act = closeCurrent;
      else if (e.key === 'Tab') act = () => nextTab(e.shiftKey ? -1 : 1);
      else if (e.key === 'PageDown' && !e.shiftKey) act = () => nextTab(1);
      else if (e.key === 'PageUp' && !e.shiftKey) act = () => nextTab(-1);
      else if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) { const n = Number(e.code.slice(5)); act = () => tabAt(n); }
      if (!act) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (overlayOpen()) return;
      act();
    };
    window.addEventListener('keydown', onKey, true);
    const off = window.electronAPI?.onTabCommand?.((cmd) => {
      if (cmd === 'close' && !overlayOpen()) closeCurrent();
    });
    return () => { window.removeEventListener('keydown', onKey, true); off?.(); };
  }, []);
}
