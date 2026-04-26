#!/usr/bin/env node
// Phase-R3 self-test: Sales Register, Purchase Register, HSN Summary,
// Stock Summary, Fast/Slow Movers.
//
// Drives controllers directly. Tolerates pre-existing prod data via
// baseline+delta where appropriate (totals are checked relative to a
// pre-fixture snapshot, not absolute).

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const {
  Party, Product, Category, SystemSettings,
  SalesBill, PurchaseBill, SalesBillItem, PurchaseBillItem, StockLedger,
} = require('../models');
const { postVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers, buildPurchaseBillVouchers } = require('../services/voucherBuilders');
const ops = require('../controllers/operationalReportsController');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__R3_';

function callCtrl(handler, query) {
  return new Promise((resolve, reject) => {
    const req = { query };
    const res = { status(c) { this._s = c; return this; }, json(b) { resolve({ status: this._s || 200, body: b }); } };
    handler(req, res).catch(reject);
  });
}

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE reference_number LIKE '${PFX}%' OR remarks LIKE '%${PFX}%'`);
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
  const TODAY = new Date().toISOString().slice(0, 10);

  // ── Baseline snapshots (R3 reports include any prod data — assert deltas) ─
  const baseSales = await callCtrl(ops.salesRegister, { from_date: FROM, to_date: TO });
  const basePurch = await callCtrl(ops.purchaseRegister, { from_date: FROM, to_date: TO });
  const baseHsnS = await callCtrl(ops.hsnSummary, { from_date: FROM, to_date: TO, direction: 'sales' });
  const baseStock = await callCtrl(ops.stockSummary, { from_date: FROM, to_date: TO });
  const baseMov = await callCtrl(ops.movers, { from_date: FROM, to_date: TO, limit: 100 });

  check('Baseline: salesRegister status 200', baseSales.status === 200);
  check('Baseline: purchaseRegister status 200', basePurch.status === 200);
  check('Baseline: hsnSummary status 200', baseHsnS.status === 200);
  check('Baseline: stockSummary status 200', baseStock.status === 200);
  check('Baseline: movers status 200', baseMov.status === 200);

  // ── Build fixtures ─────────────────────────────────────────────────────
  const cat = await Category.create({ category_name: `${PFX}CatA` });
  const prodA = await Product.create({
    barcode: `${PFX}BC-A`, product_name: `${PFX}ProductA`,
    category_id: cat.category_id, hsn_code: '610910', gst_rate: 5,
    purchase_rate: 100, sale_rate: 150, current_stock: 0,
  });
  const prodB = await Product.create({
    barcode: `${PFX}BC-B`, product_name: `${PFX}ProductB`,
    category_id: cat.category_id, hsn_code: '610910', gst_rate: 5,
    purchase_rate: 200, sale_rate: 280, current_stock: 0,
  });
  const prodDead = await Product.create({
    barcode: `${PFX}BC-DEAD`, product_name: `${PFX}ProductDead`,
    category_id: cat.category_id, hsn_code: '610911', gst_rate: 5,
    purchase_rate: 50, sale_rate: 80, current_stock: 100,
  });
  const cust = await Party.create({
    party_type: 'Customer', party_name: `${PFX}CustA`, mobile_1: '5500000010',
    gstin: '27AAAAA1234A1Z5', state: 'Maharashtra',
  });
  const sup = await Party.create({
    party_type: 'Supplier', party_name: `${PFX}SupA`, mobile_1: '5500000011',
    gstin: '27BBBBB1234A1Z5', state: 'Maharashtra',
  });
  await cust.reload(); await sup.reload();

  // Purchase bill: 30 of A @ 100 + 20 of B @ 200 = 7,000 taxable + 5% GST
  const t1 = await sequelize.transaction();
  const purBill = await PurchaseBill.create({
    bill_number: `${PFX}PUR-1`, bill_date: '2025-05-01',
    supplier_id: sup.party_id,
    sub_total: 7000, cgst_amount: 175, sgst_amount: 175,
    total_amount: 7350, balance_amount: 7350, payment_status: 'Unpaid',
  }, { transaction: t1 });
  await PurchaseBillItem.create({
    purchase_bill_id: purBill.purchase_bill_id, product_id: prodA.product_id,
    barcode: prodA.barcode, product_name: prodA.product_name, hsn_code: '610910',
    quantity: 30, purchase_rate: 100, taxable_amount: 3000,
    gst_rate: 5, cgst_amount: 75, sgst_amount: 75, total_amount: 3150,
  }, { transaction: t1 });
  await PurchaseBillItem.create({
    purchase_bill_id: purBill.purchase_bill_id, product_id: prodB.product_id,
    barcode: prodB.barcode, product_name: prodB.product_name, hsn_code: '610910',
    quantity: 20, purchase_rate: 200, taxable_amount: 4000,
    gst_rate: 5, cgst_amount: 100, sgst_amount: 100, total_amount: 4200,
  }, { transaction: t1 });
  // Stock ledger entries to mark the inflow
  await StockLedger.create({
    product_id: prodA.product_id, barcode: prodA.barcode,
    transaction_type: 'Purchase', transaction_date: '2025-05-01',
    reference_id: purBill.purchase_bill_id, reference_number: `${PFX}PUR-1`,
    quantity_in: 30, quantity_out: 0, rate: 100, balance_quantity: 30,
  }, { transaction: t1 });
  await StockLedger.create({
    product_id: prodB.product_id, barcode: prodB.barcode,
    transaction_type: 'Purchase', transaction_date: '2025-05-01',
    reference_id: purBill.purchase_bill_id, reference_number: `${PFX}PUR-1`,
    quantity_in: 20, quantity_out: 0, rate: 200, balance_quantity: 20,
  }, { transaction: t1 });
  await prodA.update({ current_stock: 30 }, { transaction: t1 });
  await prodB.update({ current_stock: 20 }, { transaction: t1 });
  await t1.commit();

  // Sales bill: 10 of A @ 150 + 5 of B @ 280 = 2,900 + 5% GST
  const t2 = await sequelize.transaction();
  const salBill = await SalesBill.create({
    bill_number: `${PFX}SAL-1`, bill_date: '2025-06-15',
    customer_id: cust.party_id,
    sub_total: 2900, cgst_amount: 72.5, sgst_amount: 72.5,
    total_amount: 3045, balance_amount: 3045, payment_status: 'Unpaid',
  }, { transaction: t2 });
  await SalesBillItem.create({
    sales_bill_id: salBill.sales_bill_id, product_id: prodA.product_id,
    barcode: prodA.barcode, product_name: prodA.product_name, hsn_code: '610910',
    unit_type: 'Pcs', quantity: 10, rate: 150, cost_rate: 100,
    taxable_amount: 1500, gst_rate: 5, cgst_amount: 37.5, sgst_amount: 37.5, total_amount: 1575,
  }, { transaction: t2 });
  await SalesBillItem.create({
    sales_bill_id: salBill.sales_bill_id, product_id: prodB.product_id,
    barcode: prodB.barcode, product_name: prodB.product_name, hsn_code: '610910',
    unit_type: 'Pcs', quantity: 5, rate: 280, cost_rate: 200,
    taxable_amount: 1400, gst_rate: 5, cgst_amount: 35, sgst_amount: 35, total_amount: 1470,
  }, { transaction: t2 });
  await StockLedger.create({
    product_id: prodA.product_id, barcode: prodA.barcode,
    transaction_type: 'Sales', transaction_date: '2025-06-15',
    reference_id: salBill.sales_bill_id, reference_number: `${PFX}SAL-1`,
    quantity_in: 0, quantity_out: 10, rate: 150, balance_quantity: 20,
  }, { transaction: t2 });
  await StockLedger.create({
    product_id: prodB.product_id, barcode: prodB.barcode,
    transaction_type: 'Sales', transaction_date: '2025-06-15',
    reference_id: salBill.sales_bill_id, reference_number: `${PFX}SAL-1`,
    quantity_in: 0, quantity_out: 5, rate: 280, balance_quantity: 15,
  }, { transaction: t2 });
  await prodA.update({ current_stock: 20 }, { transaction: t2 });
  await prodB.update({ current_stock: 15 }, { transaction: t2 });
  await t2.commit();

  // ── Sales Register ─────────────────────────────────────────────────────
  const sr = await callCtrl(ops.salesRegister, { from_date: FROM, to_date: TO });
  check('SR: status 200', sr.status === 200);
  const myBill = (sr.body.bills || []).find((b) => b.bill_number === `${PFX}SAL-1`);
  check('SR: our bill present', !!myBill);
  if (myBill) {
    check('SR: customer name matches', myBill.customer_name === `${PFX}CustA`);
    check('SR: gstin returned', myBill.gstin === '27AAAAA1234A1Z5');
    check('SR: taxable = 2,900', Math.abs(myBill.taxable - 2900) < 0.01);
    check('SR: total = 3,045', Math.abs(myBill.total - 3045) < 0.01);
    check('SR: balance = 3,045 (unpaid)', Math.abs(myBill.balance - 3045) < 0.01);
  }
  // Delta totals: ours adds bills_count + 1, taxable + 2,900
  check('SR: totals.bills_count delta = +1',
    sr.body.totals.bills_count === baseSales.body.totals.bills_count + 1,
    `before=${baseSales.body.totals.bills_count} after=${sr.body.totals.bills_count}`);
  check('SR: totals.taxable delta = +2,900',
    Math.abs(sr.body.totals.taxable - baseSales.body.totals.taxable - 2900) < 0.01,
    `delta=${(sr.body.totals.taxable - baseSales.body.totals.taxable).toFixed(2)}`);

  // ── Purchase Register ──────────────────────────────────────────────────
  const pr = await callCtrl(ops.purchaseRegister, { from_date: FROM, to_date: TO });
  check('PR: status 200', pr.status === 200);
  const myPur = (pr.body.bills || []).find((b) => b.bill_number === `${PFX}PUR-1`);
  check('PR: our bill present', !!myPur);
  if (myPur) {
    check('PR: supplier name matches', myPur.supplier_name === `${PFX}SupA`);
    check('PR: taxable = 7,000', Math.abs(myPur.taxable - 7000) < 0.01);
    check('PR: total = 7,350', Math.abs(myPur.total - 7350) < 0.01);
  }
  check('PR: totals.bills_count delta = +1',
    pr.body.totals.bills_count === basePurch.body.totals.bills_count + 1);
  check('PR: totals.taxable delta = +7,000',
    Math.abs(pr.body.totals.taxable - basePurch.body.totals.taxable - 7000) < 0.01);

  // ── HSN Summary (sales) ────────────────────────────────────────────────
  const hs = await callCtrl(ops.hsnSummary, { from_date: FROM, to_date: TO, direction: 'sales' });
  check('HSN-S: status 200', hs.status === 200);
  // Our two sales lines both on HSN 610910 = qty 15, taxable 2,900
  const hsnRow = (hs.body.hsn || []).find((r) => r.hsn_code === '610910');
  check('HSN-S: 610910 row exists', !!hsnRow);
  // Delta on the row vs base
  const baseHsnRow = (baseHsnS.body.hsn || []).find((r) => r.hsn_code === '610910');
  const baseTaxable = baseHsnRow ? baseHsnRow.taxable : 0;
  const baseQty = baseHsnRow ? baseHsnRow.quantity : 0;
  if (hsnRow) {
    check('HSN-S: 610910 taxable delta = +2,900',
      Math.abs(hsnRow.taxable - baseTaxable - 2900) < 0.01,
      `before=${baseTaxable} after=${hsnRow.taxable}`);
    check('HSN-S: 610910 quantity delta = +15',
      Math.abs(hsnRow.quantity - baseQty - 15) < 0.01);
    check('HSN-S: 610910 GST rate = 5', Math.abs(hsnRow.gst_rate - 5) < 0.01);
  }

  // ── HSN Summary (purchase) ─────────────────────────────────────────────
  const hp = await callCtrl(ops.hsnSummary, { from_date: FROM, to_date: TO, direction: 'purchase' });
  check('HSN-P: status 200', hp.status === 200);
  check('HSN-P: direction echoed', hp.body.direction === 'purchase');
  const hpRow = (hp.body.hsn || []).find((r) => r.hsn_code === '610910');
  check('HSN-P: 610910 row exists (purchase)', !!hpRow);

  // ── Stock Summary ──────────────────────────────────────────────────────
  const ss = await callCtrl(ops.stockSummary, { from_date: FROM, to_date: TO });
  check('SS: status 200', ss.status === 200);
  const ssA = (ss.body.products || []).find((p) => p.product_id === prodA.product_id);
  const ssB = (ss.body.products || []).find((p) => p.product_id === prodB.product_id);
  const ssDead = (ss.body.products || []).find((p) => p.product_id === prodDead.product_id);
  check('SS: ProductA present', !!ssA);
  check('SS: ProductB present', !!ssB);
  check('SS: ProductDead present', !!ssDead);
  if (ssA) {
    // A: opening 0, in 30, out 10, closing 20, value 20 × 100 = 2,000
    check('SS: A opening = 0', ssA.opening_qty === 0);
    check('SS: A in = 30', ssA.in_qty === 30);
    check('SS: A out = 10', ssA.out_qty === 10);
    check('SS: A closing = 20', ssA.closing_qty === 20);
    check('SS: A value = 2,000', Math.abs(ssA.closing_value - 2000) < 0.01);
  }
  if (ssDead) {
    // Dead: no transactions, opening = 0, in = 0, out = 0, closing = 0
    // (the product has current_stock=100 but stock_ledger is empty for it)
    check('SS: Dead product had no movement', ssDead.in_qty === 0 && ssDead.out_qty === 0);
  }

  // ── Stock Summary — opening for narrower window (post-purchase) ────────
  // Purchase was on 2025-05-01. A window starting 2025-06-01 should show
  // opening_qty = 30 (the purchase) and out = 10 (the June sale).
  const ssNarrow = await callCtrl(ops.stockSummary, { from_date: '2025-06-01', to_date: TO });
  const ssAN = (ssNarrow.body.products || []).find((p) => p.product_id === prodA.product_id);
  if (ssAN) {
    check('SS narrow: A opening = 30 (pre-window purchase)', ssAN.opening_qty === 30);
    check('SS narrow: A in = 0 (no purchase in window)', ssAN.in_qty === 0);
    check('SS narrow: A out = 10 (June sale)', ssAN.out_qty === 10);
    check('SS narrow: A closing = 20', ssAN.closing_qty === 20);
  }

  // ── Movers ─────────────────────────────────────────────────────────────
  const mv = await callCtrl(ops.movers, { from_date: FROM, to_date: TO, limit: 100 });
  check('MV: status 200', mv.status === 200);
  const mvA = (mv.body.fast || []).find((p) => p.product_id === prodA.product_id);
  const mvB = (mv.body.fast || []).find((p) => p.product_id === prodB.product_id);
  check('MV: ProductA in fast list (10 sold)', !!mvA);
  check('MV: ProductB in fast list (5 sold)',  !!mvB);
  if (mvA) {
    check('MV: A qty_sold = 10', mvA.qty_sold === 10);
    check('MV: A revenue = 1,500', Math.abs(mvA.revenue - 1500) < 0.01);
    check('MV: A gross_profit = 500 (1500 − 10×100)', Math.abs(mvA.gross_profit - 500) < 0.01);
  }
  // ProductDead never sold → must NOT appear in fast or slow (slow excludes zero-sales)
  const inFast = (mv.body.fast || []).some((p) => p.product_id === prodDead.product_id);
  const inSlow = (mv.body.slow || []).some((p) => p.product_id === prodDead.product_id);
  check('MV: zero-sales product NOT in fast', !inFast);
  check('MV: zero-sales product NOT in slow', !inSlow);
  check('MV: dead_stock_count delta = +1',
    mv.body.totals.dead_stock_count >= baseMov.body.totals.dead_stock_count + 1,
    `before=${baseMov.body.totals.dead_stock_count} after=${mv.body.totals.dead_stock_count}`);

  // Fast vs slow ordering: ProductA (10) should rank ahead of ProductB (5) in fast,
  // and ProductB should rank ahead of ProductA in slow.
  if (mv.body.fast && mvA && mvB) {
    const idxA = mv.body.fast.findIndex((p) => p.product_id === prodA.product_id);
    const idxB = mv.body.fast.findIndex((p) => p.product_id === prodB.product_id);
    check('MV: fast — A ranks ahead of B', idxA < idxB);
  }

  // ── Period filter — empty future window ────────────────────────────────
  const future = await callCtrl(ops.salesRegister, { from_date: '2099-01-01', to_date: '2099-12-31' });
  check('Empty period: salesRegister bills empty', (future.body.bills || []).length === 0);
  check('Empty period: salesRegister totals zero',
    future.body.totals.bills_count === 0 && future.body.totals.total === 0);

  const futureMov = await callCtrl(ops.movers, { from_date: '2099-01-01', to_date: '2099-12-31', limit: 10 });
  check('Empty period: movers fast empty', (futureMov.body.fast || []).length === 0);
  check('Empty period: movers slow empty', (futureMov.body.slow || []).length === 0);

  // ── Cancelled bills don't appear ──────────────────────────────────────
  await SalesBill.update({ is_cancelled: true }, { where: { sales_bill_id: salBill.sales_bill_id } });
  const sr2 = await callCtrl(ops.salesRegister, { from_date: FROM, to_date: TO });
  const stillThere = (sr2.body.bills || []).find((b) => b.bill_number === `${PFX}SAL-1`);
  check('Cancelled bill excluded from Sales Register', !stillThere);
  // restore for cleanup invariance
  await SalesBill.update({ is_cancelled: false }, { where: { sales_bill_id: salBill.sales_bill_id } });

  // ── HSN Summary handles missing hsn gracefully ────────────────────────
  // Insert a sales bill with an item that has empty hsn_code; should
  // bucket under "(no HSN)".
  const t3 = await sequelize.transaction();
  const noHsnBill = await SalesBill.create({
    bill_number: `${PFX}SAL-NOHSN`, bill_date: '2025-07-01',
    customer_id: cust.party_id,
    sub_total: 100, total_amount: 100, balance_amount: 100,
  }, { transaction: t3 });
  await SalesBillItem.create({
    sales_bill_id: noHsnBill.sales_bill_id, product_id: prodA.product_id,
    barcode: prodA.barcode, product_name: prodA.product_name, hsn_code: '',
    unit_type: 'Pcs', quantity: 1, rate: 100, taxable_amount: 100, total_amount: 100,
  }, { transaction: t3 });
  await t3.commit();
  const hs2 = await callCtrl(ops.hsnSummary, { from_date: FROM, to_date: TO, direction: 'sales' });
  const noHsnRow = (hs2.body.hsn || []).find((r) => r.hsn_code === '(no HSN)');
  check('HSN-S: empty HSN bucketed under "(no HSN)"', !!noHsnRow);

  // ── Cleanup ────────────────────────────────────────────────────────────
  await preClean();
  await SystemSettings.update({
    financial_year_start: '2026-04-01', financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase R3 Self-Test (Registers + HSN + Stock + Movers) ──');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
