import React, { useEffect, useRef, useState } from 'react';
import { productAPI } from '../../api';
import './sheet.css';

/* ItemSheet — manual add / edit of a single bill line.
 *
 * `initial` may be: an existing item (edit mode), { barcode: '…' }
 * (scan pre-fill), or null (fresh manual entry). Type 'sale' vs
 * 'purchase' switches the rate label + which product rate gets
 * defaulted (sale_rate vs purchase_rate). */
export default function ItemSheet({ type, initial, onClose, onSave }) {
  const isPurchase = type === 'purchase';
  const init = initial || {};

  const [productQuery, setProductQuery] = useState(init.product_name || '');
  const [results, setResults] = useState([]);
  const [picked, setPicked]   = useState(init.product_id ? init : null);
  const [showResults, setShowResults] = useState(false);

  const [quantity, setQuantity] = useState(init.quantity != null ? String(init.quantity) : '1');
  const [rate, setRate]         = useState(init.rate != null ? String(init.rate) : '');
  const [discPct, setDiscPct]   = useState(init.discount_percentage != null ? String(init.discount_percentage) : '0');
  const [gstRate, setGstRate]   = useState(init.gst_rate != null ? String(init.gst_rate) : '0');

  const qRef = useRef(null);

  // Debounced product search
  useEffect(() => {
    if (!productQuery.trim()) {
      setResults([]);
      return;
    }
    if (picked && picked.product_name === productQuery) {
      // Already picked, don't re-search
      return;
    }
    const t = setTimeout(() => {
      productAPI.search(productQuery, { limit: 12 })
        .then((r) => {
          const rows = Array.isArray(r.data) ? r.data : (r.data?.data || []);
          setResults(rows);
          setShowResults(true);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [productQuery, picked]);

  // If we have a scanned barcode and no picked product, look it up.
  useEffect(() => {
    if (init.barcode && !init.product_id) {
      productAPI.getByBarcode(init.barcode)
        .then((r) => {
          const p = r.data;
          if (p) handlePickProduct(p);
        })
        .catch(() => {/* unknown — user fills name manually */});
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
      category_id: p.category_id || null,
      category_name: p.category_name || '',
    });
    setProductQuery(p.product_name || p.name);
    const newRate = isPurchase
      ? Number(p.purchase_rate || p.last_purchase_rate || 0)
      : Number(p.sale_rate || 0);
    if (newRate > 0) setRate(String(newRate));
    setGstRate(String(Number(p.gst_rate) || 0));
    setShowResults(false);
  };

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
      category_id: picked?.category_id || null,
      category_name: picked?.category_name || '',
      quantity: q,
      rate: r,
      discount_percentage: dp,
    });
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet sheet--tall" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2 className="sheet-title">{init.product_id ? 'Edit item' : 'Add item'}</h2>
          <button className="sheet-close" onClick={onClose}>Cancel</button>
        </div>

        <div className="sheet-body sheet-body--form">
          {/* Product picker */}
          <label className="sf-field">
            <span className="sf-label">Product</span>
            <input
              className="sf-input"
              placeholder="Search product or type name…"
              value={productQuery}
              onChange={(e) => { setProductQuery(e.target.value); setPicked(null); }}
              autoCorrect="off"
              autoCapitalize="words"
              spellCheck="false"
            />
          </label>

          {showResults && results.length > 0 && (
            <div className="sf-results">
              {results.map((p) => (
                <button
                  key={p.product_id || p.id}
                  className="sf-result"
                  onClick={() => handlePickProduct(p)}
                >
                  <div className="sf-result-name">{p.product_name || p.name}</div>
                  <div className="sf-result-meta">
                    {[p.barcode, p.hsn_code && `HSN ${p.hsn_code}`,
                      isPurchase
                        ? p.purchase_rate > 0 && `₹${Number(p.purchase_rate).toFixed(0)}`
                        : p.sale_rate > 0 && `₹${Number(p.sale_rate).toFixed(0)}`,
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
                ref={qRef}
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

          {/* Live totals preview */}
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
    </div>
  );
}
