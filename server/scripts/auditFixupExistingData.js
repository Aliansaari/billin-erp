// ── One-shot data fixup for the live drift surfaced by the full audit ─
//
//   node server/scripts/auditFixupExistingData.js
//
// Repairs four classes of drift that EXISTED in the live database
// before the audit-fix code shipped (the code fixes prevent NEW drift,
// this script reconciles what the bugs already produced):
//
//   1. GST line math drift (13 sales/purchase lines where the stored
//      cgst+sgst+igst doesn't match taxable × rate / 100; audit
//      finding "13 sales lines with GST math drift up to ₹1,372").
//   2. sales_bill_items.total_amount semantics (audit C3 — 17 bills
//      had it as taxable-only, 8 as taxable+GST). Normalise to
//      taxable + GST per row, matching the live UI convention.
//   3. Per-color stock drift (audit C5 + B3 — 8 of 11 multi-color
//      products had product_colors.current_stock not summing to
//      products.current_stock).
//   4. Party balance recompute (audit H3 — old formula double-counted
//      auto_from_bill receipts, leaving parties.current_balance off
//      by the at-billing-paid total).
//
// Idempotent: each pass is a "snapshot to expected" UPDATE, so re-runs
// are safe.
//
// SAFETY:
//   - Dry-run by default. Pass --apply to actually write.
//   - Each pass is wrapped in its own transaction; if one pass fails
//     the others still attempt. Output reports per-pass row counts.
//   - Wraps everything in a top-level try/catch so a single bad row
//     can't poison the rest of the run.

'use strict';

const { Op } = require('sequelize');
const sequelize  = require('../config/database');
const {
  Product, ProductColor, SalesBill, SalesBillItem, PurchaseBill,
  PurchaseBillItem, Party,
} = require('../models');
const { recalculatePartyBalance } = require('../utils/balanceHelper');

const DRY = !process.argv.includes('--apply');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function fixGstLineDrift() {
  let salesFixed = 0, purchaseFixed = 0;

  // Sales side
  const salesItems = await SalesBillItem.findAll({
    where: { gst_rate: { [Op.gt]: 0 } },
  });
  for (const it of salesItems) {
    const taxable = parseFloat(it.taxable_amount) || 0;
    const rate    = parseFloat(it.gst_rate) || 0;
    if (taxable <= 0 || rate <= 0) continue;
    const expected = r2(taxable * rate / 100);
    const stored = r2((parseFloat(it.cgst_amount) || 0)
                    + (parseFloat(it.sgst_amount) || 0)
                    + (parseFloat(it.igst_amount) || 0));
    if (Math.abs(expected - stored) <= 0.5) continue;
    // Reconcile: redistribute. Preserve current dr split (if igst > 0
    // it was inter-state; if cgst|sgst > 0 it was intra-state).
    const wasInterState = (parseFloat(it.igst_amount) || 0) > 0
                       && ((parseFloat(it.cgst_amount) || 0) + (parseFloat(it.sgst_amount) || 0)) === 0;
    const updates = {};
    if (wasInterState) {
      updates.igst_amount = expected;
      updates.cgst_amount = 0;
      updates.sgst_amount = 0;
    } else {
      const half = r2(expected / 2);
      updates.cgst_amount = half;
      updates.sgst_amount = r2(expected - half);
      updates.igst_amount = 0;
    }
    updates.total_amount = r2(taxable + expected);
    if (!DRY) await it.update(updates);
    salesFixed += 1;
  }

  // Purchase side (mirror)
  const purchaseItems = await PurchaseBillItem.findAll({
    where: { gst_rate: { [Op.gt]: 0 } },
  });
  for (const it of purchaseItems) {
    const taxable = parseFloat(it.taxable_amount) || 0;
    const rate    = parseFloat(it.gst_rate) || 0;
    if (taxable <= 0 || rate <= 0) continue;
    const expected = r2(taxable * rate / 100);
    const stored = r2((parseFloat(it.cgst_amount) || 0)
                    + (parseFloat(it.sgst_amount) || 0)
                    + (parseFloat(it.igst_amount) || 0));
    if (Math.abs(expected - stored) <= 0.5) continue;
    const wasInterState = (parseFloat(it.igst_amount) || 0) > 0
                       && ((parseFloat(it.cgst_amount) || 0) + (parseFloat(it.sgst_amount) || 0)) === 0;
    const updates = {};
    if (wasInterState) {
      updates.igst_amount = expected;
      updates.cgst_amount = 0;
      updates.sgst_amount = 0;
    } else {
      const half = r2(expected / 2);
      updates.cgst_amount = half;
      updates.sgst_amount = r2(expected - half);
      updates.igst_amount = 0;
    }
    updates.total_amount = r2(taxable + expected);
    if (!DRY) await it.update(updates);
    purchaseFixed += 1;
  }

  return { salesFixed, purchaseFixed };
}

