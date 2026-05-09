/*
 * Unit tests for voucherBuilders — line-balance math only.
 *   node --test server/services/voucherBuilders.test.js
 *
 * Stubs the models layer so the tests run without a live DB.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// Stub models BEFORE requiring voucherBuilders.
const modelsPath = require.resolve('../models');
const stubLedgers = {
  'Sales Account':    { ledger_id: 1 },
  'Purchase Account': { ledger_id: 2 },
  'Sales Return':     { ledger_id: 3 },
  'Purchase Return':  { ledger_id: 4 },
  'Cash':             { ledger_id: 5 },
  'CGST Output':      { ledger_id: 11 },
  'SGST Output':      { ledger_id: 12 },
  'IGST Output':      { ledger_id: 13 },
  'CGST Input':       { ledger_id: 21 },
  'SGST Input':       { ledger_id: 22 },
  'IGST Input':       { ledger_id: 23 },
  'Round Off':        { ledger_id: 99 },
  'Bank Account':     { ledger_id: 100 },
  // Cess Output / Cess Input deliberately absent — the builder should
  // fold cess into IGST as a fallback.
};

const stubItemRows = { /* keyed by `${model}-${id}` */ };
function makeItemModel(name) {
  return {
    findAll: async ({ where }) => stubItemRows[`${name}-${Object.values(where)[0]}`] || [],
  };
}

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
      findByPk: async (id) => ({
        party_id: Number(id),
        ledger_account_id: 200 + Number(id),
        is_system_cash: false,
        party_name: `Party #${id}`,
      }),
    },
    SalesBillItem:         makeItemModel('SalesBillItem'),
    PurchaseBillItem:      makeItemModel('PurchaseBillItem'),
    SalesReturnBillItem:   makeItemModel('SalesReturnBillItem'),
    PurchaseReturnBillItem:makeItemModel('PurchaseReturnBillItem'),
  },
};

const {
  buildSalesBillVouchers,
  buildPurchaseBillVouchers,
  buildSalesReturnVouchers,
  buildPurchaseReturnVouchers,
} = require('./voucherBuilders');

function balance(lines) {
  let dr = 0, cr = 0;
  for (const l of lines) { dr += Number(l.debit) || 0; cr += Number(l.credit) || 0; }
  return { dr: +dr.toFixed(2), cr: +cr.toFixed(2), drift: +(dr - cr).toFixed(2) };
}

// ─── Sales Bill ──────────────────────────────────────────────────────

function mkSalesBill(o = {}) {
  return {
    sales_bill_id: 1, bill_number: 'INV-001', bill_date: '2026-05-09',
    customer_id: 7,
    sub_total: 1000, discount_amount: 0, special_discount: 0,
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0, cess_amount: 0,
    other_charges: 0, freight_charges: 0, round_off: 0,
    total_amount: 1000, paid_amount: 0,
    items: [],
    ...o,
  };
}

test('Sales bill: simple, no discounts, no GST, balances', async () => {
  const bill = mkSalesBill();
  const vs = await buildSalesBillVouchers(bill);
  assert.equal(balance(vs[0].lines).drift, 0);
});

