#!/usr/bin/env node
// Phase-6 self-test: Excel orchestrator end-to-end on synthetic workbooks.
// Generates an Excel file in-memory, drives the orchestrator, asserts on
// posted entries / re-import diff / GST-off behavior. Cleans up.
//
// Run with: node server/scripts/test-phase6.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const ExcelJS = require('exceljs');
const {
  sequelize, ImportJob, Party, Product, SalesBill, PurchaseBill,
  PaymentReceipt, LedgerEntry, LedgerAccount, SystemSettings,
} = require('../models');
const orchestrator = require('../services/excelImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P6_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function writeWorkbook(builder) {
  const wb = new ExcelJS.Workbook();
  builder(wb);
  const p = path.join(os.tmpdir(), `phase6-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
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

async function main() {
  await preClean();
  await SystemSettings.update({ gst_enabled: true }, { where: { setting_id: 1 } });

  // ── Test 1: customers template ─────────────────────────
  const file1 = await writeWorkbook((wb) => {
    const ws = wb.addWorksheet('Customers');
    ws.addRow(['Party Name', 'Mobile 1', 'GSTIN', 'Opening Balance', 'Balance Type']);
    ws.addRow([`${PFX}Cust1`, '7000000001', '', 0, 'Receivable']);
    ws.addRow([`${PFX}Cust2`, '7000000002', '', 5000, 'Receivable']);
    ws.addRow([`${PFX}Cust3`, '7000000003', '27ABCDE1234F1Z5', 0, 'Receivable']);
  });
  const j1 = await ImportJob.create({ source: 'excel_customers', status: 'queued', input_file_path: file1, profile_json: { tag: PFX } });
  await runUntilTerminal(j1);
  await j1.reload();
  check('Customers import: status=done', j1.status === 'done', `err=${j1.error_message}`);
  check('Customers import: 3 created',
    (j1.result_summary_json || {}).posted === 3,
    `summary=${JSON.stringify(j1.result_summary_json)}`);
  const c2 = await Party.findOne({ where: { party_name: `${PFX}Cust2` } });
  check(`Cust2 has ledger_account_id auto-linked`, c2 && c2.ledger_account_id);
  const c2Opening = await LedgerEntry.findAll({ where: { source_type: 'party_opening', reference_id: c2.party_id } });
  check(`Cust2 opening JV (₹5,000) posted`,
    c2Opening.length === 2 && c2Opening.reduce((s, e) => s + Number(e.debit_amount), 0) === 5000);

  // ── Test 2: sales_bills template ───────────────────────
  const file2 = await writeWorkbook((wb) => {
    const wsB = wb.addWorksheet('Bills');
    wsB.addRow(['Bill Number', 'Date', 'Customer Mobile', 'Customer Name', 'CGST %', 'SGST %', 'IGST %']);
    wsB.addRow([`${PFX}SAL01`, '2026-04-20', '7000000001', `${PFX}Cust1`, 9, 9, 0]);
    wsB.addRow([`${PFX}SAL02`, '2026-04-21', '7000000003', `${PFX}Cust3`, 0, 0, 18]);
    const wsI = wb.addWorksheet('Items');
    wsI.addRow(['Bill Number', 'Product Name', 'Quantity', 'Rate', 'GST %']);
    wsI.addRow([`${PFX}SAL01`, `${PFX}Widget`, 10, 1000, 18]);
    wsI.addRow([`${PFX}SAL02`, `${PFX}Widget`, 5,  2000, 18]);
  });
  const j2 = await ImportJob.create({ source: 'excel_sales', status: 'queued', input_file_path: file2, profile_json: { tag: PFX } });
  await runUntilTerminal(j2);
  await j2.reload();
  check('Sales bills import: status=done', j2.status === 'done', `err=${j2.error_message}`);
  check('Sales bills import: 2 posted',
    (j2.result_summary_json || {}).posted === 2,
    `summary=${JSON.stringify(j2.result_summary_json)}`);

  const sal1 = await SalesBill.findOne({ where: { bill_number: `${PFX}SAL01` } });
  check('SAL01 total = 11,800 (10K + 9% + 9%)',
    sal1 && Math.abs(Number(sal1.total_amount) - 11800) < 0.01,
    `total=${sal1 && sal1.total_amount}`);
  const sal1E = await LedgerEntry.findAll({ where: { source_type: 'sales_bill', reference_id: sal1.sales_bill_id } });
  check('SAL01 ledger balanced',
    sal1E.reduce((s, e) => s + Number(e.debit_amount), 0) === sal1E.reduce((s, e) => s + Number(e.credit_amount), 0));

  const sal2 = await SalesBill.findOne({ where: { bill_number: `${PFX}SAL02` } });
  check('SAL02 (interstate) total = 11,800 (10K + 18% IGST)',
    sal2 && Math.abs(Number(sal2.total_amount) - 11800) < 0.01,
    `total=${sal2 && sal2.total_amount}`);

  // ── Test 3: payment_receipts template ──────────────────
  const file3 = await writeWorkbook((wb) => {
    const ws = wb.addWorksheet('Payments');
    ws.addRow(['Transaction Number', 'Type', 'Date', 'Party Mobile', 'Party Name', 'Amount', 'Payment Method']);
    ws.addRow([`${PFX}RCT01`, 'Receipt', '2026-04-22', '7000000001', `${PFX}Cust1`, 5000, 'Cash']);
    ws.addRow([`${PFX}RCT02`, 'Receipt', '2026-04-22', '7000000003', `${PFX}Cust3`, 6000, 'Cash']);
  });
  const j3 = await ImportJob.create({ source: 'excel_payments', status: 'queued', input_file_path: file3, profile_json: { tag: PFX } });
  await runUntilTerminal(j3);
  await j3.reload();
  check('Payments import: 2 posted',
    (j3.result_summary_json || {}).posted === 2,
    `summary=${JSON.stringify(j3.result_summary_json)}`);

  // ── Test 4: re-import customers (all skip) ─────────────
  const file4 = await writeWorkbook((wb) => {
    const ws = wb.addWorksheet('Customers');
    ws.addRow(['Party Name', 'Mobile 1', 'Opening Balance', 'Balance Type']);
    ws.addRow([`${PFX}Cust1`, '7000000001', 0, 'Receivable']);
    ws.addRow([`${PFX}Cust2`, '7000000002', 5000, 'Receivable']);
  });
  const j4 = await ImportJob.create({ source: 'excel_customers', status: 'queued', input_file_path: file4, profile_json: { tag: PFX } });
  await runUntilTerminal(j4);
  await j4.reload();
  check('Re-import customers: 0 posted, 2 skipped',
    (j4.result_summary_json || {}).posted === 0 && (j4.result_summary_json || {}).skipped === 2);

  // ── Test 5: re-import sales with one changed → update ──
  const file5 = await writeWorkbook((wb) => {
    const wsB = wb.addWorksheet('Bills');
    wsB.addRow(['Bill Number', 'Date', 'Customer Mobile', 'Customer Name', 'CGST %', 'SGST %', 'IGST %']);
    wsB.addRow([`${PFX}SAL01`, '2026-04-20', '7000000001', `${PFX}Cust1`, 9, 9, 0]);  // unchanged
    wsB.addRow([`${PFX}SAL02`, '2026-04-21', '7000000003', `${PFX}Cust3`, 0, 0, 18]); // amount changed
    const wsI = wb.addWorksheet('Items');
    wsI.addRow(['Bill Number', 'Product Name', 'Quantity', 'Rate', 'GST %']);
    wsI.addRow([`${PFX}SAL01`, `${PFX}Widget`, 10, 1000, 18]);
    wsI.addRow([`${PFX}SAL02`, `${PFX}Widget`, 10, 2000, 18]);  // qty 5→10
  });
  const j5 = await ImportJob.create({ source: 'excel_sales', status: 'queued', input_file_path: file5, profile_json: { tag: PFX } });
  await runUntilTerminal(j5);
  await j5.reload();
  check('Sales re-import: 1 posted (update)', (j5.result_summary_json || {}).posted === 1);
  check('Sales re-import: 1 skipped (unchanged)', (j5.result_summary_json || {}).skipped === 1);
  const sal2u = await SalesBill.findOne({ where: { bill_number: `${PFX}SAL02` } });
  check('SAL02 updated total = 23,600 (10×2000 + 18%)',
    sal2u && Math.abs(Number(sal2u.total_amount) - 23600) < 0.01,
    `total=${sal2u && sal2u.total_amount}`);

  // ── Test 6: rejected rows ──────────────────────────────
  const file6 = await writeWorkbook((wb) => {
    const ws = wb.addWorksheet('Customers');
    ws.addRow(['Party Name', 'Mobile 1', 'Opening Balance', 'Balance Type']);
    ws.addRow(['', '7000000099', 0, 'Receivable']);   // missing name
    ws.addRow([`${PFX}Bad2`, '', 0, 'Receivable']);    // missing mobile
    ws.addRow([`${PFX}Good`, '7000000098', 0, 'Receivable']); // valid
  });
  const j6 = await ImportJob.create({ source: 'excel_customers', status: 'queued', input_file_path: file6, profile_json: { tag: PFX } });
  await runUntilTerminal(j6);
  await j6.reload();
  check('Rejection: 2 rejected, 1 posted', (j6.result_summary_json || {}).posted === 1 && (j6.result_summary_json || {}).rejected === 2);
  check('Rejected-rows Excel generated', !!j6.rejected_rows_path && fs.existsSync(j6.rejected_rows_path));

  // ── Test 7: GST-disabled flow on sales_bills ───────────
  await preClean();
  await Party.create({ party_type: 'Customer', party_name: `${PFX}Cust1`, mobile_1: '7000000001' });
  await SystemSettings.update({ gst_enabled: false }, { where: { setting_id: 1 } });
  const file7 = await writeWorkbook((wb) => {
    const wsB = wb.addWorksheet('Bills');
    wsB.addRow(['Bill Number', 'Date', 'Customer Mobile', 'Customer Name', 'CGST %', 'SGST %', 'IGST %']);
    wsB.addRow([`${PFX}NOGST`, '2026-04-25', '7000000001', `${PFX}Cust1`, 9, 9, 0]);
    const wsI = wb.addWorksheet('Items');
    wsI.addRow(['Bill Number', 'Product Name', 'Quantity', 'Rate', 'GST %']);
    wsI.addRow([`${PFX}NOGST`, `${PFX}Widget`, 5, 200, 18]);
  });
  const j7 = await ImportJob.create({ source: 'excel_sales', status: 'queued', input_file_path: file7, profile_json: { tag: PFX } });
  await runUntilTerminal(j7);
  await j7.reload();
  check('GST-off sales: status=done', j7.status === 'done', `err=${j7.error_message}`);
  const sNoGst = await SalesBill.findOne({ where: { bill_number: `${PFX}NOGST` } });
  check('GST-off: total = 1,000 (no tax added)', sNoGst && Math.abs(Number(sNoGst.total_amount) - 1000) < 0.01);
  const cgstOut = await LedgerAccount.findOne({ where: { ledger_name: 'CGST Output' } });
  const cgstHits = await LedgerEntry.findAll({ where: { source_type: 'sales_bill', reference_id: sNoGst.sales_bill_id, ledger_id: cgstOut.ledger_id } });
  check('GST-off: zero CGST entries on imported bill', cgstHits.length === 0);

  // ── Cleanup ──
  await preClean();
  await SystemSettings.update({ gst_enabled: true }, { where: { setting_id: 1 } });
  for (const f of [file1, file2, file3, file4, file5, file6, file7]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  console.log('\n── Phase 6 Self-Test ──────────────────────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
