#!/usr/bin/env node
// Phase-5 self-test: Tally import orchestrator end-to-end on a synthetic
// XML file. Exercises parse → mapping → validate/preview → commit, plus
// re-import diff detection (skip/update) and the GST-disabled flow.
//
// Run with: node server/scripts/test-phase5.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  sequelize, ImportJob, ImportBatch, Party, SalesBill, PurchaseBill,
  PaymentReceipt, LedgerEntry, SystemSettings, LedgerAccount,
} = require('../models');
const orchestrator = require('../services/tallyImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P5_';

// Minimal but valid Tally export XML covering 2 sales, 1 purchase,
// 1 receipt, 1 payment, 4 ledgers (2 customer + 2 supplier), 1 stock item.
function buildTallyXml(opts = {}) {
  const overrides = opts.overrides || {};
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE>
  <LEDGER NAME="${PFX}Customer A"><NAME>${PFX}Customer A</NAME><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>27ABCDE1234F1Z5</PARTYGSTIN><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <LEDGER NAME="${PFX}Customer B"><NAME>${PFX}Customer B</NAME><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>5000</OPENINGBALANCE></LEDGER>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <LEDGER NAME="${PFX}Supplier X"><NAME>${PFX}Supplier X</NAME><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>-3000</OPENINGBALANCE></LEDGER>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <STOCKITEM NAME="${PFX}Widget"><NAME>${PFX}Widget</NAME><BASEUNITS>Pcs</BASEUNITS><GSTRATE>18</GSTRATE><OPENINGBALANCE>0</OPENINGBALANCE></STOCKITEM>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <VOUCHER VCHTYPE="Sales" ACTION="Create">
    <DATE>20260415</DATE>
    <VOUCHERNUMBER>${PFX}SAL-001</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${PFX}Customer A</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Customer A</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${PFX}Widget</STOCKITEMNAME><ACTUALQTY>10 Pcs</ACTUALQTY><RATE>1000/Pcs</RATE><AMOUNT>-10000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <VOUCHER VCHTYPE="Sales" ACTION="Create">
    <DATE>20260416</DATE>
    <VOUCHERNUMBER>${PFX}SAL-002</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${PFX}Customer B</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Customer B</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${overrides.sal2_total || '5900.00'}</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${overrides.sal2_taxable || '-5000.00'}</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${overrides.sal2_cgst || '-450.00'}</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${overrides.sal2_sgst || '-450.00'}</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <VOUCHER VCHTYPE="Purchase" ACTION="Create">
    <DATE>20260417</DATE>
    <VOUCHERNUMBER>${PFX}PUR-001</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${PFX}Supplier X</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Supplier X</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-7080.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase A/c</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>6000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Input</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>540.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Input</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>540.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <VOUCHER VCHTYPE="Receipt" ACTION="Create">
    <DATE>20260418</DATE>
    <VOUCHERNUMBER>${PFX}RCT-001</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${PFX}Customer A</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Customer A</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <VOUCHER VCHTYPE="Payment" ACTION="Create">
    <DATE>20260419</DATE>
    <VOUCHERNUMBER>${PFX}PMT-001</VOUCHERNUMBER>
    <PARTYLEDGERNAME>${PFX}Supplier X</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Supplier X</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE>
${opts.includeStockJournal ? `<TALLYMESSAGE>
  <VOUCHER VCHTYPE="Stock Journal" ACTION="Create">
    <DATE>20260420</DATE>
    <VOUCHERNUMBER>${PFX}STK-001</VOUCHERNUMBER>
  </VOUCHER>
</TALLYMESSAGE>` : ''}
</REQUESTDATA></IMPORTDATA></BODY>
</ENVELOPE>`;
}

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%'`);
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function writeTempXml(content) {
  const p = path.join(os.tmpdir(), `phase5-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// Drive the orchestrator manually (no worker poll loop needed for the test).
async function runUntilTerminal(job, maxIterations = 8) {
  for (let i = 0; i < maxIterations; i++) {
    await orchestrator.run(job);
    await job.reload();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return;
    if (job.status === 'awaiting_confirmation') {
      // Auto-confirm: accept all suggestions, no opt-outs.
      const profile = { ...(job.profile_json || {}), user_choices: { confirmed: true } };
      // If a mapping is needed, supply user choices for low-confidence rows.
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

async function main() {
  await preClean();
  await SystemSettings.update({ gst_enabled: true }, { where: { setting_id: 1 } });

  // ── Test 1: First import — fresh data ──────────────────
  const xml1 = buildTallyXml();
  const file1 = await writeTempXml(xml1);
  const job1 = await ImportJob.create({
    source: 'tally', status: 'queued',
    input_file_path: file1,
    profile_json: { tag: PFX, gst_enabled: true },
  });
  await runUntilTerminal(job1);
  await job1.reload();
  check('Tally import: first run reaches done', job1.status === 'done',
    `status=${job1.status} err=${job1.error_message}`);
  check('Tally import: progress=100', job1.progress_pct === 100);

  const summary1 = job1.result_summary_json || {};
  check('Tally import: posted ≥ 5 vouchers',
    (summary1.posted || 0) >= 5, `posted=${summary1.posted}`);

  // Verify rows landed
  const sal1 = await SalesBill.findOne({ where: { bill_number: `${PFX}SAL-001` } });
  check('Sales bill 1 created', !!sal1);
  check('Sales bill 1 total = 11,800', sal1 && Math.abs(Number(sal1.total_amount) - 11800) < 0.01);
  const pur1 = await PurchaseBill.findOne({ where: { bill_number: `${PFX}PUR-001` } });
  check('Purchase bill 1 created', !!pur1);
  check('Purchase bill 1 total = 7,080', pur1 && Math.abs(Number(pur1.total_amount) - 7080) < 0.01);
  const rct1 = await PaymentReceipt.findOne({ where: { transaction_number: `${PFX}RCT-001` } });
  check('Receipt created', !!rct1);

  // Verify ledger entries posted via Posting Service
  const sal1Entries = await LedgerEntry.findAll({ where: { source_type: 'sales_bill', reference_id: sal1.sales_bill_id } });
  check('Sales bill 1 has 4 ledger entries (Cust Dr, Sales Cr, CGST Cr, SGST Cr)', sal1Entries.length === 4);
  const sal1Dr = sal1Entries.reduce((s, e) => s + Number(e.debit_amount), 0);
  const sal1Cr = sal1Entries.reduce((s, e) => s + Number(e.credit_amount), 0);
  check('Sales bill 1 ledger balanced (Dr=Cr=11,800)', sal1Dr === 11800 && sal1Cr === 11800);

  // Customer with opening_balance=5000 should have a party_opening JV via afterCreate hook
  const custB = await Party.findOne({ where: { party_name: `${PFX}Customer B` } });
  const custBOpening = await LedgerEntry.findAll({
    where: { source_type: 'party_opening', reference_id: custB.party_id },
  });
  check('Customer B opening JV posted (₹5,000 from Tally OPENINGBALANCE)',
    custBOpening.length === 2 && custBOpening.reduce((s, e) => s + Number(e.debit_amount), 0) === 5000);

  // ── Test 2: Re-import unchanged → all skip ─────────────
  const file2 = await writeTempXml(xml1);  // same XML
  const job2 = await ImportJob.create({
    source: 'tally', status: 'queued',
    input_file_path: file2,
    profile_json: { tag: PFX, gst_enabled: true },
  });
  await runUntilTerminal(job2);
  await job2.reload();
  check('Re-import unchanged: status=done', job2.status === 'done');
  check('Re-import unchanged: 0 posted, all skipped',
    (job2.result_summary_json.posted || 0) === 0 &&
    (job2.result_summary_json.skipped || 0) >= 5,
    `summary=${JSON.stringify(job2.result_summary_json)}`);

  // ── Test 3: Re-import with one sale changed → update ──
  const xml3 = buildTallyXml({ overrides: {
    sal2_total: '7080.00', sal2_taxable: '-6000.00', sal2_cgst: '-540.00', sal2_sgst: '-540.00',
  }});
  const file3 = await writeTempXml(xml3);
  const job3 = await ImportJob.create({
    source: 'tally', status: 'queued',
    input_file_path: file3,
    profile_json: { tag: PFX, gst_enabled: true },
  });
  await runUntilTerminal(job3);
  await job3.reload();
  check('Re-import with diff: status=done', job3.status === 'done');
  check('Re-import with diff: 1 voucher updated',
    (job3.result_summary_json.posted || 0) === 1,
    `summary=${JSON.stringify(job3.result_summary_json)}`);

  const sal2 = await SalesBill.findOne({ where: { bill_number: `${PFX}SAL-002` } });
  check('Updated sale 2 total = 7,080', sal2 && Math.abs(Number(sal2.total_amount) - 7080) < 0.01);

  // Ledger should have reversal pair + new entries — net Dr=Cr
  const sal2All = await LedgerEntry.findAll({ where: { source_type: 'sales_bill', reference_id: sal2.sales_bill_id } });
  const sal2Dr = sal2All.reduce((s, e) => s + Number(e.debit_amount), 0);
  const sal2Cr = sal2All.reduce((s, e) => s + Number(e.credit_amount), 0);
  check('Sale 2 after update: ledger balanced (audit trail preserved)', sal2Dr === sal2Cr);

  // ── Test 4: Stock Journal rejection ────────────────────
  const xml4 = buildTallyXml({ includeStockJournal: true });
  const file4 = await writeTempXml(xml4);
  const job4 = await ImportJob.create({
    source: 'tally', status: 'queued',
    input_file_path: file4,
    profile_json: { tag: PFX, gst_enabled: true },
  });
  await runUntilTerminal(job4);
  await job4.reload();
  const summary4 = job4.result_summary_json || {};
  check('Stock Journal voucher rejected', (summary4.rejected || 0) >= 1);
  check('Rejected-rows Excel generated', !!job4.rejected_rows_path && fs.existsSync(job4.rejected_rows_path));

  // ── Test 5: GST-disabled flow ──────────────────────────
  // Wipe everything we just created to start clean for this scenario.
  await preClean();
  await SystemSettings.update({ gst_enabled: false }, { where: { setting_id: 1 } });

  const xml5 = buildTallyXml();
  const file5 = await writeTempXml(xml5);
  const job5 = await ImportJob.create({
    source: 'tally', status: 'queued',
    input_file_path: file5,
    profile_json: { tag: PFX, gst_enabled: false },
  });
  await runUntilTerminal(job5);
  await job5.reload();
  check('GST-off import: status=done', job5.status === 'done',
    `status=${job5.status} err=${job5.error_message}`);
  const sal1g = await SalesBill.findOne({ where: { bill_number: `${PFX}SAL-001` } });
  if (sal1g) {
    const sal1gEntries = await LedgerEntry.findAll({ where: { source_type: 'sales_bill', reference_id: sal1g.sales_bill_id } });
    const cgstOut = await LedgerAccount.findOne({ where: { ledger_name: 'CGST Output' } });
    const cgstHits = sal1gEntries.filter((e) => e.ledger_id === cgstOut.ledger_id);
    check('GST-off: zero CGST entries (tax merged into sales)', cgstHits.length === 0);
    const drSum = sal1gEntries.reduce((s, e) => s + Number(e.debit_amount), 0);
    const crSum = sal1gEntries.reduce((s, e) => s + Number(e.credit_amount), 0);
    check('GST-off: sales bill ledger balanced', drSum === crSum && drSum === 11800);
  } else {
    check('GST-off: sales bill present after import', false);
  }

  // ── Cleanup ──
  await preClean();
  await SystemSettings.update({ gst_enabled: true }, { where: { setting_id: 1 } });
  // Remove tmp xml files
  for (const f of [file1, file2, file3, file4, file5]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  console.log('\n── Phase 5 Self-Test ──────────────────────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
