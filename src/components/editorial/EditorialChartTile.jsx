import React, { useEffect, useRef } from 'react';
import './editorial.css';

/**
 * EditorialChartTile — multi-line trend chart in the same visual envelope
 * as EditorialTile. Used for the dashboard's bigger "Sales vs Purchase"
 * and "Receipts vs Payments" tiles where the *shape* of the trend is the
 * value, not a single number.
 *
 * Renders a hand-rolled SVG (no charting lib) so the dashboard fetch
 * stays light. Auto-scales the y-axis to the union of all series; x-axis
 * shows first / midpoint / last labels for context. A faint horizontal
 * grid line at the y midpoint anchors the eye.
 *
 * Props:
 *   category      string                ("Trend · Sales vs Purchase")
 *   title         string                heading
 *   summary       string                one-line summary under the title
 *   summaryRight  React.Node            right-aligned chip on the summary row
 *   series        [{ key, label, color, data: number[] }]
 *   xLabels       string[]              same length as data; the chart shows
 *                                       first/middle/last under the chart
 *   reveal        boolean
 *   delayMs       number
 */
export default function EditorialChartTile({
  category,
  title,
  summary,
  summaryRight,
  series = [],
  xLabels = [],
  reveal = true,
  delayMs = 0,
}) {
  const tileRef = useRef(null);

  useEffect(() => {
    const el = tileRef.current;
    if (!el || !reveal) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { el.classList.add('in'); io.disconnect(); }
      }
    }, { threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, [reveal]);

  // Compute combined y-range across all series. Min always anchors at 0
  // for monetary trends — negative range only kicks in when at least one
  // series goes negative (e.g. net cash flow). Padded by 12% headroom so
  // the topmost peak doesn't kiss the canvas edge and small dots stay
  // visually clear of the top border.
  const flat = series.flatMap((s) => s.data || []);
  const hasNeg = flat.some((v) => v < 0);
  const rawMax = flat.length ? Math.max(...flat) : 0;
  const rawMin = hasNeg ? (flat.length ? Math.min(...flat) : 0) : 0;
  const span   = Math.max(1, rawMax - rawMin);
  const yMax   = rawMax + span * 0.12;
  const yMin   = hasNeg ? rawMin - span * 0.12 : 0;

  // Detect "no activity" — every series is all zeros (or empty). With
  // sparse data the chart line collapses to the baseline and reads as
  // broken; better to surface an explicit "no activity" line instead.
  const allZero = flat.length === 0 || flat.every((v) => v === 0);

  // SVG viewBox — 1000 wide, 200 tall keeps the math clean. The SVG also
  // gets explicit width="100%" + height attributes (in CSS pixels, NOT
  // viewBox units) so it lays out at the same size everywhere; without
  // them the SVG ends up larger than the CSS height when the parent flex
  // container is forced to grow.
  const W = 1000;
  const H = 200;
  const CANVAS_PX = 66;
  const len = Math.max(1, ...series.map((s) => (s.data || []).length));
  // Bar layout: each day owns a slot of width W/len so the last day's
  // group lands fully inside the canvas (line-chart spacing of W/(len-1)
  // would push the final slot past the right edge).
  const stepX = W / Math.max(1, len);
  const yScale = (v) => {
    if (yMax === yMin) return H / 2;
    return H - ((v - yMin) / (yMax - yMin)) * H;
  };

  // Bar geometry. Each day owns a horizontal slot of width stepX; we leave
  // a small gap between days, then split the remaining width between the
  // series so multiple lines render as side-by-side mini-bars per day.
  const numSeries = Math.max(1, series.length);
  const dayGapFrac = 0.18; // 18% of slot is left as inter-day breathing room
  const usableSlot = stepX * (1 - dayGapFrac);
  const barW = usableSlot / numSeries;
  const groupOffset = (stepX * dayGapFrac) / 2;
  const baselineY = yScale(0);
  // Minimum bar height (in viewBox units) so a zero day still renders as
  // a thin tick at the baseline — keeps the chart visually populated even
  // when most days have no activity.
  const MIN_BAR = 2;

  // x-axis tick positions — show the first label, a midpoint label, and
  // the last label. With a 30-day series this lands on day 1 / day 15 /
  // day 30 — enough to anchor the trend without crowding.
  const firstX = xLabels[0] || '';
  const midX   = xLabels[Math.floor(xLabels.length / 2)] || '';
  const lastX  = xLabels[xLabels.length - 1] || '';

  return (
    <article
      ref={tileRef}
      className={'e-tile e-tile-chart' + (reveal ? ' e-reveal' : '')}
      style={reveal ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      <div className="e-tile-top">
        <span className="e-tile-cat">{category}</span>
      </div>
      <div className="e-tile-title">{title}</div>

      {(summary || summaryRight) && (
        <div className="e-tile-list-summary">
          {summary && <span>{summary}</span>}
          {summaryRight}
        </div>
      )}

      <div className="e-tile-chart-body">
        {allZero ? (
          <div className="e-tile-chart-empty" style={{ height: CANVAS_PX }}>
            No activity in the last {len} day{len === 1 ? '' : 's'}.
          </div>
        ) : (
          <svg
            className="e-tile-chart-canvas"
            width="100%"
            height={CANVAS_PX}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{ display: 'block', height: CANVAS_PX, maxHeight: CANVAS_PX }}
          >
            {/* Faint horizontal axis line at y=0 — reads as the baseline */}
            <line
              x1={0} x2={W}
              y1={yScale(0)} y2={yScale(0)}
              stroke="var(--border)"
              strokeDasharray="3 4"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {/* Grouped bars — one slot per day, sub-bars per series. Each
                bar has a minimum height so zero-activity days render as a
                visible tick at the baseline; the whole window stays
                visually populated, no empty stretches. */}
            {series.map((s, sIdx) => (
              <g key={s.key || sIdx}>
                {(s.data || []).map((v, j) => {
                  const isLast = j === (s.data.length - 1);
                  const xLeft = groupOffset + j * stepX + sIdx * barW;
                  const yTop  = yScale(v);
                  const fullH = Math.abs(baselineY - yTop);
                  const h     = Math.max(MIN_BAR, fullH);
                  // For negative values the bar grows DOWN from the
                  // baseline; for positive values it grows UP. The y/h
                  // pair captures whichever rectangle is correct.
                  const y = v < 0 ? baselineY : Math.min(yTop, baselineY - MIN_BAR);
                  return (
                    <rect
                      key={j}
                      x={xLeft}
                      y={y}
                      width={Math.max(1, barW * 0.86)}
                      height={h}
                      fill={s.color}
                      opacity={isLast ? 1 : 0.78}
                      rx={Math.min(2, barW * 0.18)}
                    />
                  );
                })}
              </g>
            ))}
          </svg>
        )}

        {xLabels.length > 0 && !allZero && (
          <div className="e-tile-chart-axis">
            <span>{firstX}</span>
            <span>{midX}</span>
            <span>{lastX}</span>
          </div>
        )}

        {series.length > 0 && (
          <div className="e-tile-chart-legend">
            {series.map((s) => (
              <span key={s.key || s.label} className="e-tile-chart-legend-item">
                <span className="e-tile-chart-legend-dot" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
