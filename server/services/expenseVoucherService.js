// ── Expense Voucher Builder ─────────────────────────────────────────
//
// Pure function that turns an ExpenseVoucher (with items + party + bank)
// into the `lines` array consumed by ledgerPostingService.postVoucher().
// Mirrors voucherBuilders.js for the other voucher types — kept in its
// own file because the expense path is the only one that fans out to
// N expense ledgers per voucher (one per item).
//
// Posting model:
//
//   FOR each item:
//     Dr  expense_ledger_id     taxable_amount
//
//   IF Σ cgst > 0:  Dr  CGST Input  Σ cgst
//   IF Σ sgst > 0:  Dr  SGST Input  Σ sgst
//   IF Σ igst > 0:  Dr  IGST Input  Σ igst
//
//   IF round_off > 0:  Cr  Round Off    round_off
//   IF round_off < 0:  Dr  Round Off   -round_off
//
//   IF paid_amount > 0:
//     IF Cash mode:    Cr  Cash         paid_amount
//     IF Bank mode:    Cr  bank_ledger  paid_amount
//
//   IF (total - paid) > 0:  (always true when payment_mode='Credit')
//     Cr  Vendor Party Ledger   (total_amount - paid_amount)
//
// The voucher_type is 'Payment' — expense vouchers ARE payments out
// (cash leaving / liability incurred). source_type='expense_voucher'
// distinguishes them from the regular Payment vouchers tied to
// payment_receipts. This is the same pattern Sales-bill-receipt uses
// (different source_type, same voucher_type).

const { LedgerAccount, Party } = require('../models');

function r2(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Math.abs(v) < 0.005 ? 0 : v;
}

async function getSystemLedger(name, cache, transaction) {
  if (cache[name]) return cache[name];
  const row = await LedgerAccount.findOne({
    where: { ledger_name: name },
    transaction,
  });
  if (!row) {
    throw new Error(`expenseVoucherService: required ledger missing — '${name}' (re-run seeder?)`);
  }
  cache[name] = row;
  return row;
}

async function getPartyLedger(party, transaction) {
  if (!party) return null;
  if (party.ledger_account_id) {
    const direct = await LedgerAccount.findByPk(party.ledger_account_id, { transaction });
    if (direct) return direct;
  }
  return LedgerAccount.findOne({
    where: { party_id: party.party_id },
    transaction,
  });
}

