#!/usr/bin/env node
// Phase-R7 self-test: Bills Receivable + Bills Payable.
//
// Drives the new billsOutstandingController directly (no HTTP).
// Asserts on response shape, paisa-exact reconciliation invariant,
// pagination, filters, sort, group_by ordering, search, KPI summary,
// allocation-completeness flag, distinct-cities filter meta.
//
// Coverage map (one line per case, BR + BP mirrored):
//
//   BR: 1.x  shape contract                4 checks
//   BR: 2.x  reconciliation 6-term         6 checks
//   BR: 3.x  pagination (page/limit)       3 checks
//   BR: 4.x  filters (party, bucket, amount, search, show_zero)  6 checks
//   BR: 5.x  sort + group_by               4 checks
//   BR: 6.x  KPI summary                   3 checks
//   BR: 7.x  filter_meta + bucket_labels   2 checks
//   BR: 8.x  allocation_complete flag      1 check
//   BP: 9.x  parity with BR (mirror)       4 checks
//   BP:10.x  reconciliation balanced       1 check
//
// Run: node server/scripts/test-phase-r7.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const ctrl = require('../controllers/billsOutstandingController');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

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

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function main() {
  // ── BR baseline ───────────────────────────────────────────────────
  const r = await call(ctrl.billsReceivable, {});

  // 1.x — Response shape contract
  check('1.1 BR: status 200', r.status === 200);
  check('1.2 BR: data is array',
    Array.isArray(r.body.data));
  check('1.3 BR: total/page/limit are numbers',
    typeof r.body.total === 'number'
    && typeof r.body.page === 'number'
    && typeof r.body.limit === 'number');
  check('1.4 BR: summary + reconciliation + bucket_labels + filter_meta present',
    !!r.body.summary && !!r.body.reconciliation
    && !!r.body.bucket_labels && !!r.body.filter_meta);

  // 2.x — Reconciliation 6-term invariant
  const recon = r.body.reconciliation;
  check('2.1 BR: reconciliation sub_group = Sundry Debtors',
    recon.sub_group === 'Sundry Debtors');
  check('2.2 BR: 6 terms present (bill/paid/unalloc/returns/openDr/openCr)',
    typeof recon.bill_outstanding === 'number'
    && typeof recon.paid_in_bills === 'number'
    && typeof recon.unallocated_receipts === 'number'
    && typeof recon.returns_offset === 'number'
    && typeof recon.opening_dr === 'number'
    && typeof recon.opening_cr === 'number');
  check('2.3 BR: expected = bill + paid − unalloc − returns + openDr − openCr (paisa-exact)',
    Math.abs(r2(recon.bill_outstanding + recon.paid_in_bills - recon.unallocated_receipts
              - recon.returns_offset + recon.opening_dr - recon.opening_cr)
             - r2(recon.expected_ledger_outstanding)) < 0.01);
  check('2.4 BR: difference = ledger − expected (paisa-exact)',
    Math.abs(r2(recon.ledger_outstanding - recon.expected_ledger_outstanding)
             - r2(recon.difference)) < 0.01);
  check('2.5 BR: balanced flag = (|diff| < 0.01)',
    recon.balanced === (Math.abs(recon.difference) < 0.01));
  check('2.6 BR: bill_outstanding = sum of data outstanding (page 1, no filters, ≤200 rows)',
    // For seed data BR has 14 bills → fits in default limit, so the
    // page sum equals the global outstanding.
    r.body.total <= 200
      ? Math.abs(r2(r.body.data.reduce((s, x) => s + x.outstanding, 0))
                 - r2(recon.bill_outstanding)) < 0.01
      : true,
    `pageSum=${r2(r.body.data.reduce((s, x) => s + x.outstanding, 0))} bill_out=${recon.bill_outstanding}`);

  // 3.x — Pagination
  const p1 = await call(ctrl.billsReceivable, { limit: 5, page: 1 });
  const p2 = await call(ctrl.billsReceivable, { limit: 5, page: 2 });
  check('3.1 BR: page 1 returns ≤5 rows', p1.body.data.length <= 5);
  check('3.2 BR: page 2 returns different bills than page 1',
    p1.body.data.length === 0 || p2.body.data.length === 0
    || p1.body.data[0].bill_id !== p2.body.data[0]?.bill_id);
  check('3.3 BR: total is independent of page', p1.body.total === p2.body.total);

  // 4.x — Filters
  const totalBills = r.body.total;
  if (r.body.data.length > 0) {
    const aPartyId = r.body.data[0].party_id;
    const fByParty = await call(ctrl.billsReceivable, { party_ids: String(aPartyId) });
    check('4.1 BR: filter by party returns only that party',
      fByParty.body.data.every((row) => row.party_id === aPartyId));
  } else {
    check('4.1 BR: filter by party (skipped — no rows)', true);
  }

  const fBucket = await call(ctrl.billsReceivable, { buckets: 'b4' });
  check('4.2 BR: filter by bucket=b4 returns rows with overdue > 90',
    fBucket.body.data.every((row) => row.overdue_days > 90)
    || fBucket.body.total === 0);

  const fAmount = await call(ctrl.billsReceivable, { min_amount: '10000' });
  check('4.3 BR: filter by min_amount=10000',
    fAmount.body.data.every((row) => row.outstanding >= 10000));

  // Search by bill number — pick a bill from the list and search for it.
  if (r.body.data.length > 0) {
    const billNo = r.body.data[0].bill_number;
    const fSearch = await call(ctrl.billsReceivable, { search: billNo });
    check('4.4 BR: search by bill_number finds the bill',
      fSearch.body.data.some((row) => row.bill_number === billNo));
  } else {
    check('4.4 BR: search by bill_number (skipped — no rows)', true);
  }

  const fShowZero = await call(ctrl.billsReceivable, { show_zero: 'true' });
  check('4.5 BR: show_zero=true returns ≥ rows than default',
    fShowZero.body.total >= totalBills);

  // bill date range
  const fDate = await call(ctrl.billsReceivable, { bill_from: '2025-04-01', bill_to: '2025-04-30' });
  check('4.6 BR: bill date range filter restricts to that window',
    fDate.body.data.every((row) => row.bill_date >= '2025-04-01' && row.bill_date <= '2025-04-30'));

  // 5.x — Sort + group
  const sortAmt = await call(ctrl.billsReceivable, { sort: 'outstanding', dir: 'desc', limit: 10 });
  const desc = sortAmt.body.data.map((r) => r.outstanding);
  check('5.1 BR: sort outstanding desc',
    desc.length < 2 || desc.every((v, i) => i === 0 || v <= desc[i - 1]));

  const sortDate = await call(ctrl.billsReceivable, { sort: 'bill_date', dir: 'asc', limit: 10 });
  const asc = sortDate.body.data.map((r) => r.bill_date);
  check('5.2 BR: sort bill_date asc',
    asc.length < 2 || asc.every((v, i) => i === 0 || v >= asc[i - 1]));

  const grpParty = await call(ctrl.billsReceivable, { group_by: 'party' });
  check('5.3 BR: group_by=party returns rows ordered by party_name',
    grpParty.body.data.length < 2
    || grpParty.body.data.every((v, i) => i === 0
       || v.party_name >= grpParty.body.data[i - 1].party_name));

  const grpBucket = await call(ctrl.billsReceivable, { group_by: 'bucket' });
  check('5.4 BR: group_by=bucket returns rows ordered by overdue desc',
    grpBucket.body.data.length < 2
    || grpBucket.body.data.every((v, i) => i === 0
       || v.overdue_days <= grpBucket.body.data[i - 1].overdue_days));

  // 6.x — KPI summary
  const s = r.body.summary;
  check('6.1 BR: summary numbers all present',
    typeof s.total_outstanding === 'number'
    && typeof s.bill_count === 'number'
    && typeof s.party_count === 'number'
    && typeof s.overdue_amount === 'number'
    && typeof s.avg_days_overdue === 'number'
    && typeof s.oldest_days === 'number');
  check('6.2 BR: bill_count = total',
    s.bill_count === r.body.total);
  check('6.3 BR: overdue_amount ≤ total_outstanding',
    s.overdue_amount <= s.total_outstanding + 0.01);

  // 7.x — Filter meta + bucket labels
  check('7.1 BR: filter_meta has distinct_cities + distinct_states arrays',
    Array.isArray(r.body.filter_meta.distinct_cities)
    && Array.isArray(r.body.filter_meta.distinct_states));
  check('7.2 BR: bucket_labels has 5 keys',
    ['current', 'b1', 'b2', 'b3', 'b4'].every((k) => k in r.body.bucket_labels));

  // 8.x — Allocation flag
  check('8.1 BR: allocation_complete is boolean',
    typeof r.body.allocation_complete === 'boolean');

  // 9.x — BP parity
  const bp = await call(ctrl.billsPayable, {});
  check('9.1 BP: status 200', bp.status === 200);
  check('9.2 BP: party_type = Supplier', bp.body.party_type === 'Supplier');
  check('9.3 BP: reconciliation sub_group = Sundry Creditors',
    bp.body.reconciliation.sub_group === 'Sundry Creditors');
  check('9.4 BP: same response shape as BR',
    !!bp.body.summary && !!bp.body.reconciliation
    && Array.isArray(bp.body.data)
    && typeof bp.body.allocation_complete === 'boolean');

  // 10.x — BP reconciliation balanced (seed data has matching purchase
  // ledger; if it ever drifts the user wants to see the banner, but on
  // this seed it's clean)
  check('10.1 BP: reconciliation balanced or surfaces difference',
    typeof bp.body.reconciliation.balanced === 'boolean'
    && typeof bp.body.reconciliation.difference === 'number');

  // Bonus: sub-paisa stable totals across pages (chunk all pages and
  // verify their sum equals total_outstanding).
  if (r.body.total > 0) {
    let walked = 0; let walkSum = 0;
    let p = 1;
    while (walked < r.body.total) {
      const pg = await call(ctrl.billsReceivable, { page: p, limit: 100 });
      for (const row of pg.body.data) walkSum += row.outstanding;
      walked += pg.body.data.length;
      if (pg.body.data.length === 0) break;
      p++;
    }
    check('Bonus.1 BR: walked-pages outstanding sum = summary.total_outstanding',
      Math.abs(r2(walkSum) - r2(s.total_outstanding)) < 0.01,
      `walked=${r2(walkSum)} summary=${r2(s.total_outstanding)}`);
  }

  // ── Final summary ───────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────');
  console.log(`Phase R7 — Bills Receivable / Payable self-test`);
  console.log('──────────────────────────────────────────────');
  for (const r of results) console.log(r);
  console.log('──────────────────────────────────────────────');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  console.log('──────────────────────────────────────────────\n');

  await sequelize.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Test runner error:', err);
  try { await sequelize.close(); } catch {}
  process.exit(2);
});
