#!/usr/bin/env node
// ── backfill-auto-receipts.js ─────────────────────────────────────────
//
// Backfills the two-way ledger pieces (R8 phase 1) for bills that
// already have a paid_amount > 0:
//
//   For every paid sales bill with a non-cash customer that has a
//   matching `source_type='sales_bill_receipt'` ledger voucher BUT no
//   corresponding `payments_receipts` row, this script will create:
//     · a payments_receipts row tagged `source='auto_from_bill'`
//       and `source_bill_id = <bill>`
//     · a bill_payment_allocations row linking that receipt to the
//       source bill with allocated_amount = bill.paid_amount
//
//   Mirror logic for purchase_bills + 'purchase_bill_payment'.
//
// Out-of-scope (NOT touched, even with --apply):
//   · System Cash party bills (is_system_cash=true) — cash sales are
//     correctly single-voucher; no debtor leg to clear.
//   · Bills with NULL customer_id / supplier_id — legacy cash-without-
//     party rows; require a separate audit before touching.
//
// Modes:
//   --dry-run   (default)  — no DB writes, prints the plan + any
//                            mismatches.
//   --apply                — performs the inserts in a single
//                            transaction. Idempotent: a second run
//                            does nothing because the matching
//                            payments_receipts row will already
//                            exist (uniqueness keyed on
//                            source='auto_from_bill' AND source_bill_id
//                            AND transaction_type).
//
// Mismatches are reported but NEVER auto-fixed — the user reviews
// the dry-run output, decides scope, and re-runs with --apply if OK.
//
//   Usage: node server/scripts/backfill-auto-receipts.js [--dry-run|--apply]

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');

const DRY_RUN = !process.argv.includes('--apply');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function planSide(kind) {
  const isSales = kind === 'sales';
  const billTable    = isSales ? 'sales_bills'        : 'purchase_bills';
  const billPK       = isSales ? 'sales_bill_id'      : 'purchase_bill_id';
  const partyFK      = isSales ? 'customer_id'        : 'supplier_id';
  const sourceType   = isSales ? 'sales_bill_receipt' : 'purchase_bill_payment';
  const txType       = isSales ? 'Receipt'            : 'Payment';
  const billTypeEnum = isSales ? 'Sales'              : 'Purchase';
  const refBillTypeEnum = isSales ? 'Sales' : 'Purchase';

  // Pull every paid bill + its embedded-receipt voucher (if any) +
  // whether a payments_receipts row already exists for it.
  const rows = await sequelize.query(
    `SELECT
       b.${billPK}        AS bill_id,
       b.bill_number,
       b.bill_date,
       b.${partyFK}       AS party_id,
       p.party_name,
       p.is_system_cash,
       b.total_amount,
       b.paid_amount,
       b.balance_amount,
       (SELECT COALESCE(SUM(le.debit_amount), 0)::float
          FROM ledger_entries le
          JOIN ledger_accounts la ON la.ledger_id = le.ledger_id
         WHERE le.source_type = :st
           AND le.reference_id = b.${billPK}
           AND le.reversal_of_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id)
           AND la.sub_group IN ('Cash-in-Hand', 'Bank Accounts', 'Bank Account', 'Bank OD/CC', 'Bank OD A/c')
       ) AS embedded_cash_dr,
       (SELECT pr.transaction_id
          FROM payments_receipts pr
         WHERE pr.source = 'auto_from_bill'
           AND pr.source_bill_id = b.${billPK}
           AND pr.transaction_type = :tx
         LIMIT 1
       ) AS existing_receipt_id
     FROM ${billTable} b
     LEFT JOIN parties p ON p.party_id = b.${partyFK}
    WHERE b.is_cancelled = false
      AND b.paid_amount > 0
    ORDER BY b.bill_date, b.${billPK}`,
    { replacements: { st: sourceType, tx: txType }, type: sequelize.QueryTypes.SELECT },
  );

  const plan = {
    side: kind,
    total_paid_bills:    rows.length,
    in_scope:            [],
    already_migrated:    [],
    out_of_scope_cash:   [],
    out_of_scope_no_party: [],
    mismatches:          [],
  };

  for (const row of rows) {
    if (!row.party_id) {
      plan.out_of_scope_no_party.push(row);
      continue;
    }
    if (row.is_system_cash) {
      plan.out_of_scope_cash.push(row);
      continue;
    }
    if (row.existing_receipt_id) {
      plan.already_migrated.push({ ...row, existing_receipt_id: row.existing_receipt_id });
      continue;
    }
    const embeddedCash = r2(row.embedded_cash_dr);
    const expected     = r2(row.paid_amount);
    if (Math.abs(embeddedCash - expected) > 0.01) {
      plan.mismatches.push({
        ...row,
        reason: `embedded cash leg (${embeddedCash}) differs from bill.paid_amount (${expected})`,
      });
      continue;
    }
    plan.in_scope.push({
      ...row,
      bill_type_enum: billTypeEnum,
      tx_type:        txType,
      ref_bill_type:  refBillTypeEnum,
    });
  }
  return plan;
}

