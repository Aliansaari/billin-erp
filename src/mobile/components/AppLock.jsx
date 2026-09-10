import React, { useCallback, useEffect, useRef, useState } from 'react';
import useAuthStore from '../../store/authStore';
import { isLockEnabled, authenticate, RELOCK_AFTER_MS, wasRestartedNotLaunched } from '../utils/biometric';
import { onAppResumed } from '../utils/nativeShell';
import './AppLock.css';

/* ──────────────────────────────────────────────────────────────────────
 * AppLock — Face ID between a pocketed phone and the day's takings.
 *
 * Covers the app rather than unmounting it, so unlocking returns you to the
 * exact screen, scroll position and half-typed bill you left. A lock that
 * costs you your work is one people turn off.
 *
 * The cover paints BEFORE the first scan is asked for. If it were the other
 * way round, the figures would be on screen behind the system prompt — which
 * is the one moment the lock exists to prevent.
 * ────────────────────────────────────────────────────────────────────── */

export default function AppLock() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const enabled = isLockEnabled();

  // Locked from the very first render when the feature is on, so nothing is
  // ever briefly visible while we work out whether to ask.
  /* Locked from the very first render when the feature is on, so nothing is
   * ever briefly visible while we work out whether to ask — EXCEPT when the
   * WebView merely restarted under us, which is not the operator arriving.
   * See wasRestartedNotLaunched(). */
  const [locked, setLocked] = useState(
    () => enabled && isAuthenticated && !wasRestartedNotLaunched(),
  );
  const [asking, setAsking] = useState(false);
  const leftAt = useRef(0);

  const unlock = useCallback(async () => {
    if (asking) return;
    setAsking(true);
    const ok = await authenticate('Unlock ZEHEN');
    setAsking(false);
    if (ok) setLocked(false);
  }, [asking]);

  // First arrival.
  useEffect(() => { if (locked) unlock(); /* eslint-disable-next-line */ }, []);

  /* Re-lock after being away.
   *
   * `leftAt` is the moment the app actually went to the background, and it is
   * CLEARED as soon as it has been used. Leaving it set was a real bug: once
   * you had been away for more than the grace period, that stale timestamp
   * satisfied the check on every subsequent resume, so the app asked for a
   * scan again and again — including on resumes it triggers itself, like the
   * one that follows the Face ID prompt. A lock that fires when you have not
   * been anywhere is a lock people turn off.
   *
   * Only a genuine background counts. Switching tabs, opening a sheet or
   * bringing up the camera never sets it, so none of them can lock the app. */
  useEffect(() => {
    if (!enabled || !isAuthenticated) return undefined;
    const onHide = () => {
      if (document.visibilityState === 'hidden') leftAt.current = Date.now();
    };
    document.addEventListener('visibilitychange', onHide);
    const off = onAppResumed(() => {
      const away = leftAt.current;
      leftAt.current = 0;                       // used — do not fire on it twice
      if (away && Date.now() - away > RELOCK_AFTER_MS) {
        setLocked(true);
        unlock();
      }
    });
    return () => { document.removeEventListener('visibilitychange', onHide); off?.(); };
  }, [enabled, isAuthenticated, unlock]);

  if (!enabled || !isAuthenticated || !locked) return null;

  return (
    <div className="applock" role="dialog" aria-modal="true" aria-label="Locked">
      <div className="applock-mark" aria-hidden>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2.5" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <div className="applock-title">ZEHEN is locked</div>
      <div className="applock-sub">Unlock to see this shop’s figures.</div>
      <button type="button" className="applock-btn" onClick={unlock} disabled={asking}>
        {asking ? 'Waiting…' : 'Unlock'}
      </button>
    </div>
  );
}
