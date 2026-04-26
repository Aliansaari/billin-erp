#!/usr/bin/env node
// Phase-5f self-test: Tally orchestrator must write line-item rows for
// Sales / Purchase / Credit Note / Debit Note vouchers. Earlier the
// orchestrator only wrote bill headers + ledger entries — items and
// stock movements were silently missing for every Tally-imported bill.
//
// Run with: node server/scripts/test-phase5f.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  sequelize, ImportJob, Party, Product,
  SalesBill, SalesBillItem, PurchaseBill, PurchaseBillItem,
  SalesReturnBill, SalesReturnBillItem,
  PurchaseReturnBill, PurchaseReturnBillItem,
  StockLedger, SystemSettings,
} = require('../models');
const orchestrator = require('../services/tallyImportOrchestrator');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__P5F_';

async function preClean() {
  await sequelize.query(`DELETE FROM ledger_entries WHERE reference_number LIKE '${PFX}%' OR narration LIKE '%${PFX}%' OR reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_return_bill_items WHERE sales_return_id IN (SELECT sales_return_id FROM sales_return_bills WHERE return_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_return_bills WHERE return_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_return_bill_items WHERE purchase_return_id IN (SELECT purchase_return_id FROM purchase_return_bills WHERE return_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_return_bills WHERE return_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM stock_ledger WHERE reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name LIKE '${PFX}% (#%)'`);
  await sequelize.query(`DELETE FROM import_batches WHERE import_job_id IN (SELECT id FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}')`);
  await sequelize.query(`DELETE FROM import_jobs WHERE (profile_json->>'tag') = '${PFX}'`);
}

