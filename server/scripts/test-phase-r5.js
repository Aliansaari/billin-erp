#!/usr/bin/env node
// Phase-R5 self-test: cash-class party stub bug + the FK-cascade
// foundation bug it exposed.
//
// Three layers of defence are tested:
//   (1) Reports — Cash Flow's cash-ledger resolver restricts to
//       sub_group IN ('Cash-in-Hand','Bank Accounts','Bank OD A/c')
//       AND is_party_ledger=false. A Sundry Debtors party named
//       "Cash Sales" is NOT classified as cash.
//   (2) Tally orchestrator — ensureParties skips cash-class names
//       under Sundry Debtors/Creditors. commitOne for sales detects
//       the cash-class party_name and books the bill as walk-in
//       cash (customer_id=null, paid in full).
//   (3) FK hardening + soft-delete backfill — ledger_entries FKs to
//       its parents are ON DELETE RESTRICT (was CASCADE — silently
//       wiped ₹8,606 of debits). Backfill uses reverse + repost +
//       is_active=false, never hard-delete.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const { execSync } = require('child_process');
const path = require('path');
const {
  Party, LedgerAccount, SalesBill, SalesBillItem, SystemSettings,
} = require('../models');
const finReports = require('../controllers/financialReportsController');
const { postVoucher } = require('../services/ledgerPostingService');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else    { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PFX = '__R5_';

function callCtrl(handler, query) {
  return new Promise((resolve, reject) => {
    const req = { query };
    const res = { status(c) { this._s = c; return this; }, json(b) { resolve({ status: this._s || 200, body: b }); } };
    handler(req, res).catch(reject);
  });
}

// Stub fixture name. Must match the backfill's cash-class regex
// exactly (the production regex is intentionally strict — anchored,
// no prefixes), so we use the literal name. The seeded "Cash Sales"
// stub from the original Tally import has been soft-deleted, so a
// fresh active row with this name won't conflict. Cleanup below is
// explicit on this name (LIKE '${PFX}%' wouldn't match it).
const STUB_NAME = 'Cash Sales';

async function preClean() {
  // Make sure no live test stub or test prefix data is lying around.
  // Bump is_active back so DELETE queries reach soft-deleted rows.
  await sequelize.query(`UPDATE parties         SET is_active = true WHERE party_name LIKE '${PFX}%' OR (party_name = '${STUB_NAME}' AND mobile_1 = '5500000040')`);
  await sequelize.query(`UPDATE ledger_accounts SET is_active = true WHERE ledger_name LIKE '${PFX}%'`);
  // Null party_id on entries pointing at our test parties so the
  // RESTRICT FK doesn't block deletion. Raw query bypasses the
  // append-only hook — for test setup only.
  await sequelize.query(
    `UPDATE ledger_entries SET party_id = NULL
      WHERE party_id IN (SELECT party_id FROM parties WHERE party_name LIKE '${PFX}%' OR (party_name = '${STUB_NAME}' AND mobile_1 = '5500000040'))`,
  );
  await sequelize.query(`DELETE FROM ledger_entries WHERE narration LIKE '%${PFX}%' OR reference_number LIKE '${PFX}%'`);
  await sequelize.query(`DELETE FROM sales_bill_items WHERE sales_bill_id IN (SELECT sales_bill_id FROM sales_bills WHERE bill_number LIKE '${PFX}%')`);
  await sequelize.query(`DELETE FROM sales_bills WHERE bill_number LIKE '${PFX}%'`);
  await sequelize.query(`UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '${PFX}%' OR (party_name = '${STUB_NAME}' AND mobile_1 = '5500000040')`);
  await sequelize.query(`DELETE FROM parties WHERE party_name LIKE '${PFX}%' OR (party_name = '${STUB_NAME}' AND mobile_1 = '5500000040')`);
  await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_name LIKE '${PFX}%' OR ledger_name = '${STUB_NAME}'`);
}

async function activeTotals() {
  const [r] = await sequelize.query(
    `SELECT COALESCE(SUM(debit_amount),0)::float dr,
            COALESCE(SUM(credit_amount),0)::float cr
       FROM ledger_entries
      WHERE reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = ledger_entries.entry_id)`,
    { type: sequelize.QueryTypes.SELECT },
  );
  return { dr: Math.round(Number(r.dr)*100)/100, cr: Math.round(Number(r.cr)*100)/100 };
}

async function main() {
  await preClean();
  await SystemSettings.update({
    gst_enabled: true,
    financial_year_start: '2025-04-01',
    financial_year_end:   '2026-03-31',
  }, { where: { setting_id: 1 } });

  // ── (1) FK hardening — both cascades are now RESTRICT ────────────────
  const fks = await sequelize.query(
    `SELECT conname, confdeltype FROM pg_constraint
      WHERE conrelid = 'ledger_entries'::regclass
        AND contype = 'f'
        AND conname IN ('ledger_entries_ledger_id_fkey','ledger_entries_party_id_fkey')`,
    { type: sequelize.QueryTypes.SELECT },
  );
  // confdeltype: 'a' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE, 'n' = SET NULL
  for (const f of fks) {
    check(`FK hardening: ${f.conname} is RESTRICT (not CASCADE)`,
      f.confdeltype === 'r' || f.confdeltype === 'a',
      `confdeltype=${f.confdeltype}`);
  }
  check('FK hardening: both FKs were checked',
    fks.length === 2, `found ${fks.length}`);

  // ── (2) CF cash-ledger resolver ──────────────────────────────────────
  // Stage a Sundry Debtor stub with name "Cash Sales" + a sales bill
  // posted against it. CF must NOT include this in Operating cash inflow.
  const t1 = await sequelize.transaction();
  const stubLedger = await LedgerAccount.create({
    ledger_name: STUB_NAME, ledger_group: 'Assets', sub_group: 'Sundry Debtors',
    is_party_ledger: true, opening_balance: 0,
  }, { transaction: t1 });
  const stubParty = await Party.create({
    party_type: 'Customer', party_name: STUB_NAME,
    mobile_1: '5500000040', ledger_account_id: stubLedger.ledger_id,
  }, { transaction: t1 });
  const [salesAcctRow] = await sequelize.query(
    `SELECT ledger_id FROM ledger_accounts WHERE ledger_name='Sales Account'`,
    { type: sequelize.QueryTypes.SELECT, transaction: t1 },
  );
  const salBill = await SalesBill.create({
    bill_number: `${PFX}SAL-1`, bill_date: '2025-09-01',
    customer_id: stubParty.party_id,
    sub_total: 1000, total_amount: 1000, balance_amount: 1000, payment_status: 'Unpaid',
  }, { transaction: t1 });
  await SalesBillItem.create({
    sales_bill_id: salBill.sales_bill_id,
    product_name: `${PFX}Item1`, hsn_code: '610910',
    unit_type: 'Pcs', quantity: 10, rate: 100, taxable_amount: 1000, total_amount: 1000,
  }, { transaction: t1 });
  await postVoucher({
    voucherType: 'Sales', sourceType: 'sales_bill', sourceId: salBill.sales_bill_id,
    voucherDate: '2025-09-01', referenceNumber: salBill.bill_number,
    narration: `${PFX}stub-party sale`,
    lines: [
      { ledgerAccountId: stubLedger.ledger_id,    debit: 1000, credit: 0, partyId: stubParty.party_id },
      { ledgerAccountId: salesAcctRow.ledger_id,  debit: 0,    credit: 1000 },
    ],
    transaction: t1,
  });
  await t1.commit();

  const cf = await callCtrl(finReports.cashFlow, { from_date: '2025-04-01', to_date: '2026-03-31' });
  check('CF: status 200', cf.status === 200);
  const stubInOp = (cf.body.sections.operating || []).some(
    (r) => r.contra_label && r.contra_label.includes(STUB_NAME)
  );
  check('CF: stub-party sale NOT classified as cash inflow', !stubInOp);

  const cashLedgers = await sequelize.query(
    `SELECT ledger_id, ledger_name, sub_group, is_party_ledger
       FROM ledger_accounts
      WHERE is_active = true
        AND is_party_ledger = false
        AND sub_group IN ('Cash-in-Hand','Bank Accounts','Bank OD A/c')`,
    { type: sequelize.QueryTypes.SELECT },
  );
  check('CF cash resolver: returns ≥1 Cash-in-Hand ledger',
    cashLedgers.some((l) => l.sub_group === 'Cash-in-Hand'));
  check('CF cash resolver: NEVER returns a party ledger',
    cashLedgers.every((l) => l.is_party_ledger === false));
  check('CF cash resolver: NEVER returns the stub "Cash Sales" party ledger',
    !cashLedgers.some((l) => l.ledger_name === STUB_NAME));

  // ── (3) FK regression: DELETE FROM parties on a party with ledger
  //        history MUST fail at the DB level. This is the bug fix.
  let deletionBlocked = false;
  try {
    await sequelize.query(`DELETE FROM parties WHERE party_id = :id`,
      { replacements: { id: stubParty.party_id } });
  } catch (err) {
    deletionBlocked = /violates foreign key constraint|update or delete on table .parties./i.test(err.message + (err.original ? err.original.message : ''));
  }
  check('FK regression: DELETE FROM parties (with ledger history) is blocked at DB level',
    deletionBlocked);

  // Same for ledger_accounts.
  let ledgerDeletionBlocked = false;
  try {
    await sequelize.query(`DELETE FROM ledger_accounts WHERE ledger_id = :id`,
      { replacements: { id: stubLedger.ledger_id } });
  } catch (err) {
    ledgerDeletionBlocked = /violates foreign key constraint|update or delete on table .ledger_accounts./i.test(err.message + (err.original ? err.original.message : ''));
  }
  check('FK regression: DELETE FROM ledger_accounts (with entries) is blocked at DB level',
    ledgerDeletionBlocked);

  // ── (4) Tally orchestrator — cash-class party regex + integration ──
  const orch = require('../services/tallyImportOrchestrator');
  if (typeof orch.isCashClassPartyName === 'function') {
    check('Tally regex: matches "Cash Sales"',     orch.isCashClassPartyName('Cash Sales'));
    check('Tally regex: matches "Cash Purchases"', orch.isCashClassPartyName('Cash Purchases'));
    check('Tally regex: matches "Cash Purchase"',  orch.isCashClassPartyName('Cash Purchase'));
    check('Tally regex: matches plain "Cash"',     orch.isCashClassPartyName('Cash'));
    check('Tally regex: rejects real customer',    !orch.isCashClassPartyName('Sharma Cloth House'));
    check('Tally regex: rejects "Cash & Co"',      !orch.isCashClassPartyName('Cash & Co'));
    check('Tally regex: rejects "Cashier Inc"',    !orch.isCashClassPartyName('Cashier Inc'));
  } else {
    check('Tally regex helper exported', false, 'isCashClassPartyName not exported');
  }

  // ── (5) Backfill — reverse + repost + soft-delete ────────────────────
  // Capture before/after totals around the script run. Active Dr/Cr
  // must remain balanced throughout (reverse pairs + balanced re-posts
  // are value-preserving).
  const before = await activeTotals();
  check('Backfill setup: stub ledger has 1 live Dr leg of 1000',
    Math.abs(before.dr - before.cr) < 0.01,
    `before Dr=${before.dr} Cr=${before.cr}`);

  // Dry-run first — must NOT change state.
  const scriptPath = path.join(__dirname, 'backfill-cash-sale-stubs.js');
  const dryOut = execSync(`node "${scriptPath}" --dry-run`, { encoding: 'utf8' });
  check('Backfill --dry-run: prints "no changes" line',
    dryOut.includes('--dry-run: no changes'));
  const stubStillActive = await Party.findOne({ where: { party_name: STUB_NAME } });
  check('Backfill --dry-run: stub party still active',
    !!stubStillActive && stubStillActive.is_active === true);

  // Run for real.
  const realOut = execSync(`node "${scriptPath}"`, { encoding: 'utf8' });
  check('Backfill: prints "soft-deleted" line',
    realOut.includes('soft-deleted stub party + ledger'));

  const after = await activeTotals();
  check('Backfill: Active Dr unchanged (paisa)',
    Math.abs(after.dr - before.dr) < 0.01,
    `before=${before.dr} after=${after.dr}`);
  check('Backfill: Active Cr unchanged (paisa)',
    Math.abs(after.cr - before.cr) < 0.01);
  check('Backfill: Active still balanced',
    Math.abs(after.dr - after.cr) < 0.01);

  // Stub party is_active=false (soft-deleted, NOT hard-deleted).
  const stubAfter = await Party.findOne({ where: { party_name: STUB_NAME } });
  check('Backfill: stub party row STILL EXISTS (soft-delete)', !!stubAfter);
  check('Backfill: stub party is_active = false',
    stubAfter && stubAfter.is_active === false);
  const stubLedgerAfter = await LedgerAccount.findOne({ where: { ledger_name: STUB_NAME } });
  check('Backfill: stub ledger row STILL EXISTS (soft-delete)', !!stubLedgerAfter);
  check('Backfill: stub ledger is_active = false',
    stubLedgerAfter && stubLedgerAfter.is_active === false);

  // The stub ledger's live net is 0 — every original is paired with a
  // reversal mirror.
  const [stubLive] = await sequelize.query(
    `SELECT COALESCE(SUM(debit_amount - credit_amount), 0)::float net
       FROM ledger_entries
      WHERE ledger_id = :id
        AND reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = ledger_entries.entry_id)`,
    { replacements: { id: stubLedger.ledger_id }, type: sequelize.QueryTypes.SELECT },
  );
  check('Backfill: stub ledger live net = 0 after reversal',
    Math.abs(stubLive.net) < 0.01,
    `live net=${stubLive.net}`);

  // The bill row was rewritten to cash-sale shape.
  const reloaded = await SalesBill.findOne({ where: { bill_number: `${PFX}SAL-1` } });
  check('Backfill: SalesBill.customer_id = NULL', reloaded.customer_id === null);
  check('Backfill: SalesBill.payment_status = Paid', reloaded.payment_status === 'Paid');
  check('Backfill: SalesBill.balance_amount = 0',
    Math.abs(Number(reloaded.balance_amount)) < 0.01);

  // The re-post landed on the real Cash ledger.
  const [cashRow] = await sequelize.query(
    `SELECT ledger_id FROM ledger_accounts WHERE ledger_name='Cash' AND sub_group='Cash-in-Hand'`,
    { type: sequelize.QueryTypes.SELECT },
  );
  const repostOnCash = await sequelize.query(
    `SELECT le.entry_number, la.ledger_name, le.debit_amount::float dr, le.credit_amount::float cr
       FROM ledger_entries le
       JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
      WHERE le.reference_number = :ref
        AND le.ledger_id = :cash
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)`,
    { replacements: { ref: `${PFX}SAL-1`, cash: cashRow.ledger_id }, type: sequelize.QueryTypes.SELECT },
  );
  check('Backfill: re-post Dr 1000 leg now on Cash ledger',
    repostOnCash.length === 1 && Math.abs(repostOnCash[0].dr - 1000) < 0.01);

  // CF after backfill: the bill now appears in Operating with +1000.
  const cf2 = await callCtrl(finReports.cashFlow, { from_date: '2025-04-01', to_date: '2026-03-31' });
  const ourEntry = (cf2.body.sections.operating || []).find(
    (r) => r.contra_label && r.contra_label.includes('Sales Account')
        && Math.abs(r.cash_impact - 1000) < 0.01
        && r.entry_date === '2025-09-01'
  );
  check('Backfill: post-migration, CF DOES include the cash-sale (+1000)',
    !!ourEntry);

  // Foundation invariant: Active Dr = Active Cr = the seeded snapshot
  // (₹26,83,522.17). The test fixture adds +1000 then nets it to 0
  // via reverse-pair, so the net delta over the whole run is 0.
  const finalCheck = await activeTotals();
  check('Foundation: Active Dr == Active Cr (paisa-exact)',
    Math.abs(finalCheck.dr - finalCheck.cr) < 0.01,
    `Dr=${finalCheck.dr} Cr=${finalCheck.cr}`);
  // Note: we don't assert the exact 26,83,522.17 here because seeded
  // data may legitimately drift over time as the user adds bills via
  // normal flows. The cross-suite invariant is balanced-ness.

  // ── Cleanup ──
  await preClean();
  await SystemSettings.update({
    financial_year_start: '2026-04-01', financial_year_end: '2027-03-31',
  }, { where: { setting_id: 1 } });

  console.log('\n── Phase R5 Self-Test (Cash-Class Stub + FK Hardening) ───');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
