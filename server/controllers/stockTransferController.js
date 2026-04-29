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
  ProductGodownStock,
} = require('../models');
const { applyGodownStockDelta, getGodownStock } = require('../utils/godownStock');
const { scopeWhereByGodownEither, denyIfGodownInaccessible } = require('../middleware/godownScope');
const { generateBillNumber } = require('../utils/helpers');

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
          include: [{ model: Product, as: 'product', attributes: ['product_id', 'product_name', 'barcode', 'unit_of_measurement'] }],
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
    // Pre-check stock availability at the source godown when going
    // straight to In-Transit. Drafts skip — operator can fix the issue
    // before submitting.
    if (initialStatus === 'In-Transit') {
      for (const it of items) {
        const have = await getGodownStock({
          product_id: it.product_id, godown_id: from_godown_id, t,
        });
        if (parseFloat(have) < parseFloat(it.quantity)) {
          await t.rollback();
          const p = await Product.findByPk(it.product_id);
          return res.status(400).json({
            error: `Insufficient stock for ${p?.product_name || `product ${it.product_id}`} at source godown (have ${have}, need ${it.quantity}).`,
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
      const product = await Product.findByPk(it.product_id, { transaction: t });
      const lineAmount = parseFloat(it.quantity || 0) * parseFloat(it.rate || 0);
      await StockTransferItem.create({
        transfer_id: transfer.transfer_id,
        product_id:  it.product_id,
        barcode:     product?.barcode || it.barcode || null,
        quantity:    it.quantity,
        rate:        it.rate || 0,
        amount:      lineAmount,
        remarks:     it.remarks,
      }, { transaction: t });

      // Out-legs only when going straight to In-Transit. Drafts don't
      // touch stock.
      if (initialStatus === 'In-Transit') {
        await applyGodownStockDelta({
          product_id: it.product_id, godown_id: from_godown_id,
          delta: -parseFloat(it.quantity), t,
        });
        await StockLedger.create({
          product_id:       it.product_id,
          godown_id:        from_godown_id,
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

    for (const it of transfer.items) {
      const have = await getGodownStock({
        product_id: it.product_id, godown_id: transfer.from_godown_id, t,
      });
      if (parseFloat(have) < parseFloat(it.quantity)) {
        await t.rollback();
        return res.status(400).json({
          error: `Insufficient stock for product ${it.product_id} at source (have ${have}, need ${it.quantity}).`,
        });
      }
      await applyGodownStockDelta({
        product_id: it.product_id, godown_id: transfer.from_godown_id,
        delta: -parseFloat(it.quantity), t,
      });
      await StockLedger.create({
        product_id:       it.product_id,
        godown_id:        transfer.from_godown_id,
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

    for (const it of transfer.items) {
      await applyGodownStockDelta({
        product_id: it.product_id, godown_id: transfer.to_godown_id,
        delta: +parseFloat(it.quantity), t,
      });
      await StockLedger.create({
        product_id:       it.product_id,
        godown_id:        transfer.to_godown_id,
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
      // rows we wrote on submit.
      for (const it of transfer.items) {
        await applyGodownStockDelta({
          product_id: it.product_id, godown_id: transfer.from_godown_id,
          delta: +parseFloat(it.quantity), t,
        });
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
