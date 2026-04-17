import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Input, Button, Modal, Form, InputNumber, Select,
  Row, Col, Divider, message, Tag, Tooltip, Spin, Empty, DatePicker,
} from 'antd';
import {
  SearchOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  BarcodeOutlined, ExportOutlined, MoreOutlined, ShareAltOutlined,
  FilterOutlined, DownOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { productAPI, categoryAPI, dataAPI } from '../../api';

const fmt  = (v) => `₹ ${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtN = (v) =>    parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const TYPE_COLOR = {
  Purchase: '#3b82f6',
  Sales: '#10b981',
  'Purchase Return': '#f59e0b',
  'Sales Return': '#ef4444',
  'Stock Adjustment': '#8b5cf6',
  'Opening Stock': '#6366f1',
};

export default function ProductList() {
  /* ── product list ── */
  const [products, setProducts]     = useState([]);
  const [productTotal, setProductTotal] = useState(0);
  const [productPage, setProductPage]   = useState(1);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const listEndRef = useRef(null);

  /* ── selected product ── */
  const [selected, setSelected]         = useState(null);
  const [txLoading, setTxLoading]       = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [txSearch, setTxSearch]         = useState('');
  const [txTypeFilter, setTxTypeFilter] = useState('All');

  /* ── form modal ── */
  const [categories, setCategories]     = useState([]);
  const [formVisible, setFormVisible]   = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [formLoading, setFormLoading]   = useState(false);
  const [form] = Form.useForm();

  /* ── load ── */
  useEffect(() => { loadCategories(); }, []);
  useEffect(() => { loadProducts(1, true); }, [search]);
  useEffect(() => { if (selected) loadTransactions(selected.product_id); }, [selected]);

  const PROD_LIMIT = 200;

  const loadProducts = async (page = 1, reset = false) => {
    if (page === 1) setLoading(true); else setLoadingMore(true);
    try {
      const { data } = await productAPI.getAll({ search, page, limit: PROD_LIMIT });
      const list = data.data || [];
      const total = data.total || 0;
      if (reset || page === 1) {
        setProducts(list);
        setProductPage(1);
        if (list.length > 0) setSelected(list[0]);
      } else {
        setProducts(prev => [...prev, ...list]);
        setProductPage(page);
      }
      setProductTotal(total);
    } catch { message.error('Failed to load products'); }
    if (page === 1) setLoading(false); else setLoadingMore(false);
  };

  /* ── infinite scroll for product list panel ── */
  const handleLoadMore = useCallback(() => {
    if (loadingMore || loading) return;
    if (products.length >= productTotal) return;
    loadProducts(productPage + 1, false);
  }, [loadingMore, loading, products.length, productTotal, productPage, search]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) handleLoadMore(); },
      { threshold: 0.1 }
    );
    if (listEndRef.current) observer.observe(listEndRef.current);
    return () => observer.disconnect();
  }, [handleLoadMore]);

  const loadCategories = async () => {
    try { const { data } = await categoryAPI.getAllFlat(); setCategories(data); } catch {}
  };

  const loadTransactions = async (productId) => {
    setTxLoading(true);
    try {
      const { data } = await productAPI.getStockMovement(productId);
      setTransactions(data || []);
    } catch { setTransactions([]); }
    setTxLoading(false);
  };

  /* ── form helpers ── */
  const openForm = async (product = null) => {
    setEditingProduct(product);
    if (product) {
      // Load existing opening stock entry if any
      let openingQty = 0, openingRate = product.purchase_rate, openingDate = dayjs();
      try {
        const { data: movements } = await productAPI.getStockMovement(product.product_id);
        const openingEntry = movements.find(m => m.transaction_type === 'Opening Stock');
        if (openingEntry) {
          openingQty  = parseFloat(openingEntry.quantity_in || 0);
          openingRate = parseFloat(openingEntry.rate || product.purchase_rate || 0);
          openingDate = dayjs(openingEntry.transaction_date);
        }
      } catch {}
      form.setFieldsValue({
        ...product,
        category_id: product.category_id,
        opening_stock: openingQty || null,
        opening_stock_rate: openingRate,
        opening_stock_date: openingDate,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ opening_stock_date: dayjs() });
    }
    setFormVisible(true);
  };

  const handleSubmit = async () => {
    setFormLoading(true);
    try {
      const values = await form.validateFields();
      // Convert dayjs date to string
      if (values.opening_stock_date) {
        values.opening_stock_date = dayjs(values.opening_stock_date).format('YYYY-MM-DD');
      }
      if (editingProduct) {
        await productAPI.update(editingProduct.product_id, values);
        message.success('Product updated');
      } else {
        const { data } = await productAPI.create(values);
        message.success(`Product added — Barcode: ${data.barcode || data.product?.barcode}`);
      }
      setFormVisible(false);
      await loadProducts();
      if (selected?.product_id === editingProduct?.product_id) {
        loadTransactions(editingProduct.product_id);
      }
    } catch (e) { message.error(e.response?.data?.error || 'Failed to save'); }
    setFormLoading(false);
  };

  const handleDelete = async (product) => {
    Modal.confirm({
      title: `Deactivate "${product.product_name}"?`,
      okText: 'Deactivate', okType: 'danger',
      onOk: async () => {
        try { await productAPI.delete(product.product_id); message.success('Product deactivated'); loadProducts(); }
        catch (e) { message.error({ content: e.response?.data?.error || 'Failed to deactivate', duration: 6 }); }
      },
    });
  };

  const marginChanged = () => {
    const pr = form.getFieldValue('purchase_rate') || 0;
    const mg = form.getFieldValue('margin_percentage') || 0;
    form.setFieldsValue({ sale_rate: +(pr * (1 + mg / 100)).toFixed(2) });
  };

  const handleExport = async () => {
    try {
      // Honor the search filter visible on-screen so the exported workbook
      // matches the list the user is actually looking at.
      const { data } = await dataAPI.exportExcel('products', search ? { search } : {});
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      // Date-stamp the filename (local date, not UTC) so daily exports don't
      // overwrite each other in Downloads/ and "which file is newer" is obvious.
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `products_export_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  /* ── group rows by bill then recalculate running balance ── */
  const groupedTx = React.useMemo(() => {
    // 1. Filter out old internal reversal entries (-REV)
    const filtered = transactions.filter(tx => !(tx.reference_number || '').endsWith('-REV'));

    // 2. Group by transaction_type + reference_number (collapses multiple product lines per bill).
    //    Weighted-average rate math: keep separate `_qtySum` (denominator) and
    //    `_rateSum` (numerator = Σ rate × qty). The previous version divided
    //    by `quantity_in + quantity_out` but seeded `_rateSum` with `rate × 1`
    //    when both directions were zero — inflating the numerator by one
    //    un-weighted unit that had no matching unit in the denominator. The
    //    bug only surfaced on zero-qty ledger rows (rare but possible for
    //    historical adjustments), where it produced a non-deterministic rate.
    const map = new Map();
    filtered.forEach(tx => {
      // Stock Adjustments are individual events — never group them
      const key = tx.transaction_type === 'Stock Adjustment'
        ? `Stock Adjustment||${tx.ledger_id}`
        : `${tx.transaction_type}||${tx.reference_number || tx.ledger_id}`;
      const txIn   = parseFloat(tx.quantity_in  || 0);
      const txOut  = parseFloat(tx.quantity_out || 0);
      const txQty  = txIn + txOut;            // one direction per line → safe sum
      const txRate = parseFloat(tx.rate || 0);
      if (map.has(key)) {
        const g = map.get(key);
        g.quantity_in  = +(parseFloat(g.quantity_in  || 0) + txIn ).toFixed(2);
        g.quantity_out = +(parseFloat(g.quantity_out || 0) + txOut).toFixed(2);
        g._rateSum    += txRate * txQty;
        g._qtySum     += txQty;
        // Fall back to previous rate when the new line is qty-zero so we
        // don't divide by zero — preserves the earlier weighted average.
        g.rate = g._qtySum > 0 ? +(g._rateSum / g._qtySum).toFixed(2) : g.rate;
        g._count += 1;
      } else {
        map.set(key, {
          ...tx,
          quantity_in:  txIn,
          quantity_out: txOut,
          _count: 1,
          _rateSum: txRate * txQty,
          _qtySum:  txQty,
          rate: txRate,
        });
      }
    });
    const groups = Array.from(map.values());

    // 3. Sort groups chronologically (ASC by date, then by ledger_id as tiebreaker)
    groups.sort((a, b) => {
      const da = new Date(a.transaction_date);
      const db = new Date(b.transaction_date);
      if (da - db !== 0) return da - db;
      return (a.ledger_id || 0) - (b.ledger_id || 0);
    });

    // 4. Recalculate running balance dynamically (do NOT trust stored balance_quantity)
    let running = 0;
    groups.forEach(g => {
      running = +(running + parseFloat(g.quantity_in || 0) - parseFloat(g.quantity_out || 0)).toFixed(2);
      g.running_balance = running;
    });

    return groups;
  }, [transactions]);

  /* ── filtered transactions ── */
  const filteredTx = groupedTx.filter(tx => {
    if (txTypeFilter !== 'All' && tx.transaction_type !== txTypeFilter) return false;
    if (!txSearch) return true;
    const q = txSearch.toLowerCase();
    return (
      (tx.transaction_type || '').toLowerCase().includes(q) ||
      (tx.reference_number || '').toLowerCase().includes(q) ||
      (tx.remarks || '').toLowerCase().includes(q) ||
      (tx.party_name || '').toLowerCase().includes(q)
    );
  });

  /* ── statement closing balance (from dynamically recalculated running balance) ── */
  const closingBalance = groupedTx.length > 0 ? groupedTx[groupedTx.length - 1].running_balance : null;

  /* ── stock value for selected ── */
  // Always use product.current_stock as authoritative; ledger closingBalance may lag if a
  // previous transaction failed to create its ledger entry (getStockMovement auto-reconciles).
  const effectiveStock = parseFloat(selected?.current_stock || 0);
  const stockValue = selected
    ? (effectiveStock * parseFloat(selected.purchase_rate || 0))
    : 0;

  return (
    <div style={{ display:'flex', height:'calc(100vh - 64px)', background:'#f8fafc', overflow:'hidden' }}>

      {/* ════════════════ LEFT PANEL ════════════════ */}
      <div style={{ width:300, flexShrink:0, borderRight:'1px solid #e5e7eb', display:'flex', flexDirection:'column', background:'#fff', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ padding:'12px 16px', borderBottom:'1px solid #f3f4f6', display:'flex', alignItems:'center', gap:8 }}>
          <Tooltip title="Search">
            <button onClick={()=>setShowSearch(s=>!s)} style={{ background:'none', border:'none', cursor:'pointer', color:'#6b7280', fontSize:16, padding:'4px', borderRadius:6, display:'flex', alignItems:'center' }}>
              <SearchOutlined/>
            </button>
          </Tooltip>
          <div style={{ flex:1 }}/>
          <button
            onClick={() => openForm()}
            style={{ display:'flex', alignItems:'center', gap:6, background:'#f59e0b', border:'none', borderRadius:7, color:'#fff', fontWeight:700, fontSize:13, padding:'6px 14px', cursor:'pointer' }}>
            <PlusOutlined/> Add Item
          </button>
          <Tooltip title="Export Excel">
            <button onClick={handleExport} style={{ background:'none', border:'1px solid #e5e7eb', borderRadius:6, cursor:'pointer', padding:'5px 8px', color:'#6b7280', display:'flex', alignItems:'center' }}>
              <ExportOutlined/>
            </button>
          </Tooltip>
        </div>

        {/* Search box */}
        {showSearch && (
          <div style={{ padding:'8px 12px', borderBottom:'1px solid #f3f4f6' }}>
            <Input
              autoFocus
              prefix={<SearchOutlined style={{ color:'#9ca3af' }}/>}
              placeholder="Search products…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              allowClear
              size="small"
            />
          </div>
        )}

        {/* Column headers */}
        <div style={{ display:'flex', alignItems:'center', padding:'6px 16px', borderBottom:'1px solid #f3f4f6', background:'#fafafa' }}>
          <span style={{ flex:1, fontSize:11, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.6 }}>Item</span>
          <FilterOutlined style={{ fontSize:10, color:'#d1d5db', marginRight:8 }}/>
          <span style={{ fontSize:11, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.6 }}>Quantity</span>
        </div>

        {/* Product list */}
        <div style={{ flex:1, overflowY:'auto' }}>
          {loading ? (
            <div style={{ display:'flex', justifyContent:'center', padding:32 }}><Spin/></div>
          ) : products.length === 0 ? (
            <Empty description="No products" style={{ marginTop:40 }}/>
          ) : (
            <>
            {products.map(p => {
              const isActive = selected?.product_id === p.product_id;
              const stock    = parseFloat(p.current_stock || 0);
              const stockColor = stock < 0 ? '#ef4444' : stock === 0 ? '#ef4444' : '#10b981';
              return (
                <div key={p.product_id}
                  onClick={() => setSelected(p)}
                  style={{
                    display:'flex', alignItems:'center', padding:'9px 12px 9px 16px',
                    cursor:'pointer', borderBottom:'1px solid #f9fafb',
                    background: isActive ? '#eff6ff' : 'transparent',
                    borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
                    transition:'background .12s',
                  }}
                >
                  <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
                    <span style={{ fontSize:13, fontWeight: isActive ? 600 : 400, color: isActive ? '#1d4ed8' : '#374151', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {p.product_name}
                      {p.size_value && <span style={{ fontSize:11, color:'#9ca3af', marginLeft:4 }}>{p.size_value}</span>}
                    </span>
                    {p.barcode && (
                      <span style={{ fontSize:10, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {p.barcode}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize:13, fontWeight:700, color:stockColor, minWidth:36, textAlign:'right' }}>{stock}</span>
                  <Tooltip title="Options">
                    <button
                      onClick={e => { e.stopPropagation(); }}
                      style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af', fontSize:15, padding:'0 4px', marginLeft:6 }}
                    >
                      <MoreOutlined/>
                    </button>
                  </Tooltip>
                </div>
              );
            })}
            <div ref={listEndRef} style={{ padding:8, textAlign:'center' }}>
              {loadingMore
                ? <Spin size="small"/>
                : products.length < productTotal
                  ? <span style={{ fontSize:12, color:'#9ca3af' }}>Scroll for more…</span>
                  : null}
            </div>
            </>
          )}
        </div>
      </div>

      {/* ════════════════ RIGHT PANEL ════════════════ */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'#fff', borderLeft:'1px solid #e5e7eb' }}>
        {!selected ? (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <Empty description="Select a product to view details"/>
          </div>
        ) : (
          <>
            {/* Product header */}
            <div style={{ padding:'14px 24px', borderBottom:'1px solid #e5e7eb', background:'#fff' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <span style={{ fontSize:16, fontWeight:700, color:'#111827' }}>{selected.product_name}</span>
                  {selected.size_value && <Tag style={{ fontSize:11 }}>{selected.size_value}</Tag>}
                  {selected.barcode && <Tag icon={<BarcodeOutlined/>} color="blue" style={{ fontSize:11, }}>{selected.barcode}</Tag>}
                  <ShareAltOutlined style={{ color:'#9ca3af', cursor:'pointer' }}/>
                </div>
                <button
                  onClick={() => openForm(selected)}
                  style={{ display:'flex', alignItems:'center', gap:6, background:'#3b82f6', border:'none', borderRadius:7, color:'#fff', fontWeight:700, fontSize:13, padding:'7px 16px', cursor:'pointer' }}>
                  ⊞ ADJUST ITEM
                </button>
              </div>

              {/* Stats row */}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <div style={{ display:'flex', gap:32 }}>
                  <div>
                    <span style={{ fontSize:11, color:'#9ca3af', fontWeight:600, textTransform:'uppercase', letterSpacing:.5 }}>Sale Price: </span>
                    <span style={{ fontSize:13, fontWeight:700, color:'#10b981' }}>{fmt(selected.sale_rate)}</span>
                    <span style={{ fontSize:11, color:'#9ca3af' }}> (excl.)</span>
                  </div>
                  <div>
                    <span style={{ fontSize:11, color:'#9ca3af', fontWeight:600, textTransform:'uppercase', letterSpacing:.5 }}>Purchase Price: </span>
                    <span style={{ fontSize:13, fontWeight:700, color:'#3b82f6' }}>{fmt(selected.purchase_rate)}</span>
                    <span style={{ fontSize:11, color:'#9ca3af' }}> (excl.)</span>
                  </div>
                </div>
                <div style={{ display:'flex', gap:32 }}>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, textTransform:'uppercase', letterSpacing:.5 }}>Stock Quantity</div>
                    <div style={{ fontSize:14, fontWeight:800, color: parseFloat(selected.current_stock||0) >= 0 ? '#10b981' : '#ef4444' }}>
                      {fmtN(selected.current_stock)}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, textTransform:'uppercase', letterSpacing:.5 }}>Stock Value</div>
                    <div style={{ fontSize:14, fontWeight:800, color:'#3b82f6' }}>{fmt(stockValue)}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Transactions section */}
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', padding:'0' }}>
              {/* Transactions header */}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 24px', borderBottom:'1px solid #f3f4f6', gap:12, flexWrap:'wrap' }}>
                {/* Left: label + type filter chips */}
                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                  <span style={{ fontSize:13, fontWeight:700, color:'#374151', textTransform:'uppercase', letterSpacing:.8 }}>Transactions</span>
                  <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                    {['All','Purchase','Sales','Purchase Return','Sales Return','Stock Adjustment','Opening Stock'].map(type => {
                      const active = txTypeFilter === type;
                      const colors = {
                        'All':               { bg: active ? '#4f46e5' : '#f3f4f6', color: active ? '#fff' : '#6b7280', dot: null },
                        'Purchase':          { bg: active ? '#dbeafe' : '#f3f4f6', color: active ? '#1d4ed8' : '#6b7280', dot: '#3b82f6' },
                        'Sales':             { bg: active ? '#dcfce7' : '#f3f4f6', color: active ? '#15803d' : '#6b7280', dot: '#10b981' },
                        'Purchase Return':   { bg: active ? '#fef3c7' : '#f3f4f6', color: active ? '#b45309' : '#6b7280', dot: '#f59e0b' },
                        'Sales Return':      { bg: active ? '#fee2e2' : '#f3f4f6', color: active ? '#b91c1c' : '#6b7280', dot: '#ef4444' },
                        'Stock Adjustment':  { bg: active ? '#ede9fe' : '#f3f4f6', color: active ? '#6d28d9' : '#6b7280', dot: '#8b5cf6' },
                        'Opening Stock':     { bg: active ? '#e0e7ff' : '#f3f4f6', color: active ? '#4338ca' : '#6b7280', dot: '#6366f1' },
                      };
                      const c = colors[type];
                      return (
                        <button
                          key={type}
                          onClick={() => setTxTypeFilter(type)}
                          style={{
                            display:'flex', alignItems:'center', gap:6,
                            background: c.bg, color: c.color,
                            border: active ? 'none' : '1px solid #e5e7eb',
                            borderRadius:20, padding:'6px 16px',
                            fontSize:13, fontWeight: active ? 700 : 500,
                            cursor:'pointer', transition:'all .15s',
                            whiteSpace:'nowrap', lineHeight:1,
                          }}
                        >
                          {c.dot && <span style={{ width:8, height:8, borderRadius:'50%', background:c.dot, display:'inline-block', flexShrink:0 }}/>}
                          {type}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* Right: search + export */}
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <Input
                    prefix={<SearchOutlined style={{ color:'#9ca3af' }}/>}
                    placeholder="Search…"
                    value={txSearch}
                    onChange={e => setTxSearch(e.target.value)}
                    allowClear
                    size="small"
                    style={{ width:180 }}
                  />
                  <Tooltip title="Export Excel">
                    <button onClick={handleExport} style={{ background:'#16a34a', border:'none', borderRadius:6, cursor:'pointer', padding:'5px 10px', color:'#fff', display:'flex', alignItems:'center', fontSize:13 }}>
                      ⬇ XLS
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* Table header */}
              <div style={{ display:'grid', gridTemplateColumns:'140px 110px 110px 1fr 100px 110px 90px', padding:'8px 24px', borderBottom:'2px solid #f3f4f6', background:'#fafafa' }}>
                {['Type','Invoice/Ref. No','Date','Party / Remarks','Quantity','Price/Unit','Balance Qty'].map(h => (
                  <div key={h} style={{ fontSize:11, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.5, display:'flex', alignItems:'center', gap:4 }}>
                    {h} <FilterOutlined style={{ fontSize:9, color:'#d1d5db' }}/>
                  </div>
                ))}
              </div>

              {/* Table body */}
              <div style={{ flex:1, overflowY:'auto' }}>
                {txLoading ? (
                  <div style={{ display:'flex', justifyContent:'center', padding:40 }}><Spin/></div>
                ) : filteredTx.length === 0 ? (
                  <Empty description="No transactions" style={{ marginTop:40 }}/>
                ) : (
                  [...filteredTx].reverse().map((tx, i) => {
                    const qtyIn  = parseFloat(tx.quantity_in  || 0);
                    const qtyOut = parseFloat(tx.quantity_out || 0);
                    const qty = qtyIn > 0 ? `+${fmtN(qtyIn)}` : `-${fmtN(qtyOut)}`;
                    const dotColor = TYPE_COLOR[tx.transaction_type] || '#6b7280';
                    return (
                      <div key={tx.ledger_id}
                        style={{
                          display:'grid', gridTemplateColumns:'140px 110px 110px 1fr 100px 110px 90px',
                          padding:'10px 24px', borderBottom:'1px solid #f9fafb',
                          background: i % 2 === 0 ? '#fff' : '#fafafa',
                          alignItems:'center',
                          transition:'background .1s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background='#eff6ff'}
                        onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafa'}
                      >
                        {/* Type */}
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <span style={{ width:8, height:8, borderRadius:'50%', background:dotColor, flexShrink:0, display:'inline-block' }}/>
                          <span style={{ fontSize:13, fontWeight:500, color:'#374151' }}>{tx.transaction_type}</span>
                        </div>

                        {/* Invoice/Ref */}
                        <div style={{ fontSize:13, color:'#374151', fontWeight:500 }}>{tx.reference_number || '—'}</div>

                        {/* Date */}
                        <div style={{ fontSize:13, color:'#374151' }}>
                          {tx.transaction_date ? dayjs(tx.transaction_date).format('DD/MM/YYYY') : '—'}
                        </div>

                        {/* Party Name */}
                        <div style={{ fontSize:13, color:'#374151', fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {tx.party_name || tx.remarks || '—'}
                        </div>

                        {/* Quantity */}
                        <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
                          <span style={{ fontSize:13, fontWeight:700, color: parseFloat(tx.quantity_in||0)>0 ? '#374151' : '#ef4444' }}>
                            {qty}
                          </span>
                          {tx._count > 1 && (
                            <span style={{ fontSize:10, color:'#9ca3af', fontWeight:500 }}>
                              {tx._count} items
                            </span>
                          )}
                        </div>

                        {/* Price/Unit */}
                        <div style={{ fontSize:13, color:'#374151', textAlign:'right', paddingRight:8 }}>
                          {parseFloat(tx.rate || 0) > 0 ? `₹ ${fmtN(tx.rate)}` : '—'}
                        </div>

                        {/* Balance Qty */}
                        <div style={{ fontSize:13, fontWeight:700, color: tx.running_balance >= 0 ? '#374151' : '#ef4444' }}>
                          {fmtN(tx.running_balance)}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ════════ Add / Edit Modal ════════ */}
      <Modal
        title={editingProduct ? `Edit — ${editingProduct.product_name}` : 'Add New Product'}
        open={formVisible}
        onCancel={() => setFormVisible(false)}
        onOk={handleSubmit}
        confirmLoading={formLoading}
        width={680}
        destroyOnClose
        okText={editingProduct ? 'Update' : 'Add Product'}
      >
        <Form form={form} layout="vertical" size="middle">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="barcode" label="Barcode" help="Leave blank to auto-generate">
                <Input placeholder="Auto-generate" prefix={<BarcodeOutlined/>}/>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="category_id" label="Category" rules={[{ required:true, message:'Required' }]}>
                <Select placeholder="Select category" showSearch optionFilterProp="children">
                  {categories.map(c => <Select.Option key={c.category_id} value={c.category_id}>{c.category_name}</Select.Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="product_name" label="Product Name" rules={[{ required:true, message:'Required' }]}>
                <Input placeholder="Product name"/>
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}><Form.Item name="size_value" label="Size"><Input placeholder="S/M/L/XL"/></Form.Item></Col>
            <Col span={6}><Form.Item name="article_number" label="Article No"><Input/></Form.Item></Col>
            <Col span={6}><Form.Item name="hsn_code" label="HSN Code"><Input/></Form.Item></Col>
            <Col span={6}><Form.Item name="gst_rate" label="GST %"><InputNumber style={{ width:'100%' }} min={0}/></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}><Form.Item name="unit_of_measurement" label="Unit" initialValue="PCS">
              <Select>{['PCS','KG','METER','LITER','BOX','DOZEN'].map(u=><Select.Option key={u}>{u}</Select.Option>)}</Select>
            </Form.Item></Col>
            <Col span={6}><Form.Item name="quantity_per_box" label="Qty/Box"><InputNumber style={{ width:'100%' }} min={1}/></Form.Item></Col>
            <Col span={6}><Form.Item name="minimum_stock_level" label="Min Stock"><InputNumber style={{ width:'100%' }} min={0}/></Form.Item></Col>
            <Col span={6}><Form.Item name="reorder_level" label="Reorder Level"><InputNumber style={{ width:'100%' }} min={0}/></Form.Item></Col>
          </Row>
          <Divider plain>Pricing</Divider>
          <Row gutter={16}>
            <Col span={6}><Form.Item name="purchase_rate" label="Purchase Rate" rules={[{ required:true }]}>
              <InputNumber style={{ width:'100%' }} min={0} prefix="₹" onChange={marginChanged}/></Form.Item></Col>
            <Col span={6}><Form.Item name="margin_percentage" label="Margin %">
              <InputNumber style={{ width:'100%' }} min={0} suffix="%" onChange={marginChanged}/></Form.Item></Col>
            <Col span={6}><Form.Item name="sale_rate" label="Sale Rate" rules={[{ required:true }]}>
              <InputNumber style={{ width:'100%' }} min={0} prefix="₹"/></Form.Item></Col>
            <Col span={6}><Form.Item name="mrp" label="MRP">
              <InputNumber style={{ width:'100%' }} min={0} prefix="₹"/></Form.Item></Col>
          </Row>

          <Divider plain>
            <span style={{ color:'#6366f1', fontWeight:600 }}>Opening Stock</span>
          </Divider>
          <div style={{ background:'#f5f3ff', border:'1px solid #e0e7ff', borderRadius:8, padding:'12px 16px' }}>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="opening_stock" label="Opening Qty" style={{ marginBottom:0 }}>
                  <InputNumber style={{ width:'100%' }} min={0} placeholder="0" precision={2}/>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="opening_stock_rate" label="Rate / Unit" style={{ marginBottom:0 }}>
                  <InputNumber style={{ width:'100%' }} min={0} prefix="₹" placeholder="Purchase rate" precision={2}/>
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="opening_stock_date" label="As of Date" style={{ marginBottom:0 }}>
                  <DatePicker style={{ width:'100%' }} format="DD/MM/YYYY"/>
                </Form.Item>
              </Col>
            </Row>
            <div style={{ marginTop:8, fontSize:12, color:'#6b7280' }}>
              Leave Opening Qty blank or 0 if no opening stock.
            </div>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
