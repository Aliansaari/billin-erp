import React, { useEffect, useState, useRef, useMemo, useCallback, memo } from 'react';
import { Input, Select, message, Spin, Empty, Upload, Modal, Progress, Tooltip } from 'antd';
import {
  SearchOutlined, DownloadOutlined, UploadOutlined, WarningOutlined,
  CheckCircleOutlined, CloseCircleOutlined, FileExcelOutlined, EditOutlined,
  SaveOutlined, CloseOutlined,
} from '@ant-design/icons';
import { reportAPI, categoryAPI, dataAPI, productAPI } from '../../api';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) =>    parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const getStockStyle = (v, min) => {
  const n = parseFloat(v);
  if (n <= 0)                          return { bg: '#fef2f2', color: '#dc2626' };
  if (min > 0 && n <= parseFloat(min)) return { bg: '#fffbeb', color: '#d97706' };
  return                                      { bg: '#f0fdf4', color: '#16a34a' };
};

// ─── Modal column definitions ─────────────────────────────────────────────────
const MODAL_COLS = [
  { key: 'barcode',       label: 'Barcode',    sortKey: null,            width: 110, editable: false },
  { key: 'product_name',  label: 'Product',    sortKey: 'product_name',  flex: 1,    editable: false, always: true },
  { key: 'size_value',    label: 'Size',       sortKey: null,            width: 70,  editable: false },
  { key: 'current_stock', label: 'Stock',      sortKey: 'current_stock', width: 90,  editable: true  },
  { key: 'purchase_rate', label: 'Pur. Rate',  sortKey: 'purchase_rate', width: 115, editable: true  },
  { key: 'sale_rate',     label: 'Sale Rate',  sortKey: 'sale_rate',     width: 115, editable: true  },
  { key: 'min_stock',     label: 'Min Stock',  sortKey: null,            width: 85,  editable: true  },
  { key: 'stock_value',   label: 'Stk. Value', sortKey: 'stock_value',   width: 120, editable: false },
];
const DEFAULT_MODAL_VIS = Object.fromEntries(MODAL_COLS.filter(c => !c.always).map(c => [c.key, true]));

// ─── Memoized category row ────────────────────────────────────────────────────
const CategoryRow = memo(({ cat, onClick }) => (
  <div
    onClick={() => onClick(cat)}
    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 24px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', cursor: 'pointer', transition: 'background .12s' }}
    onMouseEnter={e => e.currentTarget.style.background = '#eff6ff'}
    onMouseLeave={e => e.currentTarget.style.background = '#f8fafc'}
  >
    <EditOutlined style={{ fontSize: 12, color: '#94a3b8', flexShrink: 0 }} />
    <span style={{ fontSize: 13, fontWeight: 700, color: '#1e293b', flex: 1 }}>{cat.category_name || 'Uncategorized'}</span>
    <span style={{ fontSize: 12, color: '#64748b', background: '#e2e8f0', borderRadius: 12, padding: '2px 10px', fontWeight: 600 }}>{cat.item_count?.toLocaleString()} items</span>
    <span style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', minWidth: 110, textAlign: 'right' }}>{fmt(cat.stock_value)}</span>
  </div>
));

