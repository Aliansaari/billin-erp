import React, { useEffect, useRef, useState } from 'react';
import { tap as hapticTap } from '../utils/haptics';
import './AttentionPill.css';

/* ──────────────────────────────────────────────────────────────────────
 * AttentionPill — one line that cycles through what needs doing.
 *
 * This replaces a stack of three alert cards. Those were the right
 * INFORMATION in the wrong FORM: they duplicated the notification panel,
 * they took a third of the screen to say what fits on one line, and three
 * bordered cards in a row read as an error state rather than as a summary.
 *
 * A pill borrows the one pattern people already read without being taught —
 * a small dark capsule that holds a single live fact and swaps it for the
 * next. It says "there are things here" in the space of a line, and because
 * it CHANGES it can carry all of them rather than picking one and hiding the
 * rest behind a badge.
 *
 * The cycle stops on a single item: rotating through a list of one is just a
 * thing that flickers.
 * ────────────────────────────────────────────────────────────────────── */

const CYCLE_MS = 4200;

export default function AttentionPill({ items = [], onPick }) {
  const [index, setIndex] = useState(0);
  const pausedRef = useRef(false);

  // Never leave the index past the end when the list shrinks under us —
  // an item resolves (a bill gets paid) and the array gets shorter.
  useEffect(() => { setIndex((i) => (i >= items.length ? 0 : i)); }, [items.length]);

  useEffect(() => {
    if (items.length < 2) return undefined;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    // With reduced motion the content still advances; it just does not slide.
    const id = setInterval(() => {
      if (!pausedRef.current) setIndex((i) => (i + 1) % items.length);
    }, reduced ? CYCLE_MS * 1.6 : CYCLE_MS);
    return () => clearInterval(id);
  }, [items.length]);

  if (!items.length) return null;
  const item = items[Math.min(index, items.length - 1)];

  return (
    <button
      className="apill"
      onClick={() => { hapticTap(); (onPick || item.action)?.(item); }}
      /* Holding it stops the rotation — you are reading this one. */
      onPointerDown={() => { pausedRef.current = true; }}
      onPointerUp={() => { pausedRef.current = false; }}
      onPointerCancel={() => { pausedRef.current = false; }}
      aria-live="polite"
      aria-label={`${item.title}. ${item.sub || ''}`}
    >
      {/* Keyed so React remounts it, which replays the entry animation —
          the content swap is the whole point of the shape. */}
      <span className="apill-inner" key={item.key ?? index}>
        <span className={`apill-icon apill-${item.type || 'info'}`}>{item.icon}</span>
        <span className="apill-text">
          <span className="apill-title">{item.title}</span>
          {item.sub && <span className="apill-sub">{item.sub}</span>}
        </span>
        {item.total > 0 && (
          <span className="apill-amount">
            <span className="currency">₹</span>{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(item.total)}
          </span>
        )}
      </span>

      {items.length > 1 && (
        <span className="apill-dots" aria-hidden>
          {items.map((it, i) => (
            <span key={it.key ?? i} className={`apill-dot${i === index ? ' on' : ''}`} />
          ))}
        </span>
      )}
    </button>
  );
}
