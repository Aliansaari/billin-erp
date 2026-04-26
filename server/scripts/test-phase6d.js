#!/usr/bin/env node
// Phase-6d self-test: opening-balance direction across the four cases.
//
// Repro of the spot-check bug: 02_suppliers.xlsx with "Cr" balance type
// posted Supplier Dr / OBE Cr — wrong direction on the supplier's own
// ledger, only obscured by global Dr=Cr balance because the JV is
// internally balanced. Audit trail corrupt.
//
// Tests the four corners through the Excel orchestrator AND the
// Party.normalizeBalanceType helper directly:
//   1. Customer Dr opening (typical)            → Customer Dr / OBE Cr
//   2. Customer Cr opening (advance / refund)   → Customer Cr / OBE Dr
//   3. Supplier Cr opening (typical)            → Supplier Cr / OBE Dr
//   4. Supplier Dr opening (advance paid out)   → Supplier Dr / OBE Cr
//
// Plus six unit checks on the normalizer itself so a future regression
// in the alias set is caught at the source.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const ExcelJS = require('exceljs');
const {
  sequelize, ImportJob, Party, LedgerAccount, LedgerEntry, SystemSettings,
} = require('../models');
const orchestrator = require('../services/excelImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P6D_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function runUntilTerminal(job, maxIterations = 6) {
  for (let i = 0; i < maxIterations; i++) {
    await orchestrator.run(job);
    await job.reload();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return;
    if (job.status === 'awaiting_confirmation') {
      const profile = { ...(job.profile_json || {}), user_choices: { confirmed: true } };
      await job.update({ status: 'queued', profile_json: profile });
    }
  }
}

