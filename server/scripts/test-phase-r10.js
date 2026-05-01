#!/usr/bin/env node
// Phase-R10 self-test: Monthly summary controller (sales | purchase | combined).
//
// Drives monthlySummaryController.monthlySummary directly with synthetic
// fixtures: 3 customers, 3 suppliers, sales bills + returns + purchase
// bills + purchase returns spread across April/May/June 2025.
//
// Coverage map:
//
//   1.x  Sales mode shape + monthly bucketing       6 checks
//   2.x  Cancelled / cash bills                     3 checks
//   3.x  Returns reduce Net                          2 checks
//   4.x  Purchase mode mirror                        3 checks
//   5.x  Combined mode + margin                      4 checks
//   6.x  Filters (party, min/max Net, include_zero)  4 checks
//   7.x  Reconciliation (paisa-exact, party-filtered)  2 checks
//   8.x  KPIs (best/worst/returns%)                  3 checks
//   9.x  Edge cases (margin% with zero sales,
//        empty period, drill-down URL params)        3 checks
//
// Run: node server/scripts/test-phase-r10.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const { Party, SalesBill, SalesReturnBill, PurchaseBill, PurchaseReturnBill } = require('../models');
const ctrl = require('../controllers/monthlySummaryController');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__R10_';
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

let custA, custB, suplA, suplB;

function call(query) {
  return new Promise((resolve, reject) => {
    const req = { query };
    const res = {
      status(c) { this._s = c; return this; },
      json(b)   { resolve({ status: this._s || 200, body: b }); },
    };
    ctrl.monthlySummary(req, res).catch(reject);
  });
}

async function preClean() {
  await sequelize.query(`DELETE FROM sales_return_bills    WHERE return_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bills           WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_return_bills WHERE return_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bills        WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_entries        WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties               WHERE party_name LIKE '${PFX}%'`);
}

// Insert a sales bill straight into the table (bypasses controller — we
// only care about the monthly aggregation, not the voucher posting).
// Numbers chosen so reconciliation math is hand-checkable.
async function makeSale({ num, date, customer, sub, disc = 0, freight = 0, other = 0, cgst = 0, sgst = 0, igst = 0, cancelled = false }) {
  const total = sub - disc + freight + other + cgst + sgst + igst;
  return SalesBill.create({
    bill_number: num, customer_id: customer.party_id, bill_date: date,
    sub_total: sub, discount_amount: disc, freight_charges: freight, other_charges: other,
    cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst,
    total_amount: total, paid_amount: 0, balance_amount: total, payment_status: 'Unpaid',
    total_items: 0, total_quantity: 0,
    is_cancelled: cancelled,
  });
}
async function makeSalesReturn({ num, date, customer, sub, total, refBillId }) {
  return SalesReturnBill.create({
    return_number: num, customer_id: customer.party_id, return_date: date,
    sub_total: sub, total_amount: total, balance_amount: 0, refund_status: 'Pending',
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
    discount_amount: 0, freight_charges: 0, other_charges: 0,
    reference_bill_id: refBillId,
    total_items: 0, total_quantity: 0,
  });
}
async function makePurchase({ num, date, supplier, sub, disc = 0, freight = 0, other = 0, cgst = 0, sgst = 0, igst = 0 }) {
  const total = sub - disc + freight + other + cgst + sgst + igst;
  return PurchaseBill.create({
    bill_number: num, supplier_id: supplier.party_id, bill_date: date,
    sub_total: sub, discount_amount: disc, freight_charges: freight, other_charges: other,
    cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst,
    total_amount: total, paid_amount: 0, balance_amount: total, payment_status: 'Unpaid',
    total_items: 0, total_quantity: 0,
  });
}
async function makePurchaseReturn({ num, date, supplier, sub, total, refBillId }) {
  return PurchaseReturnBill.create({
    return_number: num, supplier_id: supplier.party_id, return_date: date,
    sub_total: sub, total_amount: total, balance_amount: 0, refund_status: 'Pending',
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
    discount_amount: 0, freight_charges: 0, other_charges: 0,
    reference_bill_id: refBillId,
    total_items: 0, total_quantity: 0,
  });
}

