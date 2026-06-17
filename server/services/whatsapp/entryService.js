/**
 * WhatsApp bot entry service.
 *
 * Creates PaymentReceipts and ExpenseVouchers directly from the bot owner
 * flow, bypassing the HTTP layer. All functions must be called from inside
 * withCompany() so AsyncLocalStorage is set and require('../models') resolves
 * to the correct tenant's models.
 */
const { Op } = require('sequelize');

async function createReceiptPayment({ type, partyId, amount, date, paymentMode, billAllocations, companyId, sequelize }) {
  const { PaymentReceipt, PaymentSplit, Party, SalesBill, PurchaseBill } = require('../../models');
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
      // Explicit per-bill allocation (e.g. "for bill 1234"); honoured first by
      // reconcileBillsForParty. Null → pure FIFO (oldest-bill-first).
      bill_allocations: (Array.isArray(billAllocations) && billAllocations.length) ? billAllocations : null,
      remarks: 'Via WhatsApp',
      source: 'manual',
    }, { transaction: t });

    await PaymentSplit.create({
      transaction_id: payment.transaction_id,
      payment_mode: paymentMode,
      amount,
    }, { transaction: t });

    // Snapshot each open bill's balance BEFORE this entry is reconciled in, so
    // we can report exactly which bills it settled/reduced.
    const BillModel = type === 'Payment' ? PurchaseBill : SalesBill;
    const billIdKey = type === 'Payment' ? 'purchase_bill_id' : 'sales_bill_id';
    const partyKey  = type === 'Payment' ? 'supplier_id' : 'customer_id';
    const beforeRows = await BillModel.findAll({
      where: { [partyKey]: partyId, is_cancelled: false },
      attributes: [billIdKey, 'bill_number', 'balance_amount'],
      transaction: t,
    });
    const beforeBal = new Map(beforeRows.map((b) => [b[billIdKey], Number(b.balance_amount) || 0]));

    await reconcileBillsForParty(partyId, t);
    await recalculatePartyBalance(partyId, t);

    // Diff after-vs-before → the bills this entry actually touched.
    const afterRows = await BillModel.findAll({
      where: { [partyKey]: partyId, is_cancelled: false },
      attributes: [billIdKey, 'bill_number', 'balance_amount'],
      transaction: t,
    });
    const appliedBills = [];
    for (const b of afterRows) {
      const before = beforeBal.get(b[billIdKey]);
      const after = Number(b.balance_amount) || 0;
      if (before !== undefined && after < before - 0.01) {
        appliedBills.push({
          bill_number: b.bill_number,
          applied: +(before - after).toFixed(2),
          balance: after,
          cleared: after <= 0.01,
        });
      }
    }
    appliedBills.sort((a, b) => b.applied - a.applied);

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
      appliedBills,
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

    // WhatsApp expenses always post against Cash — choosing a specific bank/UPI
    // account needs the desktop UI, so we don't infer it from the chat. The
    // owner can re-classify the payment account later in the app. (paymentMode
    // is still accepted for a uniform call signature.)
    const payment_mode = 'Cash';

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

// Cancel (undo) a WhatsApp-created Receipt/Payment. Mirrors
// paymentController.cancel: soft-cancel the row, drop its bill allocations,
// re-reconcile + recalc the party, and post the reversing ledger voucher —
// all atomically.
async function cancelEntry({ transactionId, transactionNumber, reason, sequelize }) {
  const { PaymentReceipt, Party } = require('../../models');
  const { recalculatePartyBalance, reconcileBillsForParty } = require('../../utils/balanceHelper');
  const { reverseVoucher } = require('../ledgerPostingService');

  const t = await sequelize.transaction();
  try {
    const where = transactionId ? { transaction_id: transactionId } : { transaction_number: transactionNumber };
    const payment = await PaymentReceipt.findOne({ where, lock: t.LOCK.UPDATE, transaction: t });
    if (!payment) throw new Error('Entry not found.');
    if (payment.is_cancelled) throw new Error('That entry is already cancelled.');
    if (payment.source === 'auto_from_bill') {
      throw new Error('This was auto-generated from a bill — cancel the bill in the app instead.');
    }

    await payment.update({
      is_cancelled: true,
      cancelled_on: new Date(),
      cancellation_reason: reason || 'Cancelled via WhatsApp',
    }, { transaction: t });

    try {
      await sequelize.query('DELETE FROM bill_payment_allocations WHERE transaction_id = :id', {
        replacements: { id: payment.transaction_id }, transaction: t,
      });
    } catch (e) { /* table absent on older schemas — non-fatal */ }

    await Party.findByPk(payment.party_id, { lock: t.LOCK.UPDATE, transaction: t });
    await reconcileBillsForParty(payment.party_id, t);
    await recalculatePartyBalance(payment.party_id, t);
    await reverseVoucher({
      sourceType: 'payment_receipt', sourceId: payment.transaction_id,
      reason: reason || 'Cancelled via WhatsApp', userId: null,
      transaction: t, reversalDate: payment.transaction_date,
    });

    await t.commit();
    const freshParty = await Party.findByPk(payment.party_id);
    return {
      transaction_number: payment.transaction_number,
      transaction_type: payment.transaction_type,
      amount: Number(payment.total_amount) || 0,
      party_name: freshParty && freshParty.party_name,
      freshBalance: freshParty && freshParty.current_balance,
    };
  } catch (e) {
    if (!t.finished) await t.rollback().catch(() => {});
    throw e;
  }
}

