// Thin wrapper — Bills Receivable is just BillsOutstanding with
// side='receivable'. The shared component handles every behaviour
// difference between Receivable and Payable via a per-side config.
import React from 'react';
import BillsOutstanding from './BillsOutstanding';

export default function BillsReceivable() {
  return <BillsOutstanding side="receivable" />;
}