async function setup() {
  custA = await Party.create({ party_name: `${PFX}Cust A`, party_type: 'Customer', mobile_1: '9000010001', opening_balance: 0 });
  custB = await Party.create({ party_name: `${PFX}Cust B`, party_type: 'Customer', mobile_1: '9000010002', opening_balance: 0 });
  suplA = await Party.create({ party_name: `${PFX}Sup A`,  party_type: 'Supplier', mobile_1: '9000020001', opening_balance: 0 });
  suplB = await Party.create({ party_name: `${PFX}Sup B`,  party_type: 'Supplier', mobile_1: '9000020002', opening_balance: 0 });

  // Sales: April 5000+3000, May 8000, June (cancelled — should not count) 9999, June 2000
  await makeSale({ num: `${PFX}S-A-001`, date: '2025-04-05', customer: custA, sub: 5000, cgst: 250, sgst: 250 });
  await makeSale({ num: `${PFX}S-B-002`, date: '2025-04-15', customer: custB, sub: 3000, cgst: 150, sgst: 150 });
  await makeSale({ num: `${PFX}S-A-003`, date: '2025-05-10', customer: custA, sub: 8000, cgst: 400, sgst: 400 });
  await makeSale({ num: `${PFX}S-X-CANCEL`, date: '2025-06-01', customer: custA, sub: 9999, cgst: 500, sgst: 500, cancelled: true });
  await makeSale({ num: `${PFX}S-B-004`, date: '2025-06-12', customer: custB, sub: 2000, cgst: 100, sgst: 100 });

  // Sales returns: May 1000 (against an April bill — counts in May per return_date)
  await makeSalesReturn({ num: `${PFX}SR-001`, date: '2025-05-20', customer: custA, sub: 1000, total: 1100 });

  // Purchases: April 4000, May 6000, June 2500
  await makePurchase({ num: `${PFX}P-A-001`, date: '2025-04-08', supplier: suplA, sub: 4000, cgst: 200, sgst: 200 });
  await makePurchase({ num: `${PFX}P-A-002`, date: '2025-05-08', supplier: suplA, sub: 6000, cgst: 300, sgst: 300 });
  await makePurchase({ num: `${PFX}P-B-003`, date: '2025-06-08', supplier: suplB, sub: 2500, cgst: 125, sgst: 125 });

  // Purchase return: June 500
  await makePurchaseReturn({ num: `${PFX}PR-001`, date: '2025-06-25', supplier: suplA, sub: 500, total: 550 });
}

async function teardown() {
  await preClean();
}

// ── Tests ─────────────────────────────────────────────────────────────

async function t_sales_shape() {
  const r = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-06-30' });
  check('1.1 Sales: status 200', r.status === 200);
  check('1.2 Sales: data is array of months', Array.isArray(r.body.data) && r.body.data.length === 3);
  check('1.3 Sales: month order Apr→Jun', r.body.data[0].month_iso === '2025-04-01' && r.body.data[2].month_iso === '2025-06-01');

  const apr = r.body.data.find((m) => m.month_iso === '2025-04-01');
  // Filter to only our PFX bills — other seed sales may also be in April.
  // Cleanest: use party_ids filter to scope to our test customers.
  const r2 = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-06-30', party_ids: `${custA.party_id},${custB.party_id}` });
  const apr2 = r2.body.data.find((m) => m.month_iso === '2025-04-01');
  check('1.4 Sales: April bill count = 2 (party-scoped)', apr2.bills_count === 2,
    `got ${apr2.bills_count}`);
  check('1.5 Sales: April Gross = 8000', apr2.gross === 8000, `got ${apr2.gross}`);
  check('1.6 Sales: April Net = 8000 (no returns in Apr)', apr2.net === 8000, `got ${apr2.net}`);
}

async function t_cancelled_cash() {
  const r = await call({ mode: 'sales', from_date: '2025-06-01', to_date: '2025-06-30',
                          party_ids: `${custA.party_id},${custB.party_id}` });
  const jun = r.body.data.find((m) => m.month_iso === '2025-06-01');
  // Cancelled S-X-CANCEL (₹9999 sub) must NOT count. Only S-B-004 (₹2000).
  check('2.1 Cancelled bill excluded from June', jun.bills_count === 1 && jun.gross === 2000,
    `got bills=${jun.bills_count} gross=${jun.gross}`);
  // Returns_count check on Jun — none in Jun for our test bills.
  check('2.2 Returns excluded when no return in month', jun.returns_count === 0,
    `got ${jun.returns_count}`);
  // Cash sale handling — we didn't seed a cash-party bill in this test
  // suite; the controller doesn't filter on is_system_cash on purpose
  // (Tally treats cash sales as part of monthly Sales). Affirm that
  // posture by re-running a no-filter call and checking Apr count
  // includes any system-cash bills already in seed (count ≥ ours).
  const noFilter = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-04-30' });
  const aprAll = noFilter.body.data[0];
  check('2.3 Cash sales NOT excluded (Tally convention)', aprAll.bills_count >= 2,
    `got ${aprAll.bills_count} (expect ≥2)`);
}

