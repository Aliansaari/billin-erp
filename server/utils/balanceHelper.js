const { Op } = require('sequelize');

/**
 * Recalculates a party's current_balance from scratch using all transaction data.
 *
 * Formula:
 *   balance = opening_signed
 *           + sum(sales.balance_amount   where is_cancelled=false)   [customer owes from bills]
 *           - sum(standalone_receipts    where is_cancelled=false AND reference_bill_id IS NULL)
 *           - sum(purchases.balance_amount where is_cancelled=false) [we owe supplier from bills]
 *           + sum(standalone_payments    where is_cancelled=false AND reference_bill_id IS NULL)
 *
 * Notes:
 *  - sales.balance_amount already reflects initial paid_amount + all bill-linked receipts
 *  - purchases.balance_amount already reflects initial paid_amount + all bill-linked payments
 *  - Only standalone (non-bill-linked) payment records need separate handling
 *  - Positive balance = receivable (party owes us)
 *  - Negative balance = payable (we owe party)
 */
async function recalculatePartyBalance(partyId, t = null) {
  const { Party, SalesBill, PurchaseBill, PaymentReceipt } = require('../models');
  const opts = t ? { transaction: t } : {};

  const party = await Party.findByPk(partyId, opts);
  if (!party) return 0;

  // Opening balance signed value
  const rawOpening = parseFloat(party.opening_balance) || 0;
  const openingSigned = party.opening_balance_type === 'Payable'
    ? -Math.abs(rawOpening)
    : Math.abs(rawOpening);

  // Sum of outstanding sales bill balances
  const salesBalanceRaw = await SalesBill.sum('balance_amount', {
    where: { customer_id: partyId, is_cancelled: false },
    ...opts,
  });
  const salesBalance = parseFloat(salesBalanceRaw) || 0;

  // Sum of standalone receipts (not linked to any bill)
  const standaloneReceiptsRaw = await PaymentReceipt.sum('total_amount', {
    where: {
      party_id: partyId,
      transaction_type: 'Receipt',
      is_cancelled: false,
      reference_bill_id: { [Op.is]: null },
    },
    ...opts,
  });
  const standaloneReceipts = parseFloat(standaloneReceiptsRaw) || 0;

  // Sum of outstanding purchase bill balances
  const purchaseBalanceRaw = await PurchaseBill.sum('balance_amount', {
    where: { supplier_id: partyId, is_cancelled: false },
    ...opts,
  });
  const purchaseBalance = parseFloat(purchaseBalanceRaw) || 0;

  // Sum of standalone payments (not linked to any bill)
  const standalonePaymentsRaw = await PaymentReceipt.sum('total_amount', {
    where: {
      party_id: partyId,
      transaction_type: 'Payment',
      is_cancelled: false,
      reference_bill_id: { [Op.is]: null },
    },
    ...opts,
  });
  const standalonePayments = parseFloat(standalonePaymentsRaw) || 0;

  const newBalance = +(
    openingSigned
    + salesBalance
    - standaloneReceipts
    - purchaseBalance
    + standalonePayments
  ).toFixed(2);

  await party.update({ current_balance: newBalance }, opts);
  return newBalance;
}

module.exports = { recalculatePartyBalance };
