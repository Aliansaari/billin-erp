#!/usr/bin/env node
// ── backfill-import-allocations.js (R9 Phase 2/3) ─────────────────────
//
// Backfills `bill_payment_allocations` rows for every manual receipt /
// payment that pre-dates the R9 import-orchestrator change. These are
// rows where:
//   · source = 'manual'           (auto rows are already 1:1 allocated)
//   · party_id IS NOT NULL        (cash-without-party rows are out of
//                                  scope — separate audit needed)
//   · is_cancelled = false
//   · zero rows in bill_payment_allocations for this transaction
//
// FIFO snapshot-at-date — for each receipt we compute the party's
// outstanding bills AS THEY WERE on the receipt date (not today's
// state), then allocate oldest-first. Allocating against a bill that
// did not exist yet on the receipt date would rewrite history.
//
// We DON'T update bill.balance_amount during backfill. The current
// balances already reflect reconcileBillsForParty's implicit FIFO
// (called on every payment create/update/cancel). Our explicit
// allocation matches that implicit allocation by construction (same
// FIFO-by-bill_date order), so writing the rows keeps:
//   bill.balance_amount == total_amount − SUM(allocations)
// invariant true. The Phase-3 verification step asserts this.
//
// Usage:
//   node server/scripts/backfill-import-allocations.js [--dry-run|--apply]
//
// Default is --dry-run. --apply runs each receipt in its own transaction
// (atomic per receipt — one bad row doesn't roll back the others).
//
// Output:
//   Per-receipt plan in the form:
//     · RCT-2025-001 (₹12,500 from Sharma Trading Co., 2025-04-08)
//         → INV-2025-003 ₹3,000 + INV-2025-005 ₹9,500. Remainder: ₹0.
//   Summary: total processed, allocations created, skipped (with reasons),
//   projected post-backfill BR/BP unallocated_count.
//
// Skipped rows (no matching bills at receipt date) are written to
//   /tmp/backfill_skipped-<timestamp>.csv
// for the user to triage manually.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const inr = (v) => '₹' + (r2(v)).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const SIDE = {
  Sales:    { table: 'sales_bills',    pk: 'sales_bill_id',    partyFk: 'customer_id' },
  Purchase: { table: 'purchase_bills', pk: 'purchase_bill_id', partyFk: 'supplier_id' },
};

// ── findCandidates ────────────────────────────────────────────────────
async function findCandidates() {
  return sequelize.query(
    `SELECT pr.transaction_id, pr.transaction_number, pr.transaction_type,
            pr.transaction_date, pr.party_id, pr.total_amount,
            p.party_name, p.is_system_cash
       FROM payments_receipts pr
       JOIN parties p ON p.party_id = pr.party_id
      WHERE pr.source = 'manual'
        AND pr.is_cancelled = false
        AND pr.party_id IS NOT NULL
        AND (p.is_system_cash IS NULL OR p.is_system_cash = false)
        AND NOT EXISTS (
          SELECT 1 FROM bill_payment_allocations bpa
           WHERE bpa.transaction_id = pr.transaction_id
        )
      ORDER BY pr.transaction_date ASC, pr.transaction_id ASC`,
    { type: sequelize.QueryTypes.SELECT },
  );
}

