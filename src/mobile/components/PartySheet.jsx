import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { partyAPI } from '../../api';
import './sheet.css';

export default function PartySheet({ type, onClose, onPick }) {
  return ReactDOM.createPortal(<PartySheetInner type={type} onClose={onClose} onPick={onPick} />, document.body);
}

function PartySheetInner({ type, onClose, onPick }) {
  const [query, setQuery] = useState('');
  const [list, setList]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [kbdH, setKbdH]  = useState(0);
  const searchRef = useRef(null);

  // Lift the sheet above the iOS keyboard so results stay visible.
  useEffect(() => {
    const setKbd = (px) => setKbdH(Math.max(0, px));
    let cleanup = () => {};
    if (Capacitor.isNativePlatform()) {
      let showH = null, hideH = null;
      import('@capacitor/keyboard').then(({ Keyboard }) => {
        Keyboard.addListener('keyboardWillShow', (info) => setKbd(info.keyboardHeight)).then((h) => { showH = h; });
        Keyboard.addListener('keyboardWillHide', () => setKbd(0)).then((h) => { hideH = h; });
      }).catch(() => {});
      cleanup = () => { showH?.remove?.(); hideH?.remove?.(); setKbd(0); };
    } else if (window.visualViewport) {
      const vv = window.visualViewport;
      const apply = () => setKbd(window.innerHeight - vv.height - vv.offsetTop);
      apply();
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      cleanup = () => { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); setKbd(0); };
    }
    return cleanup;
  }, []);

  // Fetch initial list, refetch on query change with a small debounce.
  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      const fetcher = type === 'supplier' ? partyAPI.getSuppliers : partyAPI.getCustomers;
      fetcher({ search: query, limit: 30 })
        .then((r) => {
          const rows = Array.isArray(r.data) ? r.data : (r.data?.data || []);
          setList(rows);
        })
        .catch(() => setList([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query, type]);

  useEffect(() => { setTimeout(() => searchRef.current?.focus(), 80); }, []);

  const heading = type === 'supplier' ? 'Pick supplier' : 'Pick customer';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        style={kbdH > 0 ? { marginBottom: kbdH, maxHeight: `calc(86vh - ${kbdH}px)` } : undefined}
      >
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2 className="sheet-title">{heading}</h2>
          <button className="sheet-close" onClick={onClose}>Close</button>
        </div>

        <div className="sheet-body">
          {/* Walk-in / cash quick pick — only for customer side */}
          {type !== 'supplier' && (
            <button
              className="sheet-row sheet-row--walkin"
              onClick={() => onPick(null)}
            >
              <div className="sheet-row-avatar walkin">W</div>
              <div className="sheet-row-info">
                <div className="sheet-row-name">Walk-in / cash</div>
                <div className="sheet-row-meta">No party · no balance tracking</div>
              </div>
            </button>
          )}

          {loading && <div className="sheet-loading">Loading…</div>}

          {!loading && list.length === 0 && (
            <div className="sheet-empty">No {type === 'supplier' ? 'suppliers' : 'customers'} match</div>
          )}

          {!loading && list.map((p) => {
            const bal = Number(p.current_balance) || 0;
            const limit = Number(p.credit_limit) || 0;
            const limitOk = !!p.credit_allowed && limit > 0;
            const overLimit = limitOk && bal > limit;
            return (
              <button
                key={p.party_id}
                className="sheet-row"
                onClick={() => onPick(p)}
              >
                <div className={`sheet-row-avatar ${type === 'supplier' ? 'supplier' : 'customer'}`}>
                  {(p.party_name || '?').charAt(0).toUpperCase()}
                </div>
                <div className="sheet-row-info">
                  <div className="sheet-row-name">{p.party_name}</div>
                  <div className="sheet-row-meta">
                    {[p.gstin, p.city, p.mobile_1].filter(Boolean).join(' · ') || '—'}
                  </div>
                  {limitOk && (
                    <div className={`sheet-row-credit${overLimit ? ' over' : ''}`}>
                      Limit ₹{limit.toLocaleString('en-IN')}
                      {p.credit_days ? ` · ${p.credit_days}d` : ''}
                      {overLimit ? ' · over!' : ''}
                    </div>
                  )}
                </div>
                {bal !== 0 && (
                  <div className={`sheet-row-bal ${bal > 0 ? 'dr' : 'cr'}`}>
                    ₹{Math.abs(bal).toLocaleString('en-IN')}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Search field pinned at the bottom so when the keyboard rises
            the results list (above) stays fully visible and tappable. */}
        <div className="sheet-search sheet-search--bottom">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input
            ref={searchRef}
            placeholder="Search name, mobile, GSTIN…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoCorrect="off"
            autoCapitalize="words"
            spellCheck="false"
          />
        </div>
      </div>
    </div>
  );
}
