// ── Payables Aging ────────────────────────────────────────────────────
//
// Supplier side of the bucketed-aging report. Thin wrapper around the
// shared <AgingReport> engine, mirror of ReceivablesAging.

import React from 'react';
import AgingReport from './AgingReport';

export default function PayablesAging() {
  return <AgingReport partyType="Supplier" />;
}
