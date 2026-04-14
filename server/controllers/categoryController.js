const { Category, Product, PurchaseBillItem, SalesBillItem } = require('../models');

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
    const category = await Category.create(req.body);
    res.status(201).json(category);
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Category name already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    await category.update(req.body);
    res.json(category);
  } catch (error) {
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
