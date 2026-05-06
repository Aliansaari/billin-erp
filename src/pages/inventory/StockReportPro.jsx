import React, { useEffect, useState, useRef, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, Select, message, Spin, Empty, Modal, Progress, Dropdown } from 'antd';
import {
  SearchOutlined, FileExcelOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  ReloadOutlined, RightOutlined,
} from '@ant-design/icons';
import { reportAPI, categoryAPI, dataAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import './smart-stock.css';

const fmt = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

// Memoised category row — clicking navigates to the detail page.
const CategoryRow = memo(({ cat, onOpen, isCursor, isMultiSelected, onSetCursor }) => {
  const cursorClass = isCursor ? ' vrt-row-active' : (isMultiSelected ? ' vrt-row-multi' : '');
  return (
    <div
      className={`ss-cat-row${cursorClass}`}
      onClick={(e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) { onSetCursor(e); return; }
        onSetCursor(e);
      }}
      onDoubleClick={() => onOpen(cat)}
    >
      <span className="ss-cat-name">
        <RightOutlined />
        {cat.category_name || 'Uncategorised'}
      </span>
      <span className="ss-cat-items">{cat.item_count?.toLocaleString() ?? 0} items</span>
      <span className="ss-cat-value">{fmt(cat.stock_value)}</span>
    </div>
  );
});

