// ── Rich party dropdown props ──────────────────────────────────────────
//
// Returns props to spread onto an AntD <Select> to get the tabular party
// dropdown — columns for Name, City, Phone, Balance, Credit. The sale bill's
// customer picker uses the same header and row renderers, so every party
// dropdown in the app reads the same.
//
// Usage:
//   import { partySelectProps } from '../utils/partySelectProps';
//   <Select showSearch optionFilterProp="label"
//     {...partySelectProps(parties, 'Customer')}
//     ... />
//
// The returned object includes: dropdownStyle, dropdownRender,
// optionRender, and options.  The caller keeps control of value,
// onChange, placeholder, ref, etc. Styles live in global.css (.party-*).

import React from 'react';

// "NEW DELHI" → "New Delhi"; cities are stored in capitals.
const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])(\S)/g, (m, a, b) => a + b.toUpperCase());

export function partyDropdownRender(partyLabel = 'Customer') {
  return (menu) => (
    <div>
      <div className="party-head">
        <span>{partyLabel}</span><span>City</span><span>Phone</span>
        <span className="r">Balance</span><span className="c">Credit</span>
      </div>
      {menu}
    </div>
  );
}

// Row renderer for a party list. The seeded Cash party reads as walk-in on
// customer lists and as an unaccounted cash purchase everywhere else.
export function makePartyOptionRender(partyLabel = 'Customer') {
  const cashNote = partyLabel === 'Customer' ? 'walk-in customer' : 'cash, no account';
  return (opt) => partyRow(opt.data.party, cashNote);
}

export const partyOptionRender = makePartyOptionRender('Customer');

function partyRow(p, cashNote) {
  if (p.is_system_cash) {
    return (
      <div className="party-row cash">
        <span className="nm">{p.party_name} <span className="sub">{cashNote}</span></span>
      </div>
    );
  }
  const bal = parseFloat(p.current_balance || 0);
  return (
    <div className="party-row">
      <span className="nm">{p.party_name}</span>
      <span className="city">{p.city ? titleCase(p.city) : ''}</span>
      <span className="party-ph">{p.mobile_1 || ''}</span>
      <span className={`r bal${bal === 0 ? ' zero' : ''}`}>
        {bal === 0 ? '0' : <>₹{Math.abs(bal).toLocaleString('en-IN', { maximumFractionDigits: 2 })}<small>{bal > 0 ? 'Dr' : 'Cr'}</small></>}
      </span>
      <span className="c">{p.credit_allowed ? <span className="yes">Yes</span> : <span className="no">No</span>}</span>
    </div>
  );
}

export function partySelectProps(parties, partyLabel = 'Customer') {
  return {
    dropdownStyle: { minWidth: 600, padding: 0 },
    popupMatchSelectWidth: false,
    popupClassName: 'party-pop',
    options: (parties || []).map(p => ({
      value: p.party_id,
      label: p.party_name,
      party: p,
    })),
    dropdownRender: partyDropdownRender(partyLabel),
    optionRender: makePartyOptionRender(partyLabel),
  };
}
