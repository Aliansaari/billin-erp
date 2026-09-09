import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';

/**
 * useKeyboardInset — returns the current on-screen keyboard height in px
 * (0 when hidden). Use it to lift bottom-anchored sheets above the iOS
 * keyboard so their search field and results stay visible/selectable.
 *
 * Native: listens to Capacitor Keyboard will-show/will-hide.
 * Web/preview: falls back to visualViewport resize math.
 */
export default function useKeyboardInset() {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const set = (px) => setInset(Math.max(0, px || 0));
    let cleanup = () => {};

    if (Capacitor.isNativePlatform()) {
      let showH = null, hideH = null;
      import('@capacitor/keyboard').then(({ Keyboard }) => {
        Keyboard.addListener('keyboardWillShow', (info) => set(info.keyboardHeight)).then((h) => { showH = h; });
        Keyboard.addListener('keyboardWillHide', () => set(0)).then((h) => { hideH = h; });
      }).catch(() => {});
      cleanup = () => { showH?.remove?.(); hideH?.remove?.(); set(0); };
    } else if (window.visualViewport) {
      const vv = window.visualViewport;
      const apply = () => {
        const kb = window.innerHeight - vv.height - vv.offsetTop;
        set(kb > 80 ? kb : 0);
      };
      apply();
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      cleanup = () => { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); set(0); };
    }
    return cleanup;
  }, []);

  return inset;
}
