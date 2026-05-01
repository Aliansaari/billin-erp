#!/usr/bin/env node
// Phase-R11 self-test: Product Items Detail (sales / purchase).
//
// Coverage map:
//
//   1.x  Sales endpoint shape + pagination + summary keys     5 checks
//   2.x  Purchase endpoint shape + line_value (no profit)     3 checks
//   3.x  Date filter (from/to)                                 2 checks
//   4.x  Party filter, Category filter                         2 checks
//   5.x  Product / Barcode / HSN filter                        3 checks
//   6.x  Free-text search across bill/party/product            1 check
//   7.x  Sort (bill_date desc default, asc on flag)            2 checks
//   8.x  Profit calc on sales = (rate − cost) × qty − disc     1 check
//   9.x  Cancelled bill excluded                                1 check
//  10.x  Filter meta: distinct categories                       1 check
//
// Run: node server/scripts/test-phase-r11.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const ctrl = require('../controllers/productItemsController');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function call(handler, query) {
  return new Promise((resolve, reject) => {
    const req = { query };
    const res = {
      status(c) { this._s = c; return this; },
      json(b)   { resolve({ status: this._s || 200, body: b }); },
    };
    handler(req, res).catch(reject);
  });
}

async function t_sales_shape() {
  const r = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31', limit: 5 });
  check('1.1 Sales: status 200', r.status === 200);
  check('1.2 Sales: data is array, length ≤ limit', Array.isArray(r.body.data) && r.body.data.length <= 5);
  check('1.3 Sales: total/page/limit numeric',
    typeof r.body.total === 'number' && r.body.page === 1 && r.body.limit === 5);
  check('1.4 Sales: summary has profit + cost',
    r.body.summary && typeof r.body.summary.total_profit === 'number'
      && typeof r.body.summary.total_cost === 'number');
  if (r.body.data.length > 0) {
    const row = r.body.data[0];
    check('1.5 Sales: row has full shape (party + product + cost + profit)',
      row.bill_number && row.party_name && row.product_name
        && typeof row.profit === 'number'
        && typeof row.cost_rate === 'number');
  } else {
    check('1.5 Sales: row shape (no rows in window — skipping)', true);
  }
}

async function t_purchase_shape() {
  const r = await call(ctrl.productPurchaseItems, { from_date: '2025-04-01', to_date: '2026-03-31', limit: 5 });
  check('2.1 Purchase: status 200', r.status === 200);
  check('2.2 Purchase: summary has total_value but NOT total_profit',
    typeof r.body.summary.total_value === 'number'
      && r.body.summary.total_profit === undefined);
  if (r.body.data.length > 0) {
    const row = r.body.data[0];
    check('2.3 Purchase: row has line_value but NOT profit',
      typeof row.line_value === 'number' && row.profit === undefined);
  } else {
    check('2.3 Purchase: skip (no rows)', true);
  }
}

async function t_date_filter() {
  const apr = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2025-04-30' });
  const may = await call(ctrl.productSalesItems, { from_date: '2025-05-01', to_date: '2025-05-31' });
  const both = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2025-05-31' });
  check('3.1 Date filter restricts to window', apr.body.total <= both.body.total);
  check('3.2 Both-month total ≥ each individual month',
    both.body.total >= apr.body.total && both.body.total >= may.body.total);
}

async function t_party_category_filters() {
  // Pull a real customer + category from filter_meta (ensures fixtures match seed).
  const probe = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31', limit: 1 });
  if (probe.body.data.length === 0) {
    check('4.1 Party filter (no seed data)', true);
    check('4.2 Category filter (no seed data)', true);
    return;
  }
  const partyId = probe.body.data[0].party_id;
  const filtered = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31', party_ids: String(partyId) });
  const allSamePartyId = filtered.body.data.every((r) => r.party_id === partyId);
  check('4.1 Party filter: every row matches party_id', allSamePartyId,
    `total=${filtered.body.total}`);

  const categoryId = probe.body.data[0].category_id;
  if (categoryId) {
    const catFiltered = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31', category_ids: String(categoryId) });
    const allSameCat = catFiltered.body.data.every((r) => r.category_id === categoryId);
    check('4.2 Category filter: every row matches category_id', allSameCat,
      `total=${catFiltered.body.total}`);
  } else {
    check('4.2 Category filter (no category in fixture)', true);
  }
}

async function t_product_barcode_hsn_filters() {
  const probe = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31', limit: 1 });
  if (probe.body.data.length === 0) {
    check('5.1 Product search (no rows)', true);
    check('5.2 Barcode filter (no rows)', true);
    check('5.3 HSN filter (no rows)', true);
    return;
  }
  const sampleProd = probe.body.data[0].product_name;
  const sampleBC   = probe.body.data[0].barcode;
  const sampleHsn  = probe.body.data[0].hsn_code;

  const ps = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31',
                                                   product_search: sampleProd.split(' ')[0] });
  check('5.1 Product search returns rows containing the term',
    ps.body.data.length > 0
      && ps.body.data.every((r) => r.product_name.toLowerCase().includes(sampleProd.split(' ')[0].toLowerCase())));

  if (sampleBC && sampleBC !== '—') {
    const bc = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31',
                                                     barcode: sampleBC });
    check('5.2 Barcode exact match returns only that barcode',
      bc.body.data.length > 0 && bc.body.data.every((r) => r.barcode === sampleBC));
  } else { check('5.2 Barcode filter skipped (no barcode on probe)', true); }

  if (sampleHsn && sampleHsn !== '—') {
    const hsn = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31',
                                                      hsn_code: sampleHsn });
    check('5.3 HSN filter returns rows starting with the code',
      hsn.body.data.length > 0 && hsn.body.data.every((r) => (r.hsn_code || '').startsWith(sampleHsn)));
  } else { check('5.3 HSN filter skipped (no hsn on probe)', true); }
}

