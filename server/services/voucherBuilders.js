// ── Voucher Builders ───────────────────────────────────────────────────
//
// Pure functions that turn a SalesBill / PurchaseBill / Return /
// PaymentReceipt instance into the `lines` array consumed by
// ledgerPostingService.postVoucher().
//
// Conventions encoded here:
//   • Net Sales method — Sales Account is credited at sub_total - discount.
//     No separate Discount-Allowed line. Same for Purchase / Discount-Received.
//   • Other Charges and Freight on a sale ride along with Sales Account
//     (no separate Other-Income / Freight-Outward ledgers seeded). On a
//     purchase, they ride along with Purchase Account.
//   • Round Off: positive value → credit Round-Off (income); negative →
//     debit Round-Off (expense). Mirrored on purchase.
//   • Cash sale / cash purchase: when customer_id / supplier_id is absent
//     OR when the linked party is the system Cash party (party.is_system_cash),
//     the party leg is replaced with the Cash ledger directly (no party
//     tag) — the system Cash party's ledger_account_id is the Cash-in-Hand
//     ledger, so even if we did walk through getPartyLedger() the leg
//     would land on Cash. Going direct keeps the post free of the
//     party_id tag (so per-party reports / aging never see cash bills).
//   • Each bill produces ONE primary voucher (Sales/Purchase). If the bill
//     records paid_amount > 0 against a NON-cash customer/supplier, a SECOND
//     voucher (Receipt / Payment) is posted for the paid portion in the same
//     transaction. Cash sales/purchases are posted as a single voucher
//     (Cash → Sales / Purchase → Cash) — a Cash Dr / Cash Cr receipt
//     would be a self-cancelling no-op.
//
// All builders return `{ lines, narration, voucherDate, referenceNumber }`
// — a payload ready to spread into postVoucher(). They never write to the
// DB themselves; that's the Posting Service's job.
// ────────────────────────────────────────────────────────────────────────

const { LedgerAccount, Party } = require('../models');

// Round to 2dp and treat near-zero as zero so we don't post junk lines.
function r2(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Math.abs(v) < 0.005 ? 0 : v;
}