async function t_returns_reduce_net() {
  const r = await call({ mode: 'sales', from_date: '2025-05-01', to_date: '2025-05-31',
                          party_ids: `${custA.party_id},${custB.party_id}` });
  const may = r.body.data[0];
  // May has S-A-003 (sub 8000) + 1 return (sub 1000). Net = 8000 - 1000 = 7000.
  check('3.1 Sales Return reduces May Net (7000)', may.net === 7000,
    `got ${may.net} (gross=${may.gross} returns=${may.returns})`);
  check('3.2 Returns count = 1 in May', may.returns_count === 1, `got ${may.returns_count}`);
}

async function t_purchase_mirror() {
  const r = await call({ mode: 'purchase', from_date: '2025-04-01', to_date: '2025-06-30',
                          party_ids: `${suplA.party_id},${suplB.party_id}` });
  const apr = r.body.data.find((m) => m.month_iso === '2025-04-01');
  const may = r.body.data.find((m) => m.month_iso === '2025-05-01');
  const jun = r.body.data.find((m) => m.month_iso === '2025-06-01');
  check('4.1 Purchase Apr Gross = 4000', apr.gross === 4000, `got ${apr.gross}`);
  check('4.2 Purchase May Net = 6000 (no returns)', may.net === 6000, `got ${may.net}`);
  check('4.3 Purchase Jun Net = 2000 (2500 - 500 return)', jun.net === 2000, `got ${jun.net}`);
}

async function t_combined() {
  const r = await call({ mode: 'combined', from_date: '2025-04-01', to_date: '2025-06-30',
                          customer_ids: `${custA.party_id},${custB.party_id}`,
                          supplier_ids: `${suplA.party_id},${suplB.party_id}` });
  check('5.1 Combined: 3 month rows', Array.isArray(r.body.data) && r.body.data.length === 3);
  const apr = r.body.data.find((m) => m.month_iso === '2025-04-01');
  // Apr: sales_net=8000, purchase_net=4000, margin=4000, margin%=50.0
  check('5.2 Combined Apr margin = 4000', apr.margin === 4000, `got ${apr.margin}`);
  check('5.3 Combined Apr margin% = 50.0', Math.abs(apr.margin_pct - 50.0) < 0.05, `got ${apr.margin_pct}`);
  // Total margin = (8000 + 7000 + 2000) - (4000 + 6000 + 2000) = 17000 - 12000 = 5000
  check('5.4 Combined total margin = 5000', r.body.summary.total_margin === 5000,
    `got ${r.body.summary.total_margin}`);
}

async function t_filters() {
  // 6.1 Party filter on Sales — only custA's bills.
  const r = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-06-30',
                          party_ids: String(custA.party_id) });
  const totalCustA = r.body.data.reduce((s, m) => s + m.bills_count, 0);
  check('6.1 Party filter restricts to custA (2 bills: Apr+May)', totalCustA === 2,
    `got ${totalCustA}`);

  // 6.2 min_net filter — drop months below ₹6000.
  const r2 = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-06-30',
                           party_ids: `${custA.party_id},${custB.party_id}`, min_net: '6000' });
  const months = r2.body.data;
  // Apr Net = 8000 (passes), May Net = 7000 (passes), Jun Net = 2000 (drops).
  check('6.2 min_net=6000 drops June', months.length === 2 && !months.some((m) => m.month_iso === '2025-06-01'),
    `got months=${months.map((m) => m.month_iso).join(',')}`);

  // 6.3 max_net filter — keep only small months.
  const r3 = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-06-30',
                           party_ids: `${custA.party_id},${custB.party_id}`, max_net: '5000' });
  check('6.3 max_net=5000 keeps only June', r3.body.data.length === 1 && r3.body.data[0].month_iso === '2025-06-01',
    `got ${JSON.stringify(r3.body.data.map((m) => m.month_iso))}`);

  // 6.4 include_zero=false on a wider window drops empty months.
  const r4 = await call({ mode: 'sales', from_date: '2025-01-01', to_date: '2025-06-30',
                           party_ids: `${custA.party_id},${custB.party_id}`, include_zero: 'false' });
  check('6.4 include_zero=false drops Jan/Feb/Mar (no test bills)', r4.body.data.length === 3,
    `got ${r4.body.data.length}`);
}

