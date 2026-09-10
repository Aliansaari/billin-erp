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