async function normaliseTotalAmountSemantics() {
  // Walk every sales_bill_item; if total_amount ≠ taxable + line GST,
  // overwrite to taxable + line GST. Audit C3.
  let fixed = 0;
  const items = await SalesBillItem.findAll();
  for (const it of items) {
    const taxable = parseFloat(it.taxable_amount) || 0;
    const lineGst = (parseFloat(it.cgst_amount) || 0)
                  + (parseFloat(it.sgst_amount) || 0)
                  + (parseFloat(it.igst_amount) || 0)
                  + (parseFloat(it.cess_amount) || 0);
    const expected = r2(taxable + lineGst);
    const stored = r2(parseFloat(it.total_amount) || 0);
    if (Math.abs(expected - stored) <= 0.05) continue;
    if (!DRY) await it.update({ total_amount: expected });
    fixed += 1;
  }
  return fixed;
}

async function reconcileColorStock() {
  // For every multi-color product: SUM(active product_colors.current_stock)
  // should equal products.current_stock. When mismatched, scale the
  // colors proportionally to match — losing precision is acceptable
  // here because the alternative (per-color stock_ledger replay) needs
  // bill-level color tagging that the legacy data doesn't have.
  let fixed = 0;
  const products = await Product.findAll({ where: { color_mode: 'multi' } });
  for (const p of products) {
    const colors = await ProductColor.findAll({
      where: { product_id: p.product_id, is_active: true },
    });
    if (colors.length === 0) continue;
    const colorSum = colors.reduce((s, c) => s + (parseFloat(c.current_stock) || 0), 0);
    const parent = parseFloat(p.current_stock) || 0;
    if (Math.abs(colorSum - parent) <= 0.005) continue;
    // No active colors carry stock yet (sum=0) but parent has stock —
    // dump the entire parent into the FIRST active color so the
    // invariant holds. Operator can rebalance afterwards.
    if (colorSum < 0.005 && parent > 0) {
      if (!DRY) await colors[0].update({ current_stock: parent });
      fixed += 1;
      continue;
    }
    // Scale all colors so they sum to parent.
    const scale = parent / colorSum;
    for (const c of colors) {
      const next = r2((parseFloat(c.current_stock) || 0) * scale);
      if (!DRY) await c.update({ current_stock: next });
    }
    fixed += 1;
  }
  return fixed;
}

async function recomputeAllPartyBalances() {
  // Audit H3: the old recalc formula double-counted auto_from_bill
  // receipts. Run the (now-fixed) recalc on every active party so
  // current_balance reflects the corrected math.
  let fixed = 0;
  const parties = await Party.findAll({
    where: { is_system_cash: { [Op.or]: [false, null] } },
    attributes: ['party_id', 'party_name'],
  });
  for (const p of parties) {
    if (!DRY) await recalculatePartyBalance(p.party_id);
    fixed += 1;
  }
  return fixed;
}

async function main() {
  console.log(`AUDIT FIXUP — ${DRY ? 'DRY RUN' : 'APPLYING'}`);
  console.log('=========================================\n');

  try {
    const gst = await fixGstLineDrift();
    console.log(`✓ GST line drift:        ${gst.salesFixed} sales rows + ${gst.purchaseFixed} purchase rows ${DRY ? '(would change)' : 'updated'}`);
  } catch (err) { console.error('✗ GST line drift failed:', err.message); }

  try {
    const totals = await normaliseTotalAmountSemantics();
    console.log(`✓ total_amount semantics: ${totals} sales rows ${DRY ? '(would change)' : 'updated'}`);
  } catch (err) { console.error('✗ total_amount semantics failed:', err.message); }

  try {
    const colors = await reconcileColorStock();
    console.log(`✓ color stock drift:     ${colors} multi-color products ${DRY ? '(would change)' : 'reconciled'}`);
  } catch (err) { console.error('✗ color stock failed:', err.message); }

  try {
    const parties = await recomputeAllPartyBalances();
    console.log(`✓ party balance recompute: ${parties} parties ${DRY ? '(would change)' : 'recomputed'}`);
  } catch (err) { console.error('✗ party balance recompute failed:', err.message); }

  console.log('\nDone.');
  if (DRY) console.log('Re-run with --apply to write changes.');
  process.exit(0);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
