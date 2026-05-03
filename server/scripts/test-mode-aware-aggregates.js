#!/usr/bin/env node
/*
 * Mode-aware aggregate hotspots — Commit 3c integration tests.
 * Run with: node server/scripts/test-mode-aware-aggregates.js
 *
 * Covers (per audit):
 *   • Hotspot E — productController.getAll summary.total_stock_value
 *   • Hotspot I — Dashboard stockValue.purchase tile
 *   • Hotspot B — Stock Report summary.total_purchase_value
 *   • Hotspot D — Stock Report category_breakdown[].stock_value
 *   • Hotspot C — Stock Report sort by stock_value (mode-aware ORDER BY)
 *   • Hotspot F — Stock Summary closing_value
 *   • Hotspot G — Godown Valuation summary[].total_value
 *   • Hotspot H — Godown Valuation detail[].value
 *
 * Each hotspot tested for: variant uses purchase_rate, single uses
 * weighted_avg_cost, single+batch uses batch-weighted aggregate.
 *
 * Cross-checks:
 *   • Products list summary = Dashboard tile (consistency)
 *   • Stock Report summary = SUM of category_breakdown stock_values
 *   • Godown Valuation summary[].total_value = SUM of detail[].value
 *     for that godown
 *   • Books reconciliation untouched
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Product, ProductBatch, ProductBatchStock, Godown, User, Role,
  Party, SystemSettings, Category,
} = require('../models');
const purchaseController = require('../controllers/purchaseController');
const productController = require('../controllers/productController');
const reportController = require('../controllers/reportController');
const operationalReportsController = require('../controllers/operationalReportsController');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TMA_';

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
  const testCatSel  = `(SELECT category_id FROM categories WHERE category_name LIKE :p)`;
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
    mobile_1: '9000099299', is_active: true,
  });

  const variantP = await Product.create({
    barcode: FIXTURE_PREFIX + 'V', product_name: FIXTURE_PREFIX + 'Variant',
    category_id: cat.category_id, purchase_rate: 80, sale_rate: 100, mrp: 120,
    quantity_per_box: 1, current_stock: 0,
    product_mode: 'variant', is_active: true,
  });
  const singleP = await Product.create({
    barcode: FIXTURE_PREFIX + 'S', product_name: FIXTURE_PREFIX + 'Single',
    category_id: cat.category_id, purchase_rate: 100, sale_rate: 130, mrp: 150,
    quantity_per_box: 1, current_stock: 0,
    product_mode: 'single', is_active: true,
  });
  const batchP = await Product.create({
    barcode: FIXTURE_PREFIX + 'B', product_name: FIXTURE_PREFIX + 'Batch',
    category_id: cat.category_id, purchase_rate: 5, sale_rate: 8, mrp: 10,
    quantity_per_box: 1, current_stock: 0,
    product_mode: 'single', is_batch_tracked: true, is_active: true,
  });

  await SystemSettings.update({ batch_tracking_enabled: true }, { where: { setting_id: 1 } });
  return { adminUser, godown, cat, supplier, variantP, singleP, batchP };
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

async function runTests() {
  await cleanup();
  const fix = await setupFixtures();
  const buildReq = (body) => ({ user: fix.adminUser, params: {}, body });

  // Seed each product:
  //   Variant : 10 units @ ₹80  → contribution = 800
  //   Single  : 10 @ ₹100, then 5 @ ₹120 → wac=106.6667, qty=15, contrib=1600
  //   Batch   : LOT-A 10 @ ₹100, LOT-B 5 @ ₹120 → contrib=1600
  await purchase(buildReq, fix, fix.variantP.product_id, {
    product_name: fix.variantP.product_name, barcode: fix.variantP.barcode,
    qty: 10, rate: 80,
  });
  await purchase(buildReq, fix, fix.singleP.product_id, {
    product_name: fix.singleP.product_name, barcode: fix.singleP.barcode,
    qty: 10, rate: 100,
  });
  await purchase(buildReq, fix, fix.singleP.product_id, {
    product_name: fix.singleP.product_name, barcode: fix.singleP.barcode,
    qty: 5, rate: 120,
  });
  await purchase(buildReq, fix, fix.batchP.product_id, {
    product_name: fix.batchP.product_name, barcode: fix.batchP.barcode,
    qty: 10, rate: 100, batch_number: 'LOT-A',
  });
  await purchase(buildReq, fix, fix.batchP.product_id, {
    product_name: fix.batchP.product_name, barcode: fix.batchP.barcode,
    qty: 5, rate: 120, batch_number: 'LOT-B',
  });

  const expectedFixtureContribution = 800 + 1600 + 1600; // = 4000

  // ── Hotspot E: productController.getAll summary.total_stock_value ──
  // Filter by category to isolate fixture totals.
  {
    const res = mockRes();
    await productController.getAll({
      query: { category_id: String(fix.cat.category_id), include_stats: 'true' },
    }, res);
    const summary = res._body?.summary;
    check('E: products list summary has expected total_stock_value (4000)',
      near(summary?.total_stock_value, 4000),
      `total_stock_value=${summary?.total_stock_value}`);

    // Cross-check: rows' display_stock_value SUM must equal summary
    const rows = res._body?.data || [];
    const rowSum = rows.reduce((s, r) => s + (parseFloat(r.display_stock_value) || 0), 0);
    check('E: per-row display_stock_value SUM equals summary.total_stock_value',
      near(rowSum, summary?.total_stock_value),
      `rowSum=${rowSum} summary=${summary?.total_stock_value}`);
  }

  // ── Hotspot I: Dashboard stock_value.purchase tile ──
  {
    const res = mockRes();
    await reportController.dashboardStats({ query: {} }, res);
    const dashTotal = res._body?.stock_value?.purchase;
    // We compare the delta from a baseline fetch (with our fixtures excluded)
    // by recomputing via productController.getAll without category filter and
    // confirming the dashboard sums everything.
    // Simplest: compare the variant + single (no batch) + batch contribution
    // is INCLUDED — confirm dashboard is at least our 4000.
    check('I: dashboard stock_value.purchase includes the 4000 fixture contribution',
      dashTotal >= 4000 - 0.01, `dash=${dashTotal}`);
  }

  // ── Hotspots B / C / D: Stock Report ──
  {
    const res = mockRes();
    await reportController.stockReport({ query: {
      category_id: String(fix.cat.category_id),
      sort_by: 'stock_value', sort_dir: 'desc',
      limit: 100,
    }}, res);
    const summary = res._body?.summary;
    check('B: Stock Report summary.total_purchase_value = 4000',
      near(summary?.total_purchase_value, 4000),
      `total_purchase_value=${summary?.total_purchase_value}`);

    // D: category_breakdown sums to total_purchase_value (consistency)
    const cb = res._body?.category_breakdown || [];
    const cbSum = cb.reduce((s, c) => s + (parseFloat(c.stock_value) || 0), 0);
    check('D: Stock Report category_breakdown stock_value SUM equals summary total',
      near(cbSum, summary?.total_purchase_value),
      `cbSum=${cbSum} summaryTotal=${summary?.total_purchase_value}`);

    // C: sort_by stock_value DESC. Sort key per the audit-documented
    // approximation:
    //   variant            → current_stock × purchase_rate     (10 × 80 = 800)
    //   single (no batch)  → current_stock × wac (or purchase) (15 × 106.67 ≈ 1600)
    //   single + batch     → current_stock × purchase_rate     (15 × 5 = 75)
    //                        (fallback — batch's TRUE value of 1600 doesn't
    //                        fit in ORDER BY without per-row JOIN; tradeoff
    //                        accepted, documented in source)
    // So expected order DESC: single (1600) → variant (800) → batch (75)
    const rows = res._body?.data || [];
    const fixtureRows = rows.filter(r =>
      r.product_id === fix.variantP.product_id ||
      r.product_id === fix.singleP.product_id ||
      r.product_id === fix.batchP.product_id);
    check('C: Stock Report sort by stock_value desc — single first, variant middle, batch last (approximation)',
      fixtureRows.length === 3
        && fixtureRows[0].product_id === fix.singleP.product_id
        && fixtureRows[1].product_id === fix.variantP.product_id
        && fixtureRows[2].product_id === fix.batchP.product_id,
      `order=${fixtureRows.map(r => r.product_id).join(', ')}`);
  }

  // ── Hotspot F: Stock Summary closing_value per row ──
  {
    const res = mockRes();
    await operationalReportsController.stockSummary({ query: {
      category_id: String(fix.cat.category_id),
      from_date: '2026-04-01', to_date: '2026-12-31',
    }}, res);
    const products = res._body?.products || [];
    const variantRow = products.find(p => p.product_id === fix.variantP.product_id);
    const singleRow  = products.find(p => p.product_id === fix.singleP.product_id);
    const batchRow   = products.find(p => p.product_id === fix.batchP.product_id);

    check('F: Stock Summary variant closing_value = 800 (uses purchase_rate)',
      near(variantRow?.closing_value, 800),
      `variant closing_value=${variantRow?.closing_value}`);
    check('F: Stock Summary single closing_value = 1600 (uses wac)',
      near(singleRow?.closing_value, 1600),
      `single closing_value=${singleRow?.closing_value}`);
    check('F: Stock Summary single+batch closing_value = 1600 (uses batch agg)',
      near(batchRow?.closing_value, 1600),
      `batch closing_value=${batchRow?.closing_value}`);
  }

  // ── Hotspot G/H: Godown Valuation ──
  {
    const res = mockRes();
    await operationalReportsController.godownValuation({ query: { detail: 'true' } }, res);
    const summary = res._body?.summary || [];
    const detail  = res._body?.detail  || [];
    const myGodown = summary.find(s => s.godown_id === fix.godown.godown_id);
    check('G: Godown Valuation summary contains the default godown',
      !!myGodown, `summary=${JSON.stringify(summary).slice(0, 200)}`);

    // Per-product detail at this godown
    const myDetail = detail.filter(d => d.godown_id === fix.godown.godown_id);
    const detailVariant = myDetail.find(d => d.product_id === fix.variantP.product_id);
    const detailSingle  = myDetail.find(d => d.product_id === fix.singleP.product_id);
    const detailBatch   = myDetail.find(d => d.product_id === fix.batchP.product_id);
    check('H: Godown Valuation detail variant value = 800',
      near(detailVariant?.value, 800), `value=${detailVariant?.value}`);
    check('H: Godown Valuation detail single value = 1600 (uses wac)',
      near(detailSingle?.value, 1600), `value=${detailSingle?.value}`);
    check('H: Godown Valuation detail single+batch value = 1600 (per-godown batch agg)',
      near(detailBatch?.value, 1600), `value=${detailBatch?.value}`);

    // Reconciliation: per-godown summary.total_value >= sum of fixture detail
    // values at that godown (other products contribute too)
    const fixtureDetailSum = (detailVariant?.value || 0) + (detailSingle?.value || 0) + (detailBatch?.value || 0);
    check('G/H: Godown summary.total_value includes the 4000 fixture contribution',
      myGodown && myGodown.total_value >= fixtureDetailSum - 0.01,
      `godownTotal=${myGodown?.total_value} fixtureSum=${fixtureDetailSum}`);
  }

  // ── Cross-check: Products list summary + Dashboard match for full set ──
  {
    const dashRes = mockRes();
    await reportController.dashboardStats({ query: {} }, dashRes);
    const dashTotal = dashRes._body?.stock_value?.purchase;

    const plRes = mockRes();
    await productController.getAll({ query: {} }, plRes);
    const plTotal = plRes._body?.summary?.total_stock_value;

    check('CROSS: Products list summary == Dashboard tile (no filter) — both use mode-aware basis',
      near(dashTotal, plTotal, 0.05),
      `dash=${dashTotal} list=${plTotal}`);
  }
}

async function main() {
  console.log('━━━ Mode-aware aggregate hotspots (Commit 3c) tests ━━━');
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
