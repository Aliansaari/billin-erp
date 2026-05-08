import React, { useEffect, useRef, useState } from 'react';
import Ring from './Ring';
import Sparkline from './Sparkline';
import './editorial.css';

/**
 * EditorialTile — the 9-up dashboard tile.
 *
 * Props:
 *   category    string      small-caps label top-left ("Sales")
 *   tier        'S'|'A'|'B'|'C'
 *   title       string      tile heading
 *   valueText   string      already-formatted string to display (e.g. "₹2,48,350")
 *   valueCount  number      (optional) animate from 0 to this on enter
 *   valueFormat (n) => str  formatter for count-up
 *   valueLabel  string      small line under the value (e.g. "Gross value")
 *   ringPct     number      0–100 (optional)
 *   ringLabel   string      center label override (e.g. "78%" or "7.5%")
 *   trendData   number[]    sparkline series
 *   trendLabel  string      left-side label ("6-month trend")
 *   trendRight  React.Node  right-side pct badge or text
 *   verdict     string      italic commentary under the sparkline
 *   accent      string      CSS color for the tier visuals (default: per tier)
 *   reveal      boolean     attach .e-reveal for on-scroll fade-up
 *   delayMs     number      reveal transition-delay
 */
const tierAccent = (tier) => {
  switch (tier) {
    case 'S': return 'var(--accent)';
    case 'A': return 'var(--warning)';
    case 'B': return 'var(--success)';
    case 'C': return 'var(--fg-tertiary)';
    default:  return 'var(--accent)';
  }
};

export default function EditorialTile({
  category,
  tier = 'S',
  title,
  valueText,
  valueCount,
  valueFormat = (n) => Math.round(n).toLocaleString('en-IN'),
  valueLabel,
  ringPct,
  ringLabel,
  trendData,
  trendLabel = '6-month trend',
  trendRight,
  verdict,
  accent,
  reveal = true,
  delayMs = 0,
}) {
  const color = accent || tierAccent(tier);
  const tileRef = useRef(null);
  const valueRef = useRef(null);
  const [seen, setSeen] = useState(false);

  // Attach reveal observer for the tile container.
  useEffect(() => {
    const el = tileRef.current;
    if (!el || !reveal) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          el.classList.add('in');
          setSeen(true);
          io.disconnect();
        }
      }
    }, { threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, [reveal]);

  // Count-up once the tile is visible. Falls back to valueText if
  // valueCount isn't supplied.
  useEffect(() => {
    if (!seen || valueCount == null || !valueRef.current) return;
    const el = valueRef.current;
    const target = Number(valueCount) || 0;
    const t0 = performance.now();
    const dur = 1100;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = valueFormat(target * eased);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [seen, valueCount, valueFormat]);

  return (
    <article
      ref={tileRef}
      className={'e-tile' + (reveal ? ' e-reveal' : '')}
      style={reveal ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      <div className="e-tile-top">
        <span className="e-tile-cat">{category}</span>
      </div>
      <div className="e-tile-title">{title}</div>

      <div className="e-tile-primary">
        <div className="e-tile-vblock">
          {valueLabel && <div className="k">{valueLabel}</div>}
          <div className="e-tile-value" ref={valueRef}>
            {valueCount != null ? valueFormat(0) : (valueText || '—')}
          </div>
        </div>
        {ringPct != null && (
          <Ring value={ringPct} color={color} label={ringLabel} />
        )}
      </div>

      {(trendData || trendRight) && (
        <div className="e-tile-trend">
          <div className="e-tile-trend-meta">
            <span className="e-micro">{trendLabel}</span>
            {trendRight}
          </div>
          {trendData && trendData.length > 1 && (
            <Sparkline data={trendData} color={color} />
          )}
        </div>
      )}

      {verdict && <div className="e-tile-verdict">{verdict}</div>}
    </article>
  );
}
