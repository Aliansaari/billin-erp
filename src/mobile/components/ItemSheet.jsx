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
    setPicked({
      product_id: p.product_id || p.id,
      product_name: p.product_name || p.name,
      barcode: p.barcode || init.barcode || '',
      hsn_code: p.hsn_code || '',
      gst_rate: Number(p.gst_rate) || 0,
      unit_type: p.unit_of_measurement || 'Pcs',
      mrp: Number(p.mrp) || 0,
      size: p.size_value || '',
      article_number: p.article_number || '',
      category_id: p.category_id || categoryId || null,
      category_name: p.category_name || '',
    });
    setProductQuery(p.product_name || p.name);
    const newRate = isPurchase
      ? Number(p.purchase_rate || p.last_purchase_rate || 0)
      : Number(p.sale_rate || 0);
    if (newRate > 0) setRate(String(newRate));
    setGstRate(String(Number(p.gst_rate) || 0));
    setSearchFocused(false);
    // Close the soft keyboard
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
  const gross = q * r;
  const lineDisc = gross * dp / 100;
  const taxable = gross - lineDisc;
  const tax = taxable * gst / 100;
  const total = taxable + tax;

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
      mrp: picked?.mrp || 0,
      size: picked?.size || '',
      article_number: picked?.article_number || '',
      category_id: picked?.category_id || categoryId || null,
      category_name: picked?.category_name || '',
      quantity: q,
      rate: r,
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
              {results.map((p) => (
                <button
                  key={p.product_id || p.id}
                  className="sf-result"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handlePickProduct(p)}
                >
                  <div className="sf-result-name">{p.product_name || p.name}</div>
                  <div className="sf-result-meta">
                    {[
                      p.barcode,
                      p.hsn_code && `HSN ${p.hsn_code}`,
                      isPurchase
                        ? p.purchase_rate > 0 && `₹${Number(p.purchase_rate).toFixed(0)}`
                        : p.sale_rate > 0 && `₹${Number(p.sale_rate).toFixed(0)}`,
                      Number(p.current_stock) > 0 && `${p.current_stock} in stock`,
                    ].filter(Boolean).join(' · ')}
                  </div>
                </button>
              ))}
            </div>
          )}

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
