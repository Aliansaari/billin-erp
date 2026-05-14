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
 * Explain WHY a particular bill landed in the nil/exempt bucket. Without a
 * dedicated `nil_reason` column on the product master we can only infer from
 * the GST rates the user actually entered. Two cases the operator cares about:
 *
 *   1. Every line is at 0% — a genuine nil-rated supply (salt, fresh produce,
 *      milk, etc.). Action: none, this is correct.
 *   2. At least one line carries a non-zero rate but no tax was charged —
 *      almost always a data-entry slip (bill saved before tax % was filled,
 *      or the user picked the wrong GST mode). Action: open the bill, add
 *      tax, and it'll move out of Table 8.
 *
 * Returns { reason, detail } — `reason` is a short label for the column,
 * `detail` is a longer human string the UI shows in a tooltip.
 */
function classifyNilReason(bill) {
  const items = bill?.items || [];
  if (items.length === 0) {
    return { reason: 'No items', detail: 'Bill has no line items' };
  }
  const rates = items.map(it => Number(it.gst_rate) || 0);
  const distinct = [...new Set(rates)].sort((a, b) => a - b);
  const rateLabel = distinct.map(r => r + '%').join(', ');
  const hasNonZero = distinct.some(r => r > 0);
  if (!hasNonZero) {
    return {
      reason: 'Nil-rated',
      detail: `All items at 0% GST — genuine nil-rated supply (rates: ${rateLabel})`,
    };
  }
  const allNonZero = distinct.every(r => r > 0);
  if (allNonZero) {
    return {
      reason: 'Tax not captured',
      detail: `Items have non-zero rates (${rateLabel}) but no CGST/SGST/IGST was recorded — review the bill`,
    };
  }
  return {
    reason: 'Mixed (review)',
    detail: `Some items at 0%, others at ${distinct.filter(r => r > 0).map(r => r + '%').join(', ')} — verify the non-zero lines`,
  };
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

    const { reason, detail } = classifyNilReason(bill);
    invoices.push({
      bill_id: bill.bill_id,
      bill_number: bill.bill_number,
      bill_date: bill.bill_date,
      party_name: cust?.party_name || '—',
      gstin: cust?.gstin || null,
      place_of_supply: pos,
      supply_type: supplyType,
      state_type: stateType,
      reason,
      reason_detail: detail,
      remarks: bill.remarks || '',
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
 * Tables 9A (CDNR) + 9B (CDNUR) — Credit / Debit Notes.
 *
 * Sales returns are modelled as Credit Notes (note_type='C'). Each return
 * splits into one row per rate bucket (matches portal CDNR/CDNUR shape).
 * Routing:
 *   - Customer has GSTIN → Table 9A (Registered)
 *   - No GSTIN, inter-state → Table 9B with ur_type='B2CL'
 *   - No GSTIN, intra-state → Table 9B with ur_type='B2C' (technically
 *     these are netted into Table 7 B2CS on the portal, but we surface them
 *     in 9B for review completeness — operators must net them manually
 *     before portal upload)
 *
 * Each note carries `original_invoice_number` and `original_invoice_date`
 * (the invoice the customer is returning against) so the recipient can
 * match it to their input-tax-credit claim.
 *
 * Returns shape: `{ cdnr: { rows, grand }, cdnur: { rows, grand } }`.
 *
 * Input return shape:
 *   { return_id, return_number, return_date, total_amount,
 *     reference_bill_number, reference_bill_date,
 *     customer: { party_name, gstin, state, mobile_1 },
 *     items: [ { gst_rate, taxable_amount, cgst_amount, sgst_amount,
 *                igst_amount, cess_amount } ],
 *     cgst_amount, sgst_amount, igst_amount, cess_amount }
 */
function aggregateCnDn(returns, companyStateCode) {
  const cdnr  = { rows: [], grand: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 } };
  const cdnur = { rows: [], grand: { taxable: 0, igst: 0, cess: 0, total: 0 } };
  // Track distinct notes for invoice_count headers
  const seenCdnr = new Set();
  const seenCdnur = new Set();

  for (const ret of (returns || [])) {
    const cust = ret.customer;
    // Reuse the bill helpers — they don't care that the input is a return
    // because the field shape is identical (bucketsForBill reads cgst/sgst/
    // igst/cess off items + reconciles against bill-header amounts).
    const inter = isInterState(ret, cust, companyStateCode);
    const pos = placeOfSupply(cust) || companyStateCode || '97';
    const buckets = bucketsForBill(ret);
    const isReg = !!(cust?.gstin || '').trim();
    let pushed = false;   // becomes true if we emit at least one bucket row

    for (const r of buckets) {
      // Skip pure-zero rate buckets so 5%/12% mix doesn't pollute output
      if (r.taxable === 0 && r.igst === 0 && r.cgst === 0 && r.sgst === 0 && r.cess === 0) continue;
      pushed = true;

      if (isReg) {
        cdnr.rows.push({
          return_id:        ret.return_id,
          note_number:      ret.return_number,
          note_date:        ret.return_date,
          note_type:        'C',                  // Credit (only CN modelled)
          gstin:            cust.gstin,
          customer_name:    cust?.party_name || '—',
          place_of_supply:  pos,
          note_value:       round2(ret.total_amount),
          rate:             r.rate,
          taxable:          round2(r.taxable),
          igst:             round2(r.igst),
          cgst:             round2(r.cgst),
          sgst:             round2(r.sgst),
          cess:             round2(r.cess),
          original_invoice_number: ret.reference_bill_number || '',
          original_invoice_date:   ret.reference_bill_date   || null,
          reverse_charge:   false,                // hard-coded; see audit
        });
        cdnr.grand.taxable += r.taxable;
        cdnr.grand.igst    += r.igst;
        cdnr.grand.cgst    += r.cgst;
        cdnr.grand.sgst    += r.sgst;
        cdnr.grand.cess    += r.cess;
      } else {
        // Audit H3 — split CGST/SGST/IGST into separate columns instead of
        // mashing intra-state CGST+SGST into the IGST column. Previously
        // the row stored `igst = igst + (intra ? cgst + sgst : 0)`, which
        // labelled intra-state credit notes as inter-state on portal-style
        // output and confused operators uploading the JSON straight to the
        // GST portal. The row now carries cgst/sgst/igst independently so
        // the UI can render the correct tax head and the JSON export can
        // either:
        //   - keep IGST-only for legitimate inter-state CDNUR (the portal's
        //     own 9B contract), OR
        //   - net intra-state into B2CS (Table 7), which is where the
        //     portal expects them.
        // ur_type: 'B2CL' for inter > ₹2.5L; 'B2C' (informational, intra
        // unregistered should be netted into B2CS by the operator) otherwise.
        cdnur.rows.push({
          return_id:        ret.return_id,
          note_number:      ret.return_number,
          note_date:        ret.return_date,
          note_type:        'C',
          ur_type:          inter ? 'B2CL' : 'B2C',
          customer_name:    cust?.party_name || '—',
          mobile:           cust?.mobile_1 || null,
          place_of_supply:  pos,
          note_value:       round2(ret.total_amount),
          rate:             r.rate,
          taxable:          round2(r.taxable),
          // Audit H3 — proper head separation. Pre-fix: a `CDNUR.igst` that
          // mashed intra CGST+SGST into IGST. Now each head is faithful.
          // Net-into-B2CS guidance for the intra-state rows is surfaced via
          // `requires_b2cs_netting` so the UI / exporter can act on it.
          cgst:             round2(inter ? 0 : r.cgst),
          sgst:             round2(inter ? 0 : r.sgst),
          igst:             round2(inter ? r.igst : 0),
          cess:             round2(r.cess),
          requires_b2cs_netting: !inter, // operator should net into B2CS Tbl 7
          original_invoice_number: ret.reference_bill_number || '',
          original_invoice_date:   ret.reference_bill_date   || null,
        });
        cdnur.grand.taxable += r.taxable;
        // Grand totals split too — historical igst-only field kept as a
        // back-compat alias on the response (consumer code can read either).
        cdnur.grand.cgst = (cdnur.grand.cgst || 0) + (inter ? 0 : r.cgst);
        cdnur.grand.sgst = (cdnur.grand.sgst || 0) + (inter ? 0 : r.sgst);
        cdnur.grand.igst += inter ? r.igst : 0;
        cdnur.grand.cess += r.cess;
      }
    }
    // Only count notes that produced at least one row. An empty-items
    // return otherwise inflates the count badge while the table is empty.
    if (pushed) {
      if (isReg) seenCdnr.add(ret.return_number);
      else       seenCdnur.add(ret.return_number);
    }
  }

  // Grand totals — CDNR includes intra-state CGST+SGST.
  // Audit H3 — CDNUR now also breaks out CGST/SGST/IGST instead of mashing
  // intra-state heads into igst. Total includes all heads.
  cdnr.grand.total  = cdnr.grand.taxable + cdnr.grand.igst + cdnr.grand.cgst + cdnr.grand.sgst + cdnr.grand.cess;
  cdnur.grand.cgst  = +(cdnur.grand.cgst || 0).toFixed(2);
  cdnur.grand.sgst  = +(cdnur.grand.sgst || 0).toFixed(2);
  cdnur.grand.total = cdnur.grand.taxable + cdnur.grand.igst + cdnur.grand.cgst + cdnur.grand.sgst + cdnur.grand.cess;
  for (const k of Object.keys(cdnr.grand))  cdnr.grand[k]  = round2(cdnr.grand[k]);
  for (const k of Object.keys(cdnur.grand)) cdnur.grand[k] = round2(cdnur.grand[k]);

  // Sort by date asc, then note number, then rate desc
  const sorter = (a, b) =>
    (a.note_date || '').localeCompare(b.note_date || '') ||
    (a.note_number || '').localeCompare(b.note_number || '') ||
    b.rate - a.rate;
  cdnr.rows.sort(sorter);
  cdnur.rows.sort(sorter);

  cdnr.note_count  = seenCdnr.size;
  cdnur.note_count = seenCdnur.size;
  return { cdnr, cdnur };
}

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
      bill_id: bill.bill_id,
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
 * Table 5A — B2CL (Big B2C). Inter-state supplies to UNREGISTERED customers
 * where the invoice value exceeds ₹2,50,000. The portal wants these reported
 * invoice-by-invoice (not aggregated) because each one moves enough tax to
 * matter for the recipient state's revenue allocation.
 *
 * Without this aggregator, `aggregateB2CS` silently drops these bills via
 * its `> 250000` guard — the very gap this function closes.
 *
 * Output: one row per (invoice × rate bucket) so a multi-rate invoice
 * produces multiple rows (matches how the GSTN offline tool ingests them).
 * `invoice_value` repeats across rows for the same invoice — that's the
 * portal-expected shape; consumers comparing grand totals must dedupe by
 * bill_number.
 */
function aggregateB2CL(bills, companyStateCode) {
  const rows = [];
  let grand = { taxable: 0, igst: 0, cess: 0, total: 0 };
  // Track distinct invoices to surface a meaningful invoice_count without
  // double-counting multi-rate bills.
  const seenBills = new Set();

  for (const bill of bills) {
    const cust = bill.customer;
    if (cust?.gstin) continue;                                   // → B2B
    const inter = isInterState(bill, cust, companyStateCode);
    if (!inter) continue;                                        // → B2CS intra
    if (Number(bill.total_amount || 0) <= 250000) continue;       // → B2CS inter ≤2.5L
    if (isNilExemptBill(bill)) continue;                          // → Table 8

    const pos = placeOfSupply(cust) || companyStateCode || '97';
    const buckets = bucketsForBill(bill);                         // honours bill-wise mode
    seenBills.add(bill.bill_number);

    for (const r of buckets) {
      // Skip pure-zero rows so a 5%/12% mix doesn't produce stray empty 0% rows
      if (r.taxable === 0 && r.igst === 0 && r.cess === 0) continue;
      rows.push({
        bill_id:        bill.bill_id,
        bill_number:    bill.bill_number,
        bill_date:      bill.bill_date,
        customer_name:  cust?.party_name || '—',
        mobile:         cust?.mobile_1 || null,
        invoice_value:  round2(bill.total_amount),
        place_of_supply: pos,
        rate:           r.rate,
        taxable:        round2(r.taxable),
        igst:           round2(r.igst),
        cess:           round2(r.cess),
      });
      grand.taxable += r.taxable;
      grand.igst    += r.igst;
      grand.cess    += r.cess;
    }
  }
  // Total = taxable + tax (IGST only — these are inter-state by construction)
  grand.total = grand.taxable + grand.igst + grand.cess;
  for (const k of Object.keys(grand)) grand[k] = round2(grand[k]);

  // Sort by date then bill_number for predictable reading order.
  rows.sort((a, b) =>
    (a.bill_date || '').localeCompare(b.bill_date || '') ||
    (a.bill_number || '').localeCompare(b.bill_number || '') ||
    b.rate - a.rate);

  return { rows, grand, invoice_count: seenBills.size };
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
        // `invoices` is the per-bill drill-down. The portal upload only
        // wants the aggregated totals (POS × Rate × Type) but operators
        // need to see which bills contributed when something looks off.
        g = { place_of_supply: pos, rate: r.rate, type,
              taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0,
              invoice_count: 0, invoices: [] };
        groups.set(key, g);
      }
      g.taxable += r.taxable;
      g.igst    += r.igst;
      g.cgst    += r.cgst;
      g.sgst    += r.sgst;
      g.cess    += r.cess;
      g.invoices.push({
        bill_id:       bill.bill_id,
        bill_number:   bill.bill_number,
        bill_date:     bill.bill_date,
        customer_name: cust?.party_name || '—',
        mobile:        cust?.mobile_1 || null,
        taxable:       round2(r.taxable),
        igst:          round2(r.igst),
        cgst:          round2(r.cgst),
        sgst:          round2(r.sgst),
        cess:          round2(r.cess),
        total:         round2(r.taxable + r.igst + r.cgst + r.sgst + r.cess),
      });
      g.invoice_count = g.invoices.length;
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
    // Sort invoices by date (oldest first) for consistent reading order
    invoices: g.invoices.sort((a, b) => (a.bill_date || '').localeCompare(b.bill_date || '')),
  }));
  rows.sort((a, b) => (a.place_of_supply || '').localeCompare(b.place_of_supply || '') || b.rate - a.rate);
  for (const k of Object.keys(grand)) grand[k] = round2(grand[k]);
  return { rows, grand };
}