// Cache lookups for the duration of the request — avoids 6 round-trips per
// sale. Caller passes a fresh empty object as `cache`.
async function getSystemLedger(name, cache, transaction) {
  if (cache[name]) return cache[name];
  const row = await LedgerAccount.findOne({
    where: { ledger_name: name },
    transaction,
  });
  if (!row) {
    throw new Error(`voucherBuilders: required ledger missing — '${name}' (re-run seeder?)`);
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
  // Fallback: find by party_id back-link (e.g. the column was nulled by a
  // wipe but the ledger row still exists).
  return LedgerAccount.findOne({ where: { party_id: party.party_id }, transaction });
}

// Map a payment method string to the right system ledger.
// 'Cash' and anything cash-like → Cash; everything else → Bank Account.
async function paymentMethodToLedger(method, cache, transaction) {
  const m = String(method || 'Cash').toLowerCase();
  if (m === 'cash') return getSystemLedger('Cash', cache, transaction);
  return getSystemLedger('Bank Account', cache, transaction);
}

// ── Sales Bill ─────────────────────────────────────────────────────────
//
//   buildSalesBillVouchers(bill, opts)
//     bill: SalesBill instance with customer (Party) preloaded if available
//     opts: { transaction }
//   Returns: [primaryVoucher, optionalReceiptVoucher]
//     Each voucher: { voucherType, sourceType, sourceId, voucherDate,
//                     referenceNumber, lines, narration }
//
// Posting model:
//   Customer Dr     total_amount        (or Cash if no customer_id)
//     Sales Cr      sub_total - discount + other + freight
//     CGST Output Cr  cgst_amount
//     SGST Output Cr  sgst_amount
//     IGST Output Cr  igst_amount
//     Round Off Cr  round_off       (if > 0)
//   Round Off Dr  -round_off          (if < 0; expense side)
//
// If paid_amount > 0 AND customer_id is present, a second voucher is
// produced: Cash/Bank Dr paid / Customer Cr paid.
async function buildSalesBillVouchers(bill, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const customer = bill.customer || (bill.customer_id
    ? await Party.findByPk(bill.customer_id, { transaction: t })
    : null);
  // System Cash party? Treat as a cash sale (Cash leg, no party tag, no
  // receipt voucher) regardless of whether customer_id was set.
  const isCashCustomer = !customer || !!customer.is_system_cash;

  const sales   = await getSystemLedger('Sales Account', cache, t);
  const cash    = await getSystemLedger('Cash',          cache, t);
  const cgstOut = await getSystemLedger('CGST Output',   cache, t);
  const sgstOut = await getSystemLedger('SGST Output',   cache, t);
  const igstOut = await getSystemLedger('IGST Output',   cache, t);
  const roundOf = await getSystemLedger('Round Off',     cache, t);

  const subTotal       = r2(bill.sub_total);
  const discount       = r2(bill.discount_amount);
  const otherCharges   = r2(bill.other_charges);
  const freight        = r2(bill.freight_charges);
  const cgst           = r2(bill.cgst_amount);
  const sgst           = r2(bill.sgst_amount);
  const igst           = r2(bill.igst_amount);
  const roundOff       = r2(bill.round_off);
  const totalAmount    = r2(bill.total_amount);
  const paidAmount     = r2(bill.paid_amount);

  // Net sales credit
  const salesCredit = r2(subTotal - discount + otherCharges + freight);

  const lines = [];

  // Party / Cash debit (the receivable)
  if (!isCashCustomer) {
    const partyLedger = await getPartyLedger(customer, t);
    if (!partyLedger) {
      throw new Error(`buildSalesBillVouchers: customer #${customer.party_id} has no ledger account — run backfill?`);
    }
    lines.push({ ledgerAccountId: partyLedger.ledger_id, debit: totalAmount, credit: 0, partyId: customer.party_id });
  } else {
    // Cash sale: Cash account debited for the full bill — no party tag,
    // so this entry never shows up in per-party ledgers / aging.
    lines.push({ ledgerAccountId: cash.ledger_id, debit: totalAmount, credit: 0 });
  }

  if (salesCredit > 0) lines.push({ ledgerAccountId: sales.ledger_id,   debit: 0, credit: salesCredit });
  if (cgst > 0)        lines.push({ ledgerAccountId: cgstOut.ledger_id, debit: 0, credit: cgst });
  if (sgst > 0)        lines.push({ ledgerAccountId: sgstOut.ledger_id, debit: 0, credit: sgst });
  if (igst > 0)        lines.push({ ledgerAccountId: igstOut.ledger_id, debit: 0, credit: igst });

  if (roundOff > 0) {
    lines.push({ ledgerAccountId: roundOf.ledger_id, debit: 0, credit: roundOff });
  } else if (roundOff < 0) {
    lines.push({ ledgerAccountId: roundOf.ledger_id, debit: -roundOff, credit: 0 });
  }

  // Narration: use the walk-in name if the operator captured one on the
  // bill so audit logs read "Cash sale (Mr Sharma)" rather than just
  // "Cash sale". Falls back to the party name for credit sales.
  const walkIn = String(bill.walk_in_name || '').trim();
  const primary = {
    voucherType: 'Sales',
    sourceType:  'sales_bill',
    sourceId:    bill.sales_bill_id,
    voucherDate: bill.bill_date,
    referenceNumber: bill.bill_number,
    lines,
    narration: isCashCustomer
      ? (walkIn ? `Cash sale (${walkIn})` : 'Cash sale')
      : `Sales to ${customer.party_name}`,
  };

  // Optional receipt voucher for any paid_amount on a CREDIT sale.
  // Cash sales already have Cash debited above — adding a Cash Dr /
  // Cash Cr receipt would be a self-cancelling no-op.
  const vouchers = [primary];
  if (!isCashCustomer && paidAmount > 0) {
    const partyLedger = await getPartyLedger(customer, t);
    const cashOrBank = await paymentMethodToLedger(bill.payment_method, cache, t);
    vouchers.push({
      voucherType: 'Receipt',
      sourceType:  'sales_bill_receipt',   // distinct from a standalone payment_receipt
      sourceId:    bill.sales_bill_id,
      voucherDate: bill.bill_date,
      referenceNumber: bill.bill_number,
      lines: [
        { ledgerAccountId: cashOrBank.ledger_id,    debit:  paidAmount, credit: 0 },
        { ledgerAccountId: partyLedger.ledger_id,   debit:  0, credit: paidAmount, partyId: customer.party_id },
      ],
      narration: `Receipt at sale (${bill.bill_number})`,
    });
  }
  return vouchers;
}

// ── Purchase Bill ──────────────────────────────────────────────────────
// Mirror of sales: Purchase Dr / GST Input Dr / Supplier Cr.
async function buildPurchaseBillVouchers(bill, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const supplier = bill.supplier || (bill.supplier_id
    ? await Party.findByPk(bill.supplier_id, { transaction: t })
    : null);
  const isCashSupplier = !supplier || !!supplier.is_system_cash;

  const purchase = await getSystemLedger('Purchase Account', cache, t);
  const cash     = await getSystemLedger('Cash',             cache, t);
  const cgstIn   = await getSystemLedger('CGST Input',       cache, t);
  const sgstIn   = await getSystemLedger('SGST Input',       cache, t);
  const igstIn   = await getSystemLedger('IGST Input',       cache, t);
  const roundOf  = await getSystemLedger('Round Off',        cache, t);

  const subTotal     = r2(bill.sub_total);
  const discount     = r2(bill.discount_amount);
  const otherCharges = r2(bill.other_charges);
  const freight      = r2(bill.freight_charges);
  const cgst         = r2(bill.cgst_amount);
  const sgst         = r2(bill.sgst_amount);
  const igst         = r2(bill.igst_amount);
  const roundOff     = r2(bill.round_off);
  const totalAmount  = r2(bill.total_amount);
  const paidAmount   = r2(bill.paid_amount);

  const purchaseDebit = r2(subTotal - discount + otherCharges + freight);

  const lines = [];
  if (purchaseDebit > 0) lines.push({ ledgerAccountId: purchase.ledger_id, debit: purchaseDebit, credit: 0 });
  if (cgst > 0)          lines.push({ ledgerAccountId: cgstIn.ledger_id,   debit: cgst, credit: 0 });
  if (sgst > 0)          lines.push({ ledgerAccountId: sgstIn.ledger_id,   debit: sgst, credit: 0 });
  if (igst > 0)          lines.push({ ledgerAccountId: igstIn.ledger_id,   debit: igst, credit: 0 });
  if (roundOff > 0) lines.push({ ledgerAccountId: roundOf.ledger_id, debit: roundOff, credit: 0 });
  else if (roundOff < 0) lines.push({ ledgerAccountId: roundOf.ledger_id, debit: 0, credit: -roundOff });

  if (!isCashSupplier) {
    const partyLedger = await getPartyLedger(supplier, t);
    if (!partyLedger) {
      throw new Error(`buildPurchaseBillVouchers: supplier #${supplier.party_id} has no ledger account — run backfill?`);
    }
    lines.push({ ledgerAccountId: partyLedger.ledger_id, debit: 0, credit: totalAmount, partyId: supplier.party_id });
  } else {
    // Cash purchase — Cash credited directly, no party tag.
    lines.push({ ledgerAccountId: cash.ledger_id, debit: 0, credit: totalAmount });
  }

  const walkIn = String(bill.walk_in_name || '').trim();
  const primary = {
    voucherType: 'Purchase',
    sourceType:  'purchase_bill',
    sourceId:    bill.purchase_bill_id,
    voucherDate: bill.bill_date,
    referenceNumber: bill.bill_number,
    lines,
    narration: isCashSupplier
      ? (walkIn ? `Cash purchase (${walkIn})` : 'Cash purchase')
      : `Purchase from ${supplier.party_name}`,
  };

  const vouchers = [primary];
  if (!isCashSupplier && paidAmount > 0) {
    const partyLedger = await getPartyLedger(supplier, t);
    const cashOrBank = await paymentMethodToLedger(bill.payment_method, cache, t);
    vouchers.push({
      voucherType: 'Payment',
      sourceType:  'purchase_bill_payment',
      sourceId:    bill.purchase_bill_id,
      voucherDate: bill.bill_date,
      referenceNumber: bill.bill_number,
      lines: [
        { ledgerAccountId: partyLedger.ledger_id, debit: paidAmount, credit: 0, partyId: supplier.party_id },
        { ledgerAccountId: cashOrBank.ledger_id, debit: 0, credit: paidAmount },
      ],
      narration: `Payment at purchase (${bill.bill_number})`,
    });
  }
  return vouchers;
}

// ── Sales Return (Credit Note) ────────────────────────────────────────
// Reverse the sale: Sales Return Dr (or Sales Dr) / Customer Cr.
// We use 'Sales Return' contra ledger for the income reversal so the
// P&L shows gross sales and returns separately.
async function buildSalesReturnVouchers(ret, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const customer = ret.customer || (ret.customer_id
    ? await Party.findByPk(ret.customer_id, { transaction: t })
    : null);
  const isCashCustomer = !customer || !!customer.is_system_cash;

  const salesReturn = await getSystemLedger('Sales Return', cache, t);
  const cash        = await getSystemLedger('Cash',         cache, t);
  const cgstOut     = await getSystemLedger('CGST Output',  cache, t);
  const sgstOut     = await getSystemLedger('SGST Output',  cache, t);
  const igstOut     = await getSystemLedger('IGST Output',  cache, t);
  const roundOf     = await getSystemLedger('Round Off',    cache, t);

  const subTotal      = r2(ret.sub_total);
  const discount      = r2(ret.discount_amount);
  const otherCharges  = r2(ret.other_charges);
  const freight       = r2(ret.freight_charges);
  const cgst          = r2(ret.cgst_amount);
  const sgst          = r2(ret.sgst_amount);
  const igst          = r2(ret.igst_amount);
  const roundOff      = r2(ret.round_off);
  const totalAmount   = r2(ret.total_amount);

  const returnDebit = r2(subTotal - discount + otherCharges + freight);

  const lines = [];
  if (returnDebit > 0) lines.push({ ledgerAccountId: salesReturn.ledger_id, debit: returnDebit, credit: 0 });
  if (cgst > 0)        lines.push({ ledgerAccountId: cgstOut.ledger_id,     debit: cgst, credit: 0 });
  if (sgst > 0)        lines.push({ ledgerAccountId: sgstOut.ledger_id,     debit: sgst, credit: 0 });
  if (igst > 0)        lines.push({ ledgerAccountId: igstOut.ledger_id,     debit: igst, credit: 0 });
  if (roundOff > 0) lines.push({ ledgerAccountId: roundOf.ledger_id, debit: roundOff, credit: 0 });
  else if (roundOff < 0) lines.push({ ledgerAccountId: roundOf.ledger_id, debit: 0, credit: -roundOff });

  if (!isCashCustomer) {
    const partyLedger = await getPartyLedger(customer, t);
    if (!partyLedger) {
      throw new Error(`buildSalesReturnVouchers: customer #${customer.party_id} has no ledger account`);
    }
    lines.push({ ledgerAccountId: partyLedger.ledger_id, debit: 0, credit: totalAmount, partyId: customer.party_id });
  } else {
    lines.push({ ledgerAccountId: cash.ledger_id, debit: 0, credit: totalAmount });
  }

  return [{
    voucherType: 'Journal',  // credit notes don't fit cleanly in the existing enum
    sourceType:  'sales_return_bill',
    sourceId:    ret.sales_return_id,
    voucherDate: ret.return_date,
    referenceNumber: ret.return_number,
    lines,
    narration: isCashCustomer
      ? 'Cash sales return'
      : `Sales return from ${customer.party_name}`,
  }];
}

// ── Purchase Return (Debit Note) ──────────────────────────────────────
async function buildPurchaseReturnVouchers(ret, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const supplier = ret.supplier || (ret.supplier_id
    ? await Party.findByPk(ret.supplier_id, { transaction: t })
    : null);
  const isCashSupplier = !supplier || !!supplier.is_system_cash;

  const purchaseReturn = await getSystemLedger('Purchase Return', cache, t);
  const cash           = await getSystemLedger('Cash',            cache, t);
  const cgstIn         = await getSystemLedger('CGST Input',      cache, t);
  const sgstIn         = await getSystemLedger('SGST Input',      cache, t);
  const igstIn         = await getSystemLedger('IGST Input',      cache, t);
  const roundOf        = await getSystemLedger('Round Off',       cache, t);

  const subTotal     = r2(ret.sub_total);
  const discount     = r2(ret.discount_amount);
  const otherCharges = r2(ret.other_charges);
  const freight      = r2(ret.freight_charges);
  const cgst         = r2(ret.cgst_amount);
  const sgst         = r2(ret.sgst_amount);
  const igst         = r2(ret.igst_amount);
  const roundOff     = r2(ret.round_off);
  const totalAmount  = r2(ret.total_amount);

  const returnCredit = r2(subTotal - discount + otherCharges + freight);

  const lines = [];
  if (!isCashSupplier) {
    const partyLedger = await getPartyLedger(supplier, t);
    if (!partyLedger) {
      throw new Error(`buildPurchaseReturnVouchers: supplier #${supplier.party_id} has no ledger account`);
    }
    lines.push({ ledgerAccountId: partyLedger.ledger_id, debit: totalAmount, credit: 0, partyId: supplier.party_id });
  } else {
    lines.push({ ledgerAccountId: cash.ledger_id, debit: totalAmount, credit: 0 });
  }

  if (returnCredit > 0) lines.push({ ledgerAccountId: purchaseReturn.ledger_id, debit: 0, credit: returnCredit });
  if (cgst > 0)         lines.push({ ledgerAccountId: cgstIn.ledger_id,         debit: 0, credit: cgst });
  if (sgst > 0)         lines.push({ ledgerAccountId: sgstIn.ledger_id,         debit: 0, credit: sgst });
  if (igst > 0)         lines.push({ ledgerAccountId: igstIn.ledger_id,         debit: 0, credit: igst });
  if (roundOff > 0)      lines.push({ ledgerAccountId: roundOf.ledger_id, debit: 0, credit: roundOff });
  else if (roundOff < 0) lines.push({ ledgerAccountId: roundOf.ledger_id, debit: -roundOff, credit: 0 });

  return [{
    voucherType: 'Journal',
    sourceType:  'purchase_return_bill',
    sourceId:    ret.purchase_return_id,
    voucherDate: ret.return_date,
    referenceNumber: ret.return_number,
    lines,
    narration: isCashSupplier
      ? 'Cash purchase return'
      : `Purchase return to ${supplier.party_name}`,
  }];
}

// ── Payment Receipt ────────────────────────────────────────────────────
//
// PaymentReceipt has transaction_type = 'Receipt' (cash IN from customer)
// or 'Payment' (cash OUT to supplier). PaymentSplits give multi-method
// deposits (cash + bank). The party is on the receipt header.
async function buildPaymentReceiptVouchers(receipt, opts = {}) {
  const t = opts.transaction;
  const cache = {};
  const party = receipt.party || (receipt.party_id
    ? await Party.findByPk(receipt.party_id, { transaction: t })
    : null);

  if (!party) {
    throw new Error(`buildPaymentReceiptVouchers: receipt #${receipt.transaction_id} has no party`);
  }
  const partyLedger = await getPartyLedger(party, t);
  if (!partyLedger) {
    throw new Error(`buildPaymentReceiptVouchers: party #${party.party_id} has no ledger account`);
  }

  const totalAmount = r2(receipt.total_amount);
  const isReceipt = receipt.transaction_type === 'Receipt';

  // Build cash/bank legs from splits if present, else single from payment_method.
  const splits = Array.isArray(receipt.splits) ? receipt.splits : [];
  const methodLegs = [];
  if (splits.length > 0) {
    for (const s of splits) {
      const amt = r2(s.amount);
      if (amt <= 0) continue;
      const lg = await paymentMethodToLedger(s.payment_method, cache, t);
      methodLegs.push({ ledger: lg, amount: amt });
    }
  } else {
    const lg = await paymentMethodToLedger(receipt.payment_method, cache, t);
    methodLegs.push({ ledger: lg, amount: totalAmount });
  }

  // Sanity: legs must sum to total
  const sumLegs = methodLegs.reduce((s, l) => s + l.amount, 0);
  if (Math.abs(sumLegs - totalAmount) > 0.005) {
    throw new Error(
      `buildPaymentReceiptVouchers: split total ${sumLegs} ≠ receipt total ${totalAmount}`,
    );
  }

  const lines = [];
  if (isReceipt) {
    // Receipt: Cash/Bank Dr / Customer Cr
    for (const leg of methodLegs) {
      lines.push({ ledgerAccountId: leg.ledger.ledger_id, debit: leg.amount, credit: 0 });
    }
    lines.push({ ledgerAccountId: partyLedger.ledger_id, debit: 0, credit: totalAmount, partyId: party.party_id });
  } else {
    // Payment: Supplier Dr / Cash/Bank Cr
    lines.push({ ledgerAccountId: partyLedger.ledger_id, debit: totalAmount, credit: 0, partyId: party.party_id });
    for (const leg of methodLegs) {
      lines.push({ ledgerAccountId: leg.ledger.ledger_id, debit: 0, credit: leg.amount });
    }
  }

  return [{
    voucherType: isReceipt ? 'Receipt' : 'Payment',
    sourceType:  'payment_receipt',
    sourceId:    receipt.transaction_id,
    voucherDate: receipt.transaction_date,
    referenceNumber: receipt.transaction_number,
    lines,
    narration: `${isReceipt ? 'Receipt from' : 'Payment to'} ${party.party_name}`,
  }];
}

module.exports = {
  buildSalesBillVouchers,
  buildPurchaseBillVouchers,
  buildSalesReturnVouchers,
  buildPurchaseReturnVouchers,
  buildPaymentReceiptVouchers,
};
