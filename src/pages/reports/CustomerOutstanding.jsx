// ── Customer Outstanding ────────────────────────────────────────────
//
// Same data + same component as Bills Receivable, just landing on the
// Party-level view by default — one row per customer + chevron expand
// to the bills underneath. The segmented pill in the header lets the
// operator flip to Bill view at any time.
//
// Adding customer-only behaviour (e.g., a column tweak that makes
// sense for outstanding-by-customer but not for bill-level) goes here
// — keep BillsOutstanding generic.

import React from 'react';
import BillsOutstanding from './BillsOutstanding';

export default function CustomerOutstanding() {
  return <BillsOutstanding side="receivable" defaultView="party" />;
}
