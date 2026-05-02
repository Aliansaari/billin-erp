// ── PartyPicker ─────────────────────────────────────────────────────────
//
// Inline party-selection control for Customer / Supplier Statement.
// Renders a compact AntD Select (compact trigger + wide tabular
// dropdown, matching SalesBillForm) plus an inline meta strip showing
// the selected party's city / mobile / balance.
//
// No card surface around the control — it's designed to live inline
// with the page title in the header row, where the page chrome already
// supplies the visual frame.
//
// PROPS
//   partyType  'Customer' | 'Supplier' — filters the list
//   value      Selected party object (or null)
//   onChange   (party) => void
//
// KEYBOARD
//   `/` from anywhere on the page focuses the picker. Standard search
//   shortcut, matches the rest of the app.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from 'antd';
import { partyAPI } from '../api';

const fmtBal = (v) =>
  parseFloat(v || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });

export default function PartyPicker({ partyType, value, onChange }) {
  const [parties, setParties] = useState([]);
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

  function commit(partyId) {
    const p = parties.find(x => x.party_id === partyId) || null;
    onChange?.(p);
  }

  const placeholder = `Select ${partyType.toLowerCase()} — / to focus`;

  return (
    <div className="pp-inline">
      <Select
        ref={selectRef}
        showSearch
        allowClear
        placeholder={placeholder}
        value={value?.party_id}
        onChange={commit}
        optionFilterProp="label"
        options={options}
        className="pp-select"
        // Wide tabular dropdown — same chrome as SalesBillForm's
        // customer Select. Trigger stays compact; dropdown breaks out
        // to 700px so all five columns are readable.
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

      {/* Inline meta pills — render alongside the Select once a party
          is picked. Same content the Sales bill form's party-info
          strip uses, condensed to fit in a header row. */}
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
  );
}
