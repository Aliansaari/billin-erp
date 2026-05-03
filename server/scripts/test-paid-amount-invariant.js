#!/usr/bin/env node
/*
 * paid_amount invariant tests for the patched reconcileBillsForParty.
 * Run with: node server/scripts/test-paid-amount-invariant.js
 *
 * The patch maintains `paid + balance (+ return) = total` on every bill
 * the reconcile touches. The aging / bills-receivable banner formulas
 * derive `paid_in_bills` from this column, so any drift between paid
 * and the actual FIFO-applied amount surfaces as a banner discrepancy.
 *
 * SCOPE — these tests cover the production-realistic event-driven
 * scenarios that triggered the live drift on bill 393:
 *   • At-billing-paid bills (cap = 0) are protected from FIFO
 *   • Credit bills fully covered by FIFO get paid = total
 *   • Per-bill invariant `paid + balance + return = total` holds
 *   • Status logic Paid / Partial / Unpaid all correct
 *   • Idempotency on FULLY-COVERED bill states
 *   • Cross-side independence (sales reconcile doesn't touch purchase)
 *   • Explicit user_alloc honoured + FIFO remainder
 *
 * KNOWN LIMITATION (out of scope for this fix):
 *   For partial-coverage bills (balance > 0 after FIFO), if reconcile
 *   re-fires later via a new receipt, paid_amount can over-state the
 *   actual FIFO-applied amount because the receipt pool is recomputed
 *   from scratch each call. The aging banner stays balanced through
 *   this (the formula's invariant `paid + balance = total` is
 *   maintained per-bill), but the per-bill view may show a bill as
 *   "more paid" than the cash trail justifies. Audit on 2026-05-03
 *   found zero such cases on the live DB. A future commit should
 *   thread reconcile through bill_payment_allocations (Phase R9
 *   pattern) for true allocation persistence.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Party, SalesBill, PurchaseBill,
} = require('../models');
const { reconcileBillsForParty } = require('../utils/balanceHelper');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TPI_';

function check(name, condition, detail = '') {
  if (condition) { pass++; results.push(`  ✓ ${name}`); }
  else           { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function near(a, b, tol = 0.01) {
  return Math.abs(parseFloat(a || 0) - parseFloat(b || 0)) < tol;
}
function invariantHolds(bill) {
  const total = parseFloat(bill.total_amount) || 0;
  const paid = parseFloat(bill.paid_amount) || 0;
  const balance = parseFloat(bill.balance_amount) || 0;
  const ret = parseFloat(bill.return_amount || 0);
  return near(paid + balance + ret, total);
}

async function cleanup() {
  const partySel = `(SELECT party_id FROM parties WHERE party_name LIKE :p)`;
  const salesSel = `(SELECT sales_bill_id FROM sales_bills WHERE customer_id IN ${partySel})`;
  const purchSel = `(SELECT purchase_bill_id FROM purchase_bills WHERE supplier_id IN ${partySel})`;

  await sequelize.query(`DELETE FROM ledger_entries WHERE source_type IN ('sales_bill','sales_bill_receipt','purchase_bill','purchase_bill_payment','payment_receipt') AND (reference_id IN ${salesSel} OR reference_id IN ${purchSel})`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${partySel})`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM bill_payment_allocations WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE party_id IN ${partySel})`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM payments_receipts WHERE party_id IN ${partySel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM sales_bills WHERE customer_id IN ${partySel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM purchase_bills WHERE supplier_id IN ${partySel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM ledger_accounts WHERE party_id IN ${partySel}`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE :p`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE :p`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
}

async function insertSalesBill({ customerId, billNumber, billDate, total, paid, balance, returnAmt = 0, status = 'Unpaid' }) {
  const [rows] = await sequelize.query(
    `INSERT INTO sales_bills
       (bill_number, customer_id, bill_date, total_amount, paid_amount,
        balance_amount, return_amount, payment_status, is_cancelled,
        created_date, modified_date, sub_total)
     VALUES (:billNumber, :customerId, :billDate, :total, :paid, :balance,
             :returnAmt, :status, false, NOW(), NOW(), :total)
     RETURNING sales_bill_id`,
    { replacements: { customerId, billNumber, billDate, total, paid, balance, returnAmt, status } },
  );
  return rows[0].sales_bill_id;
}

async function insertPurchaseBill({ supplierId, billNumber, billDate, total, paid, balance, status = 'Unpaid' }) {
  const [rows] = await sequelize.query(
    `INSERT INTO purchase_bills
       (bill_number, supplier_id, bill_date, total_amount, paid_amount,
        balance_amount, payment_status, is_cancelled,
        created_date, modified_date, sub_total)
     VALUES (:billNumber, :supplierId, :billDate, :total, :paid, :balance,
             :status, false, NOW(), NOW(), :total)
     RETURNING purchase_bill_id`,
    { replacements: { supplierId, billNumber, billDate, total, paid, balance, status } },
  );
  return rows[0].purchase_bill_id;
}

async function insertReceipt({ partyId, txnNumber, total, type = 'Receipt', billAllocations = null }) {
  const allocsJson = billAllocations ? JSON.stringify(billAllocations) : null;
  const [rows] = await sequelize.query(
    `INSERT INTO payments_receipts
       (transaction_number, party_id, transaction_type, total_amount,
        bill_allocations, payment_method, transaction_date, is_cancelled,
        created_date, modified_date)
     VALUES (:txnNumber, :partyId, :type, :total, :allocs::jsonb, 'Cash',
             NOW(), false, NOW(), NOW())
     RETURNING transaction_id`,
    { replacements: { txnNumber, partyId, type, total, allocs: allocsJson } },
  );
  return rows[0].transaction_id;
}

async function refreshBill(model, id) {
  return model.findByPk(id);
}

async function runTests() {
  await cleanup();

  // ── Setup parties ─────────────────────────────────────────────────────
  const customer = await Party.create({
    party_name: FIXTURE_PREFIX + 'cust', party_type: 'Customer',
    mobile_1: '9100000001', is_active: true,
  });
  const supplier = await Party.create({
    party_name: FIXTURE_PREFIX + 'supp', party_type: 'Supplier',
    mobile_1: '9100000002', is_active: true,
  });

  // ── T1: at-billing-paid bill, no receipts → paid stays put ───────────
  // Mirror of Sharma's bill 383 (paid populated via Phase-R9 backfill).
  const billA = await insertSalesBill({
    customerId: customer.party_id, billNumber: FIXTURE_PREFIX + 'A',
    billDate: '2025-04-05', total: 1000, paid: 1000, balance: 0,
    status: 'Paid',
  });
  await reconcileBillsForParty(customer.party_id);
  let a = await refreshBill(SalesBill, billA);
  check('T1: at-billing bill paid = 1000 (no receipts)',
    near(a.paid_amount, 1000) && near(a.balance_amount, 0),
    `paid=${a.paid_amount} balance=${a.balance_amount}`);
  check('T1: invariant holds', invariantHolds(a));
  check('T1: status = Paid', a.payment_status === 'Paid');

  // ── T2: credit bill fully covered by on-account receipt ──────────────
  // Mirror of Sharma's bill 393 + the FIFO from receipts 209+211.
  const billB = await insertSalesBill({
    customerId: customer.party_id, billNumber: FIXTURE_PREFIX + 'B',
    billDate: '2025-04-25', total: 2000, paid: 0, balance: 2000,
    status: 'Unpaid',
  });
  await insertReceipt({
    partyId: customer.party_id, txnNumber: FIXTURE_PREFIX + 'R1',
    total: 2500, type: 'Receipt',
  });
  await reconcileBillsForParty(customer.party_id);
  let b = await refreshBill(SalesBill, billB);
  check('T2: credit bill paid = 2000 after FIFO',
    near(b.paid_amount, 2000), `paid=${b.paid_amount}`);
  check('T2: credit bill balance = 0',
    near(b.balance_amount, 0), `balance=${b.balance_amount}`);
  check('T2: status = Paid', b.payment_status === 'Paid');
  check('T2: invariant holds on covered bill', invariantHolds(b));
  check('T2: at-billing bill A still paid 1000 (cap = 0 protected it)',
    near((await refreshBill(SalesBill, billA)).paid_amount, 1000));

  // ── T3: idempotency on fully-covered state — no change ───────────────
  // This is Sharma's actual production scenario after the backfill.
  await reconcileBillsForParty(customer.party_id);
  let a3 = await refreshBill(SalesBill, billA);
  let b3 = await refreshBill(SalesBill, billB);
  check('T3: idempotent — billA paid stays 1000',
    near(a3.paid_amount, 1000) && near(a3.balance_amount, 0));
  check('T3: idempotent — billB paid stays 2000',
    near(b3.paid_amount, 2000) && near(b3.balance_amount, 0));
  check('T3: idempotent — invariants still hold',
    invariantHolds(a3) && invariantHolds(b3));

  // ── T4: status = Unpaid for a brand-new bill that the pool has
  //          already been wasted on ─────────────────────────────────────
  // Wipe state and rebuild a clean "no pool available" scenario.
  await sequelize.query(
    `DELETE FROM payments_receipts WHERE party_id = :p`,
    { replacements: { p: customer.party_id } },
  );
  await sequelize.query(
    `DELETE FROM sales_bills WHERE customer_id = :p`,
    { replacements: { p: customer.party_id } },
  );

  const billD = await insertSalesBill({
    customerId: customer.party_id, billNumber: FIXTURE_PREFIX + 'D',
    billDate: '2025-06-01', total: 700, paid: 0, balance: 700,
    status: 'Unpaid',
  });
  // No receipts at all → pool is empty.
  await reconcileBillsForParty(customer.party_id);
  let d = await refreshBill(SalesBill, billD);
  check('T4: bill with empty pool stays Unpaid',
    d.payment_status === 'Unpaid' &&
    near(d.paid_amount, 0) && near(d.balance_amount, 700),
    `paid=${d.paid_amount} balance=${d.balance_amount} status=${d.payment_status}`);
  check('T4: invariant holds on Unpaid bill', invariantHolds(d));

  // ── T5: partial coverage on first reconcile → status = Partial ───────
  // Add a receipt that covers part of billD.
  await insertReceipt({
    partyId: customer.party_id, txnNumber: FIXTURE_PREFIX + 'R5',
    total: 200, type: 'Receipt',
  });
  await reconcileBillsForParty(customer.party_id);
  let d2 = await refreshBill(SalesBill, billD);
  check('T5: partial coverage — paid = 200',
    near(d2.paid_amount, 200), `paid=${d2.paid_amount}`);
  check('T5: partial coverage — balance = 500',
    near(d2.balance_amount, 500), `balance=${d2.balance_amount}`);
  check('T5: status = Partial (newPaid > 0)',
    d2.payment_status === 'Partial', `status=${d2.payment_status}`);
  check('T5: invariant holds on partial bill', invariantHolds(d2));

  // ── T6: explicit user_alloc honoured + remainder FIFO ────────────────
  await sequelize.query(
    `DELETE FROM payments_receipts WHERE party_id = :p`,
    { replacements: { p: customer.party_id } },
  );
  await sequelize.query(
    `DELETE FROM sales_bills WHERE customer_id = :p`,
    { replacements: { p: customer.party_id } },
  );

  const billF = await insertSalesBill({
    customerId: customer.party_id, billNumber: FIXTURE_PREFIX + 'F',
    billDate: '2025-07-01', total: 1000, paid: 0, balance: 1000,
  });
  const billG = await insertSalesBill({
    customerId: customer.party_id, billNumber: FIXTURE_PREFIX + 'G',
    billDate: '2025-07-15', total: 2000, paid: 0, balance: 2000,
  });
  // Receipt of ₹1500 with explicit allocation: 1000 to billG (newer)
  // → user intent honoured even though billF is older.
  // The remaining 500 unallocated FIFOs to billF first.
  await insertReceipt({
    partyId: customer.party_id, txnNumber: FIXTURE_PREFIX + 'R2',
    total: 1500, billAllocations: [
      { bill_id: billG, bill_type: 'Sales', amount: 1000 },
    ],
  });
  await reconcileBillsForParty(customer.party_id);
  let f = await refreshBill(SalesBill, billF);
  let g = await refreshBill(SalesBill, billG);
  check('T6: explicit alloc honoured — billG paid = 1000',
    near(g.paid_amount, 1000), `paid=${g.paid_amount}`);
  check('T6: FIFO remainder applied — billF paid = 500',
    near(f.paid_amount, 500), `paid=${f.paid_amount}`);
  check('T6: invariant holds on both', invariantHolds(f) && invariantHolds(g));

  // ── T7-T11: PURCHASE side mirror ─────────────────────────────────────
  const purA = await insertPurchaseBill({
    supplierId: supplier.party_id, billNumber: FIXTURE_PREFIX + 'PA',
    billDate: '2025-04-05', total: 800, paid: 800, balance: 0,
    status: 'Paid',
  });
  const purB = await insertPurchaseBill({
    supplierId: supplier.party_id, billNumber: FIXTURE_PREFIX + 'PB',
    billDate: '2025-04-25', total: 1500, paid: 0, balance: 1500,
    status: 'Unpaid',
  });
  await insertReceipt({
    partyId: supplier.party_id, txnNumber: FIXTURE_PREFIX + 'P1',
    total: 1800, type: 'Payment',
  });
  await reconcileBillsForParty(supplier.party_id);
  let pa = await refreshBill(PurchaseBill, purA);
  let pb = await refreshBill(PurchaseBill, purB);
  check('T7: purchase at-billing paid stays at 800',
    near(pa.paid_amount, 800) && near(pa.balance_amount, 0));
  check('T8: purchase credit bill paid = 1500 after FIFO',
    near(pb.paid_amount, 1500) && near(pb.balance_amount, 0));
  check('T9: purchase invariant holds on both',
    invariantHolds(pa) && invariantHolds(pb));

  // T10: idempotency on purchase
  await reconcileBillsForParty(supplier.party_id);
  let pa2 = await refreshBill(PurchaseBill, purA);
  let pb2 = await refreshBill(PurchaseBill, purB);
  check('T10: purchase reconcile is idempotent',
    near(pa2.paid_amount, 800) && near(pb2.paid_amount, 1500));

  // T11: cross-side independence
  await reconcileBillsForParty(customer.party_id);
  let paAfterSales = await refreshBill(PurchaseBill, purA);
  check('T11: sales reconcile does not touch purchase bills',
    near(paAfterSales.paid_amount, 800) && near(paAfterSales.balance_amount, 0));

  // ── Cleanup ──────────────────────────────────────────────────────────
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
