import React, { useMemo } from 'react';

/* ──────────────────────────────────────────────────────────────────────
 * Sparkline — fourteen days of sales as a shape.
 *
 * The home screen shows one number for today and could not say whether that
 * is a good day. A percentage against yesterday was tried and removed, and
 * rightly: "+12%" is a verdict with no evidence, and yesterday is an
 * arbitrary thing to be measured against — one quiet Sunday makes Monday look
 * heroic.
 *
 * A shape asserts nothing. It shows the fortnight and lets the owner — who
 * knows their own trade far better than any threshold I could pick — see
 * where today sits in it. Today is marked, because that is the point of
 * comparison the rest of the card is about.
 *
 * No axes, no labels, no gridlines. At this size they would be illegible, and
 * a chart nobody can read is worse than no chart because it still costs the
 * space.
 * ────────────────────────────────────────────────────────────────────── */

export default function Sparkline({ points = [], width = 108, height = 40 }) {
  const geometry = useMemo(() => {
    const values = points.map((p) => Number(p.total) || 0);
    if (values.length < 2) return null;

    const max = Math.max(...values);
    const min = Math.min(...values);
    // A flat fortnight would divide by zero; draw it as a flat line at rest.
    const span = max - min || 1;
    const stepX = width / (values.length - 1);
    // Inset so the stroke and the marker are never clipped by the viewBox.
    const pad = 4;
    const usable = height - pad * 2;

    const xy = values.map((v, i) => [
      +(i * stepX).toFixed(2),
      +(pad + usable - ((v - min) / span) * usable).toFixed(2),
    ]);

    const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
    // Closed back along the baseline so the area beneath can be filled — it
    // is what makes a 40px line read as a quantity rather than as a squiggle.
    const area = `${line} L${width},${height} L0,${height} Z`;
    return { line, area, last: xy[xy.length - 1], allZero: max === 0 };
  }, [points, width, height]);

  if (!geometry || geometry.allZero) return null;

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={geometry.area} fill="url(#sparkFill)" />
      <path
        d={geometry.line}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      {/* Today. Without it the line is a trend with no "you are here". */}
      <circle cx={geometry.last[0]} cy={geometry.last[1]} r="2.6" fill="currentColor" />
    </svg>
  );
}
