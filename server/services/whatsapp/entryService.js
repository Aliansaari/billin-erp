/**
 * WhatsApp bot entry service.
 *
 * Creates PaymentReceipts and ExpenseVouchers directly from the bot owner
 * flow, bypassing the HTTP layer. All functions must be called from inside
 * withCompany() so AsyncLocalStorage is set and require('../models') resolves
 * to the correct tenant's models.
 */
const { Op } = require('sequelize');

async function createReceiptPayment({ type, partyId, amount, date, paymentMode, companyId, sequelize }) {
  const { PaymentReceipt, PaymentSplit, Party } = require('../../models');
  const { generateTransactionNumber, safeTrailingNumber } = require('../../utils/helpers');
  const { recalculatePartyBalance, reconcileBillsForParty } = require('../../utils/balanceHelper');
  const { buildPaymentReceiptVouchers } = require('../voucherBuilders');
  const { postVoucher } = require('../ledgerPostingService');

  const prefix = type === 'Payment' ? 'PAY' : 'REC';
  const lockKey = type === 'Payment' ? 901 : 902;
  const t = await sequelize.transaction();

  try {
    // Advisory lock — same serialisation used by paymentController.create()
    await sequelize.query('SELECT pg_advisory_xact_lock(:company, :key)', {
      replacements: { company: Number(companyId) || 0, key: lockKey },
      transaction: t,
    });

    const party = await Party.findByPk(partyId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!party) throw new Error('Party not found.');

    // Generate transaction number
    const last = await PaymentReceipt.findOne({
      where: { transaction_type: type, transaction_number: { [Op.like]: `${prefix}-%` } },
      order: [['transaction_id', 'DESC']],
      transaction: t,
    });
    const transaction_number = generateTransactionNumber(prefix, safeTrailingNumber(last && last.transaction_number));

    const payment = await PaymentReceipt.create({
      transaction_number,
      transaction_type: type,
      transaction_date: date,
      party_id: partyId,
      total_amount: amount,
      payment_method: paymentMode,
      remarks: 'Via WhatsApp',
      source: 'manual',
    }, { transaction: t });

    await PaymentSplit.create({
      transaction_id: payment.transaction_id,
      payment_mode: paymentMode,
      amount,
    }, { transaction: t });

    await reconcileBillsForParty(partyId, t);
    await recalculatePartyBalance(partyId, t);

    const refreshed = await PaymentReceipt.findByPk(payment.transaction_id, {
      include: [
        { model: Party, as: 'party' },
        { model: PaymentSplit, as: 'splits' },
      ],
      transaction: t,
    });
    const vouchers = await buildPaymentReceiptVouchers(refreshed, { transaction: t });
    for (const v of vouchers) {
      await postVoucher({ ...v, userId: null, transaction: t });
    }

    await t.commit();

    const freshParty = await Party.findByPk(partyId);
    const freshReceipt = await PaymentReceipt.findByPk(payment.transaction_id);
    return {
      transaction_number,
      freshBalance: freshParty && freshParty.current_balance,
      receipt: freshReceipt && freshReceipt.toJSON(),
      party: freshParty && freshParty.toJSON(),
    };
  } catch (e) {
    if (!t.finished) await t.rollback().catch(() => {});
    throw e;
  }
}

async function createExpense({ ledgerId, amount, date, description, paymentMode, companyId, sequelize }) {
  const { ExpenseVoucher, ExpenseVoucherItem } = require('../../models');
  const { postVoucher } = require('../ledgerPostingService');
  const { buildExpenseVoucher } = require('../expenseVoucherService');

  const d = new Date(date);
  const prefix = `EXP-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

  const t = await sequelize.transaction();
  try {
    const last = await ExpenseVoucher.findOne({
      where: { voucher_number: { [Op.like]: `${prefix}-%` } },
      order: [['expense_id', 'DESC']],
      transaction: t,
    });
    let seq = 1;
    if (last && last.voucher_number) {
      const m = last.voucher_number.match(/-(\d+)$/);
      if (m) seq = parseInt(m[1], 10) + 1;
    }
    const voucher_number = `${prefix}-${String(seq).padStart(4, '0')}`;

    // UPI / Bank Transfer mode: map to Cash for expense vouchers (bank
    // account selection requires the UI). Owner can edit afterwards.
    const payment_mode = (paymentMode === 'Bank Transfer') ? 'Cash' : 'Cash';

    const ev = await ExpenseVoucher.create({
      voucher_number,
      voucher_date: date,
      payment_mode,
      sub_total: amount,
      cgst_amount: 0,
      sgst_amount: 0,
      igst_amount: 0,
      round_off: 0,
      total_amount: amount,
      paid_amount: amount,
      narration: description ? `${description} (WhatsApp)` : 'Via WhatsApp',
    }, { transaction: t });

    await ExpenseVoucherItem.create({
      expense_id: ev.expense_id,
      expense_ledger_id: ledgerId,
      description: description ? description.slice(0, 255) : null,
      taxable_amount: amount,
      cgst_rate: 0, sgst_rate: 0, igst_rate: 0,
      cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
      line_total: amount,
    }, { transaction: t });

    const built = await buildExpenseVoucher({
      ...ev.toJSON(),
      items: [{ expense_ledger_id: ledgerId, taxable_amount: amount, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }],
      party: null,
    }, { transaction: t });
    await postVoucher({ ...built, userId: null, transaction: t });

    await t.commit();
    return { voucher_number };
  } catch (e) {
    if (!t.finished) await t.rollback().catch(() => {});
    throw e;
  }
}

module.exports = { createReceiptPayment, createExpense };
