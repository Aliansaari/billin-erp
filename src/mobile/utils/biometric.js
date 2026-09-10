/**
 * Face ID / Touch ID app lock.
 *
 * WHAT THIS IS, PRECISELY
 *
 * It gates the SCREEN, not the data. The session token still lives in the
 * WebView's storage exactly as before, so this stops someone picking up an
 * unlocked phone and reading the day's takings — it does not stop someone who
 * can read the device's filesystem. Saying otherwise would be the kind of
 * security claim that gets believed and then relied on.
 *
 * That is still the right trade for a shop: the realistic threat is the phone
 * left on the counter, not a forensic image of it.
 *
 * Off by default. A lock the owner did not ask for is a lock they will meet
 * for the first time while a customer waits.
 */
import { Capacitor } from '@capacitor/core';

const ENABLED_KEY = 'zehen_biometric_lock';

/** Minutes away before the app asks again. Short enough to matter, long
 *  enough that glancing at a WhatsApp message does not cost a scan. */
export const RELOCK_AFTER_MS = 3 * 60_000;

export const isLockEnabled = () => {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
};

export const setLockEnabled = (on) => {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1');
    else localStorage.removeItem(ENABLED_KEY);
  } catch { /* private mode */ }
};

/* ── Was this a real launch, or did the WebView just restart? ─────────
 *
 * iOS reclaims a backgrounded WKWebView whenever it wants the memory, and the
 * page comes back from nothing with no way to tell that apart from the
 * operator tapping the icon. Locking on the second one is right; locking on
 * the first is the app demanding a face scan while it sits in someone's hand
 * mid-sale, for no reason they can see.
 *
 * So the app leaves a heartbeat. If the last one is only seconds old, the
 * previous run was alive moments ago and this is a restart, not an arrival.
 *
 * Erring towards NOT locking is deliberate. The cost of missing one lock is
 * that a phone already in the owner's hand stays unlocked a little longer;
 * the cost of a false lock is an interruption every time iOS decides to
 * reclaim some memory, which is what makes people switch the feature off.
 */
const BEAT_KEY = 'zehen_alive_at';
const RESTART_WINDOW_MS = 20_000;

export function wasRestartedNotLaunched() {
  try {
    const last = Number(localStorage.getItem(BEAT_KEY) || 0);
    return !!last && Date.now() - last < RESTART_WINDOW_MS;
  } catch { return false; }
}

/** Keep the heartbeat fresh while the app is on screen. */
export function startHeartbeat() {
  const beat = () => {
    try { localStorage.setItem(BEAT_KEY, String(Date.now())); } catch { /* private mode */ }
  };
  beat();
  const id = setInterval(beat, 5_000);
  // Also on the way out, so the last value is as close to the end as possible.
  const onHide = () => { if (document.visibilityState === 'hidden') beat(); };
  document.addEventListener('visibilitychange', onHide);
  return () => { clearInterval(id); document.removeEventListener('visibilitychange', onHide); };
}

/** What this device can actually do — used to label the setting honestly
 *  ("Face ID" vs "Touch ID" vs nothing at all). */
export async function biometryInfo() {
  if (!Capacitor.isNativePlatform()) return { available: false, label: null };
  try {
    const { BiometricAuth, BiometryType } = await import('@aparajita/capacitor-biometric-auth');
    const info = await BiometricAuth.checkBiometry();
    const label = info.biometryType === BiometryType.faceId ? 'Face ID'
      : info.biometryType === BiometryType.touchId ? 'Touch ID'
      : info.isAvailable ? 'Biometric unlock' : null;
    return { available: !!info.isAvailable, label, reason: info.reason || '' };
  } catch {
    return { available: false, label: null };
  }
}

/**
 * Ask for a scan. Resolves true on success.
 *
 * `allowDeviceCredential` matters: a passcode fallback is what stops the owner
 * being locked out of their own books by a wet thumb or a mask, and without it
 * a failed scan has no way forward but reinstalling the app.
 */
export async function authenticate(reason = 'Unlock ZEHEN') {
  if (!Capacitor.isNativePlatform()) return true;   // browser preview
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: 'Cancel',
      allowDeviceCredential: true,
      iosFallbackTitle: 'Use passcode',
      androidTitle: 'Unlock ZEHEN',
      androidSubtitle: reason,
    });
    return true;
  } catch {
    return false;   // cancelled, failed, or unavailable
  }
}
