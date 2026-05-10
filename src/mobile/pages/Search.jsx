import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'antd-mobile';
import { partyAPI, productAPI } from '../../api';
import { formatINR, isoDate } from '../utils/format';

// Global search — mirrors the desktop's quick-find: one input that
// searches parties + products in parallel and groups results.
// Tap a result → routes to its detail screen (or a toast if we don't
// have one yet). Future: add bills/vouchers and recent searches.

const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
);
const ChevR = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
);
const Pkg = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
);
const PersonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
);

export default function Search() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [q, setQ] = useState('');
  const [parties, setParties] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Debounce search — wait 250ms after the user stops typing before
  // hitting two endpoints in parallel. Cancels via a closure flag if
  // the query changes underneath us.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setParties([]); setProducts([]); setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      Promise.allSettled([
        partyAPI.getAll({ search: term, limit: 8 }),
        productAPI.search(term, { limit: 8 }),
      ]).then(([p, pr]) => {
        if (cancelled) return;
        setParties(p.status === 'fulfilled' ? (p.value.data?.data || p.value.data || []).slice(0, 8) : []);
        setProducts(pr.status === 'fulfilled' ? (pr.value.data?.data || pr.value.data || []).slice(0, 8) : []);
      }).catch(() => {
        if (cancelled) return;
        Toast.show({ icon: 'fail', content: 'Search failed' });
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  const hasResults = parties.length > 0 || products.length > 0;

  return (
    <div className="search-screen drill-in">
      <style>{`
        .search-screen {
          flex: 1; display: flex; flex-direction: column;
          background: var(--c-bg-app);
          overflow: hidden;
        }
        .search-top {
          background: var(--c-bg-surface);
          padding: calc(env(safe-area-inset-top, 0px) + 12px) var(--pad) 14px;
          border-bottom: 1px solid var(--c-border);
        }
        .search-title {
          font-variation-settings: "opsz" 30;
          font-weight: 400;
          font-size: 22px;
          letter-spacing: -0.025em;
          color: var(--c-text);
          margin: 0 0 12px;
        }
        .search-title em { font-style: italic; font-weight: 300; }
        .search-input-wrap {
          display: flex; align-items: center; gap: 10px;
          background: var(--c-bg-app);
          border: 1px solid var(--c-border);
          border-radius: 14px;
          padding: 12px 14px;
        }
        .search-input-wrap:focus-within {
          border-color: var(--c-primary);
          background: var(--c-bg-surface);
        }
        .search-input-wrap input {
          flex: 1; background: none; border: none; outline: none;
          font-weight: 500;
          font-size: 15px;
          color: var(--c-text); letter-spacing: -0.005em;
          caret-color: var(--c-primary);
          min-width: 0;
        }
        .search-input-wrap input::placeholder { color: var(--c-text-mute); font-weight: 400; }
        .search-list-wrap {
          flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
          padding: 12px var(--pad) calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px) + 16px);
        }
        .search-section { margin-bottom: 18px; }
        .search-section-head {
          display: flex; align-items: baseline; justify-content: space-between;
          padding: 0 4px 8px;
          font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
          color: var(--c-text-mute);
        }
        .search-card {
          background: var(--c-bg-surface);
          border: 1px solid var(--c-border);
          border-radius: 16px; overflow: hidden;
        }
        .search-row {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--c-border-soft);
          cursor: pointer;
          background: none; border-left: none; border-right: none; border-top: none;
          width: 100%; text-align: left; font-family: inherit;
        }
        .search-row:last-child { border-bottom: none; }
        .search-row:active { background: var(--c-primary-soft); }
        .search-row-icon {
          width: 32px; height: 32px; border-radius: 9px;
          background: var(--c-primary-soft); color: var(--c-primary);
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .search-row-main { flex: 1; min-width: 0; }
        .search-row-title {
          font-size: 13.5px; font-weight: 500; color: var(--c-text);
          letter-spacing: -0.01em;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .search-row-sub {
          font-size: 10px; color: var(--c-text-mute);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          margin-top: 2px;
        }
        .search-row-amount {
          font-size: 13.5px; color: var(--c-text);
          font-variant-numeric: tabular-nums;
          margin-left: 8px;
        }
        .search-empty {
          padding: 56px 24px; text-align: center; color: var(--c-text-mute);
          font-style: italic; font-size: 14px;
        }
      `}</style>
      <div className="search-top">
        <h1 className="search-title">Quick <em>find</em></h1>
        <label className="search-input-wrap">
          <SearchIcon />
          <input
            ref={inputRef}
            placeholder="Search parties, products…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck="false"
          />
        </label>
      </div>

      <div className="search-list-wrap">
        {q.trim().length < 2 && (
          <div className="search-empty">
            Type 2+ characters to search across parties and products.
          </div>
        )}

        {q.trim().length >= 2 && loading && hasResults === false && (
          <div className="search-empty">Searching…</div>
        )}

        {!loading && q.trim().length >= 2 && !hasResults && (
          <div className="search-empty">No matches for "{q.trim()}".</div>
        )}

        {parties.length > 0 && (
          <div className="search-section">
            <div className="search-section-head">
              <span>Parties</span>
              <span>{parties.length}</span>
            </div>
            <div className="search-card">
              {parties.map((p) => (
                <button
                  key={p.party_id}
                  className="search-row"
                  onClick={() => Toast.show({ content: `Party detail coming soon · ${p.party_name}` })}
                >
                  <span className="search-row-icon"><PersonIcon /></span>
                  <span className="search-row-main">
                    <div className="search-row-title">{p.party_name}</div>
                    <div className="search-row-sub">
                      {[p.party_type, p.gstin, p.city].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </span>
                  <span className="search-row-amount">
                    {p.current_balance != null ? `₹${formatINR(p.current_balance)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {products.length > 0 && (
          <div className="search-section">
            <div className="search-section-head">
              <span>Products</span>
              <span>{products.length}</span>
            </div>
            <div className="search-card">
              {products.map((p) => (
                <button
                  key={p.product_id}
                  className="search-row"
                  onClick={() => Toast.show({ content: `Product detail coming soon · ${p.product_name}` })}
                >
                  <span className="search-row-icon"><Pkg /></span>
                  <span className="search-row-main">
                    <div className="search-row-title">{p.product_name}</div>
                    <div className="search-row-sub">
                      {[p.barcode, p.category_name].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </span>
                  <span className="search-row-amount">
                    {p.sale_price != null ? `₹${formatINR(p.sale_price)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
