/**
 * The parts of "feeling native" that live outside React.
 *
 * Each of these fixes one specific moment where a web view gives itself away,
 * and each is a no-op on the browser build so the preview keeps working.
 */
import { Capacitor } from '@capacitor/core';

const native = () => Capacitor.isNativePlatform();

/**
 * Status bar text colour follows the app's theme.
 *
 * Without this the bar is whatever Info.plist froze it as, so switching to the
 * dark theme leaves black glyphs on a near-black header — the clock and the
 * battery vanish. It is a small area of screen that people read constantly,
 * and getting it wrong reads as "this app does not own the whole screen".
 *
 * Capacitor's Style.Dark means DARK BACKGROUND, therefore LIGHT text. The
 * naming trips everyone up, hence the mapping being written out.
 */
export async function syncStatusBar(isDark) {
  if (!native()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
  } catch { /* plugin absent in this build */ }
}

/**
 * Run `fn` whenever the app comes back to the foreground.
 *
 * A phone put in a pocket at 11am and taken out at 4pm was showing 11am's
 * figures with nothing to say they were old — and if the shop computer had
 * come back online in between, the app never noticed. Native apps refresh on
 * resume; this is the hook that lets screens do the same.
 *
 * Returns a cleanup function; safe to call on the web, where it does nothing.
 */
export function onResume(fn) {
  if (!native()) {
    // The browser equivalent, useful in the preview and harmless on device.
    const onVis = () => { if (document.visibilityState === 'visible') fn(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }
  let remove = () => {};
  import('@capacitor/app')
    .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => { if (isActive) fn(); }))
    .then((handle) => { remove = () => handle.remove(); })
    .catch(() => { /* plugin absent */ });
  return () => remove();
}

/**
 * Android's hardware back button.
 *
 * Unhandled, it closes the app from anywhere — including from the middle of a
 * half-entered bill. It should mean the same as the back gesture: go back one
 * screen, and only exit when there is nothing left to go back to.
 */
export function bindHardwareBack(canGoBack, goBack) {
  if (!native()) return () => {};
  let remove = () => {};
  import('@capacitor/app')
    .then(({ App }) => App.addListener('backButton', () => {
      if (canGoBack()) goBack();
      else App.exitApp();
    }))
    .then((handle) => { remove = () => handle.remove(); })
    .catch(() => {});
  return () => remove();
}

/**
 * Subscribe to the shell's resume broadcast. Returns an unsubscribe function,
 * so a screen wraps it in useEffect like any other listener.
 *
 * Screens use this rather than talking to Capacitor themselves: it keeps them
 * testable in the browser and keeps the throttling in one place.
 */
export function onAppResumed(fn) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('zehen:resumed', fn);
  return () => window.removeEventListener('zehen:resumed', fn);
}

/**
 * Keyboard handling, in one place instead of three.
 *
 * The WebView is configured with `resize: 'none'`, so the keyboard slides OVER
 * the page rather than shrinking it. That is the right call — letting iOS
 * resize the view makes every fixed header and footer jump — but it means
 * anything anchored to the bottom ends up underneath the keyboard, which in a
 * billing app is the paid-amount field you are typing into.
 *
 * Three forms had grown their own copy of this listener with their own CSS
 * variable. One tracker now publishes the height as `--kb-h`, and keeps the
 * three legacy names in step so their existing CSS is untouched.
 *
 * Also turns on the iOS accessory bar. It is off by default in a WebView, and
 * it is the strip carrying Prev / Next / Done — without it there is no way to
 * move between fields except tapping each one, which is unmistakably not how
 * a native form behaves.
 */
export function startKeyboardTracking() {
  const root = document.documentElement;
  const apply = (px) => {
    const h = `${Math.max(0, Math.round(px))}px`;
    for (const name of ['--kb-h', '--bf-kbd-h', '--vf-kbd-h', '--pf-kbd-h']) {
      root.style.setProperty(name, h);
    }
    root.classList.toggle('kb-open', px > 0);
  };
  apply(0);

  if (!native()) {
    // Browser preview: visualViewport shrinks when a soft keyboard opens.
    const vv = window.visualViewport;
    if (!vv) return () => {};
    const onVV = () => apply(window.innerHeight - vv.height - vv.offsetTop);
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
    return () => {
      vv.removeEventListener('resize', onVV);
      vv.removeEventListener('scroll', onVV);
      apply(0);
    };
  }

  let handles = [];
  import('@capacitor/keyboard').then(async ({ Keyboard }) => {
    try { await Keyboard.setAccessoryBarVisible({ isVisible: true }); } catch { /* Android */ }
    handles = await Promise.all([
      Keyboard.addListener('keyboardWillShow', (info) => {
        apply(info.keyboardHeight);
        // Keep the field you are typing in on screen. The browser's own
        // scrollIntoView is the only thing that knows where the caret is, and
        // 'nearest' moves the minimum needed rather than yanking the page.
        const el = document.activeElement;
        if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) {
          setTimeout(() => {
            try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* detached */ }
          }, 60);
        }
      }),
      Keyboard.addListener('keyboardWillHide', () => apply(0)),
    ]);
  }).catch(() => { /* plugin absent */ });

  return () => { handles.forEach((h) => h.remove?.()); apply(0); };
}
