import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ZehenMark } from '../components/ZehenLogo';
import useThemeStore from '../store/themeStore';
import './login.css';

/**
 * authShell — the chrome shared by every signed-out screen.
 *
 * Sign-in and Set-a-new-password are the same room: the same dot grid,
 * the same header with the mark and the clock, the same footer. Only the
 * card in the middle differs. Keeping the chrome here means the two can
 * never drift apart again — the password screen used to carry its own
 * copy of an older login design and looked like a different product.
 *
 * Everything reads live theme tokens (see login.css), so the screen is
 * teal under Classic and terracotta under Modern. The ZEHEN mark is the
 * one thing that never recolours: it is the app icon.
 */

export const WHATSAPP_HELP = 'https://wa.me/917040700030';
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

export function greetingFor(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Morning / afternoon / evening / night — drives the background wash. */
export function phaseFor(hour) {
  if (hour < 5 || hour >= 19) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** Indian FY runs April-March; a company may override the start month. */
export function fyLabel(startMonth = 4, when = new Date()) {
  const m = Number(startMonth) || 4;          // 1-12, April by default
  const start = when.getMonth() + 1 >= m ? when.getFullYear() : when.getFullYear() - 1;
  return 'FY ' + String(start).slice(2) + '–' + String(start + 1).slice(2);
}

export function initialsOf(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function openHelp() {
  const api = window.electronAPI;
  if (api?.openExternal) { api.openExternal(WHATSAPP_HELP); return; }
  // Browser/LAN client: a normal new tab is the right behaviour there.
  window.open(WHATSAPP_HELP, '_blank', 'noopener,noreferrer');
}

/* Icons kept inline: no icon font to load, and each one is a couple of
 * paths. All decorative, so all aria-hidden. */
export const I = {
  help: (p) => (<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4M12 17h.01" /></svg>),
  search: (p) => (<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>),
  tick: (p) => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d="M5 12l5 5 9-10" /></svg>),
  alert: (p) => (<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></svg>),
  shield: (p) => (<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>),
  eye: (p) => (<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" /><circle cx="12" cy="12" r="3" /></svg>),
  eyeOff: (p) => (<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2.5 12S6 19 12 19a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>),
  spin: (p) => (<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" {...p}><path d="M12 3a9 9 0 1 0 9 9" /></svg>),
  back: (p) => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d="M14 6l-6 6 6 6" /></svg>),
  key: (p) => (<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M17 6l2 2M15 8l2 2" /></svg>),
};

/** True when the OS asks for less motion. Read once — it is a setting. */
export function usePrefersReducedMotion() {
  return useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );
}

/**
 * Clock + time-of-day wash. Ticks every 20s: the spec asks for 30s or
 * less, and a seconds hand would wake the renderer for no one's benefit.
 *
 * Night auto-dark applies only when the operator's appearance setting is
 * 'system'. An explicit Light or Dark choice stands — a signed-out screen
 * is not the place to overrule a preference.
 */
export function useClock() {
  const [now, setNow] = useState(() => new Date());
  const appearance = useThemeStore((s) => s.appearance);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 20000);
    return () => clearInterval(id);
  }, []);

  const timePhase = phaseFor(now.getHours());

  useEffect(() => {
    if (appearance !== 'system') return;
    const root = document.documentElement;
    const prev = root.dataset.theme;
    if (!prev) return;
    const wantDark = timePhase === 'night';
    const next = prev.replace(/-(light|dark)$/, wantDark ? '-dark' : '-light');
    if (next !== prev) root.dataset.theme = next;
    // ThemeProvider owns this attribute; it re-asserts on any theme change.
  }, [appearance, timePhase]);

  return { now, timePhase };
}

/**
 * Dot grid that brightens under the cursor (spec 7.13).
 *
 * The naive version repainted every dot on the screen on every pointer
 * frame — at 1366x850 that is ~2,300 dots, two hypots each, plus a
 * getComputedStyle call, and it made the sign-in screen feel sticky
 * under the mouse. Three things fix it:
 *
 *   1. The unlit grid never changes, so it is rendered ONCE into an
 *      offscreen canvas and blitted, instead of being recomputed.
 *   2. Only the dots within the cursor's radius are drawn per frame —
 *      about 270 of them, whatever the size of the window.
 *   3. Only the rectangle that changed is cleared and repainted, so the
 *      per-frame cost no longer grows with the size of the screen.
 *
 * Colours are read on resize and when the theme attribute changes, not
 * every frame. Everything is driven by rAF, so React never re-renders.
 */
const DOT_STEP = 22;      // px between dots
const DOT_RADIUS = 180;   // how far the cursor's light reaches

function useDotGrid(ref, disabled) {
  useEffect(() => {
    const cv = ref.current;
    if (!cv || disabled) return;
    const ctx = cv.getContext('2d');

    let raf = 0, w = 0, h = 0, dpr = 1;
    let mx = -9999, my = -9999, target = 0, cur = 0;
    let base = null;                 // offscreen copy of the unlit grid
    let accent = '#B1472F';
    let prev = null;                 // rect lit on the previous frame
    let needsFull = true;

    const rebuild = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth; h = cv.clientHeight;
      if (w <= 0 || h <= 0) return;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cs = getComputedStyle(cv);
      accent = cs.getPropertyValue('--ac').trim() || accent;
      const dot = cs.getPropertyValue('--dot').trim() || 'rgba(0,0,0,.15)';

      base = document.createElement('canvas');
      base.width = cv.width; base.height = cv.height;
      const b = base.getContext('2d');
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      b.fillStyle = dot;
      const cx = w / 2, cy = h / 2, fadeR = Math.max(w, h) * 0.52;
      for (let x = DOT_STEP; x < w; x += DOT_STEP) {
        for (let y = DOT_STEP; y < h; y += DOT_STEP) {
          // Radial fade so the grid dissolves toward the window edges.
          const fade = 1 - Math.hypot(x - cx, y - cy) / fadeR;
          if (fade <= 0.02) continue;
          b.globalAlpha = fade;
          b.beginPath(); b.arc(x, y, 1, 0, 6.2832); b.fill();
        }
      }
      b.globalAlpha = 1;
      prev = null;
      needsFull = true;
    };

    /* The box the cursor lights right now, clamped to the canvas. */
    const litBox = () => {
      if (cur <= 0.01) return null;
      const x0 = Math.max(0, mx - DOT_RADIUS - 2);
      const y0 = Math.max(0, my - DOT_RADIUS - 2);
      const x1 = Math.min(w, mx + DOT_RADIUS + 2);
      const y1 = Math.min(h, my + DOT_RADIUS + 2);
      if (x1 <= x0 || y1 <= y0) return null;
      return { x0, y0, x1, y1 };
    };

    const restore = (r) => {
      ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      if (!base) return;
      ctx.drawImage(
        base,
        r.x0 * dpr, r.y0 * dpr, (r.x1 - r.x0) * dpr, (r.y1 - r.y0) * dpr,
        r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0,
      );
    };

    const draw = () => {
      raf = 0;
      if (!base) return;
      cur += (target - cur) * 0.12;

      const box = litBox();
      if (needsFull) {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(base, 0, 0, w, h);
        needsFull = false;
      } else {
        // Repaint only what changed: where the light was, and where it is.
        const dirty = prev && box
          ? {
            x0: Math.min(prev.x0, box.x0), y0: Math.min(prev.y0, box.y0),
            x1: Math.max(prev.x1, box.x1), y1: Math.max(prev.y1, box.y1),
          }
          : (prev || box);
        if (dirty) restore(dirty);
      }
      prev = box;

      if (box) {
        const cx = w / 2, cy = h / 2, fadeR = Math.max(w, h) * 0.52;
        const sx = Math.max(DOT_STEP, Math.ceil((mx - DOT_RADIUS) / DOT_STEP) * DOT_STEP);
        const sy = Math.max(DOT_STEP, Math.ceil((my - DOT_RADIUS) / DOT_STEP) * DOT_STEP);
        ctx.fillStyle = accent;
        for (let x = sx; x < w && x <= mx + DOT_RADIUS; x += DOT_STEP) {
          for (let y = sy; y < h && y <= my + DOT_RADIUS; y += DOT_STEP) {
            const near = Math.hypot(x - mx, y - my);
            if (near >= DOT_RADIUS) continue;
            const fade = 1 - Math.hypot(x - cx, y - cy) / fadeR;
            if (fade <= 0.02) continue;
            ctx.globalAlpha = fade * (1 - near / DOT_RADIUS) * cur;
            ctx.beginPath(); ctx.arc(x, y, 1.5, 0, 6.2832); ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }

      // Keep animating only while the light is still fading in or out;
      // a moving cursor schedules its own frame below.
      if (Math.abs(target - cur) > 0.01) raf = requestAnimationFrame(draw);
    };

    const kick = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const onMove = (e) => { mx = e.clientX; my = e.clientY; target = 1; kick(); };
    const onLeave = () => { target = 0; kick(); };
    const onResize = () => { rebuild(); kick(); };

    // First paint is synchronous: waiting a frame left the screen briefly
    // bare on slower machines.
    rebuild(); draw();

    // The unlit grid is painted in the theme's dot colour, so it has to be
    // rebuilt when the theme changes underneath it.
    const themeWatch = new MutationObserver(() => { rebuild(); kick(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', onResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      themeWatch.disconnect();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', onResize);
    };
  }, [ref, disabled]);
}

/**
 * The room. `children` is the centre column; `overlay` is anything that
 * paints over the whole screen (the sign-in hand-off).
 */
export function AuthShell({ now, timePhase, reduced, footerNote, overlay, children }) {
  const bgRef = useRef(null);
  useDotGrid(bgRef, reduced);

  return (
    <div className="zlogin" data-phase={timePhase}>
      <canvas ref={bgRef} className="zl-bg" aria-hidden="true" />
      <div className="zl-bg-tint" aria-hidden="true" />

      <header className="zl-head">
        <div className="zl-brand">
          <ZehenMark size={30} />
          <span className="zl-word">ZEHEN</span>
        </div>
        <span className="zl-when">
          {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          <span className="sep" aria-hidden="true" />
          <span className="time">
            {now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
          </span>
        </span>
        <button type="button" className="zl-help" onClick={openHelp}>
          <I.help /> Help
        </button>
      </header>

      <main className="zl-main">
        <div className="zl-col">{children}</div>
      </main>

      <footer className="zl-foot">
        <span className="zl-live"><i aria-hidden="true" />{footerNote || 'All data on this computer'}</span>
        {/* Spec 5.5: the backup time is hidden until there is a real
            timestamp to read — an invented one would be worse than none. */}
        <span />
        <span>{APP_VERSION ? 'ZEHEN v' + APP_VERSION : 'ZEHEN'}</span>
      </footer>

      {overlay}
    </div>
  );
}
