import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { productAPI } from '../../api';
import { formatINR } from '../utils/format';
import { useBack } from '../utils/useBack';
import './ReportList.css';
import { friendlyError } from '../utils/offlineSnapshot';

const ChevL = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6"/>
  </svg>
);
const ChevR = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l6-6-6-6"/>
  </svg>
);
const SearchIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>
);

export default function StockMovementPicker() {
  const navigate = useNavigate();
  const goBack = useBack('/reports');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchOn, setSearchOn] = useState(false);
  const [search, setSearch] = useState('');
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
        Toast.show({ icon: 'fail', content: friendlyError(e, 'Could not load products') });
        setProducts([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (searchOn) setTimeout(() => searchRef.current?.focus(), 50);
    if (!searchOn) setSearch('');
  }, [searchOn]);

  const filtered = useMemo(() => {
    if (!search.trim()) return products;
    const q = search.trim().toLowerCase();
    return products.filter((p) =>
      String(p.product_name || p.name || '').toLowerCase().includes(q) ||
      String(p.barcode || p.sku || '').toLowerCase().includes(q) ||
      String(p.hsn_code || '').toLowerCase().includes(q),
    );
  }, [products, search]);

  return (
    <div className="rl-screen drill-in">

      {/* Topbar */}
      <div className="rl-top">
        <button className="rl-icon-btn framed" onClick={goBack} aria-label="Back">
          <ChevL />
        </button>
        <h1 className="rl-title">Stock <em>movement</em></h1>
        <button
          className={`rl-icon-btn${searchOn ? ' active' : ''}`}
          onClick={() => setSearchOn((v) => !v)}
          aria-label="Search"
        >
          <SearchIcon />
        </button>
      </div>

      {/* Search */}
      {searchOn && (
        <div className="rl-search">
          <input
            ref={searchRef}
            placeholder="Search product name, SKU, HSN…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off" autoCapitalize="none" spellCheck="false"
          />
        </div>
      )}

      {/* List */}
      <div className="rl-list">
        {loading && <SkeletonRows />}

        {!loading && filtered.length === 0 && (
          <div className="rl-empty">
            {search.trim() ? `No matches for "${search}"` : 'No products found'}
          </div>
        )}

        {!loading && filtered.map((p) => {
          const name = p.product_name || p.name || 'Unnamed';
          const id = p.product_id || p.id;
          const unit = p.unit_of_measurement || p.unit || 'pcs';
          const qty = Number(p.current_stock ?? p.stock_quantity ?? 0);
          const barcode = p.barcode || p.sku || '';
          const hsn = p.hsn_code || '';
          const meta = [barcode, hsn && `HSN ${hsn}`].filter(Boolean).join(' · ');

          return (
            <div key={id} className="rl-row" onClick={() => navigate(`/stock/${id}`)}>
              <div className="rl-row-main">
                <div className="rl-row-party">{name}</div>
                {meta && <div className="rl-row-meta"><span>{meta}</span></div>}
              </div>
              <div className="rl-row-side">
                <div className="rl-row-amount" style={{ color: qty > 0 ? 'var(--c-text-soft)' : 'var(--c-error)' }}>
                  {qty} <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.7 }}>{unit}</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', marginLeft: 6, color: 'var(--c-text-mute)', flexShrink: 0 }}>
                <ChevR />
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      {!loading && filtered.length > 0 && (
        <div className="rl-sticky-footer">
          <span className="rl-footer-count">{filtered.length} product{filtered.length === 1 ? '' : 's'}</span>
        </div>
      )}
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[70, 50, 80, 60, 75].map((w, i) => (
        <div key={i} className="rl-skeleton-row">
          <div style={{ flex: 1 }}>
            <div className="rl-skel" style={{ height: 13, width: `${w}%`, marginBottom: 6 }} />
            <div className="rl-skel" style={{ height: 10, width: '35%' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', flexDirection: 'column', gap: 5 }}>
            <div className="rl-skel" style={{ height: 14, width: 50 }} />
          </div>
        </div>
      ))}
    </>
  );
}