async function buildExpenseVoucher(voucher, opts = {}) {
  const t = opts.transaction;
  const cache = {};

  const items = Array.isArray(voucher.items) ? voucher.items : [];
  if (items.length === 0) {
    throw new Error('expenseVoucherService: at least one expense item is required');
  }

  const cgstIn  = await getSystemLedger('CGST Input',  cache, t);
  const sgstIn  = await getSystemLedger('SGST Input',  cache, t);
  const igstIn  = await getSystemLedger('IGST Input',  cache, t);
  const roundOf = await getSystemLedger('Round Off',   cache, t);
  const cash    = await getSystemLedger('Cash',        cache, t);

  const subTotal    = r2(voucher.sub_total);
  const cgst        = r2(voucher.cgst_amount);
  const sgst        = r2(voucher.sgst_amount);
  const igst        = r2(voucher.igst_amount);
  const roundOff    = r2(voucher.round_off);
  const totalAmount = r2(voucher.total_amount);
  const paidAmount  = r2(voucher.paid_amount);
  const credit      = r2(totalAmount - paidAmount);

  const lines = [];

  // Roll up taxable amount per expense_ledger_id so a voucher booking
  // ₹500 + ₹300 to the same ledger produces a single Dr ₹800 leg
  // rather than two — clearer in the ledger statement.
  const byLedger = new Map();
  for (const it of items) {
    const lid = Number(it.expense_ledger_id);
    if (!Number.isFinite(lid)) continue;
    const amt = r2(it.taxable_amount);
    if (amt <= 0) continue;
    byLedger.set(lid, (byLedger.get(lid) || 0) + amt);
  }
  for (const [lid, amt] of byLedger.entries()) {
    lines.push({ ledgerAccountId: lid, debit: r2(amt), credit: 0 });
  }

  if (cgst > 0) lines.push({ ledgerAccountId: cgstIn.ledger_id, debit: cgst, credit: 0 });
  if (sgst > 0) lines.push({ ledgerAccountId: sgstIn.ledger_id, debit: sgst, credit: 0 });
  if (igst > 0) lines.push({ ledgerAccountId: igstIn.ledger_id, debit: igst, credit: 0 });

  if (roundOff < 0) {
    lines.push({ ledgerAccountId: roundOf.ledger_id, debit: -roundOff, credit: 0 });
  }

  // Cash / bank credit leg (paid portion).
  if (paidAmount > 0) {
    let payLedger;
    if (voucher.payment_mode === 'Bank') {
      if (!voucher.bank_ledger_id) {
        throw new Error('expenseVoucherService: payment_mode=Bank requires bank_ledger_id');
      }
      payLedger = await LedgerAccount.findByPk(voucher.bank_ledger_id, { transaction: t });
      if (!payLedger) {
        throw new Error(`expenseVoucherService: bank ledger #${voucher.bank_ledger_id} not found`);
      }
    } else {
      // 'Cash' — and as a fallback for 'Credit' rows that happen to
      // record a cash partial. The post-condition (paid > 0 ⇒ a paying
      // leg exists) is what matters; the operator can tag credit with
      // a partial cash payment as "Cash", we won't second-guess.
      payLedger = cash;
    }
    lines.push({ ledgerAccountId: payLedger.ledger_id, debit: 0, credit: paidAmount });
  }

  // Vendor leg (credit portion). Required for payment_mode='Credit';
  // also fires for Cash/Bank vouchers if paid_amount < total_amount
  // (partial payment leaves a payable balance against the vendor).
  if (credit > 0) {
    if (!voucher.party_id) {
      throw new Error(
        `expenseVoucherService: ₹${credit.toFixed(2)} unpaid balance requires a vendor party`,
      );
    }
    const party = voucher.party || await Party.findByPk(voucher.party_id, { transaction: t });
    if (!party) {
      throw new Error(`expenseVoucherService: party #${voucher.party_id} not found`);
    }
    if (party.is_system_cash) {
      // Booking a credit balance against the system Cash party would
      // post a payable to a "ledger" that's actually Cash-in-Hand —
      // nonsensical. Force the operator to use Cash mode (no party
      // tag) instead.
      throw new Error(
        'Cannot record a credit balance against the system Cash party. Pick a real vendor.',
      );
    }
    const partyLedger = await getPartyLedger(party, t);
    if (!partyLedger) {
      throw new Error(`expenseVoucherService: party #${party.party_id} has no ledger account`);
    }
    lines.push({
      ledgerAccountId: partyLedger.ledger_id,
      debit:  0,
      credit: credit,
      partyId: party.party_id,
    });
  }

  if (roundOff > 0) {
    lines.push({ ledgerAccountId: roundOf.ledger_id, debit: 0, credit: roundOff });
  }

  // Sanity: debits must equal credits before we hand off to the posting
  // service. The posting service re-validates at the paisa level — this
  // pre-check just turns silent rounding bugs into clear errors.
  let dr = 0, cr = 0;
  for (const ln of lines) { dr += ln.debit; cr += ln.credit; }
  if (Math.abs(dr - cr) > 0.005) {
    throw new Error(
      `expenseVoucherService: built unbalanced voucher — Dr ${dr.toFixed(2)} ≠ Cr ${cr.toFixed(2)}. ` +
      `Check item totals vs total_amount (${totalAmount}).`,
    );
  }

  return {
    voucherType:      'Payment',
    sourceType:       'expense_voucher',
    sourceId:         voucher.expense_id,
    voucherDate:      voucher.voucher_date,
    referenceNumber:  voucher.voucher_number,
    lines,
    narration: voucher.narration ||
      (voucher.party ? `Expense — ${voucher.party.party_name}` : 'Expense entry'),
  };
}

module.exports = { buildExpenseVoucher };
