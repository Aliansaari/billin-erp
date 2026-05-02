// ── Supplier Outstanding ────────────────────────────────────────────
//
// Same data + same component as Bills Payable, but defaulting to the
// Party-level view — one row per supplier + chevron expand to the
// bills underneath. The segmented pill in the header lets the
// operator flip to Bill view at any time.

import React from 'react';
import BillsOutstanding from './BillsOutstanding';

export default function SupplierOutstanding() {
  return <BillsOutstanding side="payable" defaultView="party" />;
}
