#!/usr/bin/env node
// Phase-R9 self-test: import-time bill_payment_allocations.
//
// Drives billAllocationService + Tally XML parser + Excel orchestrator
// helpers + Tally orchestrator validate-phase guard + end-to-end commit
// paths on synthetic fixtures.
//
// Coverage map (one line per case):
//
//   1.x  schema (allocation_method enum extended)         3 checks
//   2.x  billAllocationService.resolveBillReferences      3 checks
//   3.x  billAllocationService.fifoAllocate               3 checks
//   4.x  billAllocationService.applyAllocations           3 checks
//   5.x  billAllocationService.allocateForReceipt         4 checks
//   6.x  Tally XML parser BILLALLOCATIONS extraction      3 checks
//   7.x  Excel orchestrator parseBillReferenceCell        3 checks
//   8.x  Excel orchestrator end-to-end commit + alloc     3 checks
//   9.x  Tally orchestrator validate-phase guard          2 checks
//
// Run: node server/scripts/test-phase-r9.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const { Party, SalesBill, PurchaseBill, PaymentReceipt } = require('../models');
const billSvc = require('../services/billAllocationService');
const { parseVouchers } = require('../utils/tallyXmlParser');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__R9_';
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// ── Test fixtures (per-run, prefixed for safe re-runs) ────────────────
let custParty, supplParty;
let salesBills = [];     // sorted by date asc
let purchaseBills = [];

