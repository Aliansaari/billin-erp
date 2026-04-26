#!/usr/bin/env node
// Phase-6b self-test: three bug fixes from the real-data spot-check.
//
// 1. Excel ISO-string dates → preview row carries the date AND commit posts.
// 2. Excel native serial-number dates → same result. The validator and
//    committer must use ONE shared parser; if they diverge, this test
//    fails with "preview accepts → commit rejects".
// 3. Rejected-rows download via the authenticated API client → 200 OK.
//
// Run with: node server/scripts/test-phase6b.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const ExcelJS = require('exceljs');
const { sequelize, ImportJob, Party, SalesBill, SystemSettings } = require('../models');
const orchestrator = require('../services/excelImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P6B_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

// Build a sales workbook. `dateForBills` controls the type of the value
// written into the Date column — 'iso' (string), 'serial' (number), or
// 'native' (Date object, which ExcelJS will serialize as a serial too).
async function writeSalesWb(billNumber, dateForBills) {
  const wb = new ExcelJS.Workbook();
  const wsB = wb.addWorksheet('Bills');
  wsB.addRow(['Bill Number', 'Date', 'Customer Mobile', 'Customer Name', 'CGST %', 'SGST %', 'IGST %']);
  let dateValue;
  if (dateForBills === 'iso')         dateValue = '2026-04-25';
  else if (dateForBills === 'serial') dateValue = 46137;        // 2026-04-25 in Excel serial
  else                                dateValue = new Date('2026-04-25T00:00:00Z');
  wsB.addRow([billNumber, dateValue, '8000000001', `${PFX}Cust`, 9, 9, 0]);
  const wsI = wb.addWorksheet('Items');
  wsI.addRow(['Bill Number', 'Product Name', 'Quantity', 'Rate', 'GST %']);
  wsI.addRow([billNumber, `${PFX}Widget`, 5, 1000, 18]);
  const p = path.join(os.tmpdir(), `phase6b-${dateForBills}-${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(p);
  return p;
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

async function runAndAssert(label, billNumber, dateMode) {
  const file = await writeSalesWb(billNumber, dateMode);
  const job = await ImportJob.create({
    source: 'excel_sales', status: 'queued',
    input_file_path: file, profile_json: { tag: PFX },
  });
  // Drive parse+validate, then assert on the preview BEFORE confirming.
  await orchestrator.run(job);
  await job.reload();
  check(`${label}: preview reached awaiting_confirmation`,
    job.status === 'awaiting_confirmation', `status=${job.status} err=${job.error_message}`);
  const sample = job.preview_json?.sample?.create || [];
  check(`${label}: preview create row has a non-null date`,
    sample.length === 1 && !!sample[0].date,
    `sample=${JSON.stringify(sample)}`);
  check(`${label}: preview date is ISO YYYY-MM-DD`,
    sample.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(sample[0].date || ''),
    `date='${sample[0] && sample[0].date}'`);

  // Confirm and commit.
  await runUntilTerminal(job);
  await job.reload();
  check(`${label}: commit reached done (no validate→commit divergence)`,
    job.status === 'done',
    `status=${job.status} err=${job.error_message} summary=${JSON.stringify(job.result_summary_json)}`);
  check(`${label}: 1 bill posted, 0 failed`,
    (job.result_summary_json || {}).posted === 1 && (job.result_summary_json || {}).failed === 0,
    `summary=${JSON.stringify(job.result_summary_json)}`);

  const sbill = await SalesBill.findOne({ where: { bill_number: billNumber } });
  check(`${label}: sales_bills.bill_date stored correctly (2026-04-25)`,
    sbill && String(sbill.bill_date) === '2026-04-25',
    `bill_date=${sbill && sbill.bill_date}`);

  try { fs.unlinkSync(file); } catch (_) {}
  return job;
}

async function main() {
  await preClean();
  await SystemSettings.update({ gst_enabled: true }, { where: { setting_id: 1 } });

  // ── Test 1: ISO dates ──
  await runAndAssert('ISO dates', `${PFX}SAL-ISO`, 'iso');

  // ── Test 2: Excel native serial dates ──
  await runAndAssert('Excel serial dates', `${PFX}SAL-SER`, 'serial');

  // ── Test 3: Authenticated rejected-rows download ──
  // Build a workbook guaranteed to produce rejects.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customers');
  ws.addRow(['Party Name', 'Mobile 1']);
  ws.addRow(['', '8000000099']);              // missing name
  ws.addRow([`${PFX}NoMobile`, '']);          // missing mobile
  ws.addRow([`${PFX}Good`, '8000000098']);    // valid
  const xPath = path.join(os.tmpdir(), `phase6b-rej-${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(xPath);
  const rejJob = await ImportJob.create({
    source: 'excel_customers', status: 'queued',
    input_file_path: xPath, profile_json: { tag: PFX },
  });
  await runUntilTerminal(rejJob);
  await rejJob.reload();
  check('Rejected-rows: job done with 2 rejects',
    rejJob.status === 'done' && (rejJob.result_summary_json || {}).rejected === 2);
  check('Rejected-rows: file written to disk',
    !!rejJob.rejected_rows_path && fs.existsSync(rejJob.rejected_rows_path));

  // Auth'd download via HTTP — mirror what the frontend now does.
  // Login → grab token → GET the endpoint with Authorization header.
  await new Promise((resolve) => setTimeout(resolve, 300));   // tiny buffer
  const token = await new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST', host: 'localhost', port: 3001, path: '/api/auth/login',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body).token); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ username: 'admin', password: 'admin123' }));
    req.end();
  });

  // 1. Without token → must 401.
  const unauthStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      method: 'GET', host: 'localhost', port: 3001,
      path: `/api/imports/${rejJob.id}/rejected-rows`,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  check('Rejected-rows: unauthenticated GET → 401', unauthStatus === 401, `status=${unauthStatus}`);

  // 2. With token → 200 + actual file body.
  const authResult = await new Promise((resolve, reject) => {
    const req = http.request({
      method: 'GET', host: 'localhost', port: 3001,
      path: `/api/imports/${rejJob.id}/rejected-rows`,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  check('Rejected-rows: authenticated GET → 200', authResult.status === 200, `status=${authResult.status}`);
  // xlsx files start with the ZIP magic bytes "PK\x03\x04".
  check('Rejected-rows: response body is a real xlsx (PK header)',
    authResult.body.length > 100 && authResult.body[0] === 0x50 && authResult.body[1] === 0x4B);

  // ── Cleanup ──
  await preClean();
  try { fs.unlinkSync(xPath); } catch (_) {}

  console.log('\n── Phase 6b Self-Test (date parser + auth download) ──────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
