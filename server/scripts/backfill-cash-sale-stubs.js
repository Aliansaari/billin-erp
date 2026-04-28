#!/usr/bin/env node
// Backfill: migrate "Cash Sales" / "Cash Purchases" stub-party
// postings to the real Cash ledger via reverse + repost, then
// soft-delete the stub party + ledger account (is_active=false).
//
// History — first cut of this script used direct SQL UPDATE on
// ledger_entries to swap ledger_id from stub→Cash, then DELETE on
// the parent party row. The DELETE silently cascaded into
// ledger_entries (ON DELETE CASCADE on the FK) and wiped ₹8,606 of
// debits. The cascade has since been changed to RESTRICT, and this
// script now follows the same pattern any party-removal must follow:
//
//   1. Reverse every live voucher posted against the stub via
//      ledgerPostingService.reverseVoucher (mirror entries → live
//      count drops to zero, but the original rows stay for audit).
//   2. Update the bill row to its cash-sale shape: customer_id /
//      supplier_id NULL'd (sales) or pointed at the canonical "Cash
//      Purchases" supplier stub (purchases — that party stays as it's
//      a system stub, not a per-customer one). paid_amount=total,
//      balance=0, status=Paid, payment_method=Cash.
//   3. Re-post via buildSalesBillVouchers / buildPurchaseBillVouchers
//      — the no-customer branch posts Cash Dr / Sales Cr directly.
//   4. Soft-delete (is_active=false) on both the stub party and its
//      ledger account.
//
// Active Dr/Cr stays balanced throughout because reverse pairs sum
// to zero and re-posts are themselves balanced. The audit trail is
// preserved: original entries + their reversal mirrors + the new
// re-posted entries all coexist in ledger_entries.
//
// Usage:
//   node server/scripts/backfill-cash-sale-stubs.js --dry-run
//   node server/scripts/backfill-cash-sale-stubs.js
// Idempotent: re-running finds no is_active=true cash-class stubs.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sequelize = require('../config/database');
const {
  Party, LedgerAccount, SalesBill, PurchaseBill,
} = require('../models');
const { reverseVoucher, postVoucher } = require('../services/ledgerPostingService');
const { buildSalesBillVouchers, buildPurchaseBillVouchers } = require('../services/voucherBuilders');

const DRY = process.argv.includes('--dry-run');

function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

