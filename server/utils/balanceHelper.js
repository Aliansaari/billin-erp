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
 * Reconciles ALL bill balances for a party.
 *
 * Algorithm (Fix #17 — user-intent-preserving):
 *   1. For each non-cancelled PaymentReceipt, honor explicit bill_allocations
 *      first — these represent the user's deliberate choice of which bill to
 *      apply money to (e.g. customer says "this ₹500 is for Invoice #7, not
 *      the older #5"). Clamp each per-bill allocation to that bill's capacity;
 *      any overflow (bill cancelled/deleted, or capacity reduced by a later
 *      return) falls back to the FIFO pool.
 *   2. Any payment amount NOT explicitly allocated (standalone/advance
 *      payments, or legacy records without bill_allocations) joins the FIFO
 *      pool and is distributed oldest-bill-first.
 *
 * This preserves accounting integrity (total applied = total non-cancelled
 * receipts/payments) while honoring user intent — matching how TallyPrime and
 * Vyapar handle "advance + specific bill" combinations.
 *
 * Purchase bills ← total non-cancelled Payments
 * Sales bills    ← total non-cancelled Receipts
 */
async function reconcileBillsForParty(partyId, t = null) {
  const { SalesBill, PurchaseBill, PaymentReceipt } = require('../models');
  const opts = t ? { transaction: t } : {};

  // Extract valid allocations from a payment row, defensively scaled so the
  // sum never exceeds the payment's total_amount (prevents data-corruption
  // scenarios from breaking the reconciliation).
  const parseAllocs = (row, expectedBillType) => {
    const totalAmt = parseFloat(row.total_amount) || 0;
    const raw = Array.isArray(row.bill_allocations) ? row.bill_allocations : [];
    const valid = [];
    let sumAlloc = 0;
    for (const a of raw) {
      if (!a || !a.bill_id || a.bill_type !== expectedBillType) continue;
      const amt = parseFloat(a.amount) || 0;
      if (amt <= 0) continue;
      valid.push({ bill_id: a.bill_id, amount: amt });
      sumAlloc += amt;
    }
    // Defensive scale-down if allocations somehow exceed total (shouldn't
    // happen under normal flow, but older data or race-import may have it).
    const scale = sumAlloc > totalAmt && sumAlloc > 0 ? totalAmt / sumAlloc : 1;
    const scaledPerBill = valid.map(v => ({
      bill_id: v.bill_id,
      amount: v.amount * scale,
    }));
    const scaledSum = sumAlloc * scale;
    const unallocated = Math.max(0, totalAmt - scaledSum);
    return { unallocated, perBill: scaledPerBill };
  };

  // Distribute (userAllocMap + overflow + unallocatedFIFO) across a set of
  // bills in FIFO order, honoring user intent first and returning nothing
  // leftover (accounting-closed).
  const distributeToBills = async (bills, getId, getCapacity, userAllocMap, unallocatedFIFO) => {
    // Pass 1: build capacity map, clamp user allocations, collect overflow.
    const capacity = {};
    for (const bill of bills) capacity[getId(bill)] = getCapacity(bill);

    const clamped = {};
    let overflow = 0;
    for (const [billIdStr, amt] of Object.entries(userAllocMap)) {
      const billId = Number(billIdStr);
      const cap = capacity[billId];
      if (cap === undefined) {
        // Bill is cancelled/deleted — that money returns to the FIFO pool.
        overflow += amt;
        continue;
      }
      const c = Math.min(amt, cap);
      clamped[billId] = c;
      overflow += (amt - c);
    }

    // Pass 2: FIFO-distribute (unallocated + overflow) across remaining capacity.
    let remaining = +(unallocatedFIFO + overflow).toFixed(2);
    for (const bill of bills) {
      const id = getId(bill);
      const cap = +(capacity[id] || 0).toFixed(2);
      const userAlloc = +((clamped[id] || 0)).toFixed(2);
      const remainingCap = +(cap - userAlloc).toFixed(2);
      const fifoApply = +(Math.min(remaining, Math.max(0, remainingCap))).toFixed(2);
      remaining = +(remaining - fifoApply).toFixed(2);

      const applyThis = +(userAlloc + fifoApply).toFixed(2);
      const newBalance = +(Math.max(0, cap - applyThis)).toFixed(2);
      const status = newBalance <= 0
        ? 'Paid'
        : applyThis > 0
          ? 'Partial'
          : 'Unpaid';
      await bill.update({ balance_amount: newBalance, payment_status: status }, opts);
    }
  };

  // ── PURCHASE BILLS: apply user Payment allocations, then FIFO remainder ──
  const paymentRows = await PaymentReceipt.findAll({
    where: { party_id: partyId, transaction_type: 'Payment', is_cancelled: false },
    attributes: ['transaction_id', 'total_amount', 'bill_allocations'],
    ...opts,
  });

  const purchaseUserAlloc = {};
  let totalPaymentsUnallocated = 0;
  for (const row of paymentRows) {
    const { unallocated, perBill } = parseAllocs(row, 'Purchase');
    totalPaymentsUnallocated += unallocated;
    for (const a of perBill) {
      purchaseUserAlloc[a.bill_id] = (purchaseUserAlloc[a.bill_id] || 0) + a.amount;
    }
  }

  const purchaseBills = await PurchaseBill.findAll({
    where: { supplier_id: partyId, is_cancelled: false },
    order: [['bill_date', 'ASC'], ['purchase_bill_id', 'ASC']],
    ...opts,
  });

  await distributeToBills(
    purchaseBills,
    (b) => b.purchase_bill_id,
    (b) => +(Math.max(0, (parseFloat(b.total_amount) || 0) - (parseFloat(b.paid_amount) || 0))).toFixed(2),
    purchaseUserAlloc,
    totalPaymentsUnallocated,
  );

  // ── SALES BILLS: apply user Receipt allocations, then FIFO remainder ─────
  const receiptRows = await PaymentReceipt.findAll({
    where: { party_id: partyId, transaction_type: 'Receipt', is_cancelled: false },
    attributes: ['transaction_id', 'total_amount', 'bill_allocations'],
    ...opts,
  });

  const salesUserAlloc = {};
  let totalReceiptsUnallocated = 0;
  for (const row of receiptRows) {
    const { unallocated, perBill } = parseAllocs(row, 'Sales');
    totalReceiptsUnallocated += unallocated;
    for (const a of perBill) {
      salesUserAlloc[a.bill_id] = (salesUserAlloc[a.bill_id] || 0) + a.amount;
    }
  }

  const salesBills = await SalesBill.findAll({
    where: { customer_id: partyId, is_cancelled: false },
    order: [['bill_date', 'ASC'], ['sales_bill_id', 'ASC']],
    ...opts,
  });

  await distributeToBills(
    salesBills,
    (b) => b.sales_bill_id,
    (b) => +(Math.max(0,
      (parseFloat(b.total_amount) || 0) -
      (parseFloat(b.paid_amount) || 0) -
      (parseFloat(b.return_amount) || 0),
    )).toFixed(2),
    salesUserAlloc,
    totalReceiptsUnallocated,
  );
}

module.exports = { recalculatePartyBalance, getPartyOutstanding, reconcileBillsForParty };