async function t_free_text_search() {
  const probe = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31', limit: 1 });
  if (probe.body.data.length === 0) {
    check('6.1 Search (no rows)', true);
    return;
  }
  const partyName = probe.body.data[0].party_name;
  const r = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31',
                                                  search: partyName.slice(0, 4) });
  check('6.1 Free-text search across party/bill/product returns rows',
    r.body.total > 0);
}

async function t_sort() {
  const desc = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31',
                                                     sort: 'bill_date', dir: 'desc', limit: 5 });
  const asc  = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31',
                                                     sort: 'bill_date', dir: 'asc',  limit: 5 });
  if (desc.body.data.length < 2 || asc.body.data.length < 2) {
    check('7.1 Sort desc (skip — too few rows)', true);
    check('7.2 Sort asc (skip — too few rows)', true);
    return;
  }
  const descOK = desc.body.data[0].bill_date >= desc.body.data[desc.body.data.length - 1].bill_date;
  const ascOK  = asc.body.data[0].bill_date  <= asc.body.data[asc.body.data.length - 1].bill_date;
  check('7.1 Sort bill_date desc', descOK,
    `first=${desc.body.data[0].bill_date} last=${desc.body.data[desc.body.data.length-1].bill_date}`);
  check('7.2 Sort bill_date asc', ascOK,
    `first=${asc.body.data[0].bill_date}  last=${asc.body.data[asc.body.data.length-1].bill_date}`);
}

async function t_profit_calc() {
  const probe = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31', limit: 50 });
  // Find a row with cost_rate > 0 to sanity-check.
  const sample = probe.body.data.find((r) => r.cost_rate > 0 && r.quantity > 0);
  if (!sample) { check('8.1 Profit calc (no row with cost > 0)', true); return; }
  const expected = r2((sample.rate - sample.cost_rate) * sample.quantity - sample.discount_amount);
  check('8.1 Profit = (rate − cost) × qty − discount',
    Math.abs(sample.profit - expected) < 0.01,
    `row.profit=${sample.profit} expected=${expected}`);
}

async function t_cancelled_excluded() {
  const r = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31' });
  // Cross-check vs raw SQL — cancelled bills must contribute 0 lines.
  const [cnt] = await sequelize.query(
    `SELECT COUNT(*)::int n FROM sales_bill_items i
       JOIN sales_bills b ON b.sales_bill_id = i.sales_bill_id
      WHERE b.is_cancelled = true
        AND b.bill_date BETWEEN '2025-04-01' AND '2026-03-31'`,
    { type: sequelize.QueryTypes.SELECT },
  );
  // Total returned rows + cancelled-line count should equal total non-
  // cancelled OR total cancelled count > 0 means our filter actually
  // excludes them. Simplest assertion: every row's bill is non-cancelled
  // (verify via spot SQL).
  if (r.body.data.length === 0) { check('9.1 Cancelled excluded (no rows)', true); return; }
  const ids = r.body.data.slice(0, 20).map((x) => x.bill_id);
  const cancelledIds = await sequelize.query(
    `SELECT sales_bill_id FROM sales_bills WHERE sales_bill_id IN (:ids) AND is_cancelled = true`,
    { replacements: { ids }, type: sequelize.QueryTypes.SELECT },
  );
  check('9.1 No row references a cancelled bill (sample of 20)',
    cancelledIds.length === 0);
}

async function t_filter_meta() {
  const r = await call(ctrl.productSalesItems, { from_date: '2025-04-01', to_date: '2026-03-31' });
  check('10.1 filter_meta.categories present + each has id+name',
    r.body.filter_meta && Array.isArray(r.body.filter_meta.categories)
      && r.body.filter_meta.categories.every((c) => c.id != null && typeof c.name === 'string'));
}

(async () => {
  console.log('──────────────────────────────────────────────');
  console.log('Phase R11 — Product Items Detail self-test');
  console.log('──────────────────────────────────────────────');
  try {
    await t_sales_shape();
    await t_purchase_shape();
    await t_date_filter();
    await t_party_category_filters();
    await t_product_barcode_hsn_filters();
    await t_free_text_search();
    await t_sort();
    await t_profit_calc();
    await t_cancelled_excluded();
    await t_filter_meta();
  } catch (err) {
    console.error('Test runner error:', err);
    fail++;
  }
  for (const r of results) console.log(r);
  console.log('──────────────────────────────────────────────');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  console.log('──────────────────────────────────────────────');
  await sequelize.close();
  process.exit(fail ? 1 : 0);
})();
