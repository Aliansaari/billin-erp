import { useEffect, useRef } from 'react';

/**
 * The active line of a bill's items table — the one last tapped or typed in.
 *
 * Painted as a full-width strip with the # cell filled in the accent, like
 * the barcode label window, and Delete removes it. Kept entirely out of
 * React state: the highlight is one <style> rule keyed on antd's
 * data-row-key, so tapping a line never re-renders the table (see the
 * sales-scan perf invariants) and the strip survives row re-renders.
 *
 * Delete removes the active line when focus is in the table, or when the
 * line was tapped on plain text and nothing else has focus. Typing in the
 * barcode box or any other field is never affected. Focus then moves to the
 * same cell of the line that takes its place, so Delete can be pressed again.
 * onDelete gets the row key as a string (it is read from data-row-key).
 * `shown` re-attaches when the table mounts (it is absent in Amount mode).
 */
export default function useActiveBillLine(wrapRef, onDelete, shown = true) {
  const deleteRef = useRef(onDelete);
  deleteRef.current = onDelete;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const scope = `bl-${Math.random().toString(36).slice(2, 8)}`;
    wrap.setAttribute('data-bill-lines', scope);
    const style = document.createElement('style');
    document.head.appendChild(style);
    let active = null;

    const sel = (key) => `[data-bill-lines="${scope}"] .ant-table-tbody > tr[data-row-key="${CSS.escape(String(key))}"]`;
    const paint = (key) => {
      active = key;
      if (key == null) { style.textContent = ''; return; }
      const row = sel(key);
      style.textContent = `
        ${row} > td, ${row}:hover > td { background: var(--bg-selected) !important; }
        ${row} > td:first-child { background: var(--accent) !important; }
        ${row} > td:first-child, ${row} > td:first-child * { color: #FDFAF2 !important; }
      `;
    };
    const rows = () => Array.from(wrap.querySelectorAll('.ant-table-tbody > tr.ant-table-row'));
    const pick = (e) => {
      const tr = e.target.closest?.('.ant-table-tbody > tr.ant-table-row');
      if (tr && wrap.contains(tr)) paint(tr.getAttribute('data-row-key'));
    };

    const onKey = (e) => {
      if (e.key !== 'Delete' || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.defaultPrevented) return;
      if (active == null) return;
      const focus = document.activeElement;
      const inTable = focus && wrap.contains(focus);
      if (!inTable && focus && focus !== document.body) return;
      const list = rows();
      const at = list.findIndex((tr) => tr.getAttribute('data-row-key') === String(active));
      if (at < 0) { paint(null); return; }
      e.preventDefault();
      e.stopPropagation();
      const td = inTable ? focus.closest('td') : null;
      const col = td ? td.cellIndex : -1;
      deleteRef.current?.(active, at);
      // Once React has drawn the table without it, carry on from the line
      // that moved up into its place (or the new last line).
      setTimeout(() => {
        const left = rows();
        if (!left.length) { paint(null); return; }
        const next = left[Math.min(at, left.length - 1)];
        paint(next.getAttribute('data-row-key'));
        if (col >= 0) {
          const inp = next.cells[col]?.querySelector('input');
          if (inp) { inp.focus(); inp.select?.(); }
        }
      }, 0);
    };

    wrap.addEventListener('focusin', pick);
    wrap.addEventListener('mousedown', pick);
    window.addEventListener('keydown', onKey);
    return () => {
      wrap.removeEventListener('focusin', pick);
      wrap.removeEventListener('mousedown', pick);
      window.removeEventListener('keydown', onKey);
      wrap.removeAttribute('data-bill-lines');
      style.remove();
    };
  }, [wrapRef, shown]);
}
