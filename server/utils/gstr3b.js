/*
 * GSTR-3B — monthly summary return.
 *
 * Unlike GSTR-1 (which is invoice-level), 3B is a single-page summary of
 * outward supplies and Input Tax Credit (ITC). The portal expects:
 *
 *   3.1  Tax on outward + inward (RCM) supplies
 *     (a) Outward taxable (other than zero-rated/nil/exempt)
 *     (b) Outward taxable zero-rated supplies (exports + SEZ)
 *     (c) Other outward supplies (Nil-rated, exempted)
 *     (d) Inward supplies liable to reverse charge
 *     (e) Non-GST outward supplies
 *
 *   3.1.1  Supplies notified u/s 9(5) of CGST Act (ECO operator collects)
 *     — out of scope for v1
 *
 *   3.2   Of inter-state supplies in 3.1(a), supplies to:
 *     - Unregistered persons   (per Place of Supply)
 *     - Composition taxable    (per Place of Supply)
 *     - UIN holders            (per Place of Supply)
 *
 *   4   Eligible ITC
 *     (A) ITC Available
 *       (1) Import of goods
 *       (2) Import of services
 *       (3) Inward supplies liable to reverse charge (other than 1 & 2)
 *       (4) Inward supplies from ISD
 *       (5) All other ITC
 *     (B) ITC Reversed
 *       (1) As per CGST Rules 38, 42 & 43
 *       (2) Others
 *     (C) Net ITC Available  (A − B)
 *     (D) Other Details
 *       (1) ITC reclaimed which was reversed under (B)(2) earlier
 *       (2) Ineligible ITC under section 16(4) and ITC restricted due to PoS rules
 *
 *   5   Values of exempt, nil-rated and non-GST inward supplies
 *     - From a supplier under composition / Exempt / Nil rated supply
 *     - Non-GST supply
 *
 *   6.1  Payment of tax (computed: 3.1 outward tax − 4(C) net ITC)
 *
 * IMPORTANT: 3B numbers are NET of credit notes. Outward taxable in 3.1(a)
 * = (Outward invoices) − (Credit notes to registered) − (Credit notes to
 * unregistered). Same for tax columns. We compute this by reusing the
 * GSTR-1 aggregators (which already split B2B/B2CL/B2CS/Nil/CDNR/CDNUR)
 * and then subtracting CN totals.
 *
 * For ITC we read PurchaseBill rows in the period, summing CGST/SGST/IGST/
 * Cess. Without an `is_rcm` flag on PurchaseBill, line (4)(A)(3) is 0 and
 * everything goes into "All other ITC" (4)(A)(5).
 */
'use strict';

const {
  round2, isInterState, placeOfSupply, isNilExemptBill,
  bucketsForBill,
} = require('./gstr1');

/**
 * Sum outward supplies into 3B's 5 buckets, NET of credit notes.
 * Returns the 5×5 grid (5 row types × {taxable, igst, cgst, sgst, cess}).
 *
 * Audit H8 — section 3.1(d) "Inward supplies liable to reverse charge" is
 * filled from rcm-flagged PurchaseBills. The recipient (us) is liable for
 * the tax under reverse charge, so it shows here as an outward liability
 * AND in section 4(A)(3) as eligible ITC (offsetting). The optional
 * `rcmPurchases` and `rcmPurchaseReturns` args are passed through by
 * `buildGstr3b`.
 */
