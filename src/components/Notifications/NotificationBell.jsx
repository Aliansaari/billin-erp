import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { BellOutlined, BellFilled } from '@ant-design/icons';
import { notificationsAPI } from '../../api';
import NotificationPanel from './NotificationPanel';
import './notifications.css';

/* ──────────────────────────────────────────────────────────────────────────
 * NotificationBell — topbar icon + unread badge + dropdown trigger.
 *
 * Two responsibilities:
 *   1. Maintain a lightweight unread-count poll while idle (60s).
 *   2. Render the dropdown panel when clicked, hand it the fetched
 *      payload, and keep state coherent on close.
 *
 * The bell hides itself entirely when the user's master_enabled
 * preference is false — that's the kill switch. We discover that on
 * the first count poll; until then the bell is invisible (no flicker
 * for users who've muted the feature).
 *
 * Polling cadence:
 *   - 60s when the tab is focused
 *   - paused when the tab is hidden (matches the dashboard's pattern;
 *     no point hitting the server when nobody can see the result)
 *   - on focus return, fire once immediately to catch up
 *
 * The polled endpoint /notifications/count is cheap — runs the
 * detectors, returns just a number. Full payload only fetched when
 * the panel actually opens, so a bell that's never opened costs the
 * server ~60s × small-query × user/day.
 * ────────────────────────────────────────────────────────────────────────── */

const POLL_INTERVAL_MS = 60 * 1000;

export default function NotificationBell({ align = 'right' } = {}) {
  // align — where the panel anchors relative to the bell.
  //   'right' (default) — panel right-edge aligned with the bell's right
  //                       edge. Use in TopNav where the bell sits near
  //                       the screen's right side.
  //   'left'            — panel left-edge aligned with the bell's left
  //                       edge. Use in Sidebar where the bell sits near
  //                       the screen's left side.
  const [count, setCount]             = useState(0);
  const [masterEnabled, setMaster]    = useState(null); // null = unknown yet
  const [open, setOpen]               = useState(false);
  // Anchor coords for the portaled panel. We measure the bell's
  // viewport position on open and pass into the panel; the panel
  // mounts at document.body so it escapes any ancestor overflow:hidden
  // (the collapsed sidebar in particular clips it otherwise).
  const [anchor, setAnchor]           = useState(null);
  const wrapRef                       = useRef(null);
  const bellRef                       = useRef(null);
  const pollTimerRef                  = useRef(null);
  const firstLoadDoneRef              = useRef(false);

  // One-shot count fetch. Pulled out so we can call it from the poll
  // tick AND from explicit refresh moments (panel close, focus return).
  const refreshCount = useCallback(async () => {
    try {
      const res = await notificationsAPI.count();
      const data = res?.data || {};
      // If master is off, normalize to 0 and persist the flag so the
      // render path hides the bell.
      if (data.master_enabled === false) {
        setMaster(false);
        setCount(0);
        return;
      }
      setMaster(true);
      setCount(Number(data.unread_count || 0));
    } catch {
      // Auth errors are noisy on first load (login screen); swallow.
      // 5xx during a poll cycle just leaves the stale count in place.
    } finally {
      firstLoadDoneRef.current = true;
    }
  }, []);

  // Poll loop — start on mount, stop on unmount, pause when tab hidden.
  useEffect(() => {
    refreshCount();
    const tick = () => { if (!document.hidden) refreshCount(); };
    pollTimerRef.current = setInterval(tick, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (!document.hidden) refreshCount();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(pollTimerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshCount]);

  // Listen for an in-app event so other components (eg the settings
  // page after a toggle update) can prompt an immediate refresh.
  useEffect(() => {
    const onRefresh = () => refreshCount();
    window.addEventListener('notifications:refresh', onRefresh);
    return () => window.removeEventListener('notifications:refresh', onRefresh);
  }, [refreshCount]);

  // Close the panel on outside click. Listening on mousedown (not
  // click) so the operator's click on a row doesn't race with the
  // close — the row's onClick still fires first via stopPropagation
  // inside the panel.
  //
  // We check both the bell wrap AND the panel itself (which lives in
  // a portal, so it's NOT inside wrapRef). Without the panel check,
  // clicking anywhere inside the portaled panel would close it.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      const target = e.target;
      if (wrapRef.current && wrapRef.current.contains(target)) return;
      if (target.closest && target.closest('.notif-panel')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Recompute anchor whenever the bell opens or the viewport size
  // changes. The portaled panel reads these coords each render.
  //
  // Direction (up vs down) is decided per-open based on which side has
  // more room — the bell used to live in the topbar (always plenty of
  // room below) but now sits at the bottom of the sidebar too, where
  // opening downward shoves the panel off-screen. The threshold is
  // 360 px (typical panel height of ~5 unread cards + header + footer);
  // if "below" can't fit it but "above" can, we flip.
  useLayoutEffect(() => {
    if (!open || !bellRef.current) return;
    const update = () => {
      const r = bellRef.current?.getBoundingClientRect();
      if (!r) return;
      const spaceBelow = window.innerHeight - r.bottom - 12;
      const spaceAbove = r.top - 12;
      const openUp    = spaceBelow < 360 && spaceAbove > spaceBelow;
      if (openUp) {
        setAnchor({
          bottom: window.innerHeight - r.top + 8,
          left:   r.left,
          right:  window.innerWidth - r.right,
          bellWidth: r.width,
          direction: 'up',
        });
      } else {
        setAnchor({
          top:    r.bottom + 8,
          left:   r.left,
          right:  window.innerWidth - r.right,
          bellWidth: r.width,
          direction: 'down',
        });
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Master-off → bell is invisible. We also skip rendering when we
  // genuinely don't know yet (null), to avoid flashing the icon and
  // then hiding it on the first poll response.
  if (masterEnabled === false) return null;
  if (masterEnabled === null && !firstLoadDoneRef.current) {
    // First render before the first poll lands. Show a quiet
    // placeholder so the topbar layout doesn't jump in the 100ms
    // before the count arrives. Functional bell, just no badge.
  }

  // Panel position style — portal mounts at body, so we anchor it
  // with viewport coords measured off the bell. align decides whether
  // the panel extends right-from-left edge or left-from-right edge.
  // direction (set in the effect above) decides whether we anchor the
  // top edge below the bell or the bottom edge above it.
  const panelStyle = anchor ? {
    ...(anchor.direction === 'up' ? { bottom: anchor.bottom } : { top: anchor.top }),
    ...(align === 'left' ? { left: anchor.left } : { right: anchor.right }),
  } : null;

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        ref={bellRef}
        type="button"
        className={`notif-bell ${count > 0 ? 'has-unread' : ''} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={count > 0 ? `${count} unread notification${count === 1 ? '' : 's'}` : 'Notifications'}
        aria-label="Open notifications"
        aria-haspopup="true"
        aria-expanded={open}
      >
        {count > 0 ? <BellFilled /> : <BellOutlined />}
        {count > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>
      {open && panelStyle && ReactDOM.createPortal(
        <NotificationPanel
          align={align}
          style={panelStyle}
          onClose={() => { setOpen(false); refreshCount(); }}
          onCountChange={(n) => setCount(n)}
        />,
        document.body,
      )}
    </div>
  );
}
