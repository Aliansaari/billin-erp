const { Op } = require('sequelize');
const { Category, Product, PurchaseBillItem, SalesBillItem, PurchaseReturnBillItem, SalesReturnBillItem } = require('../models');

// Whitelist of fields clients may send via POST/PUT. Blocks clients from
// setting category_id directly or tampering with columns we may add later.
const CATEGORY_UPDATABLE_FIELDS = [
  'category_name', 'parent_category_id', 'category_code', 'is_active',
];

/**
 * Walk the ancestor chain of `parentId` to detect whether it includes
 * `candidateId`. Used to prevent cycles in the category tree (e.g.
 * making B a child of A when A is already a descendant of B).
 *
 * Returns true if assigning parentId as parent of candidateId would create a cycle.
 */
async function wouldCreateCycle(candidateId, parentId) {
  if (!parentId) return false;
  // Normalise to integers so the `visited` Set compares by value consistently.
  // Postgres returns INT columns as numbers from Sequelize, but a stray string
  // from req.body or a migration quirk would otherwise make visited.has() miss
  // same-value-different-type entries (5 !== "5" in a Set).
  const target = parseInt(candidateId, 10);
  let current = parseInt(parentId, 10);
  if (isNaN(target) || isNaN(current)) return false;
  const visited = new Set();
  // Walk upward at most depth = existing tree depth. Guard against infinite
  // loops from pre-existing corruption with a 100-hop cap.
  for (let i = 0; i < 100 && current; i++) {
    if (current === target) return true;
    if (visited.has(current)) return true; // pre-existing cycle
    visited.add(current);
    const row = await Category.findByPk(current, { attributes: ['parent_category_id'] });
    const next = row?.parent_category_id;
    current = next != null ? parseInt(next, 10) : null;
    if (current !== null && isNaN(current)) current = null;
  }
  return false;
}

