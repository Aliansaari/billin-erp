/*
 * Per-batch stock mutation helpers. Mirror of utils/godownStock.js for the
 * batch dimension.
 *
 * For a batch-tracked product, every stock-write path must call BOTH:
 *   1. applyGodownStockDelta — keeps product_godown_stock + products.current_stock
 *   2. applyBatchStockDelta  — keeps product_batch_stock at (product, batch, godown)
 *
 * The two are kept in sync by the caller (the bill controller). They are
 * NOT folded into a single function because non-batch products only need
 * the godown-level delta, and most products in the system are non-batch.
 *
 * Invariants this module preserves:
 *   - product_batch_stock row exists exactly once per (product, batch, godown)
 *     triple — findOrCreate inside the transaction.
 *   - The row is locked FOR UPDATE inside the caller's transaction so two
 *     concurrent purchases against the same (product, batch, godown) don't
 *     race the increment.
 *   - DECIMAL precision matches the column (3 decimals) — products tracked
 *     by batch are often pharma/food, where milligram-level precision matters.
 */

const sequelize = require('../config/database');
const { ProductBatch, ProductBatchStock } = require('../models');

/**
 * Find an existing batch by (product_id, batch_number) or create one.
 * Optional metadata fills in on creation; on update of an existing batch
 * we deliberately do NOT overwrite mfg/exp/notes — first-write wins, so a
 * subsequent purchase of the same batch can't silently change the dates
 * recorded on the original receipt.
 *
 * @param {Object}  args
 * @param {number}  args.product_id
 * @param {string}  args.batch_number
 * @param {string}  [args.manufacture_date]  YYYY-MM-DD
 * @param {string}  [args.expiry_date]       YYYY-MM-DD
 * @param {string}  [args.notes]
 * @param {Object}  args.t                   Sequelize transaction (required).
 * @returns {Promise<ProductBatch>}
 */
async function resolveOrCreateBatch({ product_id, batch_number, manufacture_date, expiry_date, notes, t }) {
  if (!product_id)   throw new Error('resolveOrCreateBatch: product_id is required');
  if (!batch_number) throw new Error('resolveOrCreateBatch: batch_number is required');
  if (!t)            throw new Error('resolveOrCreateBatch: transaction is required');

  // Normalise the batch number — trim whitespace; preserve case (operators
  // distinguish "Lot-2401" from "LOT-2401"). The unique index is case-
  // sensitive; if a firm wants case-insensitive batches they can adopt a
  // convention without us forcing one.
  const normalised = String(batch_number).trim();
  if (!normalised) throw new Error('Batch number cannot be empty');

  const [batch] = await ProductBatch.findOrCreate({
    where: { product_id, batch_number: normalised },
    defaults: {
      product_id,
      batch_number: normalised,
      manufacture_date: manufacture_date || null,
      expiry_date: expiry_date || null,
      notes: notes || null,
      is_active: true,
    },
    transaction: t,
  });

  return batch;
}

/**
 * Apply a +/- delta to product_batch_stock.current_stock for one
 * (product, batch, godown) triple. Does NOT touch products.current_stock
 * or product_godown_stock — those are the godown-level helper's job, and
 * the caller invokes both in the same transaction.
 *
 * @param {Object}  args
 * @param {number}  args.product_id
 * @param {number}  args.batch_id
 * @param {number}  args.godown_id
 * @param {number}  args.delta       Signed change. Positive on receipt
 *                                   (purchase, opening, sales-return);
 *                                   negative on issue (sale, purchase-
 *                                   return, transfer-out).
 * @param {Object}  args.t           Sequelize transaction (required).
 * @returns {Promise<number>}        Resulting current_stock at this triple.
 */
async function applyBatchStockDelta({ product_id, batch_id, godown_id, delta, t }) {
  if (!product_id) throw new Error('applyBatchStockDelta: product_id is required');
  if (!batch_id)   throw new Error('applyBatchStockDelta: batch_id is required');
  if (!godown_id)  throw new Error('applyBatchStockDelta: godown_id is required');
  if (!t)          throw new Error('applyBatchStockDelta: transaction is required');

  const [row] = await ProductBatchStock.findOrCreate({
    where: { product_id, batch_id, godown_id },
    defaults: { product_id, batch_id, godown_id, current_stock: 0 },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  // 3-decimal precision on the column; round to 3 here so floating-point
  // arithmetic doesn't surface as 1.2999999999 in the DB.
  const next = +(parseFloat(row.current_stock || 0) + parseFloat(delta || 0)).toFixed(3);
  await row.update({ current_stock: next }, { transaction: t });
  return next;
}

/**
 * Read current_stock for one (product, batch, godown) triple. Implicit zero
 * for missing rows — matches the convention in godownStock.getGodownStock.
 */
async function getBatchStock({ product_id, batch_id, godown_id, t }) {
  if (!product_id || !batch_id || !godown_id) return 0;
  const row = await ProductBatchStock.findOne({
    where: { product_id, batch_id, godown_id },
    transaction: t,
  });
  return row ? parseFloat(row.current_stock || 0) : 0;
}

module.exports = {
  resolveOrCreateBatch,
  applyBatchStockDelta,
  getBatchStock,
};
