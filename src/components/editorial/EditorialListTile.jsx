import React, { useEffect, useRef } from 'react';
import './editorial.css';

/**
 * EditorialListTile — same visual envelope as EditorialTile, but the
 * primary content is a top-N list (party names, product names) instead
 * of a single big number. Used for dashboard tiles like "Top overdue
 * customers" or "Top selling products this week" where the *list* is
 * the metric, not a single aggregate.
 *
 * Props:
 *   category    string       small-caps eyebrow ("Action · Overdue")
 *   title       string       tile heading
 *   items       array        [{ id, label, sub?, value, valueClass?, onClick? }]
 *   summary     string       one-line summary under the title (optional)
 *   summaryRight React.Node  right-aligned chip on the summary row (optional)
 *   emptyText   string       shown when items[] is empty
 *   footer      React.Node   optional footer link (e.g. "View all overdue →")
 *   accent      string       CSS color override (default: --accent)
 *   reveal      boolean      attach reveal class for fade-up
 *   delayMs     number       reveal transition-delay
 */
export default function EditorialListTile({
  category,
  title,
  items = [],
  summary,
  summaryRight,
  emptyText = 'Nothing here.',
  footer,
  accent,
  reveal = true,
  delayMs = 0,
}) {
  const tileRef = useRef(null);

  useEffect(() => {
    const el = tileRef.current;
    if (!el || !reveal) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          el.classList.add('in');
          io.disconnect();
        }
      }
    }, { threshold: 0.08 });
    io.observe(el);
    return () => io.disconnect();
  }, [reveal]);

  const color = accent || 'var(--accent)';

  return (
    <article
      ref={tileRef}
      className={'e-tile e-tile-list' + (reveal ? ' e-reveal' : '')}
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

      {items.length === 0 ? (
        <div className="e-tile-list-empty">{emptyText}</div>
      ) : (
        <ul className="e-tile-list-items">
          {items.map((it, i) => (
            <li
              key={it.id ?? i}
              className={'e-tile-list-row' + (it.onClick ? ' is-clickable' : '')}
              onClick={it.onClick}
              role={it.onClick ? 'button' : undefined}
              tabIndex={it.onClick ? 0 : undefined}
              onKeyDown={(e) => { if (it.onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); it.onClick(); } }}
              style={{ '--row-accent': color }}
            >
              <span className="e-tile-list-rank" aria-hidden="true">{i + 1}</span>
              <span className="e-tile-list-text">
                <span className="e-tile-list-label">{it.label}</span>
                {it.sub && <span className="e-tile-list-sub">{it.sub}</span>}
              </span>
              <span className={'e-tile-list-value' + (it.valueClass ? ' ' + it.valueClass : '')}>
                {it.value}
              </span>
            </li>
          ))}
        </ul>
      )}

      {footer && <div className="e-tile-list-footer">{footer}</div>}
    </article>
  );
}
