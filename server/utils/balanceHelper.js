const { Op } = require('sequelize');

/**
 * Recalculates a party's current_balance from scratch.
 *
 * Formula:
 *   balance = openingSigned
 *           + (totalSales - salesPaidAtBilling - salesReturnAmount - totalReceipts)
 *           - (totalPurchases - purchasePaidAtBilling - totalPayments)
 *
 * Key design decisions:
 *  - Uses total_amount from bills (NOT balance_amount), so the formula is
 *    independent of how individual bill balances are maintained.
 *  - Counts ALL PaymentReceipts (bill-linked AND standalone), so any payment
 *    type correctly offsets the opening balance and all outstanding dues.
 *  - paid_amount on bills (at-billing cash) is separate from PaymentReceipts
 *    (post-billing payments) — both are accounted for without double-counting.
 *
 * Positive balance = receivable (party owes us)
 * Negative balance = payable (we owe party)
 */
async function recalculatePartyBalance(partyId, t = null) {
  const { Party, SalesBill, PurchaseBill, PaymentReceipt } = require('../models');
  const opts = t ? { transaction: t } : {};

  const party = await Party.findByPk(partyId, opts);
  if (!party) return 0;

  // ── Opening balance ───────────────────────────────────────────────────────
  const rawOpening   = parseFloat(party.opening_balance) || 0;
  const openingSigned = party.opening_balance_type === 'Payable'
    ? -Math.abs(rawOpening)
    :  Math.abs(rawOpening);

  // ── Sales side (customer owes us) ─────────────────────────────────────────
  const [totalSalesRaw, salesPaidRaw, salesReturnRaw, totalReceiptsRaw] = await Promise.all([
    SalesBill.sum('total_amount',  { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
    SalesBill.sum('paid_amount',   { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
    SalesBill.sum('return_amount', { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
    PaymentReceipt.sum('total_amount', {
      where: { party_id: partyId, transaction_type: 'Receipt', is_cancelled: false },
      ...opts,
    }),
  ]);

  const totalSales       = parseFloat(totalSalesRaw)    || 0;
  const salesPaid        = parseFloat(salesPaidRaw)     || 0;
  const salesReturn      = parseFloat(salesReturnRaw)   || 0;
  const totalReceipts    = parseFloat(totalReceiptsRaw) || 0;

  // Net still owed by customer from sales
  const salesNet = totalSales - salesPaid - salesReturn - totalReceipts;

  // ── Purchase side (we owe supplier) ──────────────────────────────────────
  const [totalPurchasesRaw, purchasePaidRaw, totalPaymentsRaw] = await Promise.all([
    PurchaseBill.sum('total_amount', { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
    PurchaseBill.sum('paid_amount',  { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
    PaymentReceipt.sum('total_amount', {
      where: { party_id: partyId, transaction_type: 'Payment', is_cancelled: false },
      ...opts,
    }),
  ]);

  const totalPurchases   = parseFloat(totalPurchasesRaw)  || 0;
  const purchasePaid     = parseFloat(purchasePaidRaw)     || 0;
  const totalPayments    = parseFloat(totalPaymentsRaw)    || 0;

  // Net still owed to supplier from purchases
  const purchaseNet = totalPurchases - purchasePaid - totalPayments;

  // ── Final balance ─────────────────────────────────────────────────────────
  const newBalance = +(openingSigned + salesNet - purchaseNet).toFixed(2);

  await party.update({ current_balance: newBalance }, opts);
  return newBalance;
}

/**
 * Returns the maximum amount that can be paid/received for a party
 * without exceeding their outstanding balance.
 *
 * For Payment  (we pay supplier): returns max(0, what we owe them)
 * For Receipt  (customer pays us): returns max(0, what they owe us)
 */
async function getPartyOutstanding(partyId, transactionType, t = null) {
  const { Party, SalesBill, PurchaseBill, PaymentReceipt } = require('../models');
  const opts = t ? { transaction: t } : {};

  const party = await Party.findByPk(partyId, opts);
  if (!party) return 0;

  const rawOpening   = parseFloat(party.opening_balance) || 0;
  const openingSigned = party.opening_balance_type === 'Payable'
    ? -Math.abs(rawOpening)
    :  Math.abs(rawOpening);

  if (transactionType === 'Payment') {
    const [totalPurchasesRaw, purchasePaidRaw, totalPaymentsRaw] = await Promise.all([
      PurchaseBill.sum('total_amount', { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
      PurchaseBill.sum('paid_amount',  { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
      PaymentReceipt.sum('total_amount', {
        where: { party_id: partyId, transaction_type: 'Payment', is_cancelled: false },
        ...opts,
      }),
    ]);
    const totalPurchases = parseFloat(totalPurchasesRaw) || 0;
    const purchasePaid   = parseFloat(purchasePaidRaw)   || 0;
    const totalPayments  = parseFloat(totalPaymentsRaw)  || 0;
    // What we owe them: payable opening + unpaid purchases
    const payableOpening = Math.max(0, -openingSigned);
    return +(Math.max(0, payableOpening + totalPurchases - purchasePaid - totalPayments)).toFixed(2);
  }

  if (transactionType === 'Receipt') {
    const [totalSalesRaw, salesPaidRaw, salesReturnRaw, totalReceiptsRaw] = await Promise.all([
      SalesBill.sum('total_amount',  { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
      SalesBill.sum('paid_amount',   { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
      SalesBill.sum('return_amount', { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
      PaymentReceipt.sum('total_amount', {
        where: { party_id: partyId, transaction_type: 'Receipt', is_cancelled: false },
        ...opts,
      }),
    ]);
    const totalSales    = parseFloat(totalSalesRaw)    || 0;
    const salesPaid     = parseFloat(salesPaidRaw)     || 0;
    const salesReturn   = parseFloat(salesReturnRaw)   || 0;
    const totalReceipts = parseFloat(totalReceiptsRaw) || 0;
    // What they owe us: receivable opening + unpaid sales
    const receivableOpening = Math.max(0, openingSigned);
    return +(Math.max(0, receivableOpening + totalSales - salesPaid - salesReturn - totalReceipts)).toFixed(2);
  }

  return 0;
}

/**
 * Reconciles ALL bill balances for a party using FIFO.
 *
 * After any payment create or cancel, this rebuilds every bill's
 * balance_amount and payment_status from scratch — no stale stored
 * allocations, no partial-cancel bugs, no sign errors.
 *
 * Purchase bills  → apply total non-cancelled Payments, oldest bill first.
 * Sales bills     → apply total non-cancelled Receipts, oldest bill first.
 */
async function reconcileBillsForParty(partyId, t = null) {
  const { SalesBill, PurchaseBill, PaymentReceipt } = require('../models');
  const opts = t ? { transaction: t } : {};

  // ── PURCHASE BILLS: distribute payments FIFO ──────────────────────────────
  const totalPaymentsRaw = await PaymentReceipt.sum('total_amount', {
    where: { party_id: partyId, transaction_type: 'Payment', is_cancelled: false },
    ...opts,
  });
  const totalPayments = parseFloat(totalPaymentsRaw) || 0;

  const purchaseBills = await PurchaseBill.findAll({
    where: { supplier_id: partyId, is_cancelled: false },
    order: [['bill_date', 'ASC'], ['purchase_bill_id', 'ASC']],
    ...opts,
  });

  let remainingPayments = totalPayments;
  for (const bill of purchaseBills) {
    const totalAmt      = parseFloat(bill.total_amount) || 0;
    const paidAtBilling = parseFloat(bill.paid_amount)  || 0;
    // Maximum this bill can absorb from post-billing payments
    const maxBalance = +(Math.max(0, totalAmt - paidAtBilling)).toFixed(2);
    const applyThis  = +(Math.min(remainingPayments, maxBalance)).toFixed(2);
    const newBalance = +(maxBalance - applyThis).toFixed(2);
    remainingPayments = +(remainingPayments - applyThis).toFixed(2);

    const status = newBalance <= 0
      ? 'Paid'
      : applyThis > 0
        ? 'Partial'
        : 'Unpaid';

    await bill.update({ balance_amount: newBalance, payment_status: status }, opts);
  }

  // ── SALES BILLS: distribute receipts FIFO ────────────────────────────────
  const totalReceiptsRaw = await PaymentReceipt.sum('total_amount', {
    where: { party_id: partyId, transaction_type: 'Receipt', is_cancelled: false },
    ...opts,
  });
  const totalReceipts = parseFloat(totalReceiptsRaw) || 0;

  const salesBills = await SalesBill.findAll({
    where: { customer_id: partyId, is_cancelled: false },
    order: [['bill_date', 'ASC'], ['sales_bill_id', 'ASC']],
    ...opts,
  });

  let remainingReceipts = totalReceipts;
  for (const bill of salesBills) {
    const totalAmt      = parseFloat(bill.total_amount)    || 0;
    const paidAtBilling = parseFloat(bill.paid_amount)     || 0;
    const returnAmt     = parseFloat(bill.return_amount)   || 0;
    const maxBalance = +(Math.max(0, totalAmt - paidAtBilling - returnAmt)).toFixed(2);
    const applyThis  = +(Math.min(remainingReceipts, maxBalance)).toFixed(2);
    const newBalance = +(maxBalance - applyThis).toFixed(2);
    remainingReceipts = +(remainingReceipts - applyThis).toFixed(2);

    const status = newBalance <= 0
      ? 'Paid'
      : applyThis > 0
        ? 'Partial'
        : 'Unpaid';

    await bill.update({ balance_amount: newBalance, payment_status: status }, opts);
  }
}

module.exports = { recalculatePartyBalance, getPartyOutstanding, reconcileBillsForParty };
