/*
 * Unit tests for expenseVoucherService — purely the line-balance math.
 *   node --test server/services/expenseVoucherService.test.js
 *
 * The service depends on LedgerAccount.findOne / findByPk to resolve
 * system ledgers (Cash, CGST Input, etc.) and party / bank ledgers.
 * For these unit tests we stub the model layer so the math runs in
 * isolation — no DB needed.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const Module   = require('node:module');

// ── Stub the ../models import so the service runs without the DB ─────
// Replace the resolved cache entry BEFORE requiring the service.
const modelsPath = require.resolve('../models');
const stubLedgers = {
  'CGST Input': { ledger_id: 101 },
  'SGST Input': { ledger_id: 102 },
  'IGST Input': { ledger_id: 103 },
  'Round Off':  { ledger_id: 104 },
  'Cash':       { ledger_id: 105 },
};
const stubParty = (id) => ({
  party_id: id,
  ledger_account_id: 200 + id,
  is_system_cash: false,
  party_name: `Vendor #${id}`,
});

require.cache[modelsPath] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: {
    LedgerAccount: {
      findOne: async ({ where }) => stubLedgers[where.ledger_name] || null,
      findByPk: async (id) => ({ ledger_id: Number(id) || 999 }),
    },
    Party: {
      findByPk: async (id) => stubParty(Number(id)),
    },
  },
};

const { buildExpenseVoucher } = require('./expenseVoucherService');

// Helper: sum debits / credits across produced lines, return drift.
function balance(lines) {
  let dr = 0, cr = 0;
  for (const l of lines) { dr += Number(l.debit) || 0; cr += Number(l.credit) || 0; }
  return { dr: +dr.toFixed(2), cr: +cr.toFixed(2), drift: +(dr - cr).toFixed(2) };
}

// Build a voucher with a single expense item by default.
function mkVoucher(o = {}) {
  return {
    expense_id: 1,
    voucher_date: '2026-05-09',
    voucher_number: 'EXP-001',
    sub_total: 100,
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
    round_off: 0,
    total_amount: 100,
    paid_amount: 100,
    payment_mode: 'Cash',
    items: [{ expense_ledger_id: 501, taxable_amount: 100 }],
    ...o,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Round-off math (audit C2)
// ─────────────────────────────────────────────────────────────────────

test('round_off=0 cash voucher balances', async () => {
  const v = mkVoucher({ sub_total: 100, total_amount: 100, paid_amount: 100 });
  const out = await buildExpenseVoucher(v);
  const b = balance(out.lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
});

test('round_off > 0 (rounded-up) cash voucher balances — Dr Round Off', async () => {
  // Sub 100 + IGST 18% = 118. Round up to 120 → round_off = +2. Paid 120.
  const v = mkVoucher({
    sub_total: 100, igst_amount: 18,
    round_off: 2, total_amount: 120, paid_amount: 120,
  });
  const out = await buildExpenseVoucher(v);
  const b = balance(out.lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
  // Confirm the round-off leg is on the Dr side
  const ro = out.lines.find(l => l.ledgerAccountId === 104);
  assert.ok(ro, 'round-off leg present');
  assert.equal(ro.debit, 2);
  assert.equal(ro.credit, 0);
});

test('round_off < 0 (rounded-down) cash voucher balances — Cr Round Off', async () => {
  // Sub 100 + IGST 18% = 118. Round down to 117 → round_off = -1. Paid 117.
  const v = mkVoucher({
    sub_total: 100, igst_amount: 18,
    round_off: -1, total_amount: 117, paid_amount: 117,
  });
  const out = await buildExpenseVoucher(v);
  const b = balance(out.lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
  const ro = out.lines.find(l => l.ledgerAccountId === 104);
  assert.ok(ro, 'round-off leg present');
  assert.equal(ro.debit, 0);
  assert.equal(ro.credit, 1);
});

test('round_off > 0 with split CGST + SGST balances', async () => {
  // Intra-state: CGST 9 + SGST 9. Total = 100 + 18 + 1 round-up = 119.
  const v = mkVoucher({
    sub_total: 100, cgst_amount: 9, sgst_amount: 9,
    round_off: 1, total_amount: 119, paid_amount: 119,
  });
  const out = await buildExpenseVoucher(v);
  assert.equal(balance(out.lines).drift, 0);
});

test('Bank-mode partial payment with round_off > 0 balances (party leg picks up the rest)', async () => {
  // Sub 1000 + IGST 18% = 1180 + round-up 2 = 1182. Paid 500 via bank.
  // Remaining 682 goes against the vendor's credit ledger.
  const v = mkVoucher({
    sub_total: 1000, igst_amount: 180,
    round_off: 2, total_amount: 1182,
    paid_amount: 500, payment_mode: 'Bank',
    bank_ledger_id: 999,
    party_id: 7,
    items: [{ expense_ledger_id: 501, taxable_amount: 1000 }],
  });
  const out = await buildExpenseVoucher(v);
  const b = balance(out.lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
  // Round-off leg on Dr side
  const ro = out.lines.find(l => l.ledgerAccountId === 104);
  assert.equal(ro.debit, 2);
  assert.equal(ro.credit, 0);
});

test('Credit-mode (paid=0) with round_off < 0 balances — entire amount on vendor', async () => {
  // Sub 1000 + IGST 50 = 1050, rounded down to 1049 → round_off = -1.
  const v = mkVoucher({
    sub_total: 1000, igst_amount: 50,
    round_off: -1, total_amount: 1049,
    paid_amount: 0, payment_mode: 'Credit',
    party_id: 9,
    items: [{ expense_ledger_id: 501, taxable_amount: 1000 }],
  });
  const out = await buildExpenseVoucher(v);
  const b = balance(out.lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
  const ro = out.lines.find(l => l.ledgerAccountId === 104);
  assert.equal(ro.debit, 0);
  assert.equal(ro.credit, 1);
});

test('Multiple items rolled up by ledger; round_off=0 balances', async () => {
  const v = mkVoucher({
    sub_total: 800,
    items: [
      { expense_ledger_id: 501, taxable_amount: 300 },
      { expense_ledger_id: 501, taxable_amount: 200 },  // same ledger → rolled up
      { expense_ledger_id: 502, taxable_amount: 300 },
    ],
    cgst_amount: 72, sgst_amount: 72,
    round_off: 0, total_amount: 944, paid_amount: 944,
  });
  const out = await buildExpenseVoucher(v);
  // 2 expense ledgers (501 rolled up), CGST In, SGST In, Cash → 5 lines, no round-off.
  assert.equal(out.lines.length, 5);
  const ledger501 = out.lines.find(l => l.ledgerAccountId === 501);
  assert.equal(ledger501.debit, 500);          // 300 + 200 rolled up
  assert.equal(balance(out.lines).drift, 0);
});
