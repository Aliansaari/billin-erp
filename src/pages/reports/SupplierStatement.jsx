// ── Supplier Statement ─────────────────────────────────────────────────
//
// Thin wrapper around <PartyStatementPage>. Supplier-only flavor:
//
//   • Picker is filtered to party_type = 'Supplier'.
//   • No WhatsApp button — supplier statements are typically
//     reconciled against statements WE receive from suppliers, not
//     sent outward. (Email-as-PDF for supplier reconciliation is a
//     future task.)
//   • Print letterhead reads "From: <supplier>" — flips the To/From
//     orientation versus customer mode (handled in the shell).
//   • Same drill / period / outstanding-only / Excel behaviour.
//
// Future: a "Supplier bill #" column overlay, alongside our internal
// bill number, for cleaner reconciliation against the supplier's own
// statement. Plumb via PartyStatementPage's `columnsExtra` prop when
// the data is wired (purchase_bills.supplier_bill_number is already
// captured at entry; LedgerEntry doesn't carry it though, so a join
// is needed).

import React from 'react';
import PartyStatementPage from '../../components/PartyStatementPage';

export default function SupplierStatement() {
  return (
    <PartyStatementPage
      partyType="Supplier"
      title="Supplier Statement"
      showWhatsApp={false}
    />
  );
}
