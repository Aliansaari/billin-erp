/*
 * Deep unit tests for the aging math. Run with:
 *   node --test server/utils/aging.test.js
 *
 * Every edge case the aging report can encounter is covered here. These
 * tests DO NOT touch the database — pure input/output verification.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeOverdueDays,
  bucketFor,
  bucketLabels,
  aggregateAging,
  round2,
} = require('./aging');

// ─────────────────────────────────────────────────────────────────────
// round2
// ─────────────────────────────────────────────────────────────────────

test('round2: clean integer', () => {
  assert.equal(round2(100), 100);
  assert.equal(round2(0), 0);
});

test('round2: standard halves round AWAY from zero', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.505), 2.51);
  assert.equal(round2(-1.005), -1.01);
});

test('round2: handles null / undefined / strings', () => {
  assert.equal(round2(null), 0);
  assert.equal(round2(undefined), 0);
  assert.equal(round2('abc'), 0);
  assert.equal(round2('12.3456'), 12.35);
});

test('round2: does not accumulate floating-point drift', () => {
  // Naive 0.1*3 returns 0.30000000000000004 — round2 must flatten
  assert.equal(round2(0.1 + 0.1 + 0.1), 0.30);
});

// ─────────────────────────────────────────────────────────────────────
// computeOverdueDays
// ─────────────────────────────────────────────────────────────────────

test('overdue: bill dated today with no due/credit → 0', () => {
  assert.equal(computeOverdueDays('2026-04-24', '2026-04-24', null, 0), 0);
});

test('overdue: bill dated 10 days ago, no credit → 10 days overdue', () => {
  assert.equal(computeOverdueDays('2026-04-24', '2026-04-14', null, 0), 10);
});

test('overdue: credit_days defers the due date', () => {
  // Bill 2026-04-14, 30-day credit → due 2026-05-14 → as-of 2026-04-24 is NOT overdue
  assert.equal(computeOverdueDays('2026-04-24', '2026-04-14', null, 30), 0);
});

test('overdue: explicit due_date overrides credit_days', () => {
  // credit_days would put due at 2026-05-14, but explicit due = 2026-04-20
  // → 4 days overdue.
  assert.equal(
    computeOverdueDays('2026-04-24', '2026-04-14', '2026-04-20', 30),
    4
  );
});

test('overdue: future bills return 0 (never negative)', () => {
  assert.equal(computeOverdueDays('2026-04-24', '2026-05-01', null, 0), 0);
});

test('overdue: boundary — exactly on due date → 0 (not yet overdue)', () => {
  // Due today → 0 days overdue
  assert.equal(computeOverdueDays('2026-04-24', '2026-04-24', '2026-04-24', 0), 0);
});

test('overdue: boundary — 1 day past due → 1', () => {
  assert.equal(computeOverdueDays('2026-04-24', '2026-04-23', '2026-04-23', 0), 1);
});

test('overdue: credit_days string coerced to number', () => {
  assert.equal(computeOverdueDays('2026-04-24', '2026-04-14', null, '30'), 0);
});

test('overdue: spans month/year boundaries correctly', () => {
  // 2025-12-15 to 2026-01-14 = 30 days
  assert.equal(computeOverdueDays('2026-01-14', '2025-12-15', null, 0), 30);
  // 2025-02-28 to 2025-03-01 = 1 day (non-leap)
  assert.equal(computeOverdueDays('2025-03-01', '2025-02-28', null, 0), 1);
  // 2024-02-29 to 2024-03-01 = 1 day (leap)
  assert.equal(computeOverdueDays('2024-03-01', '2024-02-29', null, 0), 1);
});

// ─────────────────────────────────────────────────────────────────────
// bucketFor
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_BOUNDS = { b1: 30, b2: 60, b3: 90 };

test('bucket: 0 days → current', () => {
  assert.equal(bucketFor(0, DEFAULT_BOUNDS), 'current');
});

test('bucket: 1 day overdue → b1', () => {
  assert.equal(bucketFor(1, DEFAULT_BOUNDS), 'b1');
});

test('bucket: exactly b1 (30) → b1 (inclusive upper)', () => {
  assert.equal(bucketFor(30, DEFAULT_BOUNDS), 'b1');
});

test('bucket: b1+1 (31) → b2', () => {
  assert.equal(bucketFor(31, DEFAULT_BOUNDS), 'b2');
});

test('bucket: exactly b2 (60) → b2', () => {
  assert.equal(bucketFor(60, DEFAULT_BOUNDS), 'b2');
});

test('bucket: b2+1 (61) → b3', () => {
  assert.equal(bucketFor(61, DEFAULT_BOUNDS), 'b3');
});

test('bucket: exactly b3 (90) → b3', () => {
  assert.equal(bucketFor(90, DEFAULT_BOUNDS), 'b3');
});

test('bucket: b3+1 (91) → b4', () => {
  assert.equal(bucketFor(91, DEFAULT_BOUNDS), 'b4');
});

test('bucket: very large overdue → b4', () => {
  assert.equal(bucketFor(365, DEFAULT_BOUNDS), 'b4');
  assert.equal(bucketFor(10_000, DEFAULT_BOUNDS), 'b4');
});

test('bucket: negative overdue → current (defensive)', () => {
  assert.equal(bucketFor(-5, DEFAULT_BOUNDS), 'current');
});

test('bucket: custom bounds respected', () => {
  const b = { b1: 15, b2: 45, b3: 75 };
  assert.equal(bucketFor(15, b), 'b1');
  assert.equal(bucketFor(16, b), 'b2');
  assert.equal(bucketFor(75, b), 'b3');
  assert.equal(bucketFor(76, b), 'b4');
});

// ─────────────────────────────────────────────────────────────────────
// bucketLabels
// ─────────────────────────────────────────────────────────────────────

test('labels: default bounds produce standard accounting ranges', () => {
  const l = bucketLabels({ b1: 30, b2: 60, b3: 90 });
  assert.equal(l.current, 'Not Due');
  assert.equal(l.b1, '1–30');
  assert.equal(l.b2, '31–60');
  assert.equal(l.b3, '61–90');
  // b4 starts at b3 + 1 = 91 (a 90-day-old bill is still in b3 per
  // bucketFor's <=b3 cutoff). Audit L1.
  assert.equal(l.b4, '91+');
});

test('labels: custom bounds generate correct ranges', () => {
  const l = bucketLabels({ b1: 15, b2: 45, b3: 75 });
  assert.equal(l.b1, '1–15');
  assert.equal(l.b2, '16–45');
  assert.equal(l.b3, '46–75');
  assert.equal(l.b4, '76+');
});

// ─────────────────────────────────────────────────────────────────────
// aggregateAging — the main aggregation
// ─────────────────────────────────────────────────────────────────────

const BOUNDS = { b1: 30, b2: 60, b3: 90 };
const AS_OF = '2026-04-24';
const P1 = { party_id: 1, party_name: 'ABC Traders', mobile_1: '9000000001', city: 'Mumbai', state: 'Maharashtra', credit_days: 0 };
const P2 = { party_id: 2, party_name: 'XYZ Corp',    mobile_1: '9000000002', city: 'Pune',   state: 'Maharashtra', credit_days: 30 };

function bill(overrides) {
  return {
    bill_id: 100,
    bill_number: 'INV-001',
    bill_date: '2026-04-01',
    due_date: null,
    total_amount: 1000,
    paid_amount: 0,
    balance_amount: 1000,
    party: P1,
    ...overrides,
  };
}

test('aggregate: empty input returns empty result', () => {
  const out = aggregateAging([], AS_OF, BOUNDS);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.grand, { total: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0 });
  assert.equal(out.as_of_date, AS_OF);
});

test('aggregate: single current bill lands in "current"', () => {
  const out = aggregateAging([bill({ bill_date: AS_OF, balance_amount: 500 })], AS_OF, BOUNDS);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].current, 500);
  assert.equal(out.rows[0].b1, 0);
  assert.equal(out.grand.total, 500);
  assert.equal(out.grand.current, 500);
});

test('aggregate: fully-paid bills (balance ≤ 0) are skipped', () => {
  const out = aggregateAging([
    bill({ balance_amount: 0 }),
    bill({ balance_amount: -10 }),
    bill({ balance_amount: 100 }),
  ], AS_OF, BOUNDS);
  assert.equal(out.rows.length, 1);
  assert.equal(out.grand.total, 100);
});

test('aggregate: bills without party are skipped', () => {
  const out = aggregateAging([
    bill({ party: null }),
    bill({ party: { party_id: null } }),
    bill({ balance_amount: 100 }),
  ], AS_OF, BOUNDS);
  assert.equal(out.rows.length, 1);
});

test('aggregate: multiple bills for one party sum to that party', () => {
  const bills = [
    bill({ bill_id: 1, bill_date: AS_OF,       balance_amount: 100 }),   // current
    bill({ bill_id: 2, bill_date: '2026-04-14', balance_amount: 200 }),  // 10d
    bill({ bill_id: 3, bill_date: '2026-03-01', balance_amount: 400 }),  // 54d
  ];
  const out = aggregateAging(bills, AS_OF, BOUNDS);
  assert.equal(out.rows.length, 1);
  const r = out.rows[0];
  assert.equal(r.total, 700);
  assert.equal(r.current, 100);
  assert.equal(r.b1, 200);
  assert.equal(r.b2, 400);
  assert.equal(r.b3, 0);
  assert.equal(r.b4, 0);
  assert.equal(r.bill_count, 3);
  assert.equal(r.oldest_days, 54);
});

test('aggregate: multiple parties are kept separate and sorted by total desc', () => {
  const out = aggregateAging([
    bill({ party: P1, bill_date: AS_OF, balance_amount: 100 }),
    bill({ party: P2, bill_date: AS_OF, balance_amount: 500 }),
    bill({ party: P2, bill_date: AS_OF, balance_amount: 50 }),
  ], AS_OF, BOUNDS);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].party_id, P2.party_id);   // 550 total first
  assert.equal(out.rows[0].total, 550);
  assert.equal(out.rows[1].party_id, P1.party_id);
  assert.equal(out.rows[1].total, 100);
});

test('aggregate: each party\'s bills are sorted by date ascending', () => {
  const bills = [
    bill({ bill_id: 3, bill_number: 'C', bill_date: '2026-02-01' }),
    bill({ bill_id: 1, bill_number: 'A', bill_date: '2026-04-01' }),
    bill({ bill_id: 2, bill_number: 'B', bill_date: '2026-03-01' }),
  ];
  const out = aggregateAging(bills, AS_OF, BOUNDS);
  assert.deepEqual(out.rows[0].bills.map(b => b.bill_number), ['C', 'B', 'A']);
});

test('aggregate: party credit_days shifts due date (P2 has 30d credit)', () => {
  // P2 has credit_days=30. Bill dated 30 days ago but due is still today.
  const bills = [bill({ party: P2, bill_date: '2026-03-25', balance_amount: 100 })];
  const out = aggregateAging(bills, AS_OF, BOUNDS);
  assert.equal(out.rows[0].current, 100);
  assert.equal(out.rows[0].b1, 0);
});

test('aggregate: explicit due_date overrides credit_days', () => {
  const bills = [bill({
    party: P2,              // credit_days=30
    bill_date: '2026-03-25',
    due_date: '2026-04-01', // → 23 days overdue as of 2026-04-24
    balance_amount: 100,
  })];
  const out = aggregateAging(bills, AS_OF, BOUNDS);
  assert.equal(out.rows[0].b1, 100);
  assert.equal(out.rows[0].current, 0);
});

test('aggregate: bucket boundaries — 30, 31, 60, 61, 90, 91', () => {
  const mkBill = (days, id) => bill({
    bill_id: id, bill_number: `B${id}`,
    bill_date: dateSub(AS_OF, days),
    balance_amount: 100,
  });
  const bills = [
    mkBill(1, 1),    // b1
    mkBill(30, 2),   // b1
    mkBill(31, 3),   // b2
    mkBill(60, 4),   // b2
    mkBill(61, 5),   // b3
    mkBill(90, 6),   // b3
    mkBill(91, 7),   // b4
    mkBill(500, 8),  // b4
  ];
  const out = aggregateAging(bills, AS_OF, BOUNDS);
  const r = out.rows[0];
  assert.equal(r.b1, 200, 'b1 should hold days 1 and 30');
  assert.equal(r.b2, 200, 'b2 should hold days 31 and 60');
  assert.equal(r.b3, 200, 'b3 should hold days 61 and 90');
  assert.equal(r.b4, 200, 'b4 should hold days 91 and 500');
  assert.equal(r.current, 0);
  assert.equal(r.total, 800);
});

test('aggregate: grand totals equal sum of row totals across the board', () => {
  const bills = [];
  for (let i = 0; i < 50; i++) {
    bills.push(bill({
      bill_id: i + 1,
      bill_number: `INV-${i + 1}`,
      bill_date: dateSub(AS_OF, (i * 7) % 120),
      balance_amount: 100 + i * 3.33,
      party: i % 3 === 0 ? P1 : P2,
    }));
  }
  const out = aggregateAging(bills, AS_OF, BOUNDS);
  const rowSum = out.rows.reduce((a, r) => a + r.total, 0);
  assert.equal(round2(rowSum), out.grand.total, 'grand.total must equal sum of row.total');
  const bucketSum = out.rows.reduce((a, r) => a + r.current + r.b1 + r.b2 + r.b3 + r.b4, 0);
  assert.equal(round2(bucketSum), out.grand.total, 'sum of all bucket values must equal grand total');
});

test('aggregate: paisa-level precision accumulates without drift', () => {
  // 100 bills of 33.33 each = 3333.00 exactly; naive float sum drifts.
  const bills = [];
  for (let i = 0; i < 100; i++) {
    bills.push(bill({
      bill_id: i + 1,
      bill_number: `INV-${i + 1}`,
      bill_date: AS_OF,
      balance_amount: 33.33,
    }));
  }
  const out = aggregateAging(bills, AS_OF, BOUNDS);
  assert.equal(out.rows[0].total, 3333);
  assert.equal(out.grand.total, 3333);
});

test('aggregate: bill drill-down carries correct per-bill fields', () => {
  const b = bill({
    bill_id: 42,
    bill_number: 'INV-42',
    bill_date: '2026-03-15',
    due_date: '2026-04-01',
    total_amount: 1000,
    paid_amount: 300,
    balance_amount: 700,
    party: P1,
  });
  const out = aggregateAging([b], AS_OF, BOUNDS);
  const [drill] = out.rows[0].bills;
  assert.equal(drill.bill_id, 42);
  assert.equal(drill.bill_number, 'INV-42');
  assert.equal(drill.total_amount, 1000);
  assert.equal(drill.paid_amount, 300);
  assert.equal(drill.balance_amount, 700);
  assert.equal(drill.overdue_days, 23);   // 2026-04-01 → 2026-04-24
  assert.equal(drill.bucket, 'b1');
});

test('aggregate: throws when bounds are invalid', () => {
  assert.throws(() => aggregateAging([], AS_OF, { b1: 30, b2: 20, b3: 90 }), /bucket bounds/);
  assert.throws(() => aggregateAging([], AS_OF, { b1: 0, b2: 60, b3: 90 }), /bucket bounds/);
});

test('aggregate: throws when asOfDate is malformed', () => {
  assert.throws(() => aggregateAging([], '24-04-2026', BOUNDS), /YYYY-MM-DD/);
  assert.throws(() => aggregateAging([], 'today', BOUNDS), /YYYY-MM-DD/);
});

test('aggregate: throws when bills is not an array', () => {
  assert.throws(() => aggregateAging(null, AS_OF, BOUNDS));
  assert.throws(() => aggregateAging({}, AS_OF, BOUNDS));
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function dateSub(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
