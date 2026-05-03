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
 * As-of-date variant of fetchBatchAggregate. Derives each batch's qty
 * at asOfDate from stock_ledger (instead of reading live
 * product_batch_stock), then weights by batch.purchase_rate.
 *
 *   batch_qty_at_asof = SUM(quantity_in - quantity_out) for that batch
 *                       across stock_ledger rows with transaction_date
 *                       <= asOfDate
 *
 *   per-product totals = SUM(batch_qty_at_asof × batch.purchase_rate)
 *                        across batches with batch_qty_at_asof > 0
 *
 * Out-of-stock batches at asOfDate (qty <= 0) are dropped — they don't
 * contribute to the as-of stock value. Returns a Map keyed by
 * product_id with { total_value, total_qty }.
 *
 * Internal — exported via computeDisplayCostAsOf.
 */
async function fetchBatchAggregateAsOf(productIds, asOfDate) {
  if (!productIds || productIds.length === 0) return new Map();
  const aggRows = await sequelize.query(
    `WITH per_batch AS (
       SELECT sl.product_id,
              sl.batch_id,
              COALESCE(pb.purchase_rate, 0) AS rate,
              SUM(COALESCE(sl.quantity_in, 0) - COALESCE(sl.quantity_out, 0)) AS qty
         FROM stock_ledger sl
         JOIN product_batches pb ON pb.batch_id = sl.batch_id
        WHERE sl.product_id IN (:ids)
          AND sl.batch_id IS NOT NULL
          AND sl.transaction_date <= :as_of
        GROUP BY sl.product_id, sl.batch_id, pb.purchase_rate
     )
     SELECT product_id,
            SUM(qty * rate) AS total_value,
            SUM(qty)        AS total_qty
       FROM per_batch
      WHERE qty > 0
      GROUP BY product_id`,
    { replacements: { ids: productIds, as_of: asOfDate }, type: sequelize.QueryTypes.SELECT },
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
 * As-of-date variant of computeDisplayCost. Returns the cost basis for
 * a product at a historical date.
 *
 * Per-mode behaviour:
 *
 *   • variant            → product.purchase_rate
 *     Approximation: variant catalog rate is overwritten on every
 *     purchase (by design — different rates spawn new variants), so
 *     "current" == "as-of" for a row that still exists. Pre-fix
 *     stockValueAt already used the current value; this matches that
 *     behaviour bit-exactly. No regression.
 *
 *   • single, no batch   → product.weighted_avg_cost (with COALESCE
 *                          fallback to purchase_rate, then 0)
 *     APPROXIMATION (option B from the design): wac is the running
 *     average across the product's lifetime, NOT the avg as it stood
 *     at asOfDate. For closing stock (asOfDate ≈ today) this is
 *     exact. For historical reads it drifts by inventory turnover
 *     between asOfDate and today. Documented and accepted: a) books
 *     reconciliation cares most about CURRENT closing stock, b)
 *     variant mode already has the same approximation, c) walking
 *     the ledger per-query (option A) is expensive at scale, d)
 *     snapshot tables (option C) are over-engineering for this
 *     phase. A future commit can upgrade to A or C if needed.
 *
 *   • single + batch     → SUM(batch.qty_at_asof × batch.purchase_rate)
 *                          / SUM(batch.qty_at_asof)
 *     EXACT historical: each batch's purchase_rate is frozen at
 *     first-write so it IS the historical rate. The qty at asOfDate
 *     is derived from stock_ledger (sum qty_in - qty_out for the
 *     batch up to asOfDate). Out-of-stock batches drop out.
 *
 * @param {Object} product   Plain product row.
 * @param {string} asOfDate  YYYY-MM-DD.
 * @param {Object|null} batchAgg  Pre-fetched as-of batch aggregate
 *                                ({ total_value, total_qty }) for
 *                                this product. If absent for a
 *                                single+batch product, the function
 *                                returns 0 (caller is expected to
 *                                pre-fetch via fetchBatchAggregateAsOf
 *                                when computing batch values).
 * @returns {number}         Cost rate per unit, rounded to 4 decimals.
 */
function computeDisplayCostAsOf(product, asOfDate, batchAgg = null) {
  if (!product) return 0;
  if (product.product_mode === 'single' && product.is_batch_tracked) {
    const tv = batchAgg ? batchAgg.total_value : 0;
    const tq = batchAgg ? batchAgg.total_qty   : 0;
    return tq > 0 ? round4(tv / tq) : 0;
  }
  if (product.product_mode === 'single') {
    // Approximation: current wac stands in for as-of-date wac (option B).
    // Falls back through wac → purchase_rate → 0 to handle edge cases:
    //   • brand-new single product with no purchases yet → wac NULL,
    //     fall to purchase_rate (the catalog seed rate)
    //   • single product with stock but never priced → 0 (defensive)
    const wac = parseFloat(product.weighted_avg_cost);
    if (Number.isFinite(wac) && wac !== 0) return wac;
    return parseFloat(product.purchase_rate || 0);
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
  computeDisplayCostAsOf,
  fetchBatchAggregateAsOf,
};
