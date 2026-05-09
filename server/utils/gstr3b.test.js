/*
 * Unit tests for gstr3b.js. Pure math — no DB.
 *   node --test server/utils/gstr3b.test.js
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const {
  summarizeOutward, summarizeInterStateUnreg, summarizeITC,
  summarizePayment, buildGstr3b,
} = require('./gstr3b');
const { round2 } = require('./gstr1');

const KA = '29';
const MH = '27';

// ─── helpers (mirror gstr1.test.js shape) ────────────────────────

function item(o = {}) {
  return {
    hsn_code: '6109', gst_rate: 18,
    quantity: 10, unit_type: 'PCS',
    taxable_amount: 1000,
    cgst_amount: 90, sgst_amount: 90, igst_amount: 0, cess_amount: 0,
    ...o,
  };
}
function bill(o = {}) {
  const items = o.items || [item()];
  const tax  = items.reduce((a, i) => a + (i.taxable_amount || 0), 0);
  const cgst = items.reduce((a, i) => a + (i.cgst_amount || 0), 0);
  const sgst = items.reduce((a, i) => a + (i.sgst_amount || 0), 0);
  const igst = items.reduce((a, i) => a + (i.igst_amount || 0), 0);
  return {
    bill_number: 'INV-001', bill_date: '2026-04-15',
    customer: { party_name: 'ABC', gstin: '29ABCDE1234F1Z5', state: 'Karnataka' },
    items,
    cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst, cess_amount: 0,
    sub_total: tax,
    total_amount: tax + cgst + sgst + igst,
    ...o,
  };
}
function ret(o = {}) {
  return { ...bill(o), return_number: o.return_number || 'CN-001' };
}
function purchase(o = {}) {
  const items = o.items || [item()];
  const tax  = items.reduce((a, i) => a + (i.taxable_amount || 0), 0);
  const cgst = items.reduce((a, i) => a + (i.cgst_amount || 0), 0);
  const sgst = items.reduce((a, i) => a + (i.sgst_amount || 0), 0);
  const igst = items.reduce((a, i) => a + (i.igst_amount || 0), 0);
  return {
    purchase_bill_id: 1,
    bill_date: '2026-04-15',
    is_cancelled: false,
    supplier: { gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' },
    items,
    cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst, cess_amount: 0,
    total_amount: tax + cgst + sgst + igst,
    ...o,
  };
}

// ─── 3.1 outward ─────────────────────────────────────────────────

test('summarizeOutward: taxable bill lands in (a)', () => {
  const out = summarizeOutward([bill()], [], KA);
  assert.equal(out.taxable_outward.taxable, 1000);
  assert.equal(out.taxable_outward.cgst,    90);
  assert.equal(out.taxable_outward.sgst,    90);
  assert.equal(out.nil_exempt.taxable,      0);
});

test('summarizeOutward: nil-rated bill lands in (c)', () => {
  const nil = bill({ bill_number: 'NIL-1',
    items: [item({ gst_rate: 0, taxable_amount: 500,
                   cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
  });
  const out = summarizeOutward([nil], [], KA);
  assert.equal(out.taxable_outward.taxable, 0);
  assert.equal(out.nil_exempt.taxable, 500);
});

test('summarizeOutward: credit notes are NETTED from (a)', () => {
  // 1 sale of 1000 + 90 CGST + 90 SGST, then 1 CN of 200 + 18 + 18
  const sale = bill({ bill_number: 'INV-1' });
  const cn   = ret({ return_number: 'CN-1',
    items: [item({ taxable_amount: 200, cgst_amount: 18, sgst_amount: 18 })],
    cgst_amount: 18, sgst_amount: 18,
  });
  const out = summarizeOutward([sale], [cn], KA);
  assert.equal(out.taxable_outward.taxable, 1000 - 200);
  assert.equal(out.taxable_outward.cgst,      90 - 18);
  assert.equal(out.taxable_outward.sgst,      90 - 18);
});

test('summarizeOutward: full return → bucket can go to zero (not negative)', () => {
  const sale = bill({ bill_number: 'INV-1' });
  const fullCn = ret({ return_number: 'CN-FULL' });   // identical amount
  const out = summarizeOutward([sale], [fullCn], KA);
  assert.equal(out.taxable_outward.taxable, 0);
  assert.equal(out.taxable_outward.cgst,    0);
});

test('summarizeOutward: inter-state bill correctly fills IGST not CGST/SGST', () => {
  const inter = bill({ bill_number: 'INV-INT',
    customer: { party_name: 'X', gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' },
    items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 180 })],
    cgst_amount: 0, sgst_amount: 0, igst_amount: 180,
  });
  const out = summarizeOutward([inter], [], KA);
  assert.equal(out.taxable_outward.igst, 180);
  assert.equal(out.taxable_outward.cgst, 0);
  assert.equal(out.taxable_outward.sgst, 0);
});

// ─── 3.2 inter-state to unregistered ─────────────────────────────

test('summarizeInterStateUnreg: groups by POS, only inter+unreg+taxable', () => {
  const bills = [
    // (a) inter unreg taxable → counted
    bill({ bill_number: 'A',
      customer: { party_name: 'P', gstin: '', state: 'Maharashtra' },
      items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 180 })],
      cgst_amount: 0, sgst_amount: 0, igst_amount: 180,
    }),
    // (b) intra unreg → excluded
    bill({ bill_number: 'B',
      customer: { party_name: 'Q', gstin: '', state: 'Karnataka' },
    }),
    // (c) inter registered → excluded (not in 3.2 unregistered slice)
    bill({ bill_number: 'C',
      customer: { party_name: 'R', gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' },
      items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 180 })],
      cgst_amount: 0, sgst_amount: 0, igst_amount: 180,
    }),
    // (d) inter unreg nil → excluded (nil goes to 3.1(c), not 3.2)
    bill({ bill_number: 'D',
      customer: { party_name: 'S', gstin: '', state: 'Maharashtra' },
      items: [item({ gst_rate: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 })],
      cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
    }),
  ];
  const { unregistered } = summarizeInterStateUnreg(bills, [], KA);
  assert.equal(unregistered.length, 1);
  assert.equal(unregistered[0].place_of_supply, '27');
  assert.equal(unregistered[0].taxable, 1000);
  assert.equal(unregistered[0].igst,    180);
});

// ─── 4 ITC ───────────────────────────────────────────────────────

test('summarizeITC: sums purchase tax into (5) all_other; (1)-(4) are zero', () => {
  const p1 = purchase({ items: [item({ cgst_amount: 90, sgst_amount: 90 })] });
  const p2 = purchase({ items: [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 360, taxable_amount: 2000 })] });
  const itc = summarizeITC([p1, p2]);
  assert.equal(itc.A.all_other.cgst, 90);
  assert.equal(itc.A.all_other.sgst, 90);
  assert.equal(itc.A.all_other.igst, 360);
  // (1) (2) (3) (4) all zero (no schema flags)
  assert.equal(itc.A.import_goods.cgst, 0);
  assert.equal(itc.A.inward_rcm.igst,   0);
});

test('summarizeITC: cancelled purchases excluded', () => {
  const live   = purchase();
  const dead   = purchase({ is_cancelled: true,
    items: [item({ cgst_amount: 9000, sgst_amount: 9000 })],   // would explode totals
  });
  const itc = summarizeITC([live, dead]);
  assert.equal(itc.A.all_other.cgst, 90);
  assert.equal(itc.meta.purchase_invoice_count, 1);
});

test('summarizeITC: A_total sums across (1)-(5); B_total starts zero; C = A − B', () => {
  const p = purchase({ items: [item({ cgst_amount: 100, sgst_amount: 100, igst_amount: 50 })] });
  const itc = summarizeITC([p]);
  assert.equal(itc.A_total.cgst, 100);
  assert.equal(itc.A_total.sgst, 100);
  assert.equal(itc.A_total.igst, 50);
  assert.equal(itc.B_total.cgst, 0);
  assert.equal(itc.C_net_available.cgst, 100);
  assert.equal(itc.C_net_available.igst, 50);
});

// Audit C8 — purchase returns must be netted from ITC.
test('summarizeITC: purchase returns NET from (5) all_other', () => {
  // Bought ₹100 + ₹18 GST, returned ₹50 + ₹9 GST → net ITC = ₹9
  const p = purchase({ items: [item({ taxable_amount: 100,
    cgst_amount: 9, sgst_amount: 9, igst_amount: 0 })] });
  const pr = purchase({ items: [item({ taxable_amount: 50,
    cgst_amount: 4.5, sgst_amount: 4.5, igst_amount: 0 })] });
  const itc = summarizeITC([p], [pr]);
  assert.equal(itc.A.all_other.cgst, 4.5);
  assert.equal(itc.A.all_other.sgst, 4.5);
  assert.equal(itc.meta.purchase_return_count, 1);
  assert.equal(itc.meta.purchase_return_taxable, 50);
  // C_net_available reflects the net
  assert.equal(itc.C_net_available.cgst, 4.5);
});

test('summarizeITC: cancelled purchase returns excluded', () => {
  const p = purchase({ items: [item({ cgst_amount: 90, sgst_amount: 90 })] });
  const livePr = purchase({ items: [item({ cgst_amount: 30, sgst_amount: 30 })] });
  const deadPr = purchase({ is_cancelled: true,
    items: [item({ cgst_amount: 9999, sgst_amount: 9999 })] });
  const itc = summarizeITC([p], [livePr, deadPr]);
  assert.equal(itc.A.all_other.cgst, 60);   // 90 − 30, dead PR ignored
  assert.equal(itc.meta.purchase_return_count, 1);
});

test('summarizeITC: returns exceeding purchases clamp to zero (no negative ITC)', () => {
  // Operator returns more than purchased in this period (carry-over from
  // a prior month). Section 4(B) is the right place for that adjustment;
  // 4(A) shouldn't go negative.
  const p = purchase({ items: [item({ cgst_amount: 50, sgst_amount: 50 })] });
  const pr = purchase({ items: [item({ cgst_amount: 200, sgst_amount: 200 })] });
  const itc = summarizeITC([p], [pr]);
  assert.equal(itc.A.all_other.cgst, 0);
  assert.equal(itc.A.all_other.sgst, 0);
});

// ─── 6.1 payment ─────────────────────────────────────────────────

test('summarizePayment: ITC reduces cash payable to zero when sufficient', () => {
  const outward = { taxable_outward: { taxable: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 } };
  const itc     = { C_net_available: { igst: 0, cgst: 100, sgst: 100, cess: 0 } };
  const pay = summarizePayment(outward, itc);
  assert.equal(pay.cgst.tax_payable,   90);
  assert.equal(pay.cgst.paid_via_itc,  90);   // capped at liability
  assert.equal(pay.cgst.paid_via_cash, 0);
});

test('summarizePayment: shortfall in ITC pays remainder via cash', () => {
  const outward = { taxable_outward: { taxable: 5000, igst: 900, cgst: 0, sgst: 0, cess: 0 } };
  const itc     = { C_net_available: { igst: 600, cgst: 0, sgst: 0, cess: 0 } };
  const pay = summarizePayment(outward, itc);
  assert.equal(pay.igst.tax_payable,   900);
  assert.equal(pay.igst.paid_via_itc,  600);
  assert.equal(pay.igst.paid_via_cash, 300);
});

test('summarizePayment: ITC excess does NOT generate negative cash', () => {
  const outward = { taxable_outward: { taxable: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 } };
  const itc     = { C_net_available: { igst: 0, cgst: 500, sgst: 500, cess: 0 } };
  const pay = summarizePayment(outward, itc);
  assert.equal(pay.cgst.paid_via_cash, 0);
  assert.equal(pay.cgst.paid_via_itc,  90);   // not 500 — capped at liability
});

// ─── buildGstr3b end-to-end ──────────────────────────────────────

test('buildGstr3b: sales − returns netting flows through to (a)', () => {
  const out = buildGstr3b({
    activeBills:   [bill({ bill_number: 'INV-1' })],
    activeReturns: [ret({ return_number: 'CN-1',
      items: [item({ taxable_amount: 100, cgst_amount: 9, sgst_amount: 9 })],
      cgst_amount: 9, sgst_amount: 9,
    })],
    purchases:     [purchase()],
    companyStateCode: KA,
  });
  assert.equal(out.section_3_1.taxable_outward.taxable, 1000 - 100);
  assert.equal(out.section_3_1.taxable_outward.cgst,      90 - 9);
  assert.equal(out.section_4_itc.A.all_other.cgst, 90);
  assert.equal(out.section_6_1_payment.cgst.tax_payable, 81);
});

test('buildGstr3b: period_meta surfaces all three counts', () => {
  const out = buildGstr3b({
    activeBills:   [bill({ bill_number: 'A' }), bill({ bill_number: 'B' })],
    activeReturns: [ret({ return_number: 'CN' })],
    purchases:     [purchase(), purchase(), purchase()],
    companyStateCode: KA,
  });
  assert.equal(out.period_meta.sales_invoice_count,    2);
  assert.equal(out.period_meta.credit_note_count,      1);
  assert.equal(out.period_meta.purchase_invoice_count, 3);
  assert.equal(out.period_meta.company_state_code,     KA);
});

test('buildGstr3b: empty inputs return zeroed sections, not crash', () => {
  const out = buildGstr3b({ companyStateCode: KA });
  assert.equal(out.section_3_1.taxable_outward.taxable, 0);
  assert.equal(out.section_4_itc.A_total.cgst, 0);
  assert.equal(out.section_6_1_payment.cgst.paid_via_cash, 0);
  assert.equal(out.section_3_2.unregistered.length, 0);
});