exports.getAll = async (req, res) => {
  try {
    // Active-only by default. Deactivated rows must not appear in the
    // tree — otherwise the UI shows a "deleted" category as if delete
    // had failed. Both the top-level rows AND the nested subCategories
    // include filter by is_active. The include is `required: false`
    // (LEFT JOIN) so a top-level cat with no active sub-cats still
    // shows up.
    const categories = await Category.findAll({
      where: { parent_category_id: null, is_active: true },
      include: [{
        model: Category,
        as: 'subCategories',
        where: { is_active: true },
        required: false,
      }],
      order: [['category_name', 'ASC']],
    });
    res.json(categories);
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAllFlat = async (req, res) => {
  try {
    const categories = await Category.findAll({
      where: { is_active: true },
      order: [['category_name', 'ASC']],
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const { parent_category_id, category_name } = req.body;
    // If a parent is specified, it must exist and be active. A newly-created
    // category cannot hang off a deactivated parent — that would orphan it
    // from the active tree.
    if (parent_category_id) {
      const parent = await Category.findByPk(parent_category_id);
      if (!parent) {
        return res.status(400).json({ error: 'Parent category does not exist' });
      }
      if (!parent.is_active) {
        return res.status(400).json({ error: 'Parent category is inactive' });
      }
    }

    // Inactive-ghost reclaim. The unique index on category_name doesn't
    // distinguish active vs inactive rows, so a previously-soft-deleted
    // category with the same name would otherwise block the create with
    // "name already exists" — confusing because the user can't see it.
    // If we find one, reactivate it (in place) so the user gets the row
    // they expected without a fresh insert. Any new fields from req.body
    // are applied so this acts like an upsert.
    if (category_name) {
      // Case-insensitive lookup so "Frock" matches a ghost stored as
      // "frock" — the unique index is case-sensitive but reusing the
      // ghost row regardless of casing matches user expectation.
      const ghost = await Category.findOne({
        where: { category_name: { [Op.iLike]: category_name }, is_active: false },
      });
      if (ghost) {
        const safe = { is_active: true };
        for (const k of CATEGORY_UPDATABLE_FIELDS) {
          if (req.body[k] !== undefined) safe[k] = req.body[k];
        }
        await ghost.update(safe);
        return res.status(201).json(ghost);
      }
    }

    const safe = {};
    for (const k of CATEGORY_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    const category = await Category.create(safe);
    res.status(201).json(category);
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    // Parent-category validation. Only re-check if the caller is actually
    // changing the parent — otherwise we'd needlessly fail edits that only
    // touch the name or description.
    if (Object.prototype.hasOwnProperty.call(req.body, 'parent_category_id')) {
      const newParent = req.body.parent_category_id;

      // Self-parenting guard. Fast, explicit, happens before the recursive
      // walk so a misclick in the UI produces a clean error.
      if (newParent != null && parseInt(newParent) === parseInt(req.params.id)) {
        return res.status(400).json({ error: 'A category cannot be its own parent' });
      }

      if (newParent) {
        const parent = await Category.findByPk(newParent);
        if (!parent) {
          return res.status(400).json({ error: 'Parent category does not exist' });
        }
        if (!parent.is_active) {
          return res.status(400).json({ error: 'Parent category is inactive' });
        }
        // Deep cycle check: moving A under B is illegal if B is already a
        // descendant of A. Without this, the tree becomes a graph with a
        // loop and any recursive render/query will hang.
        if (await wouldCreateCycle(req.params.id, newParent)) {
          return res.status(400).json({
            error: 'Cannot set parent — it would create a cycle in the category tree',
          });
        }
      }
    }

    const safe = {};
    for (const k of CATEGORY_UPDATABLE_FIELDS) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    await category.update(safe);
    res.json(category);
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.delete = async (req, res) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    // Anything pointing at this category — across products (any state),
    // sub-categories (any state), and historical bill-item snapshots.
    // We need this for both the FK-safety check below AND the hard-vs-
    // soft delete decision. Bill-item categories are denormalised
    // snapshots taken at sale time (so historical reports stay correct
    // when a category is later renamed) — they FK back to categories.
    const productCount = await Product.count({ where: { category_id: req.params.id } });
    const subCount     = await Category.count({ where: { parent_category_id: req.params.id } });
    const subActive    = await Category.count({ where: { parent_category_id: req.params.id, is_active: true } });
    // Bill-item snapshots that FK back to categories. NOTE: purchase_bill_items
    // only stores category_name (no category_id column on that table) so we
    // skip it here — there's no FK to violate.
    const itemCount    =
      (await SalesBillItem.count({           where: { category_id: req.params.id } })) +
      (await PurchaseReturnBillItem.count({ where: { category_id: req.params.id } })) +
      (await SalesReturnBillItem.count({    where: { category_id: req.params.id } }));

    // Block: real transactions on products in this category.
    if (productCount > 0) {
      const productIds = (await Product.findAll({
        where: { category_id: req.params.id }, attributes: ['product_id'], raw: true,
      })).map(p => p.product_id);
      const purchaseCount = await PurchaseBillItem.count({ where: { product_id: productIds } });
      const salesCount    = await SalesBillItem.count({   where: { product_id: productIds } });
      const txCount = purchaseCount + salesCount;
      if (txCount > 0) {
        return res.status(400).json({
          error: `Cannot deactivate "${category.category_name}" — it has ${productCount} product(s) with ${txCount} transaction(s). Reassign or deactivate the products first.`,
        });
      }
    }

    // Block: active sub-categories (matches the original guard).
    if (subActive > 0) {
      return res.status(400).json({
        error: `Cannot deactivate "${category.category_name}" — it has ${subActive} active sub-categorie(s). Deactivate them first.`,
      });
    }

    // Hard-delete path: nothing references this row at all (no products,
    // no sub-categories of any state, no historical bill items). Frees
    // the unique-name slot so a fresh "Frock" can be created later
    // without colliding with an inactive ghost.
    if (productCount === 0 && subCount === 0 && itemCount === 0) {
      await category.destroy();
      return res.json({ message: 'Category deleted' });
    }

    // Soft-delete fallback: something still references the row, so we
    // can't DELETE without an FK violation. Mark inactive instead. The
    // category will hide from the picker (getAll filters by is_active)
    // but the FK targets stay valid.
    await category.update({ is_active: false });
    res.json({ message: 'Category deactivated' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
