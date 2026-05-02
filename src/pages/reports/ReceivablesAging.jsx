// ── Receivables Aging ─────────────────────────────────────────────────
//
// Customer side of the bucketed-aging report. Thin wrapper around the
// shared <AgingReport> engine — same as how Bills Receivable wraps
// BillsOutstanding. Page identity is locked: no internal toggle to
// the supplier side; flipping is a menu / favorites action like
// every other split pair in the app.

import React from 'react';
import AgingReport from './AgingReport';

export default function ReceivablesAging() {
  return <AgingReport partyType="Customer" />;
}
