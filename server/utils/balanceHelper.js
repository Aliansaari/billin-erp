const { Op } = require('sequelize');

/**
 * Recalculates a party's current_balance from scratch.
 *
 * Formula:
 *   balance = openingSigned
 *           + (totalSales - salesPaidAtBilling - walkInReturnAmount
 *              - formalSalesReturnNet - formalSalesReturnRefund - totalReceipts)
 *           - (totalPurchases - purchasePaidAtBilling
 *              - formalPurchaseReturnNet - formalPurchaseReturnRefund - totalPayments)
 *
 * Formal return modelling:
 *   A SalesReturnBill represents a credit note we issued. Its total_amount is
 *   a liability to the customer (customer's receivable drops). Any refund_amount
 *   paid in cash immediately settles part of that liability. The NET effect on
 *   the customer's balance is -(total_amount - refund_amount) = -balance_amount.
 *   Equivalent: subtract total_amount from sales AND add refund_amount back
 *   as a cash payout. We use the simpler `- balance_amount` form.
 *   PurchaseReturnBill is the mirror on the supplier side.
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
  const {
    Party, SalesBill, PurchaseBill, PaymentReceipt,
    SalesReturnBill, PurchaseReturnBill,
  } = require('../models');
  const opts = t ? { transaction: t } : {};

  const party = await Party.findByPk(partyId, opts);
  if (!party) return 0;

  // System Cash party never carries a balance: cash bills are paid in
  // full at point-of-sale (paid_amount = total_amount), so the formula
  // would compute zero anyway. Short-circuit to avoid the per-bill
  // aggregation cost on a row that can have thousands of cash bills.
  if (party.is_system_cash) {
    if (party.current_balance !== 0) {
      await party.update({ current_balance: 0 }, opts);
    }
    return 0;
  }

  // ── Opening balance ───────────────────────────────────────────────────────
  const rawOpening   = parseFloat(party.opening_balance) || 0;
  const openingSigned = party.opening_balance_type === 'Payable'
    ? -Math.abs(rawOpening)
    :  Math.abs(rawOpening);

  // ── Sales side (customer owes us) ─────────────────────────────────────────
  // Audit H3: exclude `auto_from_bill` receipts. Those are 1:1 with the
  // bill's at-billing `paid_amount` (auto-generated when the operator
  // marks money as collected at the counter). Counting both
  // `salesPaid` (which sums bill.paid_amount) AND those auto-receipts
  // double-deducts the at-billing-paid portion. After
  // reconcileBillsForParty runs, bill.paid_amount may also include
  // FIFO-applied receipts — those are non-auto and remain in
  // totalReceipts, then ALSO get deducted via the bumped salesPaid.
  // So the manual/standalone receipts that ARE in totalReceipts (and
  // not yet applied to a specific bill) represent advances; those
  // legitimately reduce the customer's net balance.
  const [
    totalSalesRaw, salesPaidRaw, salesWalkInReturnRaw, totalReceiptsRaw,
    salesReturnBalanceRaw,
  ] = await Promise.all([
    SalesBill.sum('total_amount',  { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
    SalesBill.sum('paid_amount',   { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
    SalesBill.sum('return_amount', { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
    PaymentReceipt.sum('total_amount', {
      where: {
        party_id: partyId, transaction_type: 'Receipt', is_cancelled: false,
        [Op.or]: [
          { source: { [Op.ne]: 'auto_from_bill' } },
          { source: { [Op.is]: null } },
        ],
      },
      ...opts,
    }),
    // Net credit-note effect per formal return: total - refund = balance_amount.
    // Already clamped ≥ 0 in the controller, so this sum is monotonic.
    SalesReturnBill.sum('balance_amount', {
      where: { customer_id: partyId, is_cancelled: false },
      ...opts,
    }),
    // Cash refund leg of formal returns is a DEBIT to party (we paid them cash);
    // we model that by subtracting `refund_amount` from the sales side below.
  ]);
  const salesReturnRefundRaw = await SalesReturnBill.sum('refund_amount', {
    where: { customer_id: partyId, is_cancelled: false },
    ...opts,
  });

  const totalSales          = parseFloat(totalSalesRaw)           || 0;
  const salesPaid           = parseFloat(salesPaidRaw)            || 0;
  const salesWalkInReturn   = parseFloat(salesWalkInReturnRaw)    || 0;
  const totalReceipts       = parseFloat(totalReceiptsRaw)        || 0;
  const salesReturnBalance  = parseFloat(salesReturnBalanceRaw)   || 0;
  const salesReturnRefund   = parseFloat(salesReturnRefundRaw)    || 0;

  // salesReturnBalance drops the open credit still owed to customer.
  // salesReturnRefund represents cash we've already paid back — also drops receivable.
  const salesNet = totalSales - salesPaid - salesWalkInReturn
                 - salesReturnBalance - salesReturnRefund - totalReceipts;

  // ── Purchase side (we owe supplier) ──────────────────────────────────────
  const [
    totalPurchasesRaw, purchasePaidRaw, totalPaymentsRaw,
    purchaseReturnBalanceRaw, purchaseReturnRefundRaw,
  ] = await Promise.all([
    PurchaseBill.sum('total_amount', { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
    PurchaseBill.sum('paid_amount',  { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
    // Audit H3: same auto_from_bill exclusion as the sales side.
    PaymentReceipt.sum('total_amount', {
      where: {
        party_id: partyId, transaction_type: 'Payment', is_cancelled: false,
        [Op.or]: [
          { source: { [Op.ne]: 'auto_from_bill' } },
          { source: { [Op.is]: null } },
        ],
      },
      ...opts,
    }),
    PurchaseReturnBill.sum('balance_amount', {
      where: { supplier_id: partyId, is_cancelled: false },
      ...opts,
    }),
    PurchaseReturnBill.sum('refund_amount', {
      where: { supplier_id: partyId, is_cancelled: false },
      ...opts,
    }),
  ]);

  const totalPurchases         = parseFloat(totalPurchasesRaw)        || 0;
  const purchasePaid           = parseFloat(purchasePaidRaw)          || 0;
  const totalPayments          = parseFloat(totalPaymentsRaw)         || 0;
  const purchaseReturnBalance  = parseFloat(purchaseReturnBalanceRaw) || 0;
  const purchaseReturnRefund   = parseFloat(purchaseReturnRefundRaw)  || 0;

  const purchaseNet = totalPurchases - purchasePaid - totalPayments
                    - purchaseReturnBalance - purchaseReturnRefund;

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
  const {
    Party, SalesBill, PurchaseBill, PaymentReceipt,
    SalesReturnBill, PurchaseReturnBill,
  } = require('../models');
  const opts = t ? { transaction: t } : {};

  const party = await Party.findByPk(partyId, opts);
  if (!party) return 0;

  const rawOpening   = parseFloat(party.opening_balance) || 0;
  const openingSigned = party.opening_balance_type === 'Payable'
    ? -Math.abs(rawOpening)
    :  Math.abs(rawOpening);

  if (transactionType === 'Payment') {
    const [totalPurchasesRaw, purchasePaidRaw, totalPaymentsRaw, prBalRaw, prRefundRaw] = await Promise.all([
      PurchaseBill.sum('total_amount', { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
      PurchaseBill.sum('paid_amount',  { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
      // Audit H3: exclude auto_from_bill receipts (already in paid_amount).
      PaymentReceipt.sum('total_amount', {
        where: {
          party_id: partyId, transaction_type: 'Payment', is_cancelled: false,
          [Op.or]: [
            { source: { [Op.ne]: 'auto_from_bill' } },
            { source: { [Op.is]: null } },
          ],
        },
        ...opts,
      }),
      PurchaseReturnBill.sum('balance_amount', { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
      PurchaseReturnBill.sum('refund_amount',  { where: { supplier_id: partyId, is_cancelled: false }, ...opts }),
    ]);
    const totalPurchases = parseFloat(totalPurchasesRaw) || 0;
    const purchasePaid   = parseFloat(purchasePaidRaw)   || 0;
    const totalPayments  = parseFloat(totalPaymentsRaw)  || 0;
    const prBal          = parseFloat(prBalRaw)          || 0;
    const prRefund       = parseFloat(prRefundRaw)       || 0;
    // What we owe them: payable opening + unpaid purchases - net return credits/refunds.
    const payableOpening = Math.max(0, -openingSigned);
    return +(Math.max(0, payableOpening + totalPurchases - purchasePaid - totalPayments - prBal - prRefund)).toFixed(2);
  }

  if (transactionType === 'Receipt') {
    const [totalSalesRaw, salesPaidRaw, salesReturnRaw, totalReceiptsRaw, srBalRaw, srRefundRaw] = await Promise.all([
      SalesBill.sum('total_amount',  { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
      SalesBill.sum('paid_amount',   { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
      SalesBill.sum('return_amount', { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
      // Audit H3: exclude auto_from_bill receipts.
      PaymentReceipt.sum('total_amount', {
        where: {
          party_id: partyId, transaction_type: 'Receipt', is_cancelled: false,
          [Op.or]: [
            { source: { [Op.ne]: 'auto_from_bill' } },
            { source: { [Op.is]: null } },
          ],
        },
        ...opts,
      }),
      SalesReturnBill.sum('balance_amount', { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
      SalesReturnBill.sum('refund_amount',  { where: { customer_id: partyId, is_cancelled: false }, ...opts }),
    ]);
    const totalSales    = parseFloat(totalSalesRaw)    || 0;
    const salesPaid     = parseFloat(salesPaidRaw)     || 0;
    const salesReturn   = parseFloat(salesReturnRaw)   || 0;
    const totalReceipts = parseFloat(totalReceiptsRaw) || 0;
    const srBal         = parseFloat(srBalRaw)         || 0;
    const srRefund      = parseFloat(srRefundRaw)      || 0;
    // What they owe us: receivable opening + unpaid sales - walk-in returns
    // - formal return credit owed - formal return refund already paid.
    const receivableOpening = Math.max(0, openingSigned);
    return +(Math.max(0, receivableOpening + totalSales - salesPaid - salesReturn - totalReceipts - srBal - srRefund)).toFixed(2);
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
  //
  // Maintains the invariant `paid_amount + balance_amount (+ return_amount
  // for sales) = total_amount` on every bill it touches. This invariant is
  // load-bearing: the aging / bills-receivable banner formula derives
  // `paid_in_bills` from `paid_amount`, and any drift between paid_amount
  // and the actual FIFO-applied amount surfaces as a banner discrepancy.
  // (The pre-fix code only updated balance_amount, leaving paid_amount as
  // a stale at-billing snapshot — a credit-sale bill covered later by an
  // on-account receipt would read paid=0, balance=0, and the formula would
  // double-count the receipt as both unallocated and unapplied.)
  //
  // Math: `cap = total - prev_paid (- return)` is the remaining headroom
  // for new applications. After applying `applyThis` from FIFO/userAlloc,
  // `newPaid = prev_paid + applyThis`, which by construction equals
  // `total - newBalance (- return)`. Both forms are equivalent; the
  // additive form is used so the increment is explicit.
  //
  // KNOWN LIMITATION — this patch keeps the banner formula honest but
  // doesn't integrate with the Phase-R9 `bill_payment_allocations` table.
  // For parties whose receipts pre-date a credit-sale bill (snapshot-at-
  // date FIFO would treat those receipts as advances), this naive FIFO
  // will still allocate them to the bill and bump paid_amount past
  // SUM(allocations), violating the I1 invariant on the admin Integrity
  // screen. The banner stays green either way (the formula's invariant
  // is per-bill, not per-allocation). A follow-up commit should thread
  // reconcile through bill_payment_allocations: subtract existing
  // allocations from the pool before FIFO, INSERT new fifo_auto rows,
  // and derive paid_amount from SUM(allocations) instead of the
  // additive increment used here.
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
      const prevPaid = +(parseFloat(bill.paid_amount) || 0).toFixed(2);
      const newPaid = +(prevPaid + applyThis).toFixed(2);
      const status = newBalance <= 0
        ? 'Paid'
        : newPaid > 0
          ? 'Partial'
          : 'Unpaid';
      await bill.update(
        { balance_amount: newBalance, paid_amount: newPaid, payment_status: status },
        opts,
      );
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
