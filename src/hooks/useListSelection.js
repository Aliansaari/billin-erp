import { useCallback, useEffect, useRef, useState } from 'react';

// useListSelection — cursor + multi-select state for list pages.
//
// Selection model rule (locked with the user 2026-05-04):
//   The cursored row IS the selected row. There is no separate
//   "select" step. Arrow keys move the cursor; that row is selected.
//   Shift+arrows extend a contiguous range from the anchor; Ctrl+Click
//   toggles individual rows; Ctrl+A selects everything.
//
// Returns:
//   {
//     cursorIdx:    number | null,   // current focused row
//     selectedSet:  Set<number>,     // all selected indices (always includes cursorIdx if not null)
//     activeRow:    T | null,        // rows[cursorIdx] (convenience)
//     selectedRows: T[],             // rows that are in selectedSet
//     selectionCount: number,        // selectedSet.size
//     setCursor:    (idx) => void,   // single-select; replaces selection with {idx}
//     toggleRow:    (idx) => void,   // Ctrl+Click semantics — toggles in/out of selection
//     extendTo:     (idx) => void,   // Shift+Click — replaces selection with [anchor..idx]
//     selectAll:    () => void,
//     clear:        () => void,
//   }
//
// Keyboard handler is attached to `document` via useEffect when
// `enabled !== false` and totalCount > 0. Skipped when focus is inside
// any input / textarea / contenteditable so arrow nav in a search box
// doesn't also move the row cursor.
//
// Usage:
//   const sel = useListSelection({ totalCount: rows.length, rows });
//   <ActionStrip actions={[
//     { id:'open', key:'F1', label:'Open', onAction: () => open(sel.activeRow) }
//   ]} />
//   <VirtualReportTable
//     cursorIdx={sel.cursorIdx}
//     selectedSet={sel.selectedSet}
//     onCursorMove={sel.setCursor}
//     onShiftClickRow={sel.extendTo}
//     onCtrlClickRow={sel.toggleRow}
//     ... />
//
export default function useListSelection({
  totalCount,
  rows,
  enabled = true,
  initialIdx = null,
  // When true, ignores the input-focus check for ↑/↓/PgUp/PgDn etc.
  // Useful when the page wants arrow nav even while a search box is
  // focused. Defaults false to avoid surprising users mid-typing.
  hijackFromInputs = false,
}) {
  const [cursorIdx, setCursorIdxState] = useState(initialIdx);
  // The "anchor" for shift-extend operations — set whenever the user
  // performs a single-select action (click without shift, or arrow nav
  // without shift). Shift+arrows extend from this anchor.
  const [anchorIdx, setAnchorIdx] = useState(initialIdx);
  const [selectedSet, setSelectedSet] = useState(() => {
    return initialIdx == null ? new Set() : new Set([initialIdx]);
  });

  // ── Setters ────────────────────────────────────────────────────
  const setCursor = useCallback((idx) => {
    if (idx == null) {
      setCursorIdxState(null);
      setAnchorIdx(null);
      setSelectedSet(new Set());
      return;
    }
    setCursorIdxState(idx);
    setAnchorIdx(idx);
    setSelectedSet(new Set([idx]));
  }, []);

  const toggleRow = useCallback((idx) => {
    if (idx == null) return;
    setSelectedSet((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
    // Cursor jumps to the toggled row; anchor moves there too so a
    // subsequent Shift+Click/arrow extends from this point.
    setCursorIdxState(idx);
    setAnchorIdx(idx);
  }, []);

  const extendTo = useCallback((idx) => {
    if (idx == null) return;
    setCursorIdxState(idx);
    setSelectedSet(() => {
      const a = anchorIdx == null ? idx : anchorIdx;
      const lo = Math.min(a, idx);
      const hi = Math.max(a, idx);
      const out = new Set();
      for (let i = lo; i <= hi; i++) out.add(i);
      return out;
    });
    // Note: anchor stays put — that's the point of an "extend" op.
  }, [anchorIdx]);

  const selectAll = useCallback(() => {
    if (!totalCount) return;
    const out = new Set();
    for (let i = 0; i < totalCount; i++) out.add(i);
    setSelectedSet(out);
    // Leave cursor where it is; if null, put it at 0.
    setCursorIdxState((c) => (c == null ? 0 : c));
    setAnchorIdx((a) => (a == null ? 0 : a));
  }, [totalCount]);

  const clear = useCallback(() => {
    setCursorIdxState(null);
    setAnchorIdx(null);
    setSelectedSet(new Set());
  }, []);

  // Collapse multi-selection back to just the cursor row. Used by Esc
  // priority logic — first Esc collapses, second Esc leaves the page.
  const collapseToCursor = useCallback(() => {
    setSelectedSet(() => (cursorIdx == null ? new Set() : new Set([cursorIdx])));
    setAnchorIdx(cursorIdx);
  }, [cursorIdx]);

  // ── Keyboard handler ───────────────────────────────────────────
  // Refs for the latest values so the effect doesn't re-attach on every
  // keypress. The handler reads through refs; the effect attaches once.
  const stateRef = useRef({ cursorIdx, anchorIdx, selectedSet, totalCount });
  useEffect(() => {
    stateRef.current = { cursorIdx, anchorIdx, selectedSet, totalCount };
  });

  useEffect(() => {
    if (!enabled || !totalCount) return;
    const onKey = (e) => {
      // Skip when typing in an input / textarea / editable element.
      if (!hijackFromInputs) {
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      }

      const { cursorIdx: cur, anchorIdx: anchor, totalCount: total } = stateRef.current;

      // Ctrl+A — select all
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }

      // Movement keys
      let next = cur;
      const k = e.key;
      if      (k === 'ArrowDown')  next = cur == null ? 0 : Math.min(cur + 1, total - 1);
      else if (k === 'ArrowUp')    next = cur == null ? 0 : Math.max(cur - 1, 0);
      else if (k === 'PageDown')   next = cur == null ? 0 : Math.min(cur + 10, total - 1);
      else if (k === 'PageUp')     next = cur == null ? 0 : Math.max(cur - 10, 0);
      else if (k === 'Home')       next = 0;
      else if (k === 'End')        next = total - 1;
      else return;

      e.preventDefault();
      if (e.shiftKey) {
        // Extend from anchor (or current if no anchor) to next.
        const a = anchor == null ? (cur == null ? next : cur) : anchor;
        const lo = Math.min(a, next);
        const hi = Math.max(a, next);
        const out = new Set();
        for (let i = lo; i <= hi; i++) out.add(i);
        setCursorIdxState(next);
        setSelectedSet(out);
        if (anchor == null) setAnchorIdx(a);
      } else {
        // Plain move — replace selection with the single new cursor.
        setCursorIdxState(next);
        setAnchorIdx(next);
        setSelectedSet(new Set([next]));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, totalCount, hijackFromInputs, selectAll]);

  // Clamp cursor when the dataset shrinks (filter/search). Keep the
  // cursor on the new last row instead of going null — feels less
  // jarring during filtering. Skip when totalCount is still 0 (initial
  // load) so a restored cursor isn't wiped before fetch lands.
  useEffect(() => {
    if (!totalCount) return;
    if (cursorIdx != null && cursorIdx >= totalCount) {
      const last = totalCount - 1;
      setCursorIdxState(last);
      setAnchorIdx(last);
      setSelectedSet(new Set([last]));
    }
    // Also drop any selected indices that are now out of range.
    setSelectedSet((prev) => {
      let changed = false;
      const next = new Set();
      for (const i of prev) {
        if (i < totalCount) next.add(i);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [totalCount, cursorIdx]);

  // ── Convenience derived values ─────────────────────────────────
  const activeRow = cursorIdx != null && rows ? (rows[cursorIdx] ?? null) : null;
  const selectedRows = (() => {
    if (!rows || selectedSet.size === 0) return [];
    const out = [];
    for (const i of selectedSet) {
      const r = rows[i];
      if (r) out.push(r);
    }
    return out;
  })();

  return {
    cursorIdx,
    selectedSet,
    activeRow,
    selectedRows,
    selectionCount: selectedSet.size,
    setCursor,
    toggleRow,
    extendTo,
    selectAll,
    clear,
    collapseToCursor,
  };
}
