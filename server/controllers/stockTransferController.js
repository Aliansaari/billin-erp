/*
 * Stock Transfer controller — godown-to-godown inventory movement.
 *
 * What a stock transfer is:
 *   The same legal entity moving its own goods between two of its own
 *   godowns. Has stock impact (one Out at the source, one In at the
 *   destination, written to stock_ledger and reflected in
 *   product_godown_stock.current_stock at both godowns) but ZERO financial
 *   impact — no ledger_entries, no party balance, no GST. Trial Balance
 *   and P&L are unchanged after a transfer; the Balance Sheet's total
 *   stock-in-hand is unchanged (only its per-godown distribution moves).
 *
 * Status lifecycle (see model file for the full lifecycle prose):
 *   Draft       → no stock has moved yet. Editable, cancellable.
 *   In-Transit  → Out-leg written from source. Goods on a truck.
 *   Received    → In-leg written into destination. Terminal-success.
 *   Cancelled   → All written legs reversed. Terminal-failure.
 *
 * Numbering:
 *   ST-NNNN by default (override prefix via SystemSettings.stock_transfer_prefix
 *   if/when added). Reuses generateBillNumber from helpers.
 *
 * Concurrency:
 *   Every stock-mutating path runs inside a single transaction with
 *   `applyGodownStockDelta` taking row-level locks on the affected
 *   product_godown_stock rows. Two operators initiating concurrent
 *   transfers of the same product from the same godown will serialise
 *   correctly (the second waits for the first to commit).
 */

const sequelize = require('../config/database');
const { Op } = require('sequelize');
const {
  StockTransfer, StockTransferItem, Product, Godown, StockLedger,
  ProductGodownStock, ProductBatch, SystemSettings,
} = require('../models');
const { applyGodownStockDelta, getGodownStock } = require('../utils/godownStock');
const { applyBatchStockDelta, getBatchStock } = require('../utils/batchStock');
const { consumeFIFO, addCostLayer, isFifoMode } = require('../utils/costLayers');
const { scopeWhereByGodownEither, denyIfGodownInaccessible } = require('../middleware/godownScope');
const { generateBillNumber } = require('../utils/helpers');

/**
 * Per-line batch validation. Mirrors validateBatchLine in salesController
 * but trimmed for the transfer flow:
 *   - No expiry block — internal movement of expired stock between
 *     godowns is a legitimate "consolidate to a quarantine godown"
 *     workflow. Sales / Purchase honour block_expired_sales; transfers
 *     don't, by design.
 *   - Source-side stock check uses getBatchStock at from_godown rather
 *     than billData.godown_id.
 * Returns null on success, a human-readable error string on failure.
 */
async function validateTransferBatchLine({ product, item, fromGodownId, t }) {
  if (!product) return null;
  if (!product.is_batch_tracked) return null;
  if (!item.batch_id) return null;  // Caller decides whether to enforce.

  const batch = await ProductBatch.findByPk(item.batch_id, { transaction: t });
  if (!batch) return `Batch not found (id=${item.batch_id}) for "${product.product_name}".`;
  if (parseInt(batch.product_id, 10) !== parseInt(product.product_id, 10)) {
    return `Batch ${batch.batch_number} does not belong to "${product.product_name}".`;
  }
  if (batch.is_active === false) {
    return `Batch ${batch.batch_number} for "${product.product_name}" is inactive.`;
  }
  const onHand = await getBatchStock({
    product_id: product.product_id, batch_id: item.batch_id, godown_id: fromGodownId, t,
  });
  if (parseFloat(item.quantity) > onHand + 0.001) {
    return `Batch ${batch.batch_number} for "${product.product_name}" has only ${onHand} available at the source godown. Reduce qty or pick another batch.`;
  }
  return null;
}

/** Pull the next transfer number atomically. Locks the latest row's number
 * row inside the transaction so two concurrent creates don't both pick the
 * same N+1. Pattern mirrors salesController's bill-number generation. */
async function nextTransferNumber(t) {
  const rows = await sequelize.query(
    `SELECT transfer_number FROM stock_transfers
        ORDER BY transfer_id DESC LIMIT 1
        FOR UPDATE`,
    { transaction: t, type: sequelize.QueryTypes.SELECT },
  );
  const lastStr = rows[0]?.transfer_number || '';
  // Extract trailing digits and increment. Handles "ST-0042" → 43,
  // "0042" → 43, and missing-row → 1.
  const m = String(lastStr).match(/(\d+)\s*$/);
  const lastNum = m ? parseInt(m[1], 10) : 0;
  return generateBillNumber('ST', lastNum);
}

