#!/usr/bin/env node
// Phase-4 self-test: import queue worker + Tally ledger mapper.
//
// Run with: node server/scripts/test-phase4.js
// Cleans up everything it creates.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { sequelize, ImportJob, ImportBatch, TallyLedgerMapping, LedgerAccount } = require('../models');
const importWorker = require('../services/importJobWorker');
const { suggestMappings, saveMappings } = require('../services/tallyLedgerMapper');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P4_';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function preClean() {
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE phase_message LIKE '%${PFX}%' OR (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE phase_message LIKE '%${PFX}%' OR (profile_json->>'tag') = '${PFX}'`);
  await sequelize.query(`DELETE FROM tally_ledger_mappings WHERE tally_ledger_name LIKE '${PFX}%'`);
}

async function main() {
  await preClean();
  // Make sure no other worker is already polling — this test drives the
  // tick loop manually so its assertions are deterministic.
  importWorker.stop();

  // ── Test 1: Pick up a queued no-op job ─────────────────
  const j1 = await ImportJob.create({
    source: 'tally',
    status: 'queued',
    profile_json: { test_mode: 'noop', tag: PFX },
  });
  await importWorker._tick();
  await j1.reload();
  check('Worker picked up queued job', j1.status === 'done',
    `status=${j1.status}`);
  check('Worker set progress=100', j1.progress_pct === 100);
  check('Worker wrote result_summary_json',
    !!j1.result_summary_json && j1.result_summary_json.ok === true);
  check('Worker stamped started_at', !!j1.started_at);
  check('Worker stamped completed_at', !!j1.completed_at);

  // ── Test 2: Concurrent rejection — only one runs at a time ──
  // Pre-set one job to 'parsing' so the worker considers itself busy.
  const blocker = await ImportJob.create({
    source: 'tally',
    status: 'parsing',
    progress_pct: 10,
    phase_message: `${PFX}blocker`,
    profile_json: { tag: PFX },
  });
  const queued = await ImportJob.create({
    source: 'tally',
    status: 'queued',
    profile_json: { test_mode: 'noop', tag: PFX },
  });
  await importWorker._tick();
  await queued.reload();
  check('Concurrent rejection: queued job NOT picked while another is running',
    queued.status === 'queued', `status=${queued.status}`);
  // Now resolve the blocker and tick again
  await blocker.update({ status: 'done', completed_at: new Date(), progress_pct: 100 });
  await importWorker._tick();
  await queued.reload();
  check('Queued job runs once blocker completes', queued.status === 'done',
    `status=${queued.status}`);

  // ── Test 3: Crash recovery sweep ───────────────────────
  const orphan = await ImportJob.create({
    source: 'tally',
    status: 'committing',
    progress_pct: 50,
    phase_message: `${PFX}orphan`,
    profile_json: { tag: PFX },
  });
  const recovered = await importWorker.recoverOrphans();
  await orphan.reload();
  check('recoverOrphans returns non-zero', recovered >= 1);
  check('Orphan flipped to failed', orphan.status === 'failed',
    `status=${orphan.status}`);
  check('Orphan got an error message', /crashed/i.test(orphan.error_message || ''));

  // ── Test 4: Tally ledger mapper — exact match ──────────
  const sug = await suggestMappings(['Sales A/c', 'CGST @ 9% Output', 'Random Junk Ledger']);
  const m = (n) => sug.find((s) => s.tally_ledger_name === n);
  check('Mapper: "Sales A/c" → Sales Account / high',
    m('Sales A/c') && m('Sales A/c').suggested_ledger_name === 'Sales Account' && m('Sales A/c').confidence === 'high');
  check('Mapper: "CGST @ 9% Output" → CGST Output / high',
    m('CGST @ 9% Output') && m('CGST @ 9% Output').suggested_ledger_name === 'CGST Output' && m('CGST @ 9% Output').confidence === 'high');
  // Junk gets either 'low' or 'unmapped' depending on token overlap.
  // Whichever, it should NOT be 'high' or 'medium'.
  const junk = m('Random Junk Ledger');
  check('Mapper: "Random Junk Ledger" is NOT high/medium',
    junk && (junk.confidence === 'low' || junk.confidence === 'unmapped'),
    `got ${junk && junk.confidence}`);

  // ── Test 5: Mapping persistence ────────────────────────
  const obe = await LedgerAccount.findOne({ where: { ledger_name: 'Opening Balance Equity' } });
  await saveMappings([
    { tally_ledger_name: `${PFX}Mystery Ledger`, mapped_ledger_account_id: obe.ledger_id, confidence: 'manual' },
  ]);
  const sug2 = await suggestMappings([`${PFX}Mystery Ledger`]);
  check('Persistence: saved mapping is returned next time',
    sug2[0].suggested_ledger_id === obe.ledger_id && sug2[0].confidence === 'manual' && sug2[0].from_persisted === true);
  // Second call returns the same.
  const sug3 = await suggestMappings([`${PFX}Mystery Ledger`]);
  check('Persistence: idempotent on re-query',
    sug3[0].suggested_ledger_id === obe.ledger_id);

  // ── Test 6: GST direction inference ────────────────────
  const taxes = await suggestMappings([
    'Input CGST 9%', 'IGST Output 18%', 'SGST Sales 9%',
  ]);
  check('Mapper: "Input CGST 9%" → CGST Input',
    taxes[0].suggested_ledger_name === 'CGST Input');
  check('Mapper: "IGST Output 18%" → IGST Output',
    taxes[1].suggested_ledger_name === 'IGST Output');
  check('Mapper: "SGST Sales 9%" → SGST Output (sales = output)',
    taxes[2].suggested_ledger_name === 'SGST Output');

  // ── Cleanup ──
  await preClean();

  console.log('\n── Phase 4 Self-Test ──────────────────────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
