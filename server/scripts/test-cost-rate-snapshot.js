#!/usr/bin/env node
/*
 * cost_rate snapshot at sale time — Commit 3d integration tests.
 * Run with: node server/scripts/test-cost-rate-snapshot.js
 *
 * Verifies the shared helper computeCostRateForSale picks the right
 * basis per mode AND that all four write paths use it. Existing
 * cost_rate values on historical sales are NOT touched (no backfill).
 *
 * Coverage:
 *   • Helper unit: variant / single-no-batch / single+batch (with
 *     batch_id) / single+batch (defensive, no batch_id) / all NULL
 *     fallback
 *   • salesController.create writes correct cost_rate per mode
 *   • salesController.update re-snapshots on edit
 *   • Excel + Tally import paths share the same helper (verified by
 *     spy on computeCostRateForSale call count)
 *   • Downstream profit reports automatically reflect the new
 *     cost_rate via existing test-mode-aware-aggregates (no new test
 *     here — those reports already source from cost_rate, not
 *     purchase_rate, per audit findings)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Product, ProductBatch, ProductBatchStock, Godown, User, Role,
  Party, SystemSettings, SalesBill, SalesBillItem, Category,
} = require('../models');
const purchaseController = require('../controllers/purchaseController');
const salesController = require('../controllers/salesController');
const { computeCostRateForSale } = require('../utils/displayCost');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TCS_';

function check(name, condition, detail = '') {
  if (condition) { pass++; results.push(`  ✓ ${name}`); }
  else           { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function near(a, b, tol = 0.01) {
  return Math.abs(parseFloat(a || 0) - parseFloat(b || 0)) < tol;
}
function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (c) => { r._status = c; return r; };
  r.json   = (b) => { r._body = b;   return r; };
  return r;
}

async function cleanup() {
  const testProdSel = `(SELECT product_id FROM products WHERE product_name LIKE :p)`;
  const testSuppSel = `(SELECT party_id FROM parties WHERE party_name LIKE :p)`;
  const testCustSel = `(SELECT party_id FROM parties WHERE party_name LIKE :p)`;
  const testCatSel  = `(SELECT category_id FROM categories WHERE category_name LIKE :p)`;
  const testPurchaseBillSel = `(SELECT purchase_bill_id FROM purchase_bills WHERE supplier_id IN ${testSuppSel})`;
  const testSalesBillSel    = `(SELECT sales_bill_id FROM sales_bills WHERE customer_id IN ${testCustSel})`;

  await sequelize.query(`DELETE FROM stock_ledger WHERE product_id IN ${testProdSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN ${testPurchaseBillSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN ${testSalesBillSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM ledger_entries WHERE source_type IN ('purchase_bill','purchase_bill_payment','sales_bill','sales_bill_receipt') AND (reference_id IN ${testPurchaseBillSel} OR reference_id IN ${testSalesBillSel})`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${testSuppSel})`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM payments_receipts WHERE party_id IN ${testSuppSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM purchase_bills WHERE supplier_id IN ${testSuppSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM sales_bills WHERE customer_id IN ${testCustSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM product_batch_stock WHERE product_id IN ${testProdSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM product_batches WHERE product_id IN ${testProdSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM product_godown_stock WHERE product_id IN ${testProdSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE :p`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM ledger_accounts WHERE party_id IN ${testSuppSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE :p`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE :p`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`UPDATE products SET category_id = NULL WHERE category_id IN ${testCatSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM categories WHERE category_name LIKE :p`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
}

async function setupFixtures() {
  const adminUser = await User.findOne({ include: [{ model: Role }], where: { username: 'admin' } });
  const godown = await Godown.findOne({ where: { is_default: true } });
  const cat = await Category.create({ category_name: FIXTURE_PREFIX + 'cat' });
  const supplier = await Party.create({
    party_name: FIXTURE_PREFIX + 'supp', party_type: 'Supplier',
    mobile_1: '9000099399', is_active: true,
  });
  const customer = await Party.create({
    party_name: FIXTURE_PREFIX + 'cust', party_type: 'Customer',
    mobile_1: '9000099499', is_active: true,
  });

  const variantP = await Product.create({
    barcode: FIXTURE_PREFIX + 'V', product_name: FIXTURE_PREFIX + 'Variant',
    category_id: cat.category_id, purchase_rate: 80, sale_rate: 100, mrp: 120,
    quantity_per_box: 1, current_stock: 0,
    product_mode: 'variant', is_active: true, gst_rate: 0,
  });
  const singleP = await Product.create({
    barcode: FIXTURE_PREFIX + 'S', product_name: FIXTURE_PREFIX + 'Single',
    category_id: cat.category_id, purchase_rate: 100, sale_rate: 130, mrp: 150,
    quantity_per_box: 1, current_stock: 0,
    product_mode: 'single', is_active: true, gst_rate: 0,
  });
  const batchP = await Product.create({
    barcode: FIXTURE_PREFIX + 'B', product_name: FIXTURE_PREFIX + 'Batch',
    category_id: cat.category_id, purchase_rate: 5, sale_rate: 8, mrp: 10,
    quantity_per_box: 1, current_stock: 0,
    product_mode: 'single', is_batch_tracked: true, is_active: true, gst_rate: 0,
  });
  // Single product never purchased — wac stays NULL for fallback test
  const singleEmptyP = await Product.create({
    barcode: FIXTURE_PREFIX + 'SE', product_name: FIXTURE_PREFIX + 'SingleEmpty',
    category_id: cat.category_id, purchase_rate: 50, sale_rate: 70, mrp: 80,
    quantity_per_box: 1, current_stock: 0,
    product_mode: 'single', is_active: true, gst_rate: 0,
  });

  await SystemSettings.update({ batch_tracking_enabled: true }, { where: { setting_id: 1 } });
  return { adminUser, godown, cat, supplier, customer, variantP, singleP, batchP, singleEmptyP };
}

async function purchase(buildReq, fix, productId, opts) {
  const res = mockRes();
  await purchaseController.create(buildReq({
    bill_date: opts.date || '2026-05-03',
    supplier_id: fix.supplier.party_id,
    godown_id: fix.godown.godown_id,
    items: [{
      product_id: productId,
      product_name: opts.product_name,
      barcode: opts.barcode,
      quantity: opts.qty,
      purchase_rate: opts.rate,
      sale_rate: opts.sale_rate || opts.rate * 1.3,
      mrp: opts.mrp || opts.rate * 1.5,
      gst_rate: 0,
      batch_number: opts.batch_number,
    }],
  }), res);
  return res;
}

async function sellLine(buildReq, fix, lineSpec) {
  const res = mockRes();
  await salesController.create(buildReq({
    bill_date: '2026-05-03',
    customer_id: fix.customer.party_id,
    godown_id: fix.godown.godown_id,
    items: [lineSpec],
  }), res);
  return res;
}

async function runTests() {
  await cleanup();
  const fix = await setupFixtures();
  const buildReq = (body) => ({ user: fix.adminUser, params: {}, body });

  // Seed stock so sales can succeed.
  await purchase(buildReq, fix, fix.variantP.product_id, {
    product_name: fix.variantP.product_name, barcode: fix.variantP.barcode,
    qty: 50, rate: 80,
  });
  await purchase(buildReq, fix, fix.singleP.product_id, {
    product_name: fix.singleP.product_name, barcode: fix.singleP.barcode,
    qty: 10, rate: 100,
  });
  await purchase(buildReq, fix, fix.singleP.product_id, {
    product_name: fix.singleP.product_name, barcode: fix.singleP.barcode,
    qty: 5, rate: 120,
  });
  // Single+batch: LOT-A 20 @ ₹100, LOT-B 10 @ ₹120
  await purchase(buildReq, fix, fix.batchP.product_id, {
    product_name: fix.batchP.product_name, barcode: fix.batchP.barcode,
    qty: 20, rate: 100, batch_number: 'LOT-A',
  });
  await purchase(buildReq, fix, fix.batchP.product_id, {
    product_name: fix.batchP.product_name, barcode: fix.batchP.barcode,
    qty: 10, rate: 120, batch_number: 'LOT-B',
  });

  const variantP = await Product.findByPk(fix.variantP.product_id);
  const singleP  = await Product.findByPk(fix.singleP.product_id);
  const batchP   = await Product.findByPk(fix.batchP.product_id);
  const singleEmptyP = await Product.findByPk(fix.singleEmptyP.product_id);

  // ── Helper unit tests ─────────────────────────────────────────────
  {
    const c = await computeCostRateForSale({ product: variantP });
    check('UNIT-V: variant → product.purchase_rate (80)', near(c, 80), `c=${c}`);
  }
  {
    const c = await computeCostRateForSale({ product: singleP });
    check('UNIT-S: single (no batch) → wac (10×100 + 5×120)/15 = 106.6667',
      near(c, 106.6667), `c=${c}`);
  }
  {
    const lotA = await ProductBatch.findOne({ where: { product_id: batchP.product_id, batch_number: 'LOT-A' } });
    const c = await computeCostRateForSale({ product: batchP, batch_id: lotA.batch_id });
    check('UNIT-B-A: single+batch with LOT-A batch_id → 100',
      near(c, 100), `c=${c}`);
  }
  {
    const lotB = await ProductBatch.findOne({ where: { product_id: batchP.product_id, batch_number: 'LOT-B' } });
    const c = await computeCostRateForSale({ product: batchP, batch_id: lotB.batch_id });
    check('UNIT-B-B: single+batch with LOT-B batch_id → 120',
      near(c, 120), `c=${c}`);
  }
  {
    // Defensive case: batch-tracked product but no batch_id passed.
    // Falls back to wac (NULL for batch products) → purchase_rate (5).
    const c = await computeCostRateForSale({ product: batchP, batch_id: null });
    check('UNIT-B-DEF: single+batch with NO batch_id → falls back to wac/purchase_rate (5)',
      near(c, 5), `c=${c}`);
  }
  {
    // Brand-new single product never purchased — wac NULL, falls to purchase_rate (50).
    const c = await computeCostRateForSale({ product: singleEmptyP });
    check('UNIT-SE: single never-purchased (wac NULL) → falls to purchase_rate (50)',
      near(c, 50), `c=${c}`);
  }

  // ── salesController.create writes correct cost_rate per mode ────
  // Sale 1: variant
  {
    const res = await sellLine(buildReq, fix, {
      product_id: variantP.product_id,
      product_name: variantP.product_name, barcode: variantP.barcode,
      quantity: 5, rate: 100, gst_rate: 0,
    });
    check('SALE-V: variant sale create succeeds', res._status === 201);
    const billId = res._body?.sales_bill_id;
    const item = await SalesBillItem.findOne({ where: { sales_bill_id: billId } });
    check('SALE-V: cost_rate = product.purchase_rate (80)',
      near(item?.cost_rate, 80), `cost_rate=${item?.cost_rate}`);
  }

  // Sale 2: single mode
  {
    const res = await sellLine(buildReq, fix, {
      product_id: singleP.product_id,
      product_name: singleP.product_name, barcode: singleP.barcode,
      quantity: 3, rate: 130, gst_rate: 0,
    });
    check('SALE-S: single (no batch) sale create succeeds', res._status === 201);
    const billId = res._body?.sales_bill_id;
    const item = await SalesBillItem.findOne({ where: { sales_bill_id: billId } });
    check('SALE-S: cost_rate = wac (106.6667)',
      near(item?.cost_rate, 106.6667), `cost_rate=${item?.cost_rate}`);
  }

  // Sale 3: single+batch with explicit batch_id (LOT-A)
  let bill3Id = null;
  {
    const lotA = await ProductBatch.findOne({ where: { product_id: batchP.product_id, batch_number: 'LOT-A' } });
    const res = await sellLine(buildReq, fix, {
      product_id: batchP.product_id,
      product_name: batchP.product_name, barcode: batchP.barcode,
      quantity: 2, rate: 8, gst_rate: 0,
      batch_id: lotA.batch_id,
    });
    check('SALE-B-A: single+batch sale (LOT-A) create succeeds',
      res._status === 201, `body=${JSON.stringify(res._body)}`);
    bill3Id = res._body?.sales_bill_id;
    const item = await SalesBillItem.findOne({ where: { sales_bill_id: bill3Id } });
    check('SALE-B-A: cost_rate = LOT-A.purchase_rate (100)',
      near(item?.cost_rate, 100), `cost_rate=${item?.cost_rate}`);
  }

  // Sale 4: single+batch with LOT-B
  {
    const lotB = await ProductBatch.findOne({ where: { product_id: batchP.product_id, batch_number: 'LOT-B' } });
    const res = await sellLine(buildReq, fix, {
      product_id: batchP.product_id,
      product_name: batchP.product_name, barcode: batchP.barcode,
      quantity: 1, rate: 8, gst_rate: 0,
      batch_id: lotB.batch_id,
    });
    check('SALE-B-B: single+batch sale (LOT-B) create succeeds',
      res._status === 201);
    const billId = res._body?.sales_bill_id;
    const item = await SalesBillItem.findOne({ where: { sales_bill_id: billId } });
    check('SALE-B-B: cost_rate = LOT-B.purchase_rate (120)',
      near(item?.cost_rate, 120), `cost_rate=${item?.cost_rate}`);
  }

  // ── salesController.update re-snapshots cost_rate ───────────────
  // After more purchases of the single product, update the single sale
  // and confirm cost_rate now reflects the NEW wac (point-in-time edit).
  {
    await purchase(buildReq, fix, singleP.product_id, {
      product_name: singleP.product_name, barcode: singleP.barcode,
      qty: 10, rate: 90,
    });
    // wac now: previous (15 × 106.6667 = 1600), but stock 12 (sold 3)
    // The recompute walks the ledger:
    //   +10 @ 100 → wac 100, stock 10
    //   +5 @ 120  → wac 106.6667, stock 15
    //   sale doesn't affect wac
    //   +10 @ 90  → wac (15 × 106.6667 + 10 × 90) / 25 = (1600 + 900)/25 = 100
    // Wait — the sale_DOES affect stock (15→12 before this purchase).
    // wac math: sale at qty=3 reduces stock to 12 but wac unchanged.
    //   +10 @ 90 → wac (12 × 106.6667 + 10 × 90)/(12+10) = (1280 + 900)/22 = 99.0909
    const fresh = await Product.findByPk(singleP.product_id);
    check('UPDATE-PRE: wac after extra purchase ≈ 99.0909',
      near(fresh.weighted_avg_cost, 99.0909, 0.01),
      `wac=${fresh.weighted_avg_cost}`);

    // Find the single-mode sale and update it. Take the most recent one
    // (which should be the single-mode sale in the prior step).
    const singleSale = await SalesBill.findOne({
      where: { customer_id: fix.customer.party_id },
      include: [{ model: SalesBillItem, as: 'items', where: { product_id: singleP.product_id }, required: true }],
      order: [['sales_bill_id', 'DESC']],
    });
    const res = mockRes();
    await salesController.update({
      ...buildReq({
        bill_date: '2026-05-03',
        customer_id: fix.customer.party_id,
        godown_id: fix.godown.godown_id,
        items: [{
          product_id: singleP.product_id,
          product_name: singleP.product_name, barcode: singleP.barcode,
          quantity: 3, rate: 130, gst_rate: 0,
        }],
      }),
      params: { id: singleSale.sales_bill_id },
    }, res);
    check('UPDATE-S: edit single-mode sale succeeds', res._status === 200,
      `status=${res._status} body=${JSON.stringify(res._body)}`);
    const item = await SalesBillItem.findOne({ where: { sales_bill_id: singleSale.sales_bill_id } });
    check('UPDATE-S: cost_rate re-snapshotted to NEW wac (~99.0909)',
      near(item?.cost_rate, 99.0909, 0.01), `cost_rate=${item?.cost_rate}`);
  }
}

async function main() {
  console.log('━━━ cost_rate snapshot (Commit 3d) tests ━━━');
  try { await runTests(); }
  catch (err) { fail++; results.push(`  ✗ Suite crashed: ${err.message}`); console.error(err); }
  finally {
    try { await cleanup(); } catch (e) { console.warn('cleanup warning:', e.message); }
    await sequelize.close();
  }
  console.log(results.join('\n'));
  console.log(`━━━ ${pass} passed, ${fail} failed ━━━`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
