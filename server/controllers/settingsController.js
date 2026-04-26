const bcrypt = require('bcryptjs');
const { SystemSettings, BarcodeSettings, User, Role } = require('../models');

// Find the role_id for 'Admin' (cached after first lookup).
let ADMIN_ROLE_ID_CACHE = null;
const getAdminRoleId = async () => {
  if (ADMIN_ROLE_ID_CACHE != null) return ADMIN_ROLE_ID_CACHE;
  const adminRole = await Role.findOne({ where: { role_name: 'Admin' } });
  ADMIN_ROLE_ID_CACHE = adminRole ? adminRole.role_id : null;
  return ADMIN_ROLE_ID_CACHE;
};

// Count active Admin users excluding a specific user_id (used to detect last-admin scenarios).
const countOtherActiveAdmins = async (excludeUserId) => {
  const adminRoleId = await getAdminRoleId();
  if (!adminRoleId) return 0;
  const { Op } = require('sequelize');
  return User.count({
    where: {
      role_id: adminRoleId,
      is_active: true,
      user_id: { [Op.ne]: excludeUserId },
    },
  });
};

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
    const { password, password_hash, ...data } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!data.username || !data.username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!data.full_name || !data.full_name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    // Never accept a client-supplied password_hash — always hash the plaintext.
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
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Strip fields the client must NOT be able to set directly.
    // - password_hash must only be written via the hashed `password` branch below.
    // - user_id, created_by, last_login are audit fields; never editable through this endpoint.
    const { password, password_hash, user_id, created_by, last_login,
            created_date, modified_date, createdAt, updatedAt, ...data } = req.body;

    // Username is immutable once created — allowing it to change would break
    // audit trails (bills reference created_by, and login reuses username).
    if (Object.prototype.hasOwnProperty.call(data, 'username') && data.username !== user.username) {
      return res.status(400).json({ error: 'Username cannot be changed' });
    }
    delete data.username;

    const adminRoleId = await getAdminRoleId();
    const isSelfEdit = req.user.user_id === user.user_id;
    const isDemotingFromAdmin =
      user.role_id === adminRoleId &&
      Object.prototype.hasOwnProperty.call(data, 'role_id') &&
      parseInt(data.role_id) !== adminRoleId;
    const isDeactivating =
      user.is_active === true &&
      Object.prototype.hasOwnProperty.call(data, 'is_active') &&
      data.is_active === false;

    // The built-in 'admin' account is the bootstrap account — it must always
    // remain an active Admin. Without this guard, a firm could lock itself out
    // completely by demoting or disabling 'admin', losing all admin access.
    if (user.username === 'admin') {
      if (isDemotingFromAdmin) {
        return res.status(400).json({ error: 'The built-in admin user cannot be demoted' });
      }
      if (isDeactivating) {
        return res.status(400).json({ error: 'The built-in admin user cannot be deactivated' });
      }
    }

    // Prevent a currently-signed-in admin from accidentally demoting or
    // deactivating themselves — that session would still work until the token
    // expires, but the next login would fail.
    if (isSelfEdit) {
      if (isDemotingFromAdmin) {
        return res.status(400).json({ error: 'You cannot change your own admin role. Ask another admin.' });
      }
      if (isDeactivating) {
        return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      }
    }

    // Last-admin lockout: if we are demoting or deactivating the only remaining
    // active Admin, refuse. This protects firms from losing all admin access.
    if (isDemotingFromAdmin || isDeactivating) {
      const others = await countOtherActiveAdmins(user.user_id);
      if (others === 0) {
        return res.status(400).json({
          error: 'Cannot remove the last active admin. Promote another user to Admin first.',
        });
      }
    }

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      data.password_hash = await bcrypt.hash(password, 10);
    }

    await user.update(data);
    const result = await User.findByPk(user.user_id, {
      include: [{ model: Role }],
      attributes: { exclude: ['password_hash'] },
    });
    res.json(result);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.username === 'admin') return res.status(400).json({ error: 'Cannot delete admin user' });

    // Prevent self-deletion — would instantly invalidate the caller's token
    // and leave the UI in a broken state.
    if (req.user.user_id === user.user_id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    // If this is an active admin, make sure at least one other active admin
    // will remain after deactivation (otherwise the firm loses admin access).
    const adminRoleId = await getAdminRoleId();
    if (user.role_id === adminRoleId && user.is_active) {
      const others = await countOtherActiveAdmins(user.user_id);
      if (others === 0) {
        return res.status(400).json({
          error: 'Cannot delete the last active admin. Promote another user to Admin first.',
        });
      }
    }

    await user.update({ is_active: false });
    res.json({ message: 'User deactivated' });
  } catch (error) {
    console.error('Delete user error:', error);
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

  // This endpoint irreversibly deletes financial data. Even though the route
  // is already Admin-gated, a compromised or shared admin session would wipe
  // the firm's books. Require the admin to re-enter their password AND type
  // an explicit confirmation phrase server-side.
  const ALLOWED_CATEGORIES = new Set([
    'sales', 'purchases', 'sales_returns', 'purchase_returns',
    'payments', 'journal_vouchers', 'stock_ledger', 'products',
    'parties', 'categories',
  ]);

  try {
    const { categories, password, confirmation } = req.body;

    if (!Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: 'No categories selected' });
    }

    // Reject any category name not in the allow-list — prevents a tampered
    // client from sending a SQL-ish string or an unsupported category.
    const invalid = categories.filter((c) => !ALLOWED_CATEGORIES.has(c));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Unknown category: ${invalid.join(', ')}` });
    }

    if (typeof confirmation !== 'string' || confirmation.trim().toUpperCase() !== 'DELETE') {
      return res.status(400).json({
        error: 'Please type DELETE to confirm this destructive operation',
      });
    }

    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Admin password is required' });
    }

    // Re-verify the caller's password — protects against stolen/shared sessions.
    const me = await User.findByPk(req.user.user_id);
    if (!me) return res.status(403).json({ error: 'Access denied' });
    const ok = await bcrypt.compare(password, me.password_hash);
    if (!ok) {
      return res.status(403).json({ error: 'Incorrect password' });
    }
  } catch (error) {
    console.error('Cleanup pre-check error:', error);
    return res.status(500).json({ error: 'Server error' });
  }

  const t = await db.transaction();
  try {
    const { categories } = req.body;
    const del = (sql) => db.query(sql, { transaction: t });

    // ── Sales ──────────────────────────────────────────────
    // IMPORTANT: payment_splits FK is `transaction_id` and receipts discriminator
    // column is `transaction_type` (NOT payment_id / payment_type — those columns
    // don't exist and the old SQL crashed mid-cleanup, leaving orphaned data).
    if (categories.includes('sales')) {
      await del('DELETE FROM stock_ledger WHERE transaction_type = \'Sales\'');
      await del("DELETE FROM ledger_entries WHERE source_type IN ('sales_bill','sales_bill_receipt','sales_return_bill')");
      await del('DELETE FROM sales_return_bill_items');
      await del('DELETE FROM sales_return_bills');
      await del('DELETE FROM sales_bill_items');
      await del('DELETE FROM sales_bills');
      // Also drop payment splits / receipts tied to sales — leaving them would
      // reference bills that no longer exist, breaking ledger reports.
      await del("DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_type = 'Receipt')");
      await del("DELETE FROM payments_receipts WHERE transaction_type = 'Receipt'");
      // Rebuild customer balances from remaining bills + opening balance instead
      // of zeroing them (a supplier who is also a customer keeps their supplier side).
      await del(`
        UPDATE parties p SET current_balance =
          CASE WHEN p.opening_balance_type = 'Payable'
               THEN -COALESCE(p.opening_balance, 0)
               ELSE  COALESCE(p.opening_balance, 0) END
          - COALESCE((
            SELECT SUM(pb.balance_amount) FROM purchase_bills pb
            WHERE pb.supplier_id = p.party_id AND pb.is_cancelled = false
          ), 0)
          + COALESCE((
            SELECT SUM(pr.total_amount) FROM payments_receipts pr
            WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Payment'
              AND pr.is_cancelled = false
          ), 0)
        WHERE p.party_type IN ('Customer','Both','Supplier')
      `);
    }

    // ── Purchases ─────────────────────────────────────────
    if (categories.includes('purchases')) {
      await del('DELETE FROM stock_ledger WHERE transaction_type = \'Purchase\'');
      await del("DELETE FROM ledger_entries WHERE source_type IN ('purchase_bill','purchase_bill_payment','purchase_return_bill')");
      await del('DELETE FROM purchase_return_bill_items');
      await del('DELETE FROM purchase_return_bills');
      await del('DELETE FROM purchase_bill_items');
      await del('DELETE FROM purchase_bills');
      await del("DELETE FROM payment_splits WHERE transaction_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_type = 'Payment')");
      await del("DELETE FROM payments_receipts WHERE transaction_type = 'Payment'");
      await del(`
        UPDATE parties p SET current_balance =
          CASE WHEN p.opening_balance_type = 'Payable'
               THEN -COALESCE(p.opening_balance, 0)
               ELSE  COALESCE(p.opening_balance, 0) END
          + COALESCE((
            SELECT SUM(sb.balance_amount) FROM sales_bills sb
            WHERE sb.customer_id = p.party_id AND sb.is_cancelled = false
          ), 0)
          - COALESCE((
            SELECT SUM(pr.total_amount) FROM payments_receipts pr
            WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Receipt'
              AND pr.is_cancelled = false
          ), 0)
        WHERE p.party_type IN ('Supplier','Both','Customer')
      `);
    }

    // ── Sales Returns (only) ──────────────────────────────
    // Deletes return notes + their stock movements; sales bills stay.
    // Customer balance is rebuilt because the return's refund_amount
    // had been credited to the customer's running balance.
    if (categories.includes('sales_returns')) {
      await del("DELETE FROM stock_ledger WHERE transaction_type = 'Sales Return'");
      await del("DELETE FROM ledger_entries WHERE source_type = 'sales_return_bill'");
      await del('DELETE FROM sales_return_bill_items');
      await del('DELETE FROM sales_return_bills');
      await del(`
        UPDATE parties p SET current_balance =
          CASE WHEN p.opening_balance_type = 'Payable'
               THEN -COALESCE(p.opening_balance, 0)
               ELSE  COALESCE(p.opening_balance, 0) END
          + COALESCE((
            SELECT SUM(sb.balance_amount) FROM sales_bills sb
            WHERE sb.customer_id = p.party_id AND sb.is_cancelled = false
          ), 0)
          - COALESCE((
            SELECT SUM(pb.balance_amount) FROM purchase_bills pb
            WHERE pb.supplier_id = p.party_id AND pb.is_cancelled = false
          ), 0)
          + COALESCE((
            SELECT SUM(pr.total_amount) FROM payments_receipts pr
            WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Payment'
              AND pr.is_cancelled = false
          ), 0)
          - COALESCE((
            SELECT SUM(pr.total_amount) FROM payments_receipts pr
            WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Receipt'
              AND pr.is_cancelled = false
          ), 0)
      `);
    }

    // ── Purchase Returns (only) ───────────────────────────
    if (categories.includes('purchase_returns')) {
      await del("DELETE FROM stock_ledger WHERE transaction_type = 'Purchase Return'");
      await del("DELETE FROM ledger_entries WHERE source_type = 'purchase_return_bill'");
      await del('DELETE FROM purchase_return_bill_items');
      await del('DELETE FROM purchase_return_bills');
      await del(`
        UPDATE parties p SET current_balance =
          CASE WHEN p.opening_balance_type = 'Payable'
               THEN -COALESCE(p.opening_balance, 0)
               ELSE  COALESCE(p.opening_balance, 0) END
          + COALESCE((
            SELECT SUM(sb.balance_amount) FROM sales_bills sb
            WHERE sb.customer_id = p.party_id AND sb.is_cancelled = false
          ), 0)
          - COALESCE((
            SELECT SUM(pb.balance_amount) FROM purchase_bills pb
            WHERE pb.supplier_id = p.party_id AND pb.is_cancelled = false
          ), 0)
          + COALESCE((
            SELECT SUM(pr.total_amount) FROM payments_receipts pr
            WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Payment'
              AND pr.is_cancelled = false
          ), 0)
          - COALESCE((
            SELECT SUM(pr.total_amount) FROM payments_receipts pr
            WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Receipt'
              AND pr.is_cancelled = false
          ), 0)
      `);
    }

    // ── Payments & Receipts ───────────────────────────────
    if (categories.includes('payments')) {
      await del("DELETE FROM ledger_entries WHERE source_type IN ('payment_receipt','sales_bill_receipt','purchase_bill_payment')");
      await del('DELETE FROM payment_splits');
      await del('DELETE FROM payments_receipts');
      // Rebuild party balances from remaining bills + opening balance — otherwise
      // removing receipts would leave the cached current_balance stale AND would
      // lose the opening balance component (critical for firms migrating in).
      await del(`
        UPDATE parties p SET current_balance =
          CASE WHEN p.opening_balance_type = 'Payable'
               THEN -COALESCE(p.opening_balance, 0)
               ELSE  COALESCE(p.opening_balance, 0) END
          + COALESCE((
            SELECT SUM(sb.balance_amount) FROM sales_bills sb
            WHERE sb.customer_id = p.party_id AND sb.is_cancelled = false
          ), 0)
          - COALESCE((
            SELECT SUM(pb.balance_amount) FROM purchase_bills pb
            WHERE pb.supplier_id = p.party_id AND pb.is_cancelled = false
          ), 0)
      `);
    }

    // ── Journal Vouchers ──────────────────────────────────
    // Drops the JV header rows and their corresponding ledger_entries.
    // Opening-balance JVs (source_type='party_opening') are NOT touched
    // here — they're tied to the parties scope.
    if (categories.includes('journal_vouchers')) {
      await del("DELETE FROM ledger_entries WHERE source_type = 'journal_voucher'");
      await del('DELETE FROM journal_vouchers');
    }

    // ── Stock Ledger (history only) ───────────────────────
    if (categories.includes('stock_ledger')) {
      await del('DELETE FROM stock_ledger');
      await del('UPDATE products SET current_stock = opening_stock');
    }

    // ── Products (requires stock_ledger cleared first) ────
    if (categories.includes('products')) {
      // Dropping products invalidates every bill line that references them.
      // Do a full financial wipe for safety, not just bill_items.
      await del('DELETE FROM stock_ledger');
      await del("DELETE FROM ledger_entries WHERE source_type IN ('sales_bill','sales_bill_receipt','sales_return_bill','purchase_bill','purchase_bill_payment','purchase_return_bill')");
      await del('DELETE FROM sales_return_bill_items');
      await del('DELETE FROM sales_return_bills');
      await del('DELETE FROM sales_bill_items');
      await del('DELETE FROM sales_bills');
      await del('DELETE FROM purchase_return_bill_items');
      await del('DELETE FROM purchase_return_bills');
      await del('DELETE FROM purchase_bill_items');
      await del('DELETE FROM purchase_bills');
      await del('DELETE FROM products');
    }

    // ── Parties ───────────────────────────────────────────
    // Nuking parties cascades to everything ledger-related: opening JVs,
    // journal vouchers, and every ledger_entries row.
    if (categories.includes('parties')) {
      await del('DELETE FROM payment_splits');
      await del('DELETE FROM payments_receipts');
      await del('DELETE FROM ledger_entries');
      await del('DELETE FROM journal_vouchers');
      // Null the FK first so dropping ledger_accounts doesn't leave dangling
      // references on parties rows that survive (none should — parties are
      // deleted below — but defensive against future schema changes).
      await del('UPDATE parties SET ledger_account_id = NULL');
      await del('DELETE FROM ledger_accounts WHERE is_party_ledger = true');
      await del('DELETE FROM sales_return_bill_items');
      await del('DELETE FROM sales_return_bills');
      await del('DELETE FROM sales_bill_items');
      await del('DELETE FROM sales_bills');
      await del('DELETE FROM purchase_return_bill_items');
      await del('DELETE FROM purchase_return_bills');
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
    // Guard against double-rollback — Sequelize throws "Transaction cannot be
    // rolled back because it has been finished with state: rollback" if an
    // early branch already rolled back and a subsequent res.json() fails.
    if (!t.finished) {
      try { await t.rollback(); } catch (_) { /* already finished */ }
    }
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message || 'Cleanup failed' });
  }
};
