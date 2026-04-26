#!/usr/bin/env node
// Backfill products.current_stock to match SUM(stock_ledger.qty_in − qty_out).
//
// stock_ledger is the source of truth; products.current_stock is a
// denormalised cache for fast reads on inventory tile rendering.
// They drifted on Excel-imported sales/purchases before the Phase-5h
// fix because the orchestrator wrote stock_ledger + bill_items rows
// without bumping current_stock. This one-shot reconciles every
// product, leaves balanced ones alone, and reports the drift.
//
//   node server/scripts/backfill-current-stock.js [--dry-run]
//
// Idempotent. Re-running on a clean DB is a no-op.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { sequelize, Product } = require('../models');

const DRY = process.argv.includes('--dry-run');

async function main() {
  const drifted = await sequelize.query(
    `SELECT p.product_id,
            p.product_name,
            p.barcode,
            p.current_stock::float AS current_stock,
            COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)::float AS ledger_balance,
            (COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) - p.current_stock)::float AS delta
       FROM products p
       LEFT JOIN stock_ledger sl ON sl.product_id = p.product_id
      GROUP BY p.product_id, p.product_name, p.barcode, p.current_stock
      HAVING ABS(p.current_stock - COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0)) > 0.005
      ORDER BY p.product_name ASC`,
    { type: sequelize.QueryTypes.SELECT },
  );

  console.log(`Found ${drifted.length} product(s) with drift between current_stock and stock_ledger.${DRY ? ' (dry-run)' : ''}`);
  if (drifted.length === 0) {
    await sequelize.close();
    return;
  }

  let updated = 0, failed = 0;
  for (const r of drifted) {
    const tag = `${r.product_name}${r.barcode ? ` [${r.barcode}]` : ''}`;
    const msg = `  ${tag}: current_stock=${r.current_stock} ledger=${r.ledger_balance} delta=${r.delta >= 0 ? '+' : ''}${r.delta}`;
    if (DRY) { console.log(msg + ' → would update'); updated++; continue; }
    try {
      await Product.update(
        { current_stock: r.ledger_balance },
        { where: { product_id: r.product_id } },
      );
      console.log(msg + ' → updated');
      updated++;
    } catch (e) {
      console.error(msg + ` → FAILED: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone. updated=${updated}, failed=${failed}`);
  await sequelize.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
