// ── VirtualReportTable ─────────────────────────────────────────────────
//
// Reusable virtualized table for long-list pages. Pairs with the
// useVirtualizedReport hook in src/hooks. Together they implement
// "feels like one seamless list of N rows" UX even when N is in the
// hundreds of thousands.
//
// What it does:
//   • Antd v5 Table in `virtual` mode — only ~30 visible <tr>s in DOM.
//   • Reads the row at every visible index from a sparse array; rows
//     marked __loading render as faint skeleton placeholders.
//   • Watches the .ant-table-body scroll container; on every scroll
//     event, asks the hook to ensureChunk for the visible range +
//     prefetch distance. Hook handles dedupe, caching, and abort.
//   • Renders the totals row as a SECOND Antd Table below the virtual
//     one, with the same `columns` array but render functions
//     overridden via `summaryCells`. Both tables use Antd's own column
//     layout, so cells align cell-for-cell by construction (no external
//     measurement, no parallel math).
//   • Mirrors horizontal scroll between the two tables so the totals
//     row tracks the data when the column set is wider than the panel.
//
// Why two Antd Tables instead of a custom summary <table> with
// colgroup? Because matching Antd's column-layout math from the
// outside is fragile — box-sizing, padding, border-collapse, font
// metrics all subtly diverge. Reusing Antd for the summary makes the
// alignment problem go away entirely: same library, same column
// widths, same internal cell layout.
//
// Usage:
//
//   const { rows, totalCount, summary, ensureChunk, loading } =
//     useVirtualizedReport({ fetcher, filters });
//
//   <VirtualReportTable
//     columns={columns}
//     rows={rows}
//     totalCount={totalCount}
//     ensureChunk={ensureChunk}
//     loading={loading}
//     rowKey={(r) => r.sales_bill_id}
//     scroll={{ x: 1300 }}                  // x-overflow for the column set
//     summaryCells={(col, idx) => ...ReactNode...}
//     summaryColSpan={(col, idx) => 1}       // optional — for spanning
//     // …any other Antd Table props (size, onRow, rowClassName, etc.)
//   />
//
// Skeleton rendering:
//   Each column's existing render function is called as-is for real
//   rows. For placeholder rows, the wrapper substitutes a shimmer block
//   sized to the column's `width`. No code change needed in the
//   consuming page's column specs.

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Table } from 'antd';
import { PLACEHOLDER_ROW } from '../hooks/useVirtualizedReport';

// Initial estimate for an Antd `size="small"` row. The real height is
// measured at runtime (see `rowHeightRef` below) — this is just a
// reasonable starting point so the very first scroll math doesn't
// land in the wrong place. Actual height varies (~38–48 px) with
// font-size, padding, and any per-row meta lines.
const ROW_HEIGHT_SMALL = 38;

// Reserved height inside the table panel for thead + summary + borders.
// Used to compute scroll.y so neither edge gets clipped.
const RESERVED_FOR_HEADER_AND_SUMMARY = 80;

// ── Skeleton cell ──────────────────────────────────────────────────────
function SkeletonCell({ width, align }) {
  const w = typeof width === 'number'
    ? Math.min(width - 32, 120)
    : 80;
  return (
    <span
      aria-hidden="true"
      style={{
        display:    'inline-block',
        width:      w,
        height:     10,
        marginLeft: align === 'right' ? 'auto' : 0,
        borderRadius: 5,
        background:
          'linear-gradient(90deg, var(--bg-muted, #f1f3f5) 0%, var(--bg-hover, #e9ecef) 50%, var(--bg-muted, #f1f3f5) 100%)',
        backgroundSize: '200% 100%',
        animation:  'vrt-shimmer 1.4s ease-in-out infinite',
        opacity:    0.7,
      }}
    />
  );
}

