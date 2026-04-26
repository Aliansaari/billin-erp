#!/usr/bin/env node
// Phase-5c self-test: Tally cash-sale balance check + FY date guard.
//
// Two bugs from real-data spot-check on the Tally orchestrator:
//   • Cash sales rejected because both Cash AND a "Local Sales 12%" line
//     got summed into the party-leg bucket — leaving only tax in
//     "computed total" so the balance check failed.
//   • Pre-FY-start vouchers slipped into the create bucket instead of
//     being rejected with a clear reason.
//
// Run with: node server/scripts/test-phase5c.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  sequelize, ImportJob, Party, SalesBill, PurchaseBill,
  LedgerEntry, LedgerAccount, SystemSettings,
} = require('../models');
const orchestrator = require('../services/tallyImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P5C_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%'`);
  await sequelize.query(`DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE reference_number LIKE '${PFX}%'`);
  // Stub party + ledger created by the cash-purchase fallback. Cleaned
  // up between runs so the test is idempotent.
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%' OR party_name = 'Cash Purchases'`);
  await sequelize.query(`DELETE FROM ledger_entries WHERE source_type = 'party_opening' AND reference_id IN (SELECT party_id FROM parties WHERE party_name = 'Cash Purchases')`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%' OR party_name = 'Cash Purchases'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)' OR ledger_name = 'Cash Purchases'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function writeXml(content) {
  const p = path.join(os.tmpdir(), `phase5c-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
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

function envelope(masters, voucherBlocks) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDATA>
${masters.map((m) => `<TALLYMESSAGE>${m}</TALLYMESSAGE>`).join('\n')}
${voucherBlocks.map((v) => `<TALLYMESSAGE>${v}</TALLYMESSAGE>`).join('\n')}
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

async function main() {
  await preClean();
  await SystemSettings.update({
    gst_enabled: true,
    financial_year_start: '2025-04-01',
    financial_year_end: '2026-03-31',
  }, { where: { setting_id: 1 } });

  // ── Test 1: Cash sale (PARTYLEDGERNAME=Cash) — repro of TS-1004 ──
  // Cash Dr 1,601.60 / Local Sales 12% Cr 1,430 / CGST 9% 85.80 / SGST 9% 85.80
  const xml1 = envelope([], [
    `<VOUCHER VCHTYPE="Sales" ACTION="Create">
      <DATE>20251015</DATE>
      <VOUCHERNUMBER>${PFX}TS-1004</VOUCHERNUMBER>
      <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>1601.60</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Local Sales 12%</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1430.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-85.80</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST 9%</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-85.80</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file1 = await writeXml(xml1);
  const j1 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file1, profile_json: { tag: PFX } });
  await runUntilTerminal(j1);
  await j1.reload();
  check('Cash sale: status=done', j1.status === 'done', `err=${j1.error_message}`);
  check('Cash sale: 1 voucher posted, 0 rejected',
    (j1.result_summary_json || {}).posted === 1 && (j1.result_summary_json || {}).rejected === 0,
    `summary=${JSON.stringify(j1.result_summary_json)}`);
  const sb = await SalesBill.findOne({ where: { bill_number: `${PFX}TS-1004` } });
  check('Cash sale: bill total = 1,601.60',
    sb && Math.abs(Number(sb.total_amount) - 1601.60) < 0.01,
    `total=${sb && sb.total_amount}`);
  if (sb) {
    const e = await LedgerEntry.findAll({ where: { source_type: 'sales_bill', reference_id: sb.sales_bill_id } });
    const dr = e.reduce((s, x) => s + Number(x.debit_amount), 0);
    const cr = e.reduce((s, x) => s + Number(x.credit_amount), 0);
    check('Cash sale: ledger balanced (Dr=Cr=1,601.60)',
      Math.abs(dr - 1601.60) < 0.01 && Math.abs(cr - 1601.60) < 0.01,
      `dr=${dr} cr=${cr}`);
    const cash = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' } });
    check('Cash sale: Cash Dr 1,601.60 (party leg)',
      e.some((x) => x.ledger_id === cash.ledger_id && Math.abs(Number(x.debit_amount) - 1601.60) < 0.01));
  }

  // ── Test 2: Cash purchase (PARTYLEDGERNAME=Cash on Purchase) ──
  // Cash Cr 7,080 / Purchase A/c Dr 6,000 / CGST 9% Input Dr 540 / SGST 9% Input Dr 540
  const xml2 = envelope([], [
    `<VOUCHER VCHTYPE="Purchase" ACTION="Create">
      <DATE>20251020</DATE>
      <VOUCHERNUMBER>${PFX}TP-2002</VOUCHERNUMBER>
      <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-7080.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase A/c</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>6000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Input CGST 9%</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>540.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Input SGST 9%</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>540.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file2 = await writeXml(xml2);
  const j2 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file2, profile_json: { tag: PFX } });
  await runUntilTerminal(j2);
  await j2.reload();
  check('Cash purchase: status=done', j2.status === 'done', `err=${j2.error_message}`);
  check('Cash purchase: 1 voucher posted',
    (j2.result_summary_json || {}).posted === 1,
    `summary=${JSON.stringify(j2.result_summary_json)}`);
  const pb = await PurchaseBill.findOne({ where: { bill_number: `${PFX}TP-2002` } });
  check('Cash purchase: bill total = 7,080',
    pb && Math.abs(Number(pb.total_amount) - 7080) < 0.01);
  if (pb) {
    // Cash purchase produces TWO vouchers: the bill itself
    // (Purchase Dr / GST Input Dr / Stub Supplier Cr) and the implicit
    // payment (Stub Supplier Dr / Cash Cr). The Cash credit lives on
    // the secondary voucher; the stub supplier ledger nets to zero.
    const billE = await LedgerEntry.findAll({ where: { source_type: 'purchase_bill', reference_id: pb.purchase_bill_id } });
    const payE  = await LedgerEntry.findAll({ where: { source_type: 'purchase_bill_payment', reference_id: pb.purchase_bill_id } });
    const all   = [...billE, ...payE];
    const dr = all.reduce((s, x) => s + Number(x.debit_amount), 0);
    const cr = all.reduce((s, x) => s + Number(x.credit_amount), 0);
    check('Cash purchase: ledger balanced across both vouchers',
      Math.abs(dr - cr) < 0.01 && dr > 0,
      `dr=${dr} cr=${cr}`);
    const cash = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' } });
    check('Cash purchase: Cash Cr 7,080 on payment voucher',
      payE.some((x) => x.ledger_id === cash.ledger_id && Math.abs(Number(x.credit_amount) - 7080) < 0.01));
    // Stub supplier nets to zero across both vouchers.
    const stub = await Party.findOne({ where: { party_name: 'Cash Purchases' } });
    if (stub && stub.ledger_account_id) {
      const stubLines = all.filter((x) => x.ledger_id === stub.ledger_account_id);
      const stubNet = stubLines.reduce((s, x) => s + Number(x.debit_amount) - Number(x.credit_amount), 0);
      check('Cash purchase: stub "Cash Purchases" ledger nets to zero',
        Math.abs(stubNet) < 0.01, `net=${stubNet}`);
    }
  }

  // ── Test 3: Pre-FY date REJECTED ──
  // 2025-03-20 < 2025-04-01 (FY start) → reject with clear reason.
  const xml3 = envelope([
    `<LEDGER NAME="${PFX}OldCust"><NAME>${PFX}OldCust</NAME><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>`,
  ], [
    `<VOUCHER VCHTYPE="Sales" ACTION="Create">
      <DATE>20250320</DATE>
      <VOUCHERNUMBER>${PFX}MS-1003</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}OldCust</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}OldCust</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file3 = await writeXml(xml3);
  const j3 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file3, profile_json: { tag: PFX } });
  await runUntilTerminal(j3);
  await j3.reload();
  check('Pre-FY date: status=done (rejection IS the success path)',
    j3.status === 'done', `err=${j3.error_message}`);
  check('Pre-FY date: 0 posted, ≥1 rejected',
    (j3.result_summary_json || {}).posted === 0 && (j3.result_summary_json || {}).rejected >= 1,
    `summary=${JSON.stringify(j3.result_summary_json)}`);
  // Bill must NOT have landed.
  const orphan = await SalesBill.findOne({ where: { bill_number: `${PFX}MS-1003` } });
  check('Pre-FY date: NO sales bill row created', !orphan);
  // Confirm the rejection reason is human-readable.
  const preview = j3.preview_json || {};
  const rejSample = (preview.sample && preview.sample.reject) || [];
  const ms1003 = rejSample.find((r) => r.voucher_number === `${PFX}MS-1003`);
  check('Pre-FY date: reason mentions "before FY start"',
    ms1003 && /before FY start/i.test(ms1003.reason || ''),
    `reason='${ms1003 && ms1003.reason}'`);
  check('Pre-FY date: reason format dd-Mon-yyyy',
    ms1003 && /\d{2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}/.test(ms1003.reason || ''));

  // ── Test 4: Boundary — date EQUAL to fy_start_date ACCEPTED ──
  await preClean();
  const xml4 = envelope([
    `<LEDGER NAME="${PFX}BoundaryCust"><NAME>${PFX}BoundaryCust</NAME><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>`,
  ], [
    `<VOUCHER VCHTYPE="Sales" ACTION="Create">
      <DATE>20250401</DATE>
      <VOUCHERNUMBER>${PFX}BD-001</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}BoundaryCust</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}BoundaryCust</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file4 = await writeXml(xml4);
  const j4 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file4, profile_json: { tag: PFX } });
  await runUntilTerminal(j4);
  await j4.reload();
  check('Boundary date (FY start exactly): status=done', j4.status === 'done', `err=${j4.error_message}`);
  check('Boundary date: 1 posted, 0 rejected',
    (j4.result_summary_json || {}).posted === 1 && (j4.result_summary_json || {}).rejected === 0,
    `summary=${JSON.stringify(j4.result_summary_json)}`);
  const bd = await SalesBill.findOne({ where: { bill_number: `${PFX}BD-001` } });
  check('Boundary date: bill row created with date 2025-04-01',
    bd && String(bd.bill_date) === '2025-04-01',
    `date=${bd && bd.bill_date}`);

  // ── Cleanup ──
  await preClean();
  for (const f of [file1, file2, file3, file4]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  // Restore default FY range so other tests aren't affected.
  await SystemSettings.update({
    financial_year_start: '2026-04-01',
    financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase 5c Self-Test (cash sale + FY guard) ─────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