async function preClean() {
  // Allocations come first (FK to payments_receipts).
  await sequelize.query(`
    DELETE FROM bill_payment_allocations
     WHERE transaction_id IN (
       SELECT transaction_id FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'
     )
  `);
  await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM purchase_bill_items WHERE purchase_bill_id IN (SELECT purchase_bill_id FROM purchase_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM purchase_bills WHERE bill_number LIKE '${PFX}%'`);
  // Test 8 (Excel e2e) posts vouchers via the orchestrator's commit
  // path, which creates ledger_entries tied to the test party. Drop
  // those before the party row so the FK doesn't block the delete.
  await sequelize.query(`
    DELETE FROM ledger_entries
     WHERE party_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%')
        OR ledger_id IN (SELECT ledger_id FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%')
  `);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%'`);
}

async function setupFixtures() {
  custParty = await Party.create({
    party_name: `${PFX}Customer A`, party_type: 'Customer',
    mobile_1: '9000000901', opening_balance: 0,
  });
  supplParty = await Party.create({
    party_name: `${PFX}Supplier A`, party_type: 'Supplier',
    mobile_1: '9000000902', opening_balance: 0,
  });

  // Three sales bills for FIFO ordering tests: 2025-01-10 ₹3000,
  // 2025-02-10 ₹2000, 2025-03-10 ₹5000. All unpaid initially.
  const billDefs = [
    { num: `${PFX}SI-001`, date: '2025-01-10', amt: 3000 },
    { num: `${PFX}SI-002`, date: '2025-02-10', amt: 2000 },
    { num: `${PFX}SI-003`, date: '2025-03-10', amt: 5000 },
  ];
  salesBills = [];
  for (const b of billDefs) {
    const row = await SalesBill.create({
      bill_number: b.num, customer_id: custParty.party_id,
      bill_date: b.date,
      sub_total: b.amt, total_amount: b.amt,
      paid_amount: 0, balance_amount: b.amt, payment_status: 'Unpaid',
      total_items: 0, total_quantity: 0,
    });
    salesBills.push(row);
  }

  // Two purchase bills: 2025-01-15 ₹4000, 2025-02-15 ₹2500.
  const purDefs = [
    { num: `${PFX}PI-001`, date: '2025-01-15', amt: 4000 },
    { num: `${PFX}PI-002`, date: '2025-02-15', amt: 2500 },
  ];
  purchaseBills = [];
  for (const b of purDefs) {
    const row = await PurchaseBill.create({
      bill_number: b.num, supplier_id: supplParty.party_id,
      bill_date: b.date,
      sub_total: b.amt, total_amount: b.amt,
      paid_amount: 0, balance_amount: b.amt, payment_status: 'Unpaid',
      total_items: 0, total_quantity: 0,
    });
    purchaseBills.push(row);
  }
}

async function makeReceipt({ partyId, num, date, amount, type = 'Receipt' }) {
  return PaymentReceipt.create({
    transaction_number: num,
    transaction_type: type,
    transaction_date: date,
    party_id: partyId,
    total_amount: amount,
    payment_method: 'Cash',
    source: 'manual',
  });
}

// ── 1.x — Schema ──────────────────────────────────────────────────────
async function t_schema() {
  for (const v of ['import_excel', 'import_tally', 'backfill_fifo']) {
    const [r] = await sequelize.query(
      `SELECT 1 AS ok FROM pg_enum WHERE enumtypid='enum_bill_payment_allocations_method'::regtype AND enumlabel=:v`,
      { replacements: { v }, type: sequelize.QueryTypes.SELECT },
    );
    check(`1.${v} enum value '${v}' present`, !!r);
  }
}

// ── 2.x — resolveBillReferences ───────────────────────────────────────
async function t_resolve() {
  const t = await sequelize.transaction();
  try {
    const r1 = await billSvc.resolveBillReferences({
      partyId: custParty.party_id, billType: 'Sales',
      references: [{ bill_number: `${PFX}SI-001` }, { bill_number: `${PFX}SI-002` }],
      t,
    });
    check('2.1 BR resolves known refs', r1.resolved.length === 2 && r1.unknown.length === 0);

    const r2 = await billSvc.resolveBillReferences({
      partyId: custParty.party_id, billType: 'Sales',
      references: [{ bill_number: `${PFX}SI-001` }, { bill_number: `${PFX}NOT-A-BILL` }],
      t,
    });
    check('2.2 BR flags unknown refs', r2.resolved.length === 1 && r2.unknown.length === 1
      && r2.unknown[0] === `${PFX}NOT-A-BILL`);

    // Cross-party guard: bill belongs to customer, querying as supplier.
    const r3 = await billSvc.resolveBillReferences({
      partyId: supplParty.party_id, billType: 'Sales',
      references: [{ bill_number: `${PFX}SI-001` }], t,
    });
    check('2.3 BR rejects ref from another party', r3.resolved.length === 0 && r3.unknown.length === 1);
    await t.rollback();
  } catch (err) { await t.rollback(); throw err; }
}

// ── 3.x — fifoAllocate ────────────────────────────────────────────────
async function t_fifo() {
  const t = await sequelize.transaction();
  try {
    // Receipt of 4000 against 3 bills (3000, 2000, 5000) on 2025-04-01:
    // FIFO consumes 3000 (SI-001) + 1000 partial (SI-002), leaving SI-003 untouched.
    const plan = await billSvc.fifoAllocate({
      partyId: custParty.party_id, billType: 'Sales',
      asOfDate: '2025-04-01', totalAmount: 4000, t,
    });
    check('3.1 FIFO: oldest-first allocation',
      plan.length === 2 && plan[0].bill_number === `${PFX}SI-001` && plan[0].amount === 3000
      && plan[1].bill_number === `${PFX}SI-002` && plan[1].amount === 1000);

    // bill_date <= asOfDate: receipt on 2025-01-20 should NOT touch
    // SI-002 (2025-02-10) or SI-003 (2025-03-10).
    const plan2 = await billSvc.fifoAllocate({
      partyId: custParty.party_id, billType: 'Sales',
      asOfDate: '2025-01-20', totalAmount: 100000, t,
    });
    check('3.2 FIFO honors asOfDate (skips future bills)',
      plan2.length === 1 && plan2[0].bill_number === `${PFX}SI-001`);

    // Total > sum(outstanding): consumes everything, plan totals 10000.
    const plan3 = await billSvc.fifoAllocate({
      partyId: custParty.party_id, billType: 'Sales',
      asOfDate: '2026-01-01', totalAmount: 1000000, t,
    });
    const planSum = plan3.reduce((s, x) => s + x.amount, 0);
    check('3.3 FIFO over-pay: consumes all outstanding', planSum === 10000);

    await t.rollback();
  } catch (err) { await t.rollback(); throw err; }
}

// ── 4.x — applyAllocations ────────────────────────────────────────────
async function t_apply() {
  // Use a real receipt + bills (not rolled back) so we can verify
  // balance updates persist. Then clean up at end.
  const receipt = await makeReceipt({
    partyId: custParty.party_id, num: `${PFX}RCT-A1`, date: '2025-04-05', amount: 1500,
  });
  try {
    const t = await sequelize.transaction();
    const res = await billSvc.applyAllocations({
      receiptId: receipt.transaction_id, billType: 'Sales',
      plan: [{ bill_id: salesBills[0].sales_bill_id, amount: 1500 }],
      method: 'import_excel', t,
    });
    await t.commit();
    check('4.1 apply: inserted 1 row', res.inserted === 1 && !res.skipped);

    // Verify balance_amount on bill dropped from 3000 → 1500 + status = Partial.
    await salesBills[0].reload();
    check('4.2 apply: bill balance updated',
      Number(salesBills[0].balance_amount) === 1500
      && salesBills[0].payment_status === 'Partial');

    // Idempotency: second call should be a no-op.
    const t2 = await sequelize.transaction();
    const res2 = await billSvc.applyAllocations({
      receiptId: receipt.transaction_id, billType: 'Sales',
      plan: [{ bill_id: salesBills[0].sales_bill_id, amount: 1500 }],
      method: 'import_excel', t: t2,
    });
    await t2.commit();
    check('4.3 apply: idempotent on second call', res2.skipped === true && res2.inserted === 0);
  } finally {
    // Restore bill to clean state for next tests.
    await sequelize.query(`DELETE FROM bill_payment_allocations WHERE transaction_id = :id`,
      { replacements: { id: receipt.transaction_id } });
    await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_id = :id`,
      { replacements: { id: receipt.transaction_id } });
    await salesBills[0].update({ balance_amount: 3000, paid_amount: 0, payment_status: 'Unpaid' });
  }
}

// ── 5.x — allocateForReceipt (composed) ───────────────────────────────
async function t_allocateForReceipt() {
  // 5.1 Explicit refs path with amount.
  let r = await makeReceipt({
    partyId: custParty.party_id, num: `${PFX}RCT-B1`, date: '2025-04-10', amount: 2000,
  });
  try {
    const t = await sequelize.transaction();
    const res = await billSvc.allocateForReceipt({
      receiptId: r.transaction_id, partyId: custParty.party_id,
      transactionType: 'Receipt', asOfDate: '2025-04-10', totalAmount: 2000,
      references: [{ bill_number: `${PFX}SI-002`, amount: 2000 }],
      method: 'import_excel', t,
    });
    await t.commit();
    check('5.1 allocateForReceipt: explicit refs',
      res.mode === 'explicit' && res.inserted === 1 && res.allocated_total === 2000);
  } finally {
    await sequelize.query(`DELETE FROM bill_payment_allocations WHERE transaction_id = :id`, { replacements: { id: r.transaction_id } });
    await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_id = :id`, { replacements: { id: r.transaction_id } });
    await salesBills[1].update({ balance_amount: 2000, paid_amount: 0, payment_status: 'Unpaid' });
  }

  // 5.2 Unknown ref throws UNKNOWN_BILL_REFERENCES.
  r = await makeReceipt({
    partyId: custParty.party_id, num: `${PFX}RCT-B2`, date: '2025-04-10', amount: 1000,
  });
  let threw = null;
  try {
    const t = await sequelize.transaction();
    try {
      await billSvc.allocateForReceipt({
        receiptId: r.transaction_id, partyId: custParty.party_id,
        transactionType: 'Receipt', asOfDate: '2025-04-10', totalAmount: 1000,
        references: [{ bill_number: `${PFX}NOT-A-BILL`, amount: 1000 }],
        method: 'import_excel', t,
      });
    } catch (err) { threw = err; }
    await t.rollback();
  } finally {
    await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_id = :id`, { replacements: { id: r.transaction_id } });
  }
  check('5.2 allocateForReceipt: unknown ref throws',
    threw && threw.code === 'UNKNOWN_BILL_REFERENCES'
    && Array.isArray(threw.unknown) && threw.unknown.length === 1);

  // 5.3 FIFO fallback path (no refs supplied).
  r = await makeReceipt({
    partyId: custParty.party_id, num: `${PFX}RCT-B3`, date: '2025-04-15', amount: 4500,
  });
  try {
    const t = await sequelize.transaction();
    const res = await billSvc.allocateForReceipt({
      receiptId: r.transaction_id, partyId: custParty.party_id,
      transactionType: 'Receipt', asOfDate: '2025-04-15', totalAmount: 4500,
      references: null, method: 'import_excel', t,
    });
    await t.commit();
    check('5.3 allocateForReceipt: FIFO fallback',
      res.mode === 'fifo' && res.inserted === 2 && res.allocated_total === 4500);
  } finally {
    await sequelize.query(`DELETE FROM bill_payment_allocations WHERE transaction_id = :id`, { replacements: { id: r.transaction_id } });
    await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_id = :id`, { replacements: { id: r.transaction_id } });
    await salesBills[0].update({ balance_amount: 3000, paid_amount: 0, payment_status: 'Unpaid' });
    await salesBills[1].update({ balance_amount: 2000, paid_amount: 0, payment_status: 'Unpaid' });
  }

  // 5.4 Purchase side parity.
  r = await makeReceipt({
    partyId: supplParty.party_id, num: `${PFX}PMT-B4`, date: '2025-04-20', amount: 4000, type: 'Payment',
  });
  try {
    const t = await sequelize.transaction();
    const res = await billSvc.allocateForReceipt({
      receiptId: r.transaction_id, partyId: supplParty.party_id,
      transactionType: 'Payment', asOfDate: '2025-04-20', totalAmount: 4000,
      references: null, method: 'import_excel', t,
    });
    await t.commit();
    check('5.4 allocateForReceipt: Purchase FIFO',
      res.mode === 'fifo' && res.inserted === 1 && res.plan[0].bill_number === `${PFX}PI-001`);
  } finally {
    await sequelize.query(`DELETE FROM bill_payment_allocations WHERE transaction_id = :id`, { replacements: { id: r.transaction_id } });
    await sequelize.query(`DELETE FROM payments_receipts WHERE transaction_id = :id`, { replacements: { id: r.transaction_id } });
    await purchaseBills[0].update({ balance_amount: 4000, paid_amount: 0, payment_status: 'Unpaid' });
  }
}

