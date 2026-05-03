/*
 * displayCost — per-mode "display" cost + stock value for product rows.
 *
 * Frontend tiles, summary aggregates, and report columns read display_cost
 * / display_stock_value instead of raw products.purchase_rate so the number
 * shown reflects the right basis for each product's mode:
 *
 *   • variant            → display_cost = purchase_rate
 *                          display_stock_value = current_stock × purchase_rate
 *   • single, no batch   → display_cost = weighted_avg_cost   (wac)
 *                          display_stock_value = current_stock × wac
 *   • single + batch     → display_cost = SUM(batch.qty × batch.rate) / SUM(batch.qty)
 *                          display_stock_value = SUM(batch.qty × batch.rate)
 *                          (cost lives on product_batches.purchase_rate, NOT
 *                           on the product master — wac stays NULL)
 *
 * Scope:
 *   This helper is for DISPLAY + AGGREGATE COMPUTATION reads only — what
 *   the user sees on a tile, in a column, in a summary block. The cost
 *   snapshot stamped onto sales_bill_items.cost_rate at sale time uses
 *   different per-mode logic and lives in a separate sales-side helper
 *   (introduced in commit 3d). Stock Movement transaction TABLE rows are
 *   NOT touched by this helper either — they keep their own per-row
 *   stock_ledger.rate from the original transaction.
 *
 *   This helper computes CURRENT/LIVE cost only. As-of-date historical
 *   cost (for Balance Sheet / P&L stockValueAt) requires a different
 *   helper that respects the as_of cutoff against batch + ledger history;
 *   that's commit 3b.
 *
 * Input shape:
 *   attachDisplayCost expects an array of plain JS objects with the
 *   product columns it reads (product_id, product_mode, is_batch_tracked,
 *   current_stock, purchase_rate, weighted_avg_cost). Sequelize instances
 *   must be converted by the caller via .toJSON() first — the helper does
 *   not call toJSON itself, by design (lets the caller decide what to
 *   include / exclude in the include() pass).
 *
 *   Empty / null input is handled gracefully: empty array returns empty
 *   array, no DB round-trip.
 *
 *   Mixed-mode arrays are fine — each row branches on its own
 *   product_mode independently. The single+batch SQL aggregate is keyed
 *   only on the product_ids that need it, so a page of mostly variant
 *   products doesn't pay any batch-SQL cost.
 *
 * Output shape:
 *   attachDisplayCost is non-mutating — returns new objects (spread of
 *   the input plus display_cost + display_stock_value). The original
 *   array elements are unchanged. Match this if you replace the impl.
 */

const sequelize = require('../config/database');

const round4 = (v) => +(parseFloat(v) || 0).toFixed(4);
const round2 = (v) => +(parseFloat(v) || 0).toFixed(2);

/**
 * Bulk-fetch batch aggregates (SUM qty × rate, SUM qty) for the given
 * single+batch product_ids. Returns a Map keyed by product_id so the
 * row-mapper can look up per-product totals in O(1). Filters to active
 * batches with positive stock — out-of-stock batches don't contribute
 * to the live weighted-average. NULL purchase_rate on a batch falls to
 * 0 via COALESCE (a batch carrying no rate has nothing to contribute,
 * stays out of the average).
 *
 * Internal — exported only via the two public functions below.
 */
async function fetchBatchAggregate(productIds) {
  if (!productIds || productIds.length === 0) return new Map();
  const aggRows = await sequelize.query(
    `SELECT pbs.product_id,
            SUM(pbs.current_stock * COALESCE(pb.purchase_rate, 0)) AS total_value,
            SUM(pbs.current_stock)                                 AS total_qty
       FROM product_batch_stock pbs
       JOIN product_batches pb ON pb.batch_id = pbs.batch_id
      WHERE pbs.product_id IN (:ids)
        AND pbs.current_stock > 0
        AND pb.is_active = true
      GROUP BY pbs.product_id`,
    { replacements: { ids: productIds }, type: sequelize.QueryTypes.SELECT },
  );
  return new Map(aggRows.map(r => [
    r.product_id,
    { total_value: parseFloat(r.total_value || 0), total_qty: parseFloat(r.total_qty || 0) },
  ]));
}

/**
 * Compute display_cost for one product (no display_stock_value, no array).
 * Used by single-product callers (e.g., a controller that already has the
 * product handle and just needs the right cost number). Variant + single-
 * no-batch are pure JS; single+batch needs the batch aggregate which the
 * caller can pre-fetch and pass in via batchAgg.
 *
 * @param {Object} product   Plain product row (product_mode, is_batch_tracked,
 *                           purchase_rate, weighted_avg_cost). Must have toJSON
 *                           applied if it came from Sequelize.
 * @param {Object|null} batchAgg  Optional { total_value, total_qty } for this
 *                                product. If absent for a single+batch product
 *                                the function returns 0 — same fallback
 *                                attachDisplayCost uses when no batch row
 *                                matches. Callers that need the real number
 *                                should pre-fetch via fetchBatchAggregate or
 *                                use attachDisplayCost on a one-element array.
 * @returns {number}         The cost (rate per unit), rounded to 4 decimals.
 */
function computeDisplayCost(product, batchAgg = null) {
  if (!product) return 0;
  if (product.product_mode === 'single' && product.is_batch_tracked) {
    const tv = batchAgg ? batchAgg.total_value : 0;
    const tq = batchAgg ? batchAgg.total_qty   : 0;
    return tq > 0 ? round4(tv / tq) : 0;
  }
  if (product.product_mode === 'single') {
    return parseFloat(product.weighted_avg_cost || 0);
  }
  return parseFloat(product.purchase_rate || 0);
}

/**
 * Attach display_cost + display_stock_value to every row in the input
 * array. Returns a new array of new objects (non-mutating). Issues at
 * most ONE SQL aggregate query — only when at least one row is single+
 * batch.
 *
 * @param {Array<Object>} rows  Plain product rows (post-toJSON).
 * @returns {Promise<Array<Object>>}
 */
async function attachDisplayCost(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const batchTrackedIds = rows
    .filter(r => r.product_mode === 'single' && r.is_batch_tracked)
    .map(r => r.product_id);
  const batchAgg = await fetchBatchAggregate(batchTrackedIds);

  return rows.map(r => {
    const stock = parseFloat(r.current_stock || 0);
    let display_cost, display_stock_value;
    if (r.product_mode === 'single' && r.is_batch_tracked) {
      const agg = batchAgg.get(r.product_id);
      const tv = agg ? agg.total_value : 0;
      const tq = agg ? agg.total_qty   : 0;
      display_cost = tq > 0 ? round4(tv / tq) : 0;
      display_stock_value = round2(tv);
    } else if (r.product_mode === 'single') {
      const wac = parseFloat(r.weighted_avg_cost || 0);
      display_cost = wac;
      display_stock_value = round2(stock * wac);
    } else {
      const pr = parseFloat(r.purchase_rate || 0);
      display_cost = pr;
      display_stock_value = round2(stock * pr);
    }
    return { ...r, display_cost, display_stock_value };
  });
}

module.exports = {
  attachDisplayCost,
  computeDisplayCost,
};
