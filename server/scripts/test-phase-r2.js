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

  // ── Test 3: Receivables Aging ─────────────────────────
  const ra = await callCtrl(finReports.receivablesAging, { as_of_date: today });
  check('RA: status 200', ra.status === 200);
  const raCust = (ra.body.parties || []).find((p) => p.party_id === cust.party_id);
  check('RA: customer present', !!raCust);
  if (raCust) {
    // Old bill (95 days) → over_90 bucket; New bill (5 days) → 0_30.
    check('RA: over_90 bucket = 10,000', Math.abs(raCust.buckets['over_90'] - 10000) < 0.01,
      `over_90=${raCust.buckets['over_90']}`);
    check('RA: 0_30 bucket = 7,000', Math.abs(raCust.buckets['0_30'] - 7000) < 0.01);
    check('RA: 31_60 + 61_90 buckets empty for this customer',
      raCust.buckets['31_60'] === 0 && raCust.buckets['61_90'] === 0);
    check('RA: total = 17,000', Math.abs(raCust.total - 17000) < 0.01);
    check('RA: oldest_days >= 95', raCust.oldest_days >= 95);
    check('RA: bills_count = 2', raCust.bills_count === 2);
  }
  check('RA: reconciliation surfaces sub_group',
    ra.body.reconciliation.sub_group === 'Sundry Debtors');
  // Reconciliation balanced check is intentionally NOT asserted: legacy
  // data may have drift between bill outstanding and Sundry Debtors ledger
  // (off-cycle JVs, opening JVs, manual writeoffs). The banner surfaces
  // this to the user; the test only confirms the fields are populated.
  check('RA: reconciliation has numeric totals',
    typeof ra.body.reconciliation.bill_outstanding_total === 'number'
    && typeof ra.body.reconciliation.ledger_group_total === 'number');

  // ── Test 4: Bucket boundary — exactly 30 days ─────────
  // A bill dated exactly 30 days ago should land in 0_30, not 31_60.
  const exactly30 = new Date(today); exactly30.setDate(exactly30.getDate() - 30);
  const billBound = await SalesBill.create({
    bill_number: `${PFX}SAL-30`, bill_date: exactly30.toISOString().slice(0, 10),
    customer_id: cust.party_id,
    sub_total: 1000, total_amount: 1000, balance_amount: 1000,
  });
  const t2 = await sequelize.transaction();
  for (const v of await buildSalesBillVouchers(
    await SalesBill.findByPk(billBound.sales_bill_id, { include: [{ model: Party, as: 'customer' }], transaction: t2 }),
    { transaction: t2 },
  )) await postVoucher({ ...v, transaction: t2 });
  await t2.commit();

  const ra2 = await callCtrl(finReports.receivablesAging, { as_of_date: today });
  const raCust2 = (ra2.body.parties || []).find((p) => p.party_id === cust.party_id);
  check('Boundary: 30-day bill in 0_30 bucket',
    raCust2 && Math.abs(raCust2.buckets['0_30'] - (7000 + 1000)) < 0.01,
    `0_30=${raCust2 && raCust2.buckets['0_30']}`);

  // ── Test 5: Paid bills don't appear ───────────────────
  // Mark billNew as fully paid by zeroing balance_amount.
  await SalesBill.update({ balance_amount: 0, payment_status: 'Paid' }, { where: { sales_bill_id: billNew.sales_bill_id } });
  const ra3 = await callCtrl(finReports.receivablesAging, { as_of_date: today });
  const raCust3 = (ra3.body.parties || []).find((p) => p.party_id === cust.party_id);
  // Customer should still appear with old + 30-day bills, total = 11,000 (10K + 1K).
  check('Paid bill excluded: customer total drops by 7,000',
    raCust3 && Math.abs(raCust3.total - 11000) < 0.01,
    `total=${raCust3 && raCust3.total}`);

  // ── Test 6: Payables Aging ────────────────────────────
  const pa = await callCtrl(finReports.payablesAging, { as_of_date: today });
  check('PA: status 200', pa.status === 200);
  const paSup = (pa.body.parties || []).find((p) => p.party_id === sup.party_id);
  check('PA: supplier present with ₹5,000 outstanding',
    paSup && Math.abs(paSup.total - 5000) < 0.01);
  if (paSup) {
    check('PA: 31_60 bucket = 5,000 (45-day bill)',
      Math.abs(paSup.buckets['31_60'] - 5000) < 0.01);
    check('PA: oldest_days = 45', paSup.oldest_days === 45);
  }
  check('PA: reconciliation sub_group = Sundry Creditors',
    pa.body.reconciliation.sub_group === 'Sundry Creditors');
  check('PA: reconciliation has numeric totals',
    typeof pa.body.reconciliation.bill_outstanding_total === 'number'
    && typeof pa.body.reconciliation.ledger_group_total === 'number');

  // ── Test 7: Sort options work ────────────────────────
  // Add a second customer with a smaller balance to ensure ordering.
  const cust2 = await Party.create({
    party_type: 'Customer', party_name: `${PFX}AAACust2`, mobile_1: '5500000003',
  });
  await cust2.reload();
  const t3 = await sequelize.transaction();
  const billC2 = await SalesBill.create({
    bill_number: `${PFX}SAL-C2`, bill_date: today,
    customer_id: cust2.party_id,
    sub_total: 500, total_amount: 500, balance_amount: 500,
  }, { transaction: t3 });
  for (const v of await buildSalesBillVouchers(
    await SalesBill.findByPk(billC2.sales_bill_id, { include: [{ model: Party, as: 'customer' }], transaction: t3 }),
    { transaction: t3 },
  )) await postVoucher({ ...v, transaction: t3 });
  await t3.commit();

  const ra4 = await callCtrl(finReports.receivablesAging, { as_of_date: today });
  const ourParties = (ra4.body.parties || []).filter((p) => p.party_id === cust.party_id || p.party_id === cust2.party_id);
  check('Sort: amount desc (default) — bigger total first',
    ourParties.length === 2 && ourParties[0].total >= ourParties[1].total);

  // ── Test 8: Empty receivables when filter excludes all ──
  const emptyRa = await callCtrl(finReports.receivablesAging, { as_of_date: '1900-01-01' });
  check('Empty as-of: 0 parties', (emptyRa.body.parties || []).length === 0);
  check('Empty as-of: totals zero',
    emptyRa.body.totals.total === 0
    && emptyRa.body.totals.parties_count === 0
    && emptyRa.body.totals.bills_count === 0);
  check('Empty as-of: reconciliation balanced (both zero)',
    emptyRa.body.reconciliation.balanced === true);

  // ── Test 9: Walk-in (no customer_id) sales don't appear ─
  await SalesBill.create({
    bill_number: `${PFX}SAL-WALK`, bill_date: today,
    customer_id: null,
    sub_total: 999, total_amount: 999, balance_amount: 999,
  });
  const ra5 = await callCtrl(finReports.receivablesAging, { as_of_date: today });
  const partiesAll = (ra5.body.parties || []);
  check('Walk-in sales (customer_id=null) NOT in aging',
    !partiesAll.some((p) => p.party_id === null || p.party_id === undefined));

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