// ── 6.x — Tally XML parser BILLALLOCATIONS extraction ─────────────────
function t_tallyParser() {
  const xml = `
<ENVELOPE>
<BODY><DATA><TALLYMESSAGE>
  <VOUCHER VCHTYPE="Receipt" ACTION="Create">
    <DATE>20250410</DATE>
    <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
    <VOUCHERNUMBER>R9XML-001</VOUCHERNUMBER>
    <PARTYLEDGERNAME>__R9_Customer A</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Cash</LEDGERNAME>
      <AMOUNT>-5000</AMOUNT>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>__R9_Customer A</LEDGERNAME>
      <AMOUNT>5000</AMOUNT>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <BILLALLOCATIONS.LIST>
        <NAME>__R9_SI-001</NAME>
        <BILLTYPE>Agst Ref</BILLTYPE>
        <AMOUNT>3000</AMOUNT>
      </BILLALLOCATIONS.LIST>
      <BILLALLOCATIONS.LIST>
        <NAME>__R9_SI-002</NAME>
        <BILLTYPE>Agst Ref</BILLTYPE>
        <AMOUNT>2000</AMOUNT>
      </BILLALLOCATIONS.LIST>
    </ALLLEDGERENTRIES.LIST>
  </VOUCHER>
  <VOUCHER VCHTYPE="Receipt" ACTION="Create">
    <DATE>20250411</DATE>
    <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
    <VOUCHERNUMBER>R9XML-002</VOUCHERNUMBER>
    <PARTYLEDGERNAME>__R9_Customer A</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>__R9_Customer A</LEDGERNAME>
      <AMOUNT>1000</AMOUNT>
      <BILLALLOCATIONS.LIST>
        <NAME>ADVANCE-1</NAME>
        <BILLTYPE>On Account</BILLTYPE>
        <AMOUNT>1000</AMOUNT>
      </BILLALLOCATIONS.LIST>
    </ALLLEDGERENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`;
  const v = parseVouchers(xml);
  check('6.1 parser: extracts both vouchers', v.length === 2);
  const v1 = v.find((x) => x.voucher_number === 'R9XML-001');
  const partyEntry = v1 && v1.ledger_entries.find((le) => le.name === '__R9_Customer A');
  check('6.2 parser: BILLALLOCATIONS list of length 2',
    partyEntry && Array.isArray(partyEntry.bill_allocations)
    && partyEntry.bill_allocations.length === 2
    && partyEntry.bill_allocations[0].name === '__R9_SI-001'
    && partyEntry.bill_allocations[0].amount === 3000
    && partyEntry.bill_allocations[1].name === '__R9_SI-002');
  // 'On Account' is preserved as a row (parser doesn't filter — orchestrator does).
  const v2 = v.find((x) => x.voucher_number === 'R9XML-002');
  const pe2 = v2 && v2.ledger_entries.find((le) => le.name === '__R9_Customer A');
  check('6.3 parser: passes BILLTYPE through (orchestrator filters)',
    pe2 && pe2.bill_allocations.length === 1
    && /on account/i.test(pe2.bill_allocations[0].type));
}