function summarizeOutward(activeBills, activeReturns, companyStateCode, rcmPurchases = [], rcmPurchaseReturns = []) {
  const buckets = {
    taxable_outward:    { label: '(a) Outward taxable (regular)',          taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    zero_rated:         { label: '(b) Outward taxable zero-rated',         taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    nil_exempt:         { label: '(c) Other outward (Nil/Exempt/Non-GST)', taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    inward_rcm:         { label: '(d) Inward liable to reverse charge',    taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
    non_gst_outward:    { label: '(e) Non-GST outward supplies',           taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
  };

  // ── Audit H8 — fill (d) from RCM-flagged inward bills ─────────────────
  // For each non-cancelled purchase bill where reverse_charge=true, add the
  // taxable + tax amounts as our self-assessed outward liability. The
  // matching ITC claim on the same amounts is in section 4(A)(3); the two
  // legs net to zero cash impact when ITC is fully available.
  for (const p of (rcmPurchases || [])) {
    if (p.is_cancelled || !p.reverse_charge) continue;
    const taxable = (p.items || []).reduce((a, i) => a + (Number(i.taxable_amount) || 0), 0);
    buckets.inward_rcm.taxable += taxable;
    buckets.inward_rcm.cgst    += Number(p.cgst_amount) || 0;
    buckets.inward_rcm.sgst    += Number(p.sgst_amount) || 0;
    buckets.inward_rcm.igst    += Number(p.igst_amount) || 0;
    buckets.inward_rcm.cess    += Number(p.cess_amount) || 0;
  }
  for (const pr of (rcmPurchaseReturns || [])) {
    if (pr.is_cancelled || !pr.reverse_charge) continue;
    const taxable = (pr.items || []).reduce((a, i) => a + (Number(i.taxable_amount) || 0), 0);
    buckets.inward_rcm.taxable -= taxable;
    buckets.inward_rcm.cgst    -= Number(pr.cgst_amount) || 0;
    buckets.inward_rcm.sgst    -= Number(pr.sgst_amount) || 0;
    buckets.inward_rcm.igst    -= Number(pr.igst_amount) || 0;
    buckets.inward_rcm.cess    -= Number(pr.cess_amount) || 0;
  }

  // Helper: add a single bill into one of the buckets
  const addBill = (bill, sign) => {
    if (isNilExemptBill(bill)) {
      // All-zero-tax bills land in (c). Without a `is_zero_rated`/`is_export`
      // flag on the bill we cannot promote them to (b). Operator must edit
      // an export flag on the bill before the report would move them.
      const tax = (bill.items || []).reduce((a, i) => a + (Number(i.taxable_amount) || 0), 0);
      buckets.nil_exempt.taxable += sign * tax;
      return;
    }
    // Taxable supply: split into rate buckets and accumulate
    for (const r of bucketsForBill(bill)) {
      buckets.taxable_outward.taxable += sign * r.taxable;
      buckets.taxable_outward.igst    += sign * r.igst;
      buckets.taxable_outward.cgst    += sign * r.cgst;
      buckets.taxable_outward.sgst    += sign * r.sgst;
      buckets.taxable_outward.cess    += sign * r.cess;
    }
  };

  // Outward sales increase liability; credit notes (returns) reduce it.
  for (const b of (activeBills   || [])) addBill(b, +1);
  for (const r of (activeReturns || [])) addBill(r, -1);

  // Round each cell
  for (const k of Object.keys(buckets)) {
    for (const c of ['taxable', 'igst', 'cgst', 'sgst', 'cess']) {
      buckets[k][c] = round2(buckets[k][c]);
    }
  }
  return buckets;
}

/**
 * Section 3.2 — Of inter-state supplies in 3.1(a), per POS, supplies to:
 *   - Unregistered persons
 *   - Composition taxable persons (no schema flag — empty for now)
 *   - UIN holders                 (no schema flag — empty for now)
 *
 * For the unregistered slice we walk B2CS (inter-state portion) + B2CL,
 * grouping by POS. Returns are NETTED.
 */
function summarizeInterStateUnreg(activeBills, activeReturns, companyStateCode) {
  const byPos = new Map();   // pos → { taxable, igst }
  const bump = (bill, sign) => {
    const cust = bill.customer;
    if (cust?.gstin) return;                                  // registered → not here
    const inter = isInterState(bill, cust, companyStateCode);
    if (!inter) return;                                       // intra-state → not here
    if (isNilExemptBill(bill)) return;                        // nil → 3.1(c), not 3.2
    const pos = placeOfSupply(cust) || '97';
    let g = byPos.get(pos);
    if (!g) { g = { place_of_supply: pos, taxable: 0, igst: 0 }; byPos.set(pos, g); }
    for (const r of bucketsForBill(bill)) {
      g.taxable += sign * r.taxable;
      g.igst    += sign * r.igst;
    }
  };
  for (const b of (activeBills   || [])) bump(b, +1);
  for (const r of (activeReturns || [])) bump(r, -1);

  const rows = [...byPos.values()].map(g => ({
    place_of_supply: g.place_of_supply,
    taxable:         round2(g.taxable),
    igst:            round2(g.igst),
  }));
  rows.sort((a, b) => a.place_of_supply.localeCompare(b.place_of_supply));
  return {
    unregistered:        rows,
    composition_dealers: [],   // no schema flag — empty
    uin_holders:         [],   // no schema flag — empty
  };
}

/**
 * Section 4 — Eligible ITC. Reads PurchaseBill data.
 *
 * Inputs: `purchases` is an array of bills shaped like:
 *   { purchase_bill_id, bill_date, supplier_invoice_number, reverse_charge,
 *     cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount,
 *     is_cancelled, supplier: { gstin, state }, items: [...] }
 *
 * Audit H8 — reverse-charge bills now route to (3) Inward RCM instead of
 * (5) All other ITC. Imports (1)(2) and ISD (4) still need explicit flags
 * (out-of-scope for this audit pass; routed into (5) when not RCM).
 *
 * (B) Reversed and (D) Other Details require operator entry — exposed as
 * zero-initialised so the UI can capture them at filing time.
 */
function summarizeITC(purchases, purchaseReturns = []) {
  const all_other = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  const inward_rcm = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  let purchaseTaxableTotal = 0;
  let invoiceCount = 0;
  let returnCount = 0;
  let returnTaxableTotal = 0;
  for (const p of (purchases || [])) {
    if (p.is_cancelled) continue;
    invoiceCount += 1;
    // Audit H8 — route reverse-charge bills to bucket (3).
    const target = p.reverse_charge ? inward_rcm : all_other;
    target.igst += Number(p.igst_amount) || 0;
    target.cgst += Number(p.cgst_amount) || 0;
    target.sgst += Number(p.sgst_amount) || 0;
    target.cess += Number(p.cess_amount) || 0;
    for (const it of (p.items || [])) {
      purchaseTaxableTotal += Number(it.taxable_amount) || 0;
    }
  }
  // Net out purchase returns (debit notes) — they reverse part of the
  // earlier ITC claim. Filing 3B without netting overstates 4(A)(5) by
  // exactly the return tax amounts. Audit C8.
  for (const pr of (purchaseReturns || [])) {
    if (pr.is_cancelled) continue;
    returnCount += 1;
    // Returns flow back to the same bucket as the originating purchase
    // — RCM returns reduce RCM ITC, normal returns reduce normal ITC.
    // Without a stored link to the source bill, we approximate by reading
    // the return's reverse_charge flag (which the controller copies from
    // the parent purchase when the return is created).
    const targetR = pr.reverse_charge ? inward_rcm : all_other;
    targetR.igst -= Number(pr.igst_amount) || 0;
    targetR.cgst -= Number(pr.cgst_amount) || 0;
    targetR.sgst -= Number(pr.sgst_amount) || 0;
    targetR.cess -= Number(pr.cess_amount) || 0;
    for (const it of (pr.items || [])) {
      returnTaxableTotal += Number(it.taxable_amount) || 0;
    }
  }
  // Clamp at zero — a return-heavy month with leftover credit from an
  // earlier period shouldn't propose a NEGATIVE ITC. Operators reverse
  // ITC via section 4(B) instead.
  for (const k of Object.keys(all_other)) {
    all_other[k] = Math.max(0, round2(all_other[k]));
  }
  for (const k of Object.keys(inward_rcm)) {
    inward_rcm[k] = Math.max(0, round2(inward_rcm[k]));
  }

  const ZERO = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  const A = {
    import_goods:    { ...ZERO, label: '(1) Import of goods' },
    import_services: { ...ZERO, label: '(2) Import of services' },
    inward_rcm:      { ...inward_rcm, label: '(3) Inward supplies liable to reverse charge (other than 1 & 2)' },
    isd:             { ...ZERO, label: '(4) Inward supplies from ISD' },
    all_other:       { ...all_other, label: '(5) All other ITC' },
  };
  // Aggregated row (4)(A)
  const A_total = ['igst', 'cgst', 'sgst', 'cess'].reduce((acc, k) => {
    acc[k] = round2(['import_goods', 'import_services', 'inward_rcm', 'isd', 'all_other']
      .reduce((s, key) => s + (A[key][k] || 0), 0));
    return acc;
  }, {});

  // (B) ITC Reversed — operator-entered at filing; expose zeros + labels
  const B = {
    rules_38_42_43: { ...ZERO, label: '(1) As per Rules 38, 42 & 43 of CGST Rules' },
    others:         { ...ZERO, label: '(2) Others' },
  };
  const B_total = { igst: 0, cgst: 0, sgst: 0, cess: 0 };

  // (C) Net ITC Available = A − B
  const C = ['igst', 'cgst', 'sgst', 'cess'].reduce((acc, k) => {
    acc[k] = round2(A_total[k] - B_total[k]);
    return acc;
  }, {});

  // (D) Other Details — operator-entered
  const D = {
    reclaimed:      { ...ZERO, label: '(1) ITC reclaimed which was reversed earlier' },
    ineligible:     { ...ZERO, label: '(2) Ineligible ITC under section 16(4) / PoS rules' },
  };

  return {
    A, A_total,
    B, B_total,
    C_net_available: C,
    D,
    meta: {
      purchase_invoice_count:  invoiceCount,
      purchase_taxable_total:  round2(purchaseTaxableTotal),
      purchase_return_count:   returnCount,
      purchase_return_taxable: round2(returnTaxableTotal),
    },
  };
}

/**
 * Section 6.1 — Payment of tax. Net cash payable per tax type:
 *   payable = max(0, outward_tax_3.1 − ITC_4(C))
 *
 * We don't model cash-ledger or interest/late-fee here — just the
 * arithmetic. The operator confirms before pressing "Pay" on the portal.
 */
function summarizePayment(outward, itc) {
  const tax = outward.taxable_outward;       // 3.1(a) — only taxable supplies attract tax payable
  const credit = itc.C_net_available;
  const result = {};
  for (const k of ['igst', 'cgst', 'sgst', 'cess']) {
    const liability = Number(tax[k]) || 0;
    const claimed   = Math.min(Number(credit[k]) || 0, Math.max(0, liability));
    result[k] = {
      tax_payable:   round2(liability),
      paid_via_itc:  round2(claimed),
      paid_via_cash: round2(Math.max(0, liability - claimed)),
    };
  }
  return result;
}

/**
 * Section 5 — exempt/nil/non-GST INWARD supplies. Without an
 * `is_exempt`/`is_composition`/`is_non_gst` flag on PurchaseBill these are
 * all zero. Surfaced as a zeroed table for completeness.
 */
function summarizeExemptInward() {
  return {
    inter_state: {
      composition_or_exempt_or_nil: 0,
      non_gst_supply:               0,
    },
    intra_state: {
      composition_or_exempt_or_nil: 0,
      non_gst_supply:               0,
    },
  };
}

/**
 * Build the complete GSTR-3B summary.
 *
 * Inputs:
 *   activeBills      — non-cancelled sales bills in the period
 *   activeReturns    — non-cancelled credit notes in the period
 *   purchases        — non-cancelled purchase bills in the period (for ITC)
 *   companyStateCode — company GSTIN's first 2 digits
 *
 * Returns a JSON shape mirroring the GSTR-3B portal sections.
 */
function buildGstr3b({
  activeBills      = [],
  activeReturns    = [],
  purchases        = [],
  purchaseReturns  = [],
  companyStateCode = null,
} = {}) {
  const cStateCode = companyStateCode || null;
  // Audit H8 — pass RCM-flagged purchases through so 3.1(d) is filled.
  const outward    = summarizeOutward(activeBills, activeReturns, cStateCode, purchases, purchaseReturns);
  const interUnreg = summarizeInterStateUnreg(activeBills, activeReturns, cStateCode);
  const itc        = summarizeITC(purchases, purchaseReturns);
  const payment    = summarizePayment(outward, itc);
  const exempt     = summarizeExemptInward();

  return {
    period_meta: {
      sales_invoice_count:    activeBills.length,
      credit_note_count:      activeReturns.length,
      purchase_invoice_count: itc.meta.purchase_invoice_count,
      debit_note_count:       itc.meta.purchase_return_count,
      company_state_code:     cStateCode,
    },
    section_3_1: outward,
    section_3_2: interUnreg,
    section_4_itc:    itc,
    section_5_exempt: exempt,
    section_6_1_payment: payment,
  };
}

module.exports = {
  summarizeOutward,
  summarizeInterStateUnreg,
  summarizeITC,
  summarizePayment,
  summarizeExemptInward,
  buildGstr3b,
};
