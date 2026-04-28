#!/usr/bin/env node
// Phase-R2 self-test: Cash Flow + Receivables/Payables Aging.
//
// Drives controllers directly. Tolerates pre-existing prod data via
// baseline+delta where appropriate.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const {
  Party, LedgerAccount, SystemSettings,
  SalesBill, PurchaseBill, PaymentReceipt,
} = require('../models');
const { postVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers, buildPurchaseBillVouchers, buildPaymentReceiptVouchers } = require('../services/voucherBuilders');
const finReports = require('../controllers/financialReportsController');
const reportController = require('../controllers/reportController');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__R2_';
const today = new Date().toISOString().slice(0, 10);

function callCtrl(handler, query) {
  return new Promise((resolve, reject) => {
    const req = { query };
    const res = { status(c) { this._s = c; return this; }, json(b) { resolve({ status: this._s || 200, body: b }); } };
    handler(req, res).catch(reject);
  });
}

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_number LIKE '${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
}

async function main() {
  await preClean();
  await SystemSettings.update({
    gst_enabled: true,
    financial_year_start: '2025-04-01',
    financial_year_end:   '2026-03-31',
  }, { where: { setting_id: 1 } });

  // ── Test 1: Empty period — Cash Flow ──────────────────
  const emptyCf = await callCtrl(finReports.cashFlow, { from_date: '2099-01-01', to_date: '2099-12-31' });
  check('Empty period CF: status 200', emptyCf.status === 200);
  check('Empty period CF: all sections empty',
    (emptyCf.body.sections.operating || []).length === 0
    && (emptyCf.body.sections.investing || []).length === 0
    && (emptyCf.body.sections.financing || []).length === 0);
  check('Empty period CF: net change = 0', emptyCf.body.totals.net_change === 0);
  check('Empty period CF: opening = closing', emptyCf.body.reconciliation.opening === emptyCf.body.reconciliation.closing);
  check('Empty period CF: balanced', emptyCf.body.reconciliation.balanced === true);

  // ── Build fixtures ────────────────────────────────────
  const cust = await Party.create({
    party_type: 'Customer', party_name: `${PFX}CustA`, mobile_1: '5500000001',
  });
  await cust.reload();
  const sup = await Party.create({
    party_type: 'Supplier', party_name: `${PFX}SupA`, mobile_1: '5500000002',
  });
  await sup.reload();

  // Two sales bills with different ages: one 95 days old, one 5 days old.
  const oldDate = new Date(today); oldDate.setDate(oldDate.getDate() - 95);
  const newDate = new Date(today); newDate.setDate(newDate.getDate() - 5);
  const oldDateStr = oldDate.toISOString().slice(0, 10);
  const newDateStr = newDate.toISOString().slice(0, 10);

  const t1 = await sequelize.transaction();
  const billOld = await SalesBill.create({
    bill_number: `${PFX}SAL-OLD`, bill_date: oldDateStr,
    customer_id: cust.party_id,
    sub_total: 10000, cgst_amount: 0, sgst_amount: 0,
    total_amount: 10000, balance_amount: 10000, payment_status: 'Unpaid',
    payment_method: 'Cash',
  }, { transaction: t1 });
  for (const v of await buildSalesBillVouchers(
    await SalesBill.findByPk(billOld.sales_bill_id, { include: [{ model: Party, as: 'customer' }], transaction: t1 }),
    { transaction: t1 },
  )) await postVoucher({ ...v, transaction: t1 });
  const billNew = await SalesBill.create({
    bill_number: `${PFX}SAL-NEW`, bill_date: newDateStr,
    customer_id: cust.party_id,
    sub_total: 7000, cgst_amount: 0, sgst_amount: 0,
    total_amount: 7000, balance_amount: 7000, payment_status: 'Unpaid',
    payment_method: 'Cash',
  }, { transaction: t1 });
  for (const v of await buildSalesBillVouchers(
    await SalesBill.findByPk(billNew.sales_bill_id, { include: [{ model: Party, as: 'customer' }], transaction: t1 }),
    { transaction: t1 },
  )) await postVoucher({ ...v, transaction: t1 });
  // A purchase bill 45 days old (supplier — payable)
  const midDate = new Date(today); midDate.setDate(midDate.getDate() - 45);
  const midDateStr = midDate.toISOString().slice(0, 10);
  const purBill = await PurchaseBill.create({
    bill_number: `${PFX}PUR-MID`, bill_date: midDateStr,
    supplier_id: sup.party_id,
    sub_total: 5000, cgst_amount: 0, sgst_amount: 0,
    total_amount: 5000, balance_amount: 5000, payment_status: 'Unpaid',
    payment_method: 'Cash',
  }, { transaction: t1 });
  for (const v of await buildPurchaseBillVouchers(
    await PurchaseBill.findByPk(purBill.purchase_bill_id, { include: [{ model: Party, as: 'supplier' }], transaction: t1 }),
    { transaction: t1 },
  )) await postVoucher({ ...v, transaction: t1 });
  // A receipt of ₹4,000 on `today` from cust — for cash flow.
  const rcpt = await PaymentReceipt.create({
    transaction_number: `${PFX}RCT-1`, transaction_type: 'Receipt',
    transaction_date: today, party_id: cust.party_id,
    total_amount: 4000, payment_method: 'Cash',
  }, { transaction: t1 });
  for (const v of await buildPaymentReceiptVouchers(
    await PaymentReceipt.findByPk(rcpt.transaction_id, { include: [{ model: Party, as: 'party' }], transaction: t1 }),
    { transaction: t1 },
  )) await postVoucher({ ...v, transaction: t1 });
  await t1.commit();

  // ── Test 2: Cash Flow — receipt of ₹4,000 in Operating ──
  const fyEndForCf = today;  // include today's receipt
  const cf = await callCtrl(finReports.cashFlow, { from_date: '2025-04-01', to_date: fyEndForCf });
  check('CF: status 200', cf.status === 200);
  // Operating activities should include our receipt (a contra leg from
  // Sundry Debtors classifies as Operating).
  const opEntries = cf.body.sections.operating || [];
  // entry_number is voucher-sequence, not the source transaction_number,
  // so we identify our receipt by date + +4,000 cash inflow on `today`.
  const recordedReceipt = opEntries.find((r) =>
    r.entry_date === today && Math.abs(r.cash_impact - 4000) < 0.01);
  check('CF: Operating section contains the +4,000 receipt on today',
    !!recordedReceipt, `op count=${opEntries.length}`);
  check('CF: reconciliation balanced',
    cf.body.reconciliation.balanced === true,
    `attr=${cf.body.reconciliation.attributed_change} computed=${cf.body.reconciliation.computed_change}`);
  check('CF: closing - opening = computed_change',
    Math.abs((cf.body.reconciliation.closing - cf.body.reconciliation.opening) - cf.body.reconciliation.computed_change) < 0.01);

  // ── Test 3: Aging reconciliation invariant ────────────────
  // The /api/reports/aging endpoint (single source of truth, after the
  // R2 V2 surface was removed) carries the corrected reconciliation:
  //   bill_outstanding + paid_in_bills − unallocated_receipts
  //     − returns_offset + opening_dr − opening_cr == ledger_outstanding
  // On clean books (no off-bill JVs, no allocation gap), all four
  // adjustment terms are 0 and the formula reduces to bill == ledger.
  const ra = await callCtrl(reportController.agingReport, { party_type: 'Customer' });
  check('Aging (Customer): status 200', ra.status === 200);
  check('Aging (Customer): reconciliation present', !!ra.body.reconciliation);
  const raR = ra.body.reconciliation || {};
  check('Aging (Customer): reconciliation has all six breakdown fields',
    typeof raR.bill_outstanding === 'number'
    && typeof raR.paid_in_bills === 'number'
    && typeof raR.unallocated_receipts === 'number'
    && typeof raR.returns_offset === 'number'
    && typeof raR.opening_dr === 'number'
    && typeof raR.opening_cr === 'number');
  check('Aging (Customer): expected_ledger == ledger (paisa-exact, balanced)',
    raR.balanced === true,
    `diff=${raR.difference} expected=${raR.expected_ledger_outstanding} ledger=${raR.ledger_outstanding}`);
  check('Aging (Customer): sub_group = Sundry Debtors',
    raR.sub_group === 'Sundry Debtors');

  const pa = await callCtrl(reportController.agingReport, { party_type: 'Supplier' });
  check('Aging (Supplier): status 200', pa.status === 200);
  const paR = pa.body.reconciliation || {};
  check('Aging (Supplier): expected_ledger == ledger (paisa-exact)',
    paR.balanced === true,
    `diff=${paR.difference}`);
  check('Aging (Supplier): sub_group = Sundry Creditors',
    paR.sub_group === 'Sundry Creditors');

  // ── Test 4: Adding a credit-sale bill moves both sides in lockstep
  // The fixture-customer (cust) had two bills (10K + 7K) totalling
  // ₹17,000 outstanding; their party-leg posted ₹17,000 to Sundry
  // Debtors. Adding another credit sale of ₹1,000 should advance both
  // bill_outstanding AND ledger_outstanding by ₹1,000 — recon stays
  // balanced.
  const beforeR = ra.body.reconciliation;
  const t2 = await sequelize.transaction();
  const extraBill = await SalesBill.create({
    bill_number: `${PFX}SAL-EXTRA`, bill_date: today,
    customer_id: cust.party_id,
    sub_total: 1000, total_amount: 1000, balance_amount: 1000, payment_status: 'Unpaid',
  }, { transaction: t2 });
  for (const v of await buildSalesBillVouchers(
    await SalesBill.findByPk(extraBill.sales_bill_id, { include: [{ model: Party, as: 'customer' }], transaction: t2 }),
    { transaction: t2 },
  )) await postVoucher({ ...v, transaction: t2 });
  await t2.commit();

  const raAfter = await callCtrl(reportController.agingReport, { party_type: 'Customer' });
  const afterR = raAfter.body.reconciliation;
  check('Aging: bill_outstanding delta = +1,000',
    Math.abs(afterR.bill_outstanding - beforeR.bill_outstanding - 1000) < 0.01);
  check('Aging: ledger_outstanding delta = +1,000',
    Math.abs(afterR.ledger_outstanding - beforeR.ledger_outstanding - 1000) < 0.01);
  check('Aging: balanced remains true after lockstep posting',
    afterR.balanced === true);

  // ── Test 5: Walk-in cash sales (customer_id=NULL) don't affect recon
  // A cash sale must not appear in bill_outstanding (no Sundry Debtor
  // contribution) — recon stays balanced.
  const beforeWalk = await callCtrl(reportController.agingReport, { party_type: 'Customer' });
  await SalesBill.create({
    bill_number: `${PFX}SAL-WALK`, bill_date: today,
    customer_id: null,
    sub_total: 999, total_amount: 999, balance_amount: 999,
  });
  const afterWalk = await callCtrl(reportController.agingReport, { party_type: 'Customer' });
  check('Aging: walk-in cash sale (customer_id=NULL) does NOT advance bill_outstanding',
    Math.abs(afterWalk.body.reconciliation.bill_outstanding - beforeWalk.body.reconciliation.bill_outstanding) < 0.01);
  check('Aging: walk-in does NOT advance ledger_outstanding',
    Math.abs(afterWalk.body.reconciliation.ledger_outstanding - beforeWalk.body.reconciliation.ledger_outstanding) < 0.01);
  check('Aging: balanced remains true with walk-in present',
    afterWalk.body.reconciliation.balanced === true);

  // ── Test 6: Payables side — supplier bill of ₹5,000 advances
  // bill_outstanding by 5,000 and ledger_outstanding by 5,000 in
  // lockstep on the Sundry Creditors side.
  const beforeP = await callCtrl(reportController.agingReport, { party_type: 'Supplier' });
  const beforePR = beforeP.body.reconciliation;
  // The earlier 45-day purchase bill of ₹5,000 already posted in the
  // fixture block. Compute the delta from the recon snapshot taken
  // BEFORE this whole self-test ran (we don't have one — but we can
  // verify the supplier's contribution is captured in bill_outstanding
  // and matches their leg in the ledger).
  check('Aging (Supplier): bill_outstanding ≥ 5,000 (fixture supplier bill)',
    beforePR.bill_outstanding >= 5000);
  check('Aging (Supplier): balanced after fixture purchase bill',
    beforePR.balanced === true);

  // ── Cleanup ──
  await preClean();
  await SystemSettings.update({
    financial_year_start: '2026-04-01', financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase R2 Self-Test (Cash Flow + Aging) ────────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
