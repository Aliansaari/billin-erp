import React, { useEffect, useRef } from 'react';

/**
 * Ring — circular progress indicator used on dashboard tiles.
 *
 * Props:
 *   value    number   0–100, target percentage
 *   size     number   diameter in px (default 52)
 *   stroke   number   stroke width in px (default 2.2)
 *   color    string   CSS color (var(--accent) etc.) — defaults to currentColor
 *   label    string   center label override (default: "{value}%")
 *   duration number   fill-animation duration ms (default 1400)
 *
 * The ring animates from full-circle (empty) to `value` on mount using
 * stroke-dashoffset. Uses a 15.5-radius circle so total circumference is
 * a consistent ~97.39 across all instances.
 */
const R = 15.5;
const C = 2 * Math.PI * R;

export default function Ring({
  value = 0,
  size = 52,
  stroke = 2.2,
  color = 'currentColor',
  label,
  duration = 1400,
}) {
  const fgRef = useRef(null);

  useEffect(() => {
    const el = fgRef.current;
    if (!el) return;
    // Start empty, then animate to target next tick so the transition runs.
    el.style.strokeDasharray  = C.toFixed(2);
    el.style.strokeDashoffset = C.toFixed(2);
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = `stroke-dashoffset ${duration}ms cubic-bezier(.2,.7,.2,1)`;
        const pct = Math.max(0, Math.min(100, Number(value) || 0));
        el.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(2);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  const shown = label ?? `${Math.round(value)}%`;

  return (
    <div style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
      <svg viewBox="0 0 36 36" width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        {/* Track */}
        <circle cx="18" cy="18" r={R} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        {/* Progress */}
        <circle
          ref={fgRef}
          cx="18" cy="18" r={R}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round"
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'grid', placeItems: 'center',
        fontSize: Math.max(10, size * 0.22),
        fontWeight: 600,
        color: 'var(--fg-primary)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {shown}
      </div>
    </div>
  );
}
