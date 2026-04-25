/*
 * Deep unit tests for utils/gstr1.js. No DB. Pure math.
 *   node --test server/utils/gstr1.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  round2, stateCodeFromGstin, stateCodeFromName, placeOfSupply,
  isInterState, classify, billRateBuckets,
  reconcileBillLevelTax, bucketsForBill, isNilExemptBill,
  normalizeUqc,
  aggregateB2B, aggregateB2CL, aggregateB2CS, aggregateNil,
  aggregateCnDn, aggregateHSN, aggregateDocsIssued,
  detectBillDataIssues,
  buildGstr1,
} = require('./gstr1');

const KA = '29';
const MH = '27';

// ─── helpers ─────────────────────────────────────────────────
function item(overrides = {}) {
  return {
    hsn_code: '6109', gst_rate: 18,
    quantity: 10, unit_type: 'PCS',
    taxable_amount: 1000,
    cgst_amount: 90, sgst_amount: 90, igst_amount: 0, cess_amount: 0,
    ...overrides,
  };
}
function bill(overrides = {}) {
  const items = overrides.items || [item()];
  const taxable = items.reduce((a, i) => a + (i.taxable_amount || 0), 0);
  const cgst    = items.reduce((a, i) => a + (i.cgst_amount || 0), 0);
  const sgst    = items.reduce((a, i) => a + (i.sgst_amount || 0), 0);
  const igst    = items.reduce((a, i) => a + (i.igst_amount || 0), 0);
  return {
    bill_number: 'INV-001', bill_date: '2026-04-15',
    customer: { party_name: 'ABC', gstin: '29ABCDE1234F1Z5', state: 'Karnataka' },
    items,
    sub_total: taxable,
    cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst,
    total_amount: taxable + cgst + sgst + igst,
    ...overrides,
  };
}

// ─── round2 / state helpers ──────────────────────────────────

test('round2: standard', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-2.505), -2.51);
  assert.equal(round2(null), 0);
  assert.equal(round2('12.345'), 12.35);
});

test('stateCodeFromGstin: extracts first 2 digits', () => {
  assert.equal(stateCodeFromGstin('29ABCDE1234F1Z5'), '29');
  assert.equal(stateCodeFromGstin('07XYZAB9876A1Z0'), '07');
  assert.equal(stateCodeFromGstin(null), null);
  assert.equal(stateCodeFromGstin('X'), null);
  assert.equal(stateCodeFromGstin('AAABCDE1234F1Z5'), null);  // non-digit prefix
});

test('stateCodeFromName: case-insensitive lookup', () => {
  assert.equal(stateCodeFromName('Karnataka'), '29');
  assert.equal(stateCodeFromName('  MAHARASHTRA  '), '27');
  assert.equal(stateCodeFromName('Delhi'), '07');
  assert.equal(stateCodeFromName('Atlantis'), null);
  assert.equal(stateCodeFromName(''), null);
});

test('placeOfSupply: prefers GSTIN, falls back to state name', () => {
  assert.equal(placeOfSupply({ gstin: '27AAABB1234C1Z0', state: 'Karnataka' }), '27');
  assert.equal(placeOfSupply({ state: 'Karnataka' }), '29');
  assert.equal(placeOfSupply({}), null);
});

// ─── isInterState — derives intra/inter from STORED tax amounts ─────

test('isInterState: igst > 0 → inter, cgst/sgst > 0 → intra', () => {
  const interBill = { igst_amount: 100, cgst_amount: 0, sgst_amount: 0 };
  const intraBill = { igst_amount: 0,   cgst_amount: 50, sgst_amount: 50 };
  assert.equal(isInterState(interBill, { state: 'Karnataka' }, KA), true);
  assert.equal(isInterState(intraBill, { state: 'Maharashtra' }, KA), false);
});

test('isInterState: stored amount beats state code', () => {
  // Customer in Karnataka (same state as supplier KA) but bill stores IGST.
  // The stored amount wins — it reflects what the user actually saved.
  const bill = { igst_amount: 100, cgst_amount: 0, sgst_amount: 0 };
  assert.equal(isInterState(bill, { state: 'Karnataka' }, KA), true);
  // Reverse: customer in Maharashtra (different state) but bill stores CGST+SGST.
  const bill2 = { igst_amount: 0, cgst_amount: 50, sgst_amount: 50 };
  assert.equal(isInterState(bill2, { state: 'Maharashtra' }, KA), false);
});

test('isInterState: no tax → falls back to state-code comparison', () => {
  const nilBill = { igst_amount: 0, cgst_amount: 0, sgst_amount: 0 };
  assert.equal(isInterState(nilBill, { state: 'Maharashtra' }, KA), true);
  assert.equal(isInterState(nilBill, { state: 'Karnataka' }, KA), false);
  // Missing company state → assume intra (conservative — don't over-classify)
  assert.equal(isInterState(nilBill, { state: 'Maharashtra' }, null), false);
});

// ─── classify ────────────────────────────────────────────────

test('classify: customer with GSTIN → B2B regardless of value', () => {
  assert.equal(classify(bill({ total_amount: 100 }), { gstin: '29ABCDE1234F1Z5' }, KA), 'B2B');
  assert.equal(classify(bill({ total_amount: 10_000_000 }), { gstin: '29ABCDE1234F1Z5' }, KA), 'B2B');
});

test('classify: unregistered intra-state → B2CS regardless of value', () => {
  assert.equal(classify(bill({ total_amount: 100 }), { state: 'Karnataka' }, KA), 'B2CS');
  assert.equal(classify(bill({ total_amount: 1_000_000 }), { state: 'Karnataka' }, KA), 'B2CS');
});

test('classify: unregistered inter-state ≤ 2.5L → B2CS', () => {
  assert.equal(classify(bill({ total_amount: 250_000 }), { state: 'Maharashtra' }, KA), 'B2CS');
  assert.equal(classify(bill({ total_amount: 100_000 }), { state: 'Maharashtra' }, KA), 'B2CS');
});

test('classify: unregistered inter-state > 2.5L → B2CL', () => {
  // Inter-state = bill has IGST (not CGST+SGST). Build bills explicitly
  // that way since classification now reads stored tax amounts, not the
  // customer's declared state alone.
  const interItem = { hsn_code: '6109', gst_rate: 18, quantity: 1, unit_type: 'PCS',
                      taxable_amount: 250000, cgst_amount: 0, sgst_amount: 0,
                      igst_amount: 45000, cess_amount: 0 };
  const b1 = bill({ total_amount: 250_001, items: [interItem] });
  const b2 = bill({ total_amount: 500_000, items: [{ ...interItem, taxable_amount: 500000, igst_amount: 90000 }] });
  assert.equal(classify(b1, { state: 'Maharashtra' }, KA), 'B2CL');
  assert.equal(classify(b2, { state: 'Maharashtra' }, KA), 'B2CL');
});

test('classify: unknown state + no GSTIN → B2CS (not crashed)', () => {
  assert.equal(classify(bill({ total_amount: 100 }), { state: 'Atlantis' }, KA), 'B2CS');
  assert.equal(classify(bill({ total_amount: 100 }), {}, KA), 'B2CS');
});

// ─── billRateBuckets ──────────────────────────────────────────

test('rateBuckets: single-rate bill returns one bucket', () => {
  const b = [item({ gst_rate: 18, taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90 })];
  const out = billRateBuckets(b);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { rate: 18, taxable: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 });
});

test('rateBuckets: mixed-rate bill produces one bucket per rate, sorted desc', () => {
  const b = [
    item({ gst_rate: 18, taxable_amount: 1000, cgst_amount: 90,  sgst_amount: 90  }),
    item({ gst_rate: 5,  taxable_amount: 2000, cgst_amount: 50,  sgst_amount: 50  }),
    item({ gst_rate: 18, taxable_amount: 500,  cgst_amount: 45,  sgst_amount: 45  }),
  ];
  const out = billRateBuckets(b);
  assert.equal(out.length, 2);
  assert.equal(out[0].rate, 18);
  assert.equal(out[0].taxable, 1500);
  assert.equal(out[0].cgst, 135);
  assert.equal(out[0].sgst, 135);
  assert.equal(out[1].rate, 5);
  assert.equal(out[1].taxable, 2000);
});

test('rateBuckets: empty items → empty output', () => {
  assert.deepEqual(billRateBuckets([]), []);
  assert.deepEqual(billRateBuckets(null), []);
});

// ─── B2B aggregate ───────────────────────────────────────────

test('B2B: single bill → one group, one invoice', () => {
  const out = aggregateB2B([bill()], KA);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].invoice_count, 1);
  assert.equal(out.rows[0].invoices.length, 1);
  assert.equal(out.rows[0].gstin, '29ABCDE1234F1Z5');
  assert.equal(out.rows[0].taxable, 1000);
  assert.equal(out.rows[0].cgst, 90);
  assert.equal(out.grand.total, 1180);
});

test('B2B: same customer many bills → one group with N invoices, sorted by date', () => {
  const b1 = bill({ bill_number: 'A', bill_date: '2026-04-20' });
  const b2 = bill({ bill_number: 'B', bill_date: '2026-04-10' });
  const b3 = bill({ bill_number: 'C', bill_date: '2026-04-15' });
  const out = aggregateB2B([b1, b2, b3], KA);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].invoice_count, 3);
  assert.deepEqual(out.rows[0].invoices.map(i => i.bill_number), ['B', 'C', 'A']);
  assert.equal(out.rows[0].total, 3540);
});

test('B2B: different GSTINs → separate groups, sorted by total desc', () => {
  const out = aggregateB2B([
    bill({ bill_number: 'A', customer: { party_name: 'P1', gstin: '29AAABB1111A1Z0', state: 'Karnataka' },
           items: [item({ taxable_amount: 100, cgst_amount: 9,  sgst_amount: 9 })] }),
    bill({ bill_number: 'B', customer: { party_name: 'P2', gstin: '27AAABB2222B1Z0', state: 'Maharashtra' },
           items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 180, taxable_amount: 1000 })] }),
  ], KA);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].gstin, '27AAABB2222B1Z0');   // bigger total first
  assert.equal(out.rows[1].gstin, '29AAABB1111A1Z0');
});

test('B2B: non-registered customer is skipped (routes to B2CS)', () => {
  const out = aggregateB2B([bill({ customer: { state: 'Karnataka' } })], KA);
  assert.equal(out.rows.length, 0);
  assert.equal(out.grand.total, 0);
});

test('B2B: invoice-level amounts equal sum of rate buckets', () => {
  const b = bill({
    items: [
      item({ gst_rate: 18, taxable_amount: 1000, cgst_amount: 90,  sgst_amount: 90 }),
      item({ gst_rate: 5,  taxable_amount:  500, cgst_amount: 12.5, sgst_amount: 12.5 }),
    ],
  });
  const out = aggregateB2B([b], KA);
  const inv = out.rows[0].invoices[0];
  const bucketSum = inv.rate_rows.reduce((a, r) => ({
    taxable: a.taxable + r.taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst,
  }), { taxable: 0, cgst: 0, sgst: 0 });
  assert.equal(round2(bucketSum.taxable), inv.taxable);
  assert.equal(round2(bucketSum.cgst), inv.cgst);
  assert.equal(round2(bucketSum.sgst), inv.sgst);
});

// ─── B2CS aggregate ──────────────────────────────────────────

test('B2CS: skips registered customers', () => {
  const out = aggregateB2CS([bill()], KA);   // default bill has GSTIN
  assert.equal(out.rows.length, 0);
});

test('B2CS: aggregates unregistered intra-state to one row per rate', () => {
  const out = aggregateB2CS([
    bill({ bill_number: 'A', customer: { state: 'Karnataka' } }),
    bill({ bill_number: 'B', customer: { state: 'Karnataka' } }),
  ], KA);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].place_of_supply, '29');
  assert.equal(out.rows[0].type, 'Intra-state');
  assert.equal(out.rows[0].rate, 18);
  assert.equal(out.rows[0].taxable, 2000);
  assert.equal(out.rows[0].cgst, 180);
  assert.equal(out.rows[0].sgst, 180);
});

test('B2CS: inter-state ≤ 2.5L lands here; > 2.5L is routed to B2CL', () => {
  const small = bill({ bill_number: 'S', customer: { state: 'Maharashtra' },
    items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 18, taxable_amount: 100 })] });
  small.total_amount = 118;
  const big = bill({ bill_number: 'B', customer: { state: 'Maharashtra' },
    items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 50000, taxable_amount: 300000 })] });
  big.total_amount = 350000;   // > 2.5L so it's B2CL, excluded here
  const out = aggregateB2CS([small, big], KA);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].place_of_supply, '27');
  assert.equal(out.rows[0].type, 'Inter-state');
  assert.equal(out.rows[0].taxable, 100);
  assert.equal(out.rows[0].igst, 18);
});

test('B2CS: different states produce separate rows', () => {
  const out = aggregateB2CS([
    bill({ customer: { state: 'Karnataka' } }),
    bill({ customer: { state: 'Tamil Nadu' },
           items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 180, taxable_amount: 1000 })] }),
  ], KA);
  assert.equal(out.rows.length, 2);
});

// ─── HSN aggregate ───────────────────────────────────────────

test('HSN: one HSN, one rate → single row', () => {
  const out = aggregateHSN([bill()]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].hsn_code, '6109');
  assert.equal(out.rows[0].rate, 18);
  // Unit is now normalised to GSTN UQC code (was 'PCS' before normalizeUqc)
  assert.equal(out.rows[0].unit, 'PCS-PIECES');
  assert.equal(out.rows[0].quantity, 10);
  assert.equal(out.rows[0].taxable, 1000);
});

test('HSN: same HSN+rate across multiple bills → summed', () => {
  const out = aggregateHSN([
    bill({ items: [item({ quantity: 10, taxable_amount: 1000 })] }),
    bill({ items: [item({ quantity: 15, taxable_amount: 2000, cgst_amount: 180, sgst_amount: 180 })] }),
  ]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].quantity, 25);
  assert.equal(out.rows[0].taxable, 3000);
  assert.equal(out.rows[0].cgst, 270);
  assert.equal(out.rows[0].sgst, 270);
});

test('HSN: different HSN or rate or unit → separate rows', () => {
  const out = aggregateHSN([bill({ items: [
    item({ hsn_code: '6109', gst_rate: 18 }),
    item({ hsn_code: '6207', gst_rate: 18 }),
    item({ hsn_code: '6109', gst_rate: 5  }),
    item({ hsn_code: '6109', gst_rate: 18, unit_type: 'KG' }),
  ] })]);
  assert.equal(out.rows.length, 4);
});

test('HSN: missing HSN code → item is skipped', () => {
  const out = aggregateHSN([bill({ items: [
    item({ hsn_code: '' }),
    item({ hsn_code: null }),
    item({ hsn_code: '6109' }),
  ] })]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].hsn_code, '6109');
});

test('HSN: total invariant — sum of row.total matches grand', () => {
  const out = aggregateHSN([
    bill({ items: [item({ hsn_code: '6109', taxable_amount: 500 })] }),
    bill({ items: [item({ hsn_code: '6207', taxable_amount: 800,
                          cgst_amount: 72, sgst_amount: 72 })] }),
  ]);
  const rowSum = out.rows.reduce((a, r) => a + r.total, 0);
  assert.equal(round2(rowSum), out.grand.total);
});

// ─── buildGstr1 end-to-end invariants ─────────────────────────

test('buildGstr1: everything routed into exactly one of the sections', () => {
  const bills = [
    bill({ bill_number: 'B1' }),                                           // B2B
    bill({ bill_number: 'B2', customer: { state: 'Karnataka' } }),         // B2CS intra
    bill({ bill_number: 'B3', customer: { state: 'Maharashtra' },
           items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 50000, taxable_amount: 300000 })],
           total_amount: 350000 }),                                        // B2CL (excluded)
    bill({ bill_number: 'B4', customer: { state: 'Maharashtra' },
           items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 18, taxable_amount: 100 })],
           total_amount: 118 }),                                           // B2CS inter
  ];
  const out = buildGstr1(bills, { companyStateCode: KA });
  const buckets = out.classification.reduce((m, c) => { m[c.bucket] = (m[c.bucket] || 0) + 1; return m; }, {});
  assert.equal(buckets.B2B,  1);
  assert.equal(buckets.B2CS, 2);
  assert.equal(buckets.B2CL, 1);
  // B2B section includes exactly the one B2B bill
  assert.equal(out.b2b.grand.total, 1180);
  // B2CS section covers the two non-B2CL non-B2B bills
  const b2csTaxable = out.b2cs.rows.reduce((a, r) => a + r.taxable, 0);
  assert.equal(round2(b2csTaxable), 1100);   // 1000 + 100
});

test('buildGstr1: HSN grand.taxable equals sum of every item across ALL sections', () => {
  const bills = [
    bill({ items: [item({ taxable_amount: 1000 })] }),
    bill({ customer: { state: 'Karnataka' }, items: [item({ taxable_amount: 500 })] }),
  ];
  const out = buildGstr1(bills, { companyStateCode: KA });
  assert.equal(out.hsn.grand.taxable, 1500);
});

test('buildGstr1: empty input produces empty sections but no crash', () => {
  const out = buildGstr1([], { companyStateCode: KA });
  assert.equal(out.b2b.rows.length, 0);
  assert.equal(out.b2cs.rows.length, 0);
  assert.equal(out.nil.rows.length, 0);
  assert.equal(out.hsn.rows.length, 0);
  assert.equal(out.period_meta.invoice_count, 0);
});

// ─── reconcileBillLevelTax — backfill for bill-wise GST mode ───────────

/* A bill-wise invoice is saved with cgst/sgst/igst stored on the bill header
 * only — every item row has tax_amount = 0. Without reconciliation, GSTR-1
 * aggregators read the per-item amounts and emit "taxable X, tax 0" rows.
 */
