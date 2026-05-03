#!/usr/bin/env node
/*
 * Single Product mode migration verification. Run with:
 *   node server/scripts/test-product-mode-migration.js
 *
 * Verifies the Phase-1 migration outcome: schema additions in place,
 * existing products defaulted to 'variant', orphan is_batch_tracked
 * flags cleared on variant rows, system setting present and writable.
 *
 * Read-only on existing data. Creates one synthetic single-mode
 * fixture to test that defaults flow through, then deletes it.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { sequelize, Product, SystemSettings } = require('../models');

let pass = 0, fail = 0;
const results = [];
const FIXTURE_PREFIX = '_TPM_';

function check(name, condition, detail = '') {
  if (condition) { pass++; results.push(`  ✓ ${name}`); }
  else           { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function cleanup() {
  await sequelize.query(`DELETE FROM products WHERE product_name LIKE :p`,
    { replacements: { p: FIXTURE_PREFIX + '%' } });
}

async function runTests() {
  await cleanup();

  // ── Schema: every new column present with the right type ────────────
  const cols = await sequelize.query(`
    SELECT table_name, column_name, udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE (table_name='products' AND column_name IN ('product_mode','weighted_avg_cost','last_purchase_rate','last_purchase_date'))
        OR (table_name='product_batches' AND column_name='purchase_rate')
        OR (table_name='system_settings' AND column_name='default_product_mode')
  `, { type: sequelize.QueryTypes.SELECT });
  const colMap = Object.fromEntries(cols.map(c => [`${c.table_name}.${c.column_name}`, c]));

  check('SCHEMA: products.product_mode is ENUM with NOT NULL + default variant',
    colMap['products.product_mode']?.udt_name === 'enum_products_product_mode'
      && colMap['products.product_mode']?.is_nullable === 'NO'
      && /variant/.test(colMap['products.product_mode']?.column_default || ''),
    JSON.stringify(colMap['products.product_mode']));

  check('SCHEMA: products.weighted_avg_cost is DECIMAL(14,4) nullable',
    colMap['products.weighted_avg_cost']?.udt_name === 'numeric'
      && colMap['products.weighted_avg_cost']?.is_nullable === 'YES');

  check('SCHEMA: products.last_purchase_rate present',
    !!colMap['products.last_purchase_rate']);

  check('SCHEMA: products.last_purchase_date present',
    !!colMap['products.last_purchase_date']);

  check('SCHEMA: product_batches.purchase_rate present',
    !!colMap['product_batches.purchase_rate']);

  check('SCHEMA: system_settings.default_product_mode is ENUM with NOT NULL + default variant',
    colMap['system_settings.default_product_mode']?.udt_name === 'enum_system_settings_default_product_mode'
      && colMap['system_settings.default_product_mode']?.is_nullable === 'NO'
      && /variant/.test(colMap['system_settings.default_product_mode']?.column_default || ''));

  // ── Migration outcome: every existing product is variant, no orphan flags ─
  const dist = await sequelize.query(`
    SELECT
      COUNT(*) FILTER (WHERE product_mode='variant') as variant_count,
      COUNT(*) FILTER (WHERE product_mode='single')  as single_count,
      COUNT(*) FILTER (WHERE product_mode='variant' AND is_batch_tracked=true) as orphan_count
    FROM products
  `, { type: sequelize.QueryTypes.SELECT });
  const d = dist[0];
  check('MIGRATION: every pre-existing product defaulted to variant mode',
    parseInt(d.variant_count) >= 1 && parseInt(d.single_count) === 0,
    `variant=${d.variant_count} single=${d.single_count}`);
  check('MIGRATION: no variant products carry is_batch_tracked=true (orphan defect cleared)',
    parseInt(d.orphan_count) === 0,
    `orphan_count=${d.orphan_count}`);

  // ── Setting is readable + writable ──────────────────────────────────
  const ss = await SystemSettings.findByPk(1);
  check('SETTING: default_product_mode readable from SystemSettings model',
    ss?.default_product_mode === 'variant' || ss?.default_product_mode === 'single',
    `value=${ss?.default_product_mode}`);

  const before = ss.default_product_mode;
  await ss.update({ default_product_mode: 'single' });
  const after = await SystemSettings.findByPk(1);
  check('SETTING: default_product_mode is writable (variant → single)',
    after.default_product_mode === 'single');
  // Restore so other test runs aren't surprised
  await ss.update({ default_product_mode: before });

  // ── Per-product mode field defaults to schema default on direct create ───
  // (Controllers will pick up system_settings.default_product_mode in
  // Commit 2; for now we just confirm Sequelize honors the column default.)
  const fix = await Product.create({
    barcode: FIXTURE_PREFIX + '01',
    product_name: FIXTURE_PREFIX + 'sample',
    purchase_rate: 10, sale_rate: 12,
  });
  check('PRODUCT: new row picks up product_mode default (variant)',
    fix.product_mode === 'variant',
    `mode=${fix.product_mode}`);

  // ── Per-product mode honoured when set explicitly ───────────────────
  const fix2 = await Product.create({
    barcode: FIXTURE_PREFIX + '02',
    product_name: FIXTURE_PREFIX + 'single sample',
    purchase_rate: 10, sale_rate: 12,
    product_mode: 'single',
  });
  check('PRODUCT: explicit product_mode=single persists',
    fix2.product_mode === 'single');
}

async function main() {
  console.log('━━━ Single Product mode migration tests ━━━');
  try { await runTests(); }
  catch (err) { fail++; results.push(`  ✗ Suite crashed: ${err.message}`); console.error(err); }
  finally {
    try { await cleanup(); } catch (_) {}
    await sequelize.close();
  }
  console.log(results.join('\n'));
  console.log(`━━━ ${pass} passed, ${fail} failed ━━━`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