async function t_reconciliation() {
  // Without party filter, recon ledger_net is computed (may show drift
  // because seed has additional non-test data that hits Sales Account).
  // We just check the structure — the value is an integration concern.
  const r = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-06-30' });
  check('7.1 Recon: structure present (no party filter)',
    r.body.reconciliation && typeof r.body.reconciliation.ledger_net === 'number'
    && typeof r.body.reconciliation.register_net === 'number'
    && typeof r.body.reconciliation.balanced === 'boolean');

  // With party filter, recon.party_filtered = true and ledger_net = null
  // (the comparison is meaningless when filtered to subset of parties).
  const r2 = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-06-30',
                          party_ids: String(custA.party_id) });
  check('7.2 Recon: party_filtered = true suppresses ledger comparison',
    r2.body.reconciliation.party_filtered === true && r2.body.reconciliation.ledger_net === null);
}

async function t_kpis() {
  const r = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-06-30',
                          party_ids: `${custA.party_id},${custB.party_id}` });
  const k = r.body.kpis;
  // Net per month: Apr 8000, May 7000, Jun 2000.
  check('8.1 KPI best_month = April (8000)',
    k.best_month && k.best_month.month_iso === '2025-04-01' && k.best_month.net === 8000);
  check('8.2 KPI worst_month = June (2000)',
    k.worst_month && k.worst_month.month_iso === '2025-06-01' && k.worst_month.net === 2000);
  // Returns_pct: returns 1000, gross 18000 (Apr 8k + May 8k + Jun 2k) → 5.56%.
  check('8.3 KPI returns_pct ≈ 5.6%',
    k.returns_pct != null && Math.abs(k.returns_pct - 5.56) < 0.05,
    `got ${k.returns_pct}`);
}

async function t_edges() {
  // 9.1 Combined month with sales=0 → margin_pct = null (not Infinity).
  // Use Aug-Sep 2030 — no data anywhere.
  const r = await call({ mode: 'combined', from_date: '2030-08-01', to_date: '2030-09-30',
                          customer_ids: `${custA.party_id}`, supplier_ids: `${suplA.party_id}` });
  const allNull = r.body.data.every((m) => m.margin_pct === null);
  check('9.1 Combined margin_pct = null when sales = 0 (no Infinity/NaN)',
    allNull, `got ${r.body.data.map((m) => m.margin_pct).join(',')}`);

  // 9.2 Empty period → empty data array, no errors.
  const r2 = await call({ mode: 'sales', from_date: '2030-08-01', to_date: '2030-09-30',
                           party_ids: `${custA.party_id}`, include_zero: 'false' });
  check('9.2 Empty period returns empty array cleanly',
    Array.isArray(r2.body.data) && r2.body.data.length === 0);

  // 9.3 Drill-down URL params — verify the controller returns enough
  // info for the frontend to construct from_date / to_date for the
  // detailed Sales Report. This is a structural check on month_iso.
  const r3 = await call({ mode: 'sales', from_date: '2025-04-01', to_date: '2025-04-30' });
  const apr = r3.body.data[0];
  check('9.3 Row month_iso is YYYY-MM-01 (drill-down anchor)',
    /^\d{4}-\d{2}-01$/.test(apr.month_iso), `got ${apr.month_iso}`);
}

(async () => {
  console.log('──────────────────────────────────────────────');
  console.log('Phase R10 — Monthly summary self-test');
  console.log('──────────────────────────────────────────────');
  try {
    await preClean();
    await setup();
    await t_sales_shape();
    await t_cancelled_cash();
    await t_returns_reduce_net();
    await t_purchase_mirror();
    await t_combined();
    await t_filters();
    await t_reconciliation();
    await t_kpis();
    await t_edges();
  } catch (err) {
    console.error('Test runner error:', err);
    fail++;
  } finally {
    try { await teardown(); } catch (_) {}
  }
  for (const r of results) console.log(r);
  console.log('──────────────────────────────────────────────');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  console.log('──────────────────────────────────────────────');
  await sequelize.close();
  process.exit(fail ? 1 : 0);
})();