// Cancel (undo) a WhatsApp-created Expense voucher: soft-cancel + reverse the
// ledger posting.
async function cancelExpense({ expenseId, voucherNumber, reason, sequelize }) {
  const { ExpenseVoucher } = require('../../models');
  const { reverseVoucher } = require('../ledgerPostingService');

  const t = await sequelize.transaction();
  try {
    const where = expenseId ? { expense_id: expenseId } : { voucher_number: voucherNumber };
    const ev = await ExpenseVoucher.findOne({ where, lock: t.LOCK.UPDATE, transaction: t });
    if (!ev) throw new Error('Expense not found.');
    if (ev.is_cancelled) throw new Error('That expense is already cancelled.');

    await ev.update({
      is_cancelled: true,
      cancelled_at: new Date(),
      cancel_reason: reason || 'Cancelled via WhatsApp',
    }, { transaction: t });

    await reverseVoucher({
      sourceType: 'expense_voucher', sourceId: ev.expense_id,
      reason: reason || 'Cancelled via WhatsApp', userId: null,
      transaction: t, reversalDate: ev.voucher_date,
    });

    await t.commit();
    return { voucher_number: ev.voucher_number, amount: Number(ev.total_amount) || 0 };
  } catch (e) {
    if (!t.finished) await t.rollback().catch(() => {});
    throw e;
  }
}

// Queue paced WhatsApp payment reminders to every customer with an outstanding
// balance. Rows land in whatsapp_outbox as TEXT messages (no PDF); the existing
// outbox worker drains them slowly — daily cap, quiet-hours, opt-out — so this
// can never blast. Returns how many were queued.
async function queueReminders({ sequelize, minAmount = 1 }) {
  const { Party, WhatsappOutbox, WhatsappSettings, SystemSettings } = require('../../models');
  const pacing = require('./pacing');

  const [sys, set] = await Promise.all([
    SystemSettings.findOne(),
    WhatsappSettings.findByPk(1),
  ]);
  const shop = (sys && sys.company_name) || 'us';
  const provider = (set && set.provider) || 'web';

  const where = {
    party_type: { [Op.in]: ['Customer', 'Both'] },
    current_balance: { [Op.gte]: Math.max(0.01, Number(minAmount) || 0.01) },
    whatsapp_opt_out: { [Op.not]: true },
    mobile_1: { [Op.ne]: null },
  };
  const parties = await Party.findAll({
    where,
    order: [['current_balance', 'DESC']],
    attributes: ['party_id', 'party_name', 'current_balance', 'mobile_1'],
  });

  let queued = 0, skipped = 0, total = 0;
  for (const p of parties) {
    const number = pacing.normalizeNumber(p.mobile_1);
    if (!number) { skipped++; continue; }
    const bal = Number(p.current_balance) || 0;
    const amt = '₹' + bal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const text =
      `Namaste ${p.party_name} 🙏\n\n` +
      `*${shop}* — a gentle payment reminder.\n` +
      `Your account shows an outstanding balance of *${amt}*.\n` +
      `Kindly arrange the payment at your convenience. Thank you!\n\n` +
      `_Reply STOP to opt out of these reminders._`;
    await WhatsappOutbox.create({
      provider,
      to_number: number,
      to_jid: pacing.toJid(number),
      party_id: p.party_id,
      doc_type: 'reminder',
      file_name: null,
      caption: text,
      payload_base64: null,
      status: 'queued',
      scheduled_at: new Date(),
    });
    queued++; total += bal;
  }
  return { queued, skipped, total, shop };
}

module.exports = { createReceiptPayment, createExpense, cancelEntry, cancelExpense, queueReminders };
