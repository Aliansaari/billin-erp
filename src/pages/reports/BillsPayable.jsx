// Thin wrapper — Bills Payable is just BillsOutstanding with
// side='payable'. See BillsOutstanding.jsx for the shared
// implementation.
import React from 'react';
import BillsOutstanding from './BillsOutstanding';

export default function BillsPayable() {
  return <BillsOutstanding side="payable" />;
}
