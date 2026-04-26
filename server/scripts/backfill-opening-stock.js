#!/usr/bin/env node
// Backfill missing Opening Stock rows in stock_ledger.
//
// Repro of the gap: products imported before the Phase-5g fix landed
// got their `opening_stock` and `current_stock` columns populated, but
// no `stock_ledger` row of type 'Opening Stock' was written. As a
// result Stock Movement views show Opening=0 and a closing balance
// that doesn't match On Hand.
//
// What this script does:
//   1. Walk every product that has opening_stock > 0 AND no
//      'Opening Stock' row in stock_ledger.
//   2. Insert one Opening Stock row per product:
//        quantity_in     = products.opening_stock
//        rate            = products.opening_stock_rate ?? products.purchase_rate ?? 0
//        transaction_date = products.opening_stock_date ?? (FY start − 1 day)
//        reference_number = 'OPENING'
//   3. Leaves products.current_stock untouched. The values were
//      consistent before this script ran (current_stock was set from
//      opening_stock at import time, with no other transactions
//      affecting it) — adding the Opening row now makes stock_ledger
//      arithmetic match what was already in current_stock.
//
// Idempotent — re-running is safe. Each product is checked for an
// existing Opening Stock row before insert.
//
// Run with: node server/scripts/backfill-opening-stock.js [--dry-run]

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { sequelize, Product, StockLedger, SystemSettings } = require('../models');

const DRY = process.argv.includes('--dry-run');

async function fyMinusOne() {
  const settings = await SystemSettings.findOne({ where: { setting_id: 1 } });
  if (settings && settings.financial_year_start) {
    const fy = new Date(settings.financial_year_start);
    fy.setDate(fy.getDate() - 1);
    return fy.toISOString().slice(0, 10);
  }
  const t = new Date();
  t.setDate(t.getDate() - 1);
  return t.toISOString().slice(0, 10);
}

async function main() {
  const fyDate = await fyMinusOne();
  // Products with opening_stock > 0 that are missing the Opening row.
  const candidates = await sequelize.query(
    `SELECT p.product_id, p.product_name, p.barcode,
            p.opening_stock, p.opening_stock_rate, p.purchase_rate,
            p.opening_stock_date
       FROM products p
      WHERE COALESCE(p.opening_stock, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM stock_ledger sl
           WHERE sl.product_id = p.product_id
             AND sl.transaction_type = 'Opening Stock'
        )
      ORDER BY p.product_id ASC`,
    { type: sequelize.QueryTypes.SELECT },
  );

  console.log(`Found ${candidates.length} product(s) with opening_stock and no Opening Stock ledger row.${DRY ? ' (dry-run)' : ''}`);
  if (candidates.length === 0) {
    await sequelize.close();
    return;
  }

  let inserted = 0, skipped = 0, failed = 0;
  for (const p of candidates) {
    const qty  = Number(p.opening_stock) || 0;
    // DECIMAL columns come back from raw SQL as strings — `"0.00" || "25"`
    // returns `"0.00"` (truthy), defeating the fallback. Coerce each
    // candidate to Number first, fall through when it's a numeric zero.
    const rate = Number(p.opening_stock_rate) || Number(p.purchase_rate) || 0;
    const date = p.opening_stock_date
      ? String(p.opening_stock_date).slice(0, 10)
      : fyDate;
    if (qty <= 0) { skipped++; continue; }

    if (DRY) {
      console.log(`  [dry] would insert: ${p.product_name} qty=${qty} rate=${rate} date=${date}`);
      inserted++;
      continue;
    }

    const t = await sequelize.transaction();
    try {
      // Re-check existence inside the transaction — handles the race
      // where a parallel import wrote the row between the SELECT above
      // and now. Idempotency guard.
      const has = await StockLedger.count({
        where: { product_id: p.product_id, transaction_type: 'Opening Stock' },
        transaction: t,
      });
      if (has > 0) { skipped++; await t.commit(); continue; }
      await StockLedger.create({
        product_id: p.product_id,
        barcode: p.barcode,
        transaction_type: 'Opening Stock',
        transaction_date: date,
        reference_number: 'OPENING',
        quantity_in: qty,
        quantity_out: 0,
        rate,
        balance_quantity: qty,
        remarks: 'Opening Stock (backfill)',
      }, { transaction: t });
      await t.commit();
      inserted++;
    } catch (e) {
      try { await t.rollback(); } catch (_) { /* swallow */ }
      console.error(`  ✗ ${p.product_name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone. inserted=${inserted}, skipped=${skipped}, failed=${failed}`);
  await sequelize.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
