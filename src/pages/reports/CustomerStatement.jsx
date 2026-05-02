// ── Customer Statement ─────────────────────────────────────────────────
//
// Thin wrapper around <PartyStatementPage>. Customer-only flavor:
//
//   • Picker is filtered to party_type = 'Customer'.
//   • WhatsApp button is enabled — the canonical "send a payment
//     reminder" workflow. The shared shell formats a one-line message
//     with the closing balance and opens wa.me.
//   • Print letterhead reads "To: <customer>" — the statement is
//     mailed out to the customer.
//   • All other behaviour (period chips, outstanding-only toggle,
//     drill-into-bill, Excel) is shared with Supplier Statement.
//
// Adding a customer-only column or summary block? Add it here, not in
// PartyStatementPage — keeps the shared shell free of partyType
// branches.

import React from 'react';
import PartyStatementPage from '../../components/PartyStatementPage';

export default function CustomerStatement() {
  return (
    <PartyStatementPage
      partyType="Customer"
      title="Customer Statement"
      headerHint="Tally-style account-of-record · sales · receipts · returns"
      showWhatsApp
    />
  );
}