// ── 7.x — Excel orchestrator parseBillReferenceCell ───────────────────
function t_excelParse() {
  // Re-require to load the un-exported helper. The orchestrator doesn't
  // export it directly; we read the function by requiring the module
  // and reaching into __test__ (added below if needed). For now: drive
  // through the validator's public path.
  // Workaround: re-implement the same parse logic and verify shape via
  // a small unit. To stay honest, we drive the orchestrator's actual
  // function by reading the source at runtime with require('vm') —
  // overkill. Simplest: import it via a tiny test export.
  const o = require('../services/excelImportOrchestrator');
  if (typeof o.__test__parseBillReferenceCell !== 'function') {
    // Skip with diagnostic if the helper isn't exposed for tests.
    check('7.1 parseBillReferenceCell exported for tests', false,
      'add module.exports.__test__parseBillReferenceCell in orchestrator');
    check('7.2 parseBillReferenceCell skipped', true);
    check('7.3 parseBillReferenceCell skipped', true);
    return;
  }
  const f = o.__test__parseBillReferenceCell;
  const a = f('INV-001,INV-002');
  check('7.1 parse: comma-list without amounts',
    Array.isArray(a) && a.length === 2 && a[0].bill_number === 'INV-001' && a[0].amount === undefined);
  const b = f('INV-001:6000, INV-002 : 4000');
  check('7.2 parse: comma-list with amounts',
    Array.isArray(b) && b.length === 2 && b[0].amount === 6000 && b[1].amount === 4000);
  const c = f('INV-001:bogus');
  check('7.3 parse: invalid syntax returns null', c === null);
}

