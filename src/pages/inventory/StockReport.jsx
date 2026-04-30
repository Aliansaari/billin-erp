import React, { useEffect, useState } from 'react';
import {
  Input, Select, message, Tooltip, Spin, Upload, Modal, Progress, Dropdown,
} from 'antd';
import {
  SearchOutlined, DownloadOutlined, UploadOutlined,
  WarningOutlined, CheckCircleOutlined, CloseCircleOutlined, FileExcelOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { reportAPI, categoryAPI, dataAPI } from '../../api';
import { useVirtualizedReport } from '../../hooks/useVirtualizedReport';
import VirtualReportTable from '../../components/VirtualReportTable';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) =>    parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const COL_DEFS = [
  { key: 'sr',     label: 'Sr No',         default: true,  fixed: true },
  { key: 'bc',     label: 'Barcode',       default: true  },
  { key: 'cat',    label: 'Category',      default: true  },
  { key: 'prod',   label: 'Product',       default: true,  fixed: true },
  { key: 'size',   label: 'Size',          default: true  },
  { key: 'art',    label: 'Article No',    default: true  },
  { key: 'open',   label: 'Opening Stock', default: true  },
  { key: 'stk',    label: 'Stock',         default: true,  fixed: true },
  { key: 'pur',    label: 'Pur. Rate',     default: true  },
  { key: 'sale',   label: 'Sale Rate',     default: true  },
  { key: 'val',    label: 'Stock Value',   default: true  },
];
const SEC_DEFS = [
  { key: 'totalRow', label: 'Total row (sticky bottom)' },
];
const LS_COLS = 'inv-stock-report-cols-v1';
const DEFAULT_COLS = {
  ...Object.fromEntries(COL_DEFS.map(c => [c.key, c.default])),
  totalRow: true,
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(LS_COLS);
    if (!raw) return { ...DEFAULT_COLS };
    return { ...DEFAULT_COLS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_COLS }; }
}

// "Negative" stock (sales > purchases) is a data-integrity flag — distinct
// styling from a clean "Out of stock". Mirrors the editorial classification
// the bespoke version used.
function stockColor(v, min) {
  const q = parseFloat(v);
  if (q < 0) return { bg:'#fdf2f8', color:'#be185d', label:'Negative' };
  if (q === 0) return { bg:'#fef2f2', color:'#dc2626', label:'Out' };
  if (min > 0 && q <= parseFloat(min)) return { bg:'#fffbeb', color:'#d97706', label:'Low' };
  return { bg:'#f0fdf4', color:'#16a34a', label:'OK' };
}

