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

const {
  LedgerAccount, Party,
  SalesBillItem, PurchaseBillItem,
  SalesReturnBillItem, PurchaseReturnBillItem,
} = require('../models');

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

// Optional system ledger — returns null when missing rather than throwing.
// Used for Cess Output / Cess Input which are NEW ledgers (audit C1) that
// older deployments may not have seeded yet. Callers fold cess into the
// general GST ledger when null is returned.
async function getOptionalLedger(name, cache, transaction) {
  if (cache[name]) return cache[name];
  const row = await LedgerAccount.findOne({
    where: { ledger_name: name },
    transaction,
  });
  if (row) cache[name] = row;
  return row || null;
}

// Sum the per-line `discount_amount` across the items of a bill. The
// builder needs this so the income / expense leg can be netted at
// `sub_total - itemDiscountTotal - billDiscount - special_discount` —
// matching how `total_amount` was computed by the controller. Without
// this, a bill with ANY per-line discount produces an unbalanced voucher
// and rolls back. (Audit C1.)
//
// Loads items only if `bill.items` wasn't preloaded by the caller (most
// modern call-sites preload via `include` in salesController/etc.).
async function sumItemDiscount(bill, ItemModel, billIdField, transaction) {
  if (Array.isArray(bill.items) && bill.items.length > 0) {
    return r2(bill.items.reduce((s, it) => s + (Number(it.discount_amount) || 0), 0));
  }
  // Fallback: re-load.
  const billId = bill[billIdField];
  if (!billId) return 0;
  const rows = await ItemModel.findAll({
    where: { [billIdField]: billId },
    attributes: ['discount_amount'],
    transaction,
  });
  return r2(rows.reduce((s, r) => s + (Number(r.discount_amount) || 0), 0));
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

// Resolve the cash-or-bank ledger leg for a payment. The argument is a
// "context" object — typically a payment_split, a sales_bill, or a
// purchase_bill. Three cases, in order of preference:
//
//   1. ctx.bank_ledger_id is set → look up that exact ledger. This is
//      the modern path (the form picked a specific bank).
//   2. mode is Cash (or unset) → the system 'Cash' ledger.
//   3. Legacy fallback → the system 'Bank Account' ledger. This keeps
//      pre-migration rows posting consistently while we phase out the
//      single-bank model.
//
// We never throw on a dangling bank_ledger_id; instead we fall through
// to the legacy bank lookup so a stale FK from a deleted ledger still
// posts somewhere sensible. The Ledger Integrity report will surface
// any drift this introduces.
async function paymentMethodToLedger(ctx, cache, transaction, opts = {}) {
  // Backwards-compat: callers used to pass a method string. Tolerate it.
  if (typeof ctx === 'string' || ctx == null) {
    ctx = { payment_mode: ctx };
  }

  // Mode lives on splits as `payment_mode`; on sales/purchase bills as
  // `payment_method`. Read both so we don't care which kind of object
  // the caller passed.
  const mode = String(
    ctx.payment_mode || ctx.payment_method || 'Cash',
  ).toLowerCase();

  // Audit BANK-1 — PDC routing. When the caller indicates this is a
  // post-dated cheque (cheque_date > transaction_date), route to the
  // holding ledger instead of the chosen bank. The contra-voucher to
  // move the balance from holding → bank is posted later by
  // chequeController.clear when the cheque physically clears.
  // direction: 'INWARD' (Receipt) → PDC Receivable
  //            'OUTWARD' (Payment) → PDC Payable
  if (opts.isPdc) {
    const ledgerName = opts.direction === 'OUTWARD'
      ? 'Post-Dated Cheques (Payable)'
      : 'Post-Dated Cheques (Receivable)';
    return getSystemLedger(ledgerName, cache, transaction);
  }

  // 1. Explicit bank ledger wins (non-PDC path).
  if (ctx.bank_ledger_id) {
    const cacheKey = `__bank_${ctx.bank_ledger_id}`;
    if (cache[cacheKey]) return cache[cacheKey];
    const row = await LedgerAccount.findByPk(ctx.bank_ledger_id, { transaction });
    if (row) { cache[cacheKey] = row; return row; }
    // Dangling FK — fall through.
  }

  // 2. Cash.
  if (mode === 'cash') return getSystemLedger('Cash', cache, transaction);

  // 3. Legacy bank.
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
  // Cess output is optional — older deployments don't seed it. When
  // missing, cess folds into IGST Output (a defensible fallback that
  // preserves Σ Dr = Σ Cr; report consumers can still read cess_amount
  // off the bill row for GSTR-3B). Audit C1.
  const cessOut = await getOptionalLedger('Cess Output', cache, t);

  const subTotal       = r2(bill.sub_total);
  const discount       = r2(bill.discount_amount);
  const specialDisc    = r2(bill.special_discount);
  const otherCharges   = r2(bill.other_charges);
  const freight        = r2(bill.freight_charges);
  const cgst           = r2(bill.cgst_amount);
  const sgst           = r2(bill.sgst_amount);
  const igst           = r2(bill.igst_amount);
  const cess           = r2(bill.cess_amount);
  const roundOff       = r2(bill.round_off);
  const totalAmount    = r2(bill.total_amount);
  const paidAmount     = r2(bill.paid_amount);

  // Per-line discount sum — controller persists it as
  // sales_bill_items.discount_amount. Without netting it, the Sales Cr
  // leg is too high by exactly this amount and the voucher fails to
  // balance. Audit C1.
  const itemDiscountTotal = await sumItemDiscount(bill, SalesBillItem, 'sales_bill_id', t);

  // Net sales credit — mirrors the controller's taxable-base formula:
  //   sub_total - itemDisc - billDisc - special_disc + other + freight
  const salesCredit = r2(subTotal - itemDiscountTotal - discount - specialDisc + otherCharges + freight);

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
  if (cess > 0) {
    // Cess Output if seeded; otherwise fold into IGST Output as a
    // defensible fallback (still Σ Dr = Σ Cr, just less granular).
    const cessLedger = cessOut || igstOut;
    lines.push({ ledgerAccountId: cessLedger.ledger_id, debit: 0, credit: cess });
  }

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
    // Pass the bill itself so the resolver can read both
    // payment_method and the (newer) bank_ledger_id off of it.
    const cashOrBank = await paymentMethodToLedger(bill, cache, t);
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
  const cessIn   = await getOptionalLedger('Cess Input', cache, t);

  const subTotal     = r2(bill.sub_total);
  const discount     = r2(bill.discount_amount);
  const specialDisc  = r2(bill.special_discount);
  const otherCharges = r2(bill.other_charges);
  const freight      = r2(bill.freight_charges);
  const cgst         = r2(bill.cgst_amount);
  const sgst         = r2(bill.sgst_amount);
  const igst         = r2(bill.igst_amount);
  const cess         = r2(bill.cess_amount);
  const roundOff     = r2(bill.round_off);
  const totalAmount  = r2(bill.total_amount);
  const paidAmount   = r2(bill.paid_amount);

  // Per-line discount sum + special_discount + cess — see audit C1
  // comment in buildSalesBillVouchers.
  const itemDiscountTotal = await sumItemDiscount(bill, PurchaseBillItem, 'purchase_bill_id', t);

  const purchaseDebit = r2(subTotal - itemDiscountTotal - discount - specialDisc + otherCharges + freight);

  const lines = [];
  if (purchaseDebit > 0) lines.push({ ledgerAccountId: purchase.ledger_id, debit: purchaseDebit, credit: 0 });
  if (cgst > 0)          lines.push({ ledgerAccountId: cgstIn.ledger_id,   debit: cgst, credit: 0 });
  if (sgst > 0)          lines.push({ ledgerAccountId: sgstIn.ledger_id,   debit: sgst, credit: 0 });
  if (igst > 0)          lines.push({ ledgerAccountId: igstIn.ledger_id,   debit: igst, credit: 0 });
  if (cess > 0) {
    const cessLedger = cessIn || igstIn;
    lines.push({ ledgerAccountId: cessLedger.ledger_id, debit: cess, credit: 0 });
  }
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
    // Pass the bill so the resolver can read bank_ledger_id when set.
    const cashOrBank = await paymentMethodToLedger(bill, cache, t);
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
  const cessOut     = await getOptionalLedger('Cess Output', cache, t);

  const subTotal      = r2(ret.sub_total);
  const discount      = r2(ret.discount_amount);
  const specialDisc   = r2(ret.special_discount);
  const otherCharges  = r2(ret.other_charges);
  const freight       = r2(ret.freight_charges);
  const cgst          = r2(ret.cgst_amount);
  const sgst          = r2(ret.sgst_amount);
  const igst          = r2(ret.igst_amount);
  const cess          = r2(ret.cess_amount);
  const roundOff      = r2(ret.round_off);
  const totalAmount   = r2(ret.total_amount);

  // Audit C1 — same shape as the forward sale: net out itemDisc +
  // billDisc + special_disc; emit a separate cess leg.
  const itemDiscountTotal = await sumItemDiscount(ret, SalesReturnBillItem, 'sales_return_id', t);

  const returnDebit = r2(subTotal - itemDiscountTotal - discount - specialDisc + otherCharges + freight);

  const lines = [];
  if (returnDebit > 0) lines.push({ ledgerAccountId: salesReturn.ledger_id, debit: returnDebit, credit: 0 });
  if (cgst > 0)        lines.push({ ledgerAccountId: cgstOut.ledger_id,     debit: cgst, credit: 0 });
  if (sgst > 0)        lines.push({ ledgerAccountId: sgstOut.ledger_id,     debit: sgst, credit: 0 });
  if (igst > 0)        lines.push({ ledgerAccountId: igstOut.ledger_id,     debit: igst, credit: 0 });
  if (cess > 0) {
    const cessLedger = cessOut || igstOut;
    lines.push({ ledgerAccountId: cessLedger.ledger_id, debit: cess, credit: 0 });
  }
  if (roundOff > 0) lines.push({ ledgerAccountId: roundOf.ledger_id, debit: roundOff, credit: 0 });
  else if (roundOff < 0) lines.push({ ledgerAccountId: roundOf.ledger_id, debit: 0, credit: -roundOff });

  const refundAmount = r2(ret.refund_amount);
  const vouchers = [];

  if (!isCashCustomer) {
    const partyLedger = await getPartyLedger(customer, t);
    if (!partyLedger) {
      throw new Error(`buildSalesReturnVouchers: customer #${customer.party_id} has no ledger account`);
    }
    lines.push({ ledgerAccountId: partyLedger.ledger_id, debit: 0, credit: totalAmount, partyId: customer.party_id });

    vouchers.push({
      voucherType: 'Journal',
      sourceType:  'sales_return_bill',
      sourceId:    ret.sales_return_id,
      voucherDate: ret.return_date,
      referenceNumber: ret.return_number,
      lines,
      narration: `Sales return from ${customer.party_name}`,
    });

    // CRIT-3 fix: if cash was handed back to the customer, post a separate
    // refund-payment journal so the Cash ledger is credited.
    // DR Customer (reduces what we owe them) / CR Cash/Bank (money out).
    //
    // Audit MONEY-3 — honor ret.bank_ledger_id when set. Refunds via
    // UPI / NEFT / bank transfer credit the chosen bank ledger instead
    // of Cash. NULL bank_ledger_id falls back to Cash (legacy behaviour).
    if (refundAmount > 0) {
      let refundLedger = cash;
      if (ret.bank_ledger_id) {
        const bank = await LedgerAccount.findByPk(ret.bank_ledger_id, { transaction: t });
        if (bank) refundLedger = bank;
      }
      vouchers.push({
        voucherType: 'Payment',
        sourceType:  'sales_return_refund',
        sourceId:    ret.sales_return_id,
        voucherDate: ret.return_date,
        referenceNumber: ret.return_number,
        lines: [
          { ledgerAccountId: partyLedger.ledger_id, debit: refundAmount, credit: 0, partyId: customer.party_id },
          { ledgerAccountId: refundLedger.ledger_id, debit: 0, credit: refundAmount },
        ],
        narration: `Refund paid to ${customer.party_name} against ${ret.return_number} via ${refundLedger.ledger_name}`,
      });
    }
  } else {
    lines.push({ ledgerAccountId: cash.ledger_id, debit: 0, credit: totalAmount });
    vouchers.push({
      voucherType: 'Journal',
      sourceType:  'sales_return_bill',
      sourceId:    ret.sales_return_id,
      voucherDate: ret.return_date,
      referenceNumber: ret.return_number,
      lines,
      narration: 'Cash sales return',
    });
  }

  return vouchers;
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
  const cessIn         = await getOptionalLedger('Cess Input', cache, t);

  const subTotal     = r2(ret.sub_total);
  const discount     = r2(ret.discount_amount);
  const specialDisc  = r2(ret.special_discount);
  const otherCharges = r2(ret.other_charges);
  const freight      = r2(ret.freight_charges);
  const cgst         = r2(ret.cgst_amount);
  const sgst         = r2(ret.sgst_amount);
  const igst         = r2(ret.igst_amount);
  const cess         = r2(ret.cess_amount);
  const roundOff     = r2(ret.round_off);
  const totalAmount  = r2(ret.total_amount);

  const itemDiscountTotal = await sumItemDiscount(ret, PurchaseReturnBillItem, 'purchase_return_id', t);

  const returnCredit = r2(subTotal - itemDiscountTotal - discount - specialDisc + otherCharges + freight);

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
  if (cess > 0) {
    const cessLedger = cessIn || igstIn;
    lines.push({ ledgerAccountId: cessLedger.ledger_id, debit: 0, credit: cess });
  }
  if (roundOff > 0)      lines.push({ ledgerAccountId: roundOf.ledger_id, debit: 0, credit: roundOff });
  else if (roundOff < 0) lines.push({ ledgerAccountId: roundOf.ledger_id, debit: -roundOff, credit: 0 });

  const refundAmount = r2(ret.refund_amount);
  const purchaseVouchers = [{
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

  // CRIT-3 fix (purchase side): when supplier is refunded cash for a purchase
  // return (e.g. they paid us back), post the cash receipt:
  // CR Supplier (reduces what they owe us) / DR Cash (cash received).
  if (refundAmount > 0 && !isCashSupplier) {
    const partyLedger = await getPartyLedger(supplier, t);
    if (partyLedger) {
      // Audit MONEY-3 — honor ret.bank_ledger_id when set so a refund
      // received via bank transfer hits the right bank ledger instead
      // of Cash.
      let refundLedger = cash;
      if (ret.bank_ledger_id) {
        const bank = await LedgerAccount.findByPk(ret.bank_ledger_id, { transaction: t });
        if (bank) refundLedger = bank;
      }
      purchaseVouchers.push({
        voucherType: 'Receipt',
        sourceType:  'purchase_return_refund',
        sourceId:    ret.purchase_return_id,
        voucherDate: ret.return_date,
        referenceNumber: ret.return_number,
        lines: [
          { ledgerAccountId: refundLedger.ledger_id, debit: refundAmount, credit: 0 },
          { ledgerAccountId: partyLedger.ledger_id,  debit: 0, credit: refundAmount, partyId: supplier.party_id },
        ],
        narration: `Refund received from ${supplier.party_name} against ${ret.return_number} via ${refundLedger.ledger_name}`,
      });
    }
  }

  return purchaseVouchers;
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

  // Build cash/bank legs from splits if present, else single from the
  // header's payment_method.
  //
  // Pre-bank-FK history note: the previous version of this loop read
  // `s.payment_method` — but the column on payment_splits is
  // `payment_mode`. That meant every split silently fell through to
  // 'Cash' (the resolver's null-safe default), so multi-method receipts
  // were posting all legs to Cash. Reading the right field here is part
  // of the bank-FK migration: pass the whole split so the resolver can
  // read `payment_mode` AND `bank_ledger_id`.
  // Audit BANK-1 — detect post-dated cheque splits so the leg routes
  // to "Post-Dated Cheques (Receivable/Payable)" holding ledger
  // instead of the bank. Without this, an inward PDC inflates the
  // bank balance immediately, weeks before the cheque physically
  // clears. The contra-voucher to move from holding → Bank is posted
  // by chequeController.clear when the cheque clears.
  const txnDateStr = String(receipt.transaction_date || '').slice(0, 10);
  const isPdcSplit = (s) => {
    if (String(s.payment_mode || '').toLowerCase() !== 'cheque') return false;
    const chequeDateStr = String(s.cheque_date || '').slice(0, 10);
    return chequeDateStr && txnDateStr && chequeDateStr > txnDateStr;
  };
  const splits = Array.isArray(receipt.splits) ? receipt.splits : [];
  const methodLegs = [];
  if (splits.length > 0) {
    for (const s of splits) {
      const amt = r2(s.amount);
      if (amt <= 0) continue;
      const lg = await paymentMethodToLedger(s, cache, t, {
        isPdc: isPdcSplit(s),
        direction: isReceipt ? 'INWARD' : 'OUTWARD',
      });
      methodLegs.push({ ledger: lg, amount: amt });
    }
  } else {
    // Header-mode receipt (no splits): treat the header itself like a
    // single split for PDC detection.
    const lg = await paymentMethodToLedger(receipt, cache, t, {
      isPdc: isPdcSplit(receipt),
      direction: isReceipt ? 'INWARD' : 'OUTWARD',
    });
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
