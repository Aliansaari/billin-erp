#!/usr/bin/env node
// Phase-R1 self-test: Trial Balance + Balance Sheet.
//
// Drives the controllers directly (no HTTP). Assertions tolerate
// pre-existing production data by capturing baseline totals first
// and asserting on deltas, not absolute values, where the metric
// would otherwise be polluted.
//
// Run: node server/scripts/test-phase-r1.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const {
  Party, LedgerAccount, SystemSettings, Product, Category, JournalVoucher,
  SalesBill, PaymentReceipt,
} = require('../models');
const { postVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers, buildPaymentReceiptVouchers } = require('../services/voucherBuilders');
const finReports = require('../controllers/financialReportsController');
const ledgerCtrl = require('../controllers/ledgerController');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__R1_';
const today = new Date().toISOString().slice(0, 10);

// Direct-controller invocation. Returns { status, body }.
function callCtrl(handler, query) {
  return new Promise((resolve, reject) => {
    const req = { query };
    const res = {
      status(c) { this._s = c; return this; },
      json(b)   { resolve({ status: this._s || 200, body: b }); },
    };
    handler(req, res).catch(reject);
  });
}

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_number LIKE '${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM journal_vouchers WHERE voucher_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE product_id IN (SELECT product_id FROM products WHERE product_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM categories WHERE category_name = '${PFX}cat'`);
}

// Sum a ledger's Dr/Cr from a TB response (returns 0 if not present).
function ledgerEntry(tb, ledgerId) {
  return (tb.body.ledgers || []).find((l) => l.ledger_id === ledgerId)
    || { debit: 0, credit: 0 };
}

// Sum a sub-group's total from a Balance Sheet response side.
function subGroupTotal(side, name) {
  const all = [...(side?.sub_groups || []), ...(side?.capital_sub_groups || [])];
  const sg = all.find((s) => s.sub_group === name);
  return sg ? Number(sg.total) : 0;
}

