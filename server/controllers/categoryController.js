const { Category, Product, PurchaseBillItem, SalesBillItem } = require('../models');

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
    const categories = await Category.findAll({
      include: [{ model: Category, as: 'subCategories' }],
      where: { parent_category_id: null },
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
    const { parent_category_id } = req.body;
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

    // Block if any products in this category have transactions
    const products = await Product.findAll({ where: { category_id: req.params.id } });
    if (products.length > 0) {
      const productIds = products.map(p => p.product_id);
      const purchaseCount = await PurchaseBillItem.count({ where: { product_id: productIds } });
      const salesCount    = await SalesBillItem.count({   where: { product_id: productIds } });
      const total = purchaseCount + salesCount;
      if (total > 0) {
        return res.status(400).json({
          error: `Cannot deactivate "${category.category_name}" — it has ${products.length} product(s) with ${total} transaction(s). Reassign or deactivate the products first.`,
        });
      }
    }

    // Also block if category has active sub-categories
    const subCount = await Category.count({ where: { parent_category_id: req.params.id, is_active: true } });
    if (subCount > 0) {
      return res.status(400).json({
        error: `Cannot deactivate "${category.category_name}" — it has ${subCount} active sub-categorie(s). Deactivate them first.`,
      });
    }

    await category.update({ is_active: false });
    res.json({ message: 'Category deactivated' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