// ── snapshotOutstanding (historical) ──────────────────────────────────
//
// Bill outstanding AS OF receipt_date: total_amount minus SUM of all
// non-cancelled allocations whose underlying receipt date is on or
// BEFORE receipt_date. Auto-receipt allocations land here too (their
// receipt date == bill date, so they're always "before" any later
// manual receipt).
//
// Critically, allocations from receipts processed EARLIER in this same
// backfill run also count, because we COMMIT each receipt's allocations
// before processing the next (when --apply). For --dry-run, we accumulate
// in-memory.
async function snapshotOutstanding(partyId, billType, asOfDate, inMemoryAllocs) {
  const cfg = SIDE[billType];
  const rows = await sequelize.query(
    `SELECT b.${cfg.pk}    AS bill_id,
            b.bill_number,
            b.bill_date,
            b.total_amount,
            COALESCE((
              SELECT SUM(bpa.allocated_amount)::float
                FROM bill_payment_allocations bpa
                JOIN payments_receipts pr ON pr.transaction_id = bpa.transaction_id
               WHERE bpa.bill_id   = b.${cfg.pk}
                 AND bpa.bill_type = :bt
                 AND pr.is_cancelled = false
                 AND pr.transaction_date <= :asof
            ), 0)::float AS allocated_to_date
       FROM ${cfg.table} b
      WHERE b.${cfg.partyFk} = :pid
        AND b.is_cancelled = false
        AND b.bill_date <= :asof
      ORDER BY b.bill_date ASC, b.${cfg.pk} ASC`,
    { replacements: { pid: partyId, bt: billType, asof: asOfDate },
      type: sequelize.QueryTypes.SELECT },
  );
  // Layer in-memory allocations (dry-run accumulated state).
  const memMap = inMemoryAllocs.get(`${billType}:${partyId}`) || new Map();
  return rows.map((r) => {
    const memDelta = memMap.get(r.bill_id) || 0;
    const allocatedAll = r2(Number(r.allocated_to_date) + memDelta);
    return {
      ...r,
      allocated_to_date: r2(r.allocated_to_date),
      outstanding_at_date: r2(Math.max(0, Number(r.total_amount) - allocatedAll)),
    };
  });
}

// ── fifoPlan ──────────────────────────────────────────────────────────
function fifoPlan(bills, totalAmount) {
  const plan = [];
  let left = r2(totalAmount);
  for (const b of bills) {
    if (left <= 0.005) break;
    const cap = b.outstanding_at_date;
    if (cap <= 0) continue;
    const apply = r2(Math.min(left, cap));
    plan.push({
      bill_id:     b.bill_id,
      bill_number: b.bill_number,
      bill_date:   b.bill_date,
      amount:      apply,
    });
    left = r2(left - apply);
  }
  return { plan, remainder: r2(left) };
}

// ── computeBanner — projected unallocated_count after backfill ────────
//
// The runtime banner formula in billsOutstandingController is:
//   COUNT(manual receipts WHERE total_amount > SUM(allocations))
// so a receipt with a remainder (advance) STILL counts as flagged.
// Per-receipt projection:
//   · Plan = []                       → still flagged (zero allocs)
//   · Plan covers full total          → drops out
//   · Plan partial (remainder > 0)    → still flagged (partial)
async function computeBannerProjection(plans) {
  const before = await sequelize.query(
    `SELECT pr.transaction_type, COUNT(*)::int AS n
       FROM payments_receipts pr
       JOIN parties p ON p.party_id = pr.party_id
      WHERE pr.source = 'manual'
        AND pr.is_cancelled = false
        AND pr.party_id IS NOT NULL
        AND (p.is_system_cash IS NULL OR p.is_system_cash = false)
        AND pr.total_amount > COALESCE((
          SELECT SUM(bpa.allocated_amount) FROM bill_payment_allocations bpa
           WHERE bpa.transaction_id = pr.transaction_id
        ), 0)
      GROUP BY pr.transaction_type`,
    { type: sequelize.QueryTypes.SELECT },
  );
  const beforeMap = new Map(before.map((r) => [r.transaction_type, r.n]));
  const beforeR = beforeMap.get('Receipt') || 0;
  const beforeP = beforeMap.get('Payment') || 0;

  let projR = beforeR, projP = beforeP;
  let zeroR = 0, zeroP = 0, partialR = 0, partialP = 0;
  for (const p of plans) {
    const isReceipt = p.receipt.transaction_type === 'Receipt';
    if (p.plan.length === 0) {
      if (isReceipt) zeroR++; else zeroP++;
      continue; // empty plan = still flagged
    }
    if (p.remainder > 0.005) {
      if (isReceipt) partialR++; else partialP++;
      continue; // partial = still flagged
    }
    // Fully covered → drops out
    if (isReceipt) projR--; else projP--;
  }
  return {
    beforeR, beforeP,
    projR: Math.max(0, projR), projP: Math.max(0, projP),
    zeroR, zeroP, partialR, partialP,
  };
}

// ── readIntegrityState — R8 I1-I6 invariants ─────────────────────────
//
// Backfill writes only into bill_payment_allocations. It never touches
// ledger entries or bill.balance_amount, so all 6 invariants — including
// I5/I6 which use the 6-term ledger-vs-bills reconciliation — should
// stay in whatever state they were before. Print pass/fail per invariant
// so the user can confirm post-apply parity.
async function readIntegrityState() {
  const { checkIntegrity } = require('../services/autoReceiptService');
  return checkIntegrity();
}

