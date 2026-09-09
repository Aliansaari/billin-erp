import React, { useEffect, useState } from 'react';
import './page-transition.css';

/**
 * The animated wrapper around the current route.
 *
 * ── The bug this is built to survive ──
 *
 * The previous slide transition was reverted because a page could be left
 * "stuck at the start transform", shifted sideways with no way back. That is
 * not hypothetical — it reproduces the moment the compositor does not advance
 * the animation (a backgrounded webview, a stalled frame, low-power mode).
 * A CSS animation holds its 0% keyframe for its whole active duration, so an
 * animation that never progresses is a page parked 26px off-screen.
 *
 * The fix is to stop relying on the animation finishing. The direction class
 * is removed by a TIMER, which is not compositor-bound and keeps running when
 * frames do not. Once it goes, the element falls back to `.pt-stage`, which
 * carries no transform at all — the correct resting position.
 *
 * So the worst case degrades to "no animation", never to "wrong position".
 * That is the property the old implementation lacked.
 */

// Comfortably past the longest keyframe (280ms) so a normal animation is
// never cut short, while a stalled one is still rescued promptly.
const SETTLE_MS = 360;

export default function PageStage({ direction, children }) {
  // Seeded per mount. The parent keys this on location.key, so every
  // navigation remounts and re-seeds, which is what restarts the animation.
  const [dir, setDir] = useState(direction);

  // Two independent ways out, because each covers the other's blind spot:
  //
  //   animationend  exact, fires the instant the animation really finishes —
  //                 but never fires if the animation never ran.
  //   timer         always fires, including when frames are not being
  //                 produced — but is throttled in a backgrounded webview, so
  //                 it can be late.
  //
  // Whichever arrives first clears the class; the other becomes a no-op. The
  // page therefore reaches its resting position under every combination of
  // stalled compositor and throttled timers.
  useEffect(() => {
    const t = setTimeout(() => setDir(null), SETTLE_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className={`pt-stage${dir ? ` pt-stage--${dir}` : ''}`}
      onAnimationEnd={() => setDir(null)}
    >
      {children}
    </div>
  );
}
