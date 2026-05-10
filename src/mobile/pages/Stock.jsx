import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { productAPI } from '../../api';
import { formatINR } from '../utils/format';
import './Stock.css';

const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
);
const AlertIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
);
const ChevR = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
);

const FILTERS = [
  { key: 'all',  label: 'All' },
  { key: 'in',   label: 'In stock' },
  { key: 'low',  label: 'Low stock' },
  { key: 'out',  label: 'Out of stock' },
];

export default function Stock() {
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState('all');
  const [searchOn, setSearchOn] = useState(false);
  const [search, setSearch]     = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    productAPI.getAll({ limit: 500 })
      .then((res) => {
        if (cancelled) return;
        const raw = Array.isArray(res.data) ? res.data : (res.data?.data || []);
        setProducts(raw);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e?.response?.data?.error || e?.message || 'Failed to load stock';
        Toast.show({ icon: 'fail', content: msg });
        setProducts([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn && search) setSearch('');
  }, [searchOn]);

  const stockStatus = (p) => {
    const qty = Number(p.current_stock ?? p.stock_quantity ?? 0);
    const min = Number(p.minimum_stock_level ?? p.min_stock ?? 0);
    if (qty <= 0) return 'out';
    if (min > 0 && qty <= min) return 'low';
    return 'in';
  };

  const filtered = useMemo(() => {
    let rows = products;
    if (filter !== 'all') {
      rows = rows.filter((p) => stockStatus(p) === filter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((p) =>
        String(p.product_name || p.name || '').toLowerCase().includes(q) ||
        String(p.sku || p.barcode || '').toLowerCase().includes(q) ||
        String(p.hsn_code || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }, [products, filter, search]);

  const counts = useMemo(() => {
    const c = { all: products.length, in: 0, low: 0, out: 0 };
    for (const p of products) c[stockStatus(p)]++;
    return c;
  }, [products]);

  const totalValue = useMemo(() => {
    return filtered.reduce((sum, p) => {
      return sum + Number(p.display_stock_value ?? 0);
    }, 0);
  }, [filtered]);

  return (
    <div className="st-screen">
      <div className="st-top">
        <h1 className="st-title">Stock</h1>
        <button
          className={`st-icon-btn${searchOn ? ' active' : ''}`}
          onClick={() => setSearchOn((v) => !v)}
          aria-label="Search"
        >
          <SearchIcon />
        </button>
      </div>

      {searchOn && (
        <div className="st-search">
          <input
            ref={searchRef}
            placeholder="Search product name, SKU, HSN…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck="false"
          />
        </div>
      )}

      <div className="st-chips">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`st-chip${filter === f.key ? ' active' : ''}${f.key === 'low' && counts.low > 0 ? ' warn' : ''}${f.key === 'out' && counts.out > 0 ? ' danger' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label} <span className="st-chip-count">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      <div className="st-list-wrap">
        {loading && <div className="st-empty">Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="st-empty">
            {search.trim() ? `No matches for "${search.trim()}"` : 'No products found'}
          </div>
        )}
        {!loading && filtered.map((p) => {
          const name = p.product_name || p.name || 'Unnamed';
          const qty = Number(p.current_stock ?? p.stock_quantity ?? 0);
          const unit = p.unit_of_measurement || p.unit || 'pcs';
          const purRate = Number(p.purchase_rate ?? p.display_cost ?? 0);
          const saleRate = Number(p.sale_rate ?? p.sale_price ?? 0);
          const stockVal = Number(p.display_stock_value ?? 0);
          const status = stockStatus(p);
          const id = p.product_id || p.id;

          return (
            <div
              key={id}
              className="st-row"
              role="button"
              onClick={() => navigate(`/stock/${id}`)}
            >
              <div className={`st-bar ${status}`} aria-hidden />
              <div className="st-content">
                <div className="st-name">{name}</div>
                {(() => {
                  const barcode = p.barcode || '';
                  const hsn = p.hsn_code || '';
                  const size = p.size_value || '';
                  const meta = [barcode, hsn && `HSN ${hsn}`, size && `Size ${size}`].filter(Boolean);
                  return meta.length > 0 && <div className="st-meta">{meta.join(' · ')}</div>;
                })()}
                <div className="st-rates">
                  {purRate > 0 && <span className="st-rate">Pur ₹{formatINR(purRate)}</span>}
                  {purRate > 0 && saleRate > 0 && <span className="st-rate-sep">·</span>}
                  {saleRate > 0 && <span className="st-rate">Sale ₹{formatINR(saleRate)}</span>}
                </div>
              </div>
              <div className="st-side">
                <div className={`st-qty ${status}`}>
                  {status === 'low' && <span className="st-alert"><AlertIcon /></span>}
                  <span className="st-qty-val">{qty}</span>
                  <span className="st-qty-unit">{unit}</span>
                </div>
                {stockVal > 0 && <div className="st-val">₹{formatINR(stockVal)}</div>}
              </div>
              <div className="st-chev"><ChevR /></div>
            </div>
          );
        })}
      </div>

      {!loading && filtered.length > 0 && (
        <div className="st-footer">
          <span className="st-footer-count">{filtered.length} product{filtered.length === 1 ? '' : 's'}</span>
          <span className="st-footer-total">₹{formatINR(totalValue)}</span>
        </div>
      )}
    </div>
  );
}
