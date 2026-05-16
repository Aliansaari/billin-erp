// ── ProductColor Controller ─────────────────────────────────────
//
// CRUD for the per-product color list. Endpoints:
//
//   GET    /api/products/:productId/colors      — list (active by
//                                                  default; ?include_inactive=1)
//   POST   /api/products/:productId/colors      — add a single color
//   PUT    /api/products/:productId/colors/:id  — rename / opening / threshold
//   DELETE /api/products/:productId/colors/:id  — soft or hard delete
//
//   POST   /api/products/:productId/colors/bulk — replace the entire
//                                                  color list (used by
//                                                  the product form).
//
// Lifecycle invariants the controller enforces:
//   • Add: deduped against existing rows by (product_id, color_name)
//     (case-insensitive).
//   • Rename: just updates color_name; bill items ride along via
//     color_id FK.
//   • Delete:
//       current_stock > 0           → 400 (block, hard rule)
//       0 stock + has bill history  → soft (is_active=false)
//       0 stock + no history        → hard delete
//   • Color rows are only meaningful when products.color_mode='multi'.
//     Other modes ignore the table; the controller doesn't gate on it
//     so the operator can set up colors before flipping the mode.

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const {
  Product, ProductColor, SalesBillItem, PurchaseBillItem,
} = require('../models');
const { roundTo } = require('../utils/helpers');

// Audit MONEY-4 — use canonical roundTo (Indian GST-standard).
const r2 = (n) => roundTo(Number(n) || 0, 2);

async function ensureProduct(productId) {
  const p = await Product.findByPk(productId);
  if (!p) {
    const err = new Error('Product not found');
    err.status = 404;
    throw err;
  }
  return p;
}

async function hasHistory(colorId, transaction) {
  const used = await Promise.all([
    SalesBillItem.count({ where: { color_id: colorId }, transaction }),
    PurchaseBillItem.count({ where: { color_id: colorId }, transaction }),
  ]);
  return used.some((n) => n > 0);
}

