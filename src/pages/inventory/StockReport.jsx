import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Input, Select, message, Tooltip, Spin, Empty, Upload, Modal, Progress, Table,
} from 'antd';
import {
  SearchOutlined, DownloadOutlined, UploadOutlined,
  WarningOutlined, CheckCircleOutlined, CloseCircleOutlined, FileExcelOutlined,
} from '@ant-design/icons';
import { reportAPI, categoryAPI, dataAPI } from '../../api';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) =>    parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const SERVER_PAGE = 100; // rows per server request

export default function StockReport() {
  const [products, setProducts]      = useState([]);
  const [summary, setSummary]        = useState({});
  const [total, setTotal]            = useState(0);
  const [serverPage, setServerPage]  = useState(1);
  const [hasMore, setHasMore]        = useState(true);
  const [categories, setCategories]  = useState([]);
  const [loading, setLoading]        = useState(false);
  const [loadingMore, setLoadingMore]= useState(false);
  const [importing, setImporting]        = useState(false);
  const [importModal, setImportModal]    = useState(false);
  const [importResult, setImportResult]  = useState(null);
  const [importProgress, setImportProgress] = useState(0);
  const [importPhase, setImportPhase]    = useState('');
  const [downloadingFailed, setDownloadingFailed] = useState(false);
  const [filters, setFilters]        = useState({ search: '', category_id: null, stock_status: null });

  const loaderRef = useRef(null);

  /* ── initial / filter-change load ── */
  useEffect(() => {
    loadFirstPage();
  }, [filters]);

  useEffect(() => { loadCategories(); }, []);

  const loadFirstPage = async () => {
    setLoading(true);
    setProducts([]);
    setServerPage(1);
    setHasMore(true);
    try {
      const res = await reportAPI.getStockReport({ ...filters, page: 1, limit: SERVER_PAGE });
      const { data = [], summary: s = {}, total: t = 0 } = res.data;
      setProducts(data);
      setSummary(s);
      setTotal(t);
      setServerPage(1);
      setHasMore(data.length < t);
    } catch { message.error('Failed to load stock report'); }
    setLoading(false);
  };

  /* ── load next page when sentinel enters viewport ── */
  const loadNextPage = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const next = serverPage + 1;
    try {
      const res = await reportAPI.getStockReport({ ...filters, page: next, limit: SERVER_PAGE });
      const { data = [], total: t = 0 } = res.data;
      setProducts(prev => [...prev, ...data]);
      setTotal(t);
      setServerPage(next);
      setHasMore(next * SERVER_PAGE < t);
    } catch { message.error('Failed to load more'); }
    setLoadingMore(false);
  }, [loadingMore, hasMore, serverPage, filters]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadNextPage(); },
      { threshold: 0.1 }
    );
    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [loadNextPage, loading]);

  /* ── export ── */
  const handleExport = async () => {
    try {
      // Use the filter-aware Stock Report export so the workbook matches the
      // on-screen category/status/search filters (not a dump of all products).
      const { data } = await reportAPI.exportStockReport(filters);
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      // Date-stamp with LOCAL date so daily exports don't overwrite each other.
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
      await loadFirstPage();
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

  const loadCategories = async () => {
    try { const { data } = await categoryAPI.getAllFlat(); setCategories(data); } catch {}
  };

  const stockColor = (v, min) => {
    const q = parseFloat(v);
    // Negative stock is a data-integrity flag — means the ledger has more
    // sales than purchases for that product, usually from a cancelled/deleted
    // receipt or a bad stock-adjust. Flag it visually (distinct from "Out").
    if (q < 0) return { bg:'#fdf2f8', color:'#be185d', label:'Negative' };
    if (q === 0) return { bg:'#fef2f2', color:'#dc2626', label:'Out' };
    if (min > 0 && q <= parseFloat(min)) return { bg:'#fffbeb', color:'#d97706', label:'Low' };
    return { bg:'#f0fdf4', color:'#16a34a', label:'OK' };
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 64px)', background:'#f8fafc', overflow:'hidden' }}>

      {/* ── Top bar ── */}
      <div style={{ background:'#fff', borderBottom:'1px solid #e5e7eb', padding:'12px 24px', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
          {/* Title + summary chips */}
          <div style={{ display:'flex', alignItems:'center', gap:16, flexWrap:'wrap' }}>
            <span style={{ fontSize:16, fontWeight:700, color:'#111827' }}>Stock Report</span>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <span style={{ fontSize:12, background:'#eff6ff', color:'#1d4ed8', borderRadius:20, padding:'3px 12px', fontWeight:600 }}>
                {summary.total_items ?? total} Items
              </span>
              <span style={{ fontSize:12, background:'#f0fdf4', color:'#15803d', borderRadius:20, padding:'3px 12px', fontWeight:600 }}>
                Purchase Value: {fmt(summary.total_purchase_value)}
              </span>
              <span style={{ fontSize:12, background:'#faf5ff', color:'#7e22ce', borderRadius:20, padding:'3px 12px', fontWeight:600 }}>
                Sale Value: {fmt(summary.total_sale_value)}
              </span>
              <span style={{ fontSize:12, background:'#fefce8', color:'#854d0e', borderRadius:20, padding:'3px 12px', fontWeight:600 }}>
                Profit Potential: {fmt(summary.potential_profit)}
              </span>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
            <Input
              prefix={<SearchOutlined style={{ color:'#9ca3af' }}/>}
              placeholder="Search product / barcode…"
              value={filters.search}
              onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
              allowClear
              style={{ width:220 }}
              size="middle"
            />
            <Select
              placeholder="Category"
              style={{ width:160 }}
              allowClear
              onChange={v => setFilters(f => ({ ...f, category_id: v }))}
            >
              {categories.map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
            </Select>
            <Select
              placeholder="Stock Status"
              style={{ width:140 }}
              allowClear
              onChange={v => setFilters(f => ({ ...f, stock_status: v }))}
            >
              <Select.Option value="low"><WarningOutlined style={{ color:'#d97706' }}/> Low Stock</Select.Option>
              <Select.Option value="out"><CloseCircleOutlined style={{ color:'#dc2626' }}/> Out of Stock</Select.Option>
            </Select>

            {/* Import button */}
            <Upload
              accept=".xlsx,.xls,.csv"
              showUploadList={false}
              beforeUpload={handleImport}
              disabled={importing}
            >
              <button
                disabled={importing}
                style={{ display:'flex', alignItems:'center', gap:6, background:'#4f46e5', border:'none', borderRadius:8, color:'#fff', fontWeight:600, fontSize:13, padding:'7px 16px', cursor: importing ? 'not-allowed' : 'pointer', opacity: importing ? .7 : 1 }}
              >
                {importing ? <Spin size="small" style={{ filter:'brightness(10)' }}/> : <UploadOutlined/>}
                {importing ? (importPhase === 'processing' ? 'Processing…' : 'Uploading…') : 'Import'}
              </button>
            </Upload>

            {importing && (
              <div style={{ width:160 }}>
                {importPhase === 'uploading'
                  ? <Progress percent={importProgress} size="small" strokeColor="#4f46e5" showInfo={false}/>
                  : <Progress percent={100} size="small" status="active" strokeColor="#f59e0b" showInfo={false}/>
                }
                <div style={{ fontSize:10, color:'#9ca3af', textAlign:'center', marginTop:2 }}>
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
                style={{ display:'flex', alignItems:'center', gap:6, background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, color:'#374151', fontWeight:600, fontSize:13, padding:'7px 14px', cursor:'pointer' }}
              >
                Template
              </button>
            </Tooltip>

            <button
              onClick={handleExport}
              style={{ display:'flex', alignItems:'center', gap:6, background:'#16a34a', border:'none', borderRadius:8, color:'#fff', fontWeight:600, fontSize:13, padding:'7px 16px', cursor:'pointer' }}
            >
              <DownloadOutlined/> Export
            </button>
          </div>
        </div>
      </div>

      {/* ── Column headers ── */}
      <div style={{
        display:'grid',
        gridTemplateColumns:'46px 130px 130px 1fr 70px 110px 90px 90px 120px 120px 130px',
        padding:'8px 24px',
        borderBottom:'2px solid #e5e7eb',
        background:'#f9fafb',
        flexShrink:0,
      }}>
        {['#','Barcode','Category','Product','Size','Article No','Opening','Stock','Pur. Rate','Sale Rate','Stock Value'].map(h => (
          <div key={h} style={{ fontSize:11, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.5 }}>
            {h}
          </div>
        ))}
      </div>

      {/* ── Virtualized scroll list ── */}
      <div style={{ flex:1, overflowY:'auto' }}>
        {loading ? (
          <div style={{ display:'flex', justifyContent:'center', padding:60 }}><Spin size="large"/></div>
        ) : products.length === 0 ? (
          <Empty description="No products found" style={{ marginTop:60 }}/>
        ) : (
          <>
            {products.map((p, i) => {
              const stock    = parseFloat(p.current_stock || 0);
              const opening  = parseFloat(p.opening_stock || 0);
              const stockVal = stock * parseFloat(p.purchase_rate || 0);
              const sc = stockColor(stock, p.minimum_stock_level);
              return (
                <div
                  key={p.product_id}
                  style={{
                    display:'grid',
                    gridTemplateColumns:'46px 130px 130px 1fr 70px 110px 90px 90px 120px 120px 130px',
                    padding:'10px 24px',
                    borderBottom:'1px solid #f3f4f6',
                    background: i % 2 === 0 ? '#fff' : '#fafafa',
                    alignItems:'center',
                    transition:'background .1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background='#eff6ff'}
                  onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafa'}
                >
                  <div style={{ fontSize:12, color:'#9ca3af', fontWeight:600 }}>{i + 1}</div>
                  <div style={{ fontSize:12, color:'#6b7280' }}>{p.barcode || '—'}</div>
                  <div style={{ fontSize:13, color:'#6b7280' }}>{p.Category?.category_name || '—'}</div>
                  <div style={{ fontSize:13, fontWeight:600, color:'#111827' }}>
                    {p.product_name}
                  </div>
                  <div style={{ fontSize:13, color:'#374151' }}>{p.size_value || '—'}</div>
                  <div style={{ fontSize:13, color:'#374151' }}>{p.article_number || '—'}</div>
                  {/* Opening Stock */}
                  <div style={{ fontSize:13, color:'#6366f1', fontWeight:600 }}>{fmtN(opening)}</div>
                  {/* Current Stock */}
                  <div>
                    <span style={{ fontSize:13, fontWeight:700, color: sc.color, background: sc.bg, borderRadius:6, padding:'2px 8px' }}>
                      {fmtN(stock)}
                    </span>
                  </div>
                  <div style={{ fontSize:13, color:'#374151' }}>{fmt(p.purchase_rate)}</div>
                  <div style={{ fontSize:13, color:'#10b981', fontWeight:600 }}>{fmt(p.sale_rate)}</div>
                  <div style={{ fontSize:13, fontWeight:700, color:'#3b82f6' }}>{fmt(stockVal)}</div>
                </div>
              );
            })}

            {/* Sentinel */}
            <div ref={loaderRef} style={{ padding:16, textAlign:'center' }}>
              {loadingMore
                ? <Spin size="small"/>
                : hasMore
                  ? <span style={{ fontSize:12, color:'#9ca3af' }}>Scroll for more…</span>
                  : <span style={{ fontSize:12, color:'#9ca3af' }}>All {total} items loaded</span>
              }
            </div>
          </>
        )}
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
          <div style={{ padding:'8px 0' }}>
            {importResult.failed ? (
              <div style={{ background:'#fef2f2', borderRadius:8, padding:16, color:'#dc2626', fontWeight:600 }}>
                <CloseCircleOutlined style={{ marginRight:8 }}/>{importResult.error}
              </div>
            ) : (
              <>
                <div style={{ display:'flex', gap:12, marginBottom:16, flexWrap:'wrap' }}>
                  <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:8, padding:'10px 20px', textAlign:'center' }}>
                    <div style={{ fontSize:22, fontWeight:800, color:'#15803d' }}>{importResult.imported || 0}</div>
                    <div style={{ fontSize:11, color:'#15803d', fontWeight:600 }}><CheckCircleOutlined/> Imported</div>
                  </div>
                  <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:8, padding:'10px 20px', textAlign:'center' }}>
                    <div style={{ fontSize:22, fontWeight:800, color:'#dc2626' }}>{importResult.skipped || 0}</div>
                    <div style={{ fontSize:11, color:'#dc2626', fontWeight:600 }}><CloseCircleOutlined/> Not Imported</div>
                  </div>
                  <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:'10px 20px', textAlign:'center' }}>
                    <div style={{ fontSize:22, fontWeight:800, color:'#1d4ed8' }}>{importResult.total || 0}</div>
                    <div style={{ fontSize:11, color:'#1d4ed8', fontWeight:600 }}>Total Rows</div>
                  </div>
                </div>

                {importResult.errors?.length > 0 && (
                  <>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                      <span style={{ fontSize:13, fontWeight:700, color:'#374151' }}>
                        Not Imported Rows ({importResult.errors.length})
                      </span>
                      <button
                        onClick={handleDownloadFailed}
                        disabled={downloadingFailed}
                        style={{ display:'flex', alignItems:'center', gap:6, background:'#dc2626', border:'none', borderRadius:6, color:'#fff', fontWeight:600, fontSize:12, padding:'5px 14px', cursor:'pointer', opacity: downloadingFailed ? .7 : 1 }}
                      >
                        {downloadingFailed ? <Spin size="small" style={{ filter:'brightness(10)' }}/> : <FileExcelOutlined/>}
                        Download Failed Report
                      </button>
                    </div>
                    <div style={{ maxHeight:220, overflowY:'auto', border:'1px solid #fee2e2', borderRadius:8 }}>
                      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                        <thead>
                          <tr style={{ background:'#fef2f2', position:'sticky', top:0 }}>
                            <th style={{ padding:'6px 10px', textAlign:'left', color:'#dc2626', fontWeight:700, borderBottom:'1px solid #fecaca', width:60 }}>Row</th>
                            <th style={{ padding:'6px 10px', textAlign:'left', color:'#dc2626', fontWeight:700, borderBottom:'1px solid #fecaca' }}>Product</th>
                            <th style={{ padding:'6px 10px', textAlign:'left', color:'#dc2626', fontWeight:700, borderBottom:'1px solid #fecaca' }}>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importResult.errors.map((e, i) => (
                            <tr key={i} style={{ borderBottom:'1px solid #fef2f2', background: i%2===0?'#fff':'#fffafa' }}>
                              <td style={{ padding:'5px 10px', color:'#6b7280' }}>{e.row}</td>
                              <td style={{ padding:'5px 10px', color:'#374151', fontWeight:600 }}>
                                {e.rowData?.['Product Name *'] || e.rowData?.['Product Name'] || e.rowData?.barcode || '—'}
                              </td>
                              <td style={{ padding:'5px 10px', color:'#dc2626' }}>{e.reason}</td>
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
