import React, { useMemo } from 'react';

/**
 * Sparkline — small animated area chart used on dashboard tiles.
 *
 * Props:
 *   data    number[]   series of numeric values, any range
 *   color   string     stroke + gradient color (defaults to currentColor)
 *   height  number     px height of the SVG (default 32)
 *   width   number     viewBox width reference (default 220). The SVG scales
 *                      to container width; this just controls how ticks lay out.
 *
 * The line animates on mount via stroke-dasharray → dashoffset 0, and the
 * gradient fill fades in. Both are pure CSS, no observer, no JS per frame.
 * Each instance gets its own gradient ID so multiple sparklines on a page
 * don't share a single gradient definition.
 */
let idCounter = 0;
const nextId = () => `sl-${++idCounter}`;

export default function Sparkline({ data = [], color = 'currentColor', height = 32, width = 220 }) {
  const gradId = useMemo(nextId, []);

  const { linePath, fillPath } = useMemo(() => {
    if (!data || data.length < 2) {
      return { linePath: '', fillPath: '' };
    }
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    // Normalise each point to 4..(h-4) so the top stroke doesn't clip and
    // the bottom anchor sits inside the gradient.
    const pad = 4;
    const usable = height - pad * 2;
    const step = width / (data.length - 1);

    const pts = data.map((v, i) => {
      const x = i * step;
      const y = pad + (1 - (v - min) / range) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const linePath = 'M' + pts.join(' L');
    const fillPath = `${linePath} L${width},${height} L0,${height} Z`;
    return { linePath, fillPath };
  }, [data, height, width]);

  if (!linePath) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.18" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={fillPath}
        fill={`url(#${gradId})`}
        style={{ opacity: 0, animation: 'erpSparkFillIn 1.2s ease-out .4s forwards' }}
      />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{
          strokeDasharray: 400,
          strokeDashoffset: 400,
          animation: 'erpSparkDraw 1.3s cubic-bezier(.2,.7,.2,1) .3s forwards',
        }}
      />
    </svg>
  );
}