function fmtRow(r) {
  return `    · ${r.bill_number} (${r.bill_date.toISOString ? r.bill_date.toISOString().slice(0,10) : r.bill_date}) `
       + `${r.party_name || '(no party)'}  paid=₹${r2(r.paid_amount).toLocaleString('en-IN')}  `
       + (r.embedded_cash_dr != null ? `embedded=₹${r2(r.embedded_cash_dr).toLocaleString('en-IN')}` : '');
}

function printPlan(plan) {
  const side = plan.side === 'sales' ? 'SALES → Receipt' : 'PURCHASE → Payment';
  console.log(`\n── ${side} ──────────────────────────────────`);
  console.log(`  Paid bills (total): ${plan.total_paid_bills}`);
  console.log(`  In-scope (would migrate): ${plan.in_scope.length}`);
  for (const r of plan.in_scope) console.log(fmtRow(r));
  console.log(`  Already migrated (skip): ${plan.already_migrated.length}`);
  for (const r of plan.already_migrated) console.log(fmtRow(r) + ` → tx#${r.existing_receipt_id}`);
  console.log(`  Out of scope — system Cash party: ${plan.out_of_scope_cash.length}`);
  for (const r of plan.out_of_scope_cash) console.log(fmtRow(r));
  console.log(`  Out of scope — NULL party: ${plan.out_of_scope_no_party.length}`);
  for (const r of plan.out_of_scope_no_party) console.log(fmtRow(r));
  if (plan.mismatches.length > 0) {
    console.log(`  ⚠ Mismatches (need manual review): ${plan.mismatches.length}`);
    for (const r of plan.mismatches) console.log(fmtRow(r) + `  REASON: ${r.reason}`);
  } else {
    console.log(`  Mismatches: 0`);
  }
}

async function applyPlan(plan) {
  if (plan.in_scope.length === 0) return { inserted: 0 };
  const t = await sequelize.transaction();
  try {
    let inserted = 0;
    for (const row of plan.in_scope) {
      // Generate a transaction_number unique enough to identify the
      // backfilled row — derived from bill_number + R8B suffix.
      const txNumber = `${row.bill_number}-R8B`;
      const [insRow] = await sequelize.query(
        `INSERT INTO payments_receipts
           (transaction_number, transaction_type, transaction_date,
            party_id, reference_bill_id, reference_bill_type, reference_bill_number,
            total_amount, source, source_bill_id, remarks,
            is_cancelled, created_date, modified_date)
         VALUES (:tn, :tt, :td, :pid, :rbid, :rbt, :rbn, :amt,
                 'auto_from_bill', :sbid, :rem, false, NOW(), NOW())
         RETURNING transaction_id`,
        {
          replacements: {
            tn: txNumber, tt: row.tx_type, td: row.bill_date,
            pid: row.party_id,
            rbid: row.bill_id, rbt: row.ref_bill_type, rbn: row.bill_number,
            amt: r2(row.paid_amount), sbid: row.bill_id,
            rem: `Auto-generated from ${row.tx_type === 'Receipt' ? 'sales' : 'purchase'} bill ${row.bill_number} (R8 backfill)`,
          },
          transaction: t,
        },
      );
      const transactionId = insRow[0].transaction_id;
      await sequelize.query(
        `INSERT INTO bill_payment_allocations
           (transaction_id, bill_type, bill_id, allocated_amount, allocation_method)
         VALUES (:txid, :bt, :bid, :amt, 'auto_from_bill')`,
        {
          replacements: {
            txid: transactionId, bt: row.bill_type_enum, bid: row.bill_id,
            amt: r2(row.paid_amount),
          },
          transaction: t,
        },
      );
      inserted++;
    }
    await t.commit();
    return { inserted };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function main() {
  console.log('──────────────────────────────────────────────');
  console.log(`R8 Phase 1 — Auto-receipt/payment backfill (${DRY_RUN ? 'DRY-RUN' : 'APPLY'})`);
  console.log('──────────────────────────────────────────────');

  const sales    = await planSide('sales');
  const purchase = await planSide('purchase');

  printPlan(sales);
  printPlan(purchase);

  console.log('\n── Summary ─────────────────────────────────────');
  console.log(`  Sales — would create ${sales.in_scope.length} receipt(s) + ${sales.in_scope.length} allocation(s)`);
  console.log(`  Purchase — would create ${purchase.in_scope.length} payment(s) + ${purchase.in_scope.length} allocation(s)`);
  const totalMismatch = sales.mismatches.length + purchase.mismatches.length;
  if (totalMismatch > 0) {
    console.log(`  ⚠ Mismatches: ${totalMismatch} — review above before --apply`);
  } else {
    console.log(`  ✓ No mismatches — safe to --apply`);
  }

  if (!DRY_RUN) {
    console.log('\n── Applying ────────────────────────────────────');
    const sRes = await applyPlan(sales);
    const pRes = await applyPlan(purchase);
    console.log(`  Inserted ${sRes.inserted} receipt(s) + allocations`);
    console.log(`  Inserted ${pRes.inserted} payment(s) + allocations`);
    console.log('──────────────────────────────────────────────\n');
  } else {
    console.log('\n  (dry-run — no changes written; pass --apply to execute)');
    console.log('──────────────────────────────────────────────\n');
  }

  await sequelize.close();
}

main().catch(async (err) => {
  console.error('Backfill error:', err);
  try { await sequelize.close(); } catch {}
  process.exit(2);
});