// ── 8.x — Excel orchestrator end-to-end ──────────────────────────────
async function t_excelE2E() {
  // Synthesise a tiny payment_receipts xlsx in memory, drive through
  // validatePayments → commit. We bypass the worker queue and call the
  // exported functions directly with a fake ImportJob row.
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('payments');
  ws.columns = [
    { header: 'Transaction Number', key: 'transaction_number' },
    { header: 'Type',                key: 'transaction_type' },
    { header: 'Date',                key: 'transaction_date' },
    { header: 'Party Mobile',        key: 'party_mobile' },
    { header: 'Party Name',          key: 'party_name' },
    { header: 'Amount',              key: 'total_amount' },
    { header: 'Payment Method',      key: 'payment_method' },
    { header: 'Bill Reference',      key: 'bill_reference' },
  ];
  // Row 1: explicit refs (FIFO will be skipped).
  ws.addRow({
    transaction_number: `${PFX}XLS-001`,
    transaction_type: 'Receipt',
    transaction_date: '2025-04-12',
    party_mobile: '9000000901',
    party_name: `${PFX}Customer A`,
    total_amount: 3000,
    payment_method: 'Cash',
    bill_reference: `${PFX}SI-001:3000`,
  });
  // Row 2: no refs → FIFO against remaining bills.
  ws.addRow({
    transaction_number: `${PFX}XLS-002`,
    transaction_type: 'Receipt',
    transaction_date: '2025-04-13',
    party_mobile: '9000000901',
    party_name: `${PFX}Customer A`,
    total_amount: 2500,
    payment_method: 'Cash',
    bill_reference: '',
  });
  // Row 3: unknown bill ref — should be REJECTED at validate.
  ws.addRow({
    transaction_number: `${PFX}XLS-003`,
    transaction_type: 'Receipt',
    transaction_date: '2025-04-14',
    party_mobile: '9000000901',
    party_name: `${PFX}Customer A`,
    total_amount: 1000,
    payment_method: 'Cash',
    bill_reference: `${PFX}DOES-NOT-EXIST`,
  });

  const orch = require('../services/excelImportOrchestrator');
  const buckets = await orch.__test__validatePayments(wb);

  check('8.1 Excel validate: 2 create, 1 reject',
    buckets.create.length === 2 && buckets.reject.length === 1
    && /unknown/i.test(buckets.reject[0].reason));

  // Drive commit on the 2 acceptable rows. We forge the minimal job
  // shape commitPayment expects.
  const fakeJob = { id: 999, created_by: null };
  const r1 = await orch.__test__commitPayment(fakeJob, buckets.create[0], 'create');
  const r2 = await orch.__test__commitPayment(fakeJob, buckets.create[1], 'create');
  check('8.2 Excel commit: both rows posted', r1.success && r2.success);

  // Verify row 1 has 1 alloc (explicit) and row 2 has 1+ allocs (FIFO).
  const [counts] = await sequelize.query(
    `SELECT
       (SELECT COUNT(*) FROM bill_payment_allocations bpa
         JOIN payments_receipts pr ON pr.transaction_id = bpa.transaction_id
        WHERE pr.transaction_number = '${PFX}XLS-001'
          AND bpa.allocation_method = 'import_excel') AS row1,
       (SELECT COUNT(*) FROM bill_payment_allocations bpa
         JOIN payments_receipts pr ON pr.transaction_id = bpa.transaction_id
        WHERE pr.transaction_number = '${PFX}XLS-002'
          AND bpa.allocation_method = 'import_excel') AS row2`,
    { type: sequelize.QueryTypes.SELECT },
  );
  check('8.3 Excel commit: alloc rows landed',
    Number(counts.row1) === 1 && Number(counts.row2) >= 1,
    `row1=${counts.row1} row2=${counts.row2}`);
}

