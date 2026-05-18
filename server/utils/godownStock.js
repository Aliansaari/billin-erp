/*
 * Per-godown stock mutation helpers.
 *
 * Every stock-write path in the system MUST go through applyGodownStockDelta
 * — sales create/update/cancel, purchase create/update/cancel, sales-return,
 * purchase-return, stock-transfer, opening-stock entry. Centralising here
 * keeps three invariants in one place:
 *
 *   1. The (product_id, godown_id) row in product_godown_stock is always
 *      created when missing (a product transferred-in to a new godown for
 *      the first time needs an upsert, not an update).
 *   2. The row is locked FOR UPDATE inside the caller's transaction, so
 *      concurrent writes to the same product/godown serialise instead of
 *      racing.
 *   3. products.current_stock is kept in sync as SUM across godowns. Many
 *      legacy callers still read it (the bill-form product picker, several
 *      reports, the importer) and we don't break them in this commit.
 *
 * Design choice on products.current_stock:
 *   We keep the column rather than dropping it. Dropping would force a
 *   simultaneous edit of >100 call sites, which is not a single-commit
 *   change. The price is a tiny extra UPDATE per stock movement — in
 *   exchange for dropping the column, every callsite would need to
 *   compute the SUM at read time. Trade-off favours keeping it; a
 *   follow-up can prune once readers migrate.
 *
 * What this module does NOT do:
 *   - Write stock_ledger rows. Callers do that themselves so they can pin
 *     the right reference_id / reference_number / transaction_type. We
 *     just maintain the per-godown total.
 *   - Validate negative stock. Callers decide whether to allow it (the
 *     "allow negative stock" system setting governs this).
 */

const sequelize = require('../config/database');
const { Product, ProductGodownStock, Godown } = require('../models');

/**
 * Apply a +/- delta to product_godown_stock.current_stock at a specific
 * godown, then refresh products.current_stock to match the new sum.
 *
 * @param {Object}  args
 * @param {number}  args.product_id  Product to mutate.
 * @param {number}  args.godown_id   Godown the movement happened at.
 * @param {number}  args.delta       Signed change. +5 for an incoming
 *                                   purchase line, -5 for an outgoing sale,
 *                                   etc. Decimals fine.
 * @param {Object}  args.t           Sequelize transaction. Required —
 *                                   running outside one would race.
 * @returns {Promise<number>}        The resulting current_stock at this
 *                                   godown (post-delta).
 */
async function applyGodownStockDelta({ product_id, godown_id, delta, t, skipProductSync = false }) {
  if (!product_id) throw new Error('applyGodownStockDelta: product_id is required');
  if (!godown_id)  throw new Error('applyGodownStockDelta: godown_id is required');
  if (!t)          throw new Error('applyGodownStockDelta: transaction is required');

  // findOrCreate with FOR UPDATE locks the row when it already exists.
  // For a freshly-inserted row, the INSERT itself locks it until the
  // transaction commits. Either way the next concurrent caller waits for
  // us — no double-deduction race.
  const [row] = await ProductGodownStock.findOrCreate({
    where: { product_id, godown_id },
    defaults: { product_id, godown_id, current_stock: 0, opening_stock: 0 },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const next = +(parseFloat(row.current_stock || 0) + parseFloat(delta || 0)).toFixed(2);
  await row.update({ current_stock: next }, { transaction: t });

  if (!skipProductSync) {
    // Mirror to products.current_stock = SUM across all godowns.
    // Done as a single UPDATE-from-subquery so we don't have to fetch every
    // PGS row of this product into JS.
    await sequelize.query(
      `UPDATE products
          SET current_stock = COALESCE(
            (SELECT SUM(current_stock) FROM product_godown_stock WHERE product_id = :pid),
            0
          )
        WHERE product_id = :pid`,
      { replacements: { pid: product_id }, transaction: t },
    );
  }

  return next;
}

async function syncProductStockFromGodowns(productIds, t) {
  if (!productIds.length) return;
  await sequelize.query(
    `UPDATE products
        SET current_stock = COALESCE(
          (SELECT SUM(current_stock) FROM product_godown_stock WHERE product_id = products.product_id),
          0
        )
      WHERE product_id IN (:pids)`,
    { replacements: { pids: productIds }, transaction: t },
  );
}

/**
 * Read current_stock at a specific godown without mutating it. Returns 0
 * for missing pairs (matches the implicit-zero semantics of pre-godown
 * code that defaulted unmoved products to zero stock).
 *
 * `lock: true` (audit H7) takes a row-level FOR UPDATE lock so a
 * pre-check followed by applyGodownStockDelta in the same transaction
 * serialises against concurrent writers. Without this lock, two
 * concurrent sales of the last unit can both pass the pre-check
 * (both see stock=1) and both apply -1, ending at stock=-1 even when
 * `allow_negative_stock=false`. Callers in pre-check paths SHOULD pass
 * `{ lock: true }`; callers that just want a read-only snapshot
 * (reports, UI) leave it false.
 */
async function getGodownStock({ product_id, godown_id, t, lock = false }) {
  if (!product_id || !godown_id) return 0;
  const row = await ProductGodownStock.findOne({
    where: { product_id, godown_id },
    transaction: t,
    lock: (lock && t) ? t.LOCK.UPDATE : undefined,
  });
  return row ? parseFloat(row.current_stock || 0) : 0;
}

/**
 * Look up the default godown id (the row with is_default=true). Used by
 * controllers + bill creation when the request didn't specify a godown
 * (legacy clients, imports, scripts). Throws if no default is set —
 * which would be a startup misconfiguration since the seeder always
 * creates one.
 */
async function getDefaultGodownId({ t } = {}) {
  const row = await Godown.findOne({
    where: { is_default: true },
    transaction: t,
  });
  if (!row) {
    throw new Error('No default godown configured. Set one in Settings → Godowns.');
  }
  return row.godown_id;
}

/**
 * Resolve the godown for a write. Pure helper, no DB writes.
 *
 *   1. Use the explicit godown_id from the request body if present and
 *      the user's allowed_godowns permits it.
 *   2. Fall back to the user's first allowed godown.
 *   3. Fall back to the system default godown.
 *
 * Returns { godown_id, error }. If error is set, caller should respond 403.
 */
async function resolveGodownForWrite({ req_godown_id, user, t } = {}) {
  const role = user?.Role?.role_name;
  const isSuperAdmin = role === 'Super Admin' || role === 'Admin';
  const allowed = (!isSuperAdmin && Array.isArray(user?.allowed_godowns))
    ? user.allowed_godowns
    : null;

  if (req_godown_id) {
    if (allowed && !allowed.includes(parseInt(req_godown_id, 10))) {
      return { godown_id: null, error: 'You do not have access to that godown.' };
    }
    return { godown_id: parseInt(req_godown_id, 10), error: null };
  }

  if (allowed && allowed.length > 0) {
    return { godown_id: allowed[0], error: null };
  }

  const def = await getDefaultGodownId({ t });
  return { godown_id: def, error: null };
}

module.exports = {
  applyGodownStockDelta,
  syncProductStockFromGodowns,
  getGodownStock,
  getDefaultGodownId,
  resolveGodownForWrite,
};