async function main() {
  await preClean();
  await SystemSettings.update({
    gst_enabled: true,
    financial_year_start: '2025-04-01',
    financial_year_end:   '2026-03-31',
  }, { where: { setting_id: 1 } });

  const sales   = await LedgerAccount.findOne({ where: { ledger_name: 'Sales Account' } });
  const cash    = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' } });
  const cgstOut = await LedgerAccount.findOne({ where: { ledger_name: 'CGST Output' } });
  const sgstOut = await LedgerAccount.findOne({ where: { ledger_name: 'SGST Output' } });

  // ── Baseline before fixtures (delta-mode tolerance for prod data) ──
  const baselineTb = await callCtrl(finReports.trialBalance, { to_date: today });
  const baselineBs = await callCtrl(finReports.balanceSheet, { to_date: today });
  // Helper: net Dr for an account in a TB response (Dr − Cr; sign reflects
  // the natural direction). Lets us assert on synthetic deltas without
  // worrying about whether the baseline already pushed the account into
  // the opposite column.
  const netDr = (tb, id) => {
    const r = ledgerEntry(tb, id);
    return Number(r.debit) - Number(r.credit);
  };
  const baseSalesNet = netDr(baselineTb, sales.ledger_id);
  const baseCashNet  = netDr(baselineTb, cash.ledger_id);
  const baseCgstNet  = netDr(baselineTb, cgstOut.ledger_id);
  const baseSgstNet  = netDr(baselineTb, sgstOut.ledger_id);
  const baseDebtors = subGroupTotal(baselineBs.body.assets, 'Sundry Debtors');
  const baseDuties  = subGroupTotal(baselineBs.body.liabilities, 'Duties & Taxes');
  const basePLNet   = baselineBs.body.pl.net;
  const baseStockVal= Number(baselineBs.body.stock_value);

  // ── Test 0: Empty period (to_date before any entries) ──
  const emptyTb = await callCtrl(finReports.trialBalance, { to_date: '1900-01-01' });
  check('Empty period: status 200', emptyTb.status === 200);
  check('Empty period: ledgers empty array',
    Array.isArray(emptyTb.body.ledgers) && emptyTb.body.ledgers.length === 0);
  check('Empty period: totals zero + balanced',
    emptyTb.body.totals.debit === 0
    && emptyTb.body.totals.credit === 0
    && emptyTb.body.totals.balanced === true);

  // ── Build synthetic fixtures ────────────────────────────
  // Customer with Receivable opening — afterCreate posts opening JV
  // (Customer Dr 50,000 / OBE Cr 50,000) dated FY-1.
  const cust = await Party.create({
    party_type: 'Customer', party_name: `${PFX}CustA`, mobile_1: '4500000001',
    opening_balance: 50000, opening_balance_type: 'Receivable',
  });
  await cust.reload();
  const custLg = await LedgerAccount.findByPk(cust.ledger_account_id);

  // Sale on 2025-04-15: Customer Dr 11,800 / Sales Cr 10,000 / CGST 900 / SGST 900
  const t1 = await sequelize.transaction();
  const bill = await SalesBill.create({
    bill_number: `${PFX}SAL-1`, bill_date: '2025-04-15',
    customer_id: cust.party_id,
    sub_total: 10000, cgst_amount: 900, sgst_amount: 900,
    cgst_pct: 9, sgst_pct: 9, igst_pct: 0,
    total_amount: 11800, balance_amount: 11800, payment_status: 'Unpaid',
    payment_method: 'Cash',
  }, { transaction: t1 });
  const billRef = await SalesBill.findByPk(bill.sales_bill_id, {
    include: [{ model: Party, as: 'customer' }], transaction: t1,
  });
  for (const v of await buildSalesBillVouchers(billRef, { transaction: t1 })) {
    await postVoucher({ ...v, transaction: t1 });
  }
  await t1.commit();

  // Receipt of ₹5,000 from same customer on 2025-04-20.
  const t2 = await sequelize.transaction();
  const rcpt = await PaymentReceipt.create({
    transaction_number: `${PFX}RCT-1`, transaction_type: 'Receipt',
    transaction_date: '2025-04-20', party_id: cust.party_id,
    total_amount: 5000, payment_method: 'Cash',
  }, { transaction: t2 });
  const rcptRef = await PaymentReceipt.findByPk(rcpt.transaction_id, {
    include: [{ model: Party, as: 'party' }], transaction: t2,
  });
  for (const v of await buildPaymentReceiptVouchers(rcptRef, { transaction: t2 })) {
    await postVoucher({ ...v, transaction: t2 });
  }
  await t2.commit();

  // ── Test 1: Trial Balance covering FY 2025-26 ──────────
  const fyTb = await callCtrl(finReports.trialBalance, { to_date: '2026-03-31' });
  check('FY TB: status 200', fyTb.status === 200);
  check('FY TB: balanced (Σ Dr = Σ Cr)', fyTb.body.totals.balanced === true,
    `dr=${fyTb.body.totals.debit} cr=${fyTb.body.totals.credit}`);
  check('FY TB: difference = 0', fyTb.body.totals.difference === 0);
  check('FY TB: ledgers list non-empty', fyTb.body.ledgers.length > 0);

  // Customer ledger absolute (synthetic fixture, isolated):
  //   Opening 50,000 Dr + Sale 11,800 Dr − Receipt 5,000 Cr = 56,800 Dr
  const tbCust = ledgerEntry(fyTb, custLg.ledger_id);
  check('FY TB: customer present', tbCust.debit > 0 || tbCust.credit > 0);
  check('FY TB: customer Dr = 56,800',
    Math.abs(tbCust.debit - 56800) < 0.01,
    `dr=${tbCust.debit}`);

  // Delta-mode assertions on the NET Dr direction — tolerates whichever
  // side the prod-data baseline sat on.
  //   Sales is income → synthetic Sale 10K Cr → Δnet = −10,000.
  //   Cash → synthetic Receipt 5K Dr → Δnet = +5,000.
  //   CGST/SGST Output (liability) → synthetic 900 Cr → Δnet = −900.
  const dSales = netDr(fyTb, sales.ledger_id) - baseSalesNet;
  check('FY TB: Sales account Δnet = −10,000 (10K Cr added)',
    Math.abs(dSales - (-10000)) < 0.01, `delta=${dSales}`);
  const dCash = netDr(fyTb, cash.ledger_id) - baseCashNet;
  check('FY TB: Cash Δnet = +5,000 (5K Dr added)',
    Math.abs(dCash - 5000) < 0.01, `delta=${dCash}`);
  const dCgst = netDr(fyTb, cgstOut.ledger_id) - baseCgstNet;
  check('FY TB: CGST Output Δnet = −900',
    Math.abs(dCgst - (-900)) < 0.01, `delta=${dCgst}`);
  const dSgst = netDr(fyTb, sgstOut.ledger_id) - baseSgstNet;
  check('FY TB: SGST Output Δnet = −900',
    Math.abs(dSgst - (-900)) < 0.01, `delta=${dSgst}`);

  // Drilldown link shape.
  check('FY TB: party ledger row exposes party_id', tbCust && tbCust.party_id === cust.party_id);
  check('FY TB: party ledger row marked is_party_ledger', tbCust.is_party_ledger === true);
  const tbSalesRow = ledgerEntry(fyTb, sales.ledger_id);
  check('FY TB: system ledger row NOT marked is_party_ledger',
    tbSalesRow.is_party_ledger === false);

  // ── Test 2: Reconciliation against /api/ledger/integrity ──
  // Note: TB totals (per-account net Dr / net Cr) are NOT the same metric
  // as integrity Active raw debits / credits — integrity sums the raw
  // debit and credit columns; TB nets opposing entries within an account.
  // What we CAN reconcile is balanced-ness: both reports should be
  // balanced (Dr=Cr) on the same dataset, AND TB.totalDr should equal
  // TB.totalCr to the paisa.
  const tbToday = await callCtrl(finReports.trialBalance, { to_date: today });
  const integ = await callCtrl(ledgerCtrl.integrity, {});
  check('Integrity API: stock section present',
    !!integ.body.stock && typeof integ.body.stock.drifted_count === 'number');
  check('Reconciliation: Integrity Active is balanced',
    integ.body.totals.active.balanced === true);
  check('Reconciliation: TB(today) is balanced (Σ net Dr = Σ net Cr)',
    tbToday.body.totals.balanced === true,
    `dr=${tbToday.body.totals.debit} cr=${tbToday.body.totals.credit}`);
  check('Reconciliation: TB(today) ≤ Integrity Active raw (nets contract volume)',
    tbToday.body.totals.debit <= integ.body.totals.active.debits + 0.01);

  // ── Test 3: Negative-balance ledger (Cr-opening customer) ──
  const cust2 = await Party.create({
    party_type: 'Customer', party_name: `${PFX}CustCr`, mobile_1: '4500000002',
    opening_balance: 8000, opening_balance_type: 'Payable',
  });
  await cust2.reload();
  const cust2Lg = await LedgerAccount.findByPk(cust2.ledger_account_id);
  const fyTb2 = await callCtrl(finReports.trialBalance, { to_date: '2026-03-31' });
  const tbCust2 = ledgerEntry(fyTb2, cust2Lg.ledger_id);
  check('Cr-opening customer: shows Cr 8,000',
    tbCust2.credit === 8000 && tbCust2.debit === 0);

  // ── Test 4: Balance Sheet — identity + structure ────────
  const bs = await callCtrl(finReports.balanceSheet, { to_date: '2026-03-31' });
  check('BS: status 200', bs.status === 200);
  check('BS: balanced (Σ Assets = Σ Liab incl. P/L)',
    bs.body.totals.balanced === true,
    `assets=${bs.body.totals.total_assets} liab=${bs.body.totals.total_liabilities}`);
  check('BS: difference = 0', bs.body.totals.difference === 0);

  // P&L delta from baseline: Sales 10,000 income, no expenses.
  const bsToday = await callCtrl(finReports.balanceSheet, { to_date: today });
  check('BS: P&L income ΔTo today ≥ 10,000',
    bsToday.body.pl.income - baselineBs.body.pl.income >= 10000 - 0.01);
  check('BS: Net Profit/Loss flow correct',
    (bsToday.body.pl.net >= 0
      && bsToday.body.liabilities.net_profit === bsToday.body.pl.net
      && bsToday.body.assets.net_loss === 0)
    || (bsToday.body.pl.net < 0
      && bsToday.body.assets.net_loss === -bsToday.body.pl.net
      && bsToday.body.liabilities.net_profit === 0));

  // Sub-group deltas vs baseline.
  const dDuties = subGroupTotal(bsToday.body.liabilities, 'Duties & Taxes') - baseDuties;
  check('BS: Duties & Taxes (Liab) Δ ≥ 1,800 (CGST+SGST output from sale)',
    dDuties >= 1800 - 0.01, `delta=${dDuties}`);
  const dDebtors = subGroupTotal(bsToday.body.assets, 'Sundry Debtors') - baseDebtors;
  check('BS: Sundry Debtors (Assets) Δ matches synthetic fixtures',
    Math.abs(dDebtors - (56800 - 8000)) < 0.01,
    `delta=${dDebtors}`);

  // Cash-in-Hand: synthetic adds 5,000 (receipt). Baseline can have any
  // sign (prod data may have net Cr cash). Assert the delta on the
  // signed sub-group total moves +5,000 in the Dr direction.
  const baseCash = subGroupTotal(baselineBs.body.assets, 'Cash-in-Hand');
  const nowCash  = subGroupTotal(bsToday.body.assets, 'Cash-in-Hand');
  check('BS: Cash-in-Hand (Assets) Δ = +5,000 (receipt)',
    Math.abs((nowCash - baseCash) - 5000) < 0.01, `delta=${nowCash - baseCash}`);

  // ── Test 5: Stock Value tile ────────────────────────────
  const cat = await Category.create({ category_name: `${PFX}cat` });
  await Product.create({
    product_name: `${PFX}Prod1`,
    barcode: `R1-${Date.now()}`.slice(0, 20),
    category_id: cat.category_id,
    opening_stock: 100, current_stock: 100,
    purchase_rate: 50, sale_rate: 75,
  });
  const bs2 = await callCtrl(finReports.balanceSheet, { to_date: today });
  check('BS: stock_value tile reflects new product (+₹5,000)',
    Math.abs(bs2.body.stock_value - baseStockVal - 5000) < 0.01);

  // ── Test 6: As-of date BEFORE any entries → opening-only ─
  const earlyBs = await callCtrl(finReports.balanceSheet, { to_date: '1900-01-01' });
  check('Pre-history BS: status 200', earlyBs.status === 200);
  check('Pre-history BS: P&L net = 0 (nothing posted yet)',
    earlyBs.body.pl.income === 0 && earlyBs.body.pl.expense === 0
    && earlyBs.body.pl.net === 0);
  check('Pre-history BS: zero asset / zero liability totals',
    earlyBs.body.totals.total_assets === 0 && earlyBs.body.totals.total_liabilities === 0);

  // ── Test 7: Pre-FY range → empty TB ────────────────────
  const preFyTb = await callCtrl(finReports.trialBalance, { to_date: '1999-12-31' });
  check('Pre-history TB: empty + balanced',
    preFyTb.body.ledgers.length === 0 && preFyTb.body.totals.balanced);

  // ── Test 8: Forced loss → flows to Assets side ─────────
  const t3 = await sequelize.transaction();
  const dAllowed = await LedgerAccount.findOne({ where: { ledger_name: 'Discount Allowed' }, transaction: t3 });
  const jv = await JournalVoucher.create({
    voucher_number: `${PFX}JV-LOSS`, voucher_date: '2025-05-01',
    narration: `${PFX}forced loss`, total_amount: 2000000, is_reversed: false,
  }, { transaction: t3 });
  // Make the discount big enough to overwhelm any baseline profit and
  // force the BS into Net Loss territory regardless of prod data.
  await postVoucher({
    voucherType: 'Journal', sourceType: 'journal_voucher',
    sourceId: jv.id, voucherDate: '2025-05-01',
    referenceNumber: jv.voucher_number,
    lines: [
      { ledgerAccountId: dAllowed.ledger_id, debit: 2000000, credit: 0 },
      { ledgerAccountId: custLg.ledger_id,   debit: 0, credit: 2000000, partyId: cust.party_id },
    ],
    narration: `${PFX}forced loss`, transaction: t3,
  });
  await t3.commit();
  const bsLoss = await callCtrl(finReports.balanceSheet, { to_date: today });
  check('Loss BS: net is negative', bsLoss.body.pl.net < 0);
  check('Loss BS: net_loss on Assets side, no profit on Liab',
    bsLoss.body.assets.net_loss > 0
    && bsLoss.body.liabilities.net_profit === 0);
  check('Loss BS: still balanced', bsLoss.body.totals.balanced === true);

  // ── Cleanup ──
  await preClean();
  await SystemSettings.update({
    financial_year_start: '2026-04-01', financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase R1 Self-Test (Trial Balance + Balance Sheet) ────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
