/*
 * costLayers — FIFO cost-layer maintenance (audit H6).
 *
 * Backstory: the legacy "FIFO" claim in the docs was actually weighted-
 * average for single-mode products, per-batch frozen rate for batch-tracked,
 * and overwrite-on-purchase (latest-landed) for variant. This module
 * introduces honest FIFO when SystemSettings.cogs_method='fifo'.
 *
 * Mental model:
 *   - Each purchase creates ONE cost_layers row per line: { qty, rate,
 *     acquired_at }.
 *   - Each sale (in fifo mode) consumes from the oldest non-empty layer(s)
 *     and snapshots the weighted-average rate of the consumed layers as the
 *     sale line's cost_rate. The snapshot persists on sales_bill_items so
 *     historic P&L stays stable even after the layers are gone.
 *   - Weighted-average mode (default) doesn't consume — we just keep
 *     inserting purchase layers as cheap insurance for a future switch.
 *
 * MVP v1 limitations (documented):
 *   - Cancel / edit reversal: best-effort restore to the most recent
 *     consumed layer. Multi-edit-then-cancel can produce small cost
 *     drift; the v1 advice is "in FIFO mode, prefer creating a Sales
 *     Return over editing a closed bill". A v2 pass can track per-sale
 *     layer-consumption rows for exact reversal.
 *   - Stock transfer between godowns: layers stay at the source godown
 *     (no cross-godown layer move yet). Reports per-godown still work
 *     because consumption follows godown_id; the destination godown's
 *     consumption falls back to weighted-average until a new purchase
 *     creates a layer there.
 *   - Backfill on existing installs: a single synthetic "Backfill" layer
 *     per (product, godown) at current weighted_avg_cost, sized to
 *     current_stock. New purchases write real layers from there on.
 *
 * All public functions are async + transaction-aware.
 */

'use strict';

const sequelize = require('../config/database');
const { CostLayer, Product, ProductGodownStock, SaleLineLayerConsumption } = require('../models');

/**
 * Insert a new FIFO cost layer.
 *
 * Called by:
 *   - purchase create        (one per line)
 *   - opening stock entry    (synthetic Opening)
 *   - positive stock adjust  (synthetic Adjustment)
 *
 * No-op when qty <= 0. Negative quantities should call consumeFIFO
 * instead (a negative stock adjustment is a consumption event).
 */
async function addCostLayer({ product_id, godown_id, qty, rate, source_type, source_id, acquired_at, t }) {
  if (!product_id || !godown_id) throw new Error('addCostLayer: product_id + godown_id required');
  if (!t) throw new Error('addCostLayer: transaction required');
  const q = +parseFloat(qty || 0);
  if (!Number.isFinite(q) || q <= 0) return null;
  const r = +parseFloat(rate || 0);
  return await CostLayer.create({
    product_id,
    godown_id,
    qty_original: q,
    qty_remaining: q,
    rate: Number.isFinite(r) && r >= 0 ? r : 0,
    acquired_at: acquired_at || new Date(),
    source_type: source_type || 'Purchase',
    source_id: source_id || null,
  }, { transaction: t });
}

/**
 * Consume `qty` units from the FIFO queue at (product_id, godown_id).
 * Returns { consumedRate, consumedRows } where consumedRate is the
 * weighted-average rate of the consumed layers (this is what callers
 * should snapshot as the sale line's cost_rate).
 *
 * If layers run dry before `qty` is satisfied (negative-stock allowed
 * by setting, or a backfill miss), the shortfall is "uncovered" — we
 * fall back to product.weighted_avg_cost (or purchase_rate) for the
 * shortfall portion and proceed. The caller still gets a single
 * consumedRate; we surface `shortfall` for diagnostics.
 *
 * Idempotent semantics: each call mutates layers. To reverse, call
 * `restoreConsumption` with the same (product_id, godown_id, qty)
 * — best-effort; see module header for v1 limitations.
 */
