#!/usr/bin/env node
/*
 * Batch tracking — sales / sales-return / purchase-return integration.
 * Run with: node server/scripts/test-batch-sales.js
 *
 * Exits 0 on full pass, 1 on any failure. All fixtures get the prefix
 * `_TBS_` so cleanup can target them safely without touching real data.
 *
 * Coverage (matches Commit-3 brief):
 *   ── Endpoint ─────────────────────────────────────────────────────────
 *     E1   GET /products/:id/batches returns active stock-bearing batches
 *     E2   FEFO ordering when any batch has expiry_date set
 *     E3   FIFO ordering when no batch has expiry_date set
 *     E4   Excludes batches with current_stock <= 0 at the godown
 *     E5   Other-godown batches don't leak in
 *
 *   ── Sales create ────────────────────────────────────────────────────
 *     S-CREATE-1   sales_bill_items.batch_id persisted
 *     S-CREATE-2   stock_ledger.batch_id persisted
 *     S-CREATE-3   product_batch_stock decremented at (product, batch, godown)
 *     S-CREATE-4   cost_rate snapshotted from batch.purchase_rate
 *     S-CREATE-5   Reject batch-tracked product without batch_id
 *     S-CREATE-6   Sell more than batch on hand → blocked
 *     S-CREATE-7   block_expired_sales=true + expired batch → blocked
 *     S-CREATE-8   block_expired_sales=false + expired batch → allowed
 *
 *   ── Sales cancel + edit cascade ─────────────────────────────────────
 *     S-CANCEL-1   Cancel restores batch stock at the originating batch
 *     S-EDIT-1     Edit qty restocks old batch by old qty, decrements new qty
 *     S-EDIT-2     Edit batch_id reverses old batch fully, applies new fully
 *
 *   ── Sales return ─────────────────────────────────────────────────────
 *     SR-CREATE-1  Sales return with batch_id increments product_batch_stock
 *     SR-CREATE-2  stock_ledger row carries batch_id
 *     SR-CANCEL    Sales return cancel decrements batch stock back
 *
 *   ── Purchase return ─────────────────────────────────────────────────
 *     PR-CREATE-1  Purchase return with batch_id decrements product_batch_stock
 *     PR-CREATE-2  stock_ledger row carries batch_id
 *
 *   ── Mode interactions ──────────────────────────────────────────────
 *     M1   Global batch_tracking_enabled=false → batch_id silently NULL
 *     M2   Variant-mode product → no batch enforcement
 *
 *   ── Integrity invariant ────────────────────────────────────────────
 *     I7-1   After all operations, SUM(batch_stock) == products.current_stock
 *     I7-2   I7 surfaces a violation when batch_stock and product_stock drift
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Party, Product, Category, Godown, SystemSettings,
  PurchaseBill, PurchaseBillItem, SalesBill, SalesBillItem,
  SalesReturnBill, SalesReturnBillItem,
  PurchaseReturnBill, PurchaseReturnBillItem,
  ProductBatch, ProductBatchStock, StockLedger, User, Role,
} = require('../models');
const purchaseController = require('../controllers/purchaseController');
const salesController = require('../controllers/salesController');
const productController = require('../controllers/productController');
const salesReturnController = require('../controllers/salesReturnController');
const purchaseReturnController = require('../controllers/purchaseReturnController');
const { checkIntegrity } = require('../services/autoReceiptService');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TBS_';

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
  const testProd = `(SELECT product_id FROM products WHERE product_name LIKE :p)`;
  const testParty = `(SELECT party_id FROM parties WHERE party_name LIKE :p)`;
  const testPB = `(SELECT purchase_bill_id FROM purchase_bills WHERE supplier_id IN ${testParty})`;
  const testSB = `(SELECT sales_bill_id FROM sales_bills WHERE customer_id IN ${testParty})`;
  const testSRB = `(SELECT sales_return_id FROM sales_return_bills WHERE customer_id IN ${testParty})`;
  const testPRB = `(SELECT purchase_return_id FROM purchase_return_bills WHERE supplier_id IN ${testParty})`;

  const r = { p: FIXTURE_PREFIX + '%' };
  await sequelize.query(`DELETE FROM stock_ledger WHERE product_id IN ${testProd}`, { replacements: r });
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN ${testSB}`, { replacements: r });
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN ${testPB}`, { replacements: r });
  await sequelize.query(`DELETE FROM sales_return_bill_items WHERE sales_return_id IN ${testSRB}`, { replacements: r });
  await sequelize.query(`DELETE FROM purchase_return_bill_items WHERE purchase_return_id IN ${testPRB}`, { replacements: r });
  await sequelize.query(`DELETE FROM ledger_entries WHERE source_type IN ('sales_bill','sales_bill_receipt','purchase_bill','purchase_bill_payment','sales_return_bill','purchase_return_bill','payment_receipt') AND (reference_id IN ${testSB} OR reference_id IN ${testPB} OR reference_id IN ${testSRB} OR reference_id IN ${testPRB})`, { replacements: r });
  await sequelize.query(`DELETE FROM bill_payment_allocations WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${testParty})`, { replacements: r });
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${testParty})`, { replacements: r });
  await sequelize.query(`DELETE FROM payments_receipts WHERE party_id IN ${testParty}`, { replacements: r });
  await sequelize.query(`DELETE FROM sales_return_bills WHERE customer_id IN ${testParty}`, { replacements: r });
  await sequelize.query(`DELETE FROM purchase_return_bills WHERE supplier_id IN ${testParty}`, { replacements: r });
  await sequelize.query(`DELETE FROM sales_bills WHERE customer_id IN ${testParty}`, { replacements: r });
  await sequelize.query(`DELETE FROM purchase_bills WHERE supplier_id IN ${testParty}`, { replacements: r });
  await sequelize.query(`DELETE FROM product_batch_stock WHERE product_id IN ${testProd}`, { replacements: r });
  await sequelize.query(`DELETE FROM product_batches WHERE product_id IN ${testProd}`, { replacements: r });
  await sequelize.query(`DELETE FROM product_godown_stock WHERE product_id IN ${testProd}`, { replacements: r });
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE :p`, { replacements: r });
  await sequelize.query(`DELETE FROM ledger_accounts WHERE party_id IN ${testParty}`, { replacements: r });
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE :p`, { replacements: r });
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE :p`, { replacements: r });
  await sequelize.query(`UPDATE products SET category_id = NULL WHERE category_id IN (SELECT category_id FROM categories WHERE category_name LIKE :p)`, { replacements: r });
  await sequelize.query(`DELETE FROM categories WHERE category_name LIKE :p`, { replacements: r });
}

async function setupFixtures() {
  const adminUser = await User.findOne({ include: [{ model: Role }], where: { username: 'admin' } });
  const godown   = await Godown.findOne({ where: { is_default: true } });
  // Second godown for the cross-godown isolation test (E5)
  const godown2 = await Godown.findOne({ where: { is_default: false } })
    || await Godown.create({ code: FIXTURE_PREFIX + 'GD2', name: FIXTURE_PREFIX + 'Branch', is_default: false });

  const cat = await Category.create({ category_name: FIXTURE_PREFIX + 'cat' });
  const supplier = await Party.create({
    party_name: FIXTURE_PREFIX + 'supp', party_type: 'Supplier',
    mobile_1: '9100000010', is_active: true,
  });
  // credit_allowed=true so sales default to paid_amount=0 (credit) and
  // skip the auto-receipt path. With paid_amount > 0, salesController
  // creates an auto-receipt that the cancel guard refuses to cascade
  // through (the known cancel-guard / auto-receipt symmetry issue).
  const customer = await Party.create({
    party_name: FIXTURE_PREFIX + 'cust', party_type: 'Customer',
    mobile_1: '9100000020', is_active: true,
    credit_allowed: true,
  });

  // Two batch-tracked products (one for FEFO scenarios, one for FIFO).
  const fefoProd = await Product.create({
    barcode: FIXTURE_PREFIX + 'PHARMA',
    product_name: FIXTURE_PREFIX + 'Pharma Tablet',
    category_id: cat.category_id,
    purchase_rate: 10, sale_rate: 25, mrp: 30,
    quantity_per_box: 1, is_batch_tracked: true, is_active: true, gst_rate: 0,
    product_mode: 'single',
  });
  const fifoProd = await Product.create({
    barcode: FIXTURE_PREFIX + 'FOOD',
    product_name: FIXTURE_PREFIX + 'Food Item',
    category_id: cat.category_id,
    purchase_rate: 5, sale_rate: 12, mrp: 15,
    quantity_per_box: 1, is_batch_tracked: true, is_active: true, gst_rate: 0,
    product_mode: 'single',
  });
  // Variant-mode (non-batch) product for the M2 regression.
  const variantProd = await Product.create({
    barcode: FIXTURE_PREFIX + 'VAR',
    product_name: FIXTURE_PREFIX + 'Variant Item',
    category_id: cat.category_id,
    purchase_rate: 8, sale_rate: 14, mrp: 16,
    quantity_per_box: 1, is_active: true, gst_rate: 0,
    product_mode: 'variant',
  });

  const settings = await SystemSettings.findByPk(1);
  await settings.update({
    batch_tracking_enabled: true,
    block_expired_sales: false, // we toggle this per-test
  });

  return { adminUser, godown, godown2, cat, supplier, customer, fefoProd, fifoProd, variantProd };
}

const buildReq = (user) => (body) => ({ user, params: {}, body });
const purchase = async (buildReqFn, fix, productId, opts) => {
  const res = mockRes();
  await purchaseController.create(buildReqFn({
    bill_date: opts.date || '2026-05-03',
    supplier_id: fix.supplier.party_id,
    godown_id: opts.godown_id || fix.godown.godown_id,
    items: [{
      product_id: productId,
      product_name: opts.product_name,
      barcode: opts.barcode,
      quantity: opts.qty,
      purchase_rate: opts.rate,
      sale_rate: opts.sale_rate || opts.rate * 1.5,
      mrp: opts.mrp || opts.rate * 1.8,
      gst_rate: 0,
      batch_number: opts.batch_number,
      manufacture_date: opts.mfg || null,
      expiry_date: opts.exp || null,
    }],
  }), res);
  if (res._status !== 201 && res._status !== 200) {
    throw new Error(`Purchase failed (${res._status}): ${JSON.stringify(res._body)}`);
  }
  return res;
};

async function findBatch(productId, batchNumber) {
  return ProductBatch.findOne({ where: { product_id: productId, batch_number: batchNumber } });
}
async function batchStockAt(productId, batchId, godownId) {
  const row = await ProductBatchStock.findOne({
    where: { product_id: productId, batch_id: batchId, godown_id: godownId },
  });
  return row ? parseFloat(row.current_stock) : 0;
}

async function runTests() {
  await cleanup();
  const fix = await setupFixtures();
  const buildReqA = buildReq(fix.adminUser);

  // ── Seed: purchase 3 batches of fefoProd at 3 different rates + dates ──
  // FEFO setup: LOT-EARLY (exp 2025-06-01) is the earliest expiry → auto-pick.
  await purchase(buildReqA, fix, fix.fefoProd.product_id, {
    product_name: fix.fefoProd.product_name, barcode: fix.fefoProd.barcode,
    qty: 50, rate: 10, batch_number: 'LOT-EARLY',
    mfg: '2025-01-01', exp: '2025-06-01',
  });
  await purchase(buildReqA, fix, fix.fefoProd.product_id, {
    product_name: fix.fefoProd.product_name, barcode: fix.fefoProd.barcode,
    qty: 30, rate: 12, batch_number: 'LOT-MID',
    mfg: '2025-02-01', exp: '2026-01-01',
  });
  await purchase(buildReqA, fix, fix.fefoProd.product_id, {
    product_name: fix.fefoProd.product_name, barcode: fix.fefoProd.barcode,
    qty: 20, rate: 15, batch_number: 'LOT-LATE',
    mfg: '2025-03-01', exp: '2027-12-31',
  });

  // Seed FIFO product — three batches WITHOUT expiry dates, ordered by mfg.
  await purchase(buildReqA, fix, fix.fifoProd.product_id, {
    product_name: fix.fifoProd.product_name, barcode: fix.fifoProd.barcode,
    qty: 25, rate: 5, batch_number: 'FOOD-A', mfg: '2024-12-01',
  });
  await purchase(buildReqA, fix, fix.fifoProd.product_id, {
    product_name: fix.fifoProd.product_name, barcode: fix.fifoProd.barcode,
    qty: 15, rate: 6, batch_number: 'FOOD-B', mfg: '2025-01-15',
  });
  await purchase(buildReqA, fix, fix.fifoProd.product_id, {
    product_name: fix.fifoProd.product_name, barcode: fix.fifoProd.barcode,
    qty: 10, rate: 7, batch_number: 'FOOD-C', mfg: '2025-02-20',
  });

  // ── E1-E5: GET /products/:id/batches endpoint ─────────────────────────
  {
    const res = mockRes();
    await productController.getBatches(
      { params: { id: String(fix.fefoProd.product_id) }, query: { godown_id: String(fix.godown.godown_id) } },
      res,
    );
    const rows = res._body?.data || [];
    check('E1: endpoint returns rows for active batches with stock', rows.length === 3);
    check('E2: FEFO order — LOT-EARLY first (earliest expiry)',
      rows[0]?.batch_number === 'LOT-EARLY' && rows[1]?.batch_number === 'LOT-MID' && rows[2]?.batch_number === 'LOT-LATE');
  }
  {
    const res = mockRes();
    await productController.getBatches(
      { params: { id: String(fix.fifoProd.product_id) }, query: { godown_id: String(fix.godown.godown_id) } },
      res,
    );
    const rows = res._body?.data || [];
    check('E3: FIFO order — FOOD-A first (earliest mfg, no expiries)',
      rows[0]?.batch_number === 'FOOD-A' && rows[1]?.batch_number === 'FOOD-B' && rows[2]?.batch_number === 'FOOD-C');
  }

  // E4: drop a batch's stock to zero by selling all of it; endpoint hides it.
  {
    const lateBatch = await findBatch(fix.fefoProd.product_id, 'LOT-LATE');
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 20, rate: 25, gst_rate: 0,
        batch_id: lateBatch.batch_id,
      }],
    }), res);
    if (res._status !== 201 && res._status !== 200) throw new Error('seed-zero sale failed: ' + JSON.stringify(res._body));

    const ep = mockRes();
    await productController.getBatches(
      { params: { id: String(fix.fefoProd.product_id) }, query: { godown_id: String(fix.godown.godown_id) } },
      ep,
    );
    const rows = ep._body?.data || [];
    check('E4: zero-stock batch hidden from picker',
      rows.find(r => r.batch_number === 'LOT-LATE') === undefined);
  }

  // E5: batch with stock at godown1 only → endpoint at godown2 returns nothing.
  {
    const ep = mockRes();
    await productController.getBatches(
      { params: { id: String(fix.fefoProd.product_id) }, query: { godown_id: String(fix.godown2.godown_id) } },
      ep,
    );
    const rows = ep._body?.data || [];
    check('E5: cross-godown isolation — no batches at godown2', rows.length === 0);
  }

  // ── S-CREATE: sales create, batch_id wiring ──────────────────────────
  const earlyBatch = await findBatch(fix.fefoProd.product_id, 'LOT-EARLY');
  let saleAId;
  {
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 10, rate: 25, gst_rate: 0,
        batch_id: earlyBatch.batch_id,
      }],
    }), res);
    check('S-CREATE-1 (status 201)', res._status === 201, `status=${res._status} body=${JSON.stringify(res._body).slice(0, 200)}`);
    saleAId = res._body?.sales_bill_id;

    const item = await SalesBillItem.findOne({ where: { sales_bill_id: saleAId } });
    check('S-CREATE-1: sales_bill_items.batch_id persisted',
      item && parseInt(item.batch_id) === earlyBatch.batch_id);
    check('S-CREATE-4: cost_rate snapshotted from batch.purchase_rate (₹10)',
      item && near(item.cost_rate, 10));

    const sl = await StockLedger.findOne({
      where: { reference_id: saleAId, transaction_type: 'Sales' },
    });
    check('S-CREATE-2: stock_ledger.batch_id persisted',
      sl && parseInt(sl.batch_id) === earlyBatch.batch_id);

    const stock = await batchStockAt(fix.fefoProd.product_id, earlyBatch.batch_id, fix.godown.godown_id);
    check('S-CREATE-3: product_batch_stock decremented (50 → 40)', near(stock, 40));
  }

  // S-CREATE-5: batch-tracked product with no batch_id → reject.
  {
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 1, rate: 25, gst_rate: 0,
        // no batch_id
      }],
    }), res);
    check('S-CREATE-5: missing batch_id → 400',
      res._status === 400 && /batch-tracked/i.test(res._body?.error || ''));
  }

  // S-CREATE-6: sell more than batch on hand.
  {
    const midBatch = await findBatch(fix.fefoProd.product_id, 'LOT-MID');
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 9999, rate: 25, gst_rate: 0,
        batch_id: midBatch.batch_id,
      }],
    }), res);
    check('S-CREATE-6: over-batch qty → 400 with helpful message',
      res._status === 400 && /only \d+(\.\d+)? available/i.test(res._body?.error || ''));
  }

  // S-CREATE-7 + 8: expiry guard.
  // LOT-EARLY expired 2025-06-01, today is past that.
  {
    const settings = await SystemSettings.findByPk(1);
    await settings.update({ block_expired_sales: true });
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 1, rate: 25, gst_rate: 0,
        batch_id: earlyBatch.batch_id,
      }],
    }), res);
    check('S-CREATE-7: block_expired_sales=true blocks expired batch',
      res._status === 400 && /expired/i.test(res._body?.error || ''));

    await settings.update({ block_expired_sales: false });
    const res2 = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 1, rate: 25, gst_rate: 0,
        batch_id: earlyBatch.batch_id,
      }],
    }), res2);
    check('S-CREATE-8: block_expired_sales=false allows expired batch',
      res2._status === 201 || res2._status === 200);
  }

  // ── S-CANCEL: cancel restores batch stock ────────────────────────────
  {
    const before = await batchStockAt(fix.fefoProd.product_id, earlyBatch.batch_id, fix.godown.godown_id);
    const res = mockRes();
    await salesController.cancel({
      user: fix.adminUser, params: { id: String(saleAId) }, body: { reason: 'test cancel' },
    }, res);
    check('S-CANCEL (status 200)', res._status === 200, `status=${res._status} body=${JSON.stringify(res._body)}`);
    const after = await batchStockAt(fix.fefoProd.product_id, earlyBatch.batch_id, fix.godown.godown_id);
    check('S-CANCEL-1: cancel restored 10 units to LOT-EARLY',
      near(after, before + 10));
  }

  // ── S-EDIT: edit qty + edit batch ────────────────────────────────────
  let saleBId;
  {
    const midBatch = await findBatch(fix.fefoProd.product_id, 'LOT-MID');
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 5, rate: 25, gst_rate: 0,
        batch_id: midBatch.batch_id,
      }],
    }), res);
    saleBId = res._body?.sales_bill_id;
    if (!saleBId) throw new Error('S-EDIT seed sale failed: ' + JSON.stringify(res._body));

    // Edit qty 5 → 3 on the same batch.
    const midStockBefore = await batchStockAt(fix.fefoProd.product_id, midBatch.batch_id, fix.godown.godown_id);
    const ed = mockRes();
    await salesController.update({
      user: fix.adminUser, params: { id: String(saleBId) },
      body: {
        bill_date: '2026-05-03',
        customer_id: fix.customer.party_id,
        godown_id: fix.godown.godown_id,
        items: [{
          product_id: fix.fefoProd.product_id,
          product_name: fix.fefoProd.product_name,
          quantity: 3, rate: 25, gst_rate: 0,
          batch_id: midBatch.batch_id,
        }],
      },
    }, ed);
    if (ed._status !== 200) throw new Error('Edit-qty failed: ' + JSON.stringify(ed._body));
    const midStockAfter = await batchStockAt(fix.fefoProd.product_id, midBatch.batch_id, fix.godown.godown_id);
    check('S-EDIT-1: qty change adjusts batch stock by net delta (+5−3=+2)',
      near(midStockAfter, midStockBefore + 2));

    // Edit: change batch from MID to LATE (which we restored partially via cancel).
    // After E4 (-20) and S-CANCEL (still cancelled) — LOT-LATE has 0.
    // Repurchase a few to LOT-LATE so we can switch.
    await purchase(buildReqA, fix, fix.fefoProd.product_id, {
      product_name: fix.fefoProd.product_name, barcode: fix.fefoProd.barcode,
      qty: 10, rate: 15, batch_number: 'LOT-LATE',
    });
    const lateBatch = await findBatch(fix.fefoProd.product_id, 'LOT-LATE');
    const midBefore = await batchStockAt(fix.fefoProd.product_id, midBatch.batch_id, fix.godown.godown_id);
    const lateBefore = await batchStockAt(fix.fefoProd.product_id, lateBatch.batch_id, fix.godown.godown_id);
    const ed2 = mockRes();
    await salesController.update({
      user: fix.adminUser, params: { id: String(saleBId) },
      body: {
        bill_date: '2026-05-03',
        customer_id: fix.customer.party_id,
        godown_id: fix.godown.godown_id,
        items: [{
          product_id: fix.fefoProd.product_id,
          product_name: fix.fefoProd.product_name,
          quantity: 3, rate: 25, gst_rate: 0,
          batch_id: lateBatch.batch_id,  // switched
        }],
      },
    }, ed2);
    if (ed2._status !== 200) throw new Error('Edit-batch failed: ' + JSON.stringify(ed2._body));
    const midAfter = await batchStockAt(fix.fefoProd.product_id, midBatch.batch_id, fix.godown.godown_id);
    const lateAfter = await batchStockAt(fix.fefoProd.product_id, lateBatch.batch_id, fix.godown.godown_id);
    check('S-EDIT-2: batch switch — old batch +qty restored',
      near(midAfter, midBefore + 3));
    check('S-EDIT-2: batch switch — new batch -qty applied',
      near(lateAfter, lateBefore - 3));
  }

  // ── SR-CREATE: sales return preserves batch identity ─────────────────
  let saleForReturnId;
  {
    const earlyBefore = await batchStockAt(fix.fefoProd.product_id, earlyBatch.batch_id, fix.godown.godown_id);
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 4, rate: 25, gst_rate: 0,
        batch_id: earlyBatch.batch_id,
      }],
    }), res);
    saleForReturnId = res._body?.sales_bill_id;

    const sr = mockRes();
    await salesReturnController.create(buildReqA({
      return_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      reference_bill_id: saleForReturnId,
      reference_bill_type: 'Sales',
      reference_bill_number: 'TEST',
      return_mode: 'Items',
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 2, rate: 25, gst_rate: 0,
        batch_id: earlyBatch.batch_id,
      }],
    }), sr);
    if (sr._status !== 201 && sr._status !== 200) throw new Error('SR create failed: ' + JSON.stringify(sr._body));
    const earlyAfter = await batchStockAt(fix.fefoProd.product_id, earlyBatch.batch_id, fix.godown.godown_id);
    check('SR-CREATE-1: return increments product_batch_stock (+2 to LOT-EARLY)',
      near(earlyAfter, earlyBefore - 4 + 2));
    const slr = await StockLedger.findOne({
      where: { reference_id: sr._body?.sales_return_id, transaction_type: 'Sales Return' },
    });
    check('SR-CREATE-2: stock_ledger.batch_id persisted',
      slr && parseInt(slr.batch_id) === earlyBatch.batch_id);

    // Cancel this return → batch stock decrements back.
    const beforeCancel = await batchStockAt(fix.fefoProd.product_id, earlyBatch.batch_id, fix.godown.godown_id);
    const sc = mockRes();
    await salesReturnController.cancel({
      user: fix.adminUser, params: { id: String(sr._body?.sales_return_id) }, body: { reason: 'test' },
    }, sc);
    if (sc._status !== 200) throw new Error('SR cancel failed: ' + JSON.stringify(sc._body));
    const afterCancel = await batchStockAt(fix.fefoProd.product_id, earlyBatch.batch_id, fix.godown.godown_id);
    check('SR-CANCEL: cancelling return decrements batch stock back (-2)',
      near(afterCancel, beforeCancel - 2));
  }

  // ── PR-CREATE: purchase return decrements batch stock ────────────────
  {
    const foodA = await findBatch(fix.fifoProd.product_id, 'FOOD-A');
    const before = await batchStockAt(fix.fifoProd.product_id, foodA.batch_id, fix.godown.godown_id);

    // Find an originating purchase bill for FOOD-A
    const purBill = await PurchaseBill.findOne({
      where: { supplier_id: fix.supplier.party_id },
      order: [['purchase_bill_id', 'ASC']],
    });
    const pr = mockRes();
    await purchaseReturnController.create(buildReqA({
      return_date: '2026-05-03',
      supplier_id: fix.supplier.party_id,
      godown_id: fix.godown.godown_id,
      reference_bill_id: purBill.purchase_bill_id,
      reference_bill_type: 'Purchase',
      reference_bill_number: purBill.bill_number,
      return_mode: 'Items',
      items: [{
        product_id: fix.fifoProd.product_id,
        product_name: fix.fifoProd.product_name,
        quantity: 5, rate: 5, gst_rate: 0,
        batch_id: foodA.batch_id,
      }],
    }), pr);
    if (pr._status !== 201 && pr._status !== 200) throw new Error('PR create failed: ' + JSON.stringify(pr._body));
    const after = await batchStockAt(fix.fifoProd.product_id, foodA.batch_id, fix.godown.godown_id);
    check('PR-CREATE-1: purchase return decrements product_batch_stock (-5)',
      near(after, before - 5));
    const slpr = await StockLedger.findOne({
      where: { reference_id: pr._body?.purchase_return_id, transaction_type: 'Purchase Return' },
    });
    check('PR-CREATE-2: stock_ledger.batch_id persisted on purchase return',
      slpr && parseInt(slpr.batch_id) === foodA.batch_id);
  }

  // ── M1: global batch_tracking_enabled=false → silent no-op ─────────────
  {
    const settings = await SystemSettings.findByPk(1);
    await settings.update({ batch_tracking_enabled: false });
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.fefoProd.product_id,
        product_name: fix.fefoProd.product_name,
        quantity: 1, rate: 25, gst_rate: 0,
        // intentionally NO batch_id — should now be allowed
      }],
    }), res);
    check('M1: batch_tracking_enabled=false allows batch-tracked sale w/o batch_id',
      res._status === 201 || res._status === 200);
    let m1BillId = null;
    if (res._body?.sales_bill_id) {
      m1BillId = res._body.sales_bill_id;
      const item = await SalesBillItem.findOne({ where: { sales_bill_id: m1BillId } });
      check('M1: batch_id stored as NULL when global toggle off',
        item && item.batch_id == null);
    }
    await settings.update({ batch_tracking_enabled: true });
    // The M1 sale drew product stock without touching batch stock (by
    // design — global toggle bypasses batch tracking). That breaks I7
    // for fefoProd, so cancel the sale here to restore the invariant
    // before the I7 check.
    if (m1BillId) {
      const c = mockRes();
      await salesController.cancel({
        user: fix.adminUser, params: { id: String(m1BillId) }, body: { reason: 'M1 cleanup' },
      }, c);
      // Don't fail the test if cancel rejected (auto-receipt guard); we
      // just want to clean up best-effort.
    }
  }

  // ── M2: variant-mode product (non-batch) bypasses picker entirely ─────
  {
    // Need stock first.
    await purchase(buildReqA, fix, fix.variantProd.product_id, {
      product_name: fix.variantProd.product_name, barcode: fix.variantProd.barcode,
      qty: 10, rate: 8,
    });
    const res = mockRes();
    await salesController.create(buildReqA({
      bill_date: '2026-05-03',
      customer_id: fix.customer.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.variantProd.product_id,
        product_name: fix.variantProd.product_name,
        quantity: 1, rate: 14, gst_rate: 0,
      }],
    }), res);
    check('M2: variant product sells without batch_id (no enforcement)',
      res._status === 201 || res._status === 200);
  }

  // ── I7: integrity invariant ──────────────────────────────────────────
  {
    const integ = await checkIntegrity();
    const i7 = integ.invariants.find((i) => i.id === 'I7');
    check('I7-1: SUM(batch_stock) == products.current_stock for all batched products',
      i7 && i7.ok, i7 ? `${i7.violation_count || 0} violations` : 'no I7');

    // Force a drift to assert I7 surfaces it (M2 verification of the check itself).
    const beforeRow = await ProductBatchStock.findOne({
      where: { product_id: fix.fefoProd.product_id, godown_id: fix.godown.godown_id },
    });
    if (beforeRow) {
      const original = parseFloat(beforeRow.current_stock);
      await beforeRow.update({ current_stock: original + 99 });
      const integ2 = await checkIntegrity();
      const i7v = integ2.invariants.find((i) => i.id === 'I7');
      check('I7-2: deliberate drift surfaces as violation',
        i7v && !i7v.ok && i7v.violation_count > 0);
      // Restore so cleanup leaves the db tidy.
      await beforeRow.update({ current_stock: original });
    }
  }

  await cleanup();

  console.log('\n── results ──');
  for (const r of results) console.log(r);
  console.log(`\n${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
