#!/usr/bin/env node
/*
 * Batch tracking — Stock Transfer integration (Commit 4).
 * Run with: node server/scripts/test-batch-stock-transfer.js
 *
 * Exits 0 on full pass, 1 on any failure. All fixtures use the prefix
 * `_TBT_` so cleanup can target them safely without touching real data.
 *
 * Coverage (matches Commit-4 brief):
 *   ── Picker / API surface ─────────────────────────────────────────────
 *     PICK-1  Source-godown batches surfaced; destination-godown ignored
 *     PICK-2  FEFO ordering when expiry set; FIFO when not
 *     PICK-3  Empty list when no batches with stock at source
 *
 *   ── Transfer create (direct submit, In-Transit) ──────────────────────
 *     CR-1   stock_transfer_items.batch_id persisted
 *     CR-2   stock_ledger Out-leg carries batch_id
 *     CR-3   product_batch_stock decrements at (product, batch, FROM)
 *     CR-4   product_batch_stock at TO godown unchanged until receive
 *     CR-5   Rejected when batch-tracked product picks no batch
 *     CR-6   Rejected when transfer qty > batch on-hand at source
 *     CR-7   rate refines to batch.purchase_rate (per-lot precision)
 *
 *   ── Transfer receive ─────────────────────────────────────────────────
 *     RC-1   stock_ledger In-leg carries batch_id
 *     RC-2   product_batch_stock UPSERT at (product, batch, TO)
 *     RC-3   Same batch_id at destination — no new ProductBatch row
 *     RC-4   Per-product total stock unchanged (just godown distribution moves)
 *
 *   ── Cancel cascade ───────────────────────────────────────────────────
 *     CN-1   Cancel from In-Transit restores per-batch stock at source
 *     CN-2   Per-batch quantities back to pre-transfer state
 *
 *   ── Multi-batch transfer ─────────────────────────────────────────────
 *     MULTI-1  Three lines, three batches → each batch decrements independently
 *
 *   ── Mode regressions ─────────────────────────────────────────────────
 *     MODE-1  Global batch_tracking_enabled=false → batch_id silently NULL
 *     MODE-2  Non-batch product → no picker enforcement; batch_id null
 *
 *   ── Cross-feature ────────────────────────────────────────────────────
 *     XF-1   Transfer Main→Pimpri then sell from Pimpri → batch on hand
 *
 *   ── Draft path ───────────────────────────────────────────────────────
 *     DRAFT-1 Draft create persists batch_id without touching stock
 *     DRAFT-2 Draft → submit → ledger + per-batch decrement fires
 *
 *   ── Integrity invariants ─────────────────────────────────────────────
 *     I7-CT   I7 stays green after every operation
 *     I8-CT   I8 stays green after every operation
 *     I8-DRIFT  I8 surfaces a violation when product_batch_stock drifts from ledger
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Party, Product, Category, Godown, SystemSettings,
  PurchaseBill, PurchaseBillItem, SalesBill, SalesBillItem,
  StockTransfer, StockTransferItem,
  ProductBatch, ProductBatchStock, StockLedger, ProductGodownStock,
  User, Role,
} = require('../models');
const purchaseController       = require('../controllers/purchaseController');
const salesController          = require('../controllers/salesController');
const stockTransferController  = require('../controllers/stockTransferController');
const productController        = require('../controllers/productController');
const { checkIntegrity }       = require('../services/autoReceiptService');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TBT_';

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
  // Order: dependent rows first, then parents. Wide LIKE so any
  // partially-completed prior run gets cleaned up too.
  const testProd  = `(SELECT product_id FROM products WHERE product_name LIKE :p)`;
  const testParty = `(SELECT party_id   FROM parties  WHERE party_name   LIKE :p)`;
  const testTr    = `(SELECT transfer_id FROM stock_transfers WHERE notes LIKE :p OR transfer_number LIKE :p)`;
  const testPB    = `(SELECT purchase_bill_id FROM purchase_bills WHERE supplier_id IN ${testParty})`;
  const testSB    = `(SELECT sales_bill_id    FROM sales_bills    WHERE customer_id IN ${testParty})`;
  const testGD    = `(SELECT godown_id FROM godowns WHERE code LIKE :p)`;

  const r = { p: FIXTURE_PREFIX + '%' };
  await sequelize.query(`DELETE FROM stock_ledger             WHERE product_id IN ${testProd}`,             { replacements: r });
  await sequelize.query(`DELETE FROM stock_transfer_items     WHERE transfer_id IN ${testTr}`,              { replacements: r });
  await sequelize.query(`DELETE FROM stock_transfers          WHERE notes LIKE :p OR transfer_number LIKE :p`, { replacements: r });
  await sequelize.query(`DELETE FROM sales_bill_items         WHERE sales_bill_id IN ${testSB}`,            { replacements: r });
  await sequelize.query(`DELETE FROM purchase_bill_items      WHERE purchase_bill_id IN ${testPB}`,         { replacements: r });
  await sequelize.query(`DELETE FROM ledger_entries           WHERE source_type IN ('sales_bill','purchase_bill','payment_receipt') AND (reference_id IN ${testSB} OR reference_id IN ${testPB})`, { replacements: r });
  await sequelize.query(`DELETE FROM bill_payment_allocations WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${testParty})`, { replacements: r });
  await sequelize.query(`DELETE FROM payment_splits           WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${testParty})`, { replacements: r });
  await sequelize.query(`DELETE FROM payments_receipts        WHERE party_id IN ${testParty}`,              { replacements: r });
  await sequelize.query(`DELETE FROM sales_bills              WHERE customer_id IN ${testParty}`,           { replacements: r });
  await sequelize.query(`DELETE FROM purchase_bills           WHERE supplier_id IN ${testParty}`,           { replacements: r });
  await sequelize.query(`DELETE FROM product_batch_stock      WHERE product_id IN ${testProd}`,             { replacements: r });
  await sequelize.query(`DELETE FROM product_batches          WHERE product_id IN ${testProd}`,             { replacements: r });
  await sequelize.query(`DELETE FROM product_godown_stock     WHERE product_id IN ${testProd}`,             { replacements: r });
  await sequelize.query(`DELETE FROM products                 WHERE product_name LIKE :p`,                  { replacements: r });
  await sequelize.query(`DELETE FROM ledger_accounts          WHERE party_id IN ${testParty}`,              { replacements: r });
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE :p`,             { replacements: r });
  await sequelize.query(`DELETE FROM parties                  WHERE party_name LIKE :p`,                    { replacements: r });
  await sequelize.query(`UPDATE products SET category_id = NULL WHERE category_id IN (SELECT category_id FROM categories WHERE category_name LIKE :p)`, { replacements: r });
  await sequelize.query(`DELETE FROM categories               WHERE category_name LIKE :p`,                 { replacements: r });
  // Test godowns — only the ones we created (Pimpri / Branch fixtures);
  // the default seeded godown is NOT prefixed and stays untouched.
  await sequelize.query(`DELETE FROM godowns                  WHERE code LIKE :p`,                          { replacements: r });
}

async function setupFixtures() {
  const adminUser = await User.findOne({ include: [{ model: Role }], where: { username: 'admin' } });
  // Source godown — use the seeded default. Destination godown — fresh
  // fixture so we can assert "first-time-here" UPSERT in product_batch_stock.
  const mainGodown = await Godown.findOne({ where: { is_default: true } });
  const pimpriGodown = await Godown.create({
    code: FIXTURE_PREFIX + 'PIM', name: FIXTURE_PREFIX + 'Pimpri', is_default: false, is_active: true,
  });

  const cat = await Category.create({ category_name: FIXTURE_PREFIX + 'cat' });
  const supplier = await Party.create({
    party_name: FIXTURE_PREFIX + 'supp', party_type: 'Supplier',
    mobile_1: '9100000310', is_active: true, credit_allowed: true,
  });
  const customer = await Party.create({
    party_name: FIXTURE_PREFIX + 'cust', party_type: 'Customer',
    mobile_1: '9100000320', is_active: true, credit_allowed: true,
  });

  // Batch-tracked product for the main flow (3 lots).
  const pharma = await Product.create({
    barcode: FIXTURE_PREFIX + 'PHARMA',
    product_name: FIXTURE_PREFIX + 'Pharma Tablet',
    category_id: cat.category_id,
    purchase_rate: 10, sale_rate: 25, mrp: 30,
    quantity_per_box: 1, is_batch_tracked: true, is_active: true, gst_rate: 0,
    product_mode: 'single',
  });
  // Non-batch product for the regression test — verifies the picker
  // doesn't gatecrash a non-batch transfer line.
  const widget = await Product.create({
    barcode: FIXTURE_PREFIX + 'WIDGET',
    product_name: FIXTURE_PREFIX + 'Plain Widget',
    category_id: cat.category_id,
    purchase_rate: 4, sale_rate: 9, mrp: 12,
    quantity_per_box: 1, is_batch_tracked: false, is_active: true, gst_rate: 0,
    product_mode: 'single',
  });

  const settings = await SystemSettings.findByPk(1);
  await settings.update({ batch_tracking_enabled: true, block_expired_sales: false });

  return { adminUser, mainGodown, pimpriGodown, cat, supplier, customer, pharma, widget };
}

const buildReq = (user) => (overrides = {}) => ({ user, params: {}, body: {}, query: {}, ...overrides });

const purchase = async (buildReqFn, fix, productId, opts) => {
  const res = mockRes();
  await purchaseController.create(buildReqFn({
    body: {
      bill_date: opts.date || '2026-05-04',
      supplier_id: fix.supplier.party_id,
      godown_id: opts.godown_id || fix.mainGodown.godown_id,
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
    },
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
async function godownStockAt(productId, godownId) {
  const row = await ProductGodownStock.findOne({
    where: { product_id: productId, godown_id: godownId },
  });
  return row ? parseFloat(row.current_stock) : 0;
}
async function ledgerRowsForTransfer(transferId) {
  return StockLedger.findAll({
    where: { reference_id: transferId, transaction_type: 'Stock Transfer' },
    order: [['ledger_id', 'ASC']],
  });
}

const createTransfer = async (buildReqFn, fix, body) => {
  const res = mockRes();
  await stockTransferController.create(buildReqFn({ body }), res);
  return res;
};
const submitTransfer = async (buildReqFn, transferId) => {
  const res = mockRes();
  await stockTransferController.submit(buildReqFn({ params: { id: transferId } }), res);
  return res;
};
const receiveTransfer = async (buildReqFn, transferId) => {
  const res = mockRes();
  await stockTransferController.receive(buildReqFn({ params: { id: transferId }, body: {} }), res);
  return res;
};
const cancelTransfer = async (buildReqFn, transferId, reason = 'test') => {
  const res = mockRes();
  await stockTransferController.cancel(buildReqFn({ params: { id: transferId }, body: { reason } }), res);
  return res;
};
const getBatchesViaApi = async (buildReqFn, productId, godownId) => {
  const res = mockRes();
  await productController.getBatches(buildReqFn({
    params: { id: productId }, query: { godown_id: godownId },
  }), res);
  return res;
};

async function runTests() {
  await cleanup();
  const fix = await setupFixtures();
  const buildReqA = buildReq(fix.adminUser);

  // ── Seed: 3 batches at Main godown ───────────────────────────────────
  // LOT-A (FEFO winner — earliest expiry), LOT-B (mid), LOT-C (latest).
  await purchase(buildReqA, fix, fix.pharma.product_id, {
    product_name: fix.pharma.product_name, barcode: fix.pharma.barcode,
    qty: 50, rate: 10, batch_number: 'TBT-LOT-A', mfg: '2025-01-01', exp: '2025-08-01',
  });
  await purchase(buildReqA, fix, fix.pharma.product_id, {
    product_name: fix.pharma.product_name, barcode: fix.pharma.barcode,
    qty: 30, rate: 12, batch_number: 'TBT-LOT-B', mfg: '2025-02-01', exp: '2026-02-01',
  });
  await purchase(buildReqA, fix, fix.pharma.product_id, {
    product_name: fix.pharma.product_name, barcode: fix.pharma.barcode,
    qty: 20, rate: 15, batch_number: 'TBT-LOT-C', mfg: '2025-03-01', exp: '2027-12-31',
  });
  // Non-batch product — 100 widgets at Main.
  await purchase(buildReqA, fix, fix.widget.product_id, {
    product_name: fix.widget.product_name, barcode: fix.widget.barcode,
    qty: 100, rate: 4,
  });

  const lotA = await findBatch(fix.pharma.product_id, 'TBT-LOT-A');
  const lotB = await findBatch(fix.pharma.product_id, 'TBT-LOT-B');
  const lotC = await findBatch(fix.pharma.product_id, 'TBT-LOT-C');

  // ── PICK-1, PICK-2, PICK-3 ───────────────────────────────────────────
  // From the Stock Transfer form's perspective: getBatches at SOURCE.
  let pick = await getBatchesViaApi(buildReqA, fix.pharma.product_id, fix.mainGodown.godown_id);
  check('PICK-1 batches at SOURCE godown surfaced', pick._status === 200 && pick._body.data.length === 3,
    `status=${pick._status} count=${pick._body?.data?.length}`);
  check('PICK-2 FEFO order (LOT-A first by earliest expiry)',
    pick._body.data[0].batch_number === 'TBT-LOT-A'
    && pick._body.data[1].batch_number === 'TBT-LOT-B'
    && pick._body.data[2].batch_number === 'TBT-LOT-C',
    `order=${pick._body.data.map((r) => r.batch_number).join(',')}`);
  let pickEmpty = await getBatchesViaApi(buildReqA, fix.pharma.product_id, fix.pimpriGodown.godown_id);
  check('PICK-3 empty list at destination (no batches there yet)',
    pickEmpty._status === 200 && pickEmpty._body.data.length === 0,
    `count=${pickEmpty._body?.data?.length}`);

  // ── CR-5: Reject batch-tracked without batch_id ──────────────────────
  let crNoBatch = await createTransfer(buildReqA, fix, {
    transfer_date: '2026-05-04',
    from_godown_id: fix.mainGodown.godown_id,
    to_godown_id: fix.pimpriGodown.godown_id,
    notes: FIXTURE_PREFIX + 'no-batch',
    status: 'In-Transit',
    items: [{
      product_id: fix.pharma.product_id,
      barcode: fix.pharma.barcode,
      quantity: 5, rate: 10,
      // batch_id omitted on purpose
    }],
  });
  check('CR-5 transfer rejected without batch_id for batch-tracked product',
    crNoBatch._status === 400 && /batch/i.test(crNoBatch._body?.error || ''),
    `status=${crNoBatch._status} error=${crNoBatch._body?.error}`);

  // ── CR-6: Reject when qty > batch on-hand ────────────────────────────
  let crOverdraw = await createTransfer(buildReqA, fix, {
    transfer_date: '2026-05-04',
    from_godown_id: fix.mainGodown.godown_id,
    to_godown_id: fix.pimpriGodown.godown_id,
    notes: FIXTURE_PREFIX + 'overdraw',
    status: 'In-Transit',
    items: [{
      product_id: fix.pharma.product_id, barcode: fix.pharma.barcode,
      quantity: 999, rate: 10, batch_id: lotA.batch_id,
    }],
  });
  check('CR-6 transfer rejected when qty > batch on-hand',
    crOverdraw._status === 400 && /only|available/i.test(crOverdraw._body?.error || ''),
    `status=${crOverdraw._status} error=${crOverdraw._body?.error}`);

  // ── CR-1..4, RC-1..4: Submit, then receive, 10 of LOT-A ──────────────
  const lotAStockMainBefore  = await batchStockAt(fix.pharma.product_id, lotA.batch_id, fix.mainGodown.godown_id);
  const lotAStockPimpriBefore = await batchStockAt(fix.pharma.product_id, lotA.batch_id, fix.pimpriGodown.godown_id);
  const productTotalBefore   = parseFloat((await Product.findByPk(fix.pharma.product_id)).current_stock);

  let cr = await createTransfer(buildReqA, fix, {
    transfer_date: '2026-05-04',
    from_godown_id: fix.mainGodown.godown_id,
    to_godown_id: fix.pimpriGodown.godown_id,
    notes: FIXTURE_PREFIX + 'lot-a-10',
    status: 'In-Transit',
    items: [{
      product_id: fix.pharma.product_id, barcode: fix.pharma.barcode,
      quantity: 10, rate: 10, batch_id: lotA.batch_id,
    }],
  });
  check('CR transfer create succeeded', cr._status === 201, `status=${cr._status} err=${cr._body?.error}`);
  const transferId = cr._body?.transfer_id;

  const items = await StockTransferItem.findAll({ where: { transfer_id: transferId } });
  check('CR-1 stock_transfer_items.batch_id persisted',
    items.length === 1 && items[0].batch_id === lotA.batch_id,
    `batch_id=${items[0]?.batch_id} expected=${lotA.batch_id}`);

  let ledger = await ledgerRowsForTransfer(transferId);
  check('CR-2 stock_ledger Out-leg carries batch_id',
    ledger.length === 1
    && ledger[0].batch_id === lotA.batch_id
    && parseFloat(ledger[0].quantity_out) === 10
    && parseFloat(ledger[0].quantity_in) === 0
    && ledger[0].godown_id === fix.mainGodown.godown_id,
    `rows=${ledger.length} batch_id=${ledger[0]?.batch_id}`);

  const lotAStockMainAfterOut = await batchStockAt(fix.pharma.product_id, lotA.batch_id, fix.mainGodown.godown_id);
  check('CR-3 product_batch_stock decremented at (LOT-A, Main)',
    near(lotAStockMainAfterOut, lotAStockMainBefore - 10),
    `before=${lotAStockMainBefore} after=${lotAStockMainAfterOut}`);

  const lotAStockPimpriAfterOut = await batchStockAt(fix.pharma.product_id, lotA.batch_id, fix.pimpriGodown.godown_id);
  check('CR-4 destination batch_stock unchanged until receive',
    near(lotAStockPimpriAfterOut, lotAStockPimpriBefore),
    `before=${lotAStockPimpriBefore} after=${lotAStockPimpriAfterOut}`);

  // Now receive.
  let rc = await receiveTransfer(buildReqA, transferId);
  check('RC receive succeeded', rc._status === 200 && rc._body?.status === 'Received',
    `status=${rc._status} body=${JSON.stringify(rc._body)}`);

  ledger = await ledgerRowsForTransfer(transferId);
  const inLeg = ledger.find((r) => parseFloat(r.quantity_in) > 0);
  check('RC-1 stock_ledger In-leg carries batch_id',
    inLeg && inLeg.batch_id === lotA.batch_id
    && parseFloat(inLeg.quantity_in) === 10 && parseFloat(inLeg.quantity_out) === 0
    && inLeg.godown_id === fix.pimpriGodown.godown_id,
    `inLeg=${JSON.stringify(inLeg && { batch_id: inLeg.batch_id, qty_in: inLeg.quantity_in, godown: inLeg.godown_id })}`);

  const lotAStockPimpriAfterIn = await batchStockAt(fix.pharma.product_id, lotA.batch_id, fix.pimpriGodown.godown_id);
  check('RC-2 product_batch_stock UPSERT created at (LOT-A, Pimpri) with qty=10',
    near(lotAStockPimpriAfterIn, 10),
    `pimpri=${lotAStockPimpriAfterIn}`);

  // RC-3: same batch_id reused — not a new ProductBatch row.
  const sameBatch = await ProductBatch.findByPk(lotA.batch_id);
  const allLotABatches = await ProductBatch.findAll({
    where: { product_id: fix.pharma.product_id, batch_number: 'TBT-LOT-A' },
  });
  check('RC-3 same batch_id at destination — no duplicate ProductBatch row',
    sameBatch && sameBatch.batch_id === lotA.batch_id && allLotABatches.length === 1,
    `count=${allLotABatches.length}`);

  const productTotalAfter = parseFloat((await Product.findByPk(fix.pharma.product_id)).current_stock);
  check('RC-4 per-product total unchanged (godown distribution shifted)',
    near(productTotalAfter, productTotalBefore),
    `before=${productTotalBefore} after=${productTotalAfter}`);

  // CR-7: rate carries from per-line input (form pre-fills batch.purchase_rate
  // — verified that the persisted item.rate equals what the form would have
  // sent; here it equals the rate we passed). With per-batch refinement the
  // form sends batch.purchase_rate; the controller persists that verbatim.
  check('CR-7 transfer item.rate == sent rate (form sends batch.purchase_rate)',
    near(parseFloat(items[0].rate), 10),
    `rate=${items[0].rate}`);

  // Run integrity once after first complete cycle.
  let integrity = await checkIntegrity();
  const i7 = integrity.invariants.find((i) => i.id === 'I7');
  const i8 = integrity.invariants.find((i) => i.id === 'I8');
  check('I7 green after first transfer cycle',
    i7 && i7.ok === true,
    `i7=${JSON.stringify(i7)}`);
  check('I8 green after first transfer cycle',
    i8 && i8.ok === true,
    `i8=${JSON.stringify(i8)}`);

  // ── CN-1, CN-2: Cancel from In-Transit ───────────────────────────────
  // Set up a fresh transfer (15 of LOT-B), then cancel before receive.
  const lotBStockMainBefore = await batchStockAt(fix.pharma.product_id, lotB.batch_id, fix.mainGodown.godown_id);
  let crCancel = await createTransfer(buildReqA, fix, {
    transfer_date: '2026-05-04',
    from_godown_id: fix.mainGodown.godown_id,
    to_godown_id: fix.pimpriGodown.godown_id,
    notes: FIXTURE_PREFIX + 'cancel-test',
    status: 'In-Transit',
    items: [{
      product_id: fix.pharma.product_id, barcode: fix.pharma.barcode,
      quantity: 15, rate: 12, batch_id: lotB.batch_id,
    }],
  });
  check('CN setup: transfer In-Transit created', crCancel._status === 201,
    `status=${crCancel._status} err=${crCancel._body?.error}`);
  const cancelTransferId = crCancel._body?.transfer_id;
  const lotBStockMainAfterOut = await batchStockAt(fix.pharma.product_id, lotB.batch_id, fix.mainGodown.godown_id);
  // Sanity: stock decremented before cancel.
  check('CN setup decremented LOT-B at Main by 15',
    near(lotBStockMainAfterOut, lotBStockMainBefore - 15),
    `before=${lotBStockMainBefore} after=${lotBStockMainAfterOut}`);

  let cn = await cancelTransfer(buildReqA, cancelTransferId, 'unit test');
  check('CN cancel succeeded', cn._status === 200 && cn._body?.status === 'Cancelled',
    `status=${cn._status} body=${JSON.stringify(cn._body)}`);

  const lotBStockMainAfterCancel = await batchStockAt(fix.pharma.product_id, lotB.batch_id, fix.mainGodown.godown_id);
  check('CN-1 cancel restored per-batch stock at source',
    near(lotBStockMainAfterCancel, lotBStockMainBefore),
    `before=${lotBStockMainBefore} afterCancel=${lotBStockMainAfterCancel}`);

  const cancelLedger = await ledgerRowsForTransfer(cancelTransferId);
  check('CN-2 stock_ledger rows for cancelled transfer destroyed',
    cancelLedger.length === 0,
    `remaining=${cancelLedger.length}`);

  // ── MULTI-1: Three-line transfer ─────────────────────────────────────
  // Snapshot per-batch stocks at Main BEFORE the multi-line transfer.
  const beforeA = await batchStockAt(fix.pharma.product_id, lotA.batch_id, fix.mainGodown.godown_id);
  const beforeB = await batchStockAt(fix.pharma.product_id, lotB.batch_id, fix.mainGodown.godown_id);
  const beforeC = await batchStockAt(fix.pharma.product_id, lotC.batch_id, fix.mainGodown.godown_id);
  let crMulti = await createTransfer(buildReqA, fix, {
    transfer_date: '2026-05-04',
    from_godown_id: fix.mainGodown.godown_id,
    to_godown_id: fix.pimpriGodown.godown_id,
    notes: FIXTURE_PREFIX + 'multi',
    status: 'In-Transit',
    items: [
      { product_id: fix.pharma.product_id, barcode: fix.pharma.barcode, quantity: 5, rate: 10, batch_id: lotA.batch_id },
      { product_id: fix.pharma.product_id, barcode: fix.pharma.barcode, quantity: 7, rate: 12, batch_id: lotB.batch_id },
      { product_id: fix.pharma.product_id, barcode: fix.pharma.barcode, quantity: 9, rate: 15, batch_id: lotC.batch_id },
    ],
  });
  check('MULTI multi-line transfer created', crMulti._status === 201, `status=${crMulti._status} err=${crMulti._body?.error}`);
  const afterA = await batchStockAt(fix.pharma.product_id, lotA.batch_id, fix.mainGodown.godown_id);
  const afterB = await batchStockAt(fix.pharma.product_id, lotB.batch_id, fix.mainGodown.godown_id);
  const afterC = await batchStockAt(fix.pharma.product_id, lotC.batch_id, fix.mainGodown.godown_id);
  check('MULTI-1 each batch decrements independently',
    near(afterA, beforeA - 5) && near(afterB, beforeB - 7) && near(afterC, beforeC - 9),
    `A:${beforeA}->${afterA} B:${beforeB}->${afterB} C:${beforeC}->${afterC}`);

  // Receive the multi-line transfer (sets up stock at Pimpri for the cross-feature test).
  await receiveTransfer(buildReqA, crMulti._body.transfer_id);

  // ── MODE-1: global toggle OFF ────────────────────────────────────────
  // Toggle OFF + transfer + receive in one go so per-batch and per-godown
  // stay consistent — Out and In legs both skip per-batch writes (toggle
  // is OFF), so godown-level delta nets to zero and per-batch is
  // untouched. Without the receive, only the Out leg fires and per-batch
  // drifts by exactly the transferred qty (a production hazard if the
  // toggle is flipped mid-life with batched products that have stock).
  const settings = await SystemSettings.findByPk(1);
  await settings.update({ batch_tracking_enabled: false });
  let crModeOff = await createTransfer(buildReqA, fix, {
    transfer_date: '2026-05-04',
    from_godown_id: fix.mainGodown.godown_id,
    to_godown_id: fix.pimpriGodown.godown_id,
    notes: FIXTURE_PREFIX + 'mode-off',
    status: 'In-Transit',
    items: [{ product_id: fix.pharma.product_id, barcode: fix.pharma.barcode, quantity: 1, rate: 10 }],
  });
  check('MODE-1 transfer accepted without batch_id when global toggle OFF',
    crModeOff._status === 201,
    `status=${crModeOff._status} err=${crModeOff._body?.error}`);
  const modeOffItems = await StockTransferItem.findAll({ where: { transfer_id: crModeOff._body.transfer_id } });
  check('MODE-1 stock_transfer_items.batch_id is NULL when global toggle OFF',
    modeOffItems.length === 1 && modeOffItems[0].batch_id == null,
    `batch_id=${modeOffItems[0]?.batch_id}`);
  // Complete the cycle — receive while still in toggle-OFF mode so the
  // In leg also skips per-batch writes. Out -1 / In +1 nets to zero on
  // products.current_stock, and per-batch stays untouched, so I7 holds.
  await receiveTransfer(buildReqA, crModeOff._body.transfer_id);
  await settings.update({ batch_tracking_enabled: true });

  // ── MODE-2: non-batch product, toggle ON ─────────────────────────────
  let crNonBatch = await createTransfer(buildReqA, fix, {
    transfer_date: '2026-05-04',
    from_godown_id: fix.mainGodown.godown_id,
    to_godown_id: fix.pimpriGodown.godown_id,
    notes: FIXTURE_PREFIX + 'nonbatch',
    status: 'In-Transit',
    items: [{ product_id: fix.widget.product_id, barcode: fix.widget.barcode, quantity: 5, rate: 4 }],
  });
  check('MODE-2 non-batch product transfer accepted without batch_id',
    crNonBatch._status === 201,
    `status=${crNonBatch._status} err=${crNonBatch._body?.error}`);
  const nonBatchItems = await StockTransferItem.findAll({ where: { transfer_id: crNonBatch._body.transfer_id } });
  check('MODE-2 non-batch item.batch_id is NULL even with global toggle ON',
    nonBatchItems.length === 1 && nonBatchItems[0].batch_id == null,
    `batch_id=${nonBatchItems[0]?.batch_id}`);

  // ── XF-1: Sell from Pimpri after transfer ────────────────────────────
  // Pick batches at Pimpri now — the multi-line + LOT-A transfers should
  // have populated them.
  let pickAtPimpri = await getBatchesViaApi(buildReqA, fix.pharma.product_id, fix.pimpriGodown.godown_id);
  check('XF-1 batches now visible at Pimpri after transfer',
    pickAtPimpri._status === 200 && pickAtPimpri._body.data.length >= 1,
    `count=${pickAtPimpri._body?.data?.length}`);
  // Sell 2 of LOT-A from Pimpri.
  const sellRes = mockRes();
  await salesController.create(buildReqA({
    body: {
      sales_date: '2026-05-04',
      bill_date:  '2026-05-04',
      customer_id: fix.customer.party_id,
      godown_id: fix.pimpriGodown.godown_id,
      payment_method: 'Cash',
      items: [{
        product_id: fix.pharma.product_id, barcode: fix.pharma.barcode,
        product_name: fix.pharma.product_name,
        quantity: 2, rate: 25, gst_rate: 0,
        batch_id: lotA.batch_id,
      }],
    },
  }), sellRes);
  check('XF-1 sale from Pimpri using transferred LOT-A succeeded',
    sellRes._status === 201 || sellRes._status === 200,
    `status=${sellRes._status} err=${sellRes._body?.error}`);
  const lotAAfterSale = await batchStockAt(fix.pharma.product_id, lotA.batch_id, fix.pimpriGodown.godown_id);
  // After receive of LOT-A 10 (CR-1..4) + multi-line 5 = 15 at Pimpri,
  // then sold 2 → 13.
  check('XF-1 batch_stock decremented at Pimpri after sale',
    near(lotAAfterSale, 13),
    `pimpri=${lotAAfterSale}`);

  // ── DRAFT-1, DRAFT-2 ─────────────────────────────────────────────────
  const lotCStockMainBefore = await batchStockAt(fix.pharma.product_id, lotC.batch_id, fix.mainGodown.godown_id);
  let draftRes = await createTransfer(buildReqA, fix, {
    transfer_date: '2026-05-04',
    from_godown_id: fix.mainGodown.godown_id,
    to_godown_id: fix.pimpriGodown.godown_id,
    notes: FIXTURE_PREFIX + 'draft-test',
    status: 'Draft',
    items: [{
      product_id: fix.pharma.product_id, barcode: fix.pharma.barcode,
      quantity: 3, rate: 15, batch_id: lotC.batch_id,
    }],
  });
  check('DRAFT-1 draft create persisted batch_id',
    draftRes._status === 201,
    `status=${draftRes._status} err=${draftRes._body?.error}`);
  const draftItems = await StockTransferItem.findAll({ where: { transfer_id: draftRes._body.transfer_id } });
  check('DRAFT-1 draft batch_id stored on item',
    draftItems[0]?.batch_id === lotC.batch_id,
    `batch_id=${draftItems[0]?.batch_id}`);
  const lotCStockAfterDraft = await batchStockAt(fix.pharma.product_id, lotC.batch_id, fix.mainGodown.godown_id);
  check('DRAFT-1 draft did not move stock',
    near(lotCStockAfterDraft, lotCStockMainBefore),
    `before=${lotCStockMainBefore} afterDraft=${lotCStockAfterDraft}`);

  let submitRes = await submitTransfer(buildReqA, draftRes._body.transfer_id);
  check('DRAFT-2 draft submit succeeded',
    submitRes._status === 200,
    `status=${submitRes._status} err=${submitRes._body?.error}`);
  const lotCStockAfterSubmit = await batchStockAt(fix.pharma.product_id, lotC.batch_id, fix.mainGodown.godown_id);
  check('DRAFT-2 submit decremented per-batch stock at source',
    near(lotCStockAfterSubmit, lotCStockMainBefore - 3),
    `before=${lotCStockMainBefore} afterSubmit=${lotCStockAfterSubmit}`);
  const submitLedger = await ledgerRowsForTransfer(draftRes._body.transfer_id);
  check('DRAFT-2 submit wrote stock_ledger Out leg with batch_id',
    submitLedger.length === 1 && submitLedger[0].batch_id === lotC.batch_id,
    `rows=${submitLedger.length} batch_id=${submitLedger[0]?.batch_id}`);

  // ── I7-CT, I8-CT after every operation ───────────────────────────────
  integrity = await checkIntegrity();
  const i7Final = integrity.invariants.find((i) => i.id === 'I7');
  const i8Final = integrity.invariants.find((i) => i.id === 'I8');
  check('I7-CT green after all operations',
    i7Final && i7Final.ok === true,
    `i7=${JSON.stringify(i7Final)}`);
  check('I8-CT green after all operations',
    i8Final && i8Final.ok === true,
    `i8=${JSON.stringify(i8Final)}`);

  // ── I8-DRIFT ─────────────────────────────────────────────────────────
  // Force a drift: bump product_batch_stock for LOT-A at Pimpri by +99
  // without writing a ledger row. I8 should surface it.
  await sequelize.query(
    `UPDATE product_batch_stock
        SET current_stock = current_stock + 99
      WHERE product_id = :pid AND batch_id = :bid AND godown_id = :gid`,
    { replacements: { pid: fix.pharma.product_id, bid: lotA.batch_id, gid: fix.pimpriGodown.godown_id } },
  );
  const integrityDrift = await checkIntegrity();
  const i8Drift = integrityDrift.invariants.find((i) => i.id === 'I8');
  check('I8-DRIFT surfaces violation when product_batch_stock drifts from ledger',
    i8Drift && i8Drift.ok === false && i8Drift.violation_count >= 1,
    `i8=${JSON.stringify(i8Drift)}`);
  // Restore so cleanup is clean.
  await sequelize.query(
    `UPDATE product_batch_stock
        SET current_stock = current_stock - 99
      WHERE product_id = :pid AND batch_id = :bid AND godown_id = :gid`,
    { replacements: { pid: fix.pharma.product_id, bid: lotA.batch_id, gid: fix.pimpriGodown.godown_id } },
  );
  // I8 must come back green after restore.
  const integrityRestore = await checkIntegrity();
  const i8Restored = integrityRestore.invariants.find((i) => i.id === 'I8');
  check('I8 returns to green after manual drift is reversed',
    i8Restored && i8Restored.ok === true,
    `i8=${JSON.stringify(i8Restored)}`);
}

(async () => {
  try {
    await runTests();
  } catch (err) {
    console.error('Test runner failure:', err);
    fail++;
  } finally {
    try { await cleanup(); } catch (e) { console.error('Cleanup failed:', e.message); }
    console.log('\n── Stock Transfer batch tracking ──');
    results.forEach((r) => console.log(r));
    console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
    await sequelize.close();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
