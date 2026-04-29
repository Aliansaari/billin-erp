/*
 * Godown CRUD controller.
 *
 * Concerns kept here:
 *   - List / create / update / soft-delete / hard-delete godowns.
 *   - Set the default godown atomically (clear-then-set in one transaction
 *     so the partial unique index on is_default never sees two defaults).
 *   - Refuse to delete the default godown.
 *   - Refuse to delete a system godown ("Main").
 *   - Refuse to hard-delete a godown that has stock or referenced bills —
 *     soft-delete (is_active=false) is the supported path once a godown
 *     has activity.
 *
 * Permissions:
 *   - List/read: godowns.view
 *   - Create/update/setDefault/delete: godowns.manage
 *
 * The list endpoint is intentionally NOT scoped by allowed_godowns —
 * users need to see godown labels (city/code) for the bills they CAN see,
 * which may reference any godown. The bill-form Godown selector applies
 * an additional client-side filter to allowed_godowns when picking a
 * godown for a NEW bill. Listing existing godowns is a read.
 */

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  Godown, ProductGodownStock,
  SalesBill, PurchaseBill, SalesReturnBill, PurchaseReturnBill,
  StockLedger, StockTransfer,
} = require('../models');

exports.getAll = async (req, res) => {
  try {
    const { include_inactive } = req.query;
    const where = include_inactive === 'true' ? {} : { is_active: true };
    const rows = await Godown.findAll({
      where,
      order: [['is_default', 'DESC'], ['code', 'ASC']],
    });
    res.json(rows);
  } catch (err) {
    console.error('[godown.getAll]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const row = await Godown.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Godown not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { name, code, address, city, state, pincode, gstin } = req.body;
    if (!name || !code) {
      return res.status(400).json({ error: 'Name and code are required' });
    }
    // Normalize code to uppercase so duplicate detection isn't fooled by
    // case (e.g. "MUM" vs "mum").
    const normCode = String(code).trim().toUpperCase();
    const existing = await Godown.findOne({
      where: { [Op.or]: [{ name: name.trim() }, { code: normCode }] },
    });
    if (existing) {
      const conflict = existing.code === normCode ? 'code' : 'name';
      return res.status(400).json({ error: `Godown with that ${conflict} already exists` });
    }
    const row = await Godown.create({
      name: name.trim(),
      code: normCode,
      address, city, state, pincode, gstin,
      is_default: false,    // default flipping uses setDefault
      is_active: true,
      is_system: false,     // only the seeded "Main" gets is_system
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('[godown.create]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const row = await Godown.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Godown not found' });

    const updates = { ...req.body };

    // Don't let the API mutate sensitive flags out-of-band.
    delete updates.is_default;   // setDefault handles this
    delete updates.is_system;    // server-managed
    delete updates.godown_id;
    delete updates.created_date;

    if (updates.code) updates.code = String(updates.code).trim().toUpperCase();
    if (updates.name) updates.name = String(updates.name).trim();

    // If toggling is_active=false, refuse on the default godown — there
    // must always be exactly one active default (otherwise bill forms
    // have nothing to pre-fill and stock movements lose their landing pad).
    if (updates.is_active === false && row.is_default) {
      return res.status(400).json({ error: 'Cannot deactivate the default godown' });
    }

    await row.update(updates);
    res.json(row);
  } catch (err) {
    console.error('[godown.update]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Atomically swap which godown is the default. Two-step inside a
 * transaction:
 *   1. Clear is_default on every godown.
 *   2. Set is_default=true on the target.
 * The partial unique index on is_default WHERE is_default=true would
 * reject a naive UPDATE that briefly leaves two defaults. Doing the
 * clear in step 1 dodges that.
 */
exports.setDefault = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const target = await Godown.findByPk(req.params.id, { transaction: t });
    if (!target) {
      await t.rollback();
      return res.status(404).json({ error: 'Godown not found' });
    }
    if (!target.is_active) {
      await t.rollback();
      return res.status(400).json({ error: 'Cannot make an inactive godown the default' });
    }
    await Godown.update(
      { is_default: false },
      { where: { is_default: true }, transaction: t },
    );
    await target.update({ is_default: true }, { transaction: t });
    await t.commit();
    res.json(target);
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('[godown.setDefault]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Hard-delete a godown. Refuses when:
 *   - The godown is the default.
 *   - The godown is_system (the seeded Main).
 *   - There is non-zero stock in product_godown_stock.
 *   - The godown is referenced by any bill or stock movement.
 *
 * For godowns with history, soft-delete (PUT is_active=false) is the
 * supported path. The UI's "Delete" button calls this; if it returns
 * 400 with one of these reasons, the UI can offer the soft-delete
 * fallback.
 */
exports.delete = async (req, res) => {
  try {
    const row = await Godown.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Godown not found' });

    if (row.is_default) {
      return res.status(400).json({ error: 'Cannot delete the default godown. Set another godown as default first.' });
    }
    if (row.is_system) {
      return res.status(400).json({ error: 'Cannot delete a system godown.' });
    }

    // Stock check — sum across all products at this godown.
    const stockSum = await ProductGodownStock.sum('current_stock', {
      where: { godown_id: row.godown_id },
    });
    if (stockSum && parseFloat(stockSum) > 0) {
      return res.status(400).json({
        error: `Godown has ${stockSum} unit(s) of stock. Transfer it out before deleting, or deactivate (soft-delete) instead.`,
      });
    }

    // Reference checks — bills + ledger rows + transfers.
    const checks = [
      [SalesBill,        'godown_id',          'sales bill'],
      [PurchaseBill,     'godown_id',          'purchase bill'],
      [SalesReturnBill,  'godown_id',          'sales return'],
      [PurchaseReturnBill,'godown_id',         'purchase return'],
      [StockLedger,      'godown_id',          'stock movement'],
    ];
    for (const [Model, field, label] of checks) {
      const count = await Model.count({ where: { [field]: row.godown_id } });
      if (count > 0) {
        return res.status(400).json({
          error: `Godown is referenced by ${count} ${label}(s). Deactivate instead of deleting.`,
        });
      }
    }
    const transferCount = await StockTransfer.count({
      where: { [Op.or]: [{ from_godown_id: row.godown_id }, { to_godown_id: row.godown_id }] },
    });
    if (transferCount > 0) {
      return res.status(400).json({
        error: `Godown is referenced by ${transferCount} stock transfer(s). Deactivate instead of deleting.`,
      });
    }

    await row.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error('[godown.delete]', err);
    res.status(500).json({ error: err.message });
  }
};
