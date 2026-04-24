/*
 * GSTR-1 aggregation — pure functions, no DB or HTTP.
 *
 * Classifies each sales invoice into the section it belongs to and produces
 * the aggregate tables GSTN portal expects:
 *
 *   4A  B2B          Sales to registered parties (customer has GSTIN).
 *                    Invoice-level rows, grouped by recipient GSTIN.
 *   5A  B2CL         Unregistered INTER-state > ₹2.5L. Invoice-level rows,
 *                    grouped by place-of-supply state code.       (P1)
 *   7   B2CS         Everything else. Aggregated to state + rate + type.
 *   12  HSN summary  Per-line aggregated by HSN + rate + unit.
 *
 * The function signatures below are called by reportController.gstr1Report
 * after the bills/items are loaded. All monetary values are plain numbers
 * (already converted from Sequelize DECIMAL by the controller). Units in
 * the HSN summary follow GSTN's UQC code list when possible, else pass
 * through the stored free-text unit verbatim.
 *
 * All math is done at TWO-decimal precision via round2(). We do NOT
 * propagate floating-point errors across a full return — each aggregate
 * is rounded at the LAST step (same pattern as utils/aging.js). Summing
 * already-rounded subtotals can drift by a few paise on large returns;
 * the portal tolerates this.
 */

'use strict';

/* Round half-away-from-zero to 2dp (same convention as GST law). */
function round2(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(v) * 100 + 1e-10) / 100;
}

/**
 * Derive the 2-char state code at the head of a GSTIN.
 * Returns null for missing/invalid GSTINs (< 2 chars).
 */
function stateCodeFromGstin(gstin) {
  if (!gstin || typeof gstin !== 'string') return null;
  const s = gstin.trim().slice(0, 2);
  return /^[0-9]{2}$/.test(s) ? s : null;
}

/**
 * Name → state-code fallback when a party has no GSTIN. Minimal lookup
 * keyed by the canonical names used in the app's seed/party-creation
 * flow (see server/controllers/tallyController.js CITY_STATE and the
 * import templates). Unknown states return null — the caller decides
 * what to do (B2CS fallback uses "97" for "other territories").
 */
const STATE_CODES = {
  'andaman and nicobar islands':'35','andhra pradesh':'37','arunachal pradesh':'12',
  'assam':'18','bihar':'10','chandigarh':'04','chhattisgarh':'22','dadra and nagar haveli':'26',
  'daman and diu':'25','delhi':'07','goa':'30','gujarat':'24','haryana':'06',
  'himachal pradesh':'02','jammu and kashmir':'01','jharkhand':'20','karnataka':'29',
  'kerala':'32','ladakh':'38','lakshadweep':'31','madhya pradesh':'23','maharashtra':'27',
  'manipur':'14','meghalaya':'17','mizoram':'15','nagaland':'13','odisha':'21',
  'puducherry':'34','punjab':'03','rajasthan':'08','sikkim':'11','tamil nadu':'33',
  'telangana':'36','tripura':'16','uttar pradesh':'09','uttarakhand':'05','west bengal':'19',
};
function stateCodeFromName(name) {
  if (!name) return null;
  return STATE_CODES[name.trim().toLowerCase()] || null;
}

/**
 * Figure out the place-of-supply state code for a sale:
 *   1. If customer has GSTIN, use the first 2 chars (authoritative).
 *   2. Else use the state-name lookup.
 *   3. Else null (unknown place of supply).
 */
function placeOfSupply(customer) {
  return stateCodeFromGstin(customer?.gstin) || stateCodeFromName(customer?.state);
}

/**
 * Decide whether a bill is inter-state from the STORED tax amounts
 * (authoritative — whatever the bill was saved with). Falls back to
 * state-code comparison when the bill carries no tax at all.
 *
 * Rule:
 *   - any igst > 0                  → inter-state
 *   - any cgst or sgst > 0          → intra-state
 *   - no tax (nil-rated / exempt)   → compare place-of-supply to company
 *
 * This is more reliable than comparing states because it reflects what
 * the bill was actually saved with. A bill that stores CGST+SGST is
 * definitionally intra-state, regardless of what the state codes say.
 */
