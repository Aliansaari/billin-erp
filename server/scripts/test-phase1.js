#!/usr/bin/env node
// Phase-1 self-test for the ledger Posting Service + Party afterCreate
// hook. Creates synthetic fixtures, runs every checkbox, then wipes
// everything it created so the production DB returns to zero.
//
// Run with: node server/scripts/test-phase1.js
//
// Exit code 0 on full pass, 1 on any failure.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { sequelize, Party, LedgerAccount, LedgerEntry, SystemSettings } = require('../models');
const { postVoucher, reverseVoucher, getLedgerBalance } = require('../services/ledgerPostingService');

let pass = 0, fail = 0;
const results = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    results.push(`  ✓ ${name}`);
  } else {
    fail++;
    results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function preClean() {
  // Wipe anything a prior failed run may have left behind, in FK-safe order.
  await sequelize.query(
    "DELETE FROM ledger_entries WHERE source_type IN ('sales_bill','party_opening') " +
    "AND (reference_id BETWEEN 999000000 AND 999999999 OR " +
    " reference_id IN (SELECT party_id FROM parties WHERE party_name LIKE '__TEST_PHASE1_%'))",
  );
  await sequelize.query(
    "DELETE FROM ledger_entries WHERE narration LIKE '%__TEST_PHASE1%'",
  );
  await sequelize.query(
    "UPDATE parties SET ledger_account_id = NULL WHERE party_name LIKE '__TEST_PHASE1_%'",
  );
  await sequelize.query(
    "DELETE FROM parties WHERE party_name LIKE '__TEST_PHASE1_%'",
  );
  await sequelize.query(
    "DELETE FROM ledger_accounts WHERE ledger_name LIKE '__TEST_PHASE1_%'",
  );
}

async function main() {
  await preClean();
  // ── Pre-flight: confirm seed has the new ledgers ──────────
  const obe      = await LedgerAccount.findOne({ where: { ledger_name: 'Opening Balance Equity' } });
  const suspense = await LedgerAccount.findOne({ where: { ledger_name: 'Suspense Account' } });
  const sales    = await LedgerAccount.findOne({ where: { ledger_name: 'Sales Account' } });
  const cgstOut  = await LedgerAccount.findOne({ where: { ledger_name: 'CGST Output' } });
  const sgstOut  = await LedgerAccount.findOne({ where: { ledger_name: 'SGST Output' } });
  const cash     = await LedgerAccount.findOne({ where: { ledger_name: 'Cash' } });
  check('Seed: Opening Balance Equity exists', !!obe);
  check('Seed: Suspense Account exists',       !!suspense);
  check('Seed: Sales Account exists',          !!sales);
  check('Seed: CGST Output exists',            !!cgstOut);
  check('Seed: Cash exists',                   !!cash);

  // Track everything we create so we can clean up exactly.
  const createdPartyIds = [];
  const createdLedgerIds = [];

  try {
    // ── Test 1: Customer afterCreate auto-link ─────────────
    const cust = await Party.create({
      party_type: 'Customer',
      party_name: '__TEST_PHASE1_CUST_A',
      mobile_1: '9999900001',
      opening_balance: 0,
    });
    createdPartyIds.push(cust.party_id);
    await cust.reload();
    const custLedger = await LedgerAccount.findOne({ where: { ledger_name: '__TEST_PHASE1_CUST_A' } });
    if (custLedger) createdLedgerIds.push(custLedger.ledger_id);
    check('Customer auto-link: party.ledger_account_id populated', !!cust.ledger_account_id);
    check('Customer auto-link: ledger_account row exists',         !!custLedger);
    check('Customer auto-link: sub_group is Sundry Debtors',       custLedger && custLedger.sub_group === 'Sundry Debtors');
    check('Customer auto-link: ledger_group is Assets',            custLedger && custLedger.ledger_group === 'Assets');
    check('Customer auto-link: is_party_ledger=true',              custLedger && custLedger.is_party_ledger === true);
    check('Customer auto-link: party_id back-link set',            custLedger && custLedger.party_id === cust.party_id);

    // ── Test 2: Supplier afterCreate ───────────────────────
    const sup = await Party.create({
      party_type: 'Supplier',
      party_name: '__TEST_PHASE1_SUP_A',
      mobile_1: '9999900002',
      opening_balance: 0,
    });
    createdPartyIds.push(sup.party_id);
    await sup.reload();
    const supLedger = await LedgerAccount.findOne({ where: { ledger_name: '__TEST_PHASE1_SUP_A' } });
    if (supLedger) createdLedgerIds.push(supLedger.ledger_id);
    check('Supplier auto-link: sub_group is Sundry Creditors', supLedger && supLedger.sub_group === 'Sundry Creditors');
    check('Supplier auto-link: ledger_group is Liabilities',   supLedger && supLedger.ledger_group === 'Liabilities');

    // ── Test 3: Opening-balance JV (Customer Receivable ₹50,000) ─────
    const custOpen = await Party.create({
      party_type: 'Customer',
      party_name: '__TEST_PHASE1_CUST_OPENING',
      mobile_1: '9999900003',
      opening_balance: 50000,
      opening_balance_type: 'Receivable',
    });
    createdPartyIds.push(custOpen.party_id);
    await custOpen.reload();
    const custOpenLedger = await LedgerAccount.findOne({ where: { ledger_name: '__TEST_PHASE1_CUST_OPENING' } });
    if (custOpenLedger) createdLedgerIds.push(custOpenLedger.ledger_id);
    const openingEntries = await LedgerEntry.findAll({
      where: { source_type: 'party_opening', reference_id: custOpen.party_id },
    });
    check('Opening JV: 2 lines posted', openingEntries.length === 2,
      `got ${openingEntries.length}`);
    const drLine = openingEntries.find((e) => Number(e.debit_amount) > 0);
    const crLine = openingEntries.find((e) => Number(e.credit_amount) > 0);
    check('Opening JV: customer ledger debited ₹50,000',
      drLine && drLine.ledger_id === custOpenLedger.ledger_id && Number(drLine.debit_amount) === 50000);
    check('Opening JV: OBE credited ₹50,000',
      crLine && crLine.ledger_id === obe.ledger_id && Number(crLine.credit_amount) === 50000);
    check('Opening JV: voucher_type=Journal',
      drLine && drLine.voucher_type === 'Journal');
    // Date = FY start - 1 day
    const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
    if (settings && settings.financial_year_start) {
      const fy = new Date(settings.financial_year_start);
      fy.setDate(fy.getDate() - 1);
      const expected = fy.toISOString().slice(0, 10);
      check('Opening JV: dated FY start - 1', drLine && String(drLine.entry_date) === expected,
        `got ${drLine && drLine.entry_date}, expected ${expected}`);
    }

    // ── Test 4: postVoucher — direct call with balanced lines ─────
    // Synthetic intrastate sale: Cust Dr 11,800 / Sales Cr 10,000 / CGST Cr 900 / SGST Cr 900
    const FAKE_BILL_ID = 999000001;
    const lines = [
      { ledgerAccountId: custLedger.ledger_id, debit: 11800, credit: 0, partyId: cust.party_id },
      { ledgerAccountId: sales.ledger_id,     debit: 0,     credit: 10000 },
      { ledgerAccountId: cgstOut.ledger_id,   debit: 0,     credit: 900 },
      { ledgerAccountId: sgstOut.ledger_id,   debit: 0,     credit: 900 },
    ];
    const inserted = await postVoucher({
      voucherType: 'Sales',
      sourceType: 'sales_bill',
      sourceId: FAKE_BILL_ID,
      voucherDate: new Date(),
      referenceNumber: 'TEST-SAL-001',
      lines,
      narration: 'Test intrastate sale',
      userId: null,
    });
    check('postVoucher: returned 4 rows', inserted.length === 4);
    const sumDr = inserted.reduce((s, e) => s + Number(e.debit_amount), 0);
    const sumCr = inserted.reduce((s, e) => s + Number(e.credit_amount), 0);
    check('postVoucher: Dr=Cr=11800', sumDr === 11800 && sumCr === 11800,
      `Dr=${sumDr} Cr=${sumCr}`);

    // ── Test 5: Idempotency — second call rejects ─────────
    let idempBlocked = false;
    try {
      await postVoucher({
        voucherType: 'Sales',
        sourceType: 'sales_bill',
        sourceId: FAKE_BILL_ID,
        voucherDate: new Date(),
        lines,
        narration: 'Duplicate',
        userId: null,
      });
    } catch (e) {
      idempBlocked = /already posted/i.test(e.message);
    }
    check('postVoucher: idempotent — second call rejected', idempBlocked);

    // ── Test 6: Unbalanced posting rejected ───────────────
    let unbalancedBlocked = false;
    try {
      await postVoucher({
        voucherType: 'Sales',
        sourceType: 'sales_bill',
        sourceId: 999000099,
        voucherDate: new Date(),
        lines: [
          { ledgerAccountId: custLedger.ledger_id, debit: 100, credit: 0 },
          { ledgerAccountId: sales.ledger_id, debit: 0, credit: 99 },
        ],
        narration: 'Bad',
      });
    } catch (e) {
      unbalancedBlocked = /unbalanced/i.test(e.message);
    }
    check('postVoucher: unbalanced rejected', unbalancedBlocked);

    // ── Test 7: reverseVoucher — first call reverses ─────
    const reverseRes = await reverseVoucher({
      sourceType: 'sales_bill',
      sourceId: FAKE_BILL_ID,
      reason: 'Test reversal',
    });
    check('reverseVoucher: 4 mirror rows posted', reverseRes.reversed === 4,
      `got ${reverseRes.reversed}`);
    // After reversal, net Dr/Cr for this source = 0
    const allForSource = await LedgerEntry.findAll({
      where: { source_type: 'sales_bill', reference_id: FAKE_BILL_ID },
    });
    const netDr = allForSource.reduce((s, e) => s + Number(e.debit_amount), 0);
    const netCr = allForSource.reduce((s, e) => s + Number(e.credit_amount), 0);
    check('reverseVoucher: net Dr - Cr = 0 across orig+reversal', netDr === netCr);

    // ── Test 8: reverseVoucher idempotency (no-op) ───────
    const reverseRes2 = await reverseVoucher({
      sourceType: 'sales_bill',
      sourceId: FAKE_BILL_ID,
      reason: 'Should noop',
    });
    check('reverseVoucher: second call returns reversed=0',
      reverseRes2.reversed === 0);

    // ── Test 9: Append-only hook blocks UPDATE ───────────
    let updateBlocked = false;
    try {
      const some = await LedgerEntry.findOne({ where: { source_type: 'sales_bill' } });
      await some.update({ narration: 'tampered' });
    } catch (e) {
      updateBlocked = /append-only/i.test(e.message);
    }
    check('Append-only: direct .update() blocked', updateBlocked);

    // ── Test 10: Append-only hook blocks DESTROY ─────────
    let destroyBlocked = false;
    try {
      const some = await LedgerEntry.findOne({ where: { source_type: 'sales_bill' } });
      await some.destroy();
    } catch (e) {
      destroyBlocked = /append-only/i.test(e.message);
    }
    check('Append-only: direct .destroy() blocked', destroyBlocked);

    // ── Test 11: Append-only blocks bulk destroy via ORM ──
    let bulkDestroyBlocked = false;
    try {
      await LedgerEntry.destroy({ where: { source_type: 'sales_bill' } });
    } catch (e) {
      bulkDestroyBlocked = /append-only/i.test(e.message);
    }
    check('Append-only: bulk destroy() blocked', bulkDestroyBlocked);

    // ── Test 12: Wipe path (hooks: false) succeeds ───────
    // Simulate the settingsController wipe — uses raw SQL DELETE which
    // bypasses Sequelize hooks anyway; we also explicitly verify the
    // hooks:false ORM path works as a safety net.
    const t = await sequelize.transaction();
    try {
      await LedgerEntry.destroy({
        where: { source_type: 'sales_bill', reference_id: FAKE_BILL_ID },
        hooks: false,
        transaction: t,
      });
      await t.commit();
      const remaining = await LedgerEntry.count({
        where: { source_type: 'sales_bill', reference_id: FAKE_BILL_ID },
      });
      check('Wipe: hooks:false bypass deletes rows', remaining === 0);
    } catch (e) {
      await t.rollback();
      check('Wipe: hooks:false bypass deletes rows', false, e.message);
    }

    // ── Test 13: Backfill script idempotency ─────────────
    // Insert a synthetic party DIRECTLY (bypass afterCreate hook) by
    // disabling hooks on the create call, then run backfill.
    const orphan = await Party.create({
      party_type: 'Customer',
      party_name: '__TEST_PHASE1_ORPHAN',
      mobile_1: '9999900099',
      opening_balance: 1000,
      opening_balance_type: 'Receivable',
    }, { hooks: false });
    createdPartyIds.push(orphan.party_id);
    check('Backfill setup: orphan party has no ledger',
      orphan.ledger_account_id == null);

    // Run the backfill in-process (simulating the script's main loop)
    const orphans = await Party.findAll({ where: { ledger_account_id: null } });
    for (const p of orphans) {
      const tt = await sequelize.transaction();
      try {
        const isSupplierOnly = p.party_type === 'Supplier';
        const ledgerName = `${p.party_name} (#${p.party_id})`;
        const lg = await LedgerAccount.create({
          ledger_name: ledgerName,
          ledger_group: isSupplierOnly ? 'Liabilities' : 'Assets',
          sub_group:    isSupplierOnly ? 'Sundry Creditors' : 'Sundry Debtors',
          is_system_ledger: false,
          is_party_ledger: true,
          party_id: p.party_id,
          is_active: true,
        }, { transaction: tt });
        createdLedgerIds.push(lg.ledger_id);
        await Party.update({ ledger_account_id: lg.ledger_id },
          { where: { party_id: p.party_id }, transaction: tt, hooks: false });
        const opening = Number(p.opening_balance) || 0;
        if (opening > 0.005) {
          await postVoucher({
            voucherType: 'Journal',
            sourceType: 'party_opening',
            sourceId: p.party_id,
            voucherDate: new Date(),
            referenceNumber: `OB-${p.party_id}`,
            narration: `Backfill opening for ${p.party_name}`,
            lines: [
              { ledgerAccountId: lg.ledger_id, debit: opening, credit: 0, partyId: p.party_id },
              { ledgerAccountId: obe.ledger_id, debit: 0, credit: opening },
            ],
            transaction: tt,
          });
        }
        await tt.commit();
      } catch (e) {
        await tt.rollback();
        throw e;
      }
    }
    await orphan.reload();
    check('Backfill: orphan now linked', orphan.ledger_account_id != null);
    check('Backfill: orphan opening JV posted',
      (await LedgerEntry.count({ where: { source_type: 'party_opening', reference_id: orphan.party_id } })) === 2);

  } catch (err) {
    console.error('TEST CRASH:', err);
    fail++;
  } finally {
    // ── Cleanup: remove every fixture this test created ──
    // raw SQL with hooks:false equivalent (it's raw, no hooks).
    for (const pid of createdPartyIds) {
      await sequelize.query(
        'DELETE FROM ledger_entries WHERE party_id = :pid OR (source_type = \'party_opening\' AND reference_id = :pid)',
        { replacements: { pid } },
      );
    }
    await sequelize.query(
      "DELETE FROM ledger_entries WHERE source_type = 'sales_bill' AND reference_id BETWEEN 999000000 AND 999999999",
    );
    // Delete parties FIRST (parties.ledger_account_id FKs ledger_accounts).
    if (createdPartyIds.length) {
      await sequelize.query(
        'DELETE FROM parties WHERE party_id IN (:ids)',
        { replacements: { ids: createdPartyIds } },
      );
    }
    if (createdLedgerIds.length) {
      await sequelize.query(
        'DELETE FROM ledger_accounts WHERE ledger_id IN (:ids)',
        { replacements: { ids: createdLedgerIds } },
      );
    }
  }

  // ── Verify clean DB state ──
  const finalCounts = {
    parties:         (await sequelize.query("SELECT COUNT(*) FROM parties WHERE party_name LIKE '__TEST_PHASE1_%'", { type: sequelize.QueryTypes.SELECT }))[0].count,
    test_ledgers:    (await sequelize.query("SELECT COUNT(*) FROM ledger_accounts WHERE ledger_name LIKE '__TEST_PHASE1_%'", { type: sequelize.QueryTypes.SELECT }))[0].count,
    test_entries:    (await sequelize.query("SELECT COUNT(*) FROM ledger_entries WHERE narration LIKE '%__TEST_PHASE1%' OR (source_type = 'sales_bill' AND reference_id BETWEEN 999000000 AND 999999999)", { type: sequelize.QueryTypes.SELECT }))[0].count,
  };
  check('Cleanup: 0 test parties remain',     Number(finalCounts.parties) === 0,     `count=${finalCounts.parties}`);
  check('Cleanup: 0 test ledgers remain',     Number(finalCounts.test_ledgers) === 0, `count=${finalCounts.test_ledgers}`);
  check('Cleanup: 0 test ledger_entries remain', Number(finalCounts.test_entries) === 0, `count=${finalCounts.test_entries}`);

  console.log('\n── Phase 1 Self-Test ──────────────────────────────');
  for (const r of results) console.log(r);
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await sequelize.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