async function writeXml(content) {
  const p = path.join(os.tmpdir(), `phase5f-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
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
    gst_enabled: true, financial_year_start: '2025-04-01', financial_year_end: '2026-03-31',
  }, { where: { setting_id: 1 } });

  const stockMaster = (name) => `<STOCKITEM NAME="${name}"><NAME>${name}</NAME><BASEUNITS>Pcs</BASEUNITS><GSTRATE>18</GSTRATE><OPENINGBALANCE>0</OPENINGBALANCE></STOCKITEM>`;
  const ledgerMaster = (name, parent, opening = 0) =>
    `<LEDGER NAME="${name}"><NAME>${name}</NAME><PARENT>${parent}</PARENT><OPENINGBALANCE>${opening}</OPENINGBALANCE></LEDGER>`;

  // ── Test 1: Sales bill with 1 line item ──────────────────
  const xml1 = envelope([
    ledgerMaster(`${PFX}Cust`, 'Sundry Debtors'),
    stockMaster(`${PFX}Widget`),
  ], [
    `<VOUCHER VCHTYPE="Sales" ACTION="Create">
      <DATE>20250415</DATE>
      <VOUCHERNUMBER>${PFX}TS-1001</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}Cust</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Cust</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${PFX}Widget</STOCKITEMNAME><ACTUALQTY>10 Pcs</ACTUALQTY><RATE>1000/Pcs</RATE><AMOUNT>-10000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file1 = await writeXml(xml1);
  const j1 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file1, profile_json: { tag: PFX } });
  await runUntilTerminal(j1);
  await j1.reload();
  check('Sales 1-line: status=done', j1.status === 'done', `err=${j1.error_message}`);
  const sb1 = await SalesBill.findOne({
    where: { bill_number: `${PFX}TS-1001` },
    include: [{ model: SalesBillItem, as: 'items' }],
  });
  check('Sales 1-line: bill row exists', !!sb1);
  check('Sales 1-line: exactly 1 item row', sb1 && sb1.items.length === 1, `got ${sb1 && sb1.items.length}`);
  if (sb1 && sb1.items[0]) {
    const it = sb1.items[0];
    const wid = await Product.findOne({ where: { product_name: `${PFX}Widget` } });
    check('Sales item: product_id resolved', wid && it.product_id === wid.product_id);
    check('Sales item: quantity=10', Number(it.quantity) === 10);
    check('Sales item: rate=1000',  Number(it.rate) === 1000);
    check('Sales item: gst_rate populated', Number(it.gst_rate) > 0);
    check('Sales item: taxable_amount=10000', Math.abs(Number(it.taxable_amount) - 10000) < 0.01);
  }
  // Stock movement
  if (sb1) {
    const sl = await StockLedger.findAll({ where: { reference_id: sb1.sales_bill_id, transaction_type: 'Sales' } });
    check('Sales 1-line: stock_ledger row exists with quantity_out=10',
      sl.length === 1 && Number(sl[0].quantity_out) === 10);
  }

  // ── Test 2: Sales bill with 3 line items ─────────────────
  const xml2 = envelope([
    ledgerMaster(`${PFX}Cust2`, 'Sundry Debtors'),
    stockMaster(`${PFX}Widget`), stockMaster(`${PFX}Gadget`), stockMaster(`${PFX}Gizmo`),
  ], [
    `<VOUCHER VCHTYPE="Sales" ACTION="Create">
      <DATE>20250416</DATE>
      <VOUCHERNUMBER>${PFX}TS-1002</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}Cust2</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Cust2</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>17700.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-15000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1350.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1350.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${PFX}Widget</STOCKITEMNAME><ACTUALQTY>5 Pcs</ACTUALQTY><RATE>1000/Pcs</RATE><AMOUNT>-5000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${PFX}Gadget</STOCKITEMNAME><ACTUALQTY>2 Pcs</ACTUALQTY><RATE>2500/Pcs</RATE><AMOUNT>-5000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${PFX}Gizmo</STOCKITEMNAME><ACTUALQTY>1 Pcs</ACTUALQTY><RATE>5000/Pcs</RATE><AMOUNT>-5000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file2 = await writeXml(xml2);
  const j2 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file2, profile_json: { tag: PFX } });
  await runUntilTerminal(j2);
  await j2.reload();
  check('Sales 3-line: status=done', j2.status === 'done', `err=${j2.error_message}`);
  const sb2 = await SalesBill.findOne({
    where: { bill_number: `${PFX}TS-1002` },
    include: [{ model: SalesBillItem, as: 'items' }],
  });
  check('Sales 3-line: exactly 3 item rows', sb2 && sb2.items.length === 3,
    `got ${sb2 && sb2.items.length}`);
  if (sb2) {
    const sl = await StockLedger.findAll({ where: { reference_id: sb2.sales_bill_id, transaction_type: 'Sales' } });
    check('Sales 3-line: 3 stock_ledger rows', sl.length === 3);
  }

  // ── Test 3: Purchase bill with line items + purchase_rate ─
  const xml3 = envelope([
    ledgerMaster(`${PFX}Sup`, 'Sundry Creditors'),
    stockMaster(`${PFX}Widget`),
  ], [
    `<VOUCHER VCHTYPE="Purchase" ACTION="Create">
      <DATE>20250417</DATE>
      <VOUCHERNUMBER>${PFX}TP-2001</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}Sup</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}Sup</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-7080.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase A/c</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>6000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Input</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>540.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Input</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>540.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${PFX}Widget</STOCKITEMNAME><ACTUALQTY>10 Pcs</ACTUALQTY><RATE>600/Pcs</RATE><AMOUNT>6000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file3 = await writeXml(xml3);
  const j3 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file3, profile_json: { tag: PFX } });
  await runUntilTerminal(j3);
  await j3.reload();
  check('Purchase: status=done', j3.status === 'done', `err=${j3.error_message}`);
  const pb = await PurchaseBill.findOne({
    where: { bill_number: `${PFX}TP-2001` },
    include: [{ model: PurchaseBillItem, as: 'items' }],
  });
  check('Purchase: 1 item row', pb && pb.items.length === 1);
  if (pb && pb.items[0]) {
    const it = pb.items[0];
    check('Purchase item: purchase_rate=600 (NOT NULL satisfied)',
      Number(it.purchase_rate) === 600, `got purchase_rate=${it.purchase_rate}`);
    check('Purchase item: sale_rate populated', Number(it.sale_rate) > 0);
    check('Purchase item: quantity=10', Number(it.quantity) === 10);
  }
  if (pb) {
    const sl = await StockLedger.findAll({ where: { reference_id: pb.purchase_bill_id, transaction_type: 'Purchase' } });
    check('Purchase: stock_ledger has quantity_in=10',
      sl.length === 1 && Number(sl[0].quantity_in) === 10);
  }

  // ── Test 4: Credit Note with line items ─────────────────
  const xml4 = envelope([
    ledgerMaster(`${PFX}CustCN`, 'Sundry Debtors'),
    stockMaster(`${PFX}Widget`),
  ], [
    `<VOUCHER VCHTYPE="Credit Note" ACTION="Create">
      <DATE>20250420</DATE>
      <VOUCHERNUMBER>${PFX}TCN-1</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}CustCN</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}CustCN</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-5900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Return</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>450.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>450.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${PFX}Widget</STOCKITEMNAME><ACTUALQTY>5 Pcs</ACTUALQTY><RATE>1000/Pcs</RATE><AMOUNT>5000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file4 = await writeXml(xml4);
  const j4 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file4, profile_json: { tag: PFX } });
  await runUntilTerminal(j4);
  await j4.reload();
  check('Credit Note: status=done', j4.status === 'done', `err=${j4.error_message}`);
  const ret = await SalesReturnBill.findOne({
    where: { return_number: `${PFX}TCN-1` },
    include: [{ model: SalesReturnBillItem, as: 'items' }],
  });
  check('Credit Note: 1 return item row', ret && ret.items.length === 1);
  if (ret && ret.items[0]) {
    const it = ret.items[0];
    check('Credit Note item: rate=1000', Number(it.rate) === 1000);
    check('Credit Note item: quantity=5', Number(it.quantity) === 5);
  }

  // ── Test 5: Sales list query returns correct items count ─
  // Mirror the controller's join for the list view; prove the items
  // come back rather than being silently dropped.
  if (sb2) {
    const fresh = await SalesBill.findByPk(sb2.sales_bill_id, {
      include: [{ model: SalesBillItem, as: 'items' }],
    });
    const itemCount = (fresh.items || []).length;
    const totalQty = (fresh.items || []).reduce((s, x) => s + Number(x.quantity), 0);
    check('Sales list: TS-1002 itemCount=3, totalQty=8',
      itemCount === 3 && totalQty === 8,
      `count=${itemCount} qty=${totalQty}`);
  }

  // ── Test 6: Sales edit-view payload — items present, fields populated ──
  if (sb1) {
    const editPayload = await SalesBill.findByPk(sb1.sales_bill_id, {
      include: [
        { model: SalesBillItem, as: 'items' },
        { model: Party, as: 'customer' },
      ],
    });
    const ok = editPayload && editPayload.items && editPayload.items.length === 1
      && editPayload.items[0].product_name && Number(editPayload.items[0].quantity) > 0
      && Number(editPayload.items[0].rate) > 0;
    check('Sales edit view: TS-1001 has 1 item with name+qty+rate', !!ok,
      `items=${editPayload && JSON.stringify(editPayload.items.map((i) => ({ n: i.product_name, q: i.quantity, r: i.rate })))}`);
  }

  // ── Test 7: Validate-phase guard — unknown stock item ────
  // Voucher references "Phantom" which has no <STOCKITEM> master and
  // doesn't exist in products. Must reject in preview, not at commit.
  const xml7 = envelope([
    ledgerMaster(`${PFX}CustG`, 'Sundry Debtors'),
  ], [
    `<VOUCHER VCHTYPE="Sales" ACTION="Create">
      <DATE>20250421</DATE>
      <VOUCHERNUMBER>${PFX}TS-GHOST</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${PFX}CustG</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>${PFX}CustG</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>CGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>SGST @ 9% Output</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${PFX}Phantom</STOCKITEMNAME><ACTUALQTY>1 Pcs</ACTUALQTY><RATE>1000/Pcs</RATE><AMOUNT>-1000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
    </VOUCHER>`,
  ]);
  const file7 = await writeXml(xml7);
  const j7 = await ImportJob.create({ source: 'tally', status: 'queued', input_file_path: file7, profile_json: { tag: PFX } });
  // Drive only parse+validate; assert on preview.
  await orchestrator.run(j7);
  await j7.reload();
  check('Unknown stock: paused at awaiting_confirmation', j7.status === 'awaiting_confirmation');
  const rejSample = (j7.preview_json && j7.preview_json.sample && j7.preview_json.sample.reject) || [];
  const ghost = rejSample.find((r) => r.voucher_number === `${PFX}TS-GHOST`);
  check('Unknown stock: rejected in preview',
    !!ghost, `rejSample=${JSON.stringify(rejSample)}`);
  check('Unknown stock: reason mentions stock item not found',
    ghost && /stock item.*not found/i.test(ghost.reason || ''),
    `reason='${ghost && ghost.reason}'`);
  await runUntilTerminal(j7);
  await j7.reload();
  const orphan = await SalesBill.findOne({ where: { bill_number: `${PFX}TS-GHOST` } });
  check('Unknown stock: NO bill row created', !orphan);

  // ── Cleanup ──
  await preClean();
  for (const f of [file1, file2, file3, file4, file7]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  await SystemSettings.update({
    financial_year_start: '2026-04-01', financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase 5f Self-Test (Tally bill items + stock ledger) ──');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
