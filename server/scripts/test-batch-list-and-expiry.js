#!/usr/bin/env node
/*
 * Batch tracking — Commit 5: list / detail / expiry-report endpoints +
 * B3..B5 invariants. Run with:
 *   node server/scripts/test-batch-list-and-expiry.js
 *
 * Exits 0 on full pass, 1 on any failure. All fixtures use prefix
 * `_TBL_` so cleanup can target them safely.
 *
 * Coverage:
 *   ── /api/batches ───────────────────────────────────────────────────
 *     L1   Returns rows with computed status (active / expiring_soon
 *          / expired / out_of_stock).
 *     L2   Summary counts match per-status row count.
 *     L3   `q` filter narrows by batch_number substring.
 *     L4   product_id filter narrows to one product's batches.
 *     L5   godown_id filter narrows to batches with stock at that godown.
 *     L6   status comma-list filter restricts the return set.
 *     L7   FEFO sort priority: expired → expiring_soon → active.
 *
 *   ── /api/batches/:id ───────────────────────────────────────────────
 *     D1   detail returns batch header + days_to_expiry computed.
 *     D2   stock_by_godown sums to total_stock.
 *     D3   movement rows include batch_id and the running balance is
 *          monotonic with quantity_in / quantity_out.
 *     D4   bills_touched dedupes by reference.
 *
 *   ── /api/batches/expiry-report ────────────────────────────────────
 *     E1   Bucket assignment honours the SQL CASE (no_expiry / expired
 *          / 0_30 / 31_60 / 61_90 / 91_plus).
 *     E2   Bucket filter narrows the row set.
 *     E3   Sort puts smallest days_to_expiry first; nulls last.
 *
 *   ── B3 / B4 / B5 invariants ───────────────────────────────────────
 *     B3   NULL batch_id on a batch-tracked product surfaces as a B3
 *          violation; clearing the row makes B3 green.
 *     B5   Negative current_stock at one (batch, godown) surfaces as
 *          a B5 violation.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Party, Product, Category, Godown, SystemSettings,
  PurchaseBill, PurchaseBillItem, SalesBill, SalesBillItem,
  ProductBatch, ProductBatchStock, StockLedger,
  User, Role,
} = require('../models');
const purchaseController = require('../controllers/purchaseController');
const salesController    = require('../controllers/salesController');
const batchController    = require('../controllers/batchController');
const { checkIntegrity } = require('../services/autoReceiptService');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TBL_';

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
  const testProd  = `(SELECT product_id FROM products WHERE product_name LIKE :p)`;
  const testParty = `(SELECT party_id   FROM parties  WHERE party_name   LIKE :p)`;
  const testPB    = `(SELECT purchase_bill_id FROM purchase_bills WHERE supplier_id IN ${testParty})`;
  const testSB    = `(SELECT sales_bill_id    FROM sales_bills    WHERE customer_id IN ${testParty})`;

  const r = { p: FIXTURE_PREFIX + '%' };
  await sequelize.query(`DELETE FROM stock_ledger             WHERE product_id IN ${testProd}`,             { replacements: r });
  await sequelize.query(`DELETE FROM sales_bill_items         WHERE sales_bill_id IN ${testSB}`,            { replacements: r });
  await sequelize.query(`DELETE FROM purchase_bill_items      WHERE purchase_bill_id IN ${testPB}`,         { replacements: r });
  await sequelize.query(`DELETE FROM ledger_entries           WHERE source_type IN ('sales_bill','purchase_bill','payment_receipt') AND (reference_id IN ${testSB} OR reference_id IN ${testPB})`, { replacements: r });
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
}

async function setupFixtures() {
  const adminUser = await User.findOne({ include: [{ model: Role }], where: { username: 'admin' } });
  const godown = await Godown.findOne({ where: { is_default: true } });

  const cat = await Category.create({ category_name: FIXTURE_PREFIX + 'cat' });
  const supplier = await Party.create({
    party_name: FIXTURE_PREFIX + 'supp', party_type: 'Supplier',
    mobile_1: '9100000610', is_active: true, credit_allowed: true,
  });

  const pharma = await Product.create({
    barcode: FIXTURE_PREFIX + 'PHARMA',
    product_name: FIXTURE_PREFIX + 'Pharma Tablet',
    category_id: cat.category_id,
    purchase_rate: 10, sale_rate: 25, mrp: 30,
    quantity_per_box: 1, is_batch_tracked: true, is_active: true, gst_rate: 0,
    product_mode: 'single',
  });

  const settings = await SystemSettings.findByPk(1);
  await settings.update({ batch_tracking_enabled: true, batch_expiry_alert_days: 30 });

  return { adminUser, godown, cat, supplier, pharma };
}

const buildReq = (user) => (overrides = {}) => ({ user, params: {}, body: {}, query: {}, ...overrides });

const purchase = async (buildReqFn, fix, opts) => {
  const res = mockRes();
  await purchaseController.create(buildReqFn({
    body: {
      bill_date: opts.date || '2026-05-04',
      supplier_id: fix.supplier.party_id,
      godown_id: fix.godown.godown_id,
      items: [{
        product_id: fix.pharma.product_id,
        product_name: fix.pharma.product_name,
        barcode: fix.pharma.barcode,
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

const callList = async (buildReqFn, query = {}) => {
  const res = mockRes();
  await batchController.list(buildReqFn({ query }), res);
  return res;
};
const callDetail = async (buildReqFn, batchId) => {
  const res = mockRes();
  await batchController.detail(buildReqFn({ params: { batch_id: batchId } }), res);
  return res;
};
const callExpiry = async (buildReqFn, query = {}) => {
  const res = mockRes();
  await batchController.expiryReport(buildReqFn({ query }), res);
  return res;
};

async function runTests() {
  await cleanup();
  const fix = await setupFixtures();
  const buildReqA = buildReq(fix.adminUser);

  // ── Seed: 4 batches with varied expiry to drive the status taxonomy ──
  const today = new Date();
  const yyyymmdd = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

  // EXPIRED — exp 10 days ago
  await purchase(buildReqA, fix, {
    qty: 30, rate: 10, batch_number: 'TBL-EXPIRED',
    mfg: yyyymmdd(addDays(today, -180)), exp: yyyymmdd(addDays(today, -10)),
  });
  // EXPIRING_SOON — exp 15 days from today (within 30-day alert)
  await purchase(buildReqA, fix, {
    qty: 20, rate: 11, batch_number: 'TBL-SOON',
    mfg: yyyymmdd(addDays(today, -90)), exp: yyyymmdd(addDays(today, 15)),
  });
  // ACTIVE — exp 200 days from today
  await purchase(buildReqA, fix, {
    qty: 50, rate: 12, batch_number: 'TBL-LATE',
    mfg: yyyymmdd(addDays(today, -10)), exp: yyyymmdd(addDays(today, 200)),
  });
  // NO_EXPIRY — null expiry (active by default)
  await purchase(buildReqA, fix, {
    qty: 10, rate: 13, batch_number: 'TBL-NOEXP',
    mfg: yyyymmdd(addDays(today, -5)), exp: null,
  });

  // ── /api/batches list ──
  let list = await callList(buildReqA);
  check('L1 list status 200', list._status === 200, `status=${list._status}`);
  const ourRows = (list._body?.data || []).filter((r) => r.batch_number?.startsWith('TBL-'));
  check('L1 list returns our 4 fixture rows', ourRows.length === 4, `count=${ourRows.length}`);
  const byNum = Object.fromEntries(ourRows.map((r) => [r.batch_number, r]));
  check('L1 status mapping: EXPIRED → expired',
    byNum['TBL-EXPIRED']?.status === 'expired',
    `status=${byNum['TBL-EXPIRED']?.status}`);
  check('L1 status mapping: SOON → expiring_soon',
    byNum['TBL-SOON']?.status === 'expiring_soon',
    `status=${byNum['TBL-SOON']?.status}`);
  check('L1 status mapping: LATE → active',
    byNum['TBL-LATE']?.status === 'active',
    `status=${byNum['TBL-LATE']?.status}`);
  check('L1 status mapping: NOEXP → active (null expiry, has stock)',
    byNum['TBL-NOEXP']?.status === 'active',
    `status=${byNum['TBL-NOEXP']?.status}`);
  // L2 — summary counts
  const ourSum = (list._body?.data || []).filter((r) => r.batch_number?.startsWith('TBL-'))
    .reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  check('L2 summary mirrors per-status row count (expired)',
    list._body?.summary?.expired >= ourSum.expired,
    `summary=${list._body?.summary?.expired}`);
  // L3 — q filter
  const qList = await callList(buildReqA, { q: 'TBL-EXPIRED' });
  check('L3 q filter narrows by batch_number substring',
    (qList._body?.data || []).filter((r) => r.batch_number === 'TBL-EXPIRED').length === 1,
    `count=${(qList._body?.data || []).filter((r) => r.batch_number === 'TBL-EXPIRED').length}`);
  // L4 — product_id filter
  const pList = await callList(buildReqA, { product_id: fix.pharma.product_id });
  const onlyPharma = (pList._body?.data || []).every((r) => r.product_id === fix.pharma.product_id);
  check('L4 product_id filter restricts to one product', onlyPharma,
    `bad=${(pList._body?.data || []).find((r) => r.product_id !== fix.pharma.product_id)?.product_id}`);
  // L5 — godown_id filter (default godown holds all our batches)
  const gList = await callList(buildReqA, { godown_id: fix.godown.godown_id });
  const ourAtG = (gList._body?.data || []).filter((r) => r.batch_number?.startsWith('TBL-'));
  check('L5 godown_id filter returns batches with stock at that godown',
    ourAtG.length === 4, `count=${ourAtG.length}`);
  // L6 — status comma list
  const sList = await callList(buildReqA, { status: 'expired,expiring_soon' });
  const onlyExpAndSoon = (sList._body?.data || []).filter((r) => r.batch_number?.startsWith('TBL-'))
    .every((r) => r.status === 'expired' || r.status === 'expiring_soon');
  check('L6 status filter restricts the return set', onlyExpAndSoon, '');
  // L7 — sort priority
  const ourSorted = (list._body?.data || []).filter((r) => r.batch_number?.startsWith('TBL-'));
  const order = { expired: 0, expiring_soon: 1, active: 2, out_of_stock: 3 };
  let sorted = true;
  for (let i = 1; i < ourSorted.length; i++) {
    if ((order[ourSorted[i - 1].status] ?? 9) > (order[ourSorted[i].status] ?? 9)) { sorted = false; break; }
  }
  check('L7 sort priority: expired before expiring_soon before active', sorted,
    `order=${ourSorted.map((r) => r.status).join(',')}`);

  // ── /api/batches/:id detail ──
  const expiredBatch = await ProductBatch.findOne({ where: { batch_number: 'TBL-EXPIRED' } });
  const detail = await callDetail(buildReqA, expiredBatch.batch_id);
  check('D1 detail returns 200', detail._status === 200);
  check('D1 detail.batch carries days_to_expiry (negative for expired)',
    detail._body?.batch?.days_to_expiry < 0,
    `days=${detail._body?.batch?.days_to_expiry}`);
  // D2 — godown sums
  const sumByGodown = (detail._body?.stock_by_godown || []).reduce((s, r) => s + parseFloat(r.current_stock || 0), 0);
  check('D2 stock_by_godown sums to total_stock',
    near(sumByGodown, detail._body?.batch?.total_stock),
    `sum=${sumByGodown} total=${detail._body?.batch?.total_stock}`);
  // D3 — movement carries batch_id + monotonic running balance
  const moves = detail._body?.movement || [];
  check('D3 movement non-empty for a purchased batch', moves.length >= 1, `count=${moves.length}`);
  let calcRunning = 0;
  let runningOk = true;
  for (const m of moves) {
    calcRunning += parseFloat(m.quantity_in || 0) - parseFloat(m.quantity_out || 0);
    if (!near(calcRunning, m.running_balance)) { runningOk = false; break; }
  }
  check('D3 running balance reproducible from quantity_in - quantity_out',
    runningOk, `expected=${calcRunning} last_in_data=${moves[moves.length - 1]?.running_balance}`);
  // D4 — bills_touched dedupes
  const billsTouched = detail._body?.bills_touched || [];
  const uniqueRefs = new Set(billsTouched.map((b) => `${b.transaction_type}:${b.reference_id}`));
  check('D4 bills_touched dedupes by (type, reference)', uniqueRefs.size === billsTouched.length);

  // ── /api/batches/expiry-report ──
  const expRpt = await callExpiry(buildReqA);
  check('E1 expiry report status 200', expRpt._status === 200);
  const ourBuckets = (expRpt._body?.data || []).filter((r) => r.batch_number?.startsWith('TBL-'));
  const bucketByNum = Object.fromEntries(ourBuckets.map((r) => [r.batch_number, r.bucket]));
  check('E1 EXPIRED row → bucket=expired',     bucketByNum['TBL-EXPIRED'] === 'expired',     `b=${bucketByNum['TBL-EXPIRED']}`);
  check('E1 SOON row → bucket=0_30',           bucketByNum['TBL-SOON']    === '0_30',        `b=${bucketByNum['TBL-SOON']}`);
  check('E1 LATE row → bucket=91_plus',        bucketByNum['TBL-LATE']    === '91_plus',     `b=${bucketByNum['TBL-LATE']}`);
  check('E1 NOEXP row → bucket=no_expiry',     bucketByNum['TBL-NOEXP']   === 'no_expiry',   `b=${bucketByNum['TBL-NOEXP']}`);
  // E2 — bucket filter
  const expFilt = await callExpiry(buildReqA, { bucket: 'expired,0_30' });
  const bucketsOnly = (expFilt._body?.data || []).filter((r) => r.batch_number?.startsWith('TBL-'))
    .every((r) => r.bucket === 'expired' || r.bucket === '0_30');
  check('E2 bucket filter restricts return set', bucketsOnly);
  // E3 — sort: smallest days_to_expiry first; nulls last
  const sortable = (expRpt._body?.data || []).filter((r) => r.batch_number?.startsWith('TBL-'));
  let dteSorted = true;
  for (let i = 1; i < sortable.length; i++) {
    const a = sortable[i - 1].days_to_expiry == null ? Number.POSITIVE_INFINITY : sortable[i - 1].days_to_expiry;
    const b = sortable[i].days_to_expiry == null     ? Number.POSITIVE_INFINITY : sortable[i].days_to_expiry;
    if (a > b) { dteSorted = false; break; }
  }
  check('E3 expiry-report sort: smallest days_to_expiry first; nulls last', dteSorted);

  // ── B3 invariant — force a NULL batch_id on a batched product's ledger row ──
  // Baseline: there may be pre-existing legacy Opening-Stock rows from other
  // batch-tracked products in the DB (B3 catches those too — that's the
  // point). We measure the delta around our forced violation rather than
  // asserting B3 is globally green, which would require cleaning legacy data.
  let baseline = await checkIntegrity();
  const baseB3Count = baseline.invariants.find((i) => i.id === 'B3')?.violation_count || 0;

  const someLedger = await StockLedger.findOne({
    where: { product_id: fix.pharma.product_id },
    order: [['ledger_id', 'DESC']],
  });
  const originalBatchId = someLedger.batch_id;
  await sequelize.query(`UPDATE stock_ledger SET batch_id = NULL WHERE ledger_id = :id`,
    { replacements: { id: someLedger.ledger_id } });
  let intg = await checkIntegrity();
  const b3 = intg.invariants.find((i) => i.id === 'B3');
  check('B3 surfaces NULL batch_id on a batch-tracked product (delta +1 over baseline)',
    b3 && b3.ok === false && b3.violation_count === baseB3Count + 1,
    `expected=${baseB3Count + 1} got=${b3?.violation_count}`);
  // Restore
  await sequelize.query(`UPDATE stock_ledger SET batch_id = :bid WHERE ledger_id = :id`,
    { replacements: { id: someLedger.ledger_id, bid: originalBatchId } });
  intg = await checkIntegrity();
  const b3After = intg.invariants.find((i) => i.id === 'B3');
  check('B3 violation count returns to baseline after restoration',
    b3After && (b3After.violation_count || 0) === baseB3Count,
    `baseline=${baseB3Count} after=${b3After?.violation_count}`);

  // ── B5 invariant — force negative batch_stock at a (batch, godown) ──
  const expiredBatchRow = await ProductBatch.findOne({ where: { batch_number: 'TBL-EXPIRED' } });
  await sequelize.query(
    `UPDATE product_batch_stock SET current_stock = -5
       WHERE product_id = :pid AND batch_id = :bid AND godown_id = :gid`,
    { replacements: { pid: fix.pharma.product_id, bid: expiredBatchRow.batch_id, gid: fix.godown.godown_id } },
  );
  intg = await checkIntegrity();
  const b5 = intg.invariants.find((i) => i.id === 'B5');
  check('B5 surfaces negative batch_stock',
    b5 && b5.ok === false && b5.violation_count >= 1,
    `b5=${JSON.stringify(b5)}`);
  // Restore (set back to 30 since that's what the purchase wrote)
  await sequelize.query(
    `UPDATE product_batch_stock SET current_stock = 30
       WHERE product_id = :pid AND batch_id = :bid AND godown_id = :gid`,
    { replacements: { pid: fix.pharma.product_id, bid: expiredBatchRow.batch_id, gid: fix.godown.godown_id } },
  );
  intg = await checkIntegrity();
  const b5After = intg.invariants.find((i) => i.id === 'B5');
  check('B5 returns to green after restoration',
    b5After && b5After.ok === true,
    `b5=${JSON.stringify(b5After)}`);

  // ── B4 — orphan ProductBatch — should always be green if FK is in place ──
  const finalIntg = await checkIntegrity();
  const b4 = finalIntg.invariants.find((i) => i.id === 'B4');
  check('B4 orphan-batch check is green (FK enforced)',
    b4 && b4.ok === true,
    `b4=${JSON.stringify(b4)}`);
}

(async () => {
  try {
    await runTests();
  } catch (err) {
    console.error('Test runner failure:', err);
    fail++;
  } finally {
    try { await cleanup(); } catch (e) { console.error('Cleanup failed:', e.message); }
    console.log('\n── Batch list / detail / expiry / B3-B5 ──');
    results.forEach((r) => console.log(r));
    console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
    await sequelize.close();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
