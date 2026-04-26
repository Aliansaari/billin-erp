#!/usr/bin/env node
// Phase-5g self-test: products imported via Excel or Tally must write
// an 'Opening Stock' row to stock_ledger when opening_stock > 0.
// Without it, Stock Movement views show Opening=0 even though
// products.current_stock equals the imported qty, and the first sale
// produces a negative running balance.
//
// Tests cover:
//   • Excel product import with Opening Stock + Opening Stock Rate
//   • Tally <STOCKITEM> with <OPENINGBALANCE>
//   • Product with no opening — no Opening row, no orphan
//   • Opening + a Sale — closing balance is opening − sold (not negative)
//   • Backfill on a pre-fix product
//   • Backfill idempotency
//
// Run with: node server/scripts/test-phase5g.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');
const {
  sequelize, ImportJob, Party, Product, Category,
  SalesBill, SalesBillItem, StockLedger, SystemSettings,
} = require('../models');
const excelOrchestrator = require('../services/excelImportOrchestrator');
const tallyOrchestrator = require('../services/tallyImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P5G_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE product_id IN (SELECT product_id FROM products WHERE product_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function runUntilTerminal(orchestrator, job, maxIterations = 8) {
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

async function main() {
  await preClean();
  await SystemSettings.update({
    gst_enabled: true,
    financial_year_start: '2025-04-01',
    financial_year_end:   '2026-03-31',
  }, { where: { setting_id: 1 } });

  // ── Test 1: Excel product import with Opening Stock + Rate ──
  const xlsPath = path.join(os.tmpdir(), `phase5g-products-${Date.now()}.xlsx`);
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Products');
    ws.addRow(['Product Name', 'Opening Stock', 'Opening Stock Rate', 'Purchase Rate', 'Sale Rate']);
    ws.addRow([`${PFX}Cotton`, 100, 50, 45, 60]);
    ws.addRow([`${PFX}NoOpening`, 0, 0, 30, 40]);   // no opening — no Opening Stock row
    await wb.xlsx.writeFile(xlsPath);
  }
  const j1 = await ImportJob.create({
    source: 'excel_products', status: 'queued',
    input_file_path: xlsPath, profile_json: { tag: PFX },
  });
  await runUntilTerminal(excelOrchestrator, j1);
  await j1.reload();
  check('Excel: import done', j1.status === 'done', `err=${j1.error_message}`);

  const cotton = await Product.findOne({ where: { product_name: `${PFX}Cotton` } });
  check('Excel: product row exists', !!cotton);
  if (cotton) {
    const opening = await StockLedger.findAll({
      where: { product_id: cotton.product_id, transaction_type: 'Opening Stock' },
    });
    check('Excel: 1 Opening Stock ledger row',
      opening.length === 1, `got ${opening.length}`);
    if (opening[0]) {
      check('Excel: opening qty=100, rate=50',
        Number(opening[0].quantity_in) === 100 && Number(opening[0].rate) === 50,
        `qty=${opening[0].quantity_in} rate=${opening[0].rate}`);
      check('Excel: opening date = FY start - 1 day (2025-03-31)',
        String(opening[0].transaction_date) === '2025-03-31',
        `date=${opening[0].transaction_date}`);
      check('Excel: opening reference_number=OPENING',
        opening[0].reference_number === 'OPENING');
    }
    check('Excel: products.current_stock=100', Number(cotton.current_stock) === 100);
  }

  const noOpen = await Product.findOne({ where: { product_name: `${PFX}NoOpening` } });
  check('Excel: zero-opening product has NO Opening Stock row',
    noOpen && (await StockLedger.count({
      where: { product_id: noOpen.product_id, transaction_type: 'Opening Stock' },
    })) === 0);

  // ── Test 2: Tally <STOCKITEM> with <OPENINGBALANCE> ──
  const tallyXml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><STOCKITEM NAME="${PFX}Silk"><NAME>${PFX}Silk</NAME><BASEUNITS>Pcs</BASEUNITS><GSTRATE>5</GSTRATE><OPENINGBALANCE>200 Pcs</OPENINGBALANCE></STOCKITEM></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const tallyPath = path.join(os.tmpdir(), `phase5g-tally-${Date.now()}.xml`);
  fs.writeFileSync(tallyPath, tallyXml, 'utf-8');
  const j2 = await ImportJob.create({
    source: 'tally', status: 'queued',
    input_file_path: tallyPath, profile_json: { tag: PFX },
  });
  await runUntilTerminal(tallyOrchestrator, j2);
  await j2.reload();
  check('Tally: import done', j2.status === 'done', `err=${j2.error_message}`);
  const silk = await Product.findOne({ where: { product_name: `${PFX}Silk` } });
  check('Tally: product row exists', !!silk);
  if (silk) {
    const opening = await StockLedger.findAll({
      where: { product_id: silk.product_id, transaction_type: 'Opening Stock' },
    });
    check('Tally: 1 Opening Stock ledger row', opening.length === 1, `got ${opening.length}`);
    if (opening[0]) {
      check('Tally: opening qty=200',
        Number(opening[0].quantity_in) === 200,
        `qty=${opening[0].quantity_in}`);
      check('Tally: opening date = FY start - 1 day',
        String(opening[0].transaction_date) === '2025-03-31');
    }
    check('Tally: products.current_stock=200', Number(silk.current_stock) === 200);
  }

  // ── Test 3: Re-import of same Tally STOCKITEM is idempotent ──
  const j2b = await ImportJob.create({
    source: 'tally', status: 'queued',
    input_file_path: tallyPath, profile_json: { tag: PFX },
  });
  await runUntilTerminal(tallyOrchestrator, j2b);
  await j2b.reload();
  if (silk) {
    const opening = await StockLedger.findAll({
      where: { product_id: silk.product_id, transaction_type: 'Opening Stock' },
    });
    check('Tally: re-import does NOT duplicate the Opening Stock row',
      opening.length === 1, `got ${opening.length} after re-import`);
  }

  // ── Test 4: Opening + a Sale → closing = opening − sold ──
  // Use Cotton (opening=100). Post a Sale for 30. Closing should be 70.
  if (cotton) {
    const cust = await Party.create({
      party_type: 'Customer', party_name: `${PFX}CustForStock`, mobile_1: '7777777777',
    });
    const t = await sequelize.transaction();
    const saleBill = await SalesBill.create({
      bill_number: `${PFX}STK-001`, bill_date: '2025-04-15',
      customer_id: cust.party_id,
      sub_total: 1500, total_amount: 1500,
      balance_amount: 1500, payment_status: 'Unpaid',
    }, { transaction: t });
    await SalesBillItem.create({
      sales_bill_id: saleBill.sales_bill_id,
      product_id: cotton.product_id,
      barcode: cotton.barcode,
      product_name: cotton.product_name,
      quantity: 30, rate: 50,
      mrp: 0, taxable_amount: 1500, total_amount: 1500,
    }, { transaction: t });
    await StockLedger.create({
      product_id: cotton.product_id, barcode: cotton.barcode,
      transaction_type: 'Sales', transaction_date: '2025-04-15',
      reference_id: saleBill.sales_bill_id, reference_number: saleBill.bill_number,
      quantity_in: 0, quantity_out: 30, rate: 50, balance_quantity: 70,
    }, { transaction: t });
    await t.commit();

    const allRows = await StockLedger.findAll({
      where: { product_id: cotton.product_id },
      order: [['transaction_date', 'ASC'], ['ledger_id', 'ASC']],
    });
    const totIn  = allRows.reduce((s, r) => s + Number(r.quantity_in),  0);
    const totOut = allRows.reduce((s, r) => s + Number(r.quantity_out), 0);
    const closing = totIn - totOut;
    check('Sale after Opening: closing = 100 − 30 = 70 (not negative)',
      closing === 70, `closing=${closing}`);
    const openingRow = allRows.find((r) => r.transaction_type === 'Opening Stock');
    check('Sale after Opening: Opening row sorts before Sale row (by date)',
      openingRow && allRows[0].transaction_type === 'Opening Stock');
  }

  // ── Test 5: Backfill on a pre-fix product ──
  // Simulate a product imported before the fix: opening_stock + current_stock
  // populated, but no Opening Stock ledger row.
  const cat = (await Category.findOrCreate({ where: { category_name: 'Imported from Tally' } }))[0];
  const orphan = await Product.create({
    product_name: `${PFX}Orphan`,
    barcode: `P5G-ORPH-${Date.now()}`.slice(0, 20),
    category_id: cat.category_id,
    opening_stock: 50,
    current_stock: 50,
    purchase_rate: 25, sale_rate: 40,
  });
  // Pre-condition: no Opening Stock row.
  check('Backfill setup: orphan product has 0 Opening Stock rows',
    (await StockLedger.count({
      where: { product_id: orphan.product_id, transaction_type: 'Opening Stock' },
    })) === 0);

  // Run the backfill script.
  execSync(`node ${path.join(__dirname, 'backfill-opening-stock.js')}`, { stdio: 'pipe' });

  const orphanOpening = await StockLedger.findAll({
    where: { product_id: orphan.product_id, transaction_type: 'Opening Stock' },
  });
  check('Backfill: 1 Opening Stock row written', orphanOpening.length === 1);
  if (orphanOpening[0]) {
    check('Backfill: opening qty=50 (matches products.opening_stock)',
      Number(orphanOpening[0].quantity_in) === 50);
    check('Backfill: opening rate=25 (purchase_rate fallback)',
      Number(orphanOpening[0].rate) === 25);
  }
  // current_stock untouched.
  await orphan.reload();
  check('Backfill: products.current_stock unchanged (still 50)',
    Number(orphan.current_stock) === 50);

  // ── Test 6: Backfill idempotency ──
  execSync(`node ${path.join(__dirname, 'backfill-opening-stock.js')}`, { stdio: 'pipe' });
  const orphanOpening2 = await StockLedger.findAll({
    where: { product_id: orphan.product_id, transaction_type: 'Opening Stock' },
  });
  check('Backfill: re-run is idempotent (still exactly 1 Opening row)',
    orphanOpening2.length === 1);

  // Cleanup
  await preClean();
  try { fs.unlinkSync(xlsPath);   } catch (_) {}
  try { fs.unlinkSync(tallyPath); } catch (_) {}
  await SystemSettings.update({
    financial_year_start: '2026-04-01',
    financial_year_end:   '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase 5g Self-Test (Opening Stock ledger row) ─────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
