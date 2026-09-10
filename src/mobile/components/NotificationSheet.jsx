import React, { useCallback, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { tap as hapticTap, select as hapticSelect } from '../utils/haptics';
import { formatINR } from '../utils/format';
import './NotificationSheet.css';

/* ──────────────────────────────────────────────────────────────────────
 * NotificationSheet — everything that needs doing, in one place.
 *
 * The previous version was a dropdown hanging off the bell in the top-right
 * corner: a desktop pattern on a phone. It was ~260px wide because that is
 * what fits under an icon, so party names truncated and amounts crowded the
 * edge; it opened away from the thumb; and it needed a full-screen invisible
 * scrim to catch the taps its own click-outside listener kept missing.
 *
 * It drops from the top instead, under the bell that opens it. The app's
 * other sheets rise from the bottom because they are pickers — summon a list,
 * choose, dismiss. This one reports on the state of the shop and is opened
 * from a control in the header, and a panel appearing at the far end of the
 * screen from the thing you tapped makes you hunt for what you just asked
 * for.
 *
 * Full width regardless: top anchoring and cramped are two separate
 * decisions, and only the first was worth keeping from the old dropdown.
 *
 * Ordering is severity, not recency. Money that is late outranks a filing
 * deadline outranks a stock level, and a list a shop owner opens twice a day
 * should not reshuffle itself between visits.
 * ────────────────────────────────────────────────────────────────────── */

const RANK = { danger: 0, warn: 1, info: 2 };

export default function NotificationSheet({ open, items = [], onClose }) {
  /* Swipe up to dismiss.
   *
   * A sheet you can only close with a button is a dialog wearing a sheet's
   * clothes. This one hangs from the top, so the way out is upwards — the
   * direction it came from — and it follows the finger the whole way rather
   * than waiting for release to decide. Below a quarter of its height it
   * springs back, so a hesitant drag is a peek and not a mistake.
   *
   * Hooks stay above the early return: they must run on every render or React
   * treats the mount as a different component and throws. */
  const sheetRef = useRef(null);
  const drag = useRef(null);
  const [dy, setDy] = useState(0);

  const finish = useCallback((closing) => {
    drag.current = null;
    if (closing) { hapticSelect(); onClose?.(); }
    setDy(0);
  }, [onClose]);

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    // Only from the top of a list that is already scrolled up, or the drag
    // fights the list's own scrolling.
    const list = sheetRef.current?.querySelector('.ns-list');
    if (list && list.scrollTop > 0) return;
    drag.current = { y0: e.touches[0].clientY, t0: e.timeStamp };
  };

  const onTouchMove = (e) => {
    if (!drag.current) return;
    const delta = e.touches[0].clientY - drag.current.y0;
    // Upward only; pulling down just stretches slightly so the sheet feels
    // attached rather than ignoring you.
    setDy(delta < 0 ? delta : delta * 0.18);
  };

  const onTouchEnd = (e) => {
    if (!drag.current) return;
    const delta = e.changedTouches[0].clientY - drag.current.y0;
    const ms = Math.max(1, e.timeStamp - drag.current.t0);
    const height = sheetRef.current?.offsetHeight || 320;
    const flick = -delta / ms > 0.45;
    finish(-delta > height * 0.25 || flick);
  };

  if (!open) return null;

  const sorted = [...items].sort(
    (a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9),
  );

  return ReactDOM.createPortal(
    <div
      className="ns-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className={`ns-sheet${drag.current ? ' is-dragging' : ''}`}
        ref={sheetRef}
        role="dialog"
        aria-label="Needs attention"
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => finish(false)}
      >
        <div className="ns-head">
          <h2 className="ns-title">
            Needs attention
            {sorted.length > 0 && <span className="ns-count">{sorted.length}</span>}
          </h2>
          <button className="ns-close" onClick={onClose}>Done</button>
        </div>

        {sorted.length === 0 ? (
          /* An empty state worth reaching. The old one was a grey line of
             text in a cramped box; this is the result of everything being
             handled, and it should feel like one. */
          <div className="ns-empty">
            <div className="ns-empty-mark" aria-hidden>
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none"
                   stroke="currentColor" strokeWidth="1.9"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M4.5 12.5l5 5 10-11" />
              </svg>
            </div>
            <div className="ns-empty-title">All clear</div>
            <div className="ns-empty-sub">
              Nothing overdue, nothing due to file, nothing below reorder level.
            </div>
          </div>
        ) : (
          <div className="ns-list">
            {sorted.map((n) => (
              <button
                key={n.key}
                className={`ns-row ns-${n.type}`}
                onClick={() => { hapticTap(); onClose?.(); n.action?.(); }}
              >
                <span className="ns-icon">{n.icon}</span>
                <span className="ns-text">
                  <span className="ns-row-title">{n.title}</span>
                  {n.sub && <span className="ns-row-sub">{n.sub}</span>}
                </span>
                {n.total > 0 && (
                  <span className="ns-amount">
                    <span className="currency">₹</span>{formatINR(n.total)}
                  </span>
                )}
                <span className="ns-chev" aria-hidden>›</span>
              </button>
            ))}
          </div>
        )}
        {/* Ordered last so it sits on the panel's bottom edge — the side a
            top sheet is pushed back towards. */}
        <div className="ns-grab" aria-hidden />
      </div>
    </div>,
    document.body,
  );
}
