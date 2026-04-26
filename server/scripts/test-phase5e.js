#!/usr/bin/env node
// Phase-5e self-test: Tally importer no longer pollutes parties.mobile_1
// with "TLY..." stubs that the UI then renders as a fake identifier
// underneath the customer name on the Sales Bills list and the Party
// Ledger header.
//
// Repro:
//   1. Excel-imported Sharma Cloth House with a real GSTIN and mobile.
//   2. Tally re-import that references her by name (no <LEDGER> master
//      and no GSTIN in the XML).
//   3. UI showed "TLY22114378353" — a generated stub from the Tally
//      orchestrator's NOT-NULL filler — instead of her real GSTIN.
//
// Fixes verified here:
//   • Tally orchestrator writes mobile_1='' when Tally has no phone,
//     never a TLY... stub.
//   • Existing Excel-imported parties referenced by Tally keep their
//     real GSTIN and mobile (orchestrator does not overwrite).
//   • New Tally-only customers have empty mobile but a real GSTIN
//     when the XML supplies one.
//
// UI rendering itself is exercised in the browser preview; this script
// asserts on the data layer (which is what the UI reads).

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  sequelize, ImportJob, Party, SystemSettings,
} = require('../models');
const orchestrator = require('../services/tallyImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P5E_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function writeXml(content) {
  const p = path.join(os.tmpdir(), `phase5e-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
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

  // ── Test 1: Tally-imported customer WITH GSTIN ──────────
  // Tally <LEDGER> with PARTYGSTIN populated, no LEDGERPHONE. Party
  // should be created with real GSTIN and empty (not TLY) mobile.
  const xml1 = envelope([
    `<LEDGER NAME="${PFX}Acme Traders"><NAME>${PFX}Acme Traders</NAME><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>27ABCDE1234F1Z5</PARTYGSTIN><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>`,
  ], []);
  const file1 = await writeXml(xml1);
  const j1 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file1, profile_json: { tag: PFX } });
  await runUntilTerminal(j1);
  await j1.reload();
  check('GSTIN customer: import done', j1.status === 'done', `err=${j1.error_message}`);
  const acme = await Party.findOne({ where: { party_name: `${PFX}Acme Traders` } });
  check('GSTIN customer: party row exists', !!acme);
  check('GSTIN customer: gstin populated from PARTYGSTIN',
    acme && acme.gstin === '27ABCDE1234F1Z5',
    `gstin=${acme && acme.gstin}`);
  check('GSTIN customer: mobile_1 is empty (no TLY stub)',
    acme && (acme.mobile_1 === '' || acme.mobile_1 === null),
    `mobile_1='${acme && acme.mobile_1}'`);
  check('GSTIN customer: mobile_1 does NOT start with "TLY"',
    acme && !/^TLY/i.test(acme.mobile_1 || ''));

  // ── Test 2: Tally-imported customer with NO GSTIN, no mobile ───
  // Both blank in XML. Party row should be created cleanly without TLY.
  const xml2 = envelope([
    `<LEDGER NAME="${PFX}Plain Cust"><NAME>${PFX}Plain Cust</NAME><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>`,
  ], []);
  const file2 = await writeXml(xml2);
  const j2 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file2, profile_json: { tag: PFX } });
  await runUntilTerminal(j2);
  await j2.reload();
  check('No-GSTIN customer: import done', j2.status === 'done', `err=${j2.error_message}`);
  const plain = await Party.findOne({ where: { party_name: `${PFX}Plain Cust` } });
  check('No-GSTIN customer: party row exists', !!plain);
  check('No-GSTIN customer: gstin null/empty',
    plain && (!plain.gstin || plain.gstin === ''));
  check('No-GSTIN customer: mobile_1 empty (not TLY stub)',
    plain && plain.mobile_1 === '',
    `mobile_1='${plain && plain.mobile_1}'`);
  check('No-GSTIN customer: mobile_1 does NOT start with "TLY"',
    plain && !/^TLY/i.test(plain.mobile_1 || ''));

  // ── Test 3: Excel-created party referenced by Tally ──
  // Sharma Cloth House created first via direct Party.create (mirroring
  // Excel customers import). Then a Tally XML references her by name as
  // PARTYLEDGERNAME but does NOT include a <LEDGER> master. Phase-5d
  // ensured commit succeeds; Phase-5e ensures her real GSTIN + mobile
  // are preserved (orchestrator must NOT touch existing rows).
  await Party.create({
    party_type: 'Customer',
    party_name: `${PFX}Sharma Cloth House`,
    mobile_1: '9876543210',
    gstin: '27AABCS3322B1Z5',
  });
  const xml3 = envelope([], [
    `<VOUCHER VCHTYPE="Receipt" ACTION="Create">
      <DATE>20251015</DATE>
      <VOUCHERNUMBER>${PFX}MR-3001</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}Sharma Cloth House</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Sharma Cloth House</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file3 = await writeXml(xml3);
  const j3 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file3, profile_json: { tag: PFX } });
  await runUntilTerminal(j3);
  await j3.reload();
  check('Pre-existing party + Tally ref: import done', j3.status === 'done', `err=${j3.error_message}`);
  const sharma = await Party.findOne({ where: { party_name: `${PFX}Sharma Cloth House` } });
  check('Pre-existing party: only ONE row exists (no Tally duplicate)',
    sharma && (await Party.count({ where: { party_name: `${PFX}Sharma Cloth House` } })) === 1);
  check('Pre-existing party: mobile_1 still 9876543210 (Excel-imported)',
    sharma && sharma.mobile_1 === '9876543210',
    `mobile_1='${sharma && sharma.mobile_1}'`);
  check('Pre-existing party: gstin still 27AABCS3322B1Z5',
    sharma && sharma.gstin === '27AABCS3322B1Z5',
    `gstin='${sharma && sharma.gstin}'`);
  check('Pre-existing party: mobile_1 does NOT start with "TLY"',
    sharma && !/^TLY/i.test(sharma.mobile_1 || ''));

  // ── Sanity sweep across ALL parties touched by this test ──
  const all = await Party.findAll({ where: { party_name: { [require('sequelize').Op.like]: `${PFX}%` } } });
  const tlyLeak = all.filter((p) => /^TLY/i.test(p.mobile_1 || ''));
  check('Sanity: zero parties with TLY-stub mobile across the suite',
    tlyLeak.length === 0,
    `leaked=${tlyLeak.map((p) => p.party_name + '/' + p.mobile_1).join(', ')}`);

  // ── Cleanup ──
  await preClean();
  for (const f of [file1, file2, file3]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  await SystemSettings.update({
    financial_year_start: '2026-04-01',
    financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase 5e Self-Test (no TLY stub leak) ─────────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
