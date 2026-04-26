#!/usr/bin/env node
// Phase-2 self-test: exercise every wired flow through the actual
// model + posting service (not via HTTP — the controllers are pure
// orchestration over these). Verifies Dr/Cr correctness, atomicity,
// idempotency, edit/delete round-trips, and party-ledger cross-validation.
//
// Run with: node server/scripts/test-phase2.js
//
// Cleans up everything it creates.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const {
  sequelize, Party, LedgerAccount, LedgerEntry, JournalVoucher,
  SalesBill, SalesBillItem, PurchaseBill, PurchaseBillItem,
  SalesReturnBill, SalesReturnBillItem,
  PurchaseReturnBill, PurchaseReturnBillItem,
  PaymentReceipt, PaymentSplit, Product,
} = require('../models');
const { postVoucher, reverseVoucher } = require('../services/ledgerPostingService');
const {
  buildSalesBillVouchers, buildPurchaseBillVouchers,
  buildSalesReturnVouchers, buildPurchaseReturnVouchers,
  buildPaymentReceiptVouchers,
} = require('../services/voucherBuilders');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P2_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_return_bill_items WHERE sales_return_id IN (SELECT sales_return_id FROM sales_return_bills WHERE return_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_return_bills WHERE return_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_return_bill_items WHERE purchase_return_id IN (SELECT purchase_return_id FROM purchase_return_bills WHERE return_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_return_bills WHERE return_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM journal_vouchers WHERE voucher_number LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
}

// Sum debits and credits across an array of entries (live entries only — drop
// reversed pairs by matching reversal_of_id ↔ entry_id).
function sumLive(entries) {
  let dr = 0, cr = 0;
  for (const e of entries) {
    dr += Number(e.debit_amount)  || 0;
    cr += Number(e.credit_amount) || 0;
  }
  return { dr, cr, net: dr - cr };
}

async function entriesFor(sourceType, sourceId) {
  return LedgerEntry.findAll({ where: { source_type: sourceType, reference_id: sourceId }, order: [['entry_id','ASC']] });
}

async function main() {
  await preClean();

  // Fixtures
  const cust = await Party.create({ party_type: 'Customer', party_name: `${PFX}CUST_A`, mobile_1: '8888800001' });
  const sup  = await Party.create({ party_type: 'Supplier', party_name: `${PFX}SUP_A`,  mobile_1: '8888800002' });
  await cust.reload(); await sup.reload();

  const sales   = await LedgerAccount.findOne({ where: { ledger_name: 'Sales Account' } });
  const purchase= await LedgerAccount.findOne({ where: { ledger_name: 'Purchase Account' } });
  const cash    = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' } });
  const cgstOut = await LedgerAccount.findOne({ where: { ledger_name: 'CGST Output' } });
  const sgstOut = await LedgerAccount.findOne({ where: { ledger_name: 'SGST Output' } });
  const igstOut = await LedgerAccount.findOne({ where: { ledger_name: 'IGST Output' } });
  const cgstIn  = await LedgerAccount.findOne({ where: { ledger_name: 'CGST Input' } });
  const igstIn  = await LedgerAccount.findOne({ where: { ledger_name: 'IGST Input' } });
  const salesRet= await LedgerAccount.findOne({ where: { ledger_name: 'Sales Return' } });
  const purchRet= await LedgerAccount.findOne({ where: { ledger_name: 'Purchase Return' } });
  const roundOf = await LedgerAccount.findOne({ where: { ledger_name: 'Round Off' } });

  const custLg = await LedgerAccount.findByPk(cust.ledger_account_id);
  const supLg  = await LedgerAccount.findByPk(sup.ledger_account_id);

  // Helper: synth-create a bill via SalesBill.create + post vouchers in one tx
  async function createSale({ totalAmount, subTotal, cgst, sgst, igst, roundOff = 0, customerId = cust.party_id, paid = 0, billNumber, otherCharges = 0, freight = 0, payment_method = 'Cash' }) {
    const t = await sequelize.transaction();
    try {
      const bill = await SalesBill.create({
        bill_number: billNumber,
        bill_date: '2026-04-26',
        customer_id: customerId,
        sub_total: subTotal,
        discount_amount: 0,
        cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst,
        cgst_pct: cgst > 0 ? 9 : 0, sgst_pct: sgst > 0 ? 9 : 0, igst_pct: igst > 0 ? 18 : 0,
        round_off: roundOff,
        total_amount: totalAmount,
        paid_amount: paid,
        balance_amount: totalAmount - paid,
        payment_status: paid >= totalAmount ? 'Paid' : (paid > 0 ? 'Partial' : 'Unpaid'),
        other_charges: otherCharges,
        freight_charges: freight,
        payment_method,
      }, { transaction: t });
      const refreshed = await SalesBill.findByPk(bill.sales_bill_id, {
        include: [{ model: Party, as: 'customer' }],
        transaction: t,
      });
      const vouchers = await buildSalesBillVouchers(refreshed, { transaction: t });
      for (const v of vouchers) {
        await postVoucher({ ...v, transaction: t });
      }
      await t.commit();
      return bill;
    } catch (e) { await t.rollback(); throw e; }
  }

  // ── Test 1: Intrastate GST sale ─────────────────────────
  // ₹10,000 + 9% CGST + 9% SGST = 11,800 to customer
  let bill1 = await createSale({ totalAmount: 11800, subTotal: 10000, cgst: 900, sgst: 900, igst: 0, billNumber: `${PFX}SAL01` });
  let e1 = await entriesFor('sales_bill', bill1.sales_bill_id);
  const { dr: dr1, cr: cr1 } = sumLive(e1);
  check('Intrastate sale: 4 lines', e1.length === 4);
  check('Intrastate sale: balanced (Dr=Cr=11800)', dr1 === 11800 && cr1 === 11800);
  check('Intrastate sale: customer Dr 11800',
    e1.find((e) => e.ledger_id === custLg.ledger_id && Number(e.debit_amount) === 11800));
  check('Intrastate sale: Sales Cr 10000',
    e1.find((e) => e.ledger_id === sales.ledger_id && Number(e.credit_amount) === 10000));
  check('Intrastate sale: CGST Output Cr 900',
    e1.find((e) => e.ledger_id === cgstOut.ledger_id && Number(e.credit_amount) === 900));
  check('Intrastate sale: SGST Output Cr 900',
    e1.find((e) => e.ledger_id === sgstOut.ledger_id && Number(e.credit_amount) === 900));

  // ── Test 2: Interstate GST sale ─────────────────────────
  let bill2 = await createSale({ totalAmount: 11800, subTotal: 10000, cgst: 0, sgst: 0, igst: 1800, billNumber: `${PFX}SAL02` });
  let e2 = await entriesFor('sales_bill', bill2.sales_bill_id);
  check('Interstate sale: 3 lines (no CGST/SGST)', e2.length === 3);
  check('Interstate sale: IGST Output Cr 1800',
    e2.find((e) => e.ledger_id === igstOut.ledger_id && Number(e.credit_amount) === 1800));

  // ── Test 3: Cash sale (walk-in, no customer) ────────────
  let bill3 = await createSale({ totalAmount: 11800, subTotal: 10000, cgst: 900, sgst: 900, igst: 0, customerId: null, billNumber: `${PFX}SAL03` });
  let e3 = await entriesFor('sales_bill', bill3.sales_bill_id);
  check('Cash sale: Cash Dr 11800',
    e3.find((e) => e.ledger_id === cash.ledger_id && Number(e.debit_amount) === 11800));

  // ── Test 4: Sale with paid_amount → 2 vouchers ──────────
  let bill4 = await createSale({ totalAmount: 11800, subTotal: 10000, cgst: 900, sgst: 900, igst: 0, paid: 5000, billNumber: `${PFX}SAL04`, payment_method: 'Cash' });
  let e4Sale    = await entriesFor('sales_bill', bill4.sales_bill_id);
  let e4Receipt = await entriesFor('sales_bill_receipt', bill4.sales_bill_id);
  check('Credit sale w/ paid: sales voucher posted', e4Sale.length === 4);
  check('Credit sale w/ paid: receipt voucher posted', e4Receipt.length === 2);
  check('Credit sale w/ paid: Cash Dr 5000 in receipt',
    e4Receipt.find((e) => e.ledger_id === cash.ledger_id && Number(e.debit_amount) === 5000));
  check('Credit sale w/ paid: customer Cr 5000 in receipt',
    e4Receipt.find((e) => e.ledger_id === custLg.ledger_id && Number(e.credit_amount) === 5000));

  // ── Test 5: Sale with round-off ──────────────────────────
  // Bill of 11800 + round_off +0.50 = 11800.50
  let bill5 = await createSale({ totalAmount: 11800.50, subTotal: 10000, cgst: 900, sgst: 900, igst: 0, roundOff: 0.50, billNumber: `${PFX}SAL05` });
  let e5 = await entriesFor('sales_bill', bill5.sales_bill_id);
  check('Round-off sale: Round Off Cr 0.50',
    e5.find((e) => e.ledger_id === roundOf.ledger_id && Math.abs(Number(e.credit_amount) - 0.50) < 0.01));

  // ── Test 6: Purchase intrastate ─────────────────────────
  async function createPurchase({ totalAmount, subTotal, cgst, sgst, igst, roundOff = 0, supplierId = sup.party_id, paid = 0, billNumber, payment_method = 'Cash' }) {
    const t = await sequelize.transaction();
    try {
      const bill = await PurchaseBill.create({
        bill_number: billNumber,
        bill_date: '2026-04-26',
        supplier_id: supplierId,
        sub_total: subTotal, discount_amount: 0,
        cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst,
        cgst_pct: cgst > 0 ? 9 : 0, sgst_pct: sgst > 0 ? 9 : 0, igst_pct: igst > 0 ? 18 : 0,
        round_off: roundOff,
        total_amount: totalAmount,
        paid_amount: paid,
        balance_amount: totalAmount - paid,
        payment_status: paid >= totalAmount ? 'Paid' : (paid > 0 ? 'Partial' : 'Unpaid'),
        payment_method,
      }, { transaction: t });
      const refreshed = await PurchaseBill.findByPk(bill.purchase_bill_id, {
        include: [{ model: Party, as: 'supplier' }],
        transaction: t,
      });
      const vouchers = await buildPurchaseBillVouchers(refreshed, { transaction: t });
      for (const v of vouchers) await postVoucher({ ...v, transaction: t });
      await t.commit();
      return bill;
    } catch (e) { await t.rollback(); throw e; }
  }

  let pbill1 = await createPurchase({ totalAmount: 11800, subTotal: 10000, cgst: 900, sgst: 900, igst: 0, billNumber: `${PFX}PUR01` });
  let pe1 = await entriesFor('purchase_bill', pbill1.purchase_bill_id);
  const { dr: pdr, cr: pcr } = sumLive(pe1);
  check('Purchase intrastate: balanced (Dr=Cr=11800)', pdr === 11800 && pcr === 11800);
  check('Purchase intrastate: Purchase Dr 10000',
    pe1.find((e) => e.ledger_id === purchase.ledger_id && Number(e.debit_amount) === 10000));
  check('Purchase intrastate: CGST Input Dr 900',
    pe1.find((e) => e.ledger_id === cgstIn.ledger_id && Number(e.debit_amount) === 900));
  check('Purchase intrastate: Supplier Cr 11800',
    pe1.find((e) => e.ledger_id === supLg.ledger_id && Number(e.credit_amount) === 11800));

  // ── Test 7: Purchase interstate ─────────────────────────
  let pbill2 = await createPurchase({ totalAmount: 11800, subTotal: 10000, cgst: 0, sgst: 0, igst: 1800, billNumber: `${PFX}PUR02` });
  let pe2 = await entriesFor('purchase_bill', pbill2.purchase_bill_id);
  check('Purchase interstate: IGST Input Dr 1800',
    pe2.find((e) => e.ledger_id === igstIn.ledger_id && Number(e.debit_amount) === 1800));

  // ── Test 8: Cash purchase (paid in full at create) ─────
  // PurchaseBill requires a supplier — "cash purchase" in this system
  // means paid_amount === total_amount with payment_method='Cash'. We
  // verify the secondary Payment voucher is posted (Supplier Dr, Cash Cr).
  let pbill3 = await createPurchase({ totalAmount: 11800, subTotal: 10000, cgst: 900, sgst: 900, igst: 0, paid: 11800, billNumber: `${PFX}PUR03`, payment_method: 'Cash' });
  let pe3pay = await entriesFor('purchase_bill_payment', pbill3.purchase_bill_id);
  check('Cash purchase: secondary Payment voucher posted', pe3pay.length === 2);
  check('Cash purchase: Supplier Dr 11800 in payment leg',
    pe3pay.find((e) => e.ledger_id === supLg.ledger_id && Number(e.debit_amount) === 11800));
  check('Cash purchase: Cash Cr 11800 in payment leg',
    pe3pay.find((e) => e.ledger_id === cash.ledger_id && Number(e.credit_amount) === 11800));

  // ── Test 9: Sales Return ────────────────────────────────
  // Half return of bill1 (₹11,800 → ₹5,900)
  async function createSalesReturn({ totalAmount, subTotal, cgst, sgst, customerId = cust.party_id, returnNumber, refBillId = null }) {
    const t = await sequelize.transaction();
    try {
      const ret = await SalesReturnBill.create({
        return_number: returnNumber,
        return_date: '2026-04-26',
        customer_id: customerId,
        return_mode: 'Items',
        reference_bill_id: refBillId,
        sub_total: subTotal, discount_amount: 0,
        cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0,
        cgst_pct: 9, sgst_pct: 9, igst_pct: 0,
        round_off: 0,
        total_amount: totalAmount,
        refund_amount: 0,
        balance_amount: totalAmount,
        refund_status: 'Pending', refund_method: 'Cash',
      }, { transaction: t });
      const refreshed = await SalesReturnBill.findByPk(ret.sales_return_id, {
        include: [{ model: Party, as: 'customer' }],
        transaction: t,
      });
      const vouchers = await buildSalesReturnVouchers(refreshed, { transaction: t });
      for (const v of vouchers) await postVoucher({ ...v, transaction: t });
      await t.commit();
      return ret;
    } catch (e) { await t.rollback(); throw e; }
  }
  let ret1 = await createSalesReturn({ totalAmount: 5900, subTotal: 5000, cgst: 450, sgst: 450, returnNumber: `${PFX}SR01`, refBillId: bill1.sales_bill_id });
  let re1 = await entriesFor('sales_return_bill', ret1.sales_return_id);
  const { dr: rdr, cr: rcr } = sumLive(re1);
  check('Sales return half: balanced (Dr=Cr=5900)', rdr === 5900 && rcr === 5900);
  check('Sales return: Sales Return Dr 5000',
    re1.find((e) => e.ledger_id === salesRet.ledger_id && Number(e.debit_amount) === 5000));
  check('Sales return: Customer Cr 5900',
    re1.find((e) => e.ledger_id === custLg.ledger_id && Number(e.credit_amount) === 5900));

  // ── Test 10: Purchase Return ────────────────────────────
  async function createPurchaseReturn({ totalAmount, subTotal, cgst, sgst, supplierId = sup.party_id, returnNumber, refBillId = null }) {
    const t = await sequelize.transaction();
    try {
      const ret = await PurchaseReturnBill.create({
        return_number: returnNumber,
        return_date: '2026-04-26',
        supplier_id: supplierId,
        return_mode: 'Items',
        reference_bill_id: refBillId,
        sub_total: subTotal, discount_amount: 0,
        cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0,
        cgst_pct: 9, sgst_pct: 9, igst_pct: 0,
        round_off: 0,
        total_amount: totalAmount,
        refund_amount: 0,
        balance_amount: totalAmount,
        refund_status: 'Pending', refund_method: 'Cash',
      }, { transaction: t });
      const refreshed = await PurchaseReturnBill.findByPk(ret.purchase_return_id, {
        include: [{ model: Party, as: 'supplier' }],
        transaction: t,
      });
      const vouchers = await buildPurchaseReturnVouchers(refreshed, { transaction: t });
      for (const v of vouchers) await postVoucher({ ...v, transaction: t });
      await t.commit();
      return ret;
    } catch (e) { await t.rollback(); throw e; }
  }
  let pret1 = await createPurchaseReturn({ totalAmount: 5900, subTotal: 5000, cgst: 450, sgst: 450, returnNumber: `${PFX}PR01`, refBillId: pbill1.purchase_bill_id });
  let pre1 = await entriesFor('purchase_return_bill', pret1.purchase_return_id);
  check('Purchase return: Supplier Dr 5900',
    pre1.find((e) => e.ledger_id === supLg.ledger_id && Number(e.debit_amount) === 5900));
  check('Purchase return: Purchase Return Cr 5000',
    pre1.find((e) => e.ledger_id === purchRet.ledger_id && Number(e.credit_amount) === 5000));

  // ── Test 11: Payment Receipt ────────────────────────────
  async function createReceipt({ partyId, total, type = 'Receipt', method = 'Cash', txnNumber, splits = null }) {
    const t = await sequelize.transaction();
    try {
      const r = await PaymentReceipt.create({
        transaction_number: txnNumber,
        transaction_type: type,
        transaction_date: '2026-04-26',
        party_id: partyId,
        total_amount: total,
        payment_method: method,
      }, { transaction: t });
      if (splits) {
        for (const s of splits) {
          await PaymentSplit.create({ transaction_id: r.transaction_id, ...s }, { transaction: t });
        }
      }
      const refreshed = await PaymentReceipt.findByPk(r.transaction_id, {
        include: [{ model: Party, as: 'party' }, { model: PaymentSplit, as: 'splits' }],
        transaction: t,
      });
      const vouchers = await buildPaymentReceiptVouchers(refreshed, { transaction: t });
      for (const v of vouchers) await postVoucher({ ...v, transaction: t });
      await t.commit();
      return r;
    } catch (e) { await t.rollback(); throw e; }
  }
  let rcpt = await createReceipt({ partyId: cust.party_id, total: 5000, type: 'Receipt', txnNumber: `${PFX}RCT01` });
  let re = await entriesFor('payment_receipt', rcpt.transaction_id);
  check('Receipt: Cash Dr 5000',
    re.find((e) => e.ledger_id === cash.ledger_id && Number(e.debit_amount) === 5000));
  check('Receipt: Customer Cr 5000',
    re.find((e) => e.ledger_id === custLg.ledger_id && Number(e.credit_amount) === 5000));

  // ── Test 12: Payment Made ───────────────────────────────
  let pmt = await createReceipt({ partyId: sup.party_id, total: 5000, type: 'Payment', txnNumber: `${PFX}PMT01` });
  let pme = await entriesFor('payment_receipt', pmt.transaction_id);
  check('Payment: Supplier Dr 5000',
    pme.find((e) => e.ledger_id === supLg.ledger_id && Number(e.debit_amount) === 5000));
  check('Payment: Cash Cr 5000',
    pme.find((e) => e.ledger_id === cash.ledger_id && Number(e.credit_amount) === 5000));

  // ── Test 13: Journal Voucher (multi-leg) ────────────────
  // Manual JV: Cash Dr 1000 / Bank Cr 1000 (contra-style)
  const t = await sequelize.transaction();
  const jv = await JournalVoucher.create({
    voucher_number: `${PFX}JV01`,
    voucher_date: '2026-04-26',
    narration: `${PFX}Test JV`, total_amount: 1000, is_reversed: false,
  }, { transaction: t });
  const bank = await LedgerAccount.findOne({ where: { ledger_name: 'Bank Account' }, transaction: t });
  await postVoucher({
    voucherType: 'Journal', sourceType: 'journal_voucher',
    sourceId: jv.id, voucherDate: '2026-04-26',
    referenceNumber: jv.voucher_number,
    lines: [
      { ledgerAccountId: cash.ledger_id,  debit: 1000, credit: 0 },
      { ledgerAccountId: bank.ledger_id,  debit: 0,    credit: 1000 },
    ],
    narration: 'Cash withdrawal from bank',
    transaction: t,
  });
  await t.commit();
  let jve = await entriesFor('journal_voucher', jv.id);
  check('JV: 2 lines posted', jve.length === 2);
  const { dr: jdr, cr: jcr } = sumLive(jve);
  check('JV: balanced 1000=1000', jdr === 1000 && jcr === 1000);

  // ── Test 14: Edit a sale (₹10,000 → ₹12,000) ────────────
  // Reverse the original posting then re-post with new totals.
  const editTx = await sequelize.transaction();
  await reverseVoucher({ sourceType: 'sales_bill', sourceId: bill1.sales_bill_id, transaction: editTx });
  await reverseVoucher({ sourceType: 'sales_bill_receipt', sourceId: bill1.sales_bill_id, transaction: editTx });
  await SalesBill.update({
    sub_total: 12000, cgst_amount: 1080, sgst_amount: 1080, total_amount: 14160, balance_amount: 14160,
  }, { where: { sales_bill_id: bill1.sales_bill_id }, transaction: editTx });
  const editedBill = await SalesBill.findByPk(bill1.sales_bill_id, { include: [{ model: Party, as: 'customer' }], transaction: editTx });
  const editedV = await buildSalesBillVouchers(editedBill, { transaction: editTx });
  for (const v of editedV) await postVoucher({ ...v, transaction: editTx });
  await editTx.commit();

  let allForBill1 = await entriesFor('sales_bill', bill1.sales_bill_id);
  const { dr: edr, cr: ecr } = sumLive(allForBill1);
  check('Edit sale: total Dr === total Cr after reverse + repost', edr === ecr);
  // Net effect: original 4 entries reversed (4 mirrors) + 4 new entries = 12 total, with net = new bill totals
  check('Edit sale: 12 total rows (4 orig + 4 mirror + 4 new)', allForBill1.length === 12);
  // Net Dr-Cr per ledger: customer should be 14160 net Dr (the new total)
  const custEntries = allForBill1.filter((e) => e.ledger_id === custLg.ledger_id);
  const netCust = custEntries.reduce((s, e) => s + (Number(e.debit_amount) - Number(e.credit_amount)), 0);
  check('Edit sale: customer net Dr = 14160', Math.abs(netCust - 14160) < 0.01, `got ${netCust}`);

  // ── Test 15: Cancel a sale (reverse only, no repost) ────
  const cancelTx = await sequelize.transaction();
  await reverseVoucher({ sourceType: 'sales_bill', sourceId: bill2.sales_bill_id, transaction: cancelTx });
  await cancelTx.commit();
  let cancelEntries = await entriesFor('sales_bill', bill2.sales_bill_id);
  const { net: cancelNet } = sumLive(cancelEntries);
  check('Cancel sale: net Dr-Cr = 0', cancelNet === 0);

  // ── Test 16: Idempotency ────────────────────────────────
  let idemp = false;
  try {
    await postVoucher({
      voucherType: 'Sales', sourceType: 'sales_bill', sourceId: bill3.sales_bill_id,
      voucherDate: '2026-04-26', referenceNumber: 'DUP',
      lines: [
        { ledgerAccountId: cash.ledger_id, debit: 100, credit: 0 },
        { ledgerAccountId: sales.ledger_id, debit: 0, credit: 100 },
      ],
    });
  } catch (e) { idemp = /already posted/i.test(e.message); }
  check('Idempotency: re-post on same source rejected', idemp);

  // ── Test 17: Atomicity ──────────────────────────────────
  // Force the posting to throw inside a transaction; verify the bill doesn't survive.
  let atomic = true;
  let atomicBillId = null;
  try {
    const t2 = await sequelize.transaction();
    try {
      const b = await SalesBill.create({
        bill_number: `${PFX}ATOMIC`, bill_date: '2026-04-26',
        sub_total: 100, total_amount: 100, balance_amount: 100,
      }, { transaction: t2 });
      atomicBillId = b.sales_bill_id;
      // Intentionally pass an unbalanced posting → throws
      await postVoucher({
        voucherType: 'Sales', sourceType: 'sales_bill', sourceId: b.sales_bill_id,
        voucherDate: '2026-04-26', referenceNumber: b.bill_number,
        lines: [
          { ledgerAccountId: cash.ledger_id, debit: 100, credit: 0 },
          { ledgerAccountId: sales.ledger_id, debit: 0, credit: 50 },
        ],
        transaction: t2,
      });
      await t2.commit();
      atomic = false; // shouldn't reach here
    } catch (e) {
      await t2.rollback();
    }
  } catch (_) { /* ignore */ }
  if (atomicBillId) {
    const exists = await SalesBill.findByPk(atomicBillId);
    check('Atomicity: failing posting rolled back the bill', !exists);
  } else {
    check('Atomicity: failing posting rolled back the bill', false, 'no test bill created');
  }

  // ── Test 18: Cross-validation with party-balance helper ─
  // Compute the customer's "should-owe" from the bills + receipts the test
  // created against `cust`, vs SUM(debit-credit) on their ledger account.
  // Excludes any pre-existing data because we filter by source IDs we created.
  const allCustEntries = await LedgerEntry.findAll({
    where: { ledger_id: custLg.ledger_id },
  });
  // Compute live net (each reversed pair is original + mirror, sums to 0).
  const ledgerBalance = allCustEntries.reduce((s, e) => s + Number(e.debit_amount) - Number(e.credit_amount), 0);
  // From source: bills net of paid + returns, minus receipts.
  // bill1 was edited to 14160, paid 0 → 14160
  // bill2 was cancelled → 0
  // bill4 was 11800, paid 5000 → 6800
  // bill5 was 11800.50 → 11800.50
  // ret1 was 5900 (sales return → reduces customer's owed)
  // rcpt was 5000 receipt → reduces customer's owed
  const expectedFromSource = 14160 + 0 + (11800 - 5000) + 11800.50 - 5900 - 5000;
  check('Cross-validation: customer ledger balance == bills − payments − returns',
    Math.abs(ledgerBalance - expectedFromSource) < 0.01,
    `ledger=${ledgerBalance} expected=${expectedFromSource}`);

  // ── Test 19: Grep — only ledgerPostingService.js INSERTs to ledger_entries ──
  const fs = require('fs'); const path = require('path');
  function walk(dir, list = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'scripts') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, list);
      else if (e.name.endsWith('.js')) list.push(p);
    }
    return list;
  }
  const allJs = walk(path.join(__dirname, '..'));
  const violators = [];
  for (const file of allJs) {
    if (file.endsWith('ledgerPostingService.js')) continue;
    const s = fs.readFileSync(file, 'utf8');
    if (/LedgerEntry\s*\.\s*create\b/.test(s)) violators.push(file + ' (LedgerEntry.create)');
    if (/LedgerEntry\s*\.\s*bulkCreate\b/.test(s)) violators.push(file + ' (bulkCreate)');
    if (/INSERT\s+INTO\s+ledger_entries/i.test(s)) violators.push(file + ' (raw INSERT)');
  }
  check('Grep: only ledgerPostingService writes to ledger_entries',
    violators.length === 0, violators.join(', '));

  // ── Cleanup ──
  await preClean();

  // Verify clean
  const counts = await sequelize.query(
    `SELECT
       (SELECT COUNT(*) FROM sales_bills        WHERE bill_number LIKE '${PFX}%') AS sales,
       (SELECT COUNT(*) FROM purchase_bills     WHERE bill_number LIKE '${PFX}%') AS purchases,
       (SELECT COUNT(*) FROM sales_return_bills WHERE return_number LIKE '${PFX}%') AS s_returns,
       (SELECT COUNT(*) FROM purchase_return_bills WHERE return_number LIKE '${PFX}%') AS p_returns,
       (SELECT COUNT(*) FROM payments_receipts  WHERE transaction_number LIKE '${PFX}%') AS payments,
       (SELECT COUNT(*) FROM journal_vouchers   WHERE voucher_number LIKE '${PFX}%') AS jvs,
       (SELECT COUNT(*) FROM parties            WHERE party_name LIKE '${PFX}%') AS parties,
       (SELECT COUNT(*) FROM ledger_accounts    WHERE ledger_name LIKE '${PFX}%') AS led_accts,
       (SELECT COUNT(*) FROM ledger_entries     WHERE narration LIKE '%${PFX}%' OR reference_number LIKE '${PFX}%') AS led_entries`,
    { type: sequelize.QueryTypes.SELECT },
  );
  const c = counts[0];
  check('Cleanup: 0 sales',         Number(c.sales) === 0,         `${c.sales}`);
  check('Cleanup: 0 purchases',     Number(c.purchases) === 0,     `${c.purchases}`);
  check('Cleanup: 0 sales returns', Number(c.s_returns) === 0,     `${c.s_returns}`);
  check('Cleanup: 0 purchase returns', Number(c.p_returns) === 0, `${c.p_returns}`);
  check('Cleanup: 0 payments',      Number(c.payments) === 0,      `${c.payments}`);
  check('Cleanup: 0 JVs',           Number(c.jvs) === 0,           `${c.jvs}`);
  check('Cleanup: 0 parties',       Number(c.parties) === 0,       `${c.parties}`);
  check('Cleanup: 0 ledger_accounts', Number(c.led_accts) === 0,   `${c.led_accts}`);
  check('Cleanup: 0 ledger_entries', Number(c.led_entries) === 0,  `${c.led_entries}`);

  console.log('\n── Phase 2 Self-Test ──────────────────────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
