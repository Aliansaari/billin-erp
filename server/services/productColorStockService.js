// ── ProductColor Stock Service ──────────────────────────────────
//
// Per-color stock arithmetic for the multi-color stock module. Mirrors
// the godown / batch helpers (applyGodownStockDelta, applyBatchStockDelta)
// — sales/purchase controllers call validateBillColorRequirements before
// touching the DB to fail-fast on bad input, then applyColorStockDelta
// per line during the create/cancel transaction.
//
// All functions accept a Sequelize transaction so the caller can roll
// back the entire bill atomically if any line fails.

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Product, ProductColor } = require('../models');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Validate the color section of a bill BEFORE any writes:
//   • For every line whose product is multi-color, color_id must be
//     present and must reference an active color belonging to that
//     product.
//   • Colors must have enough stock for sales lines (or
//     allowNegativeStock must be true).
//   • For purchase lines, validates the color exists but doesn't
//     require stock (purchase increments).
//
// Returns { ok: true } or throws with a 400-shaped error.
async function validateBillColorRequirements({
  items,           // array of bill-item-shaped objects
  direction,       // 'sale' | 'purchase' — controls stock-deplete check
  allowNegativeStock = false,
  transaction,
}) {
  if (!Array.isArray(items) || items.length === 0) return { ok: true };

  // Pull the products + colors involved in one batched query each, so
  // even a 50-line bill doesn't fan out N round-trips.
  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
  if (productIds.length === 0) return { ok: true };

  const products = await Product.findAll({
    where: { product_id: { [Op.in]: productIds } },
    attributes: ['product_id', 'product_name', 'color_mode'],
    transaction,
  });
  const productById = new Map(products.map((p) => [p.product_id, p]));

  const colorIds = [...new Set(items.map((i) => i.color_id).filter(Boolean))];
  let colorById = new Map();
  if (colorIds.length > 0) {
    const colors = await ProductColor.findAll({
      where: { color_id: { [Op.in]: colorIds } },
      transaction,
    });
    colorById = new Map(colors.map((c) => [c.color_id, c]));
  }

  // Aggregate desired qty per color so multi-line bills (e.g. several
  // lines of Red Lyra-S at different rates) can collectively bust the
  // stock cap before we apply any delta.
  const desired = new Map(); // color_id → total qty across the bill
  for (const it of items) {
    const product = productById.get(it.product_id);
    if (!product) continue;
    const isMulti = product.color_mode === 'multi';

    if (isMulti) {
      if (!it.color_id) {
        const err = new Error(
          `Product "${product.product_name}" needs a color picked. Multi-color products require a color on every line.`,
        );
        err.status = 400;
        throw err;
      }
      const color = colorById.get(it.color_id);
      if (!color || color.product_id !== product.product_id) {
        const err = new Error(
          `Selected color does not belong to product "${product.product_name}".`,
        );
        err.status = 400;
        throw err;
      }
      if (color.is_active === false) {
        const err = new Error(`Color "${color.color_name}" is inactive — pick a different one.`);
        err.status = 400;
        throw err;
      }
      desired.set(it.color_id, (desired.get(it.color_id) || 0) + r2(it.quantity));
    } else if (it.color_id) {
      // Lines for non-multi-color products must NOT carry color_id —
      // strip it at the controller before save. We surface this loud
      // because a stale color_id from a UI bug would create incorrect
      // per-color stock movements.
      const err = new Error(
        `Product "${product.product_name}" is not multi-color tracked but a color was sent. Refresh and retry.`,
      );
      err.status = 400;
      throw err;
    }
  }

  // Stock-deplete check (sales only). Sum the bill's per-color desire,
  // compare against current_stock + allowNegativeStock.
  if (direction === 'sale' && !allowNegativeStock) {
    for (const [colorId, qty] of desired.entries()) {
      const color = colorById.get(colorId);
      if (!color) continue;
      const have = r2(color.current_stock);
      if (qty > have + 0.005) {
        const err = new Error(
          `Insufficient stock for "${color.color_name}". Available: ${have}, Requested: ${qty}. Enable "Allow Negative Stock" in Module Settings to proceed.`,
        );
        err.status = 400;
        throw err;
      }
    }
  }

  return { ok: true };
}

// Apply a per-color stock delta inside a transaction.
//   delta > 0  →  receive (purchase, sale-cancel)
//   delta < 0  →  ship    (sale, purchase-cancel)
//
// Uses an UPDATE ... RETURNING via raw SQL for an atomic increment-
// without-read; the model-level update would race two concurrent
// sales of the last item.
async function applyColorStockDelta({ color_id, delta, transaction }) {
  if (!color_id || !Number.isFinite(delta) || delta === 0) return;
  await sequelize.query(
    `UPDATE product_colors
        SET current_stock = COALESCE(current_stock, 0) + :delta,
            modified_date = NOW()
      WHERE color_id = :color_id`,
    {
      replacements: { delta: r2(delta), color_id },
      transaction,
    },
  );
}

// Reverse the per-color stock movements of a saved bill. Used by the
// cancel paths (sales-cancel adds the qty back, purchase-cancel
// subtracts) and the update path (reverse old, then re-apply new).
async function reverseBillColorStock({ items, direction, transaction }) {
  if (!Array.isArray(items)) return;
  // direction = 'sale': sale subtracted color stock; reverse = ADD back
  // direction = 'purchase': purchase added color stock; reverse = SUBTRACT
  const sign = direction === 'sale' ? +1 : -1;
  for (const it of items) {
    if (!it.color_id) continue;
    const qty = r2(it.quantity);
    if (qty === 0) continue;
    await applyColorStockDelta({
      color_id: it.color_id,
      delta: sign * qty,
      transaction,
    });
  }
}

module.exports = {
  validateBillColorRequirements,
  applyColorStockDelta,
  reverseBillColorStock,
};