test('Sales bill: per-line item discount nets out of Sales Cr (audit C1)', async () => {
  // 100 qty × 10 = 1000; per-line disc 50; taxable = 950.
  // total = 950 + 0 GST = 950.
  const bill = mkSalesBill({
    sub_total: 1000, total_amount: 950,
    items: [{ discount_amount: 50 }],
  });
  const vs = await buildSalesBillVouchers(bill);
  const b = balance(vs[0].lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
  // Sales Cr should be 950, not 1000
  const sales = vs[0].lines.find(l => l.ledgerAccountId === 1);
  assert.equal(sales.credit, 950);
});

test('Sales bill: bill-level special_discount nets out of Sales Cr (audit C1)', async () => {
  const bill = mkSalesBill({
    sub_total: 1000, special_discount: 100, total_amount: 900,
  });
  const vs = await buildSalesBillVouchers(bill);
  assert.equal(balance(vs[0].lines).drift, 0);
  const sales = vs[0].lines.find(l => l.ledgerAccountId === 1);
  assert.equal(sales.credit, 900);
});

test('Sales bill: cess emits its own leg (folds into IGST when Cess Output absent)', async () => {
  // Sub 1000, IGST 18% = 180, Cess 12% = 120 → total 1300.
  const bill = mkSalesBill({
    sub_total: 1000, igst_amount: 180, cess_amount: 120,
    total_amount: 1300,
  });
  const vs = await buildSalesBillVouchers(bill);
  const b = balance(vs[0].lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
  // No Cess Output ledger seeded → cess folds into IGST Output (id 13).
  const igstCr = vs[0].lines.filter(l => l.ledgerAccountId === 13).reduce((s, l) => s + l.credit, 0);
  assert.equal(igstCr, 300);  // 180 + 120
});

test('Sales bill: full mix — itemDisc + billDisc + special + GST + cess + roundOff balances', async () => {
  // Sub 10000
  // Item disc 500
  // Bill disc 200
  // Special disc 100
  // Taxable: 10000 - 500 - 200 - 100 = 9200
  // CGST 9% = 828; SGST 9% = 828; total tax = 1656
  // Cess 100
  // other 50, freight 30
  // Total before round = 9200 + 1656 + 100 + 50 + 30 = 11036
  // Round to 11036 (already round) → round_off = 0. paid = 0.
  const bill = mkSalesBill({
    sub_total: 10000,
    discount_amount: 200, special_discount: 100,
    cgst_amount: 828, sgst_amount: 828, cess_amount: 100,
    other_charges: 50, freight_charges: 30, round_off: 0,
    total_amount: 11036,
    items: [{ discount_amount: 500 }],
  });
  const vs = await buildSalesBillVouchers(bill);
  const b = balance(vs[0].lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
  // Sales Cr = sub - itemDisc - billDisc - special + other + freight
  //         = 10000 - 500 - 200 - 100 + 50 + 30 = 9280
  const salesCr = vs[0].lines.find(l => l.ledgerAccountId === 1).credit;
  assert.equal(salesCr, 9280);
});

// ─── Purchase Bill ───────────────────────────────────────────────────

function mkPurchaseBill(o = {}) {
  return {
    purchase_bill_id: 1, bill_number: 'PUR-001', bill_date: '2026-05-09',
    supplier_id: 7,
    sub_total: 1000, discount_amount: 0, special_discount: 0,
    cgst_amount: 0, sgst_amount: 0, igst_amount: 0, cess_amount: 0,
    other_charges: 0, freight_charges: 0, round_off: 0,
    total_amount: 1000, paid_amount: 0,
    items: [],
    ...o,
  };
}

test('Purchase bill: same shape as Sales — itemDisc + billDisc + special + cess balances', async () => {
  // sub 5000 − itemDisc 250 − billDisc 100 − special 50 = 4600 (taxable)
  // CGST 9% + SGST 9% on 4600 = 414 + 414 = 828; cess 50; total = 5478.
  const bill = mkPurchaseBill({
    sub_total: 5000,
    discount_amount: 100, special_discount: 50,
    cgst_amount: 414, sgst_amount: 414,
    cess_amount: 50,
    total_amount: 5478,
    items: [{ discount_amount: 250 }],
  });
  const vs = await buildPurchaseBillVouchers(bill);
  const b = balance(vs[0].lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
});

// ─── Sales Return ────────────────────────────────────────────────────

test('Sales Return: itemDisc + special + cess balances', async () => {
  // sub 2000 − itemDisc 100 − billDisc 50 − special 25 = 1825 (taxable)
  // GST 9%+9% on 1825 = 164.25 + 164.25 = 328.5; round to 165+165 (each).
  // Total = 1825 + 330 + 20 cess = 2175.
  const ret = {
    sales_return_id: 1, return_number: 'CN-001', return_date: '2026-05-09',
    customer_id: 7,
    sub_total: 2000, discount_amount: 50, special_discount: 25,
    cgst_amount: 165, sgst_amount: 165, igst_amount: 0, cess_amount: 20,
    other_charges: 0, freight_charges: 0, round_off: 0,
    total_amount: 2175,
    items: [{ discount_amount: 100 }],
  };
  const vs = await buildSalesReturnVouchers(ret);
  assert.equal(balance(vs[0].lines).drift, 0);
});

// ─── Purchase Return ─────────────────────────────────────────────────

test('Purchase Return: itemDisc + special + cess balances', async () => {
  // sub 3000 − itemDisc 180 − billDisc 60 − special 30 = 2730 (taxable)
  // CGST 9% + SGST 9% on 2730 = 245.7 + 245.7 = 491.4; cess 30.
  // Total before round = 2730 + 491.4 + 30 = 3251.4. Round to 3251 → roundOff = -0.4.
  const ret = {
    purchase_return_id: 1, return_number: 'DN-001', return_date: '2026-05-09',
    supplier_id: 7,
    sub_total: 3000, discount_amount: 60, special_discount: 30,
    cgst_amount: 245.7, sgst_amount: 245.7, igst_amount: 0, cess_amount: 30,
    other_charges: 0, freight_charges: 0, round_off: -0.4,
    total_amount: 3251,
    items: [{ discount_amount: 180 }],
  };
  const vs = await buildPurchaseReturnVouchers(ret);
  const b = balance(vs[0].lines);
  assert.equal(b.drift, 0, `Dr=${b.dr} Cr=${b.cr}`);
});

// ─── Backward compatibility — existing simple bills ──────────────────

test('No-discount no-cess bills still balance (regression)', async () => {
  // Plain CGST/SGST sale, no fancy fields.
  const bill = mkSalesBill({
    sub_total: 1000, cgst_amount: 90, sgst_amount: 90,
    total_amount: 1180,
  });
  const vs = await buildSalesBillVouchers(bill);
  assert.equal(balance(vs[0].lines).drift, 0);
  // Sales Cr should still be sub_total = 1000 in this case
  assert.equal(vs[0].lines.find(l => l.ledgerAccountId === 1).credit, 1000);
});