async function consumeFIFO({ product_id, godown_id, qty, t }) {
  if (!product_id || !godown_id) throw new Error('consumeFIFO: product_id + godown_id required');
  if (!t) throw new Error('consumeFIFO: transaction required');
  const q = +parseFloat(qty || 0);
  if (!Number.isFinite(q) || q <= 0) return { consumedRate: 0, shortfall: 0, consumedRows: [] };

  // Lock and load oldest-first available layers. FOR UPDATE so concurrent
  // sales on the same product serialise.
  const layers = await sequelize.query(
    `SELECT * FROM cost_layers
      WHERE product_id = :pid AND godown_id = :gid AND qty_remaining > 0
      ORDER BY acquired_at ASC, layer_id ASC
      FOR UPDATE`,
    {
      replacements: { pid: product_id, gid: godown_id },
      type: sequelize.QueryTypes.SELECT,
      transaction: t,
    },
  );

  let remaining = q;
  let weightedSum = 0;          // Σ (consumed_qty × layer_rate)
  let consumedQty = 0;
  const consumedRows = [];
  for (const layer of layers) {
    if (remaining <= 0) break;
    const avail = +parseFloat(layer.qty_remaining);
    const take = Math.min(avail, remaining);
    if (take <= 0) continue;
    const newRem = +(avail - take).toFixed(3);
    await sequelize.query(
      `UPDATE cost_layers SET qty_remaining = :rem, updated_at = NOW() WHERE layer_id = :lid`,
      { replacements: { rem: newRem, lid: layer.layer_id }, transaction: t },
    );
    weightedSum += take * +parseFloat(layer.rate);
    consumedQty += take;
    consumedRows.push({ layer_id: layer.layer_id, qty: take, rate: +parseFloat(layer.rate) });
    remaining = +(remaining - take).toFixed(3);
  }

  let shortfall = 0;
  if (remaining > 0.0001) {
    // Layers exhausted — fall back to weighted_avg_cost for the shortfall.
    // Allows the sale to proceed when allow_negative_stock is true OR when
    // a freshly-backfilled product has stock at a godown without layers.
    const product = await Product.findByPk(product_id, { transaction: t });
    const fallback = +(parseFloat(product?.weighted_avg_cost) || parseFloat(product?.purchase_rate) || 0);
    weightedSum += remaining * fallback;
    consumedQty += remaining;
    shortfall = remaining;
  }

  const consumedRate = consumedQty > 0 ? +(weightedSum / consumedQty).toFixed(4) : 0;
  return { consumedRate, shortfall, consumedRows };
}

/**
 * Record an exact per-layer consumption trail for a sale line. Call
 * this AFTER consumeFIFO has run and the sales_bill_item row exists;
 * pass consumeFIFO's `consumedRows` plus the new sales_bill_item_id.
 *
 * Audit H6 v2 — exact reversal. With these rows in place, restoreConsumptionByItemId
 * can put EXACTLY the right qty back into EXACTLY the right layer on
 * cancel/edit, instead of the v1 heuristic that touched the most-recent
 * layer.
 */
async function recordSaleConsumption({ sales_bill_item_id, consumedRows, t }) {
  if (!sales_bill_item_id) throw new Error('recordSaleConsumption: sales_bill_item_id required');
  if (!t) throw new Error('recordSaleConsumption: transaction required');
  if (!Array.isArray(consumedRows) || consumedRows.length === 0) return;
  for (const row of consumedRows) {
    if (!row.layer_id) continue; // shortfall fallbacks have no layer to record against
    await SaleLineLayerConsumption.create({
      sales_bill_item_id,
      layer_id: row.layer_id,
      qty_consumed: row.qty,
      rate_at_consumption: row.rate,
    }, { transaction: t });
  }
}

/**
 * Exact reversal — for each consumption row, add the qty back to the
 * exact layer that was consumed, then DELETE the consumption row.
 * Audit H6 v2 supersedes the v1 best-effort restoreConsumption().
 *
 * Caller must pass either sales_bill_item_id (single line) OR
 * sales_bill_id (whole bill, the common case for cancel/edit).
 */
async function reverseConsumptionForBill({ sales_bill_id, t }) {
  if (!sales_bill_id) throw new Error('reverseConsumptionForBill: sales_bill_id required');
  if (!t) throw new Error('reverseConsumptionForBill: transaction required');

  // Pull every consumption row tied to ANY line on this bill, with the
  // layer FK in the same shot so we can write back without a second
  // round-trip per row.
  const rows = await sequelize.query(
    `SELECT slc.consumption_id, slc.sales_bill_item_id, slc.layer_id, slc.qty_consumed
       FROM sale_line_layer_consumptions slc
       JOIN sales_bill_items sbi ON sbi.item_id = slc.sales_bill_item_id
      WHERE sbi.sales_bill_id = :bid
      FOR UPDATE OF slc`,
    {
      replacements: { bid: sales_bill_id },
      type: sequelize.QueryTypes.SELECT,
      transaction: t,
    },
  );
  if (rows.length === 0) return { reversed: 0 };

  for (const row of rows) {
    // Add qty back, but cap at qty_original so we don't overshoot.
    await sequelize.query(
      `UPDATE cost_layers
          SET qty_remaining = LEAST(qty_original, qty_remaining + :q),
              updated_at = NOW()
        WHERE layer_id = :lid`,
      {
        replacements: { q: row.qty_consumed, lid: row.layer_id },
        transaction: t,
      },
    );
  }

  // Delete the consumption rows so a future "reverse again" is a no-op.
  // (Edit path: cancels old consumptions, re-consumes with new qtys,
  // re-records new consumption rows. Cancel path: same but no re-consume.)
  await sequelize.query(
    `DELETE FROM sale_line_layer_consumptions
       WHERE sales_bill_item_id IN (
         SELECT item_id FROM sales_bill_items WHERE sales_bill_id = :bid
       )`,
    { replacements: { bid: sales_bill_id }, transaction: t },
  );

  return { reversed: rows.length };
}

