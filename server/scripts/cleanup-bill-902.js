#!/usr/bin/env node
// One-shot cleanup: cancel demo bill 902 + auto-receipt 416.
//
// Bill 902 is a leftover demo from the Commit-2 auto-receipt
// verification (~2 days ago). It exists in sales_bills with paid=1000,
// balance=0, NOT cancelled — but the sales_bill voucher (Dr Customer,
// Cr Sales+GST) was never posted to ledger_entries. The matching
// auto-receipt (txn 416, source=auto_from_bill, source_bill_id=902)
// has its receipt voucher (entries 9254/9255) posted, so the receipt's
// Cr leg sits on Sundry Debtors with no offsetting bill Dr leg —
// surfacing as I5 = -1000 drift on the banner.
//
// We cannot use salesController.cancel(902) directly because the bill-
// cancel guard refuses any bill with a linked Receipt (the guard's
// reference_bill_id check catches receipt 416, which is linked via
// reference_bill_id=902 in addition to source_bill_id=902 — a known
// duplication in autoReceiptService.upsertAutoReceiptForBill that the
// guard doesn't have an exception for). And paymentController.cancel
// refuses auto_from_bill receipts on the symmetric grounds. Catch-22.
//
// Replay the cancel cascade manually inside one transaction:
//   1. Restore godown stock (+1 unit of product 4234 back to godown 1).
//   2. Drop the bill's stock_ledger Sales row.
//   3. UPDATE bill 902: is_cancelled, balance=0, status, audit fields.
//   4. reconcileBillsForParty(693) — bill 902 now excluded; bills
//      395 and 399 already at cap=0, no-op.
//   5. recalculatePartyBalance(693) — refresh Sharma Cloth House's
//      current_balance cache.
//   6. reverseVoucher('sales_bill', 902) — no-op (voucher never
//      existed).
//   7. reverseVoucher('sales_bill_receipt', 902) — no-op (receipt's
//      source_type is 'payment_receipt', not 'sales_bill_receipt').
//   8. reverseAutoReceiptForBill('sales', 902) — soft-cancels receipt
//      416, deletes allocation row 20. Ledger entries 9254/9255 stay
//      in place as audit trail; they remain symmetric with the
//      cancelled bill's now-excluded paid_amount contribution at the
//      formula level.
//
// Net effect: paid_in_bills drops 1000, expected drops 1000, ledger
// unchanged. I5 returns to balanced.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const { SalesBill, StockLedger } = require('../models');
const { applyGodownStockDelta } = require('../utils/godownStock');
const { recalculatePartyBalance, reconcileBillsForParty } = require('../utils/balanceHelper');
const { reverseVoucher } = require('../services/ledgerPostingService');
const { reverseAutoReceiptForBill } = require('../services/autoReceiptService');

const BILL_ID = 902;
const RECEIPT_ID = 416;
const ALLOC_ID = 20;
const ENTRY_RECEIPT_DR = 9254;
const ENTRY_RECEIPT_CR = 9255;

async function snap(label) {
  const [bill]    = await sequelize.query(`SELECT sales_bill_id, is_cancelled, paid_amount, balance_amount, payment_status FROM sales_bills WHERE sales_bill_id = ${BILL_ID}`);
  const [receipt] = await sequelize.query(`SELECT transaction_id, is_cancelled FROM payments_receipts WHERE transaction_id = ${RECEIPT_ID}`);
  const [alloc]   = await sequelize.query(`SELECT allocation_id FROM bill_payment_allocations WHERE allocation_id = ${ALLOC_ID}`);
  const [entry54] = await sequelize.query(`SELECT entry_id, reversal_of_id, EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = ledger_entries.entry_id) AS reversed FROM ledger_entries WHERE entry_id = ${ENTRY_RECEIPT_DR}`);
  const [entry55] = await sequelize.query(`SELECT entry_id, reversal_of_id, EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = ledger_entries.entry_id) AS reversed FROM ledger_entries WHERE entry_id = ${ENTRY_RECEIPT_CR}`);
  console.log(`\n── ${label} ──`);
  console.log(`  bill 902:           ${bill[0] ? `is_cancelled=${bill[0].is_cancelled} paid=${bill[0].paid_amount} balance=${bill[0].balance_amount} status=${bill[0].payment_status}` : 'NOT FOUND'}`);
  console.log(`  receipt 416:        ${receipt[0] ? `is_cancelled=${receipt[0].is_cancelled}` : 'NOT FOUND'}`);
  console.log(`  alloc row 20:       ${alloc[0] ? 'EXISTS' : 'DELETED'}`);
  console.log(`  entry 9254 (Dr):    ${entry54[0] ? `reversal_of_id=${entry54[0].reversal_of_id || 'null'} reversed=${entry54[0].reversed}` : 'NOT FOUND'}`);
  console.log(`  entry 9255 (Cr):    ${entry55[0] ? `reversal_of_id=${entry55[0].reversal_of_id || 'null'} reversed=${entry55[0].reversed}` : 'NOT FOUND'}`);
}

async function main() {
  await snap('PRE-CLEANUP');

  const bill = await SalesBill.findByPk(BILL_ID, { include: [{ association: 'items' }] });
  if (!bill)             { console.error('Bill 902 not found.'); process.exit(1); }
  if (bill.is_cancelled) { console.error('Bill 902 already cancelled.'); process.exit(1); }

  const t = await sequelize.transaction();
  try {
    // 1. Restore godown stock: 1 unit per item back into the bill's godown.
    for (const item of bill.items) {
      if (item.product_id && bill.godown_id) {
        await applyGodownStockDelta({
          product_id: item.product_id, godown_id: bill.godown_id,
          delta: +parseFloat(item.quantity), t,
        });
      }
    }

    // 2. Drop the bill's stock_ledger Sales rows.
    await StockLedger.destroy({
      where: { reference_id: bill.sales_bill_id, transaction_type: 'Sales' },
      transaction: t,
    });

    // 3. Mark bill cancelled (mirrors salesController.cancel exactly).
    await bill.update({
      is_cancelled: true,
      cancelled_by: 1,
      cancelled_date: new Date(),
      cancellation_reason: 'Cleanup: leftover demo from Commit-2 auto-receipt verification',
      balance_amount: 0,
      payment_status: 'Unpaid',
    }, { transaction: t });

    // 4. + 5. Reconcile + party-balance refresh.
    await reconcileBillsForParty(bill.customer_id, t);
    await recalculatePartyBalance(bill.customer_id, t);

    // 6. + 7. Reverse vouchers (both expected to be no-ops here).
    await reverseVoucher({
      sourceType: 'sales_bill', sourceId: bill.sales_bill_id,
      reason: 'Cleanup: leftover demo', userId: 1, transaction: t,
    });
    await reverseVoucher({
      sourceType: 'sales_bill_receipt', sourceId: bill.sales_bill_id,
      reason: 'Cleanup: leftover demo', userId: 1, transaction: t,
    });

    // 8. Cancel the auto-receipt + drop its allocation row.
    const autoResult = await reverseAutoReceiptForBill({
      kind: 'sales', billId: bill.sales_bill_id,
      userId: 1, reason: 'Cleanup: leftover demo', t,
    });
    console.log(`  reverseAutoReceiptForBill: ${JSON.stringify(autoResult)}`);

    await t.commit();
    console.log('\n  Transaction committed ✓');
  } catch (err) {
    await t.rollback();
    console.error('Transaction rolled back:', err);
    process.exit(1);
  }

  await snap('POST-CLEANUP');
  await sequelize.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