export default function StockReport() {
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState({ search: '', category_id: null, stock_status: null });
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 220);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [categories, setCategories] = useState([]);
  const [cols, setCols] = useState(loadPrefs);
  useEffect(() => { try { localStorage.setItem(LS_COLS, JSON.stringify(cols)); } catch {} }, [cols]);

  const [importing, setImporting] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importProgress, setImportProgress] = useState(0);
  const [importPhase, setImportPhase] = useState('');
  const [downloadingFailed, setDownloadingFailed] = useState(false);

  // ── Virtualized data layer ────────────────────────────────────────
  const { rows, totalCount, summary, ensureChunk, loading, refresh } = useVirtualizedReport({
    fetcher: (params) => reportAPI.getStockReport(params),
    filters,
    chunkSize: 200,
  });

  useEffect(() => { loadCategories(); }, []);
  const loadCategories = async () => {
    try { const { data } = await categoryAPI.getAllFlat(); setCategories(data); } catch {}
  };

  /* ── export ── */
  const handleExport = async () => {
    try {
      const { data } = await reportAPI.exportStockReport(filters);
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock_report_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  /* ── import ── */
  const handleImport = async (file) => {
    setImporting(true);
    setImportProgress(0);
    setImportPhase('uploading');
    setImportResult(null);
    try {
      const res = await dataAPI.importExcel('products', file, (pct) => {
        setImportProgress(pct);
        if (pct >= 100) setImportPhase('processing');
      });
      setImportResult(res.data);
      setImportModal(true);
      refresh();
    } catch (e) {
      const errMsg = e.response?.data?.error || e.message || 'Import failed';
      setImportResult({ failed: true, error: errMsg });
      setImportModal(true);
    }
    setImporting(false);
    setImportPhase('');
    return false;
  };

  const handleDownloadFailed = async () => {
    if (!importResult?.errors?.length) return;
    setDownloadingFailed(true);
    try {
      const { data } = await dataAPI.downloadFailedReport(importResult.errors);
      const url = window.URL.createObjectURL(new Blob([data]));
      const a = document.createElement('a'); a.href = url; a.download = 'failed_import_report.xlsx'; a.click();
    } catch { message.error('Failed to download report'); }
    setDownloadingFailed(false);
  };

  /* ── columns ── */
  const columns = [
    cols.sr && {
      key: 'sr', title: '#', width: 56, align: 'center', fixed: 'left',
      render: (_, __, idx) => <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600 }}>{idx + 1}</span>,
    },
    cols.bc && {
      key: 'bc', title: 'Barcode', dataIndex: 'barcode', width: 130,
      render: (v) => <span style={{ fontSize: 12, color: '#6b7280', fontFamily: 'var(--font-mono, monospace)' }}>{v || '—'}</span>,
    },
    cols.cat && {
      key: 'cat', title: 'Category', dataIndex: ['Category', 'category_name'], width: 130,
      render: (v) => v || '—',
    },
    {
      key: 'prod', title: 'Product', dataIndex: 'product_name', width: 240, fixed: 'left',
      render: (v) => <span style={{ fontWeight: 600, color: '#111827' }}>{v}</span>,
    },
    cols.size && {
      key: 'size', title: 'Size', dataIndex: 'size_value', width: 70,
      render: (v) => v || '—',
    },
    cols.art && {
      key: 'art', title: 'Article No', dataIndex: 'article_number', width: 110,
      render: (v) => v || '—',
    },
    cols.open && {
      key: 'open', title: 'Opening', dataIndex: 'opening_stock', width: 90, align: 'right',
      sorter: (a, b) => parseFloat(a.opening_stock || 0) - parseFloat(b.opening_stock || 0),
      render: (v) => <span style={{ color: '#6366f1', fontWeight: 600 }}>{fmtN(v)}</span>,
    },
    {
      key: 'stk', title: 'Stock', dataIndex: 'current_stock', width: 100, align: 'right',
      sorter: (a, b) => parseFloat(a.current_stock || 0) - parseFloat(b.current_stock || 0),
      render: (v, p) => {
        const sc = stockColor(v, p.minimum_stock_level);
        return (
          <span style={{ fontWeight: 700, color: sc.color, background: sc.bg, borderRadius: 6, padding: '2px 8px' }}>
            {fmtN(v)}
          </span>
        );
      },
    },
    cols.pur && {
      key: 'pur', title: 'Pur. Rate', dataIndex: 'purchase_rate', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.purchase_rate || 0) - parseFloat(b.purchase_rate || 0),
      render: (v) => fmt(v),
    },
    cols.sale && {
      key: 'sale', title: 'Sale Rate', dataIndex: 'sale_rate', width: 110, align: 'right',
      sorter: (a, b) => parseFloat(a.sale_rate || 0) - parseFloat(b.sale_rate || 0),
      render: (v) => <span style={{ color: '#10b981', fontWeight: 600 }}>{fmt(v)}</span>,
    },
    cols.val && {
      key: 'val', title: 'Stock Value', width: 130, align: 'right',
      sorter: (a, b) =>
        parseFloat(a.current_stock || 0) * parseFloat(a.purchase_rate || 0) -
        parseFloat(b.current_stock || 0) * parseFloat(b.purchase_rate || 0),
      render: (_, p) => {
        const v = parseFloat(p.current_stock || 0) * parseFloat(p.purchase_rate || 0);
        return <span style={{ fontWeight: 700, color: '#3b82f6' }}>{fmt(v)}</span>;
      },
    },
  ].filter(Boolean);

  /* ── Total strip — sums Stock Value column from server summary ── */
  const SUMMABLE_KEYS = new Set(['val']);
  const firstAggIdx = (() => {
    const idx = columns.findIndex((c) => SUMMABLE_KEYS.has(c.key));
    return idx === -1 ? columns.length : idx;
  })();
  const summaryCells = (col, idx) => {
    if (idx === 0) return totalCount > 0 ? `Total (${totalCount} item${totalCount === 1 ? '' : 's'})` : null;
    if (idx > 0 && idx < firstAggIdx) return null;
    if (col.key === 'val') return <strong style={{ color: '#3b82f6' }}>{fmt(summary?.total_purchase_value)}</strong>;
    return null;
  };
  const summaryColSpan = (col, idx) => {
    if (idx === 0) return Math.max(1, firstAggIdx);
    if (idx > 0 && idx < firstAggIdx) return 0;
    return 1;
  };

  const customizePopoverContent = (
    <div className="cols-menu" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.12)' }}>
      <div className="grp">
        <div className="gh">
          <span>Columns</span>
          <button className="gh-reset" type="button" onClick={() => setCols(DEFAULT_COLS)}>Reset</button>
        </div>
        {COL_DEFS.map(c => (
          <label key={c.key} className={`opt${c.fixed ? ' fixed' : ''}`}>
            <input
              type="checkbox"
              checked={!!cols[c.key] || !!c.fixed}
              disabled={!!c.fixed}
              onChange={(e) => setCols(prev => ({ ...prev, [c.key]: e.target.checked }))}
            />
            <span>{c.label}</span>
            {c.fixed && <span className="pin">Fixed</span>}
          </label>
        ))}
      </div>
      <div className="grp">
        <div className="gh"><span>Page Sections</span></div>
        {SEC_DEFS.map(s => (
          <label key={s.key} className="opt">
            <input
              type="checkbox"
              checked={!!cols[s.key]}
              onChange={(e) => setCols(prev => ({ ...prev, [s.key]: e.target.checked }))}
            />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', background: '#f8fafc', overflow: 'hidden' }}>

      {/* ── Top bar ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '12px 24px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Stock Report</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, background: '#eff6ff', color: '#1d4ed8', borderRadius: 20, padding: '3px 12px', fontWeight: 600 }}>
                {summary?.total_items ?? totalCount} Items
              </span>
              <span style={{ fontSize: 12, background: '#f0fdf4', color: '#15803d', borderRadius: 20, padding: '3px 12px', fontWeight: 600 }}>
                Purchase Value: {fmt(summary?.total_purchase_value)}
              </span>
              <span style={{ fontSize: 12, background: '#faf5ff', color: '#7e22ce', borderRadius: 20, padding: '3px 12px', fontWeight: 600 }}>
                Sale Value: {fmt(summary?.total_sale_value)}
              </span>
              <span style={{ fontSize: 12, background: '#fefce8', color: '#854d0e', borderRadius: 20, padding: '3px 12px', fontWeight: 600 }}>
                Profit Potential: {fmt(summary?.potential_profit)}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              prefix={<SearchOutlined style={{ color: '#9ca3af' }} />}
              placeholder="Search product / barcode…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              allowClear
              style={{ width: 220 }}
              size="middle"
            />
            <Select
              placeholder="Category"
              style={{ width: 160 }}
              allowClear
              onChange={(v) => setFilters(f => ({ ...f, category_id: v }))}
            >
              {categories.map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
            </Select>
            <Select
              placeholder="Stock Status"
              style={{ width: 140 }}
              allowClear
              onChange={(v) => setFilters(f => ({ ...f, stock_status: v }))}
            >
              <Select.Option value="low"><WarningOutlined style={{ color: '#d97706' }} /> Low Stock</Select.Option>
              <Select.Option value="out"><CloseCircleOutlined style={{ color: '#dc2626' }} /> Out of Stock</Select.Option>
            </Select>

            <Dropdown trigger={['click']} placement="bottomRight" dropdownRender={() => customizePopoverContent}>
              <button style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, color: '#374151', fontWeight: 600, fontSize: 13, padding: '7px 14px', cursor: 'pointer' }}>
                <SettingOutlined /> Customize
              </button>
            </Dropdown>

            <Upload accept=".xlsx,.xls,.csv" showUploadList={false} beforeUpload={handleImport} disabled={importing}>
              <button
                disabled={importing}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#4f46e5', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, padding: '7px 16px', cursor: importing ? 'not-allowed' : 'pointer', opacity: importing ? .7 : 1 }}
              >
                {importing ? <Spin size="small" style={{ filter: 'brightness(10)' }} /> : <UploadOutlined />}
                {importing ? (importPhase === 'processing' ? 'Processing…' : 'Uploading…') : 'Import'}
              </button>
            </Upload>

            {importing && (
              <div style={{ width: 160 }}>
                {importPhase === 'uploading'
                  ? <Progress percent={importProgress} size="small" strokeColor="#4f46e5" showInfo={false} />
                  : <Progress percent={100} size="small" status="active" strokeColor="#f59e0b" showInfo={false} />
                }
                <div style={{ fontSize: 10, color: '#9ca3af', textAlign: 'center', marginTop: 2 }}>
                  {importPhase === 'uploading' ? `Uploading ${importProgress}%` : 'Processing rows…'}
                </div>
              </div>
            )}

            <Tooltip title="Download import template">
              <button
                onClick={async () => {
                  try {
                    const { data } = await dataAPI.downloadTemplate('products');
                    const url = window.URL.createObjectURL(new Blob([data]));
                    const a = document.createElement('a'); a.href = url; a.download = 'products_template.xlsx'; a.click();
                  } catch { message.error('Template download failed'); }
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, color: '#374151', fontWeight: 600, fontSize: 13, padding: '7px 14px', cursor: 'pointer' }}
              >
                Template
              </button>
            </Tooltip>

            <button
              onClick={handleExport}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#16a34a', border: 'none', borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 13, padding: '7px 16px', cursor: 'pointer' }}
            >
              <DownloadOutlined /> Export
            </button>
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <VirtualReportTable
          columns={columns}
          rows={rows}
          totalCount={totalCount}
          ensureChunk={ensureChunk}
          loading={loading}
          rowKey="product_id"
          scroll={{ x: 1280 }}
          summaryCells={cols.totalRow ? summaryCells : undefined}
          summaryColSpan={cols.totalRow ? summaryColSpan : undefined}
        />
      </div>

      {/* ── Import Result Modal ── */}
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
              <div style={{ background: '#fef2f2', borderRadius: 8, padding: 16, color: '#dc2626', fontWeight: 600 }}>
                <CloseCircleOutlined style={{ marginRight: 8 }} />{importResult.error}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: '#15803d' }}>{importResult.imported || 0}</div>
                    <div style={{ fontSize: 11, color: '#15803d', fontWeight: 600 }}><CheckCircleOutlined /> Imported</div>
                  </div>
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: '#dc2626' }}>{importResult.skipped || 0}</div>
                    <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}><CloseCircleOutlined /> Not Imported</div>
                  </div>
                  <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: '#1d4ed8' }}>{importResult.total || 0}</div>
                    <div style={{ fontSize: 11, color: '#1d4ed8', fontWeight: 600 }}>Total Rows</div>
                  </div>
                </div>

                {importResult.errors?.length > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
                        Not Imported Rows ({importResult.errors.length})
                      </span>
                      <button
                        onClick={handleDownloadFailed}
                        disabled={downloadingFailed}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#dc2626', border: 'none', borderRadius: 6, color: '#fff', fontWeight: 600, fontSize: 12, padding: '5px 14px', cursor: 'pointer', opacity: downloadingFailed ? .7 : 1 }}
                      >
                        {downloadingFailed ? <Spin size="small" style={{ filter: 'brightness(10)' }} /> : <FileExcelOutlined />}
                        Download Failed Report
                      </button>
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #fee2e2', borderRadius: 8 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: '#fef2f2', position: 'sticky', top: 0 }}>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#dc2626', fontWeight: 700, borderBottom: '1px solid #fecaca', width: 60 }}>Row</th>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#dc2626', fontWeight: 700, borderBottom: '1px solid #fecaca' }}>Product</th>
                            <th style={{ padding: '6px 10px', textAlign: 'left', color: '#dc2626', fontWeight: 700, borderBottom: '1px solid #fecaca' }}>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importResult.errors.map((e, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #fef2f2', background: i % 2 === 0 ? '#fff' : '#fffafa' }}>
                              <td style={{ padding: '5px 10px', color: '#6b7280' }}>{e.row}</td>
                              <td style={{ padding: '5px 10px', color: '#374151', fontWeight: 600 }}>
                                {e.rowData?.['Product Name *'] || e.rowData?.['Product Name'] || e.rowData?.barcode || '—'}
                              </td>
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