test('reconcileBillLevelTax: allocates bill CGST+SGST to single-rate bucket', () => {
  const b = bill({
    items: [item({ gst_rate: 18, taxable_amount: 1000,
                   cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
    cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
  });
  const out = reconcileBillLevelTax(billRateBuckets(b.items), b);
  assert.equal(out.length, 1);
  assert.equal(out[0].cgst, 90);
  assert.equal(out[0].sgst, 90);
  assert.equal(out[0].igst, 0);
});

test('reconcileBillLevelTax: allocates bill IGST to single-rate inter-state bucket', () => {
  const b = bill({
    items: [item({ gst_rate: 18, taxable_amount: 1000,
                   cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 180,
  });
  const out = reconcileBillLevelTax(billRateBuckets(b.items), b);
  assert.equal(out[0].igst, 180);
  assert.equal(out[0].cgst, 0);
});

/* Key fix for mixed-rate bills. A bill with 500@18% and 500@0% and bill
 * CGST+SGST of 45+45 should put ALL the tax on the 18% bucket (its tax-
 * base is 9000; the 0% bucket's is 0). Simple pro-rata-by-taxable would
 * split it 45-45 between both buckets, smearing tax onto nil-rated items.
 */
test('reconcileBillLevelTax: mixed rates allocate by tax-base, 0% bucket stays zero', () => {
  const b = bill({
    items: [
      item({ gst_rate: 18, taxable_amount: 500, cgst_amount: 0, sgst_amount: 0 }),
      item({ gst_rate:  0, taxable_amount: 500, cgst_amount: 0, sgst_amount: 0 }),
    ],
    cgst_amount: 45, sgst_amount: 45, igst_amount: 0,
  });
  const out = reconcileBillLevelTax(billRateBuckets(b.items), b);
  const r18 = out.find(r => r.rate === 18);
  const r0  = out.find(r => r.rate === 0);
  assert.equal(r18.cgst, 45);
  assert.equal(r18.sgst, 45);
  assert.equal(r0.cgst, 0);
  assert.equal(r0.sgst, 0);
});

test('reconcileBillLevelTax: two non-zero rates split pro-rata by tax-base', () => {
  // tax-base weights: 1000*18=18000 and 2000*5=10000; total 28000.
  // bill cgst = 140, split ≈ 90 : 50.
  const b = bill({
    items: [
      item({ gst_rate: 18, taxable_amount: 1000, cgst_amount: 0, sgst_amount: 0 }),
      item({ gst_rate:  5, taxable_amount: 2000, cgst_amount: 0, sgst_amount: 0 }),
    ],
    cgst_amount: 140, sgst_amount: 140, igst_amount: 0,
  });
  const out = reconcileBillLevelTax(billRateBuckets(b.items), b);
  const r18 = out.find(r => r.rate === 18);
  const r5  = out.find(r => r.rate === 5);
  // Last bucket (sorted desc by rate so 5 is last) absorbs the remainder.
  assert.equal(round2(r18.cgst + r5.cgst), 140);
  assert.equal(round2(r18.sgst + r5.sgst), 140);
  assert.ok(r18.cgst > r5.cgst, '18% bucket should get the larger share');
});

test('reconcileBillLevelTax: item-level tax already populated → passthrough', () => {
  const b = bill({
    items: [item({ gst_rate: 18, taxable_amount: 1000,
                   cgst_amount: 90, sgst_amount: 90, igst_amount: 0 })],
    cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
  });
  const buckets = billRateBuckets(b.items);
  const out = reconcileBillLevelTax(buckets, b);
  assert.deepEqual(out, buckets);
});

test('reconcileBillLevelTax: no tax at any level → passthrough (nil-rated bill)', () => {
  const b = bill({
    items: [item({ gst_rate: 0, taxable_amount: 1000,
                   cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  const buckets = billRateBuckets(b.items);
  const out = reconcileBillLevelTax(buckets, b);
  assert.deepEqual(out, buckets);
});

test('reconcileBillLevelTax: empty/null buckets → empty array (no crash)', () => {
  assert.deepEqual(reconcileBillLevelTax([], {}), []);
  assert.deepEqual(reconcileBillLevelTax(null, {}), []);
});

// ─── isNilExemptBill ──────────────────────────────────────────────────

test('isNilExemptBill: zero tax at both levels → true', () => {
  const b = bill({
    items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  assert.equal(isNilExemptBill(b), true);
});

test('isNilExemptBill: tax at bill level → false', () => {
  const b = bill({
    items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
    cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
  });
  assert.equal(isNilExemptBill(b), false);
});

test('isNilExemptBill: tax at item level → false', () => {
  const b = bill({ items: [item({ cgst_amount: 90, sgst_amount: 90 })] });
  b.cgst_amount = 0; b.sgst_amount = 0; b.igst_amount = 0;
  assert.equal(isNilExemptBill(b), false);
});

// ─── B2B with bill-wise reconciliation ─────────────────────────────────

test('B2B: bill-wise intra-state invoice shows CGST+SGST split (not zeros)', () => {
  // The bug the user reported: Intra-state row exports all 0/0/0 because
  // item-level tax was never populated in bill-wise mode. Reconciliation
  // should fill it in from the header.
  const b = bill({
    bill_number: 'INV-0075',
    items: [
      item({ gst_rate: 18, taxable_amount: 13193.1, cgst_amount: 0, sgst_amount: 0 }),
      item({ gst_rate: 12, taxable_amount: 163605,  cgst_amount: 0, sgst_amount: 0 }),
      item({ gst_rate:  5, taxable_amount: 1226.47, cgst_amount: 0, sgst_amount: 0 }),
    ],
    cgst_amount: 10102.13, sgst_amount: 10102.13, igst_amount: 0,
  });
  const out = aggregateB2B([b], KA);
  const inv = out.rows[0].invoices[0];
  assert.equal(inv.invoice_type, 'Intra-state');
  assert.equal(inv.igst, 0);
  assert.equal(round2(inv.cgst + inv.sgst), round2(10102.13 + 10102.13));
  // Every rate bucket got a non-zero split
  inv.rate_rows.forEach(r => {
    assert.ok(r.cgst > 0, `rate ${r.rate}% should have cgst > 0`);
    assert.ok(r.sgst > 0, `rate ${r.rate}% should have sgst > 0`);
  });
});

test('B2B: bill-wise inter-state invoice shows IGST (not zeros)', () => {
  const b = bill({
    customer: { party_name: 'P', gstin: '27AAABB1111A1Z0', state: 'Maharashtra' },
    items: [item({ gst_rate: 18, taxable_amount: 1000, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 180,
  });
  const out = aggregateB2B([b], KA);
  const inv = out.rows[0].invoices[0];
  assert.equal(inv.invoice_type, 'Inter-state');
  assert.equal(inv.igst, 180);
  assert.equal(inv.cgst, 0);
  assert.equal(inv.sgst, 0);
});

test('B2B: zero-tax B2B invoice is excluded from Table 4A', () => {
  const b = bill({
    items: [item({ gst_rate: 0, taxable_amount: 1000, cgst_amount: 0, sgst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  const out = aggregateB2B([b], KA);
  assert.equal(out.rows.length, 0);
  assert.equal(out.grand.total, 0);
});

// ─── aggregateNil — Table 8 ────────────────────────────────────────────

test('aggregateNil: registered + intra-state zero-tax bill lands in Registered/Intra', () => {
  const b = bill({
    items: [item({ gst_rate: 0, taxable_amount: 1000, cgst_amount: 0, sgst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  const out = aggregateNil([b], KA);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].supply_type, 'Registered');
  assert.equal(out.rows[0].state_type, 'Intra-state');
  assert.equal(out.rows[0].taxable, 1000);
  assert.equal(out.invoices.length, 1);
  assert.equal(out.grand.taxable, 1000);
});

test('aggregateNil: unregistered + inter-state zero-tax bill', () => {
  const b = bill({
    customer: { state: 'Maharashtra' },
    items: [item({ gst_rate: 0, taxable_amount: 500, cgst_amount: 0, sgst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  const out = aggregateNil([b], KA);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].supply_type, 'Unregistered');
  assert.equal(out.rows[0].state_type, 'Inter-state');
});

test('aggregateNil: mix across all four buckets', () => {
  const bills = [
    bill({ bill_number: 'R1', customer: { party_name: 'A', gstin: '29AAABB1111A1Z0', state: 'Karnataka' },
           items: [item({ gst_rate: 0, taxable_amount: 100, cgst_amount: 0, sgst_amount: 0 })],
           cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }),
    bill({ bill_number: 'R2', customer: { party_name: 'B', gstin: '27AAABB2222A1Z0', state: 'Maharashtra' },
           items: [item({ gst_rate: 0, taxable_amount: 200, cgst_amount: 0, sgst_amount: 0 })],
           cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }),
    bill({ bill_number: 'U1', customer: { state: 'Karnataka' },
           items: [item({ gst_rate: 0, taxable_amount: 300, cgst_amount: 0, sgst_amount: 0 })],
           cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }),
    bill({ bill_number: 'U2', customer: { state: 'Maharashtra' },
           items: [item({ gst_rate: 0, taxable_amount: 400, cgst_amount: 0, sgst_amount: 0 })],
           cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }),
  ];
  const out = aggregateNil(bills, KA);
  assert.equal(out.rows.length, 4);
  assert.equal(out.grand.taxable, 1000);
  assert.equal(out.invoices.length, 4);
});

test('aggregateNil: taxed bills are skipped', () => {
  const out = aggregateNil([bill()], KA);   // default has CGST/SGST
  assert.equal(out.rows.length, 0);
  assert.equal(out.invoices.length, 0);
});

// ─── end-to-end: classification now recognises NIL ─────────────────────

test('classify: zero-tax bill with GSTIN → NIL (not B2B)', () => {
  const b = bill({
    items: [item({ gst_rate: 0, taxable_amount: 1000, cgst_amount: 0, sgst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  assert.equal(classify(b, { gstin: '29ABCDE1234F1Z5' }, KA), 'NIL');
});

test('buildGstr1: nil invoice excluded from B2B totals, included in nil grand', () => {
  const taxed = bill({ bill_number: 'T1' });  // default bill() has tax at item level
  const nilB = bill({
    bill_number: 'N1',
    items: [item({ gst_rate: 0, taxable_amount: 500, cgst_amount: 0, sgst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  const out = buildGstr1([taxed, nilB], { companyStateCode: KA });
  assert.equal(out.b2b.rows.length, 1);
  assert.equal(out.b2b.grand.taxable, 1000);   // only the taxed bill's 1000
  assert.equal(out.nil.grand.taxable, 500);
  assert.equal(out.classification.find(c => c.bill_number === 'N1').bucket, 'NIL');
});

// ─── normalizeUqc ─────────────────────────────────────────────

test('normalizeUqc: known units map to GSTN codes', () => {
  assert.equal(normalizeUqc('meter'),  'MTR-METRES');
  assert.equal(normalizeUqc('METER'),  'MTR-METRES');
  assert.equal(normalizeUqc('  Mtr '), 'MTR-METRES');
  assert.equal(normalizeUqc('BOX'),    'BOX-BOX');
  assert.equal(normalizeUqc('dozen'),  'DZN-DOZENS');
  assert.equal(normalizeUqc('pcs'),    'PCS-PIECES');
  assert.equal(normalizeUqc('PIECES'), 'PCS-PIECES');
  assert.equal(normalizeUqc('kg'),     'KGS-KILOGRAMS');
  assert.equal(normalizeUqc('LITRE'),  'LTR-LITRES');
});

test('normalizeUqc: unknown unit → OTH-OTHERS', () => {
  assert.equal(normalizeUqc('WIDGETS'), 'OTH-OTHERS');
  assert.equal(normalizeUqc('foo'),     'OTH-OTHERS');
});

test('normalizeUqc: empty/null defaults to PCS-PIECES', () => {
  // Preserves the pre-helper aggregateHSN default ('PCS') so existing
  // unit-less items continue to land in the same bucket.
  assert.equal(normalizeUqc(null),      'PCS-PIECES');
  assert.equal(normalizeUqc(undefined), 'PCS-PIECES');
  assert.equal(normalizeUqc(''),        'PCS-PIECES');
  assert.equal(normalizeUqc('   '),     'PCS-PIECES');
});

test('aggregateHSN: variant unit strings collapse into one row', () => {
  // Two items at the same HSN+rate but with different free-text units
  // must converge to a single row keyed by the GSTN UQC code.
  const b1 = bill({ items: [item({ unit_type: 'meter', taxable_amount: 100, cgst_amount: 9, sgst_amount: 9 })] });
  const b2 = bill({ bill_number: 'INV-002',
    items: [item({ unit_type: 'METER', taxable_amount: 200, cgst_amount: 18, sgst_amount: 18 })],
  });
  const { rows } = aggregateHSN([b1, b2]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unit, 'MTR-METRES');
  assert.equal(rows[0].taxable, 300);
  assert.equal(rows[0].quantity, 20);
});

// ─── aggregateB2CL (Table 5A) ─────────────────────────────────

// Helper: an unregistered customer in a different state from KA
const uregCust = { party_name: 'Cash Sale', gstin: '', state: 'Maharashtra' };

test('aggregateB2CL: includes only unregistered + inter-state + > 250000', () => {
  // Build 4 bills, one of each disqualifier
  const bills = [
    // (a) registered → goes to B2B, not B2CL
    bill({ bill_number: 'A',
      customer: { party_name: 'X', gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' },
      items: [item({ taxable_amount: 300000, cgst_amount: 0, sgst_amount: 0, igst_amount: 54000 })],
      cgst_amount: 0, sgst_amount: 0, igst_amount: 54000,
    }),
    // (b) unregistered intra-state → B2CS
    bill({ bill_number: 'B',
      customer: { ...uregCust, state: 'Karnataka' },
      items: [item({ taxable_amount: 300000, cgst_amount: 27000, sgst_amount: 27000, igst_amount: 0 })],
      cgst_amount: 27000, sgst_amount: 27000, igst_amount: 0,
    }),
    // (c) unregistered inter-state ≤ 2.5L → B2CS
    bill({ bill_number: 'C',
      customer: uregCust,
      items: [item({ taxable_amount: 200000, cgst_amount: 0, sgst_amount: 0, igst_amount: 36000 })],
      cgst_amount: 0, sgst_amount: 0, igst_amount: 36000,
    }),
    // (d) qualifies → B2CL
    bill({ bill_number: 'D',
      customer: uregCust,
      items: [item({ taxable_amount: 300000, cgst_amount: 0, sgst_amount: 0, igst_amount: 54000 })],
      cgst_amount: 0, sgst_amount: 0, igst_amount: 54000,
    }),
  ];
  const { rows, invoice_count } = aggregateB2CL(bills, KA);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bill_number, 'D');
  assert.equal(invoice_count, 1);
});

test('aggregateB2CL: nil-tax bill > 2.5L still goes to Table 8, not B2CL', () => {
  const nil = bill({ bill_number: 'NILBIG',
    customer: uregCust,
    items: [item({ taxable_amount: 300000, gst_rate: 0,
                   cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  const { rows } = aggregateB2CL([nil], KA);
  assert.equal(rows.length, 0);
});

test('aggregateB2CL: multi-rate bill emits one row per rate', () => {
  const mixed = bill({ bill_number: 'MIX',
    customer: uregCust,
    items: [
      item({ gst_rate: 18, taxable_amount: 200000,
             cgst_amount: 0, sgst_amount: 0, igst_amount: 36000 }),
      item({ gst_rate: 12, taxable_amount: 100000,
             cgst_amount: 0, sgst_amount: 0, igst_amount: 12000 }),
    ],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 48000,
  });
  const { rows, invoice_count } = aggregateB2CL([mixed], KA);
  assert.equal(rows.length, 2);
  assert.equal(invoice_count, 1);                              // distinct bills
  assert.deepEqual([...rows].map(r => r.rate).sort(), [12, 18]);
  // invoice_value repeats across rate rows (portal-expected shape)
  assert.equal(rows[0].invoice_value, rows[1].invoice_value);
  // Sum of per-row taxable matches the bill's total taxable
  const totTax = rows.reduce((a, r) => a + r.taxable, 0);
  assert.equal(round2(totTax), 300000);
});

test('aggregateB2CL: grand total invariant — taxable + igst sums match rows', () => {
  const bills = [
    bill({ bill_number: 'D1',
      customer: uregCust,
      items: [item({ taxable_amount: 280000, cgst_amount: 0, sgst_amount: 0, igst_amount: 50400 })],
      cgst_amount: 0, sgst_amount: 0, igst_amount: 50400,
    }),
    bill({ bill_number: 'D2',
      customer: { ...uregCust, party_name: 'Y' },
      items: [item({ taxable_amount: 350000, cgst_amount: 0, sgst_amount: 0, igst_amount: 63000 })],
      cgst_amount: 0, sgst_amount: 0, igst_amount: 63000,
    }),
  ];
  const { rows, grand } = aggregateB2CL(bills, KA);
  const sumTax  = rows.reduce((a, r) => a + r.taxable, 0);
  const sumIgst = rows.reduce((a, r) => a + r.igst,    0);
  assert.equal(round2(sumTax),  grand.taxable);
  assert.equal(round2(sumIgst), grand.igst);
  assert.equal(round2(grand.taxable + grand.igst + grand.cess), grand.total);
});

// ─── aggregateDocsIssued (Table 13) ───────────────────────────

test('aggregateDocsIssued: groups by series prefix, counts cancelled separately', () => {
  const active    = [{ bill_number: 'INV-25-26-001' }, { bill_number: 'INV-25-26-002' },
                     { bill_number: 'INV-25-26-005' }];
  const cancelled = [{ bill_number: 'INV-25-26-003' }, { bill_number: 'INV-25-26-004' }];
  const { rows, grand } = aggregateDocsIssued(active, cancelled);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prefix,    'INV-25-26-');
  assert.equal(rows[0].from_no,   '1');
  assert.equal(rows[0].to_no,     '5');
  assert.equal(rows[0].total,     5);
  assert.equal(rows[0].cancelled, 2);
  assert.equal(rows[0].net,       3);
  assert.equal(grand.total, 5);
  assert.equal(grand.cancelled, 2);
  assert.equal(grand.net, 3);
});

test('aggregateDocsIssued: multiple series produce sorted rows', () => {
  const active    = [{ bill_number: 'INV-A-1' }, { bill_number: 'INV-A-2' },
                     { bill_number: 'INV-B-5' }];
  const { rows } = aggregateDocsIssued(active, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].prefix, 'INV-A-');
  assert.equal(rows[1].prefix, 'INV-B-');
});

test('aggregateDocsIssued: non-numeric bill numbers land in their own row', () => {
  const { rows } = aggregateDocsIssued(
    [{ bill_number: 'MANUAL' }],
    []
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prefix,  'MANUAL');
  assert.equal(rows[0].from_no, '—');
  assert.equal(rows[0].to_no,   '—');
  assert.equal(rows[0].total,   1);
});

test('buildGstr1: cancelled bills feed docs-issued but not B2B/B2CS/HSN', () => {
  const taxed = bill({ bill_number: 'A-1' });            // active, registered, taxed
  const cnl   = bill({ bill_number: 'A-2' });            // cancelled
  const out = buildGstr1([taxed], { companyStateCode: KA, cancelledBills: [cnl] });
  assert.equal(out.b2b.rows.length, 1);                  // cancelled NOT in B2B
  assert.equal(out.docs.rows.length, 1);
  assert.equal(out.docs.rows[0].total,     2);
  assert.equal(out.docs.rows[0].cancelled, 1);
  assert.equal(out.docs.rows[0].net,       1);
  assert.equal(out.period_meta.invoice_count,   1);
  assert.equal(out.period_meta.cancelled_count, 1);
});

// ─── aggregateCnDn (Tables 9A / 9B) ───────────────────────────

// A credit-note (sales return) shaped like the controller-mapped rows
function ret(overrides = {}) {
  const items = overrides.items || [
    { gst_rate: 18, taxable_amount: 1000,
      cgst_amount: 90, sgst_amount: 90, igst_amount: 0, cess_amount: 0 },
  ];
  const cgst = items.reduce((a, i) => a + (i.cgst_amount || 0), 0);
  const sgst = items.reduce((a, i) => a + (i.sgst_amount || 0), 0);
  const igst = items.reduce((a, i) => a + (i.igst_amount || 0), 0);
  const tax  = items.reduce((a, i) => a + (i.taxable_amount || 0), 0);
  return {
    return_id: 1, return_number: 'CN-001', return_date: '2026-04-20',
    reference_bill_number: 'INV-001', reference_bill_date: '2026-04-15',
    customer: { party_name: 'ABC', gstin: '29ABCDE1234F1Z5', state: 'Karnataka' },
    items,
    cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst, cess_amount: 0,
    total_amount: tax + cgst + sgst + igst,
    ...overrides,
  };
}

test('aggregateCnDn: registered customer → CDNR (9A), unregistered → CDNUR (9B)', () => {
  const reg = ret({ return_number: 'CN-A',
    customer: { party_name: 'Reg Co', gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' },
    items: [{ gst_rate: 18, taxable_amount: 1000, cgst_amount: 0, sgst_amount: 0, igst_amount: 180 }],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 180,
  });
  const ureg = ret({ return_number: 'CN-B',
    customer: { party_name: 'Walk-in', gstin: '', state: 'Maharashtra' },
    items: [{ gst_rate: 18, taxable_amount: 500, cgst_amount: 0, sgst_amount: 0, igst_amount: 90 }],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 90,
  });
  const { cdnr, cdnur } = aggregateCnDn([reg, ureg], KA);
  assert.equal(cdnr.rows.length,  1);
  assert.equal(cdnur.rows.length, 1);
  assert.equal(cdnr.rows[0].note_number,  'CN-A');
  assert.equal(cdnur.rows[0].note_number, 'CN-B');
  assert.equal(cdnr.rows[0].note_type,    'C');                  // Credit
  assert.equal(cdnr.rows[0].original_invoice_number, 'INV-001');
  assert.equal(cdnur.rows[0].ur_type,     'B2CL');               // inter-state
});

test('aggregateCnDn: intra-state unregistered marks ur_type=B2C (manual netting flag)', () => {
  const intraUreg = ret({ return_number: 'CN-INTRA',
    customer: { party_name: 'X', gstin: '', state: 'Karnataka' },
    items: [{ gst_rate: 18, taxable_amount: 200, cgst_amount: 18, sgst_amount: 18, igst_amount: 0 }],
    cgst_amount: 18, sgst_amount: 18, igst_amount: 0,
  });
  const { cdnur } = aggregateCnDn([intraUreg], KA);
  assert.equal(cdnur.rows.length, 1);
  assert.equal(cdnur.rows[0].ur_type, 'B2C');
});

test('aggregateCnDn: multi-rate note splits into one row per rate', () => {
  const mixed = ret({ return_number: 'CN-MIX',
    items: [
      { gst_rate: 18, taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0 },
      { gst_rate:  5, taxable_amount: 500,  cgst_amount: 12.5, sgst_amount: 12.5, igst_amount: 0 },
    ],
    cgst_amount: 102.5, sgst_amount: 102.5, igst_amount: 0,
  });
  const { cdnr } = aggregateCnDn([mixed], KA);
  assert.equal(cdnr.rows.length, 2);
  assert.deepEqual(cdnr.rows.map(r => r.rate).sort((a, b) => a - b), [5, 18]);
  // note_value (= return total) repeats across rows
  assert.equal(cdnr.rows[0].note_value, cdnr.rows[1].note_value);
});

test('aggregateCnDn: grand totals sum from row level', () => {
  const reg1 = ret({ return_number: 'CN-A',
    customer: { party_name: 'X', gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' },
    items: [{ gst_rate: 18, taxable_amount: 1000, cgst_amount: 0, sgst_amount: 0, igst_amount: 180 }],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 180,
  });
  const reg2 = ret({ return_number: 'CN-B',
    customer: { party_name: 'Y', gstin: '29ABCDE1234F1Z5', state: 'Karnataka' },
    items: [{ gst_rate: 12, taxable_amount: 500, cgst_amount: 30, sgst_amount: 30, igst_amount: 0 }],
    cgst_amount: 30, sgst_amount: 30, igst_amount: 0,
  });
  const { cdnr } = aggregateCnDn([reg1, reg2], KA);
  const sumTax  = cdnr.rows.reduce((a, r) => a + r.taxable, 0);
  const sumIgst = cdnr.rows.reduce((a, r) => a + r.igst, 0);
  assert.equal(round2(sumTax),  cdnr.grand.taxable);
  assert.equal(round2(sumIgst), cdnr.grand.igst);
  assert.equal(cdnr.note_count, 2);
});

test('aggregateCnDn: empty-items return does NOT inflate note_count', () => {
  // Defect found in deep audit: seenCdnr.add ran before the bucket loop,
  // so a return with no rate buckets still bumped note_count from 0 to 1.
  const empty = ret({ return_number: 'CN-EMPTY',
    items: [],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  const { cdnr } = aggregateCnDn([empty], KA);
  assert.equal(cdnr.rows.length, 0);
  assert.equal(cdnr.note_count, 0);   // was 1 before the fix
});

test('aggregateDocsIssued: pure-numeric bill numbers get a real series label', () => {
  // Defect found in deep audit: '001' matched the regex with empty prefix
  // and fell through the (none) fallback. Now surfaces as '(numeric)'.
  const { rows } = aggregateDocsIssued(
    [{ bill_number: '001' }, { bill_number: '002' }],
    []
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prefix, '(numeric)');
  assert.equal(rows[0].from_no, '1');
  assert.equal(rows[0].to_no,   '2');
  assert.equal(rows[0].total,   2);
});

test('detectBillDataIssues: flags bills where items+tax > total beyond ₹1', () => {
  const cleanBill = bill({ bill_number: 'CLEAN' });
  // Deliberately corrupt: total understates by ₹500 (operator scenario:
  // bill-level discount applied to total but not to per-item taxable)
  const dirtyBill = bill({ bill_number: 'DIRTY',
    items: [item({ taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90 })],
    cgst_amount: 90, sgst_amount: 90,
    total_amount: 680,    // should be 1180; understates by 500
  });
  const warnings = detectBillDataIssues([cleanBill, dirtyBill]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].bill_number, 'DIRTY');
  assert.equal(warnings[0].issue, 'taxable_overstated');
  assert.equal(warnings[0].over_by, 500);
  assert.equal(warnings[0].items_taxable_sum, 1000);
  assert.equal(warnings[0].header_tax_sum, 180);
  assert.equal(warnings[0].bill_total, 680);
});

test('detectBillDataIssues: ₹1 round-off slop is tolerated', () => {
  // A bill that's off by exactly ₹1 should NOT trigger a warning — that's
  // benign rounding. Anything > ₹1 is real.
  const slop = bill({ bill_number: 'SLOP',
    items: [item({ taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90 })],
    cgst_amount: 90, sgst_amount: 90,
    total_amount: 1179,    // off by 1
  });
  assert.equal(detectBillDataIssues([slop]).length, 0);

  const justOver = bill({ bill_number: 'OVER',
    items: [item({ taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90 })],
    cgst_amount: 90, sgst_amount: 90,
    total_amount: 1178,    // off by 2 — should warn
  });
  assert.equal(detectBillDataIssues([justOver]).length, 1);
});

test('detectBillDataIssues: warnings sorted worst-first', () => {
  const small = bill({ bill_number: 'SMALL',
    items: [item({ taxable_amount: 100, cgst_amount: 9, sgst_amount: 9 })],
    cgst_amount: 9, sgst_amount: 9, total_amount: 110,   // over by 8
  });
  const big = bill({ bill_number: 'BIG',
    items: [item({ taxable_amount: 10000, cgst_amount: 900, sgst_amount: 900 })],
    cgst_amount: 900, sgst_amount: 900, total_amount: 10800,   // over by 1000
  });
  const warnings = detectBillDataIssues([small, big]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].bill_number, 'BIG');     // worst first
  assert.equal(warnings[1].bill_number, 'SMALL');
});

test('buildGstr1: data_quality.bill_warnings exposed at top level', () => {
  const cleanBill = bill({ bill_number: 'CLEAN' });
  const dirtyBill = bill({ bill_number: 'DIRTY',
    items: [item({ taxable_amount: 5000, cgst_amount: 450, sgst_amount: 450 })],
    cgst_amount: 450, sgst_amount: 450,
    total_amount: 4000,    // off by 1900
  });
  const out = buildGstr1([cleanBill, dirtyBill], { companyStateCode: KA });
  assert.equal(out.data_quality.bill_warning_count, 1);
  assert.equal(out.data_quality.bill_warnings[0].bill_number, 'DIRTY');
});

test('buildGstr1: returns flow into cdnr/cdnur and into docs-issued CN row', () => {
  const billA = bill({ bill_number: 'INV-A' });
  const cnReg = ret({ return_number: 'CN-A' });
  const out = buildGstr1([billA], {
    companyStateCode: KA,
    activeReturns: [cnReg],
  });
  assert.equal(out.cdnr.rows.length, 1);
  assert.equal(out.cdnur.rows.length, 0);
  assert.equal(out.period_meta.credit_note_count, 1);
  // Docs Issued now has TWO rows: invoices + credit notes
  assert.equal(out.docs.rows.length, 2);
  const cnRow  = out.docs.rows.find(r => r.nature === 'Credit Notes');
  const invRow = out.docs.rows.find(r => r.nature === 'Invoices for outward supply');
  assert.equal(cnRow.total, 1);
  assert.equal(invRow.total, 1);
});
