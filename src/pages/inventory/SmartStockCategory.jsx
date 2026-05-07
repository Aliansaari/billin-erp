import React, { useEffect, useState, useRef, useMemo, useCallback, memo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Input, message, Spin, Empty, Dropdown } from 'antd';
import {
  SearchOutlined, EditOutlined, SaveOutlined, CloseOutlined,
  ArrowLeftOutlined, AppstoreOutlined, SettingOutlined,
} from '@ant-design/icons';
import { reportAPI, categoryAPI, productAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './smart-stock.css';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) =>    parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

function stockTone(v, min) {
  const q = parseFloat(v);
  if (q < 0) return 'neg';
  if (q === 0) return 'out';
  if (parseFloat(min) > 0 && q <= parseFloat(min)) return 'low';
  return 'ok';
}

// ─── Memoised row ────────────────────────────────────────────────────
//
// Held-arrow nav fires 30–50 events/sec. Without memo, every keypress
// triggered a full re-render of all 200+ rows (~30 ms each), which can't
// keep 60 fps. With React.memo, only the row that LOSES highlight and
// the row that GAINS it re-render — 2 rows per keypress regardless of
// dataset size. The shallow-prop comparison works because the parent
// passes stable callbacks (useCallback) and a stable `visibleCols` /
// `gridCols` (useMemo).
const XlsRow = memo(function XlsRow({
  product, rowIdx, visibleCols, gridCols,
  isHighlight, isEditing, activeColKey,
  bulkMode, onCellClick, renderCell,
}) {
  return (
    <div
      data-row={rowIdx}
      className={`xls-row${isEditing ? ' editing' : ''}${isHighlight ? ' bulk-row' : ''}`}
      style={{ gridTemplateColumns: gridCols }}
    >
      {visibleCols.map(col => {
        const isActive = activeColKey === col.key;
        return (
          <div
            key={col.key}
            data-col={col.key}
            className={`xls-cell${col.editable ? ' editable' : ''}${isActive ? ' active' : ''}${col.align === 'right' ? ' r' : col.align === 'center' ? ' c' : ''}`}
            onClick={() => onCellClick(rowIdx, col.key, col.editable)}
          >
            {renderCell(col, product, rowIdx, isEditing, isActive)}
          </div>
        );
      })}
    </div>
  );
});

// ─── Column registry ─────────────────────────────────────────────────
// `group` drives the section grouping in the Customize popover. New
// columns added here automatically appear in the right group with no
// extra wiring. `defaultOff: true` opts a column out of the initial
// preset (useful for fields most users don't need by default).
const COLS = [
  { key: 'sno',           label: '#',           width: 56,   editable: false, always: true, align: 'center', group: 'id' },
  { key: 'barcode',       label: 'Barcode',     width: 120,  editable: false, sort: 'barcode',         group: 'id' },
  { key: 'product_name',  label: 'Product',     flex: 1,     editable: false, sort: 'product_name', always: true, minW: 240, group: 'id' },
  { key: 'size_value',    label: 'Size',        width: 80,   editable: false, group: 'id' },
  { key: 'article',       label: 'Article',     width: 110,  editable: false, sort: 'article_number', defaultOff: true, group: 'id' },
  { key: 'hsn',           label: 'HSN',         width: 90,   editable: false, defaultOff: true, group: 'id' },
  { key: 'gst',           label: 'GST %',       width: 80,   editable: false, defaultOff: true, align: 'right', group: 'id' },
  { key: 'opening',       label: 'Opening',     width: 100,  editable: false, defaultOff: true, align: 'right', sort: 'opening_stock', group: 'qty' },
  { key: 'current_stock', label: 'Stock',       width: 100,  editable: true,  sort: 'current_stock', align: 'right', field: 'current_stock', group: 'qty' },
  { key: 'purchase_rate', label: 'Pur. Rate',   width: 110,  editable: true,  sort: 'purchase_rate', align: 'right', field: 'purchase_rate', group: 'price' },
  { key: 'sale_rate',     label: 'Sale Rate',   width: 110,  editable: true,  sort: 'sale_rate',     align: 'right', field: 'sale_rate',     group: 'price' },
  { key: 'min_stock',     label: 'Min Stock',   width: 90,   editable: true,  align: 'right', field: 'minimum_stock_level', group: 'qty' },
  { key: 'stock_value',   label: 'Stk. Value',  width: 130,  editable: false, sort: 'stock_value',   align: 'right', group: 'price' },
  { key: 'actions',       label: '',            width: 90,   editable: false, align: 'center', always: true, group: 'id' },
];