function isInterState(bill, customer, companyStateCode) {
  const igst = Number(bill?.igst_amount) || 0;
  const cgst = Number(bill?.cgst_amount) || 0;
  const sgst = Number(bill?.sgst_amount) || 0;
  if (igst > 0)             return true;
  if (cgst > 0 || sgst > 0) return false;
  // No tax → fall back to state-code comparison. null state → assume intra.
  const pos = placeOfSupply(customer);
  if (pos && companyStateCode) return pos !== companyStateCode;
  return false;
}

/**
 * Classify an invoice into a GSTR-1 section.
 *
 * Rules (simplified from the 2024 GSTR-1 spec):
 *   - B2B    : customer has a non-empty GSTIN
 *   - B2CL   : no GSTIN AND inter-state (per stored taxes) AND > ₹2.5L
 *   - B2CS   : everything else
 *
 * Exports / SEZ / Nil-rated are not modelled in this first pass; callers
 * that need them will add routing ahead of this function.
 */
function classify(bill, customer, companyStateCode) {
  if (isNilExemptBill(bill)) return 'NIL';
  const custGstin = (customer?.gstin || '').trim();
  if (custGstin) return 'B2B';
  const inter = isInterState(bill, customer, companyStateCode);
  if (inter && Number(bill.total_amount || 0) > 250000) return 'B2CL';
  return 'B2CS';
}

/* Split a bill's tax totals across "rate buckets". A bill may carry items
 * at multiple rates (18%, 12%, 5% mixed). GSTR-1 reports need per-rate
 * taxable + tax, so we aggregate at the line level. Returns an array:
 *   [{ rate, taxable, igst, cgst, sgst, cess }, …]
 * with exactly one row per distinct rate in the bill.
 */
