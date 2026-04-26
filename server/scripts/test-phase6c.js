#!/usr/bin/env node
// Phase-6c self-test: Excel purchase_bills round-trip.
//
// Reproduces the spot-check bug: with 8 purchase bills carrying a "Rate"
// column on the items sheet, every row got rejected with
// "PurchaseBillItem.purchase_rate cannot be null" because the orchestrator
// was writing `rate` (the SalesBillItem column) regardless of template.
//
// Tests:
//   1. Excel purchase_bills import — all 8 bills posted, ledger balanced,
//      PurchaseBillItem.purchase_rate matches the workbook's Rate column,
//      purchase-only header fields (Supplier Bill No, Transport, Vehicle
//      No) carry through to the bill row.
//   2. Excel sales_bills import (regression) — still works as before.
//
// Run with: node server/scripts/test-phase6c.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const ExcelJS = require('exceljs');
const {
  sequelize, ImportJob, Party, Product,
  SalesBill, SalesBillItem, PurchaseBill, PurchaseBillItem,
  LedgerEntry, SystemSettings,
} = require('../models');
const orchestrator = require('../services/excelImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P6C_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
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

  // ── Test 1: Purchase bills (the failing case) ──────────
  // 8 bills, 1 item each. Rate values intentionally differ per bill so
  // we can verify each lands on the right purchase_rate field.
  const purWb = new ExcelJS.Workbook();
  const pBills = purWb.addWorksheet('Bills');
  pBills.addRow([
    'Bill Number', 'Date', 'Supplier Mobile', 'Supplier Name',
    'CGST %', 'SGST %', 'IGST %',
    'Supplier Bill No', 'Transport', 'Vehicle No',
  ]);
  const RATES = [100, 200, 300, 400, 500, 600, 700, 800];
  for (let i = 0; i < 8; i++) {
    const n = i + 1;
    pBills.addRow([
      `${PFX}PUR${String(n).padStart(2, '0')}`, '2026-04-25',
      `90000000${String(n).padStart(2, '0')}`, `${PFX}Sup${n}`,
      9, 9, 0,
      `SUP-INV-${n}`, `Transport ${n}`, `MH${n}-AB-${n}`,
    ]);
  }
  const pItems = purWb.addWorksheet('Items');
  pItems.addRow(['Bill Number', 'Barcode', 'Product Name', 'Category', 'HSN', 'Quantity', 'Rate', 'GST %', 'Unit']);
  for (let i = 0; i < 8; i++) {
    const n = i + 1;
    pItems.addRow([
      `${PFX}PUR${String(n).padStart(2, '0')}`,
      '', `${PFX}Widget`, 'Widgets', '', 5, RATES[i], 18, 'Pcs',
    ]);
  }
  const purFile = path.join(os.tmpdir(), `phase6c-pur-${Date.now()}.xlsx`);
  await purWb.xlsx.writeFile(purFile);

  const purJob = await ImportJob.create({
    source: 'excel_purchases', status: 'queued',
    input_file_path: purFile, profile_json: { tag: PFX },
  });
  await runUntilTerminal(purJob);
  await purJob.reload();
  check('Purchase bills: status=done', purJob.status === 'done',
    `status=${purJob.status} err=${purJob.error_message} summary=${JSON.stringify(purJob.result_summary_json)}`);
  check('Purchase bills: 8 posted, 0 failed',
    (purJob.result_summary_json || {}).posted === 8 && (purJob.result_summary_json || {}).failed === 0,
    `summary=${JSON.stringify(purJob.result_summary_json)}`);

  // Verify each bill + item.
  for (let i = 0; i < 8; i++) {
    const n = i + 1;
    const billNum = `${PFX}PUR${String(n).padStart(2, '0')}`;
    const bill = await PurchaseBill.findOne({
      where: { bill_number: billNum },
      include: [{ model: PurchaseBillItem, as: 'items' }],
    });
    if (!bill) { check(`Purchase ${billNum}: bill row exists`, false); continue; }
    check(`Purchase ${billNum}: 1 item row inserted`, bill.items.length === 1);
    const it = bill.items[0];
    if (it) {
      check(`Purchase ${billNum}: purchase_rate populated (${RATES[i]})`,
        Number(it.purchase_rate) === RATES[i],
        `got purchase_rate=${it.purchase_rate}`);
    }
    // Header fields carried through.
    check(`Purchase ${billNum}: Supplier Bill No persisted`,
      bill.supplier_bill_number === `SUP-INV-${n}`,
      `got '${bill.supplier_bill_number}'`);
    check(`Purchase ${billNum}: Transport persisted`,
      bill.transport_name === `Transport ${n}`);
    check(`Purchase ${billNum}: Vehicle No persisted`,
      bill.vehicle_number === `MH${n}-AB-${n}`);
  }

  // Ledger balanced for one of the imported bills.
  const sample = await PurchaseBill.findOne({ where: { bill_number: `${PFX}PUR01` } });
  if (sample) {
    const e = await LedgerEntry.findAll({ where: { source_type: 'purchase_bill', reference_id: sample.purchase_bill_id } });
    const dr = e.reduce((s, x) => s + Number(x.debit_amount), 0);
    const cr = e.reduce((s, x) => s + Number(x.credit_amount), 0);
    check('Purchase bills: ledger balanced (Dr=Cr)', dr === cr && dr > 0,
      `dr=${dr} cr=${cr}`);
  }

  // ── Test 2: Sales bills regression ─────────────────────
  const salWb = new ExcelJS.Workbook();
  const sBills = salWb.addWorksheet('Bills');
  sBills.addRow(['Bill Number', 'Date', 'Customer Mobile', 'Customer Name', 'CGST %', 'SGST %', 'IGST %']);
  sBills.addRow([`${PFX}SAL01`, '2026-04-25', '8000000001', `${PFX}Cust1`, 9, 9, 0]);
  const sItems = salWb.addWorksheet('Items');
  sItems.addRow(['Bill Number', 'Product Name', 'Quantity', 'Rate', 'GST %']);
  sItems.addRow([`${PFX}SAL01`, `${PFX}Widget`, 5, 1000, 18]);
  const salFile = path.join(os.tmpdir(), `phase6c-sal-${Date.now()}.xlsx`);
  await salWb.xlsx.writeFile(salFile);

  const salJob = await ImportJob.create({
    source: 'excel_sales', status: 'queued',
    input_file_path: salFile, profile_json: { tag: PFX },
  });
  await runUntilTerminal(salJob);
  await salJob.reload();
  check('Sales regression: status=done', salJob.status === 'done',
    `err=${salJob.error_message} summary=${JSON.stringify(salJob.result_summary_json)}`);
  check('Sales regression: 1 posted',
    (salJob.result_summary_json || {}).posted === 1);
  const sBill = await SalesBill.findOne({
    where: { bill_number: `${PFX}SAL01` },
    include: [{ model: SalesBillItem, as: 'items' }],
  });
  check('Sales regression: SalesBillItem.rate populated (1000)',
    sBill && sBill.items[0] && Number(sBill.items[0].rate) === 1000,
    `got rate=${sBill && sBill.items[0] && sBill.items[0].rate}`);

  // ── Cleanup ──
  await preClean();
  try { fs.unlinkSync(purFile); } catch (_) {}
  try { fs.unlinkSync(salFile); } catch (_) {}

  console.log('\n── Phase 6c Self-Test (purchase rate field) ──────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
