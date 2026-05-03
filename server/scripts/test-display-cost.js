#!/usr/bin/env node
/*
 * Display-cost integration tests. Run with:
 *   node server/scripts/test-display-cost.js
 *
 * Verifies productController.getById attaches mode-aware display_cost
 * + display_stock_value derived fields. Three modes:
 *   • variant            → purchase_rate / current_stock × purchase_rate
 *   • single, no batch   → weighted_avg_cost / current_stock × wac
 *   • single + batch     → batch-weighted avg / SUM(qty × rate) across
 *                          active batches with stock
 *
 * Stock Movement transaction TABLE rows are NOT exercised here — they
 * read per-row stock_ledger.rate directly and intentionally bypass this
 * helper. Tile / aggregate displays only.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Product, ProductBatch, ProductBatchStock, Godown, User, Role,
  Party, SystemSettings,
} = require('../models');
const purchaseController = require('../controllers/purchaseController');
const productController = require('../controllers/productController');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TDC_';

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
  const testBillSel = `(SELECT purchase_bill_id FROM purchase_bills WHERE supplier_id IN ${testSuppSel})`;

  await sequelize.query(`DELETE FROM stock_ledger WHERE product_id IN ${testProdSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN ${testBillSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM ledger_entries WHERE source_type IN ('purchase_bill','purchase_bill_payment') AND reference_id IN ${testBillSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${testSuppSel})`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM payments_receipts WHERE party_id IN ${testSuppSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM purchase_bills WHERE supplier_id IN ${testSuppSel}`,
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
}

async function fetchEnriched(productId) {
  const res = mockRes();
  await productController.getById({ params: { id: productId } }, res);
  return res._body;
}

async function runTests() {
  await cleanup();

  const admin = await User.findOne({ include: [{ model: Role }], where: { username: 'admin' } });
  const godown = await Godown.findOne({ where: { is_default: true } });
  const supp = await Party.create({
    party_name: FIXTURE_PREFIX + 'supp', party_type: 'Supplier',
    mobile_1: '9000099001', is_active: true,
  });
  await SystemSettings.update({ batch_tracking_enabled: true }, { where: { setting_id: 1 } });

  // ── Variant: display_cost = purchase_rate ───────────────────────────
  const variantProd = await Product.create({
    barcode: FIXTURE_PREFIX + 'V1', product_name: FIXTURE_PREFIX + 'Variant SKU',
    purchase_rate: 80, sale_rate: 120, mrp: 150, current_stock: 25,
    product_mode: 'variant',
  });
  {
    const got = await fetchEnriched(variantProd.product_id);
    check('VARIANT: display_cost = purchase_rate (80)',
      near(got.display_cost, 80), `got=${got.display_cost}`);
    check('VARIANT: display_stock_value = current_stock × purchase_rate (25 × 80 = 2000)',
      near(got.display_stock_value, 2000), `got=${got.display_stock_value}`);
  }

  // ── Single, no batch: display_cost = weighted_avg_cost ──────────────
  const singleProd = await Product.create({
    barcode: FIXTURE_PREFIX + 'S1', product_name: FIXTURE_PREFIX + 'Single SKU',
    purchase_rate: 100, sale_rate: 130, mrp: 150, current_stock: 0,
    product_mode: 'single',
  });
  // Drive wac via real purchases so it lands on the row authentically.
  const buildReq = (body) => ({ user: admin, params: {}, body });
  await purchaseController.create(buildReq({
    bill_date: '2026-05-03',
    supplier_id: supp.party_id,
    godown_id: godown.godown_id,
    items: [{
      product_id: singleProd.product_id, product_name: singleProd.product_name,
      barcode: singleProd.barcode, quantity: 10, purchase_rate: 100,
      sale_rate: 130, mrp: 150, gst_rate: 0,
    }],
  }), mockRes());
  await purchaseController.create(buildReq({
    bill_date: '2026-05-03',
    supplier_id: supp.party_id,
    godown_id: godown.godown_id,
    items: [{
      product_id: singleProd.product_id, product_name: singleProd.product_name,
      barcode: singleProd.barcode, quantity: 5, purchase_rate: 120,
      sale_rate: 130, mrp: 150, gst_rate: 0,
    }],
  }), mockRes());
  // Expected wac after (10×100 + 5×120)/15 = 106.6667; stock = 15.
  {
    const got = await fetchEnriched(singleProd.product_id);
    check('SINGLE no-batch: display_cost = weighted_avg_cost (106.6667)',
      near(got.display_cost, 106.6667), `got=${got.display_cost}`);
    check('SINGLE no-batch: display_stock_value = stock × wac (15 × 106.6667 = 1600)',
      near(got.display_stock_value, 1600), `got=${got.display_stock_value}`);
    check('SINGLE no-batch: catalog purchase_rate untouched (still 100, frozen)',
      near(got.purchase_rate, 100), `got=${got.purchase_rate}`);
  }

  // ── Single + batch: display_cost = batch-weighted avg ───────────────
  const batchProd = await Product.create({
    barcode: FIXTURE_PREFIX + 'B1', product_name: FIXTURE_PREFIX + 'Batch SKU',
    purchase_rate: 5, sale_rate: 8, mrp: 10, current_stock: 0,
    product_mode: 'single', is_batch_tracked: true,
  });
  // LOT-A: 100 units @ ₹5
  await purchaseController.create(buildReq({
    bill_date: '2026-05-03',
    supplier_id: supp.party_id,
    godown_id: godown.godown_id,
    items: [{
      product_id: batchProd.product_id, product_name: batchProd.product_name,
      barcode: batchProd.barcode, quantity: 100, purchase_rate: 5,
      gst_rate: 0, batch_number: 'LOT-A',
    }],
  }), mockRes());
  // LOT-B: 50 units @ ₹7
  await purchaseController.create(buildReq({
    bill_date: '2026-05-03',
    supplier_id: supp.party_id,
    godown_id: godown.godown_id,
    items: [{
      product_id: batchProd.product_id, product_name: batchProd.product_name,
      barcode: batchProd.barcode, quantity: 50, purchase_rate: 7,
      gst_rate: 0, batch_number: 'LOT-B',
    }],
  }), mockRes());
  // Expected: (100×5 + 50×7)/(100+50) = (500 + 350)/150 = 850/150 = 5.6667
  // Stock value: 850
  {
    const got = await fetchEnriched(batchProd.product_id);
    check('SINGLE+BATCH: display_cost = batch-weighted ((100×5 + 50×7)/150 = 5.6667)',
      near(got.display_cost, 5.6667), `got=${got.display_cost}`);
    check('SINGLE+BATCH: display_stock_value = SUM(qty × rate) = 850',
      near(got.display_stock_value, 850), `got=${got.display_stock_value}`);
    check('SINGLE+BATCH: weighted_avg_cost stays NULL (batch products skip wac)',
      got.weighted_avg_cost == null, `got=${got.weighted_avg_cost}`);
  }

  // ── Cleanup
  await sequelize.query(`DELETE FROM stock_ledger WHERE product_id IN (:ids)`, {
    replacements: { ids: [variantProd.product_id, singleProd.product_id, batchProd.product_id] },
  });
}

async function main() {
  console.log('━━━ Display-cost tile derivation tests ━━━');
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