exports.getAll = async (req, res) => {
  try {
    const { from_godown_id, to_godown_id, status, start_date, end_date, q } = req.query;
    const where = {};
    if (from_godown_id) where.from_godown_id = from_godown_id;
    if (to_godown_id)   where.to_godown_id   = to_godown_id;
    if (status)         where.status         = status;
    if (start_date && end_date) where.transfer_date = { [Op.between]: [start_date, end_date] };
    else if (start_date)        where.transfer_date = { [Op.gte]:    start_date };
    else if (end_date)          where.transfer_date = { [Op.lte]:    end_date };
    if (q) where.transfer_number = { [Op.iLike]: `%${q}%` };

    // Scope: a transfer is visible if either side touches an allowed godown.
    scopeWhereByGodownEither(where, req.user);

    const rows = await StockTransfer.findAll({
      where,
      include: [
        { model: Godown, as: 'fromGodown', attributes: ['godown_id', 'code', 'name'] },
        { model: Godown, as: 'toGodown',   attributes: ['godown_id', 'code', 'name'] },
      ],
      order: [['transfer_date', 'DESC'], ['transfer_id', 'DESC']],
    });
    res.json(rows);
  } catch (err) {
    console.error('[stockTransfer.getAll]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const row = await StockTransfer.findByPk(req.params.id, {
      include: [
        { model: Godown, as: 'fromGodown' },
        { model: Godown, as: 'toGodown' },
        {
          model: StockTransferItem, as: 'items',
          // is_batch_tracked is needed so the form can re-light the picker
          // on edit-load; the batch include carries the same lot identity
          // that moved at submission time so re-opens / cancels operate on
          // the correct batch row.
          include: [
            { model: Product,      as: 'product', attributes: ['product_id', 'product_name', 'barcode', 'unit_of_measurement', 'is_batch_tracked'] },
            { model: ProductBatch, as: 'batch',   attributes: ['batch_id', 'batch_number', 'manufacture_date', 'expiry_date'] },
          ],
        },
      ],
    });
    if (!row) return res.status(404).json({ error: 'Stock transfer not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Create a transfer. Two flows depending on body.status:
 *   - 'Draft'      → save as draft, no stock movement.
 *   - 'In-Transit' → deduct from source godown immediately; write Out
 *                    legs to stock_ledger; status='In-Transit'.
 *
 * The body should carry: transfer_date, from_godown_id, to_godown_id,
 * notes, items: [{ product_id, quantity, rate, remarks }].
 */
exports.create = async (req, res) => {
  const { transfer_date, from_godown_id, to_godown_id, status, notes, items } = req.body;
  if (!from_godown_id || !to_godown_id) {
    return res.status(400).json({ error: 'from_godown_id and to_godown_id are required' });
  }
  if (parseInt(from_godown_id, 10) === parseInt(to_godown_id, 10)) {
    return res.status(400).json({ error: 'from and to godowns must differ' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }

  // Permission: user must have access to BOTH godowns (since they're
  // initiating a movement at both). An operator restricted to a single
  // godown cannot transfer to a godown they can't see.
  const denyFrom = denyIfGodownInaccessible(from_godown_id, req.user);
  if (denyFrom) return res.status(403).json({ error: denyFrom });
  const denyTo = denyIfGodownInaccessible(to_godown_id, req.user);
  if (denyTo) return res.status(403).json({ error: denyTo });

  const initialStatus = status === 'In-Transit' ? 'In-Transit' : 'Draft';

  const t = await sequelize.transaction();
  try {
    // Global batch toggle gate. When OFF, any incoming batch_id on
    // items is silently dropped — the system is in non-batch mode and
    // the per-batch table stays untouched (regression preserved).
    const sysSettings = await SystemSettings.findByPk(1, { transaction: t });
    const batchTrackingOn = !!sysSettings?.batch_tracking_enabled;

    // Pre-resolve products so we can both stock-check AND batch-validate
    // in one pass. Skip the godown-level pre-check for batch-tracked
    // products on In-Transit — the per-batch validator below does a
    // strictly tighter check (batch on-hand ≤ godown on-hand).
    const productMap = new Map();
    for (const it of items) {
      if (!productMap.has(it.product_id)) {
        const p = await Product.findByPk(it.product_id, { transaction: t });
        productMap.set(it.product_id, p);
      }
    }

    if (initialStatus === 'In-Transit') {
      for (const it of items) {
        const product = productMap.get(it.product_id);
        const isBatched = batchTrackingOn && product?.is_batch_tracked;
        if (isBatched) {
          // Per-batch validator covers stock + identity + active flag.
          if (!it.batch_id) {
            await t.rollback();
            return res.status(400).json({
              error: `"${product.product_name}" is batch-tracked but no batch was picked. Open the line and select a batch.`,
            });
          }
          const err = await validateTransferBatchLine({
            product, item: it, fromGodownId: from_godown_id, t,
          });
          if (err) {
            await t.rollback();
            return res.status(400).json({ error: err });
          }
        } else {
          // Non-batch: godown-level check (audit H7 — lock the row).
          const have = await getGodownStock({
            product_id: it.product_id, godown_id: from_godown_id, t,
            lock: true,
          });
          if (parseFloat(have) < parseFloat(it.quantity)) {
            await t.rollback();
            return res.status(400).json({
              error: `Insufficient stock for ${product?.product_name || `product ${it.product_id}`} at source godown (have ${have}, need ${it.quantity}).`,
            });
          }
        }
      }
    } else if (batchTrackingOn) {
      // Draft path — relax stock checks (operator may fix later) but
      // still enforce that batch-tracked products carry a batch_id so
      // the saved Draft can be submitted later without re-editing.
      for (const it of items) {
        const product = productMap.get(it.product_id);
        if (product?.is_batch_tracked && !it.batch_id) {
          await t.rollback();
          return res.status(400).json({
            error: `"${product.product_name}" is batch-tracked but no batch was picked. Open the line and select a batch.`,
          });
        }
      }
    }

    const transfer_number = await nextTransferNumber(t);

    const totalQty = items.reduce((s, x) => s + parseFloat(x.quantity || 0), 0);
    const totalVal = items.reduce((s, x) => s + parseFloat(x.quantity || 0) * parseFloat(x.rate || 0), 0);

    const transfer = await StockTransfer.create({
      transfer_number,
      transfer_date: transfer_date || new Date().toISOString().slice(0, 10),
      from_godown_id, to_godown_id,
      status: initialStatus,
      notes,
      total_quantity: totalQty,
      total_value: totalVal,
      created_by: req.user.user_id,
    }, { transaction: t });

    // Item rows.
    for (const it of items) {
      const product = productMap.get(it.product_id);
      // Persist batch_id only when the product is genuinely batch-tracked
      // AND the global toggle is on — silently drops a stray batch_id
      // from a non-batch product so a misconfigured client can't pollute
      // the stock_transfer_items.batch_id column.
      const batchId = (batchTrackingOn && product?.is_batch_tracked)
        ? (it.batch_id || null)
        : null;
      const lineAmount = parseFloat(it.quantity || 0) * parseFloat(it.rate || 0);
      const newItem = await StockTransferItem.create({
        transfer_id: transfer.transfer_id,
        product_id:  it.product_id,
        barcode:     product?.barcode || it.barcode || null,
        quantity:    it.quantity,
        rate:        it.rate || 0,
        amount:      lineAmount,
        remarks:     it.remarks,
        batch_id:    batchId,
      }, { transaction: t });

      // Out-legs only when going straight to In-Transit. Drafts don't
      // touch stock.
      if (initialStatus === 'In-Transit') {
        await applyGodownStockDelta({
          product_id: it.product_id, godown_id: from_godown_id,
          delta: -parseFloat(it.quantity), t,
        });
        // Audit H6 L2 — consume FIFO at source godown; stash the consumed
        // (qty, rate) pairs on the item so the destination receive can
        // recreate matching layers there. In weighted_avg mode this is a
        // no-op (layers don't drive costing).
        if (await isFifoMode(t, it.product_id)) {
          const fifoR = await consumeFIFO({
            product_id: it.product_id, godown_id: from_godown_id,
            qty: +parseFloat(it.quantity), t,
          });
          await sequelize.query(
            `UPDATE stock_transfer_items SET cost_layers_consumed = :cl::jsonb WHERE item_id = :iid`,
            {
              replacements: {
                cl: JSON.stringify((fifoR.consumedRows || []).map(r => ({ qty: r.qty, rate: r.rate }))),
                iid: newItem.item_id,
              },
              transaction: t,
            },
          );
        }
        // Per-batch decrement at source — keeps product_batch_stock in
        // step with the godown-level total. NB: product_batch_stock
        // never gets a row CREATED on the Out leg (the batch must
        // already exist at from_godown to have stock to take), so this
        // is always an update against an existing row.
        if (batchId) {
          await applyBatchStockDelta({
            product_id: it.product_id, batch_id: batchId,
            godown_id: from_godown_id,
            delta: -parseFloat(it.quantity), t,
          });
        }
        await StockLedger.create({
          product_id:       it.product_id,
          godown_id:        from_godown_id,
          batch_id:         batchId,
          barcode:          product?.barcode,
          transaction_type: 'Stock Transfer',
          transaction_date: transfer.transfer_date,
          reference_id:     transfer.transfer_id,
          reference_number: transfer.transfer_number,
          quantity_in:      0,
          quantity_out:     it.quantity,
          rate:             it.rate || 0,
          remarks:          `Out → ${transfer.transfer_number}`,
          created_by:       req.user.user_id,
        }, { transaction: t });
      }
    }

    await t.commit();
    const full = await StockTransfer.findByPk(transfer.transfer_id, {
      include: [
        { model: Godown, as: 'fromGodown' },
        { model: Godown, as: 'toGodown' },
        { model: StockTransferItem, as: 'items', include: [{ model: Product, as: 'product' }] },
      ],
    });
    res.status(201).json(full);
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('[stockTransfer.create]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Submit a Draft → In-Transit. Writes the Out-leg stock ledger rows and
 * deducts from the source godown.
 */
exports.submit = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    // FOR UPDATE only locks the parent stock_transfers row; the
    // included stock_transfer_items rows must NOT be in the lock
    // because Postgres rejects "FOR UPDATE" on the nullable side
    // of an outer join (and Sequelize generates LEFT JOIN for
    // includes). Sequelize v6 supports the {level, of} form for
    // exactly this case.
    const transfer = await StockTransfer.findByPk(req.params.id, {
      include: [{ model: StockTransferItem, as: 'items' }],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: StockTransfer },
    });
    if (!transfer) {
      await t.rollback();
      return res.status(404).json({ error: 'Transfer not found' });
    }
    if (transfer.status !== 'Draft') {
      await t.rollback();
      return res.status(400).json({ error: `Cannot submit a transfer in status ${transfer.status}` });
    }

    const sysSettings = await SystemSettings.findByPk(1, { transaction: t });
    const batchTrackingOn = !!sysSettings?.batch_tracking_enabled;

    for (const it of transfer.items) {
      // Pull product to gate per-batch logic; batch_id on the item row
      // was already persisted at draft-create time.
      const product = await Product.findByPk(it.product_id, { transaction: t });
      const isBatched = batchTrackingOn && product?.is_batch_tracked && it.batch_id;
      if (isBatched) {
        const err = await validateTransferBatchLine({
          product, item: it, fromGodownId: transfer.from_godown_id, t,
        });
        if (err) {
          await t.rollback();
          return res.status(400).json({ error: err });
        }
      } else {
        // Audit H7 — lock the PGS row.
        const have = await getGodownStock({
          product_id: it.product_id, godown_id: transfer.from_godown_id, t,
          lock: true,
        });
        if (parseFloat(have) < parseFloat(it.quantity)) {
          await t.rollback();
          return res.status(400).json({
            error: `Insufficient stock for product ${it.product_id} at source (have ${have}, need ${it.quantity}).`,
          });
        }
      }
      await applyGodownStockDelta({
        product_id: it.product_id, godown_id: transfer.from_godown_id,
        delta: -parseFloat(it.quantity), t,
      });
      if (isBatched) {
        await applyBatchStockDelta({
          product_id: it.product_id, batch_id: it.batch_id,
          godown_id: transfer.from_godown_id,
          delta: -parseFloat(it.quantity), t,
        });
      }
      await StockLedger.create({
        product_id:       it.product_id,
        godown_id:        transfer.from_godown_id,
        batch_id:         isBatched ? it.batch_id : null,
        barcode:          it.barcode,
        transaction_type: 'Stock Transfer',
        transaction_date: transfer.transfer_date,
        reference_id:     transfer.transfer_id,
        reference_number: transfer.transfer_number,
        quantity_in:      0,
        quantity_out:     it.quantity,
        rate:             it.rate || 0,
        remarks:          `Out → ${transfer.transfer_number}`,
        created_by:       req.user.user_id,
      }, { transaction: t });
    }
    await transfer.update({ status: 'In-Transit' }, { transaction: t });
    await t.commit();
    res.json(transfer);
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('[stockTransfer.submit]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Mark a transfer as Received. Writes the In-leg stock ledger rows and
 * adds to the destination godown. Only valid from In-Transit.
 */
exports.receive = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    // FOR UPDATE only locks the parent stock_transfers row; the
    // included stock_transfer_items rows must NOT be in the lock
    // because Postgres rejects "FOR UPDATE" on the nullable side
    // of an outer join (and Sequelize generates LEFT JOIN for
    // includes). Sequelize v6 supports the {level, of} form for
    // exactly this case.
    const transfer = await StockTransfer.findByPk(req.params.id, {
      include: [{ model: StockTransferItem, as: 'items' }],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: StockTransfer },
    });
    if (!transfer) {
      await t.rollback();
      return res.status(404).json({ error: 'Transfer not found' });
    }
    if (transfer.status !== 'In-Transit') {
      await t.rollback();
      return res.status(400).json({
        error: `Cannot receive a transfer in status ${transfer.status}. Submit it first.`,
      });
    }

    const sysSettings = await SystemSettings.findByPk(1, { transaction: t });
    const batchTrackingOn = !!sysSettings?.batch_tracking_enabled;

    for (const it of transfer.items) {
      await applyGodownStockDelta({
        product_id: it.product_id, godown_id: transfer.to_godown_id,
        delta: +parseFloat(it.quantity), t,
      });
      // Audit H6 L2 — recreate matching cost layers at destination from
      // the consumed-source-layers snapshot taken on dispatch. Each
      // (qty, rate) pair becomes a fresh layer at destination, dated NOW
      // so the destination's FIFO ordering naturally puts them after any
      // pre-existing layers there. If the snapshot is missing (legacy
      // transfer or transfer happened in weighted_avg mode), fall back
      // to a single weighted-avg layer at the transfer rate.
      if (await isFifoMode(t)) {
        const consumed = Array.isArray(it.cost_layers_consumed) ? it.cost_layers_consumed : [];
        if (consumed.length > 0) {
          for (const cl of consumed) {
            await addCostLayer({
              product_id: it.product_id,
              godown_id: transfer.to_godown_id,
              qty: +parseFloat(cl.qty),
              rate: +parseFloat(cl.rate),
              source_type: 'Adjustment',
              source_id: transfer.transfer_id,
              acquired_at: new Date(),
              t,
            });
          }
        } else {
          // No snapshot — synthesize one layer at the transfer rate.
          // Better than nothing; the destination at least gets a layer
          // with a sensible rate (the item's recorded transfer rate).
          await addCostLayer({
            product_id: it.product_id,
            godown_id: transfer.to_godown_id,
            qty: +parseFloat(it.quantity),
            rate: +parseFloat(it.rate || 0),
            source_type: 'Adjustment',
            source_id: transfer.transfer_id,
            acquired_at: new Date(),
            t,
          });
        }
      }
      // Per-batch increment at destination — UPSERT pattern via
      // applyBatchStockDelta (which findOrCreate's the
      // (product, batch, godown) row when this destination has never
      // held this batch before, then increments). Same batch_id flows
      // through; we never create a new ProductBatch row, just a new
      // ProductBatchStock row at the destination godown.
      //
      // Audit M6: validate that the batch still belongs to this
      // product before crediting. submit() already validates this on
      // the source side via validateTransferBatchLine; if an admin
      // reassigned the batch (or merged) between submit and receive,
      // this guard prevents the In-leg from crediting the wrong
      // product's batch row.
      if (batchTrackingOn && it.batch_id) {
        const batch = await ProductBatch.findByPk(it.batch_id, { transaction: t });
        if (!batch || batch.product_id !== it.product_id) {
          await t.rollback();
          return res.status(400).json({
            error: `Batch #${it.batch_id} no longer belongs to product #${it.product_id}. ` +
                   'Cancel and re-create the transfer.',
          });
        }
        await applyBatchStockDelta({
          product_id: it.product_id, batch_id: it.batch_id,
          godown_id: transfer.to_godown_id,
          delta: +parseFloat(it.quantity), t,
        });
      }
      await StockLedger.create({
        product_id:       it.product_id,
        godown_id:        transfer.to_godown_id,
        batch_id:         (batchTrackingOn && it.batch_id) ? it.batch_id : null,
        barcode:          it.barcode,
        transaction_type: 'Stock Transfer',
        transaction_date: req.body.received_date || transfer.transfer_date,
        reference_id:     transfer.transfer_id,
        reference_number: transfer.transfer_number,
        quantity_in:      it.quantity,
        quantity_out:     0,
        rate:             it.rate || 0,
        remarks:          `In  ← ${transfer.transfer_number}`,
        created_by:       req.user.user_id,
      }, { transaction: t });
    }

    await transfer.update({
      status:        'Received',
      received_date: req.body.received_date || new Date().toISOString().slice(0, 10),
      received_by:   req.user.user_id,
    }, { transaction: t });

    await t.commit();
    res.json(transfer);
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('[stockTransfer.receive]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Cancel a transfer. Reverses any stock movements that have already
 * happened (Out-legs only if In-Transit; both Out and In if Received —
 * though in practice we don't allow cancelling from Received, see below).
 *
 * From Draft     → no movements to reverse, just mark cancelled.
 * From In-Transit → reverse Out-legs at source godown.
 * From Received  → REJECT. A received transfer is closed history. Issue
 *                  a reverse transfer (to → from) instead.
 */
exports.cancel = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    // FOR UPDATE only locks the parent stock_transfers row; the
    // included stock_transfer_items rows must NOT be in the lock
    // because Postgres rejects "FOR UPDATE" on the nullable side
    // of an outer join (and Sequelize generates LEFT JOIN for
    // includes). Sequelize v6 supports the {level, of} form for
    // exactly this case.
    const transfer = await StockTransfer.findByPk(req.params.id, {
      include: [{ model: StockTransferItem, as: 'items' }],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: StockTransfer },
    });
    if (!transfer) {
      await t.rollback();
      return res.status(404).json({ error: 'Transfer not found' });
    }
    if (transfer.status === 'Received') {
      await t.rollback();
      return res.status(400).json({
        error: 'Cannot cancel a Received transfer. Issue a reverse transfer to undo it.',
      });
    }
    if (transfer.status === 'Cancelled') {
      await t.rollback();
      return res.status(400).json({ error: 'Transfer already cancelled' });
    }

    if (transfer.status === 'In-Transit') {
      // Reverse Out-legs: add back at source godown, destroy the ledger
      // rows we wrote on submit. Received cancels are explicitly
      // rejected above, so by definition only the Out leg has fired —
      // no destination-side reversal needed here. (If the lifecycle
      // ever grows to allow Received cancels, the destination-side
      // reversal slots in symmetrically: applyBatchStockDelta with
      // godown_id=to_godown_id and delta=-qty.)
      const sysSettings = await SystemSettings.findByPk(1, { transaction: t });
      const batchTrackingOn = !!sysSettings?.batch_tracking_enabled;
      for (const it of transfer.items) {
        await applyGodownStockDelta({
          product_id: it.product_id, godown_id: transfer.from_godown_id,
          delta: +parseFloat(it.quantity), t,
        });
        if (batchTrackingOn && it.batch_id) {
          await applyBatchStockDelta({
            product_id: it.product_id, batch_id: it.batch_id,
            godown_id: transfer.from_godown_id,
            delta: +parseFloat(it.quantity), t,
          });
        }
      }
      await StockLedger.destroy({
        where: {
          reference_id: transfer.transfer_id,
          reference_number: transfer.transfer_number,
          transaction_type: 'Stock Transfer',
        },
        transaction: t,
      });
    }

    await transfer.update({
      status:              'Cancelled',
      cancelled_date:      new Date(),
      cancelled_by:        req.user.user_id,
      cancellation_reason: req.body.reason || null,
    }, { transaction: t });

    await t.commit();
    res.json(transfer);
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('[stockTransfer.cancel]', err);
    res.status(500).json({ error: err.message });
  }
};