/**
 * v1 best-effort fallback — kept for paths that DON'T have a
 * sales_bill_item_id (legacy callers, stock adjustments, transfer
 * sources without a SLC link). Prefer reverseConsumptionForBill in
 * sales paths.
 *
 * Finds the MOST RECENT layer at (product_id, godown_id) and adds the
 * qty back to its qty_remaining — bounded by qty_original so we don't
 * overshoot. If no layer exists, we synth a new layer.
 */
async function restoreConsumption({ product_id, godown_id, qty, t }) {
  if (!product_id || !godown_id) throw new Error('restoreConsumption: product_id + godown_id required');
  if (!t) throw new Error('restoreConsumption: transaction required');
  const q = +parseFloat(qty || 0);
  if (!Number.isFinite(q) || q <= 0) return;

  // Most recent layer (could be empty or partially full).
  const [latest] = await sequelize.query(
    `SELECT * FROM cost_layers
      WHERE product_id = :pid AND godown_id = :gid
      ORDER BY acquired_at DESC, layer_id DESC
      LIMIT 1
      FOR UPDATE`,
    {
      replacements: { pid: product_id, gid: godown_id },
      type: sequelize.QueryTypes.SELECT,
      transaction: t,
    },
  );

  if (latest) {
    const max = +parseFloat(latest.qty_original);
    const current = +parseFloat(latest.qty_remaining);
    const restored = Math.min(max, current + q);
    await sequelize.query(
      `UPDATE cost_layers SET qty_remaining = :rem, updated_at = NOW() WHERE layer_id = :lid`,
      { replacements: { rem: restored.toFixed(3), lid: latest.layer_id }, transaction: t },
    );
    const stillOwed = +(q - (restored - current)).toFixed(3);
    if (stillOwed > 0.0001) {
      // Layer was full; create a synthetic restore layer at the same rate.
      await CostLayer.create({
        product_id,
        godown_id,
        qty_original: stillOwed,
        qty_remaining: stillOwed,
        rate: latest.rate,
        acquired_at: new Date(),
        source_type: 'Adjustment',
        source_id: null,
      }, { transaction: t });
    }
  } else {
    // No layers at all — synth one at the product's avg/purchase rate.
    const product = await Product.findByPk(product_id, { transaction: t });
    const rate = +(parseFloat(product?.weighted_avg_cost) || parseFloat(product?.purchase_rate) || 0);
    await CostLayer.create({
      product_id,
      godown_id,
      qty_original: q,
      qty_remaining: q,
      rate,
      acquired_at: new Date(),
      source_type: 'Adjustment',
      source_id: null,
    }, { transaction: t });
  }
}

/**
 * Effective costing method, with per-product override precedence:
 *
 *   product.costing_method = 'fifo'           → 'fifo'   (override beats company)
 *   product.costing_method = 'weighted_avg'   → 'weighted_avg'
 *   product.costing_method = 'inherit'        → company-wide setting
 *   product_id not provided                   → company-wide setting
 *
 * The company-wide setting (SystemSettings.cogs_method) is cached in
 * memory for 30 s; refreshCogsCache() busts the cache after a settings
 * update so the next sale picks up the new value immediately.
 *
 * Per-product lookups are NOT cached — they're cheap (single SELECT on
 * an indexed PK) and cache invalidation on every product edit would
 * be more code than it's worth.
 */
let _cogsModeCache = null;
let _cogsModeFetchedAt = 0;
const COGS_CACHE_TTL_MS = 30 * 1000;

