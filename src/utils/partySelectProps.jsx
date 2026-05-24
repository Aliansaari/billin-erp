// ── Rich party dropdown props ──────────────────────────────────────────
//
// Returns props to spread onto an AntD <Select> to get the tabular party
// dropdown matching SalesBillForm's customer picker — columns for Name,
// City, Contact, Balance, Credit.
//
// Usage:
//   import { partySelectProps } from '../utils/partySelectProps';
//   <Select showSearch optionFilterProp="label"
//     {...partySelectProps(parties, 'Customer')}
//     ... />
//
// The returned object includes: dropdownStyle, dropdownRender,
// optionRender, and options.  The caller keeps control of value,
// onChange, placeholder, ref, etc.

import React from 'react';

export function partySelectProps(parties, partyLabel = 'Customer') {
  return {
    dropdownStyle: { minWidth: 600, padding: 0 },
    popupMatchSelectWidth: false,
    options: (parties || []).map(p => ({
      value: p.party_id,
      label: p.party_name,
      party: p,
    })),
    dropdownRender: (menu) => (
      <div>
        <div style={{
          display: 'flex', gap: 0,
          background: 'var(--warning-bg)',
          padding: '5px 12px',
          fontSize: 11, fontWeight: 700,
          color: 'var(--fg-primary)',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ flex: '0 0 180px' }}>{partyLabel} Name</span>
          <span style={{ flex: '0 0 120px' }}>City</span>
          <span style={{ flex: '0 0 110px' }}>Contact</span>
          <span style={{ flex: '0 0 80px', textAlign: 'right' }}>Balance</span>
          <span style={{ flex: '0 0 70px', textAlign: 'center' }}>Credit</span>
        </div>
        {menu}
      </div>
    ),
    optionRender: (opt) => {
      const p = opt.data.party;
      const bal = parseFloat(p.current_balance || 0);
      return (
        <div style={{ display: 'flex', gap: 0, alignItems: 'center', fontSize: 12, padding: '2px 0' }}>
          <span style={{ flex: '0 0 180px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 6 }}>
            {p.party_name}
          </span>
          <span style={{ flex: '0 0 120px', color: 'var(--fg-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 6 }}>
            {p.city || '—'}
          </span>
          <span style={{ flex: '0 0 110px', color: 'var(--fg-secondary)' }}>
            {p.mobile_1 || '—'}
          </span>
          <span style={{ flex: '0 0 80px', textAlign: 'right', fontWeight: 700, paddingRight: 8,
            color: bal > 0 ? 'var(--success)' : bal < 0 ? 'var(--danger)' : 'var(--fg-tertiary)' }}>
            {bal === 0 ? '0' : <>{Math.abs(bal).toLocaleString('en-IN', { maximumFractionDigits: 1 })} <span style={{fontSize:9,fontWeight:600,opacity:0.75}}>{bal >= 0 ? 'Dr' : 'Cr'}</span></>}
          </span>
          <span style={{ flex: '0 0 70px', textAlign: 'center' }}>
            <span style={{
              background: p.credit_allowed ? 'var(--success-bg)' : 'var(--danger-bg)',
              color: p.credit_allowed ? 'var(--success)' : 'var(--danger)',
              borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700,
            }}>
              {p.credit_allowed ? 'YES' : 'NO'}
            </span>
          </span>
        </div>
      );
    },
  };
}
