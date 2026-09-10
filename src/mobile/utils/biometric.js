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
const BEAT_KEY  = 'zehen_alive_at';
const EXIT_KEY  = 'zehen_clean_exit';
const RESTART_WINDOW_MS = 20_000;

/* A fresh heartbeat alone was the wrong test, and it disabled the lock.
 *
 * The heartbeat is also written when the app goes to the background — so
 * closing ZEHEN and opening it again within twenty seconds looked exactly
 * like a crash-restart, and the lock was skipped on the one journey it exists
 * for: someone picking the phone up and opening the app.
 *
 * The real discriminator is whether the app got to run its own shutdown. A
 * crash or a WebView reclaim never reaches the hide handler; a person
 * swiping the app away always does. So: a restart is a fresh heartbeat AND
 * no clean-exit marker. Anything else is an arrival, and an arrival locks.
 */
let bootVerdict = null;   // decided once per page load, then frozen

export function wasRestartedNotLaunched() {
  if (bootVerdict !== null) return bootVerdict;
  let restarted = false;
  try {
    const last  = Number(localStorage.getItem(BEAT_KEY) || 0);
    const clean = localStorage.getItem(EXIT_KEY) === '1';
    restarted = !clean && !!last && Date.now() - last < RESTART_WINDOW_MS;
    /* Consumed here, on the first read of the run.
     *
     * If it were left for a later handler to clear, a clean exit followed by
     * a crash would still be carrying the marker and the crash-restart would
     * lock. And it must be read before it is cleared, which is why both
     * happen in one place rather than at two ends of the boot sequence. */
    localStorage.removeItem(EXIT_KEY);
  } catch { /* private mode — treat as a launch, which locks */ }
  bootVerdict = restarted;
  return bootVerdict;
}

/* A count of times the WebView came back on its own rather than being opened.
 *
 * Recorded because guessing at this from the outside costs a build and a
 * round trip each time: "blank for a second and then the same screen" is what
 * a restart looks like from the operator's side, and it is indistinguishable
 * from several other faults. The number is shown in the side panel footer, so
 * it can simply be read out. Zero there means the app is not restarting and
 * the fault is somewhere else entirely. */
const RESTART_COUNT_KEY = 'zehen_restarts';

export function restartCount() {
  try { return Number(localStorage.getItem(RESTART_COUNT_KEY) || 0); } catch { return 0; }
}

export function noteBootKind() {
  if (!wasRestartedNotLaunched()) return;
  try {
    localStorage.setItem(RESTART_COUNT_KEY, String(restartCount() + 1));
  } catch { /* private mode */ }
}

/** Keep the heartbeat fresh while the app is on screen. */
export function startHeartbeat() {
  const beat = () => {
    try { localStorage.setItem(BEAT_KEY, String(Date.now())); } catch { /* private mode */ }
  };
  // The boot verdict is frozen on its first read (wasRestartedNotLaunched),
  // which also consumes the marker — so nothing here has to race it.
  beat();
  const id = setInterval(beat, 5_000);

  const onHide = () => {
    if (document.visibilityState === 'hidden') {
      beat();
      // Reaching this line at all is the signal: the app was closed, not
      // killed. pagehide covers the cases visibilitychange misses on iOS.
      try { localStorage.setItem(EXIT_KEY, '1'); } catch { /* ignore */ }
    } else {
      /* Back on screen with the page still alive — so the hide it wrote the
       * marker for did NOT end the run, and the marker is now a lie. Left
       * set, a later foreground crash would read it as a clean exit and lock
       * the operator out mid-sale, which is the exact failure this whole
       * mechanism exists to avoid. Cleared on every return, so the marker
       * only ever survives a hide that really was the end. */
      try { localStorage.removeItem(EXIT_KEY); } catch { /* ignore */ }
    }
  };
  const onPageHide = () => {
    try { localStorage.setItem(EXIT_KEY, '1'); } catch { /* ignore */ }
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
  };
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