// Inject shared styles once at module load.
//   • @keyframes vrt-shimmer — drives the skeleton placeholder animation.
//   • .vrt-summary-area — visual treatment for the second-table summary
//     (top border, muted background, bold cells). Targets the inner
//     Antd cell classes so we override Antd's defaults without
//     fighting specificity.
if (typeof document !== 'undefined' && !document.getElementById('vrt-shimmer-style')) {
  const style = document.createElement('style');
  style.id = 'vrt-shimmer-style';
  style.textContent = `
    @keyframes vrt-shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .vrt-summary-area {
      flex: none;
      border-top: 1px solid var(--border, #e5e7eb);
    }
    .vrt-summary-area .ant-table-cell {
      background: var(--bg-muted, #fafafa) !important;
      font-weight: 700 !important;
      color: var(--fg-primary, #111) !important;
      /* Keep totals on a single line. Without nowrap, narrow column
         widths cause breaks at the space inside "₹ 1,234.56" — the
         rupee glyph ends up on one line and the amount on the next. */
      white-space: nowrap;
    }
    /* The summary's own scrollbar is hidden — its scrollLeft is
       slaved to the data table's scrollLeft via JS so the cells stay
       aligned during horizontal scroll. */
    .vrt-summary-area .ant-table-body::-webkit-scrollbar { display: none; }
    .vrt-summary-area .ant-table-body { scrollbar-width: none; }
    /* Keyboard-nav active row — opt-in via the keyboardNav prop.
       Selectors cover both Antd table modes (the classic <tr>/<td>
       layout and the virtual <div role="row"> layout), and uses
       higher-specificity ancestors to win against the per-page row
       tints (e.g. .sr-row-neg) without an extra !important war. */
    .ant-table-tbody > tr.vrt-row-active > td,
    .ant-table-row.vrt-row-active > .ant-table-cell,
    tr.vrt-row-active > td {
      background: var(--accent-bg, rgba(79,70,229,0.08)) !important;
    }
    .ant-table-tbody > tr.vrt-row-active > td:first-child,
    .ant-table-row.vrt-row-active > .ant-table-cell:first-child,
    tr.vrt-row-active > td:first-child {
      box-shadow: inset 3px 0 0 0 var(--accent, #4F46E5);
    }`;
  document.head.appendChild(style);
}