async function _getCompanyCogsMethod(t) {
  const now = Date.now();
  if (_cogsModeCache !== null && (now - _cogsModeFetchedAt) < COGS_CACHE_TTL_MS) {
    return _cogsModeCache;
  }
  const { SystemSettings } = require('../models');
  const s = await SystemSettings.findByPk(1, { transaction: t });
  _cogsModeCache = s?.cogs_method || 'weighted_avg';
  _cogsModeFetchedAt = now;
  return _cogsModeCache;
}

/**
 * Resolve the effective costing method for a given product (or the
 * company-wide default when no product is passed). Returns
 * 'weighted_avg' or 'fifo'.
 */
async function getEffectiveCogsMethod({ product_id, t } = {}) {
  if (product_id) {
    const product = await Product.findByPk(product_id, { transaction: t });
    const pm = product?.costing_method;
    if (pm === 'fifo' || pm === 'weighted_avg') return pm;
    // pm == 'inherit' or null/undefined → fall through to company default
  }
  return await _getCompanyCogsMethod(t);
}

/**
 * Convenience: true iff the EFFECTIVE costing method for the given
 * product (or company-wide if no product_id) is FIFO. Preferred over
 * raw getEffectiveCogsMethod when the caller only needs a boolean.
 */
async function isFifoMode(t, product_id) {
  return (await getEffectiveCogsMethod({ product_id, t })) === 'fifo';
}

function refreshCogsCache() {
  _cogsModeCache = null;
  _cogsModeFetchedAt = 0;
}

/**
 * Backfill — create one synthetic Backfill layer per (product, godown)
 * combination that has stock but no existing layers. Called at boot
 * (idempotent: skips combinations that already have any layer).
 *
 * Sizes the layer at current_stock units at the product's
 * weighted_avg_cost (fallback purchase_rate). After backfill, every
 * new purchase appends a real layer and FIFO consumption works
 * correctly for everything bought from that point forward; the
 * backfill layer covers the historic stock at its weighted-average
 * snapshot cost.
 */
async function backfillCostLayers(t = null) {
  const opts = t ? { transaction: t } : {};
  // For every PGS row with stock > 0 that has no layer yet, create one.
  const rows = await sequelize.query(
    `SELECT pgs.product_id, pgs.godown_id, pgs.current_stock,
            COALESCE(p.weighted_avg_cost, p.purchase_rate, 0) AS rate
       FROM product_godown_stock pgs
       JOIN products p ON p.product_id = pgs.product_id
      WHERE pgs.current_stock > 0
        AND NOT EXISTS (
          SELECT 1 FROM cost_layers cl
           WHERE cl.product_id = pgs.product_id AND cl.godown_id = pgs.godown_id
        )`,
    { type: sequelize.QueryTypes.SELECT, ...opts },
  );
  for (const r of rows) {
    await CostLayer.create({
      product_id: r.product_id,
      godown_id: r.godown_id,
      qty_original: r.current_stock,
      qty_remaining: r.current_stock,
      rate: +parseFloat(r.rate),
      acquired_at: new Date(0),    // epoch — so any new purchase sorts after it
      source_type: 'Backfill',
      source_id: null,
    }, opts);
  }
  return { backfilled: rows.length };
}

/**
 * Zero out qty_remaining for every cost layer that was created by a
 * specific purchase bill. Call this when a purchase bill is cancelled
 * or edited so the cancelled/old quantities can no longer be consumed
 * by future FIFO sales.
 *
 * We set qty_remaining = 0 rather than deleting so the audit trail
 * (qty_original, rate, acquired_at) is preserved for historic COGS
 * reports. Layers that were already partially consumed stay zeroed —
 * the consumed portion was already attributed to past sales and cannot
 * be unwound here (v1 limitation, same as restoreConsumption).
 */
async function cancelLayersForPurchase({ purchase_bill_id, t }) {
  if (!purchase_bill_id) throw new Error('cancelLayersForPurchase: purchase_bill_id required');
  if (!t) throw new Error('cancelLayersForPurchase: transaction required');
  await sequelize.query(
    `UPDATE cost_layers
        SET qty_remaining = 0, updated_at = NOW()
      WHERE source_type = 'Purchase' AND source_id = :bid AND qty_remaining > 0`,
    { replacements: { bid: purchase_bill_id }, transaction: t },
  );
}

module.exports = {
  addCostLayer,
  cancelLayersForPurchase,
  consumeFIFO,
  recordSaleConsumption,
  reverseConsumptionForBill,
  restoreConsumption,           // legacy best-effort fallback
  isFifoMode,
  getEffectiveCogsMethod,
  refreshCogsCache,
  backfillCostLayers,
};
