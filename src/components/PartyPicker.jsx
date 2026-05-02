// ── PartyPicker ─────────────────────────────────────────────────────────
//
// Big sticky party-selection bar for Customer Statement / Supplier
// Statement. The ergonomic improvement over the old PartyLedger
// dropdown is:
//
//   1. Top-of-page bar (not a buried dropdown). Sticky on scroll
//      inside the report. Always visible while the user reads the
//      statement, so they can re-pick a party without scrolling up.
//
//   2. ~520px input with party-name, city, mobile, and balance shown
//      as inline pills. Tells the user EVERYTHING they need to verify
//      they've picked the right party — not just the name. The old
//      dropdown showed only the name.
//
//   3. Recently-viewed chips below the input. Most accountants pull
//      the same 3-5 parties' statements per day; chips make that one
//      click instead of a search.
//
//   4. `/` from anywhere on the page focuses the input. Standard
//      keyboard convention (matches search bars across the app).
//
// PROPS
//   partyType         'Customer' | 'Supplier' — filters the list
//   value             Selected party object (or null)
//   onChange          (party) => void
//   loading           Boolean — show skeleton in the metadata strip
//                     while a refresh is in flight (the statement
//                     fetch happens upstream)
//
// PERSISTENCE
//   Recent picks are stored in localStorage under
//   `pp_recent_<type>` (an array of last 5 party_ids). Read on
//   mount, written on every successful selection. Cheap, no backend.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Input, AutoComplete, Tag } from 'antd';
import { SearchOutlined, UserOutlined, ShopOutlined } from '@ant-design/icons';
import { partyAPI } from '../api';

const RECENT_KEY = (type) => `pp_recent_${type.toLowerCase()}`;
const RECENT_MAX = 5;

const fmt = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

function loadRecent(type) {
  try {
    const raw = localStorage.getItem(RECENT_KEY(type));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveRecent(type, partyIds) {
  try { localStorage.setItem(RECENT_KEY(type), JSON.stringify(partyIds.slice(0, RECENT_MAX))); }
  catch { /* swallow — quota errors shouldn't break selection */ }
}

export default function PartyPicker({ partyType, value, onChange, loading }) {
  const [parties, setParties] = useState([]);          // full list, fetched once
  const [search,  setSearch]  = useState('');          // current input text
  const [recentIds, setRecent] = useState(() => loadRecent(partyType));
  const inputRef = useRef(null);

  // Fetch parties on mount + on partyType change. The list is small
  // enough (a few thousand at most) to keep entirely client-side; the
  // search is a substring filter, no round-trip per keystroke.
  useEffect(() => {
    let cancelled = false;
    partyAPI.getAll({ party_type: partyType, limit: 5000 })
      .then(res => {
        if (cancelled) return;
        const list = (res.data?.data || res.data || []).filter(p => p.is_active);
        setParties(list);
      })
      .catch(() => { if (!cancelled) setParties([]); });
    return () => { cancelled = true; };
  }, [partyType]);

  // Reload recent when the type flips (Customer Statement page vs
  // Supplier Statement page have separate lists).
  useEffect(() => {
    setRecent(loadRecent(partyType));
  }, [partyType]);

  // `/` keyboard shortcut to focus the picker. Don't trigger when the
  // user is typing into another field — `/` is a real character in
  // some narration / address inputs.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/') return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // AutoComplete options — filter by name substring or mobile match.
  // Show name as the headline, city / mobile as secondary line. The
  // value (what AntD echoes into the input) is the party_id, not the
  // name, so onSelect can do an O(1) lookup.
  const options = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    const base = q
      ? parties.filter(p =>
          (p.party_name || '').toLowerCase().includes(q)
          || (p.mobile_1 || '').includes(q)
          || (p.city     || '').toLowerCase().includes(q),
        )
      : parties;
    return base.slice(0, 50).map(p => ({
      value: String(p.party_id),
      label: (
        <div className="pp-opt">
          <div className="pp-opt-name">{p.party_name}</div>
          <div className="pp-opt-meta">
            {p.city ? <span>{p.city}</span> : null}
            {p.mobile_1 ? <span>📞 {p.mobile_1}</span> : null}
            <span>Balance ₹{fmt(p.current_balance)}</span>
          </div>
        </div>
      ),
      _party: p,
    }));
  }, [parties, search]);

  // Derive recent-party objects from ids. Stale ids (party deleted)
  // silently drop out. We do NOT prune storage on miss — a party
  // marked inactive temporarily then reactivated should reappear.
  const recentParties = useMemo(() => {
    if (!recentIds.length || !parties.length) return [];
    const byId = new Map(parties.map(p => [p.party_id, p]));
    return recentIds.map(id => byId.get(id)).filter(Boolean);
  }, [recentIds, parties]);

  function commit(party) {
    if (!party) return;
    setSearch('');
    onChange?.(party);
    // Update recent list — move-to-front, dedupe, cap to RECENT_MAX.
    const next = [party.party_id, ...recentIds.filter(id => id !== party.party_id)].slice(0, RECENT_MAX);
    setRecent(next);
    saveRecent(partyType, next);
  }

  return (
    <div className={'pp-bar' + (value ? ' has-selection' : '')}>
      <div className="pp-row">
        <div className="pp-input-wrap">
          <AutoComplete
            value={search}
            options={options}
            onChange={setSearch}
            onSelect={(_, opt) => commit(opt._party)}
            // Suggest when there's text OR when the field is empty +
            // focused (so the operator sees the top 50 to scroll
            // through). dropdownMatchSelectWidth fixes the suggestion
            // panel to match the input's width.
            dropdownMatchSelectWidth
            popupMatchSelectWidth={520}
            style={{ width: '100%' }}
          >
            <Input
              ref={inputRef}
              size="large"
              prefix={partyType === 'Customer' ? <UserOutlined /> : <ShopOutlined />}
              suffix={<SearchOutlined style={{ color: 'var(--fg-tertiary)' }} />}
              placeholder={`Search ${partyType.toLowerCase()} — name / mobile / city  ·  press / to focus`}
              allowClear
              onClear={() => onChange?.(null)}
            />
          </AutoComplete>
        </div>

        {/* Selected-party metadata strip — the right column. Mirrors
            the Sales bill form's party-info pill so accountants get a
            consistent "this is who you've picked" surface across the
            app. */}
        {value && (
          <div className="pp-meta">
            <span className="pp-meta-name">{value.party_name}</span>
            {value.city && <span className="pp-meta-pill">{value.city}</span>}
            {value.mobile_1 && <span className="pp-meta-pill">📞 {value.mobile_1}</span>}
            <span className={'pp-meta-pill pp-meta-bal' + (parseFloat(value.current_balance || 0) >= 0 ? ' pos' : ' neg')}>
              ₹{fmt(value.current_balance)}
            </span>
            {value.party_status && value.party_status !== 'Regular' && (
              <Tag color={value.party_status === 'Blacklist' ? 'red' : value.party_status === 'VIP' ? 'purple' : 'orange'}>
                {value.party_status}
              </Tag>
            )}
          </div>
        )}
      </div>

      {/* Recent chips — quick re-pick. Hidden once a party is selected
          to keep the bar uncluttered while a statement is open. */}
      {!value && recentParties.length > 0 && (
        <div className="pp-recent">
          <span className="pp-recent-lbl">Recent:</span>
          {recentParties.map(p => (
            <button
              type="button"
              key={p.party_id}
              className="pp-chip"
              onClick={() => commit(p)}
            >
              {p.party_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
