#!/usr/bin/env node
// Phase-5h self-test: products.current_stock must stay in sync with
// SUM(stock_ledger.qty_in − qty_out) through every Excel orchestrator
// write path — fresh sale, fresh purchase, edit (qty change). Plus a
// drift backfill that corrects any product where they diverge.
//
// Run with: node server/scripts/test-phase5h.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');
const {
  sequelize, ImportJob, Party, Product, Category,
  SalesBill, PurchaseBill, StockLedger, SystemSettings,
} = require('../models');
const excelOrchestrator = require('../services/excelImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P5H_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE product_id IN (SELECT product_id FROM products WHERE product_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function runUntilTerminal(job, max = 6) {
  for (let i = 0; i < max; i++) {
    await excelOrchestrator.run(job);
    await job.reload();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return;
    if (job.status === 'awaiting_confirmation') {
      const profile = { ...(job.profile_json || {}), user_choices: { confirmed: true } };
      await job.update({ status: 'queued', profile_json: profile });
    }
  }
}

async function ledgerSum(productId) {
  const rows = await StockLedger.findAll({ where: { product_id: productId } });
  return rows.reduce((s, r) => s + Number(r.quantity_in) - Number(r.quantity_out), 0);
}

async function importExcel(source, build) {
  const p = path.join(os.tmpdir(), `phase5h-${source}-${Date.now()}.xlsx`);
  const wb = new ExcelJS.Workbook();
  build(wb);
  await wb.xlsx.writeFile(p);
  const job = await ImportJob.create({
    source, status: 'queued', input_file_path: p, profile_json: { tag: PFX },
  });
  await runUntilTerminal(job);
  await job.reload();
  return { job, file: p };
}