// ─── Main component ───────────────────────────────────────────────────────────
export default function StockReportPro() {

  // ── data ──
  const [products,          setProducts]          = useState([]);
  const [summary,           setSummary]           = useState({});
  const [categoryBreakdown, setCategoryBreakdown] = useState([]);
  const [categories,        setCategories]        = useState([]);
  const [loading,           setLoading]           = useState(false);
  const [refreshCount,      setRefreshCount]      = useState(0);

  // ── import ──
  const [importing,      setImporting]      = useState(false);
  const [importModal,    setImportModal]    = useState(false);
  const [importResult,   setImportResult]   = useState(null);
  const [importProgress, setImportProgress] = useState(0);
  const [importPhase,    setImportPhase]    = useState('');
  const [dlFailed,       setDlFailed]       = useState(false);

  // ── filters (main list) ──
  const [searchInput, setSearchInput] = useState('');
  const [search,      setSearch]      = useState('');
  const [categoryId,  setCategoryId]  = useState(null);
  const [stockStatus, setStockStatus] = useState(null);

  // ── category modal ──
  const [catModal,     setCatModal]     = useState(null);
  const [modalSortKey, setModalSortKey] = useState('product_name');
  const [modalSortDir, setModalSortDir] = useState('ASC');
  const [modalSearch,  setModalSearch]  = useState('');
  const [modalColVis,  setModalColVis]  = useState(DEFAULT_MODAL_VIS);

  // ── single row edit ──
  const [editingId, setEditingId] = useState(null);
  const [editBuf,   setEditBuf]   = useState({});
  const [saving,    setSaving]    = useState(false);

  // ── adjusted tracking ──
  const [adjustedProducts, setAdjustedProducts] = useState({});

  // ── bulk edit ──
  const [bulkMode,   setBulkMode]   = useState(false);
  const [bulkData,   setBulkData]   = useState({});
  const [activeCell, setActiveCell] = useState(null); // { rowIdx, colKey }
  const [bulkSaving, setBulkSaving] = useState(false);

  // ── column dropdown ──
  const [colDropOpen, setColDropOpen] = useState(false);
  const colDropRef    = useRef(null);
  const cellInputRefs = useRef({});
  const searchTimer   = useRef(null);

  // ─── grouped products (cached) ────────────────────────────────────────────
  const groupedProducts = useMemo(() => {
    const map = new Map();
    products.forEach(p => {
      const k = p.category_id ?? '__none__';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    });
    return map;
  }, [products]);

  // ─── modal products — sorted ──────────────────────────────────────────────
  const modalProducts = useMemo(() => {
    if (!catModal) return [];
    const catId = catModal.category_id ?? '__none__';
    const rows  = groupedProducts.get(catId) || [];
    return [...rows].sort((a, b) => {
      let av, bv;
      if (modalSortKey === 'stock_value') {
        av = parseFloat(a.current_stock || 0) * parseFloat(a.purchase_rate || 0);
        bv = parseFloat(b.current_stock || 0) * parseFloat(b.purchase_rate || 0);
      } else if (['current_stock', 'purchase_rate', 'sale_rate'].includes(modalSortKey)) {
        av = parseFloat(a[modalSortKey] || 0);
        bv = parseFloat(b[modalSortKey] || 0);
      } else {
        av = (a[modalSortKey] || '').toString().toLowerCase();
        bv = (b[modalSortKey] || '').toString().toLowerCase();
      }
      if (av < bv) return modalSortDir === 'ASC' ? -1 : 1;
      if (av > bv) return modalSortDir === 'ASC' ? 1 : -1;
      return 0;
    });
  }, [catModal, groupedProducts, modalSortKey, modalSortDir]);

  // ─── modal products — search filtered ────────────────────────────────────
  const filteredModalProducts = useMemo(() => {
    const q = modalSearch.trim().toLowerCase();
    if (!q) return modalProducts;
    return modalProducts.filter(p =>
      p.product_name?.toLowerCase().includes(q) ||
      p.barcode?.toLowerCase().includes(q) ||
      p.article_number?.toLowerCase().includes(q)
    );
  }, [modalProducts, modalSearch]);

  // ─── modal statistics ─────────────────────────────────────────────────────
  const modalStats = useMemo(() => {
    const rows = filteredModalProducts;
    if (!rows.length) return null;
    let totalQty = 0, totalPurVal = 0, totalSaleVal = 0, totalPurRate = 0, outOfStock = 0, lowStock = 0;
    rows.forEach(p => {
      const qty  = parseFloat(p.current_stock  || 0);
      const pur  = parseFloat(p.purchase_rate  || 0);
      const sale = parseFloat(p.sale_rate      || 0);
      const min  = parseFloat(p.minimum_stock_level || 0);
      totalQty     += qty;
      totalPurVal  += qty * pur;
      totalSaleVal += qty * sale;
      totalPurRate += pur;
      if (qty <= 0)               outOfStock++;
      else if (min > 0 && qty <= min) lowStock++;
    });
    return { count: rows.length, totalQty, totalPurVal, totalSaleVal, profit: totalSaleVal - totalPurVal, avgPurRate: totalPurRate / rows.length, outOfStock, lowStock };
  }, [filteredModalProducts]);

  // ─── visible modal columns ────────────────────────────────────────────────
  const visibleModalCols = useMemo(
    () => MODAL_COLS.filter(c => c.always || modalColVis[c.key]),
    [modalColVis]
  );

  // ─── CSS grid template ────────────────────────────────────────────────────
  const gridCols = useMemo(() => {
    const parts = ['44px', ...visibleModalCols.map(c => c.flex ? '1fr' : `${c.width}px`), '110px'];
    return parts.join(' ');
  }, [visibleModalCols]);

  // ─── main fetch ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const doFetch = async () => {
      setLoading(true); setProducts([]); setCategoryBreakdown([]);
      try {
        const r = await reportAPI.getStockReport({
          search, category_id: categoryId, stock_status: stockStatus,
          sort_by: 'category_name', sort_dir: 'ASC', page: 1, limit: 99999,
        });
        if (cancelled) return;
        const { data = [], summary: s = {}, category_breakdown: cb = [] } = r.data;
        setProducts(data); setSummary(s); setCategoryBreakdown(cb);
      } catch { if (!cancelled) message.error('Failed to load stock report'); }
      if (!cancelled) setLoading(false);
    };
    doFetch();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, categoryId, stockStatus, refreshCount]);

  useEffect(() => {
    categoryAPI.getAllFlat().then(r => setCategories(r.data)).catch(() => {});
  }, []);

  // ─── close column dropdown on outside click ───────────────────────────────
  useEffect(() => {
    if (!colDropOpen) return;
    const handler = e => {
      if (colDropRef.current && !colDropRef.current.contains(e.target)) setColDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [colDropOpen]);

  // ─── focus active cell in bulk mode ──────────────────────────────────────
  useEffect(() => {
    if (!activeCell) return;
    const el = cellInputRefs.current[`${activeCell.rowIdx}-${activeCell.colKey}`];
    if (el) { el.focus(); el.select(); }
  }, [activeCell]);

  // ─── handlers ─────────────────────────────────────────────────────────────
  const handleSearchChange = e => {
    const v = e.target.value;
    setSearchInput(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(v), 350);
  };

  const handleModalSort = key => {
    if (modalSortKey === key) setModalSortDir(d => d === 'ASC' ? 'DESC' : 'ASC');
    else { setModalSortKey(key); setModalSortDir('ASC'); }
  };

  const openModal = useCallback(cat => {
    setCatModal(cat); setModalSearch(''); setModalSortKey('product_name');
    setModalSortDir('ASC'); setEditingId(null); setEditBuf({});
    setBulkMode(false); setBulkData({}); setActiveCell(null);
  }, []);

  const closeModal = () => {
    setCatModal(null); setEditingId(null); setEditBuf({});
    setBulkMode(false); setBulkData({}); setActiveCell(null);
  };

  const startEdit = p => {
    if (bulkMode) return;
    setEditingId(p.product_id);
    setEditBuf({ current_stock: p.current_stock, purchase_rate: p.purchase_rate, sale_rate: p.sale_rate, minimum_stock_level: p.minimum_stock_level });
  };
  const cancelEdit = () => { setEditingId(null); setEditBuf({}); };

  const today = () => new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const saveEdit = async productId => {
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

  const toggleModalCol = key => setModalColVis(v => ({ ...v, [key]: !v[key] }));

  // ─── bulk edit handlers ───────────────────────────────────────────────────
  const enterBulkMode = () => {
    setEditingId(null); setEditBuf({});
    const data = {};
    filteredModalProducts.forEach(p => {
      data[p.product_id] = {
        current_stock:       p.current_stock       ?? '',
        purchase_rate:       p.purchase_rate       ?? '',
        sale_rate:           p.sale_rate           ?? '',
        minimum_stock_level: p.minimum_stock_level ?? '',
      };
    });
    setBulkData(data);
    setBulkMode(true);
    setActiveCell(null);
  };

  const exitBulkMode = () => { setBulkMode(false); setBulkData({}); setActiveCell(null); };

  const handleBulkCellChange = (productId, fieldKey, value) => {
    setBulkData(prev => ({ ...prev, [productId]: { ...prev[productId], [fieldKey]: value } }));
  };

  const handleBulkKeyDown = (e, rowIdx, colKey) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) return;
    e.preventDefault();
    const editableCols = visibleModalCols.filter(c => c.editable).map(c => c.key);
    const colIdx = editableCols.indexOf(colKey);
    let nextRow = rowIdx, nextCol = colKey;

    if (e.key === 'ArrowDown') {
      nextRow = Math.min(rowIdx + 1, filteredModalProducts.length - 1);
    } else if (e.key === 'ArrowUp') {
      nextRow = Math.max(rowIdx - 1, 0);
    } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
      if (colIdx < editableCols.length - 1) nextCol = editableCols[colIdx + 1];
      else { nextRow = Math.min(rowIdx + 1, filteredModalProducts.length - 1); nextCol = editableCols[0]; }
    } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
      if (colIdx > 0) nextCol = editableCols[colIdx - 1];
      else { nextRow = Math.max(rowIdx - 1, 0); nextCol = editableCols[editableCols.length - 1]; }
    }
    setActiveCell({ rowIdx: nextRow, colKey: nextCol });
  };

  const saveBulkEdit = async () => {
    setBulkSaving(true);
    const dateStr = today();
    let successCount = 0;
    const newAdjusted = { ...adjustedProducts };

    for (const p of filteredModalProducts) {
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

  // ─── import/export ────────────────────────────────────────────────────────
  const handleExport = async () => {
    try {
      const { data } = await dataAPI.exportExcel('products');
      const url = window.URL.createObjectURL(new Blob([data]));
      Object.assign(document.createElement('a'), { href: url, download: 'stock_report.xlsx' }).click();
    } catch { message.error('Export failed'); }
  };

  const handleImport = async file => {
    setImporting(true); setImportProgress(0); setImportPhase('uploading'); setImportResult(null);
    try {
      const res = await dataAPI.importExcel('products', file, pct => {
        setImportProgress(pct);
        if (pct >= 100) setImportPhase('processing');
      });
      setImportResult(res.data); setImportModal(true); setRefreshCount(c => c + 1);
    } catch (e) {
      setImportResult({ failed: true, error: e.response?.data?.error || e.message || 'Import failed' });
      setImportModal(true);
    }
    setImporting(false); setImportPhase('');
    return false;
  };

  const handleDlFailed = async () => {
    if (!importResult?.errors?.length) return;
    setDlFailed(true);
    try {
      const { data } = await dataAPI.downloadFailedReport(importResult.errors);
      const url = window.URL.createObjectURL(new Blob([data]));
      Object.assign(document.createElement('a'), { href: url, download: 'failed_import.xlsx' }).click();
    } catch { message.error('Download failed'); }
    setDlFailed(false);
  };

  // ─── cell value renderer ─────────────────────────────────────────────────
  const renderCell = (col, p, isEditing, rowIdx) => {
    const stock = parseFloat(p.current_stock || 0);
    const s     = getStockStyle(stock, p.minimum_stock_level);
    const stVal = stock * parseFloat(p.purchase_rate || 0);
    const fieldKey = col.key === 'min_stock' ? 'minimum_stock_level' : col.key;

    // Bulk mode: editable cells become inputs
    if (bulkMode && col.editable) {
      const isActive = activeCell?.rowIdx === rowIdx && activeCell?.colKey === col.key;
      const colors   = { current_stock: '#6366f1', purchase_rate: '#6366f1', sale_rate: '#10b981', min_stock: '#f59e0b' };
      return (
        <input
          ref={el => { cellInputRefs.current[`${rowIdx}-${col.key}`] = el; }}
          type="number"
          value={bulkData[p.product_id]?.[fieldKey] ?? ''}
          onChange={e => handleBulkCellChange(p.product_id, fieldKey, e.target.value)}
          onKeyDown={e => handleBulkKeyDown(e, rowIdx, col.key)}
          onFocus={() => setActiveCell({ rowIdx, colKey: col.key })}
          style={{
            width: '100%',
            border: `${isActive ? '2px' : '1px'} solid ${isActive ? (colors[col.key] || '#6366f1') : '#d1d5db'}`,
            borderRadius: 5, padding: '3px 6px', fontSize: 13, outline: 'none',
            boxSizing: 'border-box', background: isActive ? '#eff6ff' : '#fff',
          }}
        />
      );
    }

    // Single-row edit mode
    if (isEditing && col.editable) {
      const colors = { current_stock: '#6366f1', purchase_rate: '#6366f1', sale_rate: '#10b981', min_stock: '#f59e0b' };
      return (
        <input
          type="number"
          value={editBuf[fieldKey] ?? ''}
          onChange={e => setEditBuf(b => ({ ...b, [fieldKey]: e.target.value }))}
          style={{ width: '100%', border: `1.5px solid ${colors[col.key] || '#6366f1'}`, borderRadius: 6, padding: '3px 7px', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
        />
      );
    }

    switch (col.key) {
      case 'barcode':
        return <span style={{ fontSize: 12, color: '#6b7280' }}>{p.barcode || '—'}</span>;
      case 'product_name':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.product_name}</span>
            {adjustedProducts[p.product_id] && (
              <span style={{ fontSize: 10, color: '#059669', background: '#d1fae5', borderRadius: 4, padding: '1px 6px', fontWeight: 600, width: 'fit-content', whiteSpace: 'nowrap' }}>
                Adjusted {adjustedProducts[p.product_id]}
              </span>
            )}
          </div>
        );
      case 'size_value':
        return <span style={{ fontSize: 12, color: '#6b7280' }}>{p.size_value || '—'}</span>;
      case 'current_stock':
        return <span style={{ fontSize: 12, fontWeight: 700, color: s.color, background: s.bg, borderRadius: 6, padding: '2px 7px' }}>{fmtN(stock)}</span>;
      case 'purchase_rate':
        return <span style={{ fontSize: 13, color: '#374151' }}>{fmt(p.purchase_rate)}</span>;
      case 'sale_rate':
        return <span style={{ fontSize: 13, color: '#10b981', fontWeight: 600 }}>{fmt(p.sale_rate)}</span>;
      case 'min_stock':
        return <span style={{ fontSize: 12, color: '#9ca3af' }}>{p.minimum_stock_level || '—'}</span>;
      case 'stock_value':
        return <span style={{ fontSize: 13, fontWeight: 700, color: '#3b82f6' }}>{fmt(stVal)}</span>;
      default:
        return null;
    }
  };

  // ─── render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', background: '#f8fafc', overflow: 'hidden' }}>

      {/* ── Top bar ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '12px 24px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Smart Stock</span>
            {loading ? <Spin size="small" /> : <>
              <span style={{ fontSize: 12, background: '#eff6ff', color: '#1d4ed8', borderRadius: 20, padding: '3px 12px', fontWeight: 600 }}>{(summary.total_items ?? products.length).toLocaleString()} Items</span>
              <span style={{ fontSize: 12, background: '#f0fdf4', color: '#15803d', borderRadius: 20, padding: '3px 12px', fontWeight: 600 }}>Purchase: {fmt(summary.total_purchase_value)}</span>
              <span style={{ fontSize: 12, background: '#faf5ff', color: '#7e22ce', borderRadius: 20, padding: '3px 12px', fontWeight: 600 }}>Sale: {fmt(summary.total_sale_value)}</span>
              <span style={{ fontSize: 12, background: '#fefce8', color: '#854d0e', borderRadius: 20, padding: '3px 12px', fontWeight: 600 }}>Profit: {fmt(summary.potential_profit)}</span>
            </>}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input prefix={<SearchOutlined style={{ color: '#9ca3af' }} />} placeholder="Search product / barcode…"
              value={searchInput} onChange={handleSearchChange}
              onClear={() => { setSearchInput(''); setSearch(''); }} allowClear style={{ width: 210 }} size="middle" />
            <Select placeholder="Category" style={{ width: 155 }} allowClear value={categoryId} onChange={v => setCategoryId(v ?? null)}>
              {categories.map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
            </Select>
            <Select placeholder="Stock Status" style={{ width: 145 }} allowClear value={stockStatus} onChange={v => setStockStatus(v ?? null)}>
              <Select.Option value="low"><WarningOutlined style={{ color: '#d97706' }} /> Low Stock</Select.Option>
              <Select.Option value="out"><CloseCircleOutlined style={{ color: '#dc2626' }} /> Out of Stock</Select.Option>
            </Select>
            <Upload accept=".xlsx,.xls,.csv" showUploadList={false} beforeUpload={handleImport} disabled={importing}>
              <button disabled={importing} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#4f46e5', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, padding: '7px 14px', cursor: importing ? 'not-allowed' : 'pointer', opacity: importing ? .7 : 1 }}>
                {importing ? <Spin size="small" style={{ filter: 'brightness(10)' }} /> : <UploadOutlined />}
                {importing ? (importPhase === 'processing' ? 'Processing…' : 'Uploading…') : 'Import'}
              </button>
            </Upload>
            {importing && (
              <div style={{ width: 140 }}>
                {importPhase === 'uploading'
                  ? <Progress percent={importProgress} size="small" strokeColor="#4f46e5" showInfo={false} />
                  : <Progress percent={100} size="small" status="active" strokeColor="#f59e0b" showInfo={false} />}
                <div style={{ fontSize: 10, color: '#9ca3af', textAlign: 'center', marginTop: 2 }}>
                  {importPhase === 'uploading' ? `${importProgress}%` : 'Processing…'}
                </div>
              </div>
            )}
            <Tooltip title="Download import template">
              <button onClick={async () => {
                try {
                  const { data } = await dataAPI.downloadTemplate('products');
                  const url = window.URL.createObjectURL(new Blob([data]));
                  Object.assign(document.createElement('a'), { href: url, download: 'products_template.xlsx' }).click();
                } catch { message.error('Failed'); }
              }} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, color: '#374151', fontWeight: 600, fontSize: 13, padding: '7px 12px', cursor: 'pointer' }}>
                Template
              </button>
            </Tooltip>
            <button onClick={handleExport} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#16a34a', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, padding: '7px 14px', cursor: 'pointer' }}>
              <DownloadOutlined /> Export
            </button>
          </div>
        </div>
      </div>

      {/* ── Category list column header ── */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 24px', background: '#f1f5f9', borderBottom: '2px solid #e5e7eb', flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: .5, flex: 1 }}>Category</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: .5, marginRight: 28 }}>Items</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: .5, minWidth: 110, textAlign: 'right' }}>Stock Value</span>
      </div>

      {/* ── Category list ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 80, gap: 16 }}>
            <Spin size="large" />
            <span style={{ fontSize: 13, color: '#9ca3af' }}>Loading all products…</span>
          </div>
        ) : categoryBreakdown.length === 0 ? (
          <Empty description="No categories found" style={{ marginTop: 60 }} />
        ) : (
          <>
            {categoryBreakdown.map(cat => (
              <CategoryRow key={cat.category_id ?? '__none__'} cat={cat} onClick={openModal} />
            ))}
            <div style={{ padding: 14, textAlign: 'center', fontSize: 12, color: '#cbd5e1' }}>
              {categoryBreakdown.length} categories · {products.length.toLocaleString()} products total
            </div>
          </>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          CATEGORY EDIT MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={!!catModal}
        onCancel={closeModal}
        footer={null}
        width="94vw"
        style={{ top: 16 }}
        styles={{ body: { padding: 0, height: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' } }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#1e293b' }}>{catModal?.category_name || 'Uncategorized'}</span>
            <span style={{ fontSize: 12, background: '#eff6ff', color: '#1d4ed8', borderRadius: 12, padding: '2px 10px', fontWeight: 600 }}>
              {modalStats ? `${modalStats.count} shown` : `${catModal?.item_count?.toLocaleString()} products`}
            </span>
            {!bulkMode ? (
              <button
                onClick={enterBulkMode}
                style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 7, color: '#16a34a', fontWeight: 600, fontSize: 12, padding: '4px 12px', cursor: 'pointer' }}
              >
                <EditOutlined /> Bulk Edit
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  onClick={saveBulkEdit}
                  disabled={bulkSaving}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#16a34a', border: 'none', borderRadius: 7, color: '#fff', fontWeight: 600, fontSize: 12, padding: '4px 14px', cursor: 'pointer', opacity: bulkSaving ? .7 : 1 }}
                >
                  {bulkSaving ? <Spin size="small" style={{ filter: 'brightness(10)' }} /> : <SaveOutlined />} Save All
                </button>
                <button
                  onClick={exitBulkMode}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, color: '#dc2626', fontWeight: 600, fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
                >
                  <CloseOutlined /> Cancel
                </button>
                <span style={{ fontSize: 11, color: '#94a3b8', background: '#f1f5f9', borderRadius: 5, padding: '3px 8px' }}>
                  Arrow keys / Tab to navigate
                </span>
              </div>
            )}
          </div>
        }
      >
        {/* ── Stats bar ── */}
        {modalStats && (
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', flexShrink: 0, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Qty',     value: fmtN(modalStats.totalQty),    color: '#1d4ed8', bg: '#eff6ff' },
              { label: 'Purchase Val',  value: fmt(modalStats.totalPurVal),   color: '#15803d', bg: '#f0fdf4' },
              { label: 'Sale Value',    value: fmt(modalStats.totalSaleVal),  color: '#7e22ce', bg: '#faf5ff' },
              { label: 'Profit',        value: fmt(modalStats.profit),        color: '#854d0e', bg: '#fefce8' },
              { label: 'Avg Pur Rate',  value: fmt(modalStats.avgPurRate),    color: '#374151', bg: '#f9fafb' },
              { label: 'Out of Stock',  value: modalStats.outOfStock,         color: '#dc2626', bg: '#fef2f2' },
              { label: 'Low Stock',     value: modalStats.lowStock,           color: '#d97706', bg: '#fffbeb' },
            ].map(st => (
              <div key={st.label} style={{ flex: 1, minWidth: 110, padding: '10px 16px', background: st.bg, borderRight: '1px solid #f1f5f9', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: st.color }}>{st.value}</div>
                <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4, marginTop: 2 }}>{st.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Search + Columns dropdown ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #e5e7eb', flexShrink: 0, background: '#fafafa' }}>
          <Input
            prefix={<SearchOutlined style={{ color: '#9ca3af' }} />}
            placeholder="Search by product / barcode…"
            value={modalSearch}
            onChange={e => setModalSearch(e.target.value)}
            onClear={() => setModalSearch('')}
            allowClear style={{ width: 240 }} size="small"
          />
          {/* Columns dropdown */}
          <div ref={colDropRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setColDropOpen(o => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: 5, background: colDropOpen ? '#eff6ff' : '#fff', border: `1px solid ${colDropOpen ? '#bfdbfe' : '#e5e7eb'}`, borderRadius: 7, color: colDropOpen ? '#1d4ed8' : '#374151', fontWeight: 600, fontSize: 12, padding: '5px 12px', cursor: 'pointer', userSelect: 'none' }}
            >
              Columns {colDropOpen ? '▲' : '▾'}
            </button>
            {colDropOpen && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.1)', padding: '6px 0', zIndex: 200, minWidth: 155 }}>
                {MODAL_COLS.filter(c => !c.always).map(col => (
                  <label
                    key={col.key}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, color: '#374151', userSelect: 'none', transition: 'background .1s' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <input
                      type="checkbox"
                      checked={!!modalColVis[col.key]}
                      onChange={() => toggleModalCol(col.key)}
                      style={{ cursor: 'pointer', width: 14, height: 14, accentColor: '#3b82f6' }}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Table header (CSS Grid) ── */}
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, alignItems: 'center', padding: '7px 16px', background: '#f9fafb', borderBottom: '2px solid #e5e7eb', flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>#</div>
          {visibleModalCols.map(col => {
            const active = modalSortKey === col.sortKey && col.sortKey;
            return (
              <div
                key={col.key}
                onClick={col.sortKey ? () => handleModalSort(col.sortKey) : undefined}
                style={{ fontSize: 11, fontWeight: 700, color: active ? '#3b82f6' : '#9ca3af', textTransform: 'uppercase', letterSpacing: .4, cursor: col.sortKey ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 3, userSelect: 'none', paddingRight: 8, overflow: 'hidden' }}
              >
                {col.label}
                {col.sortKey && (
                  <span style={{ opacity: active ? 1 : 0.3, fontSize: 10 }}>
                    {active ? (modalSortDir === 'ASC' ? '↑' : '↓') : '↕'}
                  </span>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', textAlign: 'center' }}>
            {bulkMode ? '' : 'Actions'}
          </div>
        </div>

        {/* ── Table body (CSS Grid rows) ── */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filteredModalProducts.length === 0 ? (
            <Empty description="No products found" style={{ marginTop: 40 }} />
          ) : filteredModalProducts.map((p, idx) => {
            const isEditing = !bulkMode && editingId === p.product_id;
            const bg = idx % 2 === 0 ? '#fff' : '#fafafa';
            const isBulkActive = bulkMode && activeCell?.rowIdx === idx;
            return (
              <div
                key={p.product_id}
                style={{ display: 'grid', gridTemplateColumns: gridCols, alignItems: 'center', padding: '5px 16px', borderBottom: '1px solid #f3f4f6', background: isBulkActive ? '#f0f9ff' : (isEditing ? '#fefce8' : bg), transition: 'background .1s', minHeight: 38 }}
                onMouseEnter={e => { if (!isEditing && !bulkMode) e.currentTarget.style.background = '#f0f9ff'; }}
                onMouseLeave={e => { if (!isEditing && !bulkMode) e.currentTarget.style.background = bg; }}
              >
                {/* S.No */}
                <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600 }}>{idx + 1}</div>

                {/* Data cells */}
                {visibleModalCols.map(col => (
                  <div key={col.key} style={{ paddingRight: 6, overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
                    {renderCell(col, p, isEditing, idx)}
                  </div>
                ))}

                {/* Actions */}
                <div style={{ display: 'flex', gap: 5, justifyContent: 'center' }}>
                  {!bulkMode && (isEditing ? (
                    <>
                      <button
                        onClick={() => saveEdit(p.product_id)}
                        disabled={saving}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#16a34a', border: 'none', borderRadius: 6, color: '#fff', fontWeight: 600, fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
                      >
                        {saving ? <Spin size="small" style={{ filter: 'brightness(10)' }} /> : <SaveOutlined />} Save
                      </button>
                      <button onClick={cancelEdit} style={{ display: 'flex', alignItems: 'center', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, color: '#64748b', fontSize: 12, padding: '4px 8px', cursor: 'pointer' }}>
                        <CloseOutlined />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => startEdit(p)}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, color: '#1d4ed8', fontWeight: 600, fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
                    >
                      <EditOutlined /> Edit
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Modal footer ── */}
        <div style={{ padding: '9px 16px', borderTop: '1px solid #e5e7eb', background: '#f9fafb', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: '#64748b' }}>
            {filteredModalProducts.length !== modalProducts.length
              ? `Showing ${filteredModalProducts.length} of ${modalProducts.length} products`
              : `${modalProducts.length} products`}
            {bulkMode && <span style={{ marginLeft: 8, color: '#d97706', fontWeight: 600 }}>● Bulk Edit Active</span>}
          </span>
          <button onClick={closeModal} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, color: '#374151', fontWeight: 600, fontSize: 13, padding: '6px 20px', cursor: 'pointer' }}>
            Close
          </button>
        </div>
      </Modal>

      {/* ── Import Result Modal ── */}
      <Modal title={importResult?.failed ? 'Import Failed' : 'Import Complete'} open={importModal}
        onCancel={() => { setImportModal(false); setImportResult(null); }} footer={null} width={640}>
        {importResult && (
          <div style={{ padding: '8px 0' }}>
            {importResult.failed ? (
              <div style={{ background: '#fef2f2', borderRadius: 8, padding: 16, color: '#dc2626', fontWeight: 600 }}>
                <CloseCircleOutlined style={{ marginRight: 8 }} />{importResult.error}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                  {[['#15803d','#f0fdf4','#bbf7d0', importResult.imported||0, <CheckCircleOutlined />, 'Imported'],
                    ['#dc2626','#fef2f2','#fecaca', importResult.skipped||0,  <CloseCircleOutlined />, 'Skipped'],
                    ['#1d4ed8','#eff6ff','#bfdbfe', importResult.total||0,    null, 'Total Rows']
                  ].map(([color, bg, border, val, icon, label]) => (
                    <div key={label} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: '10px 20px', textAlign: 'center' }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color }}>{val}</div>
                      <div style={{ fontSize: 11, color, fontWeight: 600 }}>{icon} {label}</div>
                    </div>
                  ))}
                </div>
                {importResult.errors?.length > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Failed Rows ({importResult.errors.length})</span>
                      <button onClick={handleDlFailed} disabled={dlFailed}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#dc2626', border: 'none', borderRadius: 6, color: '#fff', fontWeight: 600, fontSize: 12, padding: '5px 14px', cursor: 'pointer' }}>
                        {dlFailed ? <Spin size="small" style={{ filter: 'brightness(10)' }} /> : <FileExcelOutlined />} Download Report
                      </button>
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #fee2e2', borderRadius: 8 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: '#fef2f2', position: 'sticky', top: 0 }}>
                            {['Row','Product','Reason'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#dc2626', fontWeight: 700, borderBottom: '1px solid #fecaca', width: h==='Row'?60:undefined }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {importResult.errors.map((e, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #fef2f2', background: i%2===0?'#fff':'#fffafa' }}>
                              <td style={{ padding: '5px 10px', color: '#6b7280' }}>{e.row}</td>
                              <td style={{ padding: '5px 10px', color: '#374151', fontWeight: 600 }}>{e.rowData?.['Product Name *']||e.rowData?.['Product Name']||e.rowData?.barcode||'—'}</td>
                              <td style={{ padding: '5px 10px', color: '#dc2626' }}>{e.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