// Toggleable page sections (parallel to Stock Report's "Page Sections"
// group in its customize popover).
const SEC_DEFS = [
  { key: 'statsBar', label: 'KPI cards (top)' },
  { key: 'totalRow', label: 'Total row (bottom)' },
  { key: 'hintBar',  label: 'Bulk-edit hint bar' },
];

const DEFAULT_VIS = {
  ...Object.fromEntries(COLS.filter(c => !c.always).map(c => [c.key, !c.defaultOff])),
  statsBar: true,
  totalRow: true,
  hintBar:  true,
  // Display mode — 'cells' = Excel-style with full grid + cell focus
  // ring, 'clean' = minimal borders + soft row highlight (the look the
  // rest of the app uses for read-mostly tables).
  viewMode: 'cells',
};
const LS_VIS = 'smart-stock-cat-cols-v3';

function loadVis() {
  try {
    const raw = localStorage.getItem(LS_VIS);
    return raw ? { ...DEFAULT_VIS, ...JSON.parse(raw) } : { ...DEFAULT_VIS };
  } catch { return { ...DEFAULT_VIS }; }
}

export default function SmartStockCategory() {
  const { categoryId } = useParams();
  const navigate = useNavigate();
  const catIdParam = categoryId === 'none' ? null : parseInt(categoryId, 10);

  const [products, setProducts] = useState([]);
  const [category, setCategory] = useState(null);
  const [loading,  setLoading]  = useState(false);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('product_name');
  const [sortDir, setSortDir] = useState('ASC');
  const [colVis, setColVis] = useState(loadVis);
  useEffect(() => { try { localStorage.setItem(LS_VIS, JSON.stringify(colVis)); } catch {} }, [colVis]);

  // ── single-row edit ──
  const [editingId, setEditingId] = useState(null);
  const [editBuf,   setEditBuf]   = useState({});
  const [saving,    setSaving]    = useState(false);

  // ── bulk edit ──
  const [bulkMode,   setBulkMode]   = useState(false);
  const [bulkData,   setBulkData]   = useState({});
  const [activeCell, setActiveCell] = useState(null); // { rowIdx, colKey }
  const [bulkSaving, setBulkSaving] = useState(false);

  // ── view-mode cell selection ──
  // Cursor position in view mode — { rowIdx, colKey } | null. Reuses
  // the bulk-mode cell + row visual treatment. ↑/↓ move rows, ←/→
  // move across visible columns, Home/End jump to first/last row,
  // Enter starts single-row edit on the row, Esc clears.
  const [viewCell, setViewCell] = useState(null);

  // ── adjusted tracking ──
  const [adjustedProducts, setAdjustedProducts] = useState({});

  const cellInputRefs = useRef({});
  const bodyRef       = useRef(null);
  const searchInputRef = useRef(null);

  // Refresh trigger — re-runs the products fetch effect by bumping a
  // counter included in its dep list, mirroring the StockReportPro
  // pattern.
  const [refreshCount, setRefreshCount] = useState(0);

  // Excel export of the current category — mirrors StockReport.handleExport
  // (calls reportAPI.exportStockReport with the same filter shape).
  const handleExport = async () => {
    try {
      const params = {};
      if (search)         params.search      = search;
      if (catIdParam)     params.category_id = catIdParam;
      const { data } = await reportAPI.exportStockReport(params);
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock_${(category?.category_name || 'category').replace(/\s+/g, '-').toLowerCase()}_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  // ─── fetch products in this category ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const doFetch = async () => {
      setLoading(true);
      try {
        const params = {
          category_id: catIdParam ?? undefined,
          sort_by: 'product_name', sort_dir: 'ASC',
          page: 1, limit: 99999,
        };
        const r = await reportAPI.getStockReport(params);
        if (cancelled) return;
        const all = r.data?.data || [];
        // Server filter is best-effort — also drop client-side anything
        // that doesn't match the category, in case the endpoint returns
        // extras (e.g. uncategorised when called with category_id null).
        const list = catIdParam == null
          ? all.filter(p => p.category_id == null)
          : all.filter(p => p.category_id === catIdParam);
        setProducts(list);
      } catch { if (!cancelled) message.error('Failed to load products'); }
      if (!cancelled) setLoading(false);
    };
    doFetch();
    return () => { cancelled = true; };
  }, [catIdParam, refreshCount]);

  // ─── fetch category metadata for the title ─────────────────────────
  useEffect(() => {
    if (catIdParam == null) { setCategory({ category_name: 'Uncategorised' }); return; }
    categoryAPI.getAllFlat()
      .then(r => {
        const found = (r.data || []).find(c => c.category_id === catIdParam);
        setCategory(found || { category_name: `Category ${catIdParam}` });
      })
      .catch(() => setCategory({ category_name: `Category ${catIdParam}` }));
  }, [catIdParam]);

  // ─── derived: filtered + sorted ─────────────────────────────────
  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = products;
    if (q) {
      rows = rows.filter(p =>
        p.product_name?.toLowerCase().includes(q) ||
        p.barcode?.toLowerCase().includes(q) ||
        p.article_number?.toLowerCase().includes(q)
      );
    }
    return [...rows].sort((a, b) => {
      let av, bv;
      if (sortKey === 'stock_value') {
        // Mode-aware via display_stock_value (server-attached); legacy
        // formula stays as fallback for rows that pre-date enrichment.
        av = parseFloat(a.display_stock_value ?? (parseFloat(a.current_stock || 0) * parseFloat(a.purchase_rate || 0)));
        bv = parseFloat(b.display_stock_value ?? (parseFloat(b.current_stock || 0) * parseFloat(b.purchase_rate || 0)));
      } else if (sortKey === 'purchase_rate') {
        // Sort by the same value the column displays — display_cost
        // (mode-aware) for single / single+batch, purchase_rate for
        // variant. Falls back to purchase_rate when display_cost is
        // missing (older/cached rows).
        av = parseFloat(a.display_cost ?? a.purchase_rate ?? 0);
        bv = parseFloat(b.display_cost ?? b.purchase_rate ?? 0);
      } else if (['current_stock', 'sale_rate'].includes(sortKey)) {
        av = parseFloat(a[sortKey] || 0);
        bv = parseFloat(b[sortKey] || 0);
      } else {
        av = (a[sortKey] || '').toString().toLowerCase();
        bv = (b[sortKey] || '').toString().toLowerCase();
      }
      if (av < bv) return sortDir === 'ASC' ? -1 : 1;
      if (av > bv) return sortDir === 'ASC' ?  1 : -1;
      return 0;
    });
  }, [products, search, sortKey, sortDir]);

  // ─── derived: stats ──────────────────────────────────────────────
  // Stock value (`pur`) and profit potential aggregate against the
  // mode-aware basis. display_stock_value is server-attached for the
  // SUM(stock × cost); display_cost feeds the unit-cost path used by
  // single+batch rows whose `current_stock × display_cost` would
  // diverge from display_stock_value (display_stock_value is the SUM
  // of qty×rate per batch, not stock × weighted-average). Variant rows
  // collapse to the legacy formula since display_cost === purchase_rate.
  const stats = useMemo(() => {
    if (!visibleProducts.length) return null;
    let qty = 0, pur = 0, sale = 0, neg = 0, out = 0, low = 0;
    visibleProducts.forEach(p => {
      const q = parseFloat(p.current_stock || 0);
      const sr = parseFloat(p.sale_rate || 0);
      const mn = parseFloat(p.minimum_stock_level || 0);
      const stockValue = parseFloat(
        p.display_stock_value ?? (q * parseFloat(p.purchase_rate || 0)),
      );
      qty += q; pur += stockValue; sale += q * sr;
      if (q < 0) neg++;
      else if (q === 0) out++;
      else if (mn > 0 && q <= mn) low++;
    });
    return { count: visibleProducts.length, qty, pur, sale, profit: sale - pur, neg, out, low };
  }, [visibleProducts]);

  // ─── visible columns + grid template ─────────────────────────────
  const visibleCols = useMemo(
    () => COLS.filter(c => c.always || colVis[c.key]),
    [colVis]
  );
  const gridCols = useMemo(
    () => visibleCols.map(c => c.flex ? `minmax(${c.minW || 150}px, 1fr)` : `${c.width}px`).join(' '),
    [visibleCols]
  );

  // ─── focus active cell + scroll into view ────────────────────────
  // `block: 'nearest'` scrolls the .xls-body container only as far as
  // needed to bring the cell into view — no jump if it's already
  // visible, no scroll-to-top when navigating row 1, and the smallest
  // possible movement when navigating off the bottom edge. This is the
  // "page scrolls only when the arrow goes off the bottom" behavior.
  useEffect(() => {
    if (!activeCell) return;
    const el = cellInputRefs.current[`${activeCell.rowIdx}-${activeCell.colKey}`];
    if (el) {
      el.focus();
      el.select();
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeCell]);

  // ─── view-mode keyboard nav (cell-level) ─────────────────────────
  // Listener attached at the document level so navigation works
  // without a focused element. We use refs for the per-render values
  // so the handler doesn't get re-bound on every selection change
  // (which was the source of the laggy feel — re-binding each frame
  // means the document gets a fresh listener for every arrow press).
  const navRefs = useRef({ visibleProducts, viewCell, editingId, visibleCols });
  useEffect(() => {
    navRefs.current = { visibleProducts, viewCell, editingId, visibleCols };
  });

  useEffect(() => {
    if (bulkMode) return;
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const { visibleProducts: vp, viewCell: vc, editingId: ed, visibleCols: vcols } = navRefs.current;
      if (!vp.length) return;
      const maxRow = vp.length - 1;
      // Skip the leading '#' (sno) and trailing 'actions' columns —
      // they aren't info-cells the user wants to land on.
      const navCols = vcols.map(c => c.key).filter(k => k !== 'sno' && k !== 'actions');
      if (!navCols.length) return;
      const curRow = vc?.rowIdx ?? 0;
      const curCol = vc?.colKey ?? navCols[0];
      const colIdx = Math.max(0, navCols.indexOf(curCol));
      let nextRow = curRow, nextCol = curCol;

      if (e.key === 'ArrowDown')      { nextRow = Math.min(curRow + 1, maxRow); }
      else if (e.key === 'ArrowUp')   { nextRow = Math.max(curRow - 1, 0); }
      else if (e.key === 'ArrowRight'){ nextCol = navCols[Math.min(colIdx + 1, navCols.length - 1)]; }
      else if (e.key === 'ArrowLeft') { nextCol = navCols[Math.max(colIdx - 1, 0)]; }
      else if (e.key === 'Home')      { nextRow = 0; }
      else if (e.key === 'End')       { nextRow = maxRow; }
      else if (e.key === 'Enter') {
        if (vc) { e.preventDefault(); startEdit(vp[vc.rowIdx]); }
        return;
      } else if (e.key === 'Escape') {
        if (ed) cancelEdit();
        else setViewCell(null);
        return;
      } else { return; }

      e.preventDefault();
      // Only commit a new state if something actually changed (keeps
      // React from re-rendering when the user holds an arrow at the
      // edge of the table).
      if (nextRow !== curRow || nextCol !== curCol || vc == null) {
        setViewCell({ rowIdx: nextRow, colKey: nextCol });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [bulkMode]);

  // Scroll the active cell (or row, if no col known) into view.
  // `behavior: 'instant'` so it doesn't ride a smooth-scroll animation
  // on every keystroke (which the user perceives as lag). Uses
  // querySelector against data attributes to avoid keeping per-row
  // refs (which would invalidate the row's React.memo each render).
  useEffect(() => {
    if (viewCell == null) return;
    const rowEl = document.querySelector(`.xls-row[data-row="${viewCell.rowIdx}"]`);
    const cellEl = rowEl?.querySelector(`.xls-cell[data-col="${viewCell.colKey}"]`);
    const target = cellEl || rowEl;
    if (target) {
      try { target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); }
      catch { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    }
  }, [viewCell]);

  // Clearing selection when the dataset shrinks (filter/search changes
  // could push the selected row out of bounds).
  useEffect(() => {
    if (viewCell && viewCell.rowIdx >= visibleProducts.length) {
      setViewCell(visibleProducts.length
        ? { rowIdx: visibleProducts.length - 1, colKey: viewCell.colKey }
        : null);
    }
  }, [visibleProducts.length, viewCell]);

  // ─── handlers ────────────────────────────────────────────────────
  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'ASC' ? 'DESC' : 'ASC');
    else { setSortKey(key); setSortDir('ASC'); }
  };
  const today = () => new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const startEdit = (p) => {
    if (bulkMode) return;
    setEditingId(p.product_id);
    setEditBuf({
      current_stock: p.current_stock,
      purchase_rate: p.purchase_rate,
      sale_rate: p.sale_rate,
      minimum_stock_level: p.minimum_stock_level,
    });
  };
  const cancelEdit = () => { setEditingId(null); setEditBuf({}); };
  const saveEdit = async (productId) => {
    setSaving(true);
    try {
      await productAPI.adjust(productId, editBuf);
      setProducts(prev => prev.map(p => p.product_id === productId ? { ...p, ...editBuf } : p));
      setAdjustedProducts(prev => ({ ...prev, [productId]: today() }));
      setEditingId(null); setEditBuf({});
      message.success('Product updated');
    } catch { message.error('Failed to save'); }
    setSaving(false);
  };

  const enterBulkMode = () => {
    setEditingId(null); setEditBuf({});
    setViewCell(null); // view-mode selection is meaningless in bulk
    const data = {};
    visibleProducts.forEach(p => {
      data[p.product_id] = {
        current_stock:       p.current_stock       ?? '',
        purchase_rate:       p.purchase_rate       ?? '',
        sale_rate:           p.sale_rate           ?? '',
        minimum_stock_level: p.minimum_stock_level ?? '',
      };
    });
    setBulkData(data); setBulkMode(true);
    // Auto-focus the first editable cell so the user can start typing.
    const firstEditable = visibleCols.find(c => c.editable);
    if (firstEditable && visibleProducts.length > 0) {
      setActiveCell({ rowIdx: 0, colKey: firstEditable.key });
    }
  };
  const exitBulkMode = () => { setBulkMode(false); setBulkData({}); setActiveCell(null); };

  const handleBulkCellChange = (productId, fieldKey, value) =>
    setBulkData(prev => ({ ...prev, [productId]: { ...prev[productId], [fieldKey]: value } }));

  // Excel-style key handling: arrows / Tab / Enter all navigate.
  const handleBulkKeyDown = (e, rowIdx, colKey) => {
    const keys = ['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Tab','Enter','Escape'];
    if (!keys.includes(e.key)) return;
    if (e.key === 'Escape') { setActiveCell(null); e.target.blur(); return; }
    e.preventDefault();
    const editableCols = visibleCols.filter(c => c.editable).map(c => c.key);
    const colIdx = editableCols.indexOf(colKey);
    let nextRow = rowIdx, nextCol = colKey;
    const rows = visibleProducts.length;

    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      nextRow = (rowIdx + 1) % rows; // wrap
    } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
      nextRow = (rowIdx - 1 + rows) % rows;
    } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
      if (colIdx < editableCols.length - 1) nextCol = editableCols[colIdx + 1];
      else { nextRow = (rowIdx + 1) % rows; nextCol = editableCols[0]; }
    } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
      if (colIdx > 0) nextCol = editableCols[colIdx - 1];
      else { nextRow = (rowIdx - 1 + rows) % rows; nextCol = editableCols[editableCols.length - 1]; }
    }
    setActiveCell({ rowIdx: nextRow, colKey: nextCol });
  };

  // Count of cells with pending changes (shown in the save bar).
  const pendingCount = useMemo(() => {
    if (!bulkMode) return 0;
    let n = 0;
    visibleProducts.forEach(p => {
      const curr = bulkData[p.product_id];
      if (!curr) return;
      if (
        String(curr.current_stock)       !== String(p.current_stock       ?? '') ||
        String(curr.purchase_rate)       !== String(p.purchase_rate       ?? '') ||
        String(curr.sale_rate)           !== String(p.sale_rate           ?? '') ||
        String(curr.minimum_stock_level) !== String(p.minimum_stock_level ?? '')
      ) n++;
    });
    return n;
  }, [bulkMode, bulkData, visibleProducts]);

  const saveBulkEdit = async () => {
    setBulkSaving(true);
    const dateStr = today();
    let successCount = 0;
    const newAdjusted = { ...adjustedProducts };

    for (const p of visibleProducts) {
      const curr = bulkData[p.product_id];
      if (!curr) continue;
      const changed = (
        String(curr.current_stock)       !== String(p.current_stock       ?? '') ||
        String(curr.purchase_rate)       !== String(p.purchase_rate       ?? '') ||
        String(curr.sale_rate)           !== String(p.sale_rate           ?? '') ||
        String(curr.minimum_stock_level) !== String(p.minimum_stock_level ?? '')
      );
      if (!changed) continue;
      try {
        await productAPI.adjust(p.product_id, curr);
        setProducts(prev => prev.map(pr => pr.product_id === p.product_id ? { ...pr, ...curr } : pr));
        newAdjusted[p.product_id] = dateStr;
        successCount++;
      } catch { /* skip failed */ }
    }
    setAdjustedProducts(newAdjusted);
    if (successCount > 0) message.success(`${successCount} product(s) updated`);
    setBulkSaving(false);
    exitBulkMode();
  };

  // ─── cell render ─────────────────────────────────────────────────
  // Memoised so XlsRow's React.memo can hold across arrow nav. Deps
  // intentionally cover only the state slices the render reads — adding
  // anything else would make every key press invalidate every row.
  const renderCellBody = useCallback((col, p, rowIdx, isEditing, isActive) => {
    const stock = parseFloat(p.current_stock || 0);
    const tone  = stockTone(stock, p.minimum_stock_level);
    // Mode-aware stock value via display_stock_value; legacy fallback
    // matches what the row would compute against the master purchase_rate.
    const stVal = parseFloat(
      p.display_stock_value ?? (stock * parseFloat(p.purchase_rate || 0)),
    );

    if (bulkMode && col.editable) {
      return (
        <input
          ref={(el) => { cellInputRefs.current[`${rowIdx}-${col.key}`] = el; }}
          type="number"
          className={`xls-input${isActive ? ' active' : ''}`}
          value={bulkData[p.product_id]?.[col.field] ?? ''}
          onChange={(e) => handleBulkCellChange(p.product_id, col.field, e.target.value)}
          onKeyDown={(e) => handleBulkKeyDown(e, rowIdx, col.key)}
          onFocus={() => setActiveCell({ rowIdx, colKey: col.key })}
        />
      );
    }
    if (isEditing && col.editable) {
      return (
        <input
          type="number"
          className="xls-input active"
          value={editBuf[col.field] ?? ''}
          onChange={(e) => setEditBuf(b => ({ ...b, [col.field]: e.target.value }))}
        />
      );
    }

    switch (col.key) {
      case 'sno':         return <span className="ss-cell-sno">{rowIdx + 1}</span>;
      case 'barcode':     return <span className="ss-cell-bc">{p.barcode || '—'}</span>;
      case 'article':     return <span className="ss-cell-bc">{p.article_number || '—'}</span>;
      case 'hsn':         return <span className="ss-cell-bc">{p.hsn_code || '—'}</span>;
      case 'gst':         return <span className="ss-cell-min">{p.gst_rate != null ? `${parseFloat(p.gst_rate).toFixed(0)}%` : '—'}</span>;
      case 'opening':     return <span className="ss-cell-pur">{fmtN(p.opening_stock || 0)}</span>;
      case 'product_name':
        return (
          <div className="ss-cell-prod">
            <span className="ss-cell-prod-name">{p.product_name}</span>
            {adjustedProducts[p.product_id] && (
              <span className="ss-cell-prod-meta">Adjusted {adjustedProducts[p.product_id]}</span>
            )}
          </div>
        );
      case 'size_value':  return <span className="ss-cell-size">{p.size_value || '—'}</span>;
      case 'current_stock': return <span className={`ss-cell-stk ${tone}`}>{fmtN(stock)}</span>;
      case 'purchase_rate': return <span className="ss-cell-pur">{fmt(p.display_cost ?? p.purchase_rate)}</span>;
      case 'sale_rate':     return <span className="ss-cell-sale">{fmt(p.sale_rate)}</span>;
      case 'min_stock':     return <span className="ss-cell-min">{p.minimum_stock_level || '—'}</span>;
      case 'stock_value':   return <span className="ss-cell-val">{fmt(stVal)}</span>;
      case 'actions':
        if (bulkMode) return null;
        if (isEditing) return (
          <div className="xls-row-actions">
            <button className="ss-row-action save" onClick={() => saveEdit(p.product_id)} disabled={saving}>
              {saving ? <Spin size="small" /> : <SaveOutlined />}
            </button>
            <button className="ss-row-action" onClick={cancelEdit}><CloseOutlined /></button>
          </div>
        );
        return (
          <div className="xls-row-actions">
            <button className="ss-row-action" onClick={() => startEdit(p)}><EditOutlined /></button>
          </div>
        );
      default: return null;
    }
  // Stable across arrow nav (none of these deps change while pressing
  // arrows). The inline handlers (saveEdit/startEdit/etc) are
  // intentionally not in deps — re-creating renderCellBody on every
  // parent render would defeat XlsRow's React.memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkMode, bulkData, editBuf, adjustedProducts, saving]);

  // Stable cell-click dispatcher. Bulk mode → activeCell; view mode →
  // viewCell (excluding sno + actions which aren't info-cells).
  const onCellClick = useCallback((rowIdx, colKey, editable) => {
    if (bulkMode && editable) {
      setActiveCell({ rowIdx, colKey });
    } else if (!bulkMode && colKey !== 'sno' && colKey !== 'actions') {
      setViewCell({ rowIdx, colKey });
    }
  }, [bulkMode]);

  /* Customize popover — grouped by Identifiers / Quantity / Pricing,
     plus Display radios + Page Sections. Uses the shared `.cols-menu`
     markup so the global customize-menu styles drive the look. */
  const renderColGroup = (groupKey) =>
    COLS.filter(c => c.group === groupKey && !c.always).map(col => (
      <label key={col.key} className="opt">
        <input
          type="checkbox"
          checked={!!colVis[col.key]}
          onChange={() => setColVis(v => ({ ...v, [col.key]: !v[col.key] }))}
        />
        <span>{col.label}</span>
      </label>
    ));

  const customizePopover = (
    <div className="cols-menu">
      <div className="grp">
        <div className="gh">
          <span>Identifiers</span>
          <button className="gh-reset" type="button" onClick={() => setColVis({ ...DEFAULT_VIS })}>Reset</button>
        </div>
        {renderColGroup('id')}
      </div>
      <div className="grp">
        <div className="gh"><span>Quantity</span></div>
        {renderColGroup('qty')}
      </div>
      <div className="grp">
        <div className="gh"><span>Pricing &amp; Value</span></div>
        {renderColGroup('price')}
      </div>
      <div className="grp">
        <div className="gh"><span>Display</span></div>
        {/* Radios use the same .opt row styling as the checkboxes — the
         * accent-rail-on-checked treatment fires off any input:checked
         * inside an .opt label, so radios light up the same way. */}
        <label className="opt">
          <input
            type="radio"
            name="viewMode"
            checked={colVis.viewMode === 'cells'}
            onChange={() => setColVis(v => ({ ...v, viewMode: 'cells' }))}
          />
          <span><b>Cell grid</b> <span style={{color:'var(--fg-tertiary)',fontWeight:500,fontSize:11}}>· Excel-style</span></span>
        </label>
        <label className="opt">
          <input
            type="radio"
            name="viewMode"
            checked={colVis.viewMode === 'clean'}
            onChange={() => setColVis(v => ({ ...v, viewMode: 'clean' }))}
          />
          <span><b>Clean table</b> <span style={{color:'var(--fg-tertiary)',fontWeight:500,fontSize:11}}>· Minimal borders</span></span>
        </label>
      </div>
      <div className="grp">
        <div className="gh"><span>Page Sections</span></div>
        {SEC_DEFS.map(s => (
          <label key={s.key} className="opt">
            <input
              type="checkbox"
              checked={!!colVis[s.key]}
              onChange={() => setColVis(v => ({ ...v, [s.key]: !v[s.key] }))}
            />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="ss-page">

      {/* HEADER — back / breadcrumb / title / actions */}
      <div className="ss-hd ss-hd-cat">
        <div className="ss-cat-back">
          <button className="ss-btn" onClick={() => navigate('/stock-report-pro')}>
            <ArrowLeftOutlined /> Back
          </button>
          <div className="ss-crumbs">
            <span onClick={() => navigate('/stock-report-pro')} className="crumb-link">
              <AppstoreOutlined /> Smart Stock
            </span>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{category?.category_name || 'Category'}</span>
          </div>
        </div>
        <div className="ss-ctrls">
          <div className="ss-search">
            <SearchOutlined />
            <input
              ref={searchInputRef}
              placeholder="Search product, barcode, article…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Dropdown trigger={['click']} placement="bottomRight" dropdownRender={() => customizePopover}>
            <button className="ss-btn"><SettingOutlined /> Customize</button>
          </Dropdown>
          {!bulkMode ? (
            <button className="ss-btn primary" onClick={enterBulkMode}>
              <EditOutlined /> Bulk Edit
            </button>
          ) : (
            <>
              <button className="ss-btn primary" onClick={saveBulkEdit} disabled={bulkSaving}>
                {bulkSaving ? <Spin size="small" /> : <SaveOutlined />} Save All ({pendingCount})
              </button>
              <button className="ss-btn" onClick={exitBulkMode}>
                <CloseOutlined /> Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* STATS BAR */}
      {colVis.statsBar && stats && (
        <div className="ss-modal-stats">
          <div className="ss-modal-stat qty"><div className="ss-modal-stat-v">{fmtN(stats.qty)}</div><div className="ss-modal-stat-l">Total Qty</div></div>
          <div className="ss-modal-stat pur"><div className="ss-modal-stat-v">{fmt(stats.pur)}</div><div className="ss-modal-stat-l">Purchase Val</div></div>
          <div className="ss-modal-stat sale"><div className="ss-modal-stat-v">{fmt(stats.sale)}</div><div className="ss-modal-stat-l">Sale Value</div></div>
          <div className="ss-modal-stat profit"><div className="ss-modal-stat-v">{fmt(stats.profit)}</div><div className="ss-modal-stat-l">Profit</div></div>
          <div className="ss-modal-stat"><div className="ss-modal-stat-v">{stats.count}</div><div className="ss-modal-stat-l">Shown</div></div>
          <div className="ss-modal-stat neg"><div className="ss-modal-stat-v">{stats.neg}</div><div className="ss-modal-stat-l">Negative</div></div>
          <div className="ss-modal-stat out"><div className="ss-modal-stat-v">{stats.out}</div><div className="ss-modal-stat-l">Out of Stock</div></div>
          <div className="ss-modal-stat low"><div className="ss-modal-stat-v">{stats.low}</div><div className="ss-modal-stat-l">Low Stock</div></div>
        </div>
      )}

      {/* BULK-MODE HINT BAR */}
      {bulkMode && colVis.hintBar && (
        <div className="xls-hint-bar">
          <span><b>Bulk Edit</b> — click any cell or use the keyboard:</span>
          <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd>
          <span className="hint-sep">·</span>
          <kbd>Tab</kbd>/<kbd>Shift+Tab</kbd>
          <span className="hint-sep">·</span>
          <kbd>Enter</kbd> next row
          <span className="hint-sep">·</span>
          <kbd>Esc</kbd> exit cell
          <span className="hint-spacer" />
          <span className="hint-pending">{pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}</span>
        </div>
      )}

      {/* EXCEL-LIKE GRID */}
      <div className={`xls-wrap${colVis.viewMode === 'clean' ? ' clean-mode' : ''}`}>
        <div className="xls-head" style={{ gridTemplateColumns: gridCols }}>
          {visibleCols.map(col => {
            const active = sortKey === col.sort && col.sort;
            return (
              <div
                key={col.key}
                className={`xls-th${col.sort ? ' sortable' : ''}${active ? ' active' : ''}${col.align === 'right' ? ' r' : col.align === 'center' ? ' c' : ''}`}
                onClick={col.sort ? () => handleSort(col.sort) : undefined}
              >
                {col.label}
                {col.sort && (
                  <span className="arrow">{active ? (sortDir === 'ASC' ? '↑' : '↓') : '↕'}</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="xls-body" ref={bodyRef}>
          {loading ? (
            <div className="ss-empty"><Spin /> <div style={{ marginTop: 12 }}>Loading…</div></div>
          ) : visibleProducts.length === 0 ? (
            <Empty description={search ? 'No products match the search' : 'No products in this category'} style={{ marginTop: 60 }} />
          ) : visibleProducts.map((p, idx) => {
            const activeRowIdx = bulkMode ? activeCell?.rowIdx : viewCell?.rowIdx;
            const activeColKey = (activeRowIdx === idx)
              ? (bulkMode ? activeCell.colKey : viewCell?.colKey ?? null)
              : null;
            return (
              <XlsRow
                key={p.product_id}
                product={p}
                rowIdx={idx}
                visibleCols={visibleCols}
                gridCols={gridCols}
                isHighlight={activeRowIdx === idx}
                isEditing={!bulkMode && editingId === p.product_id}
                activeColKey={activeColKey}
                bulkMode={bulkMode}
                onCellClick={onCellClick}
                renderCell={renderCellBody}
              />
            );
          })}
        </div>

        {/* Sticky bottom totals row — column-aligned with the table head.
            Pinned to the bottom of `.xls-wrap` (which is a flex column);
            `.xls-body` scrolls in the middle, head + foot stay put. */}
        {colVis.totalRow && stats && visibleProducts.length > 0 && (
          <div className="xls-foot" style={{ gridTemplateColumns: gridCols }}>
            {visibleCols.map((col, i) => {
              const cls = `xls-foot-cell${col.align === 'right' ? ' r' : col.align === 'center' ? ' c' : ''}`;
              if (col.key === 'product_name') {
                return <div key={col.key} className={`${cls} label`}>Total · {stats.count} item{stats.count === 1 ? '' : 's'}</div>;
              }
              if (col.key === 'current_stock') {
                return <div key={col.key} className={`${cls} qty`}>{fmtN(stats.qty)}</div>;
              }
              if (col.key === 'stock_value') {
                return <div key={col.key} className={`${cls} val`}>{fmt(stats.pur)}</div>;
              }
              // For purchase / sale rate columns we surface the *value*
              // total too (sum of qty × rate) so all three columns are
              // useful at a glance — not the average rate (which would
              // mislead at a category level).
              if (col.key === 'sale_rate') {
                return <div key={col.key} className={`${cls} sale`}>{fmt(stats.sale)}</div>;
              }
              return <div key={col.key} className={cls} />;
            })}
          </div>
        )}
      </div>

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate('/stock-report-pro'),
          },
          {
            id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus?.(),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => setRefreshCount(c => c + 1),
          },
          {
            id: 'print', key: 'F9', label: 'Print',
            onAction: () => window.print(),
          },
          {
            id: 'export', key: 'F10', label: 'Export',
            onAction: handleExport,
          },
        ]}
      />
    </div>
  );
}
