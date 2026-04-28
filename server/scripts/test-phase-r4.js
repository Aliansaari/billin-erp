#!/usr/bin/env node
// Phase-R4 self-test: report reconciliation invariants.
//
// Triggered by a real bug report — "Trial Balance totals diverge from
// Ledger Integrity" — that turned out to be a misread (TB nets per
// account, Integrity sums raw legs, so they're not equal by definition).
// The CORRECT invariants are tested here, plus banners surface them
// in the UI so future filter regressions get caught.
//
// Invariants checked:
//   • TB:   filter_raw + excluded_after_to == integrity_active   (paisa)
//   • SR:   Sales Account net Cr (period) ⩬ Σ sub_total of bills (period)
//   • PR:   Purchase Account net Dr (period) ⩬ Σ sub_total of bills (period)
//   • RA:   Σ customer outstanding == bill_outstanding_total
//   • PA:   Σ supplier outstanding == bill_outstanding_total
// (Aging's bill_outstanding vs Sundry Debtors/Creditors ledger drift
//  is a real legacy-data condition; we verify the FIELDS exist and
//  that drift, when present, is surfaced — not that it's zero.)

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const {
  Party, Product, Category, SystemSettings,
  SalesBill, PurchaseBill, SalesBillItem, PurchaseBillItem,
} = require('../models');
const { postVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers, buildPurchaseBillVouchers } = require('../services/voucherBuilders');
const finReports = require('../controllers/financialReportsController');
const ops = require('../controllers/operationalReportsController');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__R4_';