function billRateBuckets(items) {
  const byRate = new Map();
  for (const it of items || []) {
    const rate = Number(it.gst_rate) || 0;
    const row = byRate.get(rate) || { rate, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    row.taxable += Number(it.taxable_amount) || 0;
    row.igst    += Number(it.igst_amount)    || 0;
    row.cgst    += Number(it.cgst_amount)    || 0;
    row.sgst    += Number(it.sgst_amount)    || 0;
    row.cess    += Number(it.cess_amount)    || 0;
    byRate.set(rate, row);
  }
  const out = [...byRate.values()].map(r => ({
    rate: r.rate,
    taxable: round2(r.taxable),
    igst:    round2(r.igst),
    cgst:    round2(r.cgst),
    sgst:    round2(r.sgst),
    cess:    round2(r.cess),
  }));
  out.sort((a, b) => b.rate - a.rate);
  return out;
}

/**
 * Bill-wise GST mode (SystemSettings.gst_mode='bill-wise') stores the tax
 * split ONLY on SalesBill (header), leaving every SalesBillItem with
 * cgst/sgst/igst = 0. Item-wise mode stores it on each item.
 *
 * billRateBuckets() aggregates from the item level, so bill-wise invoices
 * come out with correct taxable amounts per rate but zero tax across the
 * board. This helper backfills the missing splits from the header tax
 * totals, allocating pro-rata by each bucket's TAX-BASE (taxable × rate)
 * — not by taxable alone — so a bill mixing 18% and 0% lines puts all tax
 * on the 18% bucket instead of smearing it across the nil-rated one.
 *
 * The last non-zero-weight bucket absorbs the rounding remainder so the
 * allocated sums equal the bill's stored header totals to the paisa.
 * No-ops when item-level tax is already populated (item-wise bills) or
 * when the bill header carries no tax (genuine nil/exempt supplies).
 */
function reconcileBillLevelTax(buckets, bill) {
  if (!buckets || buckets.length === 0) return buckets || [];
  const itemTax = buckets.reduce((a, r) => a + r.igst + r.cgst + r.sgst + r.cess, 0);
  if (itemTax > 0.01) return buckets;

  const billCgst = Number(bill?.cgst_amount) || 0;
  const billSgst = Number(bill?.sgst_amount) || 0;
  const billIgst = Number(bill?.igst_amount) || 0;
  const billCess = Number(bill?.cess_amount) || 0;
  if (billCgst + billSgst + billIgst + billCess <= 0.01) return buckets;

  const weights = buckets.map(r => r.taxable * r.rate);
  const wSum = weights.reduce((a, w) => a + w, 0);
  if (wSum <= 0.01) return buckets;

  let lastWeighted = -1;
  for (let i = weights.length - 1; i >= 0; i--) {
    if (weights[i] > 0) { lastWeighted = i; break; }
  }

  let remCgst = billCgst, remSgst = billSgst, remIgst = billIgst, remCess = billCess;
  return buckets.map((r, i) => {
    if (weights[i] === 0) return r;
    const last = i === lastWeighted;
    const share = weights[i] / wSum;
    const cgst = last ? round2(remCgst) : round2(billCgst * share);
    const sgst = last ? round2(remSgst) : round2(billSgst * share);
    const igst = last ? round2(remIgst) : round2(billIgst * share);
    const cess = last ? round2(remCess) : round2(billCess * share);
    remCgst -= cgst; remSgst -= sgst; remIgst -= igst; remCess -= cess;
    return { ...r, cgst, sgst, igst, cess };
  });
}

/** Convenience: read items, bucket, then reconcile against bill header. */
function bucketsForBill(bill) {
  return reconcileBillLevelTax(billRateBuckets(bill?.items), bill);
}

/**
 * Nil / Exempt / Non-GST test. A bill qualifies for Table 8 when neither
 * item-level nor bill-level tax carries any value — no CGST, SGST, IGST
 * or Cess anywhere. Treated as outward supply without tax regardless of
 * whether the customer has a GSTIN. We do NOT rely on rate==0 alone
 * because a bill in bill-wise mode may carry items at 18% but have had
 * the header percentages left blank (a data-entry error), and that
 * still produces a zero-tax supply — which is what the taxpayer
 * actually filed.
 */
function isNilExemptBill(bill) {
  const bCgst = Number(bill?.cgst_amount) || 0;
  const bSgst = Number(bill?.sgst_amount) || 0;
  const bIgst = Number(bill?.igst_amount) || 0;
  const bCess = Number(bill?.cess_amount) || 0;
  if (bCgst + bSgst + bIgst + bCess > 0.01) return false;
  for (const it of (bill?.items || [])) {
    const t = (Number(it.cgst_amount) || 0) + (Number(it.sgst_amount) || 0)
            + (Number(it.igst_amount) || 0) + (Number(it.cess_amount) || 0);
    if (t > 0.01) return false;
  }
  return true;
}

/**
 * Table 8 — Nil-rated / Exempted / Non-GST outward supplies.
 *
 * GSTR-1 reports this as four buckets distinguished by
 * (registered-vs-unregistered) × (intra-vs-inter). We aggregate the
 * taxable value in each bucket and also expose a per-invoice list so the
 * UI can show which bills landed here (useful when a "missing tax" is a
 * data-entry mistake the user wants to find and fix).
 */
function aggregateNil(bills, companyStateCode) {
  const groups = new Map();
  const invoices = [];
  let grand = { taxable: 0 };

  for (const bill of bills) {
    if (!isNilExemptBill(bill)) continue;
    const cust = bill.customer;
    const registered = !!(cust?.gstin || '').trim();
    const inter = isInterState(bill, cust, companyStateCode);
    const supplyType = registered ? 'Registered' : 'Unregistered';
    const stateType  = inter ? 'Inter-state' : 'Intra-state';
    const key = `${supplyType}|${stateType}`;
    const taxable = (bill.items || []).reduce((a, it) => a + (Number(it.taxable_amount) || 0), 0);
    const pos = placeOfSupply(cust) || companyStateCode || null;

    let g = groups.get(key);
    if (!g) {
      g = { supply_type: supplyType, state_type: stateType, taxable: 0, invoice_count: 0 };
      groups.set(key, g);
    }
    g.taxable += taxable;
    g.invoice_count += 1;
    grand.taxable += taxable;

    invoices.push({
      bill_number: bill.bill_number,
      bill_date: bill.bill_date,
      party_name: cust?.party_name || '—',
      gstin: cust?.gstin || null,
      place_of_supply: pos,
      supply_type: supplyType,
      state_type: stateType,
      taxable: round2(taxable),
      total: round2(bill.total_amount),
    });
  }

  const rows = [...groups.values()].map(g => ({
    ...g,
    taxable: round2(g.taxable),
  }));
  rows.sort((a, b) =>
    a.supply_type.localeCompare(b.supply_type) ||
    a.state_type.localeCompare(b.state_type));
  invoices.sort((a, b) => a.bill_date.localeCompare(b.bill_date));
  grand.taxable = round2(grand.taxable);
  return { rows, invoices, grand };
}

/**
 * B2B aggregation: one row per invoice, grouped by recipient GSTIN.
 *
 * Input shape (per bill):
 *   { bill_number, bill_date, total_amount, sub_total,
 *     customer: { party_name, gstin, state },
 *     items: [ { hsn_code, gst_rate, taxable_amount, cgst_amount,
 *                sgst_amount, igst_amount, cess_amount } ] }
 */
function aggregateB2B(bills, companyStateCode) {
  const byGstin = new Map();
  let grand = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };

  for (const bill of bills) {
    const cust = bill.customer;
    if (!cust?.gstin) continue;
    // Skip invoices that are entirely nil/exempt/non-GST — they belong in
    // Table 8, not Table 4A. aggregateNil picks them up separately.
    if (isNilExemptBill(bill)) continue;
    const buckets = bucketsForBill(bill);
    const totals = buckets.reduce((a, r) => ({
      taxable: a.taxable + r.taxable,
      igst:    a.igst    + r.igst,
      cgst:    a.cgst    + r.cgst,
      sgst:    a.sgst    + r.sgst,
      cess:    a.cess    + r.cess,
    }), { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

    const pos = placeOfSupply(cust) || companyStateCode || null;
    const invType = isInterState(bill, cust, companyStateCode) ? 'Inter-state' : 'Intra-state';

    const key = cust.gstin.trim().toUpperCase();
    let group = byGstin.get(key);
    if (!group) {
      group = {
        gstin: key,
        party_name: cust.party_name,
        place_of_supply: pos,
        invoices: [],
        invoice_count: 0,
        taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0,
      };
      byGstin.set(key, group);
    }

    const inv = {
      bill_number: bill.bill_number,
      bill_date: bill.bill_date,
      place_of_supply: pos,
      invoice_value: round2(bill.total_amount),
      invoice_type: invType,
      reverse_charge: false,
      rate_rows: buckets,
      taxable: round2(totals.taxable),
      igst:    round2(totals.igst),
      cgst:    round2(totals.cgst),
      sgst:    round2(totals.sgst),
      cess:    round2(totals.cess),
      total:   round2(bill.total_amount),
    };
    group.invoices.push(inv);
    group.invoice_count += 1;
    group.taxable += inv.taxable;
    group.igst    += inv.igst;
    group.cgst    += inv.cgst;
    group.sgst    += inv.sgst;
    group.cess    += inv.cess;
    group.total   += inv.total;

    grand.taxable += inv.taxable;
    grand.igst    += inv.igst;
    grand.cgst    += inv.cgst;
    grand.sgst    += inv.sgst;
    grand.cess    += inv.cess;
    grand.total   += inv.total;
  }

  const rows = [...byGstin.values()].map(g => ({
    ...g,
    taxable: round2(g.taxable),
    igst:    round2(g.igst),
    cgst:    round2(g.cgst),
    sgst:    round2(g.sgst),
    cess:    round2(g.cess),
    total:   round2(g.total),
    invoices: g.invoices.sort((a, b) => a.bill_date.localeCompare(b.bill_date)),
  }));
  rows.sort((a, b) => b.total - a.total);

  for (const k of Object.keys(grand)) grand[k] = round2(grand[k]);
  return { rows, grand };
}

/**
 * B2CS aggregation: grouped by place-of-supply state + rate + type.
 * Each group row aggregates every B2CS invoice hitting that bucket.
 */
function aggregateB2CS(bills, companyStateCode) {
  const groups = new Map();   // key = pos|rate|type
  let grand = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };

  for (const bill of bills) {
    const cust = bill.customer;
    if (cust?.gstin) continue;       // B2B invoices skip this section

    const pos = placeOfSupply(cust) || companyStateCode || '97';  // 97 = Other
    const inter = isInterState(bill, cust, companyStateCode);
    if (inter && Number(bill.total_amount || 0) > 250000) continue; // → B2CL
    if (isNilExemptBill(bill)) continue;                            // → Table 8

    for (const r of bucketsForBill(bill)) {
      const type = inter ? 'Inter-state' : 'Intra-state';
      const key = `${pos}|${r.rate}|${type}`;
      let g = groups.get(key);
      if (!g) {
        g = { place_of_supply: pos, rate: r.rate, type,
              taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
        groups.set(key, g);
      }
      g.taxable += r.taxable;
      g.igst    += r.igst;
      g.cgst    += r.cgst;
      g.sgst    += r.sgst;
      g.cess    += r.cess;
      grand.taxable += r.taxable;
      grand.igst    += r.igst;
      grand.cgst    += r.cgst;
      grand.sgst    += r.sgst;
      grand.cess    += r.cess;
      grand.total   += r.taxable + r.igst + r.cgst + r.sgst + r.cess;
    }
  }

  const rows = [...groups.values()].map(g => ({
    ...g,
    taxable: round2(g.taxable),
    igst:    round2(g.igst),
    cgst:    round2(g.cgst),
    sgst:    round2(g.sgst),
    cess:    round2(g.cess),
    total:   round2(g.taxable + g.igst + g.cgst + g.sgst + g.cess),
  }));
  rows.sort((a, b) => (a.place_of_supply || '').localeCompare(b.place_of_supply || '') || b.rate - a.rate);
  for (const k of Object.keys(grand)) grand[k] = round2(grand[k]);
  return { rows, grand };
}

/**
 * HSN aggregation: per-line, grouped by HSN code + rate + unit. UQC
 * normalisation is kept simple — upper-case trim. Uncommon units pass
 * through verbatim (portal accepts "OTH" mapping for unknowns).
 */
function aggregateHSN(bills) {
  const groups = new Map();
  let grand = { quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };

  for (const bill of bills) {
    for (const it of (bill.items || [])) {
      const hsn = (it.hsn_code || '').trim();
      if (!hsn) continue;
      const rate = Number(it.gst_rate) || 0;
      const unit = (it.unit_type || 'PCS').toUpperCase().trim();
      const key = `${hsn}|${rate}|${unit}`;
      let g = groups.get(key);
      if (!g) {
        g = { hsn_code: hsn, rate, unit,
              quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
        groups.set(key, g);
      }
      const qty     = Number(it.quantity)       || 0;
      const taxable = Number(it.taxable_amount) || 0;
      const igst    = Number(it.igst_amount)    || 0;
      const cgst    = Number(it.cgst_amount)    || 0;
      const sgst    = Number(it.sgst_amount)    || 0;
      const cess    = Number(it.cess_amount)    || 0;
      g.quantity += qty;
      g.taxable  += taxable;
      g.igst     += igst;
      g.cgst     += cgst;
      g.sgst     += sgst;
      g.cess     += cess;
      grand.quantity += qty;
      grand.taxable  += taxable;
      grand.igst     += igst;
      grand.cgst     += cgst;
      grand.sgst     += sgst;
      grand.cess     += cess;
    }
  }

  const rows = [...groups.values()].map(g => ({
    ...g,
    quantity: round2(g.quantity),
    taxable:  round2(g.taxable),
    igst:     round2(g.igst),
    cgst:     round2(g.cgst),
    sgst:     round2(g.sgst),
    cess:     round2(g.cess),
    total:    round2(g.taxable + g.igst + g.cgst + g.sgst + g.cess),
  }));
  rows.sort((a, b) => a.hsn_code.localeCompare(b.hsn_code) || b.rate - a.rate);
  for (const k of Object.keys(grand)) grand[k] = round2(grand[k]);
  grand.total = round2(grand.taxable + grand.igst + grand.cgst + grand.sgst + grand.cess);
  return { rows, grand };
}

/**
 * Build the complete GSTR-1 aggregate.
 * `bills` is already filtered (period, non-cancelled) by the caller.
 */
function buildGstr1(bills, { companyStateCode } = {}) {
  const cStateCode = companyStateCode || null;
  return {
    period_meta: {
      invoice_count: bills.length,
      company_state_code: cStateCode,
    },
    b2b:  aggregateB2B(bills, cStateCode),
    b2cs: aggregateB2CS(bills, cStateCode),
    nil:  aggregateNil(bills, cStateCode),
    hsn:  aggregateHSN(bills),
    classification: bills.map(b => ({
      bill_number: b.bill_number,
      bucket: classify(b, b.customer, cStateCode),
    })),
  };
}

module.exports = {
  round2,
  stateCodeFromGstin,
  stateCodeFromName,
  placeOfSupply,
  isInterState,
  classify,
  billRateBuckets,
  reconcileBillLevelTax,
  bucketsForBill,
  isNilExemptBill,
  aggregateB2B,
  aggregateB2CS,
  aggregateNil,
  aggregateHSN,
  buildGstr1,
};