async function activeTotals() {
  const [r] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount), 0)::float dr,
            COALESCE(SUM(le.credit_amount), 0)::float cr
       FROM ledger_entries le
      WHERE le.reversal_of_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id
        )`,
    { type: sequelize.QueryTypes.SELECT },
  );
  return { dr: r2(r.dr), cr: r2(r.cr) };
}

async function ledgerLiveNet(ledgerId, transaction) {
  // Pass the transaction explicitly so the helper sees the in-flight
  // mutations (post-reversal mirrors) rather than the last committed
  // snapshot. Without this, the post-reverse net check reads stale
  // data and refuses to soft-delete a ledger that's actually paired.
  const [r] = await sequelize.query(
    `SELECT COALESCE(SUM(le.debit_amount - le.credit_amount), 0)::float net
       FROM ledger_entries le
      WHERE le.ledger_id = :id
        AND le.reversal_of_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries m WHERE m.reversal_of_id = le.entry_id
        )`,
    { replacements: { id: ledgerId }, type: sequelize.QueryTypes.SELECT, transaction },
  );
  return r2(r.net);
}

async function main() {
  const before = await activeTotals();
  console.log('Active totals BEFORE: Dr', before.dr.toFixed(2), 'Cr', before.cr.toFixed(2),
              '  balanced:', Math.abs(before.dr - before.cr) < 0.01);

  // Find candidate stub parties: still is_active=true, in Sundry
  // Debtors / Creditors, name matches the cash-class regex.
  const candidates = await sequelize.query(
    `SELECT p.party_id, p.party_name, p.party_type, p.ledger_account_id,
            la.sub_group, la.is_active AS ledger_active
       FROM parties p
       JOIN ledger_accounts la ON la.ledger_id = p.ledger_account_id
      WHERE p.is_active = true
        AND la.is_active = true
        AND la.sub_group IN ('Sundry Debtors', 'Sundry Creditors')
        AND p.party_name ~* '^\\s*cash(\\s+(sales|purchases?))?\\s*$'`,
    { type: sequelize.QueryTypes.SELECT },
  );

  if (candidates.length === 0) {
    console.log('No active cash-class stub parties found. Nothing to backfill.');
    await sequelize.close();
    process.exit(0);
  }

  for (const c of candidates) {
    console.log(`\n── ${c.party_name} (party_id=${c.party_id}, ledger_id=${c.ledger_account_id}, ${c.sub_group}) ──`);
    const beforeLedgerNet = await ledgerLiveNet(c.ledger_account_id);
    console.log(`  ledger live net before: ${beforeLedgerNet.toFixed(2)}`);

    const isCustomer = c.party_type === 'Customer';
    const Bill       = isCustomer ? SalesBill : PurchaseBill;
    const idCol      = isCustomer ? 'sales_bill_id' : 'purchase_bill_id';
    const fkCol      = isCustomer ? 'customer_id' : 'supplier_id';
    const sourceType = isCustomer ? 'sales_bill' : 'purchase_bill';
    const subType    = isCustomer ? 'sales_bill_receipt' : 'purchase_bill_payment';
    const builder    = isCustomer ? buildSalesBillVouchers : buildPurchaseBillVouchers;
    const includeAs  = isCustomer ? 'customer' : 'supplier';

    // The bills FK-pointing at the stub. Each one needs reverse + repost.
    const bills = await Bill.findAll({ where: { [fkCol]: c.party_id } });
    console.log(`  ${bills.length} ${sourceType} rows to reverse + repost`);

    if (DRY) {
      for (const b of bills) {
        console.log(`    ${b.bill_date}  ${b.bill_number}  total=${b.total_amount}`);
      }
      console.log('  --dry-run: no changes');
      continue;
    }

    const t = await sequelize.transaction();
    try {
      // 1. Reverse every voucher posted against the stub party's bills.
      //    Use sourceType + bill primary key. Also reverse the receipt-
      //    at-sale leg (sales_bill_receipt / purchase_bill_payment) if
      //    one exists, since the original might have had paid_amount > 0
      //    and we're rewriting that too.
      for (const b of bills) {
        await reverseVoucher({ sourceType,         sourceId: b[idCol], reason: 'cash-stub backfill',     transaction: t });
        await reverseVoucher({ sourceType: subType, sourceId: b[idCol], reason: 'cash-stub backfill', transaction: t });
      }

      // 2. Re-shape each bill row to the cash-sale form.
      for (const b of bills) {
        const update = {
          [fkCol]: isCustomer ? null : await ensureCanonicalCashPurchasesParty(t),
          paid_amount:    b.total_amount,
          balance_amount: 0,
          payment_status: 'Paid',
          payment_method: 'Cash',
        };
        await b.update(update, { transaction: t });
      }

      // 3. Re-post via the standard voucher builder. With customer_id
      //    null (sales) the builder's walk-in branch puts Cash Dr / Sales
      //    Cr directly — no party leg, no stub. For purchase, the
      //    canonical "Cash Purchases" supplier stub continues to be
      //    used (it's a system fixture, not a per-customer leak).
      for (const b of bills) {
        const refreshed = await Bill.findByPk(b[idCol], {
          include: [{ model: Party, as: includeAs }],
          transaction: t,
        });
        const vouchers = await builder(refreshed, { transaction: t });
        for (const v of vouchers) {
          await postVoucher({ ...v, transaction: t });
        }
      }

      // 4. Confirm the stub ledger's live net is now zero — every
      //    original was paired with a mirror, and the re-posts went
      //    elsewhere (Cash for sales; canonical stub for purchase).
      const afterLedgerNet = await ledgerLiveNet(c.ledger_account_id, t);
      if (Math.abs(afterLedgerNet) > 0.01) {
        throw new Error(
          `stub ledger ${c.ledger_account_id} live net = ${afterLedgerNet} after reversal — refusing to soft-delete`,
        );
      }
      console.log(`  ledger live net after reversal: ${afterLedgerNet.toFixed(2)} (paired)`);

      // 5. Soft-delete: is_active=false on both party and ledger.
      //    NEVER hard-delete — the FK is now ON DELETE RESTRICT, and
      //    even if it weren't, the audit trail (originals + mirrors)
      //    must persist.
      await sequelize.query(
        `UPDATE parties SET is_active = false WHERE party_id = :id`,
        { replacements: { id: c.party_id }, transaction: t },
      );
      await sequelize.query(
        `UPDATE ledger_accounts SET is_active = false WHERE ledger_id = :id`,
        { replacements: { id: c.ledger_account_id }, transaction: t },
      );
      console.log(`  ✓ soft-deleted stub party + ledger`);

      await t.commit();
    } catch (err) {
      try { await t.rollback(); } catch (_) {}
      throw err;
    }
  }

  // Verification: Active Dr/Cr unchanged.
  const after = await activeTotals();
  console.log('\nActive totals AFTER:  Dr', after.dr.toFixed(2), 'Cr', after.cr.toFixed(2),
              '  balanced:', Math.abs(after.dr - after.cr) < 0.01);
  const driftDr = r2(after.dr - before.dr);
  const driftCr = r2(after.cr - before.cr);
  console.log('Δ Dr:', driftDr.toFixed(2), 'Δ Cr:', driftCr.toFixed(2),
              '(both should be 0.00 — reverse + repost is value-preserving)');
  if (Math.abs(driftDr) > 0.01 || Math.abs(driftCr) > 0.01) {
    console.error('FAIL: integrity drift detected');
    await sequelize.close();
    process.exit(1);
  }

  console.log('\nDone.', DRY ? '(--dry-run, no changes were committed)' : '(committed)');
  await sequelize.close();
}

// Returns the party_id of the canonical "Cash Purchases" Supplier stub
// (the system fixture used by Tally cash-purchase imports — distinct
// from a per-customer "Cash Sales" leak). Creates one if missing.
async function ensureCanonicalCashPurchasesParty(t) {
  const [existing] = await sequelize.query(
    `SELECT party_id FROM parties
      WHERE party_name = 'Cash Purchases' AND mobile_1 = 'CASH-PURCHASES'
        AND is_active = true
      ORDER BY party_id ASC LIMIT 1`,
    { type: sequelize.QueryTypes.SELECT, transaction: t },
  );
  if (existing) return existing.party_id;
  const [{ party_id }] = await sequelize.query(
    `INSERT INTO parties (party_type, party_name, mobile_1, opening_balance,
                          opening_balance_type, is_active, created_date, modified_date)
     VALUES ('Supplier', 'Cash Purchases', 'CASH-PURCHASES', 0,
             'Payable', true, NOW(), NOW())
     RETURNING party_id`,
    { type: sequelize.QueryTypes.SELECT, transaction: t },
  );
  return party_id;
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