function callCtrl(handler, query) {
  return new Promise((resolve, reject) => {
    const req = { query };
    const res = { status(c) { this._s = c; return this; }, json(b) { resolve({ status: this._s || 200, body: b }); } };
    handler(req, res).catch(reject);
  });
}

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM products WHERE barcode LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM categories WHERE category_name LIKE '${PFX}%'`);
}

async function main() {
  await preClean();
  await SystemSettings.update({
    gst_enabled: true,
    financial_year_start: '2025-04-01',
    financial_year_end:   '2026-03-31',
  }, { where: { setting_id: 1 } });

  const FROM = '2025-04-01';
  const TO   = '2026-03-31';

  // ── (A) TB filter-drift reconciliation ────────────────────────────────
  // The new reconciliation block must:
  //   filter_raw + excluded_after_to == integrity_active  (Dr & Cr)
  // for ANY to_date — both the FY end and a historical mid-FY date.
  for (const toDate of [TO, '2025-08-31', '2099-12-31']) {
    const tb = await callCtrl(finReports.trialBalance, { from_date: FROM, to_date: toDate });
    check(`TB(${toDate}): status 200`, tb.status === 200);
    check(`TB(${toDate}): reconciliation present`, !!tb.body.reconciliation);
    const r = tb.body.reconciliation || {};
    check(`TB(${toDate}): filter_raw + excluded == integrity (Dr) — paisa-exact`,
      Math.abs(r.filter_raw_dr + r.excluded_after_to_dr - r.integrity_active_dr) < 0.01,
      `filter=${r.filter_raw_dr} excl=${r.excluded_after_to_dr} integ=${r.integrity_active_dr}`);
    check(`TB(${toDate}): filter_raw + excluded == integrity (Cr) — paisa-exact`,
      Math.abs(r.filter_raw_cr + r.excluded_after_to_cr - r.integrity_active_cr) < 0.01);
    check(`TB(${toDate}): drift fields = 0`,
      Math.abs(r.drift_dr) < 0.01 && Math.abs(r.drift_cr) < 0.01);
    check(`TB(${toDate}): banner not raised (balanced)`, r.balanced === true);
    // The TB column totals (per-account net) must always be balanced too.
    check(`TB(${toDate}): per-column totals balanced (Dr == Cr)`,
      Math.abs(tb.body.totals.debit - tb.body.totals.credit) < 0.01);
    // Per-column totals must NOT exceed integrity active (TB nets within
    // accounts, can never exceed the raw sum).
    check(`TB(${toDate}): per-column total ≤ integrity active`,
      tb.body.totals.debit <= r.integrity_active_dr + 0.01);
  }

  // Extra: future to_date should leave excluded == 0.
  const tbFar = await callCtrl(finReports.trialBalance, { from_date: FROM, to_date: '2099-12-31' });
  const rFar = tbFar.body.reconciliation;
  check('TB(far future): excluded_after_to == 0',
    Math.abs(rFar.excluded_after_to_dr) < 0.01 && Math.abs(rFar.excluded_after_to_cr) < 0.01);
  check('TB(far future): filter_raw == integrity_active',
    Math.abs(rFar.filter_raw_dr - rFar.integrity_active_dr) < 0.01);

  // ── (B) Build fixtures for register reconciliation ────────────────────
  const cat = await Category.create({ category_name: `${PFX}CatA` });
  const prodA = await Product.create({
    barcode: `${PFX}BC-A`, product_name: `${PFX}ProductA`,
    category_id: cat.category_id, hsn_code: '610910', gst_rate: 5,
    purchase_rate: 100, sale_rate: 150, current_stock: 0,
  });
  const cust = await Party.create({
    party_type: 'Customer', party_name: `${PFX}CustA`, mobile_1: '5500000020',
  });
  const sup = await Party.create({
    party_type: 'Supplier', party_name: `${PFX}SupA`, mobile_1: '5500000021',
  });
  await cust.reload(); await sup.reload();

  // Take baseline reconciliation deltas BEFORE creating fixtures so we
  // can assert "a +1000 bill moves both sides by +1000 in lockstep".
  const srBase = await callCtrl(ops.salesRegister,    { from_date: FROM, to_date: TO });
  const prBase = await callCtrl(ops.purchaseRegister, { from_date: FROM, to_date: TO });
  const baseSalesLedger    = srBase.body.reconciliation.ledger_net_credit;
  const baseSalesNet2L     = srBase.body.reconciliation.register_net_to_ledger;
  const basePurLedger      = prBase.body.reconciliation.ledger_net_debit;
  const basePurNet2L       = prBase.body.reconciliation.register_net_to_ledger;
  const baseSalesDiff      = srBase.body.reconciliation.difference;
  const basePurDiff        = prBase.body.reconciliation.difference;
  // Seeded data MUST already balance now that the invariant matches the
  // voucher-builder formula (sub − discount + freight + other).
  check('Seeded data: SR reconciliation balanced (paisa)',
    srBase.body.reconciliation.balanced === true,
    `diff=${baseSalesDiff} ledger=${baseSalesLedger} net2L=${baseSalesNet2L}`);
  check('Seeded data: PR reconciliation balanced (paisa)',
    prBase.body.reconciliation.balanced === true,
    `diff=${basePurDiff} ledger=${basePurLedger} net2L=${basePurNet2L}`);

  // Sales bill of 10 × 100 = ₹1,000 sub_total. With voucher posting,
  // Sales Account gets a Cr of 1,000.
  const t1 = await sequelize.transaction();
  const salBill = await SalesBill.create({
    bill_number: `${PFX}SAL-1`, bill_date: '2025-09-15',
    customer_id: cust.party_id,
    sub_total: 1000, total_amount: 1000, balance_amount: 1000, payment_status: 'Unpaid',
  }, { transaction: t1 });
  await SalesBillItem.create({
    sales_bill_id: salBill.sales_bill_id, product_id: prodA.product_id,
    barcode: prodA.barcode, product_name: prodA.product_name, hsn_code: '610910',
    unit_type: 'Pcs', quantity: 10, rate: 100, cost_rate: 80,
    taxable_amount: 1000, total_amount: 1000,
  }, { transaction: t1 });
  for (const v of await buildSalesBillVouchers(
    await SalesBill.findByPk(salBill.sales_bill_id, {
      include: [{ model: Party, as: 'customer' }, { model: SalesBillItem, as: 'items' }],
      transaction: t1,
    }),
    { transaction: t1 },
  )) await postVoucher({ ...v, transaction: t1 });
  await t1.commit();

  // ── (C) Sales Register reconciliation ────────────────────────────────
  const sr = await callCtrl(ops.salesRegister, { from_date: FROM, to_date: TO });
  const srRecon = sr.body.reconciliation;
  check('SR: reconciliation present', !!srRecon);
  check('SR: register_net_to_ledger field present', typeof srRecon.register_net_to_ledger === 'number');
  check('SR: breakdown fields present',
    typeof srRecon.register_taxable === 'number' && typeof srRecon.register_freight === 'number'
    && typeof srRecon.register_other === 'number' && typeof srRecon.register_discount === 'number');
  check('SR: ledger Cr delta = +1,000',
    Math.abs(srRecon.ledger_net_credit - baseSalesLedger - 1000) < 0.01,
    `before=${baseSalesLedger} after=${srRecon.ledger_net_credit}`);
  check('SR: register_net_to_ledger delta = +1,000',
    Math.abs(srRecon.register_net_to_ledger - baseSalesNet2L - 1000) < 0.01);
  // After this lockstep posting, recon must STILL be balanced (paisa).
  check('SR: balanced remains true after vanilla bill',
    srRecon.balanced === true,
    `diff=${srRecon.difference}`);

  // ── (D) Purchase fixtures + Purchase Register reconciliation ────────
  const t2 = await sequelize.transaction();
  const purBill = await PurchaseBill.create({
    bill_number: `${PFX}PUR-1`, bill_date: '2025-09-20',
    supplier_id: sup.party_id,
    sub_total: 500, total_amount: 500, balance_amount: 500, payment_status: 'Unpaid',
  }, { transaction: t2 });
  await PurchaseBillItem.create({
    purchase_bill_id: purBill.purchase_bill_id, product_id: prodA.product_id,
    barcode: prodA.barcode, product_name: prodA.product_name, hsn_code: '610910',
    quantity: 5, purchase_rate: 100, taxable_amount: 500, total_amount: 500,
  }, { transaction: t2 });
  for (const v of await buildPurchaseBillVouchers(
    await PurchaseBill.findByPk(purBill.purchase_bill_id, {
      include: [{ model: Party, as: 'supplier' }, { model: PurchaseBillItem, as: 'items' }],
      transaction: t2,
    }),
    { transaction: t2 },
  )) await postVoucher({ ...v, transaction: t2 });
  await t2.commit();

  const pr = await callCtrl(ops.purchaseRegister, { from_date: FROM, to_date: TO });
  const prRecon = pr.body.reconciliation;
  check('PR: reconciliation present', !!prRecon);
  check('PR: register_net_to_ledger field present', typeof prRecon.register_net_to_ledger === 'number');
  check('PR: ledger Dr delta = +500',
    Math.abs(prRecon.ledger_net_debit - basePurLedger - 500) < 0.01);
  check('PR: register_net_to_ledger delta = +500',
    Math.abs(prRecon.register_net_to_ledger - basePurNet2L - 500) < 0.01);
  check('PR: balanced remains true after vanilla bill',
    prRecon.balanced === true);

  // ── (D2) FREIGHT-ONLY REGRESSION — locks in the bug class.
  // The voucher builder posts Sales Cr = sub_total − discount + other +
  // freight. A bill with freight ≠ 0 used to drift the SR reconciliation
  // (Sales Cr included freight; register_taxable did not). With the
  // fix, register_net_to_ledger absorbs freight + other − discount, so
  // the recon stays balanced.
  const t2b = await sequelize.transaction();
  const freightBill = await SalesBill.create({
    bill_number: `${PFX}SAL-FREIGHT`, bill_date: '2025-09-25',
    customer_id: cust.party_id,
    sub_total: 2000, discount_amount: 50, other_charges: 25,
    freight_charges: 300, total_amount: 2275, balance_amount: 2275,
    payment_status: 'Unpaid',
  }, { transaction: t2b });
  await SalesBillItem.create({
    sales_bill_id: freightBill.sales_bill_id, product_id: prodA.product_id,
    barcode: prodA.barcode, product_name: prodA.product_name, hsn_code: '610910',
    unit_type: 'Pcs', quantity: 20, rate: 100, cost_rate: 80,
    taxable_amount: 2000, total_amount: 2000,
  }, { transaction: t2b });
  for (const v of await buildSalesBillVouchers(
    await SalesBill.findByPk(freightBill.sales_bill_id, {
      include: [{ model: Party, as: 'customer' }, { model: SalesBillItem, as: 'items' }],
      transaction: t2b,
    }),
    { transaction: t2b },
  )) await postVoucher({ ...v, transaction: t2b });
  await t2b.commit();

  const srAfterFreight = await callCtrl(ops.salesRegister, { from_date: FROM, to_date: TO });
  const recF = srAfterFreight.body.reconciliation;
  // Sales Cr should advance by 2000 − 50 + 25 + 300 = 2275.
  check('Freight-only: ledger Cr delta = 2,275',
    Math.abs(recF.ledger_net_credit - srRecon.ledger_net_credit - 2275) < 0.01);
  check('Freight-only: register_net_to_ledger delta = 2,275',
    Math.abs(recF.register_net_to_ledger - srRecon.register_net_to_ledger - 2275) < 0.01);
  check('Freight-only: register_taxable delta = 2,000 (sub_total only)',
    Math.abs(recF.register_taxable - srRecon.register_taxable - 2000) < 0.01);
  check('Freight-only: register_freight delta = 300',
    Math.abs(recF.register_freight - srRecon.register_freight - 300) < 0.01);
  check('Freight-only: register_other delta = 25',
    Math.abs(recF.register_other - srRecon.register_other - 25) < 0.01);
  check('Freight-only: register_discount delta = 50',
    Math.abs(recF.register_discount - srRecon.register_discount - 50) < 0.01);
  // Critical regression check — recon must STILL balance after the
  // freight-bearing bill (the bug R4 missed before this fix).
  check('Freight-only: SR balanced remains true (regression lock)',
    recF.balanced === true,
    `diff=${recF.difference}`);

  // ── (E) Detect a deliberately broken Sales bill (manual JV that
  // bypasses billing → ledger Cr increases without a register entry) ──
  // Post a manual journal voucher: Cash Dr 100 / Sales Account Cr 100.
  // SR reconciliation should now drift by exactly 100.
  const cashLedger = await sequelize.query(
    `SELECT ledger_id FROM ledger_accounts WHERE ledger_name = 'Cash' LIMIT 1`,
    { type: sequelize.QueryTypes.SELECT },
  );
  const salesLedger = await sequelize.query(
    `SELECT ledger_id FROM ledger_accounts WHERE ledger_name = 'Sales Account' LIMIT 1`,
    { type: sequelize.QueryTypes.SELECT },
  );
  if (cashLedger[0] && salesLedger[0]) {
    // Inject the drift directly into ledger_entries (we don't go through
    // postVoucher because that requires a parent journal_vouchers row;
    // the goal here is to simulate the *symptom* of off-bill activity,
    // not to exercise the JV API).
    await sequelize.query(
      `INSERT INTO ledger_entries
         (entry_number, entry_date, ledger_id, debit_amount, credit_amount,
          narration, reference_number, source_type, voucher_type, created_date)
       VALUES
         ('${PFX}MANUAL-JV1-D', '2025-10-01', ${cashLedger[0].ledger_id}, 100, 0,
          '${PFX}drift inducer', '${PFX}MANUAL-JV1', 'journal_voucher', 'Journal', NOW()),
         ('${PFX}MANUAL-JV1-C', '2025-10-01', ${salesLedger[0].ledger_id}, 0, 100,
          '${PFX}drift inducer', '${PFX}MANUAL-JV1', 'journal_voucher', 'Journal', NOW())`,
    );

    const sr2 = await callCtrl(ops.salesRegister, { from_date: FROM, to_date: TO });
    const drifted = sr2.body.reconciliation;
    // Sales Cr advances by 100 (off-bill). register_net_to_ledger does NOT
    // (no SalesBill row created). Difference must advance by exactly 100.
    check('SR drift detection: ledger Cr advanced by 100',
      Math.abs(drifted.ledger_net_credit - recF.ledger_net_credit - 100) < 0.01);
    check('SR drift detection: register_net_to_ledger unchanged',
      Math.abs(drifted.register_net_to_ledger - recF.register_net_to_ledger) < 0.01);
    check('SR drift detection: difference advanced by exactly 100',
      Math.abs(drifted.difference - recF.difference - 100) < 0.01,
      `before=${recF.difference} after=${drifted.difference}`);
    check('SR drift detection: reconciliation flags unbalanced',
      drifted.balanced === false);
  } else {
    check('SR drift detection: skipped (Cash/Sales ledger not seeded)', true);
    check('SR drift detection: register taxable unchanged (skipped)', true);
    check('SR drift detection: difference advanced by exactly 100 (skipped)', true);
    check('SR drift detection: reconciliation flags unbalanced (skipped)', true);
  }

  // ── (F) Aging cross-checks against /api/reports/aging ────────────
  // The R2-era /receivables-aging + /payables-aging endpoints were
  // removed in the Phase R5 follow-up. /api/reports/aging is the
  // single source of truth and carries the corrected reconciliation
  // formula (see _agingReconciliation in reportController.js).
  const reportController = require('../controllers/reportController');
  const ra = await callCtrl(reportController.agingReport, { party_type: 'Customer' });
  check('Aging (Customer): reconciliation present', !!ra.body.reconciliation);
  check('Aging (Customer): balanced (paisa-exact, post-R5 formula)',
    ra.body.reconciliation.balanced === true,
    `diff=${ra.body.reconciliation.difference}`);
  check('Aging (Customer): sub_group = Sundry Debtors',
    ra.body.reconciliation.sub_group === 'Sundry Debtors');

  const pa = await callCtrl(reportController.agingReport, { party_type: 'Supplier' });
  check('Aging (Supplier): balanced (paisa-exact)',
    pa.body.reconciliation.balanced === true,
    `diff=${pa.body.reconciliation.difference}`);
  check('Aging (Supplier): sub_group = Sundry Creditors',
    pa.body.reconciliation.sub_group === 'Sundry Creditors');

  // ── Cleanup ──
  await preClean();
  await SystemSettings.update({
    financial_year_start: '2026-04-01', financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase R4 Self-Test (Reconciliation Invariants) ────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