// Build a one-row party workbook with the given balance-type alias.
async function buildWb(template, partyName, mobile, openingAmt, balanceTypeAlias) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(template === 'excel_customers' ? 'Customers' : 'Suppliers');
  ws.addRow(['Party Name', 'Mobile 1', 'Opening Balance', 'Balance Type']);
  ws.addRow([partyName, mobile, openingAmt, balanceTypeAlias]);
  const p = path.join(os.tmpdir(), `phase6d-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  await wb.xlsx.writeFile(p);
  return p;
}

// Drive an import and return the party + opening JV entries for inspection.
async function importAndInspect(label, template, partyName, mobile, opening, balanceTypeAlias) {
  const file = await buildWb(template, partyName, mobile, opening, balanceTypeAlias);
  const job = await ImportJob.create({
    source: template, status: 'queued',
    input_file_path: file, profile_json: { tag: PFX },
  });
  await runUntilTerminal(job);
  await job.reload();
  check(`${label}: import done`, job.status === 'done',
    `status=${job.status} err=${job.error_message}`);
  const party = await Party.findOne({ where: { party_name: partyName } });
  if (!party) { check(`${label}: party row exists`, false); try { fs.unlinkSync(file); } catch (_) {} return null; }
  const entries = await LedgerEntry.findAll({
    where: { source_type: 'party_opening', reference_id: party.party_id },
    order: [['entry_id', 'ASC']],
  });
  try { fs.unlinkSync(file); } catch (_) {}
  return { party, entries };
}

async function main() {
  await preClean();
  await SystemSettings.update({ gst_enabled: true }, { where: { setting_id: 1 } });

  const obe = await LedgerAccount.findOne({ where: { ledger_name: 'Opening Balance Equity' } });

  // ── Unit checks: the normalizer itself ─────────────────
  check('Normalizer: ""        → Receivable', Party.normalizeBalanceType('') === 'Receivable');
  check('Normalizer: "Dr"      → Receivable', Party.normalizeBalanceType('Dr') === 'Receivable');
  check('Normalizer: "Debit"   → Receivable', Party.normalizeBalanceType('Debit') === 'Receivable');
  check('Normalizer: "Cr"      → Payable',    Party.normalizeBalanceType('Cr') === 'Payable');
  check('Normalizer: "Credit"  → Payable',    Party.normalizeBalanceType('Credit') === 'Payable');
  check('Normalizer: "Payable" → Payable',    Party.normalizeBalanceType('Payable') === 'Payable');
  check('Normalizer: "Receivable" → Receivable', Party.normalizeBalanceType('Receivable') === 'Receivable');
  check('Normalizer: " cr "    → Payable (whitespace)', Party.normalizeBalanceType(' cr ') === 'Payable');

  // ── Test 1: Customer Dr opening (typical) ──────────────
  // Excel typically writes "Dr" or "Receivable" for customer balances.
  const r1 = await importAndInspect(
    'Customer Dr', 'excel_customers',
    `${PFX}CustDr`, '8500000001', 50000, 'Dr',
  );
  if (r1) {
    const cl = await LedgerAccount.findByPk(r1.party.ledger_account_id);
    check('Customer Dr: 2 ledger lines', r1.entries.length === 2);
    check('Customer Dr: customer ledger Dr 50,000',
      r1.entries.some((e) => e.ledger_id === cl.ledger_id && Number(e.debit_amount) === 50000));
    check('Customer Dr: OBE Cr 50,000',
      r1.entries.some((e) => e.ledger_id === obe.ledger_id && Number(e.credit_amount) === 50000));
  }

  // ── Test 2: Customer Cr opening (rare advance / refund pending) ──
  const r2 = await importAndInspect(
    'Customer Cr', 'excel_customers',
    `${PFX}CustCr`, '8500000002', 12000, 'Cr',
  );
  if (r2) {
    const cl = await LedgerAccount.findByPk(r2.party.ledger_account_id);
    check('Customer Cr: 2 ledger lines', r2.entries.length === 2);
    check('Customer Cr: customer ledger Cr 12,000 (we owe customer)',
      r2.entries.some((e) => e.ledger_id === cl.ledger_id && Number(e.credit_amount) === 12000));
    check('Customer Cr: OBE Dr 12,000',
      r2.entries.some((e) => e.ledger_id === obe.ledger_id && Number(e.debit_amount) === 12000));
    check('Customer Cr: party row stored as Payable',
      r2.party.opening_balance_type === 'Payable');
  }

  // ── Test 3: Supplier Cr opening (THE BUG — typical case) ──────────
  // Repro of the 02_suppliers.xlsx scenario. "Cr" must yield
  // Supplier Cr / OBE Dr — we owe them, audit-correct direction.
  const r3 = await importAndInspect(
    'Supplier Cr', 'excel_suppliers',
    `${PFX}SupCr`, '8500000003', 145000, 'Cr',
  );
  if (r3) {
    const sl = await LedgerAccount.findByPk(r3.party.ledger_account_id);
    check('Supplier Cr: 2 ledger lines', r3.entries.length === 2);
    check('Supplier Cr: supplier ledger Cr 1,45,000 (we owe supplier)',
      r3.entries.some((e) => e.ledger_id === sl.ledger_id && Number(e.credit_amount) === 145000));
    check('Supplier Cr: supplier ledger has NO debit on opening',
      !r3.entries.some((e) => e.ledger_id === sl.ledger_id && Number(e.debit_amount) > 0));
    check('Supplier Cr: OBE Dr 1,45,000',
      r3.entries.some((e) => e.ledger_id === obe.ledger_id && Number(e.debit_amount) === 145000));
    check('Supplier Cr: party row stored as Payable',
      r3.party.opening_balance_type === 'Payable',
      `got ${r3.party.opening_balance_type}`);
  }

  // ── Test 4: Supplier Dr opening (rare advance paid) ──────────────
  const r4 = await importAndInspect(
    'Supplier Dr', 'excel_suppliers',
    `${PFX}SupDr`, '8500000004', 8000, 'Dr',
  );
  if (r4) {
    const sl = await LedgerAccount.findByPk(r4.party.ledger_account_id);
    check('Supplier Dr: 2 ledger lines', r4.entries.length === 2);
    check('Supplier Dr: supplier ledger Dr 8,000 (advance paid)',
      r4.entries.some((e) => e.ledger_id === sl.ledger_id && Number(e.debit_amount) === 8000));
    check('Supplier Dr: OBE Cr 8,000',
      r4.entries.some((e) => e.ledger_id === obe.ledger_id && Number(e.credit_amount) === 8000));
    check('Supplier Dr: party row stored as Receivable',
      r4.party.opening_balance_type === 'Receivable');
  }

  // ── Cleanup ──
  await preClean();

  console.log('\n── Phase 6d Self-Test (opening balance direction) ────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
