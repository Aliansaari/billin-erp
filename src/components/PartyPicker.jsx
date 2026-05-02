// ── PartyPicker ─────────────────────────────────────────────────────────
//
// Party-selection control matching the customer dropdown on Sales Bill
// Form — compact trigger + a wide tabular dropdown so the operator sees
// every party's identity (name / city / contact / balance / credit) in
// one row when picking.
//
// PROPS
//   partyType    'Customer' | 'Supplier' — filters the list
//   value        Selected party object (or null)
//   onChange     (party) => void
//
// PERSISTENCE
//   Recent picks are stored in localStorage under
//   `pp_recent_<type>` (an array of last 5 party_ids). Read on mount,
//   written on every selection. Surfaces below the picker as quick
//   chips when no party is selected — most accountants pull the same
//   3-5 parties' statements per day, so chips are one click each.
//
// KEYBOARD
//   `/` from anywhere on the page focuses the picker. Standard search
//   shortcut, matches the rest of the app.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from 'antd';
import { partyAPI } from '../api';

const RECENT_KEY = (type) => `pp_recent_${type.toLowerCase()}`;
const RECENT_MAX = 5;

const fmtBal = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
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

export default function PartyPicker({ partyType, value, onChange }) {
  const [parties, setParties] = useState([]);
  const [recentIds, setRecent] = useState(() => loadRecent(partyType));
  const selectRef = useRef(null);

  // Fetch parties on mount + on partyType change. Small enough list
  // (a few thousand) to keep entirely client-side; the dropdown's
  // built-in filter handles the substring match per keystroke.
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

  useEffect(() => { setRecent(loadRecent(partyType)); }, [partyType]);

  // `/` shortcut. Skip when typing into another input — `/` is a
  // legal character in narration / address fields elsewhere.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/') return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      selectRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const options = useMemo(
    () => parties.map(p => ({ value: p.party_id, label: p.party_name, party: p })),
    [parties],
  );

  const recentParties = useMemo(() => {
    if (!recentIds.length || !parties.length) return [];
    const byId = new Map(parties.map(p => [p.party_id, p]));
    return recentIds.map(id => byId.get(id)).filter(Boolean);
  }, [recentIds, parties]);

  function commit(partyId) {
    const p = parties.find(x => x.party_id === partyId) || null;
    onChange?.(p);
    if (p) {
      const next = [p.party_id, ...recentIds.filter(id => id !== p.party_id)].slice(0, RECENT_MAX);
      setRecent(next);
      saveRecent(partyType, next);
    }
  }

  const placeholder = `Select ${partyType.toLowerCase()} — type to search · press / to focus`;

  return (
    <div className={'pp-bar' + (value ? ' has-selection' : '')}>
      <div className="pp-row">
        <div className="pp-select-wrap">
          <Select
            ref={selectRef}
            showSearch
            allowClear
            placeholder={placeholder}
            value={value?.party_id}
            onChange={commit}
            optionFilterProp="label"
            // Built-in filter: case-insensitive substring on the
            // option's `label`. AntD also exposes filterOption to
            // customise — but for a plain "find by name" the
            // optionFilterProp shortcut is enough.
            options={options}
            // Wide tabular dropdown — same pattern as SalesBillForm's
            // customer Select. Trigger stays compact; the dropdown
            // breaks out to 700px so all five columns are readable.
            dropdownStyle={{ minWidth: 700, padding: 0 }}
            popupMatchSelectWidth={false}
            dropdownRender={menu => (
              <div>
                <div className="pp-opt-head">
                  <span style={{ flex: '0 0 200px' }}>{partyType} Name</span>
                  <span style={{ flex: '0 0 130px' }}>City</span>
                  <span style={{ flex: '0 0 120px' }}>Contact</span>
                  <span style={{ flex: '0 0 110px', textAlign: 'right' }}>Balance</span>
                  <span style={{ flex: '0 0 70px', textAlign: 'center' }}>Status</span>
                </div>
                {menu}
              </div>
            )}
            optionRender={(opt) => {
              const p = opt.data.party;
              const bal = parseFloat(p.current_balance || 0);
              const status = p.party_status || 'Regular';
              return (
                <div className="pp-opt-row">
                  <span style={{ flex: '0 0 200px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 6 }}>
                    {p.party_name}
                  </span>
                  <span style={{ flex: '0 0 130px', color: 'var(--fg-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 6 }}>
                    {p.city || '—'}
                  </span>
                  <span style={{ flex: '0 0 120px', color: 'var(--fg-secondary)' }}>
                    {p.mobile_1 || '—'}
                  </span>
                  <span
                    style={{
                      flex: '0 0 110px',
                      textAlign: 'right',
                      fontWeight: 700,
                      paddingRight: 8,
                      color: bal > 0 ? 'var(--success)' : bal < 0 ? 'var(--danger)' : 'var(--fg-tertiary)',
                    }}
                  >
                    {fmtBal(bal)}
                  </span>
                  <span style={{ flex: '0 0 70px', textAlign: 'center' }}>
                    <span
                      style={{
                        background:
                          status === 'Blacklist' ? 'var(--danger-bg)' :
                          status === 'VIP'       ? 'rgba(127,90,163,0.14)' :
                          status === 'Priority'  ? 'rgba(177,71,47,0.10)' :
                                                   'var(--bg-secondary)',
                        color:
                          status === 'Blacklist' ? 'var(--danger)' :
                          status === 'VIP'       ? '#7F5AA3' :
                          status === 'Priority'  ? 'var(--warning)' :
                                                   'var(--fg-tertiary)',
                        borderRadius: 4,
                        padding: '1px 7px',
                        fontSize: 10,
                        fontWeight: 700,
                      }}
                    >
                      {status === 'Regular' ? '—' : status.toUpperCase()}
                    </span>
                  </span>
                </div>
              );
            }}
          />
        </div>

        {/* Selected-party meta strip — pills to the right of the
            picker. Only renders once a party is picked; matches the
            Sales bill form's "you've chosen X" surface so the visual
            pattern is consistent across the app. */}
        {value && (
          <div className="pp-meta">
            {value.city && <span className="pp-meta-pill">{value.city}</span>}
            {value.mobile_1 && <span className="pp-meta-pill">📞 {value.mobile_1}</span>}
            <span className={'pp-meta-pill pp-meta-bal' + (parseFloat(value.current_balance || 0) >= 0 ? ' pos' : ' neg')}>
              ₹{fmtBal(value.current_balance)}
            </span>
          </div>
        )}
      </div>

      {/* Recent chips — shown only when nothing is picked. Once a
          party is selected the picker meta strip carries its identity,
          so the chips would be visual noise. */}
      {!value && recentParties.length > 0 && (
        <div className="pp-recent">
          <span className="pp-recent-lbl">Recent:</span>
          {recentParties.map(p => (
            <button
              type="button"
              key={p.party_id}
              className="pp-chip"
              onClick={() => commit(p.party_id)}
            >
              {p.party_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