/**
 * UQC (Unit Quantity Code) normalisation. The GSTN portal expects very
 * specific strings (e.g. "MTR-METRES", "BOX-BOX") and rejects free-text
 * units like "METER" or "BOX". Map the loose strings users actually type
 * into the codes the portal accepts. Anything truly unknown becomes
 * "OTH-OTHERS" — better than crashing the upload.
 *
 * The map is intentionally generous about input variants (singular/plural,
 * abbreviations) because user-entered data is messy. Keys are upper-cased
 * before lookup so casing doesn't matter.
 */
const UQC_MAP = {
  PCS: 'PCS-PIECES', PIECE: 'PCS-PIECES', PIECES: 'PCS-PIECES',
  NOS: 'PCS-PIECES', NO: 'PCS-PIECES', NUMBERS: 'PCS-PIECES',
  MTR: 'MTR-METRES', METER: 'MTR-METRES', METRE: 'MTR-METRES',
  METERS: 'MTR-METRES', METRES: 'MTR-METRES', M: 'MTR-METRES',
  KG: 'KGS-KILOGRAMS', KGS: 'KGS-KILOGRAMS',
  KILOGRAM: 'KGS-KILOGRAMS', KILOGRAMS: 'KGS-KILOGRAMS',
  BOX: 'BOX-BOX', BOXES: 'BOX-BOX',
  DZN: 'DZN-DOZENS', DOZEN: 'DZN-DOZENS', DOZENS: 'DZN-DOZENS',
  ROL: 'ROL-ROLLS', ROLL: 'ROL-ROLLS', ROLLS: 'ROL-ROLLS',
  PRS: 'PRS-PAIRS', PAIR: 'PRS-PAIRS', PAIRS: 'PRS-PAIRS',
  SET: 'SET-SET', SETS: 'SET-SET',
  GMS: 'GMS-GRAMMES', GM: 'GMS-GRAMMES', GRAM: 'GMS-GRAMMES', GRAMS: 'GMS-GRAMMES',
  LTR: 'LTR-LITRES', L: 'LTR-LITRES', LITRE: 'LTR-LITRES', LITER: 'LTR-LITRES',
  MLT: 'MLT-MILLILITRE', ML: 'MLT-MILLILITRE',
};
function normalizeUqc(unit) {
  // Trim first, *then* default — whitespace-only strings ("   ") would
  // otherwise pass the truthy check and become empty after trimming,
  // misclassifying as OTH-OTHERS. Empty/null intentionally defaults to
  // PCS-PIECES so items missing a unit land in the same bucket they
  // landed in before this helper existed.
  const u = String(unit || '').toUpperCase().trim();
  if (!u) return 'PCS-PIECES';
  return UQC_MAP[u] || 'OTH-OTHERS';
}

