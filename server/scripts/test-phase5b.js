#!/usr/bin/env node
// Phase-5b self-test: Tally Credit Note / Debit Note / Contra / Tally
// Journal vouchers wired through the orchestrator's posting mapping.
//
// Each test imports a synthetic XML containing exactly one of the four
// types (plus the masters required to resolve party legs) and confirms:
//   • The right source row landed (sales_return_bill / purchase_return_bill /
//     journal_voucher).
//   • ledger_entries has the expected source_type and voucher_type.
//   • Dr legs sum to Cr legs (always the cardinal invariant).
//
// Run with: node server/scripts/test-phase5b.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  sequelize, ImportJob, Party, SalesBill, PurchaseBill,
  SalesReturnBill, PurchaseReturnBill, JournalVoucher,
  LedgerEntry, LedgerAccount, SystemSettings,
} = require('../models');
const orchestrator = require('../services/tallyImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P5B_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM journal_vouchers WHERE voucher_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_return_bill_items WHERE sales_return_id IN (SELECT sales_return_id FROM sales_return_bills WHERE return_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_return_bills WHERE return_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_return_bill_items WHERE purchase_return_id IN (SELECT purchase_return_id FROM purchase_return_bills WHERE return_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_return_bills WHERE return_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE reference_number LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function writeXml(content) {
  const p = path.join(os.tmpdir(), `phase5b-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

async function runUntilTerminal(job, maxIterations = 8) {
  for (let i = 0; i < maxIterations; i++) {
    await orchestrator.run(job);
    await job.reload();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return;
    if (job.status === 'awaiting_confirmation') {
      const profile = { ...(job.profile_json || {}), user_choices: { confirmed: true } };
      if (job.mapping_json && Array.isArray(job.mapping_json.needs_review)) {
        profile.user_choices.mappings = job.mapping_json.needs_review.map((s) => ({
          tally_ledger_name: s.tally_ledger_name,
          mapped_ledger_account_id: s.suggested_ledger_id,
        }));
      }
      await job.update({ status: 'queued', profile_json: profile });
    }
  }
}

// Build a minimal Tally export wrapping a single voucher block. Masters
// (the 1-2 LEDGERS each test needs) are included.
function envelope(masters, voucherBody) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDATA>
${masters.map((m) => `<TALLYMESSAGE>${m}</TALLYMESSAGE>`).join('\n')}
<TALLYMESSAGE>${voucherBody}</TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

async function main() {
  await preClean();
  await SystemSettings.update({ gst_enabled: true }, { where: { setting_id: 1 } });

  // ── Test 1: Credit Note → sales_return_bill ────────────
  // Customer A returns half a ₹11,800 sale = ₹5,900.
  const xml1 = envelope([
    `<LEDGER NAME="${PFX}CustA"><NAME>${PFX}CustA</NAME><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>`,
  ], `<VOUCHER VCHTYPE="Credit Note" ACTION="Create">
    <DATE>20260420</DATE>
    <VOUCHERNUMBER>${PFX}CN-001</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${PFX}CustA</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}CustA</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-5900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Return</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>450.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>450.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>`);
  const file1 = await writeXml(xml1);
  const j1 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file1, profile_json: { tag: PFX, gst_enabled: true } });
  await runUntilTerminal(j1);
  await j1.reload();
  check('Credit Note: status=done', j1.status === 'done', `err=${j1.error_message}`);
  check('Credit Note: 1 voucher posted', (j1.result_summary_json || {}).posted === 1);
  const ret = await SalesReturnBill.findOne({ where: { return_number: `${PFX}CN-001` } });
  check('Credit Note: sales_return_bill row created', !!ret);
  check('Credit Note: total = 5,900', ret && Math.abs(Number(ret.total_amount) - 5900) < 0.01);
  if (ret) {
    const e = await LedgerEntry.findAll({ where: { source_type: 'sales_return_bill', reference_id: ret.sales_return_id } });
    check('Credit Note: ledger_entries source_type=sales_return_bill', e.length >= 4);
    check('Credit Note: voucher_type=Journal',
      e.length > 0 && e.every((x) => x.voucher_type === 'Journal'));
    const dr = e.reduce((s, x) => s + Number(x.debit_amount), 0);
    const cr = e.reduce((s, x) => s + Number(x.credit_amount), 0);
    check('Credit Note: balanced (Dr=Cr=5,900)', dr === 5900 && cr === 5900);
    const salesRet = await LedgerAccount.findOne({ where: { ledger_name: 'Sales Return' } });
    check('Credit Note: Sales Return Dr 5,000',
      e.some((x) => x.ledger_id === salesRet.ledger_id && Number(x.debit_amount) === 5000));
  }

  // ── Test 2: Debit Note → purchase_return_bill ──────────
  await preClean();
  const xml2 = envelope([
    `<LEDGER NAME="${PFX}SupX"><NAME>${PFX}SupX</NAME><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>`,
  ], `<VOUCHER VCHTYPE="Debit Note" ACTION="Create">
    <DATE>20260421</DATE>
    <VOUCHERNUMBER>${PFX}DN-001</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${PFX}SupX</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}SupX</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>3540.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase Return</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-3000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Input</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-270.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Input</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-270.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>`);
  const file2 = await writeXml(xml2);
  const j2 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file2, profile_json: { tag: PFX, gst_enabled: true } });
  await runUntilTerminal(j2);
  await j2.reload();
  check('Debit Note: status=done', j2.status === 'done', `err=${j2.error_message}`);
  const pret = await PurchaseReturnBill.findOne({ where: { return_number: `${PFX}DN-001` } });
  check('Debit Note: purchase_return_bill row created', !!pret);
  check('Debit Note: total = 3,540', pret && Math.abs(Number(pret.total_amount) - 3540) < 0.01);
  if (pret) {
    const e = await LedgerEntry.findAll({ where: { source_type: 'purchase_return_bill', reference_id: pret.purchase_return_id } });
    check('Debit Note: ledger_entries source_type=purchase_return_bill', e.length >= 4);
    check('Debit Note: voucher_type=Journal',
      e.length > 0 && e.every((x) => x.voucher_type === 'Journal'));
    const dr = e.reduce((s, x) => s + Number(x.debit_amount), 0);
    const cr = e.reduce((s, x) => s + Number(x.credit_amount), 0);
    check('Debit Note: balanced (Dr=Cr=3,540)', dr === 3540 && cr === 3540);
    const purchRet = await LedgerAccount.findOne({ where: { ledger_name: 'Purchase Return' } });
    check('Debit Note: Purchase Return Cr 3,000',
      e.some((x) => x.ledger_id === purchRet.ledger_id && Number(x.credit_amount) === 3000));
  }

  // ── Test 3: Contra (Cash → Bank) ───────────────────────
  await preClean();
  const xml3 = envelope([], `<VOUCHER VCHTYPE="Contra" ACTION="Create">
    <DATE>20260422</DATE>
    <VOUCHERNUMBER>${PFX}CON-001</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank Account</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>`);
  const file3 = await writeXml(xml3);
  const j3 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file3, profile_json: { tag: PFX, gst_enabled: true } });
  await runUntilTerminal(j3);
  await j3.reload();
  check('Contra: status=done', j3.status === 'done', `err=${j3.error_message}`);
  const jvCon = await JournalVoucher.findOne({ where: { voucher_number: `${PFX}CON-001` } });
  check('Contra: journal_voucher row created', !!jvCon);
  if (jvCon) {
    const e = await LedgerEntry.findAll({ where: { source_type: 'journal_voucher', reference_id: jvCon.id } });
    check('Contra: 2 ledger_entries', e.length === 2);
    check('Contra: voucher_type=Contra',
      e.length > 0 && e.every((x) => x.voucher_type === 'Contra'));
    const cash = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' } });
    const bank = await LedgerAccount.findOne({ where: { ledger_name: 'Bank Account' } });
    check('Contra: Bank Dr 1,000',
      e.some((x) => x.ledger_id === bank.ledger_id && Number(x.debit_amount) === 1000));
    check('Contra: Cash Cr 1,000',
      e.some((x) => x.ledger_id === cash.ledger_id && Number(x.credit_amount) === 1000));
  }

  // ── Test 4: Tally Journal (Discount Allowed Dr / Customer Cr) ───
  await preClean();
  const xml4 = envelope([
    `<LEDGER NAME="${PFX}CustJ"><NAME>${PFX}CustJ</NAME><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>`,
  ], `<VOUCHER VCHTYPE="Journal" ACTION="Create">
    <DATE>20260423</DATE>
    <VOUCHERNUMBER>${PFX}JV-001</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Discount Allowed</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}CustJ</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>`);
  const file4 = await writeXml(xml4);
  const j4 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file4, profile_json: { tag: PFX, gst_enabled: true } });
  await runUntilTerminal(j4);
  await j4.reload();
  check('Tally Journal: status=done', j4.status === 'done', `err=${j4.error_message}`);
  const jv = await JournalVoucher.findOne({ where: { voucher_number: `${PFX}JV-001` } });
  check('Tally Journal: journal_voucher row created', !!jv);
  if (jv) {
    const e = await LedgerEntry.findAll({ where: { source_type: 'journal_voucher', reference_id: jv.id } });
    check('Tally Journal: 2 ledger_entries', e.length === 2);
    check('Tally Journal: voucher_type=Journal',
      e.length > 0 && e.every((x) => x.voucher_type === 'Journal'));
    const discAllowed = await LedgerAccount.findOne({ where: { ledger_name: 'Discount Allowed' } });
    check('Tally Journal: Discount Allowed Dr 500',
      e.some((x) => x.ledger_id === discAllowed.ledger_id && Number(x.debit_amount) === 500));
    const cust = await Party.findOne({ where: { party_name: `${PFX}CustJ` } });
    if (cust && cust.ledger_account_id) {
      check('Tally Journal: Customer ledger Cr 500',
        e.some((x) => x.ledger_id === cust.ledger_account_id && Number(x.credit_amount) === 500));
    }
  }

  // ── Cleanup ──
  await preClean();
  for (const f of [file1, file2, file3, file4]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  console.log('\n── Phase 5b Self-Test (Credit/Debit/Contra/Journal) ──────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
