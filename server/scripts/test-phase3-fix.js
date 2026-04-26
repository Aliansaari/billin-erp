#!/usr/bin/env node
// Self-test for the Ledger Integrity follow-up fixes:
//   • Active vs Lifetime totals correctly split
//   • party_opening row appears in the breakdown
//
// Scenario: create a customer with opening balance (party_opening JV
// fires), enter a sale, edit it once (₹10K → ₹12K), edit again (→ ₹15K).
// After the dust settles:
//   • Active rows reflect the FINAL ₹15K state
//   • Lifetime rows include all originals + 2 sets of reversal mirrors
//   • Both balanced (Dr = Cr) — reversal pairs sum to zero
//   • party_opening row in breakdown shows our test customer's opening JV

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { sequelize, Party, LedgerAccount, SalesBill } = require('../models');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers } = require('../services/voucherBuilders');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P3FIX_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_number LIKE '${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM ledger_entries WHERE source_type IN ('sales_bill','sales_bill_receipt') AND reference_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
}

async function postSale(billId) {
  const t = await sequelize.transaction();
  const refreshed = await SalesBill.findByPk(billId, { include: [{ model: Party, as: 'customer' }], transaction: t });
  const vouchers = await buildSalesBillVouchers(refreshed, { transaction: t });
  for (const v of vouchers) await postVoucher({ ...v, transaction: t });
  await t.commit();
}

async function reversePostings(billId) {
  const t = await sequelize.transaction();
  await reverseVoucher({ sourceType: 'sales_bill',         sourceId: billId, transaction: t });
  await reverseVoucher({ sourceType: 'sales_bill_receipt', sourceId: billId, transaction: t });
  await t.commit();
}

async function callIntegrity() {
  // Hit the controller directly via the Sequelize instance, skipping the
  // HTTP layer (no auth needed for the test).
  const ctrl = require('../controllers/ledgerController');
  return await new Promise((resolve, reject) => {
    const req = {};
    const res = {
      status(code) { this._status = code; return this; },
      json(body) { resolve({ status: this._status || 200, body }); },
    };
    ctrl.integrity(req, res).catch(reject);
  });
}

async function main() {
  await preClean();

  // Capture baseline so the test tolerates pre-existing data the user may
  // have entered through the UI (Phase 2 acceptance: "spot-check by entering
  // a few real transactions"). We assert on deltas, not absolute totals.
  const baseline = (await callIntegrity()).body.totals;

  // Customer with ₹50,000 opening — fires party_opening JV via afterCreate.
  const cust = await Party.create({
    party_type: 'Customer',
    party_name: `${PFX}CUST`,
    mobile_1: '7777700001',
    opening_balance: 50000,
    opening_balance_type: 'Receivable',
  });
  await cust.reload();

  // Enter a sale @ ₹11,800 (10K + 9% CGST + 9% SGST).
  const sales   = await LedgerAccount.findOne({ where: { ledger_name: 'Sales Account' } });
  const cgstOut = await LedgerAccount.findOne({ where: { ledger_name: 'CGST Output' } });
  const sgstOut = await LedgerAccount.findOne({ where: { ledger_name: 'SGST Output' } });

  const billA = await SalesBill.create({
    bill_number: `${PFX}SAL01`, bill_date: '2026-04-26', customer_id: cust.party_id,
    sub_total: 10000, discount_amount: 0,
    cgst_amount: 900, sgst_amount: 900, igst_amount: 0,
    cgst_pct: 9, sgst_pct: 9, igst_pct: 0,
    round_off: 0, total_amount: 11800, paid_amount: 0,
    balance_amount: 11800, payment_status: 'Unpaid',
    payment_method: 'Cash',
  });
  await postSale(billA.sales_bill_id);

  // Edit #1: ₹11,800 → ₹14,160 (12K + tax)
  await reversePostings(billA.sales_bill_id);
  await SalesBill.update({
    sub_total: 12000, cgst_amount: 1080, sgst_amount: 1080,
    total_amount: 14160, balance_amount: 14160,
  }, { where: { sales_bill_id: billA.sales_bill_id } });
  await postSale(billA.sales_bill_id);

  // Edit #2: ₹14,160 → ₹17,700 (15K + tax)
  await reversePostings(billA.sales_bill_id);
  await SalesBill.update({
    sub_total: 15000, cgst_amount: 1350, sgst_amount: 1350,
    total_amount: 17700, balance_amount: 17700,
  }, { where: { sales_bill_id: billA.sales_bill_id } });
  await postSale(billA.sales_bill_id);

  // Hit the integrity endpoint
  const r = await callIntegrity();
  const t = r.body.totals;

  // Active delta = our fixtures only. Opening JV (50K Dr / 50K Cr) +
  // latest sale (Customer Dr 17,700 / Sales Cr 15,000 / CGST Cr 1,350 / SGST Cr 1,350)
  const expectedDelta = 50000 + 17700;
  const drDelta = t.active.debits  - baseline.active.debits;
  const crDelta = t.active.credits - baseline.active.credits;
  check('Active is balanced', t.active.balanced);
  check('Active Dr delta = 67,700', Math.abs(drDelta - expectedDelta) < 0.01,
    `delta=${drDelta}`);
  check('Active Cr delta = 67,700', Math.abs(crDelta - expectedDelta) < 0.01,
    `delta=${crDelta}`);

  // Lifetime: opening (2 rows) + 3 sales postings × 4 rows + 2 reversal pairs × 4 rows
  // = 2 + 12 + 8 = 22 rows total
  // Lifetime Dr = Lifetime Cr (paired)
  check('Lifetime is balanced', t.lifetime.balanced);
  check('Lifetime Dr = Lifetime Cr', Math.abs(t.lifetime.debits - t.lifetime.credits) < 0.01);
  check('Lifetime Dr ≥ Active Dr (audit trail bigger)', t.lifetime.debits >= t.active.debits);

  // breakdown contains party_opening row
  const open = r.body.breakdown.find((b) => b.source_type === 'party_opening');
  check('Breakdown has party_opening row', !!open);
  check('party_opening total ≥ 1 (our test customer)', open && open.total >= 1);
  check('party_opening unposted = 0', open && open.unposted === 0);

  // Cleanup
  await preClean();

  console.log('\n── Phase 3 Follow-up Self-Test ───────────────────');
  console.log(`  Active   Dr=${t.active.debits}   Cr=${t.active.credits}   diff=${t.active.difference}`);
  console.log(`  Lifetime Dr=${t.lifetime.debits} Cr=${t.lifetime.credits} diff=${t.lifetime.difference} rows=${t.lifetime.rows}`);
  for (const ln of results) console.log(ln);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
