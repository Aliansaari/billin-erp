const bcrypt = require('bcryptjs');
const { SystemSettings, BarcodeSettings, User, Role } = require('../models');

exports.getSystemSettings = async (req, res) => {
  try {
    let settings = await SystemSettings.findByPk(1);
    if (!settings) {
      settings = await SystemSettings.create({ setting_id: 1, company_name: 'My Company' });
    }
    res.json({ data: settings });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateSystemSettings = async (req, res) => {
  try {
    let settings = await SystemSettings.findByPk(1);
    if (!settings) {
      settings = await SystemSettings.create({ setting_id: 1, ...req.body });
    } else {
      await settings.update(req.body);
    }
    res.json({ data: settings });
  } catch (error) {
    console.error('Settings update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getBarcodeSettings = async (req, res) => {
  try {
    const settings = await BarcodeSettings.findByPk(1);
    res.json({ data: settings });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateBarcodeSettings = async (req, res) => {
  try {
    const settings = await BarcodeSettings.findByPk(1);
    if (!settings) return res.status(404).json({ error: 'Barcode settings not found' });
    await settings.update(req.body);
    res.json({ data: settings });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

// User Management
exports.getUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      include: [{ model: Role }],
      attributes: { exclude: ['password_hash'] },
      order: [['full_name', 'ASC']],
    });
    res.json({ data: users });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.createUser = async (req, res) => {
  try {
    const { password, ...data } = req.body;
    data.password_hash = await bcrypt.hash(password, 10);
    data.created_by = req.user.user_id;
    const user = await User.create(data);
    const result = await User.findByPk(user.user_id, {
      include: [{ model: Role }],
      attributes: { exclude: ['password_hash'] },
    });
    res.status(201).json(result);
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password, ...data } = req.body;
    if (password) data.password_hash = await bcrypt.hash(password, 10);
    await user.update(data);
    const result = await User.findByPk(user.user_id, {
      include: [{ model: Role }],
      attributes: { exclude: ['password_hash'] },
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.username === 'admin') return res.status(400).json({ error: 'Cannot delete admin user' });
    await user.update({ is_active: false });
    res.json({ message: 'User deactivated' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getRoles = async (req, res) => {
  try {
    const roles = await Role.findAll({ order: [['role_id', 'ASC']] });
    res.json({ data: roles });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.cleanupData = async (req, res) => {
  const db = require('../config/database');
  const t = await db.transaction();
  try {
    const { categories } = req.body; // array of strings
    if (!Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: 'No categories selected' });
    }

    const del = (sql) => db.query(sql, { transaction: t });

    // ── Sales ──────────────────────────────────────────────
    if (categories.includes('sales')) {
      await del('DELETE FROM sales_bill_items');
      await del('DELETE FROM sales_bills');
      await del("UPDATE parties SET current_balance = 0 WHERE party_type IN ('Customer','Both')");
    }

    // ── Purchases ─────────────────────────────────────────
    if (categories.includes('purchases')) {
      await del('DELETE FROM purchase_bill_items');
      await del('DELETE FROM purchase_bills');
      await del("UPDATE parties SET current_balance = 0 WHERE party_type IN ('Supplier','Both')");
    }

    // ── Payments & Receipts ───────────────────────────────
    if (categories.includes('payments')) {
      await del('DELETE FROM payments');
    }

    // ── Stock Ledger (history only) ───────────────────────
    if (categories.includes('stock_ledger')) {
      await del('DELETE FROM stock_ledger');
      await del('UPDATE products SET current_stock = 0');
    }

    // ── Products (requires stock_ledger cleared first) ────
    if (categories.includes('products')) {
      await del('DELETE FROM stock_ledger');
      await del('DELETE FROM products');
    }

    // ── Parties ───────────────────────────────────────────
    if (categories.includes('parties')) {
      await del('DELETE FROM payments');
      await del('DELETE FROM sales_bill_items');
      await del('DELETE FROM sales_bills');
      await del('DELETE FROM purchase_bill_items');
      await del('DELETE FROM purchase_bills');
      await del('DELETE FROM parties');
    }

    // ── Categories ────────────────────────────────────────
    if (categories.includes('categories')) {
      await del('UPDATE products SET category_id = NULL');
      await del('DELETE FROM categories');
    }

    await t.commit();
    res.json({ success: true, message: 'Selected data deleted successfully' });
  } catch (error) {
    await t.rollback();
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message || 'Cleanup failed' });
  }
};