// ── main ──────────────────────────────────────────────────────────────
(async () => {
  console.log('──────────────────────────────────────────────');
  console.log(`R9 Phase 2/3 — Import allocation backfill (${DRY_RUN ? 'DRY-RUN' : 'APPLY'})`);
  console.log('──────────────────────────────────────────────');

  const candidates = await findCandidates();
  console.log(`\nUnallocated manual receipts/payments found: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('  ✓ Nothing to backfill — all manual rows already have allocations.');
    await sequelize.close();
    process.exit(0);
  }

  // Plan phase. For dry-run we accumulate allocations in-memory so each
  // subsequent receipt sees the reduced outstanding (otherwise multiple
  // receipts against the same bill on the same date would all "see" the
  // full balance and over-allocate in the printed plan).
  const inMemoryAllocs = new Map(); // key: `${billType}:${partyId}` → Map<bill_id, amount>
  const plans = [];

  for (const r of candidates) {
    const billType = r.transaction_type === 'Receipt' ? 'Sales' : 'Purchase';
    const bills = await snapshotOutstanding(r.party_id, billType, r.transaction_date, inMemoryAllocs);
    const { plan, remainder } = fifoPlan(bills, r.total_amount);
    plans.push({ receipt: r, billType, plan, remainder });
    // Bookkeeping: layer this receipt's plan into the memo so the next
    // receipt's snapshot sees it.
    const k = `${billType}:${r.party_id}`;
    if (!inMemoryAllocs.has(k)) inMemoryAllocs.set(k, new Map());
    const m = inMemoryAllocs.get(k);
    for (const a of plan) m.set(a.bill_id, (m.get(a.bill_id) || 0) + a.amount);
  }

  // Print plan.
  let totalAllocs = 0, totalAdvance = 0, totalSkipped = 0;
  console.log('\n── Per-receipt plan ─────────────────────────────────────────');
  for (const p of plans) {
    const dateStr = p.receipt.transaction_date.toISOString
      ? p.receipt.transaction_date.toISOString().slice(0, 10)
      : String(p.receipt.transaction_date).slice(0, 10);
    const head = `  · ${p.receipt.transaction_type} ${p.receipt.transaction_number} `
               + `(${inr(p.receipt.total_amount)} from ${p.receipt.party_name}, ${dateStr})`;
    if (p.plan.length === 0) {
      console.log(`${head}  → SKIP — no matching bills at receipt date`);
      totalSkipped++;
    } else {
      const allocStr = p.plan
        .map((a) => `${a.bill_number} ${inr(a.amount)}`)
        .join(' + ');
      const remarkStr = p.remainder > 0
        ? `Remainder (advance): ${inr(p.remainder)}`
        : 'Remainder: ₹0.';
      console.log(`${head}\n      → ${allocStr}. ${remarkStr}`);
      totalAllocs += p.plan.length;
      if (p.remainder > 0) totalAdvance++;
    }
  }

  // Banner projection.
  const banner = await computeBannerProjection(plans);
  console.log('\n── Summary ───────────────────────────────────────────────');
  console.log(`  Receipts/payments processed: ${plans.length}`);
  console.log(`  Allocation rows ${DRY_RUN ? 'to be created' : 'created'}: ${totalAllocs}`);
  console.log(`  With remainder (on-account advance): ${totalAdvance}`);
  console.log(`  Skipped (no matching bills): ${totalSkipped}`);
  console.log('');
  console.log(`  BR banner unallocated_count: ${banner.beforeR} → ${DRY_RUN ? banner.projR + ' (projected)' : banner.projR}`);
  console.log(`     residue breakdown: ${banner.zeroR} zero-alloc + ${banner.partialR} partial-with-remainder`);
  console.log(`  BP banner unallocated_count: ${banner.beforeP} → ${DRY_RUN ? banner.projP + ' (projected)' : banner.projP}`);
  console.log(`     residue breakdown: ${banner.zeroP} zero-alloc + ${banner.partialP} partial-with-remainder`);

  // Integrity snapshot — R8 I1-I6 invariants (includes the 6-term
  // ledger-vs-bills reconciliation in I5/I6). Backfill writes only to
  // bill_payment_allocations and never touches ledger or balance_amount,
  // so post-apply I1-I6 should equal pre-apply.
  const intBefore = await readIntegrityState();
  console.log('\n── Integrity invariants (current state) ─────────────────');
  for (const inv of intBefore.invariants) {
    console.log(`  ${inv.ok ? '✓' : '✗'} ${inv.name}${inv.ok ? '' : ` (${inv.violation_count || 'fail'})`}`);
  }
  console.log(`  ${intBefore.all_pass ? '✓ ALL PASS' : '✗ SOME FAIL'} — backfill writes only allocations; no ledger/balance change → state unchanged after --apply`);

  // Write skipped CSV (always, even on dry-run, so the user can pre-
  // review what'll need manual triage).
  if (totalSkipped > 0) {
    const skippedRows = plans.filter((p) => p.plan.length === 0);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvPath = path.join('/tmp', `backfill_skipped-${stamp}.csv`);
    const csv = [
      'transaction_number,transaction_type,transaction_date,party_name,total_amount,reason',
      ...skippedRows.map((p) => {
        const r = p.receipt;
        const dateStr = r.transaction_date.toISOString
          ? r.transaction_date.toISOString().slice(0, 10)
          : String(r.transaction_date).slice(0, 10);
        return [
          r.transaction_number, r.transaction_type, dateStr,
          `"${r.party_name.replace(/"/g, '""')}"`,
          r2(r.total_amount).toFixed(2),
          'No matching bills at receipt date',
        ].join(',');
      }),
    ].join('\n');
    fs.writeFileSync(csvPath, csv);
    console.log(`\n  Skipped CSV: ${csvPath}`);
  }

  if (DRY_RUN) {
    console.log('\n  (dry-run — no changes written; pass --apply to execute)');
    console.log('──────────────────────────────────────────────\n');
    await sequelize.close();
    process.exit(0);
  }

  // Apply phase. One transaction per receipt — atomic per row, so a
  // failure on one doesn't undo prior successes.
  console.log('\n── Applying ─────────────────────────────────────────────');
  let inserted = 0, errors = 0;
  for (const p of plans) {
    if (p.plan.length === 0) continue;
    const t = await sequelize.transaction();
    try {
      const [{ n }] = await sequelize.query(
        `SELECT COUNT(*)::int AS n FROM bill_payment_allocations WHERE transaction_id = :id`,
        { replacements: { id: p.receipt.transaction_id }, type: sequelize.QueryTypes.SELECT, transaction: t },
      );
      if (n > 0) { await t.rollback(); continue; } // idempotency
      for (const a of p.plan) {
        await sequelize.query(
          `INSERT INTO bill_payment_allocations
             (transaction_id, bill_type, bill_id, allocated_amount, allocation_method)
           VALUES (:tid, :bt, :bid, :amt, 'backfill_fifo')`,
          {
            replacements: {
              tid: p.receipt.transaction_id, bt: p.billType,
              bid: a.bill_id, amt: a.amount,
            },
            transaction: t,
          },
        );
        inserted++;
      }
      await t.commit();
    } catch (err) {
      await t.rollback();
      errors++;
      console.error(`  ✗ ${p.receipt.transaction_number}: ${err.message}`);
    }
  }
  console.log(`  Inserted ${inserted} allocation row(s) across ${plans.length - totalSkipped} receipt(s).`);
  if (errors > 0) console.log(`  ⚠ ${errors} apply error(s) — see stderr above.`);

  // Re-read banner + invariants for confirmation.
  const bannerAfter = await computeBannerProjection([]); // no in-flight plans
  const intAfter    = await readIntegrityState();
  console.log('\n── Post-apply state ─────────────────────────────────────');
  console.log(`  BR banner unallocated_count: ${bannerAfter.beforeR}`);
  console.log(`  BP banner unallocated_count: ${bannerAfter.beforeP}`);
  console.log('  Integrity invariants:');
  for (const inv of intAfter.invariants) {
    console.log(`    ${inv.ok ? '✓' : '✗'} ${inv.name}`);
  }
  console.log(`  ${intAfter.all_pass ? '✓ ALL PASS' : '✗ FAIL — investigate before continuing'}`);
  console.log('──────────────────────────────────────────────\n');

  await sequelize.close();
  process.exit(errors > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error('Backfill error:', err);
  try { await sequelize.close(); } catch (_) {}
  process.exit(2);
});
