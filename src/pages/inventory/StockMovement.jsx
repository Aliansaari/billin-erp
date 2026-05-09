import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Input, Spin, message, Select } from 'antd';
import { SearchOutlined, AppstoreOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { productAPI, dataAPI, settingsAPI } from '../../api';
import ActionStrip from '../../components/keyboard/ActionStrip';
import '../../styles/editorial-product-list.css';

dayjs.extend(relativeTime);

/*
 * StockMovement — per-product ledger view.
 *
 *   Left pane: searchable product picker (name / barcode / HSN / article).
 *   Right pane: header stats for the selected product + transaction
 *   ledger (Opening Stock, Purchase, Sale, Purchase Return, Sales Return,
 *   Stock Adjustment) with a dynamically-recalculated running balance.
 *
 * Grouping: the raw ledger has one row per bill line. We collapse rows
 * that share (transaction_type, reference_number) so a 12-item bill
 * shows as a single ledger entry — matching how the old ProductList's
 * right panel used to display it. Weighted-average rate over the
 * grouped quantities.
 *
 * Running balance: computed dynamically (ASC by date → cumulative
 * in - out). We do NOT trust `balance_quantity` from the server
 * because partial failures can leave it drifted.
 *
 * Direct-linking: /stock-movement/:productId pre-selects the product.
 * Clicking another product in the picker updates the URL so the view
 * is bookmarkable and the back button works.
 */

const TX_TYPES = [
  { key: 'All',              label: 'All',              cls: '' },
  { key: 'Opening Stock',    label: 'Opening',          cls: 'opening' },
  { key: 'Purchase',         label: 'Purchase',         cls: 'purchase' },
  { key: 'Sales',            label: 'Sale',             cls: 'sale' },
  { key: 'Purchase Return',  label: 'Pur. Return',      cls: 'preturn' },
  { key: 'Sales Return',     label: 'Sales Return',     cls: 'sreturn' },
  { key: 'Stock Adjustment', label: 'Adjustment',       cls: 'adjust' },
];

const fmtMoney = (v) => parseFloat(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtQty   = (v) => parseFloat(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const CAT_PALETTE = ['#7A9660','#B1472F','#4F6A7A','#B8923C','#7F5AA3','#6D5F4E','#3F5A4A','#CA7537','#8E4F2E','#55503F'];
function catColor(name) {
  if (!name) return 'var(--ed-fg-3)';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CAT_PALETTE[h % CAT_PALETTE.length];
}

function healthOf(p) {
  const stock = parseFloat(p?.current_stock || 0);
  const min   = parseFloat(p?.minimum_stock_level || 0);
  if (stock === 0) return { kind: 'out',  label: 'Out of stock' };
  if (stock < 0)   return { kind: 'out',  label: 'Negative' };
  if (min > 0 && stock <= min) return { kind: 'low', label: 'Low' };
  return { kind: 'ok', label: 'Healthy' };
}

export default function StockMovement() {
  // Route is declared as `stock-movement/*` (splat) so the component stays
  // mounted when navigating between the empty and populated forms — the
  // old `:productId` param name no longer exists, it's now the `*` splat.
  const params = useParams();
  const productId = params['*'] || undefined;
  const navigate = useNavigate();

  // Esc handling is now owned by the ActionStrip below — keeps a single
  // source of truth for window keybindings on this page.

  /* ── product picker ── */
  const [products, setProducts] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState('');
  const listBoxRef = useRef(null);
  const searchInputRef = useRef(null);

  /* ── selected product + transactions ── */
  const [selected, setSelected] = useState(null);
  const [txLoading, setTxLoading] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [txType, setTxType] = useState('All');
  const [txSearch, setTxSearch] = useState('');
  // Batch filter (Commit 5 — Part E). Only meaningful when global
  // batch tracking is on AND the selected product is batch-tracked.
  // 'All' shows every movement regardless of batch_id; a specific id
  // restricts the table to rows where stock_ledger.batch_id matches.
  const [batchFilter, setBatchFilter] = useState('All');
  const [batchTrackingOn, setBatchTrackingOn] = useState(false);

  /* Load product list when search changes (debounced) */
  useEffect(() => {
    const timer = setTimeout(() => { loadProducts(); }, search ? 220 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Batch-tracking toggle — read once on mount. Used to gate the
  // batch-filter dropdown (we don't want to render an inert filter
  // on installs that never enabled batch tracking).
  useEffect(() => {
    settingsAPI.getSystem()
      .then(({ data }) => setBatchTrackingOn(!!data?.data?.batch_tracking_enabled))
      .catch(() => {});
  }, []);

  // Reset batch filter whenever the selected product changes — the
  // dropdown options come from the new product's movements, so the
  // old selection would point at a batch this product doesn't have.
  useEffect(() => { setBatchFilter('All'); }, [selected?.product_id]);

  /* Deep-link: if URL has productId, fetch + select it */
  useEffect(() => {
    if (!productId) return;
    // Prefer the list entry if we already have it — avoids one round trip
    const fromList = products.find(p => String(p.product_id) === String(productId));
    if (fromList) { setSelected(fromList); return; }
    productAPI.getById(productId)
      .then(({ data }) => setSelected(data))
      .catch(() => message.error('Product not found'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  /* Load transactions whenever selected product changes.
   * We deliberately do NOT clear `transactions` synchronously — that causes a
   * visible "blink" where the header stats snap to zero and the ledger
   * unmounts before the new data arrives. Instead we keep the previous
   * product's rows rendered behind a loading overlay (`txLoading`) and only
   * swap them in when the fetch resolves. The cancel flag prevents an
   * in-flight response from overwriting a newer selection. */
  useEffect(() => {
    if (!selected) { setTransactions([]); return; }
    setTxLoading(true);
    let cancelled = false;
    productAPI.getStockMovement(selected.product_id)
      .then(({ data }) => {
        if (cancelled) return;
        setTransactions(data || []);
      })
      .catch(() => {
        if (cancelled) return;
        setTransactions([]);
        message.error('Failed to load movement');
      })
      .finally(() => {
        if (cancelled) return;
        setTxLoading(false);
      });
    return () => { cancelled = true; };
  }, [selected]);

  const loadProducts = async () => {
    setLoadingList(true);
    try {
      const { data } = await productAPI.getAll({ search, page: 1, limit: 200 });
      const list = data.data || [];
      setProducts(list);
      // If nothing selected yet and no URL param, auto-select first hit —
      // matches the old right-panel behaviour so the page isn't empty on load.
      if (!selected && !productId && list.length > 0) setSelected(list[0]);
    } catch { message.error('Failed to load products'); }
    setLoadingList(false);
  };

  const handleSelect = useCallback((p) => {
    setSelected(p);
    navigate(`/stock-movement/${p.product_id}`, { replace: true });
  }, [navigate]);

  /* ── Group rows + recalc running balance ── */
  const groupedTx = useMemo(() => {
    // Filter old reversal rows (-REV) left behind by historical data.
    const filtered = (transactions || []).filter(tx => !(tx.reference_number || '').endsWith('-REV'));

    // Group by (transaction_type, reference_number) so multi-line bills
    // collapse into one ledger entry. Stock Adjustments stay ungrouped.
    const map = new Map();
    for (const tx of filtered) {
      const key = tx.transaction_type === 'Stock Adjustment'
        ? `Stock Adjustment||${tx.ledger_id}`
        : `${tx.transaction_type}||${tx.reference_number || tx.ledger_id}`;
      const txIn  = parseFloat(tx.quantity_in  || 0);
      const txOut = parseFloat(tx.quantity_out || 0);
      const txQty = txIn + txOut;
      const txRate = parseFloat(tx.rate || 0);
      if (map.has(key)) {
        const g = map.get(key);
        g.quantity_in  = +(parseFloat(g.quantity_in  || 0) + txIn ).toFixed(2);
        g.quantity_out = +(parseFloat(g.quantity_out || 0) + txOut).toFixed(2);
        g._rateSum += txRate * txQty;
        g._qtySum  += txQty;
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
    }
    const groups = Array.from(map.values());

    // Sort ASC by date, then ledger_id as tiebreaker so balances line up.
    groups.sort((a, b) => {
      const da = new Date(a.transaction_date), db = new Date(b.transaction_date);
      if (da - db !== 0) return da - db;
      return (a.ledger_id || 0) - (b.ledger_id || 0);
    });

    let running = 0;
    for (const g of groups) {
      running = +(running + parseFloat(g.quantity_in || 0) - parseFloat(g.quantity_out || 0)).toFixed(2);
      g.running_balance = running;
    }
    return groups;
  }, [transactions]);

  /* Type counts for filter chips */
  const typeCounts = useMemo(() => {
    const counts = { All: groupedTx.length };
    for (const tx of groupedTx) counts[tx.transaction_type] = (counts[tx.transaction_type] || 0) + 1;
    return counts;
  }, [groupedTx]);

  // Distinct batches that touched this product, sorted FEFO/FIFO so
  // the dropdown reads in the same order the picker does on the bill
  // form. Built from the raw transactions before grouping (we need
  // batch_id at the per-row level — grouping collapses identity).
  const batchOpts = useMemo(() => {
    if (!selected?.is_batch_tracked || !batchTrackingOn) return [];
    const map = new Map();
    for (const tx of (transactions || [])) {
      if (!tx.batch_id || !tx.batch) continue;
      if (!map.has(tx.batch_id)) {
        map.set(tx.batch_id, {
          batch_id:        tx.batch_id,
          batch_number:    tx.batch.batch_number,
          manufacture_date: tx.batch.manufacture_date,
          expiry_date:     tx.batch.expiry_date,
        });
      }
    }
    const list = Array.from(map.values());
    list.sort((a, b) => {
      const ax = a.expiry_date ? new Date(a.expiry_date).getTime() : Number.POSITIVE_INFINITY;
      const bx = b.expiry_date ? new Date(b.expiry_date).getTime() : Number.POSITIVE_INFINITY;
      if (ax !== bx) return ax - bx;
      return (a.batch_number || '').localeCompare(b.batch_number || '');
    });
    return list;
  }, [transactions, selected?.is_batch_tracked, batchTrackingOn]);

  const filteredTx = useMemo(() => {
    return groupedTx.filter(tx => {
      if (txType !== 'All' && tx.transaction_type !== txType) return false;
      // Batch filter: 'All' passes everything; a specific id restricts
      // to rows where the underlying ledger row's batch_id matches.
      if (batchFilter !== 'All' && tx.batch_id !== batchFilter) return false;
      if (!txSearch) return true;
      const q = txSearch.toLowerCase();
      return (
        (tx.transaction_type || '').toLowerCase().includes(q) ||
        (tx.reference_number || '').toLowerCase().includes(q) ||
        (tx.remarks || '').toLowerCase().includes(q) ||
        (tx.party_name || '').toLowerCase().includes(q) ||
        (tx.batch?.batch_number || '').toLowerCase().includes(q)
      );
    });
  }, [groupedTx, txType, txSearch, batchFilter]);

  /* Stats for the header — Opening Stock is its own bucket, NOT a "Total In"
   * event, so the four numbers add up cleanly:
   *   Opening + Total In − Total Out = Closing
   */
  const stats = useMemo(() => {
    let totIn = 0, totOut = 0, openQty = 0;
    for (const g of groupedTx) {
      if (g.transaction_type === 'Opening Stock') {
        openQty += parseFloat(g.quantity_in || 0);
        continue;
      }
      totIn  += parseFloat(g.quantity_in  || 0);
      totOut += parseFloat(g.quantity_out || 0);
    }
    const closing = groupedTx.length ? groupedTx[groupedTx.length - 1].running_balance : parseFloat(selected?.current_stock || 0);
    return { totIn, totOut, openQty, closing };
  }, [groupedTx, selected]);

  const handleExport = async () => {
    if (!selected) return;
    try {
      const { data } = await dataAPI.exportExcel('products', { search: selected.product_name });
      const url = window.URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock_movement_${selected.product_id}_${stamp}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { message.error('Export failed'); }
  };

  return (
    // Outer wrapper is flex COLUMN so the ActionStrip below sits at
    // the bottom of the viewport. The aside + section are nested
    // inside `.sm-body` so they flow side-by-side. Class name is
    // deliberately NOT `.sm-row` — that's already used by the inner
    // ledger row markup (header + data rows) and the more-specific
    // page-level selector would have inherited the wrong layout.
    <div className="ed-prod sm-page">
     <div className="sm-body">

      {/* ── Left: product picker ── */}
      <aside className="sm-pick">
        <div className="sm-pick-hd">
          <h2>Stock Movement</h2>
          <div className="sub">{products.length} products{products.length >= 200 ? '+' : ''} · pick one</div>
        </div>
        <div className="sm-pick-search">
          <Input
            ref={searchInputRef}
            placeholder="Search name, barcode, HSN, article"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            size="middle"
            autoFocus
          />
        </div>
        <div className="sm-pick-list" ref={listBoxRef}>
          {loadingList ? (
            <div className="sm-pick-empty"><Spin size="small" /></div>
          ) : products.length === 0 ? (
            <div className="sm-pick-empty">
              {search ? `No match for "${search}"` : 'No products yet.'}
            </div>
          ) : (
            products.map(p => {
              const active = selected?.product_id === p.product_id;
              const h = healthOf(p);
              const stk = parseFloat(p.current_stock || 0);
              return (
                <div
                  key={p.product_id}
                  className={`sm-pick-row${active ? ' active' : ''}`}
                  onClick={() => handleSelect(p)}
                >
                  <div className="nm">
                    {p.product_name}
                    {p.size_value && <span className="p-var" style={{ marginLeft: 6 }}>{p.size_value}</span>}
                  </div>
                  <div className="meta">
                    <span>{p.barcode || p.hsn_code || '—'}</span>
                    <span className={`qty${h.kind === 'out' ? ' out' : h.kind === 'low' ? ' low' : ''}`}>
                      {fmtQty(stk)} {p.unit_of_measurement || 'pcs'}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Right: selected product + ledger ── */}
      <section className="sm-main">
        {!selected ? (
          <div className="sm-main-empty">
            <div className="big">Pick a product</div>
            Search on the left — by name, barcode, HSN, or article number — to see its stock movement.
          </div>
        ) : (
          <>
            <div className="sm-hd">
              <div className="sm-hd-top">
                <div>
                  <h1>{selected.product_name}{selected.size_value ? ` · ${selected.size_value}` : ''}</h1>
                  <div className="meta-row">
                    {selected.Category?.category_name && (
                      <span className="tag">
                        <span className="cat-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: catColor(selected.Category.category_name), display: 'inline-block' }} />
                        {selected.Category.category_name}
                      </span>
                    )}
                    {selected.barcode   && <span className="tag">BC {selected.barcode}</span>}
                    {selected.hsn_code  && <span className="tag">HSN {selected.hsn_code}</span>}
                    {selected.gst_rate != null && <span className="tag">GST {selected.gst_rate}%</span>}
                    {selected.article_number && <span className="tag">Art. {selected.article_number}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="ed-cta ghost" onClick={() => navigate('/products')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                    All Products
                  </button>
                  <button className="ed-cta ghost" onClick={handleExport}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Export
                  </button>
                </div>
              </div>

              <div className="sm-stats">
                <div className="sm-stat">
                  <div className="k">On Hand</div>
                  <div className={`v ${healthOf(selected).kind === 'out' ? 'out' : healthOf(selected).kind === 'low' ? 'warn' : 'ok'}`}>
                    {fmtQty(selected.current_stock)} {selected.unit_of_measurement || 'pcs'}
                  </div>
                </div>
                <div className="sm-stat">
                  <div className="k">Opening Stock</div>
                  <div className="v">{fmtQty(stats.openQty)} {selected.unit_of_measurement || 'pcs'}</div>
                </div>
                <div className="sm-stat">
                  <div className="k">Total In</div>
                  <div className="v ok">+{fmtQty(stats.totIn)} {selected.unit_of_measurement || 'pcs'}</div>
                </div>
                <div className="sm-stat">
                  <div className="k">Total Out</div>
                  <div className="v out">−{fmtQty(stats.totOut)} {selected.unit_of_measurement || 'pcs'}</div>
                </div>
                {/* Cost tile: label + value branch on the product's mode.
                    Variant uses the catalog purchase_rate (overwritten on
                    each purchase). Single mode uses display_cost from the
                    backend — weighted_avg_cost for non-batch products,
                    or the per-batch weighted average for batch-tracked.
                    The transaction TABLE below still shows each line's
                    own rate from stock_ledger, so the operator can
                    always see "Mill A charged ₹100, Mill B ₹120". */}
                <div className="sm-stat">
                  <div className="k">{selected.product_mode === 'single' ? 'Avg Cost' : 'Purchase Rate'}</div>
                  <div className="v">₹ {fmtMoney(selected.display_cost ?? selected.purchase_rate)}</div>
                </div>
                <div className="sm-stat">
                  <div className="k">Sale Rate</div>
                  <div className="v">₹ {fmtMoney(selected.sale_rate)}</div>
                </div>
                <div className="sm-stat">
                  <div className="k">Stock Value</div>
                  <div className="v">₹ {fmtMoney(selected.display_stock_value ?? (parseFloat(selected.current_stock || 0) * parseFloat(selected.purchase_rate || 0)))}</div>
                </div>
              </div>
            </div>

            <div className="sm-filter">
              {TX_TYPES.map(t => (
                <button
                  key={t.key}
                  className={`sm-type${txType === t.key ? ' on' : ''}`}
                  onClick={() => setTxType(t.key)}
                >
                  {t.cls && <span className="dot" style={{
                    background:
                      t.cls === 'opening'  ? '#6366F1' :
                      t.cls === 'purchase' ? 'var(--ed-ok)' :
                      t.cls === 'sale'     ? 'var(--ed-accent)' :
                      t.cls === 'preturn'  ? 'var(--ed-warn)' :
                      t.cls === 'sreturn'  ? 'var(--ed-danger)' :
                      t.cls === 'adjust'   ? '#8B5CF6' : 'var(--ed-fg-3)',
                  }} />}
                  {t.label}
                  <span className="n">{typeCounts[t.key] || 0}</span>
                </button>
              ))}
              <span style={{ flex: 1 }} />
              {/* Batch filter (Commit 5) — appears for batch-tracked
               *  products when the global toggle is on. Default 'All
               *  Batches' reads the full ledger; selecting a specific
               *  batch restricts the table to that lot's movements
               *  and updates the running balance to the per-batch
               *  ledger rather than the per-product total. */}
              {batchTrackingOn && selected?.is_batch_tracked && batchOpts.length > 0 && (
                <Select
                  size="middle"
                  prefix={<AppstoreOutlined />}
                  value={batchFilter}
                  onChange={setBatchFilter}
                  style={{ width: 220 }}
                  options={[
                    { value: 'All', label: `All Batches (${batchOpts.length})` },
                    ...batchOpts.map((b) => ({
                      value: b.batch_id,
                      label: `${b.batch_number}${b.expiry_date ? ` · Exp ${dayjs(b.expiry_date).format('DD MMM YY')}` : ''}`,
                    })),
                  ]}
                />
              )}
              <Input
                placeholder="Search bill, party, remark"
                prefix={<SearchOutlined />}
                value={txSearch}
                onChange={(e) => setTxSearch(e.target.value)}
                allowClear
                size="middle"
                style={{ width: 240 }}
              />
            </div>

            <div className="sm-ledger-wrap">
              <div className="sm-ledger">
                <div className="sm-row head">
                  <div className="sm-c-date">Date</div>
                  <div className="sm-c-type">Type</div>
                  <div className="sm-c-ref">Invoice / Ref.</div>
                  <div className="sm-c-party">Party / Remarks</div>
                  <div className="sm-c-qty">Quantity</div>
                  <div className="sm-c-rate">Rate</div>
                  <div className="sm-c-bal">Balance</div>
                </div>
                <div className="sm-ledger-scroll" style={{ position: 'relative' }}>
                  {txLoading && (
                    <div style={{
                      position: 'absolute', top: 0, left: 0, right: 0,
                      height: 2, overflow: 'hidden', zIndex: 3,
                      background: 'transparent',
                    }}>
                      <div style={{
                        width: '40%', height: '100%',
                        background: 'var(--accent, #4F46E5)',
                        animation: 'sm-loading-bar 1.1s ease-in-out infinite',
                      }} />
                    </div>
                  )}
                  {filteredTx.length === 0 && !txLoading ? (
                    <div className="ed-empty">
                      {txSearch || txType !== 'All'
                        ? 'No matching transactions.'
                        : 'No stock movement for this product yet.'}
                    </div>
                  ) : (
                    [...filteredTx].reverse().map((tx) => {
                      const qtyIn  = parseFloat(tx.quantity_in  || 0);
                      const qtyOut = parseFloat(tx.quantity_out || 0);
                      const isIn   = qtyIn > 0;
                      const typeDef = TX_TYPES.find(t => t.key === tx.transaction_type);
                      const cls = typeDef?.cls || '';
                      return (
                        <div className="sm-row data" key={tx.ledger_id}>
                          <div className="sm-c-date">
                            <span className="sm-date">
                              {tx.transaction_date ? dayjs(tx.transaction_date).format('DD MMM YYYY') : '—'}
                              {tx.transaction_date && (
                                <span className="t">{dayjs(tx.transaction_date).fromNow()}</span>
                              )}
                            </span>
                          </div>
                          <div className="sm-c-type">
                            <span className={`tx-type ${cls}`}><span className="dot" />{typeDef?.label || tx.transaction_type}</span>
                          </div>
                          <div className="sm-c-ref">
                            <span className="sm-ref">{tx.reference_number || '—'}</span>
                          </div>
                          <div className="sm-c-party">
                            <span className="sm-party">
                              {tx.party_name || tx.remarks || '—'}
                              {tx._count > 1 && <span className="r">{tx._count} items bundled</span>}
                              {tx.remarks && tx.party_name && tx.remarks !== tx.party_name && <span className="r">{tx.remarks}</span>}
                              {/* Lot sub-line — visible only in 'All Batches'
                               *  mode for batched products. When the operator
                               *  filters to a specific batch the column would
                               *  be redundant. */}
                              {batchTrackingOn && batchFilter === 'All' && tx.batch?.batch_number && (
                                <span className="r" style={{ color: 'var(--accent, #4F46E5)', fontWeight: 600 }}>
                                  Lot {tx.batch.batch_number}
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="sm-c-qty">
                            <span className={`sm-qty ${isIn ? 'in' : 'out'}`}>
                              {isIn ? '+' : '−'}{fmtQty(isIn ? qtyIn : qtyOut)}
                            </span>
                          </div>
                          <div className="sm-c-rate">
                            <span className="sm-rate">
                              {parseFloat(tx.rate || 0) > 0 ? `₹ ${fmtMoney(tx.rate)}` : '—'}
                            </span>
                          </div>
                          <div className="sm-c-bal">
                            <span className="sm-bal" style={{ color: tx.running_balance < 0 ? 'var(--ed-danger)' : undefined }}>
                              {fmtQty(tx.running_balance)}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="ed-foot">
                  <span>Shown: <b>{filteredTx.length} of {groupedTx.length}</b></span>
                  <span>Opening: <b>{fmtQty(stats.openQty)}</b></span>
                  <span>In: <b style={{ color: 'var(--ed-ok)' }}>+{fmtQty(stats.totIn)}</b></span>
                  <span>Out: <b style={{ color: 'var(--ed-danger)' }}>−{fmtQty(stats.totOut)}</b></span>
                  <span>Closing: <b>{fmtQty(stats.closing)}</b></span>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
     </div>{/* /.sm-body */}

      <ActionStrip
        actions={[
          {
            id: 'back', key: 'Esc', label: 'Back',
            onAction: () => navigate(-1),
          },
          {
            id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus?.(),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => {
              loadProducts();
              if (selected) setSelected({ ...selected });
            },
          },
          {
            id: 'print', key: 'F9', label: 'Print',
            onAction: () => window.print(),
          },
          {
            id: 'export', key: 'F10', label: 'Export',
            disabled: !selected,
            onAction: handleExport,
          },
        ]}
      />
    </div>
  );
}
