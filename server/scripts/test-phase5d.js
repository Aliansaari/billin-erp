#!/usr/bin/env node
// Phase-5d self-test: Tally Receipt/Payment commit must resolve the
// party from the existing parties table, not just the in-batch <LEDGER>
// map. Repro of the spot-check bug:
//
//   1. User imports 01_customers.xlsx (creates "Sharma Cloth House").
//   2. User imports tally_export_messy.xml. The XML's MR-3001 references
//      Sharma Cloth House by name but does NOT include a <LEDGER> master
//      for her — she's already in the DB. Old code threw "Receipt has
//      no party" at commit because partiesByName only held the XML's
//      master ledgers.
//
// Fix: shared resolvePartyByName(name, partiesByName, transaction) used
// by every commit branch + a validate-phase existence check that
// rejects Receipt/Payment/Debit Note vouchers whose party isn't known
// (in-batch OR DB) so the user sees it in preview, not at commit.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  sequelize, ImportJob, Party, PaymentReceipt, LedgerEntry, LedgerAccount, SystemSettings,
} = require('../models');
const orchestrator = require('../services/tallyImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P5D_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function writeXml(content) {
  const p = path.join(os.tmpdir(), `phase5d-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
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

  // Pre-create a customer + supplier in the DB. The Tally XML below
  // references them by name but does NOT include <LEDGER> masters for
  // them — the bug repro.
  const cust = await Party.create({
    party_type: 'Customer', party_name: `${PFX}Sharma Cloth House`, mobile_1: '9000000001',
  });
  const sup = await Party.create({
    party_type: 'Supplier', party_name: `${PFX}Patel Dist`, mobile_1: '9000000002',
  });
  await cust.reload(); await sup.reload();

  // ── Test 1: Receipt against pre-existing customer (no <LEDGER> in XML) ──
  const xml1 = envelope([], [
    `<VOUCHER VCHTYPE="Receipt" ACTION="Create">
      <DATE>20251015</DATE>
      <VOUCHERNUMBER>${PFX}MR-3001</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}Sharma Cloth House</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Sharma Cloth House</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file1 = await writeXml(xml1);
  const j1 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file1, profile_json: { tag: PFX } });
  await runUntilTerminal(j1);
  await j1.reload();
  check('Receipt vs pre-existing party: status=done',
    j1.status === 'done', `err=${j1.error_message}`);
  check('Receipt vs pre-existing party: 1 posted, 0 rejected, 0 failed',
    (j1.result_summary_json || {}).posted === 1
    && (j1.result_summary_json || {}).rejected === 0
    && (j1.result_summary_json || {}).failed === 0,
    `summary=${JSON.stringify(j1.result_summary_json)}`);
  const rcpt = await PaymentReceipt.findOne({ where: { transaction_number: `${PFX}MR-3001` } });
  check('Receipt: row created, party_id matches existing customer',
    rcpt && rcpt.party_id === cust.party_id, `got party_id=${rcpt && rcpt.party_id}, expected=${cust.party_id}`);
  if (rcpt) {
    const e = await LedgerEntry.findAll({ where: { source_type: 'payment_receipt', reference_id: rcpt.transaction_id } });
    const dr = e.reduce((s, x) => s + Number(x.debit_amount), 0);
    const cr = e.reduce((s, x) => s + Number(x.credit_amount), 0);
    check('Receipt: ledger balanced (Dr=Cr=5,000)',
      Math.abs(dr - 5000) < 0.01 && Math.abs(cr - 5000) < 0.01);
  }

  // ── Test 2: Payment against pre-existing supplier (no <LEDGER> in XML) ──
  const xml2 = envelope([], [
    `<VOUCHER VCHTYPE="Payment" ACTION="Create">
      <DATE>20251020</DATE>
      <VOUCHERNUMBER>${PFX}MP-4001</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}Patel Dist</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Patel Dist</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>2500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-2500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file2 = await writeXml(xml2);
  const j2 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file2, profile_json: { tag: PFX } });
  await runUntilTerminal(j2);
  await j2.reload();
  check('Payment vs pre-existing party: status=done', j2.status === 'done', `err=${j2.error_message}`);
  check('Payment vs pre-existing party: 1 posted, 0 failed',
    (j2.result_summary_json || {}).posted === 1 && (j2.result_summary_json || {}).failed === 0,
    `summary=${JSON.stringify(j2.result_summary_json)}`);
  const pmt = await PaymentReceipt.findOne({ where: { transaction_number: `${PFX}MP-4001` } });
  check('Payment: party_id matches existing supplier',
    pmt && pmt.party_id === sup.party_id);

  // ── Test 3: Receipt against unknown party → REJECTED IN PREVIEW ──
  const xml3 = envelope([], [
    `<VOUCHER VCHTYPE="Receipt" ACTION="Create">
      <DATE>20251022</DATE>
      <VOUCHERNUMBER>${PFX}MR-3099</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}Ghost Customer Who Never Existed</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Ghost Customer Who Never Existed</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file3 = await writeXml(xml3);
  const j3 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file3, profile_json: { tag: PFX } });

  // Drive only the parse+validate steps so we can inspect the preview
  // BEFORE confirming.
  await orchestrator.run(j3);
  await j3.reload();
  check('Unknown-party Receipt: validate paused at awaiting_confirmation',
    j3.status === 'awaiting_confirmation',
    `status=${j3.status} err=${j3.error_message}`);
  const rejSample3 = (j3.preview_json && j3.preview_json.sample && j3.preview_json.sample.reject) || [];
  const ghost3 = rejSample3.find((r) => r.voucher_number === `${PFX}MR-3099`);
  check('Unknown-party Receipt: rejected in preview (validate phase)',
    !!ghost3, `rejSample=${JSON.stringify(rejSample3)}`);
  check('Unknown-party Receipt: reason mentions party not found',
    ghost3 && /not found/i.test(ghost3.reason || ''),
    `reason='${ghost3 && ghost3.reason}'`);
  // Continue the import — should commit nothing (the only voucher was rejected).
  await runUntilTerminal(j3);
  await j3.reload();
  const orphan3 = await PaymentReceipt.findOne({ where: { transaction_number: `${PFX}MR-3099` } });
  check('Unknown-party Receipt: NO payments_receipts row created', !orphan3);

  // ── Test 4: Payment against unknown party → REJECTED IN PREVIEW ──
  const xml4 = envelope([], [
    `<VOUCHER VCHTYPE="Payment" ACTION="Create">
      <DATE>20251023</DATE>
      <VOUCHERNUMBER>${PFX}MP-4099</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}Ghost Supplier Who Never Existed</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Ghost Supplier Who Never Existed</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>3000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-3000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file4 = await writeXml(xml4);
  const j4 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file4, profile_json: { tag: PFX } });
  await orchestrator.run(j4);
  await j4.reload();
  check('Unknown-party Payment: validate paused at awaiting_confirmation',
    j4.status === 'awaiting_confirmation', `status=${j4.status} err=${j4.error_message}`);
  const rejSample4 = (j4.preview_json && j4.preview_json.sample && j4.preview_json.sample.reject) || [];
  const ghost4 = rejSample4.find((r) => r.voucher_number === `${PFX}MP-4099`);
  check('Unknown-party Payment: rejected in preview (validate phase)', !!ghost4);
  check('Unknown-party Payment: reason mentions party not found',
    ghost4 && /not found/i.test(ghost4.reason || ''));
  await runUntilTerminal(j4);
  await j4.reload();
  const orphan4 = await PaymentReceipt.findOne({ where: { transaction_number: `${PFX}MP-4099` } });
  check('Unknown-party Payment: NO payments_receipts row created', !orphan4);

  // ── Cleanup ──
  await preClean();
  for (const f of [file1, file2, file3, file4]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  await SystemSettings.update({
    financial_year_start: '2026-04-01',
    financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase 5d Self-Test (party resolution: in-batch + DB) ──');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
