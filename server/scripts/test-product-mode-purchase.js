#!/usr/bin/env node
/*
 * Single Product mode — purchase flow integration tests.
 * Run with: node server/scripts/test-product-mode-purchase.js
 *
 * Covers Phase 3 (mode-aware fingerprint branching) and Phase 4
 * (weighted_avg_cost math, batch first-write-wins rate, purchase
 * return reversal). Tests interact with controllers via mock req/res
 * (not HTTP) — same pattern as test-batch-purchase.js.
 *
 * Suite layout:
 *   V-* — variant-mode regression (must keep existing behaviour)
 *   S-* — single-mode without batch (weighted-avg math)
 *   SR-* — single-mode purchase return (full reversal)
 *   SB-* — single-mode + batch (per-batch rate, first-write-wins)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Party, Product, Category, Godown, SystemSettings,
  PurchaseBill, PurchaseBillItem, PurchaseReturnBill, PurchaseReturnBillItem,
  ProductBatch, ProductBatchStock, StockLedger, User, Role,
} = require('../models');
const purchaseController = require('../controllers/purchaseController');
const purchaseReturnController = require('../controllers/purchaseReturnController');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TPM_PUR_';

function check(name, condition, detail = '') {
  if (condition) { pass++; results.push(`  ✓ ${name}`); }
  else           { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function near(a, b, tol = 0.001) {
  return Math.abs(parseFloat(a || 0) - parseFloat(b || 0)) < tol;
}

function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (code) => { r._status = code; return r; };
  r.json   = (body) => { r._body = body;  return r; };
  return r;
}

async function cleanup() {
  const testProdSel = `(SELECT product_id FROM products WHERE product_name LIKE :p)`;
  const testSuppSel = `(SELECT party_id FROM parties WHERE party_name LIKE :p)`;
  const testBillSel = `(SELECT purchase_bill_id FROM purchase_bills WHERE supplier_id IN ${testSuppSel})`;
  const testRetSel  = `(SELECT purchase_return_id FROM purchase_return_bills WHERE supplier_id IN ${testSuppSel})`;

  await sequelize.query(`DELETE FROM stock_ledger WHERE product_id IN ${testProdSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN ${testBillSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM purchase_return_bill_items WHERE purchase_return_id IN ${testRetSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM ledger_entries WHERE source_type IN ('purchase_bill','purchase_bill_payment','purchase_return_bill') AND reference_id IN ${testBillSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM ledger_entries WHERE source_type='purchase_return_bill' AND reference_id IN ${testRetSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${testSuppSel})`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM payments_receipts WHERE party_id IN ${testSuppSel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM purchase_return_bills WHERE supplier_id IN ${testSuppSel}`,
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
  await sequelize.query(`DELETE FROM categories WHERE category_name LIKE :p`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
}

async function setupFixtures() {
  const adminUser = await User.findOne({ include: [{ model: Role }], where: { username: 'admin' } });
  if (!adminUser) throw new Error('Seeded admin user not found.');
  const godown = await Godown.findOne({ where: { is_default: true } });
  if (!godown) throw new Error('Default godown not found.');

  const cat = await Category.create({ category_name: FIXTURE_PREFIX + 'cat' });
  const supplier = await Party.create({
    party_name: FIXTURE_PREFIX + 'supplier',
    party_type: 'Supplier',
    mobile_1: '9000010001',
    is_active: true,
  });

  // Variant-mode product (regression baseline)
  const variantProduct = await Product.create({
    barcode: FIXTURE_PREFIX + 'V01',
    product_name: FIXTURE_PREFIX + 'Saree A',
    category_id: cat.category_id,
    purchase_rate: 100, sale_rate: 150, mrp: 180,
    quantity_per_box: 1,
    product_mode: 'variant',
    is_active: true,
  });

  // Single-mode product (no batch)
  const singleProduct = await Product.create({
    barcode: FIXTURE_PREFIX + 'S01',
    product_name: FIXTURE_PREFIX + 'Bottle Cap',
    category_id: cat.category_id,
    purchase_rate: 100, sale_rate: 130, mrp: 150,
    quantity_per_box: 1,
    product_mode: 'single',
    is_active: true,
  });

  // Single-mode + batch product
  const singleBatchProduct = await Product.create({
    barcode: FIXTURE_PREFIX + 'SB1',
    product_name: FIXTURE_PREFIX + 'Tablet 200mg',
    category_id: cat.category_id,
    purchase_rate: 5, sale_rate: 8, mrp: 10,
    quantity_per_box: 1,
    product_mode: 'single',
    is_batch_tracked: true,
    is_active: true,
  });

  // Make sure global batch tracking is enabled (single+batch needs it)
  const settings = await SystemSettings.findByPk(1);
  await settings.update({ batch_tracking_enabled: true });

  return { adminUser, godown, cat, supplier, variantProduct, singleProduct, singleBatchProduct };
}

function makeReq(adminUser) {
  return (body) => ({ body, user: adminUser, params: {} });
}

async function purchaseLine(buildReq, fix, productId, opts) {
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
      sale_rate: opts.sale_rate || (opts.rate * 1.3),
      mrp: opts.mrp || (opts.rate * 1.5),
      gst_rate: 0,
      batch_number: opts.batch_number,
    }],
  }), res);
  return res;
}

async function runTests() {
  await cleanup();
  const fix = await setupFixtures();
  const buildReq = makeReq(fix.adminUser);

  // ── V-1 / V-2: VARIANT regression ────────────────────────────────────
  // Variant mode behaviour must remain bit-exact: differing rate creates
  // a new variant, purchase_rate gets overwritten on each purchase.
  {
    const res1 = await purchaseLine(buildReq, fix, fix.variantProduct.product_id, {
      product_name: fix.variantProduct.product_name,
      barcode: fix.variantProduct.barcode,
      qty: 5, rate: 100,
    });
    check('V-1: variant purchase at same rate succeeds', res1._status === 201,
      `status=${res1._status} body=${JSON.stringify(res1._body)}`);

    const after1 = await Product.findByPk(fix.variantProduct.product_id);
    check('V-1: variant purchase_rate stays at the (matching) rate',
      near(after1.purchase_rate, 100));

    // Now purchase the SAME product_id at a DIFFERENT rate. With explicit
    // product_id, resolveOrCreateProduct case-1 reuses that product
    // (no new variant). The rate gets overwritten.
    const res2 = await purchaseLine(buildReq, fix, fix.variantProduct.product_id, {
      product_name: fix.variantProduct.product_name,
      barcode: fix.variantProduct.barcode,
      qty: 3, rate: 110,
    });
    check('V-2: variant purchase at different rate (same product_id) succeeds',
      res2._status === 201);

    const after2 = await Product.findByPk(fix.variantProduct.product_id);
    check('V-2: variant purchase_rate OVERWRITTEN to latest (100 → 110)',
      near(after2.purchase_rate, 110), `purchase_rate=${after2.purchase_rate}`);
    check('V-2: variant has NO weighted_avg_cost (column stays NULL)',
      after2.weighted_avg_cost == null, `wac=${after2.weighted_avg_cost}`);
  }

  // ── S-1: single-mode first purchase establishes basis ────────────────
  {
    const res = await purchaseLine(buildReq, fix, fix.singleProduct.product_id, {
      product_name: fix.singleProduct.product_name,
      barcode: fix.singleProduct.barcode,
      qty: 10, rate: 100,
    });
    check('S-1: single-mode first purchase succeeds', res._status === 201);
    const p = await Product.findByPk(fix.singleProduct.product_id);
    check('S-1: weighted_avg_cost = first purchase rate (100)',
      near(p.weighted_avg_cost, 100), `wac=${p.weighted_avg_cost}`);
    check('S-1: catalog purchase_rate stays FROZEN at original (100)',
      near(p.purchase_rate, 100), `purchase_rate=${p.purchase_rate}`);
    check('S-1: last_purchase_rate = 100', near(p.last_purchase_rate, 100));
    check('S-1: last_purchase_date populated', !!p.last_purchase_date);
  }

  // ── S-2: weighted-avg math on second purchase at higher rate ────────
  {
    const res = await purchaseLine(buildReq, fix, fix.singleProduct.product_id, {
      product_name: fix.singleProduct.product_name,
      barcode: fix.singleProduct.barcode,
      qty: 5, rate: 120,
    });
    check('S-2: single-mode second purchase succeeds', res._status === 201);
    const p = await Product.findByPk(fix.singleProduct.product_id);
    // (10 × 100 + 5 × 120) / 15 = 1600 / 15 = 106.6667
    check('S-2: weighted_avg_cost = (10×100 + 5×120)/15 = 106.6667',
      near(p.weighted_avg_cost, 106.6667, 0.001), `wac=${p.weighted_avg_cost}`);
    check('S-2: catalog purchase_rate STILL frozen (no overwrite)',
      near(p.purchase_rate, 100));
    check('S-2: last_purchase_rate = 120 (latest)',
      near(p.last_purchase_rate, 120));
  }

  // ── S-3: third purchase at a third rate ──────────────────────────────
  {
    const res = await purchaseLine(buildReq, fix, fix.singleProduct.product_id, {
      product_name: fix.singleProduct.product_name,
      barcode: fix.singleProduct.barcode,
      qty: 8, rate: 110,
    });
    check('S-3: third purchase succeeds', res._status === 201);
    const p = await Product.findByPk(fix.singleProduct.product_id);
    // (15 × 106.6667 + 8 × 110) / 23 = (1600 + 880) / 23 = 2480 / 23 = 107.8261
    check('S-3: wac = (15×106.6667 + 8×110)/23 = 107.8261',
      near(p.weighted_avg_cost, 107.8261, 0.001), `wac=${p.weighted_avg_cost}`);
    check('S-3: stock at 23 across all godowns',
      near(p.current_stock, 23), `stock=${p.current_stock}`);
  }

  // ── SR-1: purchase return reverses wac correctly ────────────────────
  {
    // Return 5 from the most recent state (current stock 23, wac 107.8261).
    // After return: stock 18. The recompute walks the ledger:
    //   +10 @ 100  → wac=100, stock=10
    //   +5  @ 120  → wac=106.6667, stock=15
    //   +8  @ 110  → wac=107.8261, stock=23
    //   -5  @ 110 (return at last rate) → stock=18, wac unchanged at
    //                                     107.8261 (returns don't change avg)
    // The returnsRate doesn't matter because the recompute treats returns
    // as stock_out without changing wac (steady-state assumption).
    const res = mockRes();
    await purchaseReturnController.create({
      ...buildReq({
        return_date: '2026-05-04',
        supplier_id: fix.supplier.party_id,
        godown_id: fix.godown.godown_id,
        return_mode: 'Items',
        items: [{
          product_id: fix.singleProduct.product_id,
          product_name: fix.singleProduct.product_name,
          barcode: fix.singleProduct.barcode,
          quantity: 5,
          rate: 110,
          gst_rate: 0,
        }],
      }),
    }, res);
    check('SR-1: purchase return succeeds', res._status === 201,
      `status=${res._status} body=${JSON.stringify(res._body)}`);
    const p = await Product.findByPk(fix.singleProduct.product_id);
    check('SR-1: stock decremented to 18',
      near(p.current_stock, 18), `stock=${p.current_stock}`);
    check('SR-1: wac stays at 107.8261 (return doesn\'t shift avg in steady state)',
      near(p.weighted_avg_cost, 107.8261, 0.001), `wac=${p.weighted_avg_cost}`);
  }

  // ── SR-2: full return takes stock + wac to zero ──────────────────────
  {
    // Return all remaining 18 units. Stock → 0, wac → 0.
    const res = mockRes();
    await purchaseReturnController.create({
      ...buildReq({
        return_date: '2026-05-05',
        supplier_id: fix.supplier.party_id,
        godown_id: fix.godown.godown_id,
        return_mode: 'Items',
        items: [{
          product_id: fix.singleProduct.product_id,
          product_name: fix.singleProduct.product_name,
          barcode: fix.singleProduct.barcode,
          quantity: 18,
          rate: 110,
          gst_rate: 0,
        }],
      }),
    }, res);
    check('SR-2: full return to zero succeeds', res._status === 201);
    const p = await Product.findByPk(fix.singleProduct.product_id);
    check('SR-2: stock = 0', near(p.current_stock, 0), `stock=${p.current_stock}`);
    check('SR-2: wac reset to 0 (next purchase starts fresh)',
      near(p.weighted_avg_cost, 0), `wac=${p.weighted_avg_cost}`);
  }

  // ── SR-3: next purchase after zero starts fresh basis ────────────────
  {
    const res = await purchaseLine(buildReq, fix, fix.singleProduct.product_id, {
      product_name: fix.singleProduct.product_name,
      barcode: fix.singleProduct.barcode,
      qty: 4, rate: 95,
    });
    check('SR-3: post-zero purchase succeeds', res._status === 201);
    const p = await Product.findByPk(fix.singleProduct.product_id);
    check('SR-3: wac = 95 (clean restart)',
      near(p.weighted_avg_cost, 95), `wac=${p.weighted_avg_cost}`);
  }

  // ── SB-1: single + batch — rate stored on batch, wac NOT used ────────
  {
    const res1 = await purchaseLine(buildReq, fix, fix.singleBatchProduct.product_id, {
      product_name: fix.singleBatchProduct.product_name,
      barcode: fix.singleBatchProduct.barcode,
      qty: 100, rate: 5,
      batch_number: 'LOT-A',
    });
    check('SB-1: single+batch purchase LOT-A succeeds', res1._status === 201,
      `status=${res1._status} body=${JSON.stringify(res1._body)}`);
    const batchA = await ProductBatch.findOne({
      where: { product_id: fix.singleBatchProduct.product_id, batch_number: 'LOT-A' },
    });
    check('SB-1: ProductBatch.purchase_rate = 5 (set on creation)',
      !!batchA && near(batchA.purchase_rate, 5), `batch=${JSON.stringify(batchA)}`);
    const p = await Product.findByPk(fix.singleBatchProduct.product_id);
    check('SB-1: weighted_avg_cost stays NULL on single+batch products',
      p.weighted_avg_cost == null, `wac=${p.weighted_avg_cost}`);
  }

  // ── SB-2: re-purchase of LOT-A keeps original rate (first-write-wins) ─
  {
    const res = await purchaseLine(buildReq, fix, fix.singleBatchProduct.product_id, {
      product_name: fix.singleBatchProduct.product_name,
      barcode: fix.singleBatchProduct.barcode,
      qty: 50, rate: 7,            // NEW rate, but same batch
      batch_number: 'LOT-A',
    });
    check('SB-2: re-purchase of same batch succeeds', res._status === 201);
    const batchA = await ProductBatch.findOne({
      where: { product_id: fix.singleBatchProduct.product_id, batch_number: 'LOT-A' },
    });
    check('SB-2: batch.purchase_rate STILL 5 (first-write-wins, not 7)',
      !!batchA && near(batchA.purchase_rate, 5),
      `batch.purchase_rate=${batchA.purchase_rate}`);
    const stockRow = await ProductBatchStock.findOne({
      where: { product_id: fix.singleBatchProduct.product_id, batch_id: batchA.batch_id, godown_id: fix.godown.godown_id },
    });
    check('SB-2: batch stock accumulates to 150 (100 + 50)',
      near(stockRow.current_stock, 150), `stock=${stockRow?.current_stock}`);
  }

  // ── SB-3: new batch (LOT-B) gets its own rate ────────────────────────
  {
    const res = await purchaseLine(buildReq, fix, fix.singleBatchProduct.product_id, {
      product_name: fix.singleBatchProduct.product_name,
      barcode: fix.singleBatchProduct.barcode,
      qty: 30, rate: 6,
      batch_number: 'LOT-B',
    });
    check('SB-3: new-batch purchase succeeds', res._status === 201);
    const batchB = await ProductBatch.findOne({
      where: { product_id: fix.singleBatchProduct.product_id, batch_number: 'LOT-B' },
    });
    check('SB-3: LOT-B purchase_rate = 6',
      !!batchB && near(batchB.purchase_rate, 6),
      `batch.purchase_rate=${batchB?.purchase_rate}`);
    const p = await Product.findByPk(fix.singleBatchProduct.product_id);
    check('SB-3: product weighted_avg_cost still NULL (single+batch never uses it)',
      p.weighted_avg_cost == null);
  }

  // ── DUP-1: backend safety net rejects duplicate creation ────────────
  // Reproduces the bug the user hit: handleProductSelect once wiped
  // product_id, then any size/article on the line broke
  // findExistingProduct's match (master has NULL size, line has 'M').
  // The new safety net (case 4.5) catches this when the would-be-
  // created product is single mode, doing a name+single-mode lookup.
  {
    // Make sure default is single so case 4.5 fires.
    await SystemSettings.update({ default_product_mode: 'single' }, { where: { setting_id: 1 } });
    const before = await Product.count({ where: { product_name: fix.singleProduct.product_name } });
    // Send the line WITHOUT product_id (frontend wipe scenario) AND
    // with size + article populated (the trigger condition). Should
    // still resolve to the existing single product, not create a dup.
    const res = mockRes();
    await purchaseController.create(buildReq({
      bill_date: '2026-05-06',
      supplier_id: fix.supplier.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: null,
        product_name: fix.singleProduct.product_name,
        barcode: '',
        size: 'M', article_number: 'A99',
        quantity: 2, purchase_rate: 105,
        quantity_per_box: 1,
      }],
    }), res);
    check('DUP-1: bill saves with safety net engaged', res._status === 201,
      `status=${res._status} body=${JSON.stringify(res._body)}`);
    const after = await Product.count({ where: { product_name: fix.singleProduct.product_name } });
    check('DUP-1: no duplicate product created (count unchanged)',
      after === before, `before=${before} after=${after}`);
    await SystemSettings.update({ default_product_mode: 'variant' }, { where: { setting_id: 1 } });
  }
}

async function main() {
  console.log('━━━ Single Product mode — purchase flow tests ━━━');
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