// ── 9.x — Tally orchestrator validate-phase guard (allocations) ──────
async function t_tallyValidateGuard() {
  // Drive the validate-phase predicate directly. Build a minimal voucher
  // with bill_allocations and confirm: known names pass, unknown names
  // emit a clear reject reason. Use the orchestrator's __test__ hook.
  const orch = require('../services/tallyImportOrchestrator');
  if (typeof orch.__test__validateAllocations !== 'function') {
    check('9.1 validateAllocations exported for tests', false,
      'add module.exports.__test__validateAllocations in orchestrator');
    check('9.2 skipped', true);
    return;
  }
  const known = await orch.__test__validateAllocations({
    voucher: {
      voucher_type: 'Receipt', voucher_number: `${PFX}TLY-OK`, voucher_date: '2025-04-20',
      party_name: `${PFX}Customer A`,
      ledger_entries: [{
        name: `${PFX}Customer A`,
        bill_allocations: [
          { name: `${PFX}SI-001`, amount: 3000, type: 'Agst Ref' },
          { name: `${PFX}SI-002`, amount: 2000, type: 'Agst Ref' },
        ],
      }],
    },
  });
  check('9.1 validate: known refs pass', known.ok === true && known.unknown.length === 0);

  const bad = await orch.__test__validateAllocations({
    voucher: {
      voucher_type: 'Receipt', voucher_number: `${PFX}TLY-BAD`, voucher_date: '2025-04-20',
      party_name: `${PFX}Customer A`,
      ledger_entries: [{
        name: `${PFX}Customer A`,
        bill_allocations: [
          { name: `${PFX}NOPE`, amount: 1000, type: 'Agst Ref' },
        ],
      }],
    },
  });
  check('9.2 validate: unknown ref rejected',
    bad.ok === false && bad.unknown.length === 1 && bad.unknown[0] === `${PFX}NOPE`);
}

(async () => {
  console.log('──────────────────────────────────────────────');
  console.log('Phase R9 — Import allocation self-test');
  console.log('──────────────────────────────────────────────');
  try {
    await preClean();
    await setupFixtures();
    await t_schema();
    await t_resolve();
    await t_fifo();
    await t_apply();
    await t_allocateForReceipt();
    t_tallyParser();
    t_excelParse();
    await t_excelE2E();
    await t_tallyValidateGuard();
  } catch (err) {
    console.error('Test runner error:', err);
    fail++;
  } finally {
    try { await preClean(); } catch (_) {}
  }

  for (const r of results) console.log(r);
  console.log('──────────────────────────────────────────────');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  console.log('──────────────────────────────────────────────');
  await sequelize.close();
  process.exit(fail ? 1 : 0);
})();