export default function StockReportPro() {
  const navigate = useNavigate();

  const [categoryBreakdown, setCategoryBreakdown] = useState([]);
  const [products,          setProducts]          = useState([]);
  const [categories,        setCategories]        = useState([]);
  const [loading,           setLoading]           = useState(false);
  const [refreshCount,      setRefreshCount]      = useState(0);

  // Filters
  const [searchInput, setSearchInput] = useState('');
  const [search,      setSearch]      = useState('');
  const [categoryId,  setCategoryId]  = useState(null);
  const searchTimer = useRef(null);

  // Import
  const [importing,      setImporting]      = useState(false);
  const [importModal,    setImportModal]    = useState(false);
  const [importResult,   setImportResult]   = useState(null);
  const [importProgress, setImportProgress] = useState(0);
  const [importPhase,    setImportPhase]    = useState('');
  const [dlFailed,       setDlFailed]       = useState(false);
  const fileInputRef = useRef(null);
  const searchInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const doFetch = async () => {
      setLoading(true);
      try {
        const r = await reportAPI.getStockReport({
          search, category_id: categoryId,
          sort_by: 'category_name', sort_dir: 'ASC', page: 1, limit: 99999,
        });
        if (cancelled) return;
        const { data = [], category_breakdown: cb = [] } = r.data;
        setProducts(data); setCategoryBreakdown(cb);
      } catch { if (!cancelled) message.error('Failed to load stock report'); }
      if (!cancelled) setLoading(false);
    };
    doFetch();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, categoryId, refreshCount]);

  useEffect(() => {
    categoryAPI.getAllFlat().then(r => setCategories(r.data || [])).catch(() => {});
  }, []);

  const handleSearchChange = (e) => {
    const v = e.target.value;
    setSearchInput(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(v), 250);
  };

  const openCategory = (cat) => {
    const id = cat.category_id ?? 'none';
    navigate(`/stock-report-pro/${id}`);
  };

  // Cursor over the category breakdown — F1 Open Category navigates to
  // the cursored row's detail page.
  const sel = useListSelection({ totalCount: categoryBreakdown.length, rows: categoryBreakdown });
  const single = sel.activeRow;

  /* ── import / export / template ── */
  const handleExport = async () => {
    try {
      const params = {};
      if (search)     params.search      = search;
      if (categoryId) params.category_id = categoryId;
      const { data } = await reportAPI.exportStockReport(params);
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const stamp = new Date().toISOString().slice(0, 10);
      Object.assign(document.createElement('a'), { href: url, download: `stock_report_${stamp}.xlsx` }).click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };
  const handleTemplate = async () => {
    try {
      const { data } = await dataAPI.downloadTemplate('products');
      const url = window.URL.createObjectURL(new Blob([data]));
      Object.assign(document.createElement('a'), { href: url, download: 'products_template.xlsx' }).click();
    } catch { message.error('Template download failed'); }
  };
  const handleImport = async (file) => {
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

  const excelMenu = {
    items: [
      { key: 'export',   label: 'Export to Excel',   icon: <FileExcelOutlined /> },
      { key: 'import',   label: 'Import from Excel', icon: <FileExcelOutlined /> },
      { type: 'divider' },
      { key: 'template', label: 'Download Template', icon: <FileExcelOutlined /> },
    ],
    onClick: ({ key }) => {
      if (key === 'export')   handleExport();
      if (key === 'import')   fileInputRef.current?.click();
      if (key === 'template') handleTemplate();
    },
  };

  return (
    <div className="ss-page">

      {/* HEADER */}
      <div className="ss-hd">
        <div className="ss-title"><h1>Smart Stock</h1></div>
        <div className="ss-ctrls">
          <div className="ss-search">
            <SearchOutlined />
            <input
              ref={searchInputRef}
              placeholder="Search product, barcode, article…"
              value={searchInput}
              onChange={handleSearchChange}
              autoComplete="off"
            />
          </div>
          <Select
            placeholder="All Categories"
            style={{ width: 160 }}
            allowClear
            value={categoryId}
            onChange={(v) => setCategoryId(v ?? null)}
            options={categories.map(c => ({ value: c.category_id, label: c.category_name }))}
          />
          <button className="ss-btn" onClick={() => setRefreshCount(c => c + 1)} title="Refresh">
            <ReloadOutlined /> Refresh
          </button>
          <Dropdown menu={excelMenu} trigger={['click']} placement="bottomRight">
            <button className="ss-btn primary"><FileExcelOutlined /> Excel</button>
          </Dropdown>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImport(f);
              e.target.value = '';
            }}
          />
          {importing && (
            <div style={{ width: 130 }}>
              {importPhase === 'uploading'
                ? <Progress percent={importProgress} size="small" showInfo={false} />
                : <Progress percent={100} size="small" status="active" showInfo={false} />}
              <div style={{ fontSize: 10, color: 'var(--fg-tertiary)', textAlign: 'center', marginTop: 2 }}>
                {importPhase === 'uploading' ? `${importProgress}%` : 'Processing…'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CATEGORY LIST */}
      <div className="ss-cat-hd">
        <span>Category</span>
        <span className="right">Items</span>
        <span className="right">Stock Value</span>
      </div>
      <div className="ss-cat-list">
        {loading ? (
          <div className="ss-empty"><Spin /> <div style={{ marginTop: 12 }}>Loading…</div></div>
        ) : categoryBreakdown.length === 0 ? (
          <Empty description="No categories found" style={{ marginTop: 60 }} />
        ) : (
          categoryBreakdown.map((cat, idx) => (
            <CategoryRow
              key={cat.category_id ?? '__none__'}
              cat={cat}
              onOpen={openCategory}
              isCursor={sel.cursorIdx === idx}
              isMultiSelected={sel.selectedSet.has(idx) && sel.cursorIdx !== idx}
              onSetCursor={(e) => {
                if (e.shiftKey)              sel.extendTo(idx);
                else if (e.ctrlKey || e.metaKey) sel.toggleRow(idx);
                else                            sel.setCursor(idx);
              }}
            />
          ))
        )}
      </div>
      {categoryBreakdown.length > 0 && (
        <div className="ss-cat-meta">
          <b>{categoryBreakdown.length}</b> categor{categoryBreakdown.length === 1 ? 'y' : 'ies'} ·{' '}
          <b>{products.length.toLocaleString()}</b> products total
        </div>
      )}

      {/* Import Result Modal */}
      <Modal
        title={importResult?.failed ? 'Import Failed' : 'Import Complete'}
        open={importModal}
        onCancel={() => { setImportModal(false); setImportResult(null); }}
        footer={null}
        width={640}
      >
        {importResult && (
          <div style={{ padding: '8px 0' }}>
            {importResult.failed ? (
              <div style={{ background: 'var(--danger-bg)', borderRadius: 8, padding: 16, color: 'var(--danger)', fontWeight: 600 }}>
                <CloseCircleOutlined style={{ marginRight: 8 }} />{importResult.error}
              </div>
            ) : (
              <>
                <div className="ss-imp-grid">
                  <div className="ss-imp-stat ok">
                    <div className="ss-imp-stat-v">{importResult.imported || 0}</div>
                    <div className="ss-imp-stat-l"><CheckCircleOutlined /> Imported</div>
                  </div>
                  <div className="ss-imp-stat skipped">
                    <div className="ss-imp-stat-v">{importResult.skipped || 0}</div>
                    <div className="ss-imp-stat-l"><CloseCircleOutlined /> Skipped</div>
                  </div>
                  <div className="ss-imp-stat total">
                    <div className="ss-imp-stat-v">{importResult.total || 0}</div>
                    <div className="ss-imp-stat-l">Total Rows</div>
                  </div>
                </div>
                {importResult.errors?.length > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-primary)' }}>
                        Failed Rows ({importResult.errors.length})
                      </span>
                      <button className="ss-btn primary" onClick={handleDlFailed} disabled={dlFailed}>
                        {dlFailed ? <Spin size="small" /> : <FileExcelOutlined />} Download Report
                      </button>
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--danger-bg)', position: 'sticky', top: 0 }}>
                            {['Row', 'Product', 'Reason'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--danger)', fontWeight: 700, borderBottom: '1px solid var(--border)', width: h === 'Row' ? 60 : undefined }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {importResult.errors.map((e, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '5px 10px', color: 'var(--fg-tertiary)' }}>{e.row}</td>
                              <td style={{ padding: '5px 10px', color: 'var(--fg-primary)', fontWeight: 600 }}>
                                {e.rowData?.['Product Name *'] || e.rowData?.['Product Name'] || e.rowData?.barcode || '—'}
                              </td>
                              <td style={{ padding: '5px 10px', color: 'var(--danger)' }}>{e.reason}</td>
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

      <ActionStrip
        actions={[
          {
            id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus?.(),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => setRefreshCount(c => c + 1),
          },
          {
            id: 'open', key: 'F1', label: 'Open Category', tone: 'primary',
            disabled: !single,
            onAction: () => single && openCategory(single),
          },
        ]}
      />
    </div>
  );
}
