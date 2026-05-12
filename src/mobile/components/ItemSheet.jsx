import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { productAPI, categoryAPI } from '../../api';
import './sheet.css';

export default function ItemSheet(props) {
  return ReactDOM.createPortal(<ItemSheetInner {...props} />, document.body);
}

/* ItemSheet — manual add / edit of a single bill line.
 * `initial` may be: existing item (edit), { barcode } (scan pre-fill),
 * or null (fresh). Type 'sale' vs 'purchase' switches which product
 * rate gets defaulted (sale_rate vs purchase_rate). */
function ItemSheetInner({ type, initial, onClose, onSave }) {
  const isPurchase = type === 'purchase';
  const init = initial || {};

  const [productQuery, setProductQuery] = useState(init.product_name || '');
  const [results, setResults] = useState([]);
  const [picked, setPicked]   = useState(init.product_id ? init : null);
  const [searchFocused, setSearchFocused] = useState(false);

  const [categoryId, setCategoryId] = useState(init.category_id || null);
  const [categories, setCategories] = useState([]);
  const [catSheetOpen, setCatSheetOpen] = useState(false);

  const [quantity, setQuantity] = useState(init.quantity != null ? String(init.quantity) : '1');
  const [rate, setRate]         = useState(init.rate != null ? String(init.rate) : '');
  const [discPct, setDiscPct]   = useState(init.discount_percentage != null ? String(init.discount_percentage) : '0');
  const [gstRate, setGstRate]   = useState(init.gst_rate != null ? String(init.gst_rate) : '0');
  // Purchase-only: MRP and our intended sale price. Margin% is
  // derived from purchase_rate (`rate`) and `saleRate` on the fly.
  const [mrp, setMrp]           = useState(init.mrp != null ? String(init.mrp) : '');
  const [saleRate, setSaleRate] = useState(init.sale_rate != null ? String(init.sale_rate) : '');
  // Variant identifiers — shown for both sale + purchase so the
  // operator can pin down the right SKU or stamp a new one.
  const [size, setSize]               = useState(init.size || '');
  const [articleNumber, setArticleNumber] = useState(init.article_number || '');
  // Pieces / box — drives the stock-accounting box math on the server.
  // Editable on purchase so the operator can correct a supplier who
  // sent a different carton size than what's in the master.
  const [qpb, setQpb] = useState(init.quantity_per_box != null ? String(init.quantity_per_box) : '1');

  const searchRef = useRef(null);

  // Load categories once
  useEffect(() => {
    categoryAPI.getAllFlat()
      .then((r) => {
        const rows = Array.isArray(r.data) ? r.data : (r.data?.data || []);
        setCategories(rows);
      })
      .catch(() => setCategories([]));
  }, []);

  // Product search — runs on query OR category change. When a category
  // is selected and the search is empty, we still list products from
  // that category (so the user can pick from the filtered list without
  // typing).
  useEffect(() => {
    const q = productQuery.trim();
    // Skip search if a product is already picked and the query matches it
    if (picked && picked.product_name === q && !categoryId) return;

    const t = setTimeout(() => {
      const params = { limit: 30 };
      if (categoryId) params.category_id = categoryId;
      if (q) params.search = q;
      // No query AND no category → don't bother fetching
      if (!q && !categoryId) {
        setResults([]);
        return;
      }
      productAPI.getAll(params)
        .then((r) => {
          const rows = Array.isArray(r.data) ? r.data : (r.data?.data || []);
          setResults(rows);
        })
        .catch(() => setResults([]));
    }, 220);
    return () => clearTimeout(t);
  }, [productQuery, categoryId, picked]);

  // Barcode pre-fill from scan
  useEffect(() => {
    if (init.barcode && !init.product_id) {
      productAPI.getByBarcode(init.barcode)
        .then((r) => {
          const p = r.data;
          if (p) handlePickProduct(p);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePickProduct = (p) => {
    const qpbFromMaster = Number(p.quantity_per_box) || 1;
    setPicked({
      product_id: p.product_id || p.id,
      product_name: p.product_name || p.name,
      barcode: p.barcode || init.barcode || '',
      hsn_code: p.hsn_code || '',
      gst_rate: Number(p.gst_rate) || 0,
      unit_type: p.unit_of_measurement || 'Pcs',
      quantity_per_box: qpbFromMaster,
      mrp: Number(p.mrp) || 0,
      size: p.size_value || '',
      article_number: p.article_number || '',
      category_id: p.category_id || categoryId || null,
      category_name: p.category_name || '',
    });
    setProductQuery(p.product_name || p.name);
    // Pre-fill variant fields from the master so the operator doesn't
    // retype size/article on every line. They can still override.
    if (p.size_value && !size) setSize(p.size_value);
    if (p.article_number && !articleNumber) setArticleNumber(p.article_number);
    const newRate = isPurchase
      ? Number(p.purchase_rate || p.last_purchase_rate || 0)
      : Number(p.sale_rate || 0);
    if (newRate > 0) setRate(String(newRate));
    setGstRate(String(Number(p.gst_rate) || 0));
    if (isPurchase) {
      if (Number(p.mrp) > 0) setMrp(String(p.mrp));
      if (Number(p.sale_rate) > 0) setSaleRate(String(p.sale_rate));
    }
    // Pre-fill pcs/box from master if the user hasn't already set a value.
    if (qpb === '1' || !qpb) setQpb(String(qpbFromMaster));
    // Wholesale default: 1 full box of pieces if qpb > 1.
    if (qpbFromMaster > 1 && (quantity === '' || quantity === '1')) {
      setQuantity(String(qpbFromMaster));
    }
    setSearchFocused(false);
    searchRef.current?.blur();
  };

  const dismissKeyboard = () => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    setSearchFocused(false);
  };

  // Live totals
  const q = Number(quantity) || 0;
  const r = Number(rate) || 0;
  const dp = Number(discPct) || 0;
  const gst = Number(gstRate) || 0;
  const mrpN = Number(mrp) || 0;
  const saleRateN = Number(saleRate) || 0;
  const gross = q * r;
  const lineDisc = gross * dp / 100;
  const taxable = gross - lineDisc;
  const tax = taxable * gst / 100;
  const total = taxable + tax;
  // Margin = (sale − purchase) / purchase × 100. Negative if user
  // sets sale below cost (we let them — the warning is on display).
  const margin = (isPurchase && r > 0 && saleRateN > 0)
    ? ((saleRateN - r) / r) * 100
    : 0;

  const valid = (picked || productQuery.trim().length > 0) && q > 0 && r >= 0;

  const handleSave = () => {
    if (!valid) return;
    onSave({
      product_id: picked?.product_id || null,
      barcode: picked?.barcode || init.barcode || '',
      product_name: picked?.product_name || productQuery.trim(),
      hsn_code: picked?.hsn_code || '',
      gst_rate: gst,
      unit_type: picked?.unit_type || 'Pcs',
      quantity_per_box: Number(qpb) || picked?.quantity_per_box || 1,
      mrp: mrpN,
      sale_rate: saleRateN,         // purchase-only — sale handler ignores
      margin_percentage: margin,    // purchase-only
      size: (size || picked?.size || '').trim(),
      article_number: (articleNumber || picked?.article_number || '').trim(),
      category_id: picked?.category_id || categoryId || null,
      category_name: picked?.category_name || '',
      quantity: q,
      rate: r,                       // sale_rate for sales, purchase_rate for purchases
      discount_percentage: dp,
    });
  };

  const selectedCategory = useMemo(
    () => categories.find((c) => (c.category_id || c.id) === categoryId),
    [categories, categoryId],
  );

  const showResults = searchFocused && results.length > 0;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet sheet--tall" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2 className="sheet-title">{init.product_id ? 'Edit item' : 'Add item'}</h2>
          <button className="sheet-close" onClick={onClose}>Cancel</button>
        </div>

        <div className="sheet-body sheet-body--form">
          {/* Category picker — sits above product so user can filter
              the search before typing. */}
          <label className="sf-field">
            <span className="sf-label">Category</span>
            <button
              type="button"
              className="sf-picker"
              onClick={() => setCatSheetOpen(true)}
            >
              <span className={selectedCategory ? 'sf-picker-val' : 'sf-picker-placeholder'}>
                {selectedCategory ? (selectedCategory.category_name || selectedCategory.name) : 'All categories'}
              </span>
              {selectedCategory && (
                <span
                  className="sf-picker-clear"
                  onClick={(e) => { e.stopPropagation(); setCategoryId(null); }}
                  role="button"
                  aria-label="Clear"
                >✕</span>
              )}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="sf-picker-chev"><path d="M6 9l6 6 6-6"/></svg>
            </button>
          </label>

          {/* Product picker */}
          <label className="sf-field">
            <span className="sf-label-row">
              <span className="sf-label">Product</span>
              {searchFocused && (
                <button type="button" className="sf-done" onClick={dismissKeyboard}>Done</button>
              )}
            </span>
            <input
              ref={searchRef}
              className="sf-input"
              placeholder="Search product or type name…"
              value={productQuery}
              onChange={(e) => { setProductQuery(e.target.value); setPicked(null); }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
              autoCorrect="off"
              autoCapitalize="words"
              spellCheck="false"
            />
          </label>

          {showResults && (
            <div className="sf-results">
              {results.map((p) => {
                const qpb = Number(p.quantity_per_box) || 0;
                const rate = isPurchase
                  ? Number(p.purchase_rate || p.last_purchase_rate || 0)
                  : Number(p.sale_rate || 0);
                return (
                  <button
                    key={p.product_id || p.id}
                    className="sf-result"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handlePickProduct(p)}
                  >
                    <div className="sf-result-name">{p.product_name || p.name}</div>
                    <div className="sf-result-meta">
                      {[
                        p.size_value && `Size ${p.size_value}`,
                        qpb > 1 && `${qpb} pcs/box`,
                        rate > 0 && `₹${rate.toFixed(0)}`,
                        Number(p.current_stock) > 0 && `${Math.floor(Number(p.current_stock))} in stock`,
                        p.hsn_code && `HSN ${p.hsn_code}`,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Size + Article # — variant pins. Shown for both sale and
              purchase. Pre-fills from the product master on pick. */}
          <div className="sf-grid">
            <label className="sf-field">
              <span className="sf-label">Size</span>
              <input
                className="sf-input"
                placeholder="M, 32, XL…"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck="false"
              />
            </label>
            <label className="sf-field">
              <span className="sf-label">Article #</span>
              <input
                className="sf-input"
                placeholder="ART-2841"
                value={articleNumber}
                onChange={(e) => setArticleNumber(e.target.value)}
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck="false"
              />
            </label>
          </div>

          {/* Quantity + Rate */}
          <div className="sf-grid">
            <label className="sf-field">
              <span className="sf-label">Quantity</span>
              <input
                className="sf-input"
                type="number"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <label className="sf-field">
              <span className="sf-label">{isPurchase ? 'Purchase rate' : 'Rate'}</span>
              <input
                className="sf-input"
                type="number"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0.00"
              />
            </label>
          </div>

          {/* Purchase only: pcs / box paired with MRP. */}
          {isPurchase && (
            <div className="sf-grid">
              <label className="sf-field">
                <span className="sf-label">Pcs / box</span>
                <input
                  className="sf-input"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={qpb}
                  onChange={(e) => setQpb(e.target.value)}
                  placeholder="1"
                />
              </label>
              <label className="sf-field">
                <span className="sf-label">MRP</span>
                <input
                  className="sf-input"
                  type="number"
                  inputMode="decimal"
                  value={mrp}
                  onChange={(e) => setMrp(e.target.value)}
                  placeholder="0.00"
                />
              </label>
            </div>
          )}

          {/* Sale only: Discount %. Purchase doesn't typically carry line-disc. */}
          {!isPurchase && (
            <div className="sf-grid">
              <label className="sf-field">
                <span className="sf-label">Discount %</span>
                <input
                  className="sf-input"
                  type="number"
                  inputMode="decimal"
                  value={discPct}
                  onChange={(e) => setDiscPct(e.target.value)}
                />
              </label>
              <label className="sf-field">
                <span className="sf-label">GST %</span>
                <input
                  className="sf-input"
                  type="number"
                  inputMode="decimal"
                  value={gstRate}
                  onChange={(e) => setGstRate(e.target.value)}
                />
              </label>
            </div>
          )}

          {/* Purchase only: Margin% (auto) → Sale rate → GST%.
              Operator types purchase rate above, sees margin update
              live as they fill Sale rate, then sets GST. */}
          {isPurchase && (
            <>
              <div className="sf-grid">
                <label className="sf-field">
                  <span className="sf-label">Margin %</span>
                  <input
                    className="sf-input"
                    type="text"
                    readOnly
                    value={margin ? `${margin.toFixed(2)}%` : '—'}
                    style={{
                      color: margin < 0 ? 'var(--c-error)' : (margin >= 10 ? 'var(--c-success)' : 'var(--c-text-2)'),
                      fontWeight: 600,
                    }}
                  />
                </label>
                <label className="sf-field">
                  <span className="sf-label">Sale rate</span>
                  <input
                    className="sf-input"
                    type="number"
                    inputMode="decimal"
                    value={saleRate}
                    onChange={(e) => setSaleRate(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
              </div>
              <div className="sf-grid">
                <label className="sf-field">
                  <span className="sf-label">GST %</span>
                  <input
                    className="sf-input"
                    type="number"
                    inputMode="decimal"
                    value={gstRate}
                    onChange={(e) => setGstRate(e.target.value)}
                  />
                </label>
                <span /> {/* spacer to keep grid alignment */}
              </div>
            </>
          )}

          <div className="sf-preview">
            <div className="sf-preview-row">
              <span>Subtotal</span>
              <span>₹{gross.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
            </div>
            {lineDisc > 0 && (
              <div className="sf-preview-row">
                <span>Discount</span>
                <span>−₹{lineDisc.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
              </div>
            )}
            {tax > 0 && (
              <div className="sf-preview-row">
                <span>GST ({gst}%)</span>
                <span>₹{tax.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
              </div>
            )}
            <div className="sf-preview-row sf-preview-row--total">
              <span>Line total</span>
              <span>₹{total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
            </div>
          </div>
        </div>

        <div className="sheet-footer">
          <button className="sf-save" onClick={handleSave} disabled={!valid}>
            {init.product_id ? 'Update item' : 'Add item'}
          </button>
        </div>
      </div>

      {catSheetOpen && (
        <CategorySheet
          categories={categories}
          selectedId={categoryId}
          onPick={(id) => { setCategoryId(id); setCatSheetOpen(false); }}
          onClose={() => setCatSheetOpen(false)}
        />
      )}
    </div>
  );
}

function CategorySheet({ categories, selectedId, onPick, onClose }) {
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => { setTimeout(() => ref.current?.focus(), 80); }, []);
  const filtered = q.trim()
    ? categories.filter((c) => String(c.category_name || c.name || '').toLowerCase().includes(q.trim().toLowerCase()))
    : categories;

  return (
    <div className="sheet-backdrop" onClick={onClose} style={{ zIndex: 1100 }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2 className="sheet-title">Pick category</h2>
          <button className="sheet-close" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input
            ref={ref}
            placeholder="Search categories"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoCorrect="off"
            autoCapitalize="words"
            spellCheck="false"
          />
        </div>
        <div className="sheet-body">
          <button
            className={`sheet-row${selectedId == null ? ' sheet-row--walkin' : ''}`}
            onClick={() => onPick(null)}
          >
            <div className="sheet-row-info">
              <div className="sheet-row-name">All categories</div>
              <div className="sheet-row-meta">No filter</div>
            </div>
          </button>
          {filtered.map((c) => {
            const id = c.category_id || c.id;
            return (
              <button
                key={id}
                className={`sheet-row${selectedId === id ? ' sheet-row--walkin' : ''}`}
                onClick={() => onPick(id)}
              >
                <div className="sheet-row-info">
                  <div className="sheet-row-name">{c.category_name || c.name}</div>
                  {c.parent_name && <div className="sheet-row-meta">{c.parent_name}</div>}
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && <div className="sheet-empty">No categories match</div>}
        </div>
      </div>
    </div>
  );
}