/**
 * HSN aggregation: per-line, grouped by HSN code + rate + UQC. UQC values
 * are normalised to GSTN codes via normalizeUqc — without this, free-text
 * units like "METER" leak into the export and the portal rejects them.
 */
function aggregateHSN(bills) {
  const groups = new Map();
  let grand = { quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };

  for (const bill of bills) {
    for (const it of (bill.items || [])) {
      const hsn = (it.hsn_code || '').trim();
      if (!hsn) continue;
      const rate = Number(it.gst_rate) || 0;
      const unit = normalizeUqc(it.unit_type);
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
 * Table 13 — Documents Issued. Auditors require a sequence-number summary
 * of every document type the taxpayer issued in the period: how many were
 * raised, how many cancelled, the from-no/to-no range. This catches missing
 * sequence numbers (a common red flag) and proves no parallel book exists.
 *
 * For this first pass we report Sales Invoices only — Credit/Debit notes
 * and Delivery Challans need separate model wiring (see audit follow-ups).
 *
 * Bill numbers are split into (prefix, sequence) by trailing digits:
 *   "INV-25-26-0001" → prefix="INV-25-26-", seq=1
 *   "INV/A/12"       → prefix="INV/A/",     seq=12
 *   "MANUAL"         → prefix="MANUAL",     seq=null (own row, from/to = "—")
 */
function _splitDocNumber(num) {
  const s = String(num || '').trim();
  if (!s) return { prefix: '(blank)', seq: null };
  const m = s.match(/^(.*?)(\d+)$/);
  if (!m) return { prefix: s, seq: null };
  // Pure-numeric input (e.g. "001", "42") matches with empty prefix —
  // surface it as the literal series "(numeric)" rather than the
  // misleading "(none)" so Table 13 says what's actually happening and
  // the GSTN validator gets a non-empty series identifier.
  return { prefix: m[1] || '(numeric)', seq: Number(m[2]) };
}

function aggregateDocsIssued(activeBills, cancelledBills, activeReturns = [], cancelledReturns = []) {
  const groups = new Map();   // key = nature|prefix
  const INVOICE_NATURE = 'Invoices for outward supply';
  const CN_NATURE      = 'Credit Notes';

  const bump = (nature, num, isCancelled) => {
    const { prefix, seq } = _splitDocNumber(num);
    const key = `${nature}|${prefix}`;
    let g = groups.get(key);
    if (!g) {
      g = { nature, prefix,
            from_no: null, to_no: null,
            total: 0, cancelled: 0, net: 0,
            _hasNumeric: false };
      groups.set(key, g);
    }
    g.total += 1;
    if (isCancelled) g.cancelled += 1;
    g.net = g.total - g.cancelled;
    if (seq != null) {
      g._hasNumeric = true;
      if (g.from_no == null || seq < g.from_no) g.from_no = seq;
      if (g.to_no   == null || seq > g.to_no)   g.to_no   = seq;
    }
  };

  for (const b of (activeBills      || [])) bump(INVOICE_NATURE, b.bill_number,   false);
  for (const b of (cancelledBills   || [])) bump(INVOICE_NATURE, b.bill_number,   true);
  for (const r of (activeReturns    || [])) bump(CN_NATURE,      r.return_number, false);
  for (const r of (cancelledReturns || [])) bump(CN_NATURE,      r.return_number, true);

  const rows = [...groups.values()].map(g => ({
    nature:    g.nature,
    prefix:    g.prefix,
    // Display "—" for the unparseable case so the UI doesn't show "null"
    from_no:   g._hasNumeric ? String(g.from_no) : '—',
    to_no:     g._hasNumeric ? String(g.to_no)   : '—',
    total:     g.total,
    cancelled: g.cancelled,
    net:       g.net,
  }));
  rows.sort((a, b) =>
    a.nature.localeCompare(b.nature) ||
    a.prefix.localeCompare(b.prefix));

  const grand = rows.reduce((acc, r) => {
    acc.total     += r.total;
    acc.cancelled += r.cancelled;
    acc.net       += r.net;
    return acc;
  }, { total: 0, cancelled: 0, net: 0 });

  return { rows, grand };
}

/**
 * Data-quality scanner. Surfaces bills whose stored numbers don't add up:
 *   Σ items.taxable + bill.cgst + bill.sgst + bill.igst + bill.cess  >  bill.total + ₹1
 * That gap means the bill was created/imported without applying the bill-
 * level discount to the per-item `taxable_amount`, which over-states the
 * outward-supply taxable value in every downstream return (GSTR-1, GSTR-3B).
 *
 * The aggregator does NOT auto-correct — silently changing the numbers
 * would make the report disagree with what the user sees on the bill, and
 * could mask real bugs. We expose the warnings so the operator can open
 * each bill, re-save it (which re-applies the correct pro-rata discount
 * via salesController.js), and re-run the report.
 *
 * Returns an array of warnings; empty when everything is clean.
 */
function detectBillDataIssues(bills) {
  const warnings = [];
  for (const b of (bills || [])) {
    const itemsTax = (b.items || []).reduce((a, i) => a + (Number(i.taxable_amount) || 0), 0);
    const headerTax = (Number(b.cgst_amount) || 0) + (Number(b.sgst_amount) || 0)
                    + (Number(b.igst_amount) || 0) + (Number(b.cess_amount) || 0);
    const computed = itemsTax + headerTax;
    const total = Number(b.total_amount) || 0;
    const delta = round2(computed - total);
    // Allow ₹1 slop for benign round-off; anything bigger is a real defect.
    if (delta > 1) {
      warnings.push({
        bill_id:     b.bill_id,
        bill_number: b.bill_number,
        bill_date:   b.bill_date,
        issue:       'taxable_overstated',
        message:     `Items + tax (₹${round2(computed)}) exceed bill total (₹${round2(total)}) by ₹${delta}. Likely cause: bill-level discount wasn't applied to per-item taxable amounts. Open and re-save the bill to fix.`,
        items_taxable_sum: round2(itemsTax),
        header_tax_sum:    round2(headerTax),
        bill_total:        round2(total),
        over_by:           delta,
      });
    }
  }
  // Sort worst-first so the operator sees the biggest discrepancies up top
  warnings.sort((a, b) => b.over_by - a.over_by);
  return warnings;
}

/**
 * Build the complete GSTR-1 aggregate.
 *
 * `activeBills` is already filtered (period, non-cancelled) by the caller.
 * `cancelledBills` (optional) is the same period's cancelled bills, fed
 * only into Table 13 (Documents Issued) — the other tables continue to see
 * just active bills, exactly as the portal expects.
 *
 * `activeReturns` / `cancelledReturns` (both optional) feed Tables 9A
 * (CDNR — credit notes to registered) and 9B (CDNUR — to unregistered),
 * plus the credit-note row in Table 13.
 */
function buildGstr1(activeBills, {
  companyStateCode,
  cancelledBills    = [],
  activeReturns     = [],
  cancelledReturns  = [],
} = {}) {
  const cStateCode = companyStateCode || null;
  const cnDn = aggregateCnDn(activeReturns, cStateCode);
  // Surface dirty bills BEFORE aggregating so the operator can fix the
  // source data; the aggregator continues to faithfully report the dirty
  // numbers (no auto-correction — see detectBillDataIssues docs).
  const billWarnings = detectBillDataIssues(activeBills);
  return {
    period_meta: {
      invoice_count:        activeBills.length,
      cancelled_count:      cancelledBills.length,
      credit_note_count:    activeReturns.length,
      cancelled_cn_count:   cancelledReturns.length,
      company_state_code:   cStateCode,
    },
    data_quality: {
      bill_warnings:        billWarnings,
      bill_warning_count:   billWarnings.length,
    },
    b2b:   aggregateB2B(activeBills, cStateCode),
    b2cl:  aggregateB2CL(activeBills, cStateCode),
    b2cs:  aggregateB2CS(activeBills, cStateCode),
    nil:   aggregateNil(activeBills, cStateCode),
    cdnr:  cnDn.cdnr,
    cdnur: cnDn.cdnur,
    hsn:   aggregateHSN(activeBills),
    docs:  aggregateDocsIssued(activeBills, cancelledBills, activeReturns, cancelledReturns),
    classification: activeBills.map(b => ({
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
  classifyNilReason,
  normalizeUqc,
  aggregateB2B,
  aggregateB2CL,
  aggregateB2CS,
  aggregateNil,
  aggregateCnDn,
  aggregateHSN,
  aggregateDocsIssued,
  detectBillDataIssues,
  buildGstr1,
};