async function main() {
  await preClean();
  await SystemSettings.update({
    gst_enabled: true,
    financial_year_start: '2025-04-01',
    financial_year_end:   '2026-03-31',
  }, { where: { setting_id: 1 } });

  // Pre-create products with opening stock so Sale and Purchase tests
  // have stock to move. Use the orchestrator's own create path so
  // Phase-5g Opening Stock rows are written too.
  const productsXls = await importExcel('excel_products', (wb) => {
    const ws = wb.addWorksheet('Products');
    ws.addRow(['Product Name', 'Opening Stock', 'Opening Stock Rate', 'Purchase Rate', 'Sale Rate']);
    ws.addRow([`${PFX}A`, 100, 50, 45, 60]);
    ws.addRow([`${PFX}B`, 200, 30, 25, 40]);
  });
  check('Setup: products imported',
    productsXls.job.status === 'done', `err=${productsXls.job.error_message}`);
  const prodA = await Product.findOne({ where: { product_name: `${PFX}A` } });
  const prodB = await Product.findOne({ where: { product_name: `${PFX}B` } });
  check('Setup: A current_stock=100', prodA && Number(prodA.current_stock) === 100);
  check('Setup: A ledger sum=100',     prodA && (await ledgerSum(prodA.product_id)) === 100);

  // Pre-create the customer + supplier the bill rows reference (Excel
  // bill commit uses Party.findOne by mobile or name).
  await Party.create({ party_type: 'Customer', party_name: `${PFX}Cust`, mobile_1: '6500000001' });
  await Party.create({ party_type: 'Supplier', party_name: `${PFX}Sup`,  mobile_1: '6500000002' });

  // ── Test 1: Excel sale → current_stock decremented, ledger row written ──
  const salesXls = await importExcel('excel_sales', (wb) => {
    const wsB = wb.addWorksheet('Bills');
    wsB.addRow(['Bill Number', 'Date', 'Customer Mobile', 'Customer Name', 'CGST %', 'SGST %', 'IGST %']);
    wsB.addRow([`${PFX}SAL-1`, '2025-04-15', '6500000001', `${PFX}Cust`, 9, 9, 0]);
    const wsI = wb.addWorksheet('Items');
    wsI.addRow(['Bill Number', 'Product Name', 'Quantity', 'Rate', 'GST %']);
    wsI.addRow([`${PFX}SAL-1`, `${PFX}A`, 30, 60, 18]);
  });
  check('Sale: status=done', salesXls.job.status === 'done', `err=${salesXls.job.error_message}`);
  await prodA.reload();
  const bill1 = await SalesBill.findOne({ where: { bill_number: `${PFX}SAL-1` } });
  check('Sale: bill row created', !!bill1);
  check('Sale: A.current_stock = 100 − 30 = 70',
    Number(prodA.current_stock) === 70, `current_stock=${prodA.current_stock}`);
  check('Sale: A ledger sum = 70 (matches current_stock)',
    (await ledgerSum(prodA.product_id)) === 70);
  if (bill1) {
    const slRows = await StockLedger.findAll({ where: { reference_id: bill1.sales_bill_id, transaction_type: 'Sales' } });
    check('Sale: stock_ledger row written with quantity_out=30',
      slRows.length === 1 && Number(slRows[0].quantity_out) === 30);
  }

  // ── Test 2: Excel purchase → current_stock incremented ──
  const purXls = await importExcel('excel_purchases', (wb) => {
    const wsB = wb.addWorksheet('Bills');
    wsB.addRow(['Bill Number', 'Date', 'Supplier Mobile', 'Supplier Name', 'CGST %', 'SGST %', 'IGST %']);
    wsB.addRow([`${PFX}PUR-1`, '2025-04-16', '6500000002', `${PFX}Sup`, 9, 9, 0]);
    const wsI = wb.addWorksheet('Items');
    wsI.addRow(['Bill Number', 'Product Name', 'Quantity', 'Rate', 'GST %']);
    wsI.addRow([`${PFX}PUR-1`, `${PFX}A`, 50, 45, 18]);
  });
  check('Purchase: status=done', purXls.job.status === 'done', `err=${purXls.job.error_message}`);
  await prodA.reload();
  check('Purchase: A.current_stock = 70 + 50 = 120',
    Number(prodA.current_stock) === 120, `current_stock=${prodA.current_stock}`);
  check('Purchase: A ledger sum = 120 (matches current_stock)',
    (await ledgerSum(prodA.product_id)) === 120);

  // ── Test 3: Edit Excel sale (qty 30 → 50) ──
  // Re-import the same bill number with a higher qty. The orchestrator
  // reverses the old stock movement, refunds current_stock, then posts
  // the new movement. Net effect: A.current_stock should be 70 (after
  // purchase) − 50 (new sale) = 70.
  // Math walk-through:
  //   Start of test 3: current_stock = 120 (100 op − 30 sold + 50 bought)
  //   Reverse old sale of 30:    + 30  → 150
  //   New sale of 50:            − 50  → 100
  // (different from "100 − 30 + 50 − 50 = 70" because the new total is
  // 50, not 30+50.)
  const editXls = await importExcel('excel_sales', (wb) => {
    const wsB = wb.addWorksheet('Bills');
    wsB.addRow(['Bill Number', 'Date', 'Customer Mobile', 'Customer Name', 'CGST %', 'SGST %', 'IGST %']);
    wsB.addRow([`${PFX}SAL-1`, '2025-04-15', '6500000001', `${PFX}Cust`, 9, 9, 0]);
    const wsI = wb.addWorksheet('Items');
    wsI.addRow(['Bill Number', 'Product Name', 'Quantity', 'Rate', 'GST %']);
    wsI.addRow([`${PFX}SAL-1`, `${PFX}A`, 50, 60, 18]);   // qty 30 → 50
  });
  check('Edit: status=done', editXls.job.status === 'done', `err=${editXls.job.error_message}`);
  check('Edit: 1 update committed',
    (editXls.job.result_summary_json || {}).posted === 1
    && (editXls.job.result_summary_json || {}).failed === 0,
    `summary=${JSON.stringify(editXls.job.result_summary_json)}`);
  await prodA.reload();
  check('Edit: A.current_stock = 100 − 50 + 50 = 100',
    Number(prodA.current_stock) === 100, `current_stock=${prodA.current_stock}`);
  check('Edit: A ledger sum = 100 (matches current_stock; no leak from old qty=30)',
    (await ledgerSum(prodA.product_id)) === 100);

  // ── Test 4: Drift backfill — cross-check + correction ──
  // Manually corrupt prodB.current_stock to simulate pre-fix drift.
  // ledger sum should be 200 (just opening); current_stock will be 175.
  await Product.update({ current_stock: 175 }, { where: { product_id: prodB.product_id } });
  await prodB.reload();
  check('Backfill setup: B.current_stock corrupted to 175',
    Number(prodB.current_stock) === 175);
  check('Backfill setup: B ledger sum still 200 (opening)',
    (await ledgerSum(prodB.product_id)) === 200);

  // Run backfill.
  execSync(`node ${path.join(__dirname, 'backfill-current-stock.js')}`, { stdio: 'pipe' });
  await prodB.reload();
  check('Backfill: B.current_stock corrected to 200 (from ledger)',
    Number(prodB.current_stock) === 200);
  // Re-run = no-op.
  const before = await Product.findAll({ attributes: ['product_id', 'current_stock'] });
  execSync(`node ${path.join(__dirname, 'backfill-current-stock.js')}`, { stdio: 'pipe' });
  const after = await Product.findAll({ attributes: ['product_id', 'current_stock'] });
  const diffs = before.filter((b, i) => Number(b.current_stock) !== Number(after[i].current_stock));
  check('Backfill: idempotent (re-run is no-op)', diffs.length === 0);

  // ── Test 5: Stock Integrity API surface ──
  // Hit the controller directly, not via HTTP.
  const ledgerCtrl = require('../controllers/ledgerController');
  const apiResp = await new Promise((resolve, reject) => {
    const req = {};
    const res = { status(c) { this._s = c; return this; }, json(b) { resolve({ status: this._s || 200, body: b }); } };
    ledgerCtrl.integrity(req, res).catch(reject);
  });
  check('Integrity API: stock section present',
    !!apiResp.body.stock && typeof apiResp.body.stock.drifted_count === 'number',
    `body=${JSON.stringify(apiResp.body && apiResp.body.stock)}`);
  check('Integrity API: zero drift after backfill',
    apiResp.body.stock && apiResp.body.stock.drifted_count === 0
    && apiResp.body.stock.balanced === true);

  // Cleanup
  await preClean();
  try { fs.unlinkSync(productsXls.file); } catch (_) {}
  try { fs.unlinkSync(salesXls.file);    } catch (_) {}
  try { fs.unlinkSync(purXls.file);      } catch (_) {}
  try { fs.unlinkSync(editXls.file);     } catch (_) {}
  await SystemSettings.update({
    financial_year_start: '2026-04-01', financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase 5h Self-Test (current_stock ↔ stock_ledger sync) ──');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