export default function VirtualReportTable({
  columns,
  rows,
  totalCount,
  ensureChunk,
  loading,
  rowKey,
  scroll,
  panelRef: externalPanelRef,
  // Per-column summary content. Called once per column when rendering
  // the totals row. Return null/undefined for columns that have no
  // aggregate (e.g. status pill, customer name) — the cell renders
  // empty. Combined with `summaryColSpan` to merge consecutive
  // empty cells into a single label cell.
  summaryCells,
  // Optional. Per-column colSpan for the summary row. Default 1.
  // Returning 0 hides the cell (it's been merged into a previous
  // cell with a higher colSpan). Used to make the "Total (1676)"
  // label span the leading non-aggregate columns so it's never
  // truncated by a narrow first column.
  summaryColSpan,
  // Opt-in keyboard navigation. When true, ↑/↓/Home/End/PageUp/PageDown
  // move an active-row cursor through the FULL filtered set (not just
  // currently-rendered rows). Enter dispatches `onRowEnter(row, idx)`.
  // Esc clears the cursor. Works with virtualization: the active row's
  // chunk is fetched via ensureChunk and the body is scrolled to it.
  keyboardNav = false,
  onRowEnter,
  // When set, the cursor index is persisted to sessionStorage under
  // this key. Restored on mount so a round-trip to a detail page
  // (Product → Stock Movement → back) lands the user on the row they
  // came from. Pages that don't pass this prop get the previous in-
  // memory-only behaviour.
  persistKey,
  ...rest
}) {
  // Pull rowClassName + onRow out so we can wrap them — the inner Antd
  // Table needs a single rowClassName that combines user's + our
  // active-row class, and a single onRow that adds click-to-select on
  // top of the user's handler.
  const { rowClassName: userRowClassName, onRow: userOnRow, ...restProps } = rest;
  // Panel height measurement → scroll.y. Without a numeric scroll.y,
  // Antd silently keeps thead inline with the body and it scrolls out
  // of view inside the panel's overflow:hidden.
  const internalPanelRef = useRef(null);
  const panelRef = externalPanelRef || internalPanelRef;
  const [bodyMaxH, setBodyMaxH] = useState(undefined);

  // Keyboard-nav cursor (opt-in via `keyboardNav` prop). Stored as a
  // simple row index — virtualization friendly because we don't need
  // the row's data to be present in `rows` to navigate (we just compute
  // the next index and let ensureChunk + scroll bring it in).
  //
  // Persistence: when persistKey is set, both the cursor index AND
  // the body scrollTop are stashed in sessionStorage. Persisting the
  // raw scrollTop (in addition to the index) means the round-trip
  // restores the EXACT visual position — without it, computing
  // scrollTop from the index reproduces "the cursor at the bottom of
  // the viewport" (or wherever our default math puts it), which can
  // be 10+ rows off from where the user actually left their view.
  const persistedInitial = (() => {
    if (!keyboardNav || !persistKey || typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(`vrt-cursor:${persistKey}`);
    if (raw == null) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        const idx = Number.isFinite(obj.idx) && obj.idx >= 0 ? obj.idx : null;
        const top = Number.isFinite(obj.scrollTop) && obj.scrollTop >= 0 ? obj.scrollTop : null;
        return { idx, top };
      }
      // Backwards-compat — older builds stored a bare index.
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? { idx: n, top: null } : null;
    } catch {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? { idx: n, top: null } : null;
    }
  })();
  const [activeIdx, setActiveIdx] = useState(persistedInitial?.idx ?? null);
  // One-shot scrollTop to apply once the scroller is available.
  const pendingScrollTopRef = useRef(persistedInitial?.top ?? null);

  // Persist the cursor + the live scrollTop. We save scrollTop on a
  // scroll listener too (below) so it stays current as the user
  // scrolls, but persisting on cursor change covers the keyboard-nav
  // path before the scroll listener fires.
  useEffect(() => {
    if (!keyboardNav || !persistKey || typeof sessionStorage === 'undefined') return;
    const key = `vrt-cursor:${persistKey}`;
    if (activeIdx == null) {
      sessionStorage.removeItem(key);
      return;
    }
    const sc = scrollerRef.current;
    const top = sc ? sc.scrollTop : null;
    sessionStorage.setItem(key, JSON.stringify({ idx: activeIdx, scrollTop: top }));
  }, [activeIdx, keyboardNav, persistKey]);
  // Cached scroller so the keyboard handler can scroll the body without
  // re-querying the DOM each keypress. Updated by the existing scroll
  // effect below.
  const scrollerRef = useRef(null);
  // Measured row height — sampled from the first rendered row and
  // re-sampled when rows change. Without this, manual scroll math
  // (top = idx × ROW_HEIGHT) drifts by ~9 px / row against Antd's
  // actual small-table row height (~47 px), making the cursor walk
  // off-screen ~64 rows in.
  const rowHeightRef = useRef(ROW_HEIGHT_SMALL);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const update = () => {
      const h = el.clientHeight;
      setBodyMaxH(Math.max(120, h - RESERVED_FOR_HEADER_AND_SUMMARY));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panelRef]);

  // Wrap each column's render to detect placeholder rows and emit a
  // skeleton cell. Real rows pass through to the user-supplied render.
  const wrappedColumns = useMemo(() => columns.map((col) => {
    const userRender = col.render;
    return {
      ...col,
      render: (value, record, index) => {
        if (record && record.__loading) {
          return <SkeletonCell width={col.width} align={col.align} />;
        }
        return userRender ? userRender(value, record, index) : value;
      },
    };
  }), [columns]);

  // rowKey: when row is a placeholder, fall back to its index so React
  // doesn't try to use the same singleton placeholder object as a key
  // for many rows.
  const wrappedRowKey = useCallback((record, index) => {
    if (!record || record.__loading) return `__placeholder_${index}`;
    if (typeof rowKey === 'function') return rowKey(record, index);
    if (typeof rowKey === 'string')   return record[rowKey];
    return index;
  }, [rowKey]);

  // Total visible width — `max(scroll.x, sum_of_column_widths)`. Both
  // tables get the same value so neither scales columns up to fill,
  // and both end up with identical column widths. Without this, when
  // the user hides columns to drop the visible-sum below scroll.x,
  // Antd would scale columns wider in the data table — and the
  // summary table (which we ALSO control) needs to behave the same.
  const lockedScrollX = useMemo(() => {
    const sum = columns.reduce((s, c) => s + (typeof c.width === 'number' ? c.width : 100), 0);
    const scrollX = scroll && typeof scroll.x === 'number' ? scroll.x : 0;
    return Math.max(sum, scrollX);
  }, [columns, scroll]);

  // Visible-range tracker AND horizontal-scroll mirror. Attaches a
  // passive scroll listener to the data table's scroll container and:
  //   • asks ensureChunk for the visible row range (vertical)
  //   • mirrors scrollLeft to the summary table so the totals row
  //     tracks horizontal scroll on the data above
  const summaryWrapRef = useRef(null);
  useEffect(() => {
    if (!totalCount) return;
    const root = panelRef.current;
    if (!root) return;

    // Antd's scroll container class varies across minor versions.
    // Walk both common selectors — but only inside the DATA-table
    // subtree, NOT the summary subtree (each table has its own
    // .ant-table-body and we only want to listen on the data one).
    const findScroller = () => {
      const dataArea = root.querySelector('.vrt-data-area');
      if (!dataArea) return null;
      // Try the well-known Antd selectors first (fast path):
      //   .ant-table-body                — non-virtual classic
      //   .ant-table-tbody-virtual-holder — Antd v5 early virtual
      //   .rc-virtual-list-holder         — Antd v5.10+ virtual (rc-table)
      const fast = dataArea.querySelector('.ant-table-body')
                || dataArea.querySelector('.ant-table-tbody-virtual-holder')
                || dataArea.querySelector('.rc-virtual-list-holder');
      if (fast) return fast;
      // Fallback: walk descendants and pick the first element that
      // actually scrolls vertically. Catches future Antd renames and
      // unusual mode combinations without per-version maintenance.
      const all = dataArea.querySelectorAll('*');
      for (const el of all) {
        const cs = getComputedStyle(el);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
          return el;
        }
      }
      return null;
    };
    const findSummaryScroller = () => {
      const sumArea = summaryWrapRef.current;
      if (!sumArea) return null;
      return sumArea.querySelector('.ant-table-body')
          || sumArea.querySelector('.ant-table-tbody-virtual-holder')
          || null;
    };

    let scroller = findScroller();
    if (!scroller) {
      const t = setTimeout(() => {
        scroller = findScroller();
        if (scroller) { scrollerRef.current = scroller; attach(scroller); }
      }, 100);
      return () => clearTimeout(t);
    }
    scrollerRef.current = scroller;
    return attach(scroller);

    function attach(el) {
      // First-attach: apply any scrollTop persisted from the previous
      // session (round-trip via Stock Movement). Cleared after use so
      // it isn't re-applied on subsequent attaches (e.g. column toggle
      // re-mounting the table).
      if (pendingScrollTopRef.current != null) {
        try { el.scrollTop = pendingScrollTopRef.current; } catch {}
        pendingScrollTopRef.current = null;
      }
      const handler = () => {
        const top = el.scrollTop;
        const h   = el.clientHeight;
        if (ensureChunk) {
          const first = Math.floor(top / ROW_HEIGHT_SMALL);
          const last  = Math.ceil((top + h) / ROW_HEIGHT_SMALL);
          ensureChunk(first);
          ensureChunk(last);
        }
        // Persist scrollTop alongside the cursor index. Done on every
        // scroll (not just on cursor change) so the user's manual
        // scroll position survives a round-trip to a detail page even
        // if they didn't move the cursor before navigating.
        if (keyboardNav && persistKey && typeof sessionStorage !== 'undefined') {
          const key = `vrt-cursor:${persistKey}`;
          const cur = sessionStorage.getItem(key);
          let body;
          try { body = cur ? JSON.parse(cur) : {}; } catch { body = {}; }
          if (typeof body !== 'object' || body == null) body = {};
          body.scrollTop = top;
          sessionStorage.setItem(key, JSON.stringify(body));
        }
        // Mirror horizontal scroll to the summary table's body. Looked
        // up each event because the summary body element may be replaced
        // by Antd between renders (e.g. when columns toggle).
        const sumScroller = findSummaryScroller();
        if (sumScroller && sumScroller.scrollLeft !== el.scrollLeft) {
          sumScroller.scrollLeft = el.scrollLeft;
        }
      };
      handler();
      el.addEventListener('scroll', handler, { passive: true });
      return () => el.removeEventListener('scroll', handler);
    }
  }, [ensureChunk, totalCount, panelRef]);

  // ── Keyboard nav ────────────────────────────────────────────────
  // Bound once with refs for the changing values so we don't tear down
  // and re-attach the listener on every keypress (cheap but adds up).
  // Skipped when the user is typing in any input — we don't want arrow
  // keys in a search box to also move the table cursor.
  const navRefs = useRef({ totalCount, ensureChunk, rows, onRowEnter, activeIdx });
  useEffect(() => {
    navRefs.current = { totalCount, ensureChunk, rows, onRowEnter, activeIdx };
  });

  useEffect(() => {
    if (!keyboardNav) return;
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const { totalCount: total, activeIdx: cur, onRowEnter: onEnter, rows: rs } = navRefs.current;
      if (!total) return;

      if (e.key === 'Enter') {
        if (cur != null && onEnter) {
          const row = rs[cur];
          if (row && !row.__loading) {
            e.preventDefault();
            onEnter(row, cur);
          }
        }
        return;
      }
      if (e.key === 'Escape') { setActiveIdx(null); return; }

      let next = cur;
      if (e.key === 'ArrowDown')        next = cur == null ? 0 : Math.min(cur + 1, total - 1);
      else if (e.key === 'ArrowUp')     next = cur == null ? 0 : Math.max(cur - 1, 0);
      else if (e.key === 'PageDown')    next = cur == null ? 0 : Math.min(cur + 10, total - 1);
      else if (e.key === 'PageUp')      next = cur == null ? 0 : Math.max(cur - 10, 0);
      else if (e.key === 'Home')        next = 0;
      else if (e.key === 'End')         next = total - 1;
      else return;

      e.preventDefault();
      if (next !== cur || cur == null) setActiveIdx(next);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keyboardNav]);

  // ── Active-row paint via imperative DOM mutation ─────────────────
  //
  // Held arrows fire 30–50 events/sec. If activeIdx flowed into Antd's
  // rowClassName via a useCallback dependency, every keypress would
  // change the rowClassName function reference → Antd would re-render
  // every visible row × every cell on every press. Even for 30 rows
  // that's >300 cell renders per press and held arrows can't keep up.
  //
  // Instead: keep `wrappedRowClassName` stable so Antd skips row
  // re-renders, and apply / remove the `.vrt-row-active` class
  // directly on the row's DOM element. A useEffect runs after every
  // render of VRT (so it stays correct when rows or filters change),
  // and a scroll listener re-applies after Antd re-mounts a row
  // during virtual scroll.
  const lastActiveElRef = useRef(null);

  // Refs for the imperative paint (read inside scroll handler / effect).
  const rowsRef     = useRef(rows);
  const rowKeyRef   = useRef(rowKey);
  const totalRef    = useRef(totalCount);
  const ensureRef   = useRef(ensureChunk);
  const onRowEnterRef = useRef(onRowEnter);
  useEffect(() => {
    rowsRef.current = rows;
    rowKeyRef.current = rowKey;
    totalRef.current = totalCount;
    ensureRef.current = ensureChunk;
    onRowEnterRef.current = onRowEnter;
  });

  // paintActive reads activeIdx via ref so its function reference stays
  // stable across keypresses. If it depended on `activeIdx` directly,
  // the scroll-listener effect (which depends on paintActive) would
  // detach + re-attach on every press — and any pending paintActive
  // rAF queued by the previous attachment would be lost. That cascade
  // is what made the cursor "bury" during fast nav.
  const activeIdxRef = useRef(activeIdx);
  useEffect(() => { activeIdxRef.current = activeIdx; });

  const paintActive = useCallback(() => {
    if (!keyboardNav) return;
    const root = panelRef.current;
    if (!root) return;
    if (lastActiveElRef.current) {
      lastActiveElRef.current.classList.remove('vrt-row-active');
      lastActiveElRef.current = null;
    }
    root.querySelectorAll('.vrt-row-active').forEach((el) => {
      el.classList.remove('vrt-row-active');
    });
    const idx = activeIdxRef.current;
    if (idx == null) return;
    const r = rowsRef.current[idx];
    // Determine the data-row-key. Real rows use the consumer's rowKey;
    // placeholder rows (chunk still loading) use the synthetic key
    // that wrappedRowKey assigns. Both cases map to a real DOM element
    // — without this, the cursor would be invisible AND unscrollable
    // until the chunk resolved.
    let key;
    if (!r || r.__loading) {
      key = `__placeholder_${idx}`;
    } else if (typeof rowKeyRef.current === 'function') {
      key = rowKeyRef.current(r, idx);
    } else {
      key = r[rowKeyRef.current];
    }
    if (key == null) return;
    const safeKey = (window.CSS && CSS.escape) ? CSS.escape(String(key)) : String(key);
    const el = root.querySelector(`[data-row-key="${safeKey}"]`);
    if (el) {
      el.classList.add('vrt-row-active');
      lastActiveElRef.current = el;
    }
  }, [keyboardNav, panelRef]);

  // Scroll-to-row + chunk fetch when the cursor moves. With virtual
  // mode we can't rely on scrollIntoView (the row may not be in the
  // DOM at all). Instead: ensureChunk loads the data, then we scroll
  // the body to `idx * ROW_HEIGHT_SMALL` only as far as needed to bring
  // the row into the visible window — "minimum scroll" UX, same as the
  // cell page.
  // Last activeIdx that triggered a manual scroll. Initialised to the
  // current activeIdx so the FIRST effect run (the one fired by mount-
  // restore from sessionStorage) is treated as "no change" and skips
  // the scroll math — the persisted scrollTop already places the user
  // exactly where they left off, and re-running the math would
  // re-position the cursor at the bottom edge instead.
  const lastScrolledIdxRef = useRef(activeIdx);

  useEffect(() => {
    if (activeIdx == null) { paintActive(); return; }
    if (ensureChunk) ensureChunk(activeIdx);
    const idxChanged = lastScrolledIdxRef.current !== activeIdx;
    lastScrolledIdxRef.current = activeIdx;

    // Only scroll when the cursor index actually moved. Skipping on
    // data-update re-renders (rows change with same activeIdx) keeps
    // the user's saved scroll position intact across chunk loads and
    // search-debounce flushes.
    if (idxChanged) {
      const sc = scrollerRef.current;
      if (sc) {
        // Sample actual row height — Antd small-table rows are ~47 px,
        // not the 38 px estimate; without measuring, manual scroll math
        // drifts ~9 px / row and the cursor walks off-screen.
        const sampleEl = panelRef.current?.querySelector('.ant-table-row');
        const sampleH  = sampleEl?.offsetHeight;
        if (sampleH && sampleH > 16) rowHeightRef.current = sampleH;
        const rh   = rowHeightRef.current;
        const top  = activeIdx * rh;
        const view = sc.scrollTop;
        const h    = sc.clientHeight;
        if (top < view) {
          sc.scrollTop = top;
        } else if (top + rh > view + h) {
          sc.scrollTop = top - h + rh;
        }
      }
    }
    // Apply the class after this render commits so the row is in DOM.
    paintActive();
    // Safety net — if the row's still partly hidden under a sticky
    // header / footer (or scrollerRef wasn't found for this Antd
    // version), scrollIntoView({ block: 'nearest' }) brings it into
    // the visible area. The rAF is intentionally NOT cancelled on
    // cleanup — during rapid keypresses each tick fires with the
    // latest activeIdxRef.current and the paint is idempotent, so
    // letting them all run keeps the cursor visible during the hold
    // (cancelling would mean only the final rAF after key-release
    // ever fires, leaving the cursor invisible during the hold).
    requestAnimationFrame(() => {
      paintActive();
      const el = lastActiveElRef.current;
      if (!el) return;
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); }
      catch { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    });
  }, [activeIdx, ensureChunk, paintActive, rows]);

  // Re-apply on virtual scroll — Antd swaps row elements as the user
  // scrolls past them, so our imperative class is wiped. Throttled
  // (not debounced) so paintActive runs at most once per frame but
  // is never cancelled mid-flight: during rapid scroll the cursor
  // class keeps tracking the active index instead of waiting for
  // scroll to come to a complete stop.
  useEffect(() => {
    if (!keyboardNav) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; paintActive(); });
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => { sc.removeEventListener('scroll', onScroll); };
  }, [keyboardNav, paintActive, totalCount]);

  // Clamp the cursor when the dataset shrinks (filter/search change).
  // Skip when totalCount is still 0 — that's the "data not loaded yet"
  // state on initial mount, and clamping there would wipe a cursor
  // restored from sessionStorage before the fetch completes.
  useEffect(() => {
    if (totalCount === 0) return;
    if (activeIdx != null && activeIdx >= totalCount) {
      setActiveIdx(totalCount - 1);
    }
  }, [totalCount, activeIdx]);

  // Stable rowClassName — does NOT include activeIdx so Antd skips
  // per-row re-renders during arrow nav. The active class is painted
  // imperatively (above). Per-page tints (e.g. `sr-row-neg`) still
  // flow through normally.
  const wrappedRowClassName = useCallback((record, index) => {
    return userRowClassName ? userRowClassName(record, index) : '';
  }, [userRowClassName]);

  // Click-to-select — sets the active cursor on the clicked row so the
  // visual highlight is reachable without keyboard nav, and so the
  // user can land the cursor anywhere before pressing Enter. We write
  // the cursor index to sessionStorage SYNCHRONOUSLY here, before the
  // user's onClick navigates away — the useEffect-based persistence
  // would lose this update because the component unmounts before
  // React commits the setActiveIdx state change. Without this sync
  // write, a click on row 64 (after arrow-navigating to row 4) would
  // navigate to product 64 but persist row 4 → Esc-back lands on 4.
  const onRow = useCallback((record, index) => {
    const userBound = userOnRow ? userOnRow(record, index) : {};
    if (!keyboardNav) return userBound;
    return {
      ...userBound,
      onClick: (ev) => {
        const live = rowsRef.current[index] ?? record;
        if (live && !live.__loading) {
          setActiveIdx(index);
          if (persistKey && typeof sessionStorage !== 'undefined') {
            const sc = scrollerRef.current;
            sessionStorage.setItem(
              `vrt-cursor:${persistKey}`,
              JSON.stringify({ idx: index, scrollTop: sc ? sc.scrollTop : null }),
            );
          }
        }
        // Re-bind on the live record so the user's handler navigates
        // to the actually-clicked row even if Antd's closure was stale.
        const freshBound = userOnRow ? userOnRow(live, index) : {};
        freshBound.onClick?.(ev);
      },
    };
  }, [userOnRow, keyboardNav, persistKey]);

  // Build the columns for the summary table. Same shape as data
  // columns — Antd applies identical layout — but with `render` and
  // `onCell` overridden to emit summary content + colSpan.
  const summaryColumns = useMemo(() => {
    if (!summaryCells) return null;
    return columns.map((c, i) => {
      const span = summaryColSpan ? summaryColSpan(c, i) : 1;
      return {
        ...c,
        // When this cell spans multiple columns it's holding a label
        // (e.g. "Total (1676)"). Labels read naturally left-aligned —
        // override the source column's `align` (which may be 'center'
        // for an Sr column) so the label sits flush to the panel edge
        // rather than floating in the middle of the merged width.
        align: span > 1 ? 'left' : c.align,
        // Strip the shimmer-wrapped render and any user render; the
        // summary cell content comes from summaryCells(col, idx).
        render: () => summaryCells(c, i),
        onCell: () => ({ colSpan: span }),
      };
    });
  }, [columns, summaryCells, summaryColSpan]);

  // Compose scroll prop for the data table.
  const dataScrollProp = useMemo(() => ({
    ...(scroll || {}),
    x: lockedScrollX,
    y: bodyMaxH,
  }), [scroll, bodyMaxH, lockedScrollX]);

  // Scroll prop for the summary table — same x so column widths match;
  // no y so the single row takes its natural height.
  const summaryScrollProp = useMemo(() => ({
    x: lockedScrollX,
  }), [lockedScrollX]);

  return (
    <div
      ref={panelRef}
      className="report-table-scroll rpt-tbl"
      style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div
        className="vrt-data-area"
        style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <Table
          virtual
          columns={wrappedColumns}
          dataSource={rows}
          rowKey={wrappedRowKey}
          loading={loading}
          scroll={dataScrollProp}
          pagination={false}
          size="small"
          {...restProps}
          rowClassName={wrappedRowClassName}
          onRow={onRow}
        />
      </div>
      {summaryColumns && totalCount > 0 && (
        <div className="vrt-summary-area" ref={summaryWrapRef}>
          <Table
            columns={summaryColumns}
            dataSource={[{ __summary: true }]}
            rowKey={() => '__summary'}
            showHeader={false}
            pagination={false}
            scroll={summaryScrollProp}
            size="small"
          />
        </div>
      )}
    </div>
  );
}
