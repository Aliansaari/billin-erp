/*
 * stockLedgerReversal — preserves the audit trail when a bill is cancelled
 * or edited.
 *
 * Audit H5 — the cancel/edit paths previously called StockLedger.destroy()
 * to wipe the rows for the bill. That left the Stock Movement page unable
 * to reconstruct "what was sold and then unsold on these dates", which is
 * required for any GST audit asking to see the lifecycle of cancelled or
 * edited invoices.
 *
 * The fix: keep the originals AND write a paired reversing row per active
 * line. The reversal row mirrors the original but swaps quantity_in <->
 * quantity_out and points back at the original via
 * `is_reversal_of_ledger_id`. So:
 *
 *   - SUM(quantity_in - quantity_out) per product is unchanged (original
 *     row's contribution is exactly cancelled by the reversal row).
 *   - The Stock Movement timeline shows BOTH rows, so an auditor can see
 *     the goods went out then came back in the same audit trail.
 *   - On a SECOND edit, we only reverse the still-active originals (those
 *     no other row points back at via is_reversal_of_ledger_id). The very
 *     first edit's reversal rows are themselves leaves — they don't get
 *     re-reversed.
 *
 * Note: this helper does NOT update product.current_stock or per-godown
 * totals. The cancel/edit paths already call applyGodownStockDelta
 * separately to credit/debit the stock. This helper is purely the
 * audit-trail pair.
 *
 * Usage:
 *
 *   const { writeStockLedgerReversal } = require('../utils/stockLedgerReversal');
 *   await writeStockLedgerReversal({
 *     referenceId: bill.sales_bill_id,
 *     transactionType: 'Sales',
 *     reason: `Bill ${bill.bill_number} cancelled`,
 *     userId: req.user?.user_id,
 *     t,
 *     // optional: skipIdempotencyCheck=true for edit paths
 *   });
 *
 * Idempotency:
 *   - Cancel paths (default): if a reversal already exists for this
 *     (reference_id, transaction_type), skip — prevents duplicate
 *     reversals on a re-invocation of cancel.
 *   - Edit paths (pass skipIdempotencyCheck=true): every edit writes its
 *     own paired reversal of the currently-active originals.
 */

'use strict';

const sequelize = require('../config/database');
const { StockLedger } = require('../models');

const REVERSAL_PREFIX = 'REVERSAL';

async function writeStockLedgerReversal({ referenceId, transactionType, reason, userId, t, skipIdempotencyCheck = false }) {
  if (!referenceId) throw new Error('writeStockLedgerReversal: referenceId is required');
  if (!transactionType) throw new Error('writeStockLedgerReversal: transactionType is required');
  if (!t) throw new Error('writeStockLedgerReversal: transaction is required');

  // Load currently-active (unreversed) originals via NOT EXISTS on
  // is_reversal_of_ledger_id. Multi-edit-correct: each edit only reverses
  // the latest active set; prior reversed rows stay frozen.
  const originals = await sequelize.query(
    `SELECT * FROM stock_ledger s
      WHERE s.reference_id = :refId
        AND s.transaction_type = :tt
        AND s.is_reversal_of_ledger_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM stock_ledger r
           WHERE r.is_reversal_of_ledger_id = s.ledger_id
        )`,
    {
      replacements: { refId: referenceId, tt: transactionType },
      type: sequelize.QueryTypes.SELECT,
      transaction: t,
    },
  );

  if (originals.length === 0) return { skipped: true, reason: 'no active originals to reverse' };

  // Cancel-flow idempotency: if a reversal already exists for this
  // reference (e.g., the cancel controller is being re-invoked on retry),
  // skip silently. Edit-flow callers pass skipIdempotencyCheck=true to
  // bypass — every edit writes its own reversal pair.
  if (!skipIdempotencyCheck) {
    const [{ already_reversed_count }] = await sequelize.query(
      `SELECT COUNT(*)::int AS already_reversed_count FROM stock_ledger
        WHERE reference_id = :refId AND transaction_type = :tt
          AND is_reversal_of_ledger_id IS NOT NULL`,
      {
        replacements: { refId: referenceId, tt: transactionType },
        type: sequelize.QueryTypes.SELECT,
        transaction: t,
      },
    );
    if (already_reversed_count > 0) {
      return { skipped: true, reason: 'reversal already written' };
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const row of originals) {
    await StockLedger.create({
      product_id:        row.product_id,
      godown_id:         row.godown_id,
      batch_id:          row.batch_id,
      barcode:           row.barcode,
      transaction_type:  row.transaction_type,
      transaction_date:  today,
      reference_id:      row.reference_id,
      reference_number:  row.reference_number,
      // Swap qty_in <-> qty_out so the row exactly cancels the original's
      // SUM(quantity_in - quantity_out) contribution.
      quantity_in:       row.quantity_out,
      quantity_out:      row.quantity_in,
      rate:              row.rate,
      balance_quantity:  0,
      remarks:           `${REVERSAL_PREFIX}: ${reason || 'cancelled'}`,
      is_reversal_of_ledger_id: row.ledger_id,
      created_by:        userId || null,
    }, { transaction: t });
  }

  return { reversed: originals.length };
}

module.exports = { writeStockLedgerReversal };