exports.list = async (req, res) => {
  try {
    const { productId } = req.params;
    const { include_inactive } = req.query || {};
    const where = { product_id: productId };
    if (!include_inactive || include_inactive === 'false') where.is_active = true;
    const rows = await ProductColor.findAll({
      where,
      order: [['color_name', 'ASC']],
    });
    res.json({ data: rows });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('productColor list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const { productId } = req.params;
    await ensureProduct(productId);
    const { color_name, opening_stock, low_stock_alert } = req.body || {};
    const name = (color_name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'Color name is required.' });

    // Case-insensitive uniqueness check (the unique index is exact-case;
    // we add a soft case-insensitive guard at the controller so "Red" and
    // "red" don't both end up in the master).
    const existing = await ProductColor.findOne({
      where: {
        product_id: productId,
        color_name: { [Op.iLike]: name },
        is_active: true,
      },
    });
    if (existing) {
      return res.status(400).json({ error: `Color "${existing.color_name}" already exists for this product.` });
    }

    const opening = r2(opening_stock);
    const row = await ProductColor.create({
      product_id: productId,
      color_name: name.slice(0, 50),
      opening_stock: opening,
      current_stock: opening,
      low_stock_alert: low_stock_alert != null ? r2(low_stock_alert) : null,
      is_active: true,
    });
    res.status(201).json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Color already exists for this product.' });
    }
    console.error('productColor create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const { productId, id } = req.params;
    const row = await ProductColor.findOne({
      where: { color_id: id, product_id: productId },
    });
    if (!row) return res.status(404).json({ error: 'Color not found' });

    const { color_name, low_stock_alert, opening_stock, is_active } = req.body || {};
    const patch = {};
    if (color_name != null) {
      const name = String(color_name).trim().slice(0, 50);
      if (!name) return res.status(400).json({ error: 'Color name cannot be empty.' });
      // Case-insensitive uniqueness, excluding self
      const dupe = await ProductColor.findOne({
        where: {
          product_id: productId,
          color_name: { [Op.iLike]: name },
          color_id: { [Op.ne]: id },
        },
      });
      if (dupe) return res.status(400).json({ error: `Color "${dupe.color_name}" already exists.` });
      patch.color_name = name;
    }
    if (low_stock_alert !== undefined) {
      patch.low_stock_alert = low_stock_alert == null || low_stock_alert === ''
        ? null : r2(low_stock_alert);
    }
    // opening_stock is editable only while there's no billing history
    // — otherwise we'd be retroactively changing the audited starting
    // point. current_stock follows opening_stock in lockstep when we
    // allow the edit.
    if (opening_stock !== undefined) {
      const histed = await hasHistory(row.color_id);
      if (histed) {
        return res.status(400).json({
          error: 'Opening stock cannot be edited once bills reference this color. Adjust via stock adjustment instead.',
        });
      }
      const v = r2(opening_stock);
      patch.opening_stock = v;
      patch.current_stock = v;
    }
    if (is_active != null) patch.is_active = !!is_active;

    await row.update(patch);
    res.json(row);
  } catch (err) {
    console.error('productColor update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.remove = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { productId, id } = req.params;
    const row = await ProductColor.findOne({
      where: { color_id: id, product_id: productId },
      transaction: t,
    });
    if (!row) {
      await t.rollback();
      return res.status(404).json({ error: 'Color not found' });
    }
    if (Number(row.current_stock) > 0) {
      await t.rollback();
      return res.status(400).json({
        error: `Cannot delete "${row.color_name}" — current stock is ${row.current_stock}. Adjust to 0 first.`,
      });
    }
    const histed = await hasHistory(row.color_id, t);
    if (histed) {
      // Soft delete — keep the row for historical references on bills
      await row.update({ is_active: false }, { transaction: t });
      await t.commit();
      return res.json({ message: 'Color archived (had billing history).', soft: true });
    }
    await row.destroy({ transaction: t });
    await t.commit();
    res.json({ message: 'Color deleted.', hard: true });
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    console.error('productColor remove error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Bulk replace — used by the product form's Save flow when the user
// edits the colors panel as a whole. Diffs against the existing list:
//
//   • New color names get inserted (with the supplied opening / threshold).
//   • Existing names get updated (rename if name changed, threshold edit).
//   • Names removed from the payload trigger the same delete rules
//     above (block / soft / hard).
exports.bulkReplace = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { productId } = req.params;
    await ensureProduct(productId);

    const incoming = Array.isArray(req.body?.colors) ? req.body.colors : [];
    const existing = await ProductColor.findAll({
      where: { product_id: productId, is_active: true },
      transaction: t,
    });
    const byId = new Map(existing.map((c) => [c.color_id, c]));
    const seenIds = new Set();
    const seenNames = new Set();

    // Validate up-front so we don't write half-results
    for (const inc of incoming) {
      const name = String(inc.color_name || '').trim().slice(0, 50);
      if (!name) {
        await t.rollback();
        return res.status(400).json({ error: 'Color name cannot be empty.' });
      }
      const key = name.toLowerCase();
      if (seenNames.has(key)) {
        await t.rollback();
        return res.status(400).json({ error: `Duplicate color "${name}" in the list.` });
      }
      seenNames.add(key);
    }

    // Apply
    for (const inc of incoming) {
      const name = String(inc.color_name).trim().slice(0, 50);
      const opening = r2(inc.opening_stock);
      const threshold = inc.low_stock_alert == null || inc.low_stock_alert === ''
        ? null : r2(inc.low_stock_alert);

      if (inc.color_id && byId.has(inc.color_id)) {
        const row = byId.get(inc.color_id);
        seenIds.add(inc.color_id);
        const patch = {
          color_name: name,
          low_stock_alert: threshold,
        };
        // Only allow opening_stock edit when there's no history yet
        const histed = await hasHistory(row.color_id, t);
        if (!histed) {
          patch.opening_stock = opening;
          patch.current_stock = opening;
        }
        await row.update(patch, { transaction: t });
      } else {
        // New color row
        await ProductColor.create({
          product_id: productId,
          color_name: name,
          opening_stock: opening,
          current_stock: opening,
          low_stock_alert: threshold,
          is_active: true,
        }, { transaction: t });
      }
    }

    // Delete (or soft-delete) anything not in the incoming list
    for (const row of existing) {
      if (seenIds.has(row.color_id)) continue;
      if (Number(row.current_stock) > 0) {
        await t.rollback();
        return res.status(400).json({
          error: `Cannot remove "${row.color_name}" — current stock is ${row.current_stock}. Adjust to 0 first.`,
        });
      }
      const histed = await hasHistory(row.color_id, t);
      if (histed) {
        await row.update({ is_active: false }, { transaction: t });
      } else {
        await row.destroy({ transaction: t });
      }
    }

    await t.commit();
    const fresh = await ProductColor.findAll({
      where: { product_id: productId, is_active: true },
      order: [['color_name', 'ASC']],
    });
    res.json({ data: fresh });
  } catch (err) {
    if (!t.finished) await t.rollback().catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('productColor bulkReplace error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
};
