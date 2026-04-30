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

// Approximate row height in pixels for Antd `size="small"` rows. Used
// only for the visible-range computation — actual heights are still
// driven by Antd's virtualizer.
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
    .vrt-summary-area .ant-table-body { scrollbar-width: none; }`;
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
  ...rest
}) {
  // Panel height measurement → scroll.y. Without a numeric scroll.y,
  // Antd silently keeps thead inline with the body and it scrolls out
  // of view inside the panel's overflow:hidden.
  const internalPanelRef = useRef(null);
  const panelRef = externalPanelRef || internalPanelRef;
  const [bodyMaxH, setBodyMaxH] = useState(undefined);

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
      return dataArea.querySelector('.ant-table-body')
          || dataArea.querySelector('.ant-table-tbody-virtual-holder')
          || null;
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
        if (scroller) attach(scroller);
      }, 100);
      return () => clearTimeout(t);
    }
    return attach(scroller);

    function attach(el) {
      const handler = () => {
        const top = el.scrollTop;
        const h   = el.clientHeight;
        if (ensureChunk) {
          const first = Math.floor(top / ROW_HEIGHT_SMALL);
          const last  = Math.ceil((top + h) / ROW_HEIGHT_SMALL);
          ensureChunk(first);
          ensureChunk(last);
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
          {...rest}
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
