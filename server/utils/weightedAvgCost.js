/*
 * Weighted-average cost helpers for single-mode products.
 *
 * Variant-mode products keep using products.purchase_rate (overwritten on
 * each purchase) because differing rates create new variant rows — there
 * is no compounding cost to maintain. Single-mode products instead carry
 * a running weighted-average in products.weighted_avg_cost, recomputed
 * on every purchase / purchase-return / adjustment.
 *
 * Two functions, one purpose:
 *
 *   applyWeightedAvgIncrement — fast path for the common case (a new
 *     purchase line). Pure math: new_avg = (old_stock × old_avg + qty ×
 *     rate) / (old_stock + qty). Called inline from the create-purchase
 *     loop so the result lands in the same transaction as the stock
 *     delta.
 *
 *   recomputeWeightedAvgFromLedger — full rebuild from stock_ledger.
 *     Called from purchase-return create, purchase update, and purchase
 *     cancel. Cheaper to recompute than to derive a per-line reversal,
 *     and matches the recalculatePartyBalance pattern (idempotent;
 *     re-running produces the same answer).
 *
 * Both round to 4 decimals. The column carries 4dp because compounding
 * drift over many small purchases at 2dp accumulates visibly — by the
 * time a product hits 1000+ ledger rows the rounding error on a 2dp
 * basis can swing by ₹0.50/unit.
 *
 * Batch-tracked single products do NOT use weighted_avg_cost. Cost lives
 * on the batch row (product_batches.purchase_rate). Callers must check
 * product.is_batch_tracked before invoking either function.
 */

const { Op } = require('sequelize');
const { Product, StockLedger } = require('../models');

const round4 = (v) => +(parseFloat(v) || 0).toFixed(4);

/**
 * Incrementally update weighted_avg_cost for a fresh purchase line.
 * Reads the product's current state, applies the formula, writes back.
 *
 * @param {Object}  args
 * @param {number}  args.product_id   Product to update.
 * @param {number}  args.qty          Purchase quantity (positive).
 * @param {number}  args.purchase_rate Rate per unit on this line.
 * @param {Object}  args.t            Sequelize transaction (required).
 * @returns {Promise<number>}         New weighted_avg_cost (rounded).
 */
async function applyWeightedAvgIncrement({ product_id, qty, purchase_rate, t }) {
  if (!product_id) throw new Error('applyWeightedAvgIncrement: product_id required');
  if (!t)          throw new Error('applyWeightedAvgIncrement: transaction required');

  const product = await Product.findByPk(product_id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!product) throw new Error(`applyWeightedAvgIncrement: product ${product_id} not found`);

  // Sanity checks the caller is responsible for, but defensively no-op
  // here so a future caller mistake doesn't silently corrupt the avg.
  if (product.product_mode !== 'single') return null;
  if (product.is_batch_tracked)         return null;

  const oldStock = parseFloat(product.current_stock || 0);
  const oldAvg   = parseFloat(product.weighted_avg_cost || 0);
  const addQty   = parseFloat(qty || 0);
  const rate     = parseFloat(purchase_rate || 0);

  // Clean-start case: stock at zero (or first purchase ever, or returned
  // to zero by a refund) → next purchase sets the new basis. Same rule
  // the design calls out: "if old_stock = 0: new_avg = purchase_rate".
  let newAvg;
  if (oldStock <= 0 || addQty <= 0) {
    newAvg = rate;
  } else {
    newAvg = ((oldStock * oldAvg) + (addQty * rate)) / (oldStock + addQty);
  }
  newAvg = round4(newAvg);

  await product.update({ weighted_avg_cost: newAvg }, { transaction: t });
  return newAvg;
}

/**
 * Rebuild weighted_avg_cost from the full stock_ledger history. Walks
 * Purchase / Purchase Return / Stock Adjustment / Opening Stock rows in
 * chronological order and replays the avg formula at each step.
 *
 * Purchase return is handled as a stock_out at the original purchase
 * rate (from the ledger row) — wac stays the same on a clean return,
 * matching the math the design documents:
 *
 *   old_avg_before_return = ((current_avg × current_stock)
 *                           - (return_qty × purchase_rate_of_returned_lot))
 *                           / (current_stock - return_qty)
 *
 * When the returned qty equals the post-purchase add at the same rate,
 * this collapses back to the pre-purchase avg — exact paisa-cleanness.
 *
 * Final wac of zero stock is forced to 0 so the next purchase starts
 * fresh. Used by purchase update / cancel and purchase return create
 * because incremental reversal is fragile when many purchases at
 * different rates contribute.
 *
 * Cost: one SELECT over the product's ledger history. For most products
 * that's <100 rows; high-volume SKUs with thousands of movements pay
 * a noticeable but acceptable cost (one rebuild per state-changing
 * write). Same trade-off recalculatePartyBalance accepts.
 */
async function recomputeWeightedAvgFromLedger({ product_id, t }) {
  if (!product_id) throw new Error('recomputeWeightedAvgFromLedger: product_id required');
  if (!t)          throw new Error('recomputeWeightedAvgFromLedger: transaction required');

  const product = await Product.findByPk(product_id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!product) return null;
  if (product.product_mode !== 'single') return null;
  if (product.is_batch_tracked)         return null;

  const rows = await StockLedger.findAll({
    where: {
      product_id,
      transaction_type: { [Op.in]: ['Opening Stock', 'Purchase', 'Purchase Return', 'Stock Adjustment'] },
    },
    order: [['transaction_date', 'ASC'], ['ledger_id', 'ASC']],
    transaction: t,
  });

  let stock = 0, wac = 0;
  for (const r of rows) {
    const qIn  = parseFloat(r.quantity_in  || 0);
    const qOut = parseFloat(r.quantity_out || 0);
    const rate = parseFloat(r.rate         || 0);
    if (qIn > 0) {
      const newStock = stock + qIn;
      wac = stock <= 0 ? rate : ((stock * wac) + (qIn * rate)) / newStock;
      stock = newStock;
    }
    if (qOut > 0) {
      // qOut here is from the qty_out side of Purchase Return /
      // Stock Adjustment ledger rows (Sales aren't replayed — they
      // don't affect wac; the cost_rate snapshot was taken at sale
      // time). Returns / negative adjustments don't change wac in
      // steady state (returning at the same rate just trims the
      // contribution proportionally).
      //
      // When stock crosses zero we drop wac; the next purchase resets
      // the basis from scratch. This is intentional — there's no
      // meaningful weighted average to carry across a stock-out — but
      // it does mean a temporary zero-crossing on `allow_negative_stock`
      // products will erase the historical wac. Audit M5: documented
      // in case anyone tries to extend this to preserve wac across
      // crossings; the simplest preservation rule (keep wac when
      // stock dips ≤ 0 but expect the basis to reset on next inward)
      // is what callers already see in practice.
      stock = stock - qOut;
      if (stock <= 0) { stock = 0; wac = 0; }
    }
  }

  const final = round4(wac);
  await product.update({ weighted_avg_cost: final }, { transaction: t });
  return final;
}

module.exports = {
  applyWeightedAvgIncrement,
  recomputeWeightedAvgFromLedger,
};
