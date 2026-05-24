const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { SystemSettings, BarcodeSettings, User, Role } = require('../models');
const fmt = require('../utils/indianIdFormats');
const { recordAudit } = require('../utils/auditLog');
const { respondWithError } = require('../utils/helpers');

// Where uploaded logos / signatures live on disk. Set by server boot
// (see server/utils/paths.js). Each company writes into its own
// subdirectory so multi-tenant installs can't cross-load each other's
// branding.
const UPLOADS_DIR = process.env.BILLING_ERP_UPLOADS_DIR || path.join(require('os').homedir(), '.billing-erp', 'uploads');
const BRANDING_DIR = path.join(UPLOADS_DIR, 'branding');
try { fs.mkdirSync(BRANDING_DIR, { recursive: true }); } catch { /* race-safe noop */ }

// Whitelist of acceptable image MIME types for the logo + signature
// uploads. Anything else is rejected at the multer fileFilter so we
// never write executable content to disk.
//
// Audit AUTH-4 — SVG was previously in the allowlist; SVG can carry
// <script> tags and inline `onload=` handlers. Servlets that load the
// branding asset via <object>/<iframe>/inline-<svg> would execute the
// script under the page's origin (stored XSS, every user printing a
// bill is exposed). PNG / JPEG / GIF / WebP cover every real-world
// logo and signature case — drop SVG.
const ALLOWED_BRANDING_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

// Strip every character that could escape the branding directory or
// collide with another file. Final form: timestamp-randomtail.ext, so
// two operators uploading "logo.png" at the same second still get
// distinct files.
function _safeBrandingFilename(originalName, prefix) {
  const ext = (path.extname(originalName || '') || '.png').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const safeExt = ext.length <= 6 ? ext : '.png';
  const tail = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${Date.now()}-${tail}${safeExt}`;
}

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
    respondWithError(res, error);
  }
};

exports.updateSystemSettings = async (req, res) => {
  try {
    let settings = await SystemSettings.findByPk(1);
    // Whitelist cogs_method so a tampered client can't pass garbage that
    // PG would reject AFTER the rest of the update succeeded.
    if (req.body.cogs_method && !['weighted_avg', 'fifo'].includes(req.body.cogs_method)) {
      return res.status(400).json({ error: "cogs_method must be 'weighted_avg' or 'fifo'" });
    }

    // Onboarding-tier format validators (Indian ID + contact fields).
    // Each helper accepts empty/null as valid, so the operator can
    // leave optional fields blank. Failures return 400 with a clean
    // human-readable message so the frontend can show it inline.
    const fieldChecks = [
      ['gstin',             fmt.validateGstin],
      ['pan_number',        fmt.validatePan],
      ['tan_number',        fmt.validateTan],
      ['cin_number',        fmt.validateCin],
      ['company_pincode',   fmt.validatePincode],
      ['company_email',     fmt.validateEmail],
      ['company_phone',     fmt.validateMobile],
      ['company_phone_2',   fmt.validateMobile],
      ['company_state',     fmt.validateState],
      ['bank_ifsc',         fmt.validateIfsc],
      ['bank_account_number', fmt.validateBankAccount],
      ['bank_upi_id',       fmt.validateUpi],
    ];
    for (const [field, check] of fieldChecks) {
      if (req.body[field] !== undefined && req.body[field] !== '') {
        const r = check(req.body[field]);
        if (!r.ok) return res.status(400).json({ error: r.error, field });
      }
    }
    // Normalise mobiles to digits-only so downstream consumers (print
    // templates, WhatsApp share) see a consistent form.
    if (req.body.company_phone) {
      const r = fmt.validateMobile(req.body.company_phone);
      if (r.normalized) req.body.company_phone = r.normalized;
    }
    if (req.body.company_phone_2) {
      const r = fmt.validateMobile(req.body.company_phone_2);
      if (r.normalized) req.body.company_phone_2 = r.normalized;
    }
    // Uppercase IDs that are case-insensitive — operators type lowercase
    // but the printed invoice + GSTR-1 expect uppercase.
    ['gstin', 'pan_number', 'tan_number', 'cin_number', 'bank_ifsc'].forEach((k) => {
      if (req.body[k] && typeof req.body[k] === 'string') {
        req.body[k] = req.body[k].trim().toUpperCase();
      }
    });
    // Snapshot the compliance fields BEFORE the update so we can diff +
    // emit audit-log rows for every change. Captured even when the
    // settings row is being created (rare; defaults from defaultData).
    const complianceFields = [
      'fy_compliance_mode',
      'fy_soft_lock_date',
      'fy_hard_lock_date',
      'fy_require_override_password',
    ];
    const before = settings
      ? Object.fromEntries(complianceFields.map((k) => [k, settings[k] ?? null]))
      : Object.fromEntries(complianceFields.map((k) => [k, null]));

    if (!settings) {
      settings = await SystemSettings.create({ setting_id: 1, ...req.body });
    } else {
      await settings.update(req.body);
    }

    // Audit-log any compliance config change. Best-effort; never blocks
    // the save. Snapshot the user from req.user so the log row carries
    // attribution even if the user is later renamed / deactivated.
    try {
      const after = Object.fromEntries(complianceFields.map((k) => [k, settings[k] ?? null]));
      const complianceChanged = complianceFields.some((k) => String(before[k]) !== String(after[k]));
      if (complianceChanged) {
        const { logSettingsDiff } = require('./complianceController');
        await logSettingsDiff({ before, after, user: req.user });
      }
    } catch (e) {
      console.warn('compliance audit-log write failed:', e?.message || e);
    }

    // Bust the LAN gate's settings cache so dev_lan_enabled /
    // dev_lan_max_clients flips take effect on the very next request,
    // not on the next minute boundary.
    try { require('../middleware/lanGate').invalidateLanGateCache(); } catch {}
    // Same for the back-dated entry guard — operator-facing toggle
    // should take effect on the next save, not in 60 s.
    try { require('../utils/backdatedGuard').invalidateCache(); } catch {}
    // Audit H6 — bust the costLayers in-memory cache so a FIFO/weighted-avg
    // flip from this endpoint takes effect on the very next sale, not 30 s
    // later when the cache naturally expires.
    if (req.body.cogs_method) {
      try { require('../utils/costLayers').refreshCogsCache(); } catch {}
    }
    res.json({ data: settings });
  } catch (error) {
    console.error('Settings update error:', error);
    respondWithError(res, error);
  }
};

exports.getBarcodeSettings = async (req, res) => {
  try {
    const settings = await BarcodeSettings.findByPk(1);
    res.json({ data: settings });
  } catch (error) {
    respondWithError(res, error);
  }
};

exports.updateBarcodeSettings = async (req, res) => {
  try {
    const settings = await BarcodeSettings.findByPk(1);
    if (!settings) return res.status(404).json({ error: 'Barcode settings not found' });
    // Ensure current_number is aligned with starting_number. The barcode
    // generator reads current_number (not starting_number), so if the
    // operator sets starting_number to 29112000 but current_number is 7,
    // barcodes would stay at 00000008. Fix: whenever current_number is
    // behind starting_number, snap it to starting_number − 1 so the next
    // generated barcode equals starting_number.
    const payload = { ...req.body };
    const start = Number(payload.starting_number ?? settings.starting_number);
    const cur   = Number(settings.current_number);
    if (start > 0 && cur < start - 1) {
      payload.current_number = start - 1;
    }
    // Also reset when starting_number explicitly changes (even if cur >= start,
    // the operator clearly wants to restart from the new value).
    if (payload.starting_number != null && Number(payload.starting_number) !== Number(settings.starting_number)) {
      payload.current_number = Number(payload.starting_number) - 1;
    }
    await settings.update(payload);
    res.json({ data: settings });
  } catch (error) {
    respondWithError(res, error);
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
    respondWithError(res, error);
  }
};

exports.createUser = async (req, res) => {
  try {
    const { password, password_hash, ...data } = req.body;
    // AUTH-H5 — unified strong-password check (10+ chars, 3 char classes,
    // common-blocklist, not equal to username). Previously this used a
    // less-strict rule than change-password — admins could seed weaker
    // passwords than the user is later required to rotate to.
    const { checkPasswordStrength } = require('./authController');
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    const ps = checkPasswordStrength(password, { username: data.username });
    if (!ps.ok) {
      return res.status(400).json({ error: ps.reason });
    }
    if (!data.username || !data.username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!data.full_name || !data.full_name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    // Never accept a client-supplied password_hash — always hash the plaintext.
    // AUTH-H6 — bcrypt cost factor 12 (OWASP 2025 recommendation, up from 10).
    data.password_hash = await bcrypt.hash(password, 12);
    data.created_by = req.user.user_id;
    const user = await User.create(data);
    const result = await User.findByPk(user.user_id, {
      include: [{ model: Role }],
      attributes: { exclude: ['password_hash'] },
    });
    // Audit H11 — record user creation in the audit log.
    recordAudit({
      req, action: 'user.create',
      entityType: 'user', entityId: user.user_id,
      after: { username: data.username, full_name: data.full_name, email: data.email, role_id: data.role_id, is_active: data.is_active },
    });
    res.status(201).json(result);
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error('Create user error:', error);
    respondWithError(res, error);
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

    // SER-1 fix: prevent privilege self-escalation. A user editing their own
    // account must never be allowed to change their own role — any role_id in
    // the body is silently stripped. Only an admin editing a DIFFERENT user
    // may change that user's role_id.
    if (isSelfEdit && Object.prototype.hasOwnProperty.call(data, 'role_id')) {
      delete data.role_id;
    }

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
      // AUTH-H5 — unified strong-password check.
      const { checkPasswordStrength } = require('./authController');
      const ps = checkPasswordStrength(password, { username: user.username });
      if (!ps.ok) {
        return res.status(400).json({ error: ps.reason });
      }
      // AUTH-H6 — bcrypt cost 12.
      data.password_hash = await bcrypt.hash(password, 12);
    }

    // Audit H11 — capture before snapshot for the audit log so role/status
    // changes are reconstructable. Password rotations are flagged (the
    // hash itself is redacted).
    const beforeSnap = {
      username: user.username, full_name: user.full_name, email: user.email,
      role_id: user.role_id, is_active: user.is_active,
    };
    await user.update(data);
    const result = await User.findByPk(user.user_id, {
      include: [{ model: Role }],
      attributes: { exclude: ['password_hash'] },
    });
    const afterSnap = {
      username: result.username, full_name: result.full_name, email: result.email,
      role_id: result.role_id, is_active: result.is_active,
      password_rotated: !!password,
    };
    const action = (data.is_active === false && beforeSnap.is_active === true)
      ? 'user.deactivate'
      : (data.is_active === true && beforeSnap.is_active === false)
        ? 'user.activate'
        : 'user.update';
    recordAudit({
      req, action,
      entityType: 'user', entityId: user.user_id,
      before: beforeSnap, after: afterSnap,
    });
    res.json(result);
  } catch (error) {
    console.error('Update user error:', error);
    respondWithError(res, error);
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
    // Audit H11 — record the soft-delete (deactivate).
    recordAudit({
      req, action: 'user.delete',
      entityType: 'user', entityId: user.user_id,
      before: { username: user.username, is_active: true },
      after:  { username: user.username, is_active: false },
      notes: 'Soft-delete (is_active=false)',
    });
    res.json({ message: 'User deactivated' });
  } catch (error) {
    console.error('Delete user error:', error);
    respondWithError(res, error);
  }
};

exports.getRoles = async (req, res) => {
  try {
    const roles = await Role.findAll({ order: [['role_id', 'ASC']] });
    res.json({ data: roles });
  } catch (error) {
    respondWithError(res, error);
  }
};

// Update a role row's capability columns. Currently only the
// `can_enter_backdated` flag is editable from the UI; the other
// legacy booleans (can_view_reports, can_delete_bills, ...) are
// effectively dead since the JSONB permission editor on each user
// overrides them. The endpoint is allow-listed so a crafted client
// can't poke `permissions_json` or `role_name` through this path.
exports.updateRolePolicy = async (req, res) => {
  try {
    const roleId = parseInt(req.params.role_id, 10);
    if (!Number.isFinite(roleId)) {
      return res.status(400).json({ error: 'Invalid role_id' });
    }
    const role = await Role.findByPk(roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    const ALLOWED = ['can_enter_backdated'];
    const updates = {};
    for (const key of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        updates[key] = !!req.body[key];
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No editable fields supplied' });
    }
    await role.update(updates);
    res.json({ data: role });
  } catch (error) {
    console.error('updateRolePolicy error:', error);
    respondWithError(res, error);
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
    return respondWithError(res, error);
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
      // Held sales drafts belong to the sales scope — wiping sales must
      // drop them too, otherwise recalling a draft after a wipe would
      // resurrect product/party references that no longer exist.
      await del('DELETE FROM sales_bill_drafts');
      // Also drop payment splits / receipts tied to sales — leaving them would
      // reference bills that no longer exist, breaking ledger reports.
      // Cheques referencing those splits/receipts must go first; on DBs where
      // the FKs are CASCADE they'd auto-delete, but old installs predate the
      // CASCADE upgrade so we do it explicitly. Idempotent on new schema.
      await del("DELETE FROM cheques WHERE source_payment_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_type = 'Receipt') OR source_payment_split_id IN (SELECT s.split_id FROM payment_splits s JOIN payments_receipts r ON r.transaction_id = s.transaction_id WHERE r.transaction_type = 'Receipt')");
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
              AND (pr.source != 'auto_from_bill' OR pr.source IS NULL)
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
      // Held purchase drafts belong to the purchases scope — see sales
      // scope above for rationale (recalling stale drafts after a wipe).
      await del('DELETE FROM purchase_bill_drafts');
      // Cheques tied to outgoing payments must be dropped before their
      // source rows (see sales branch above for rationale).
      await del("DELETE FROM cheques WHERE source_payment_id IN (SELECT transaction_id FROM payments_receipts WHERE transaction_type = 'Payment') OR source_payment_split_id IN (SELECT s.split_id FROM payment_splits s JOIN payments_receipts r ON r.transaction_id = s.transaction_id WHERE r.transaction_type = 'Payment')");
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
              AND (pr.source != 'auto_from_bill' OR pr.source IS NULL)
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
              AND (pr.source != 'auto_from_bill' OR pr.source IS NULL)
          ), 0)
          - COALESCE((
            SELECT SUM(pr.total_amount) FROM payments_receipts pr
            WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Receipt'
              AND pr.is_cancelled = false
              AND (pr.source != 'auto_from_bill' OR pr.source IS NULL)
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
              AND (pr.source != 'auto_from_bill' OR pr.source IS NULL)
          ), 0)
          - COALESCE((
            SELECT SUM(pr.total_amount) FROM payments_receipts pr
            WHERE pr.party_id = p.party_id AND pr.transaction_type = 'Receipt'
              AND pr.is_cancelled = false
              AND (pr.source != 'auto_from_bill' OR pr.source IS NULL)
          ), 0)
      `);
    }

    // ── Payments & Receipts ───────────────────────────────
    if (categories.includes('payments')) {
      await del("DELETE FROM ledger_entries WHERE source_type IN ('payment_receipt','sales_bill_receipt','purchase_bill_payment')");
      // Cheque register entries are derived from payment_splits / receipts —
      // wipe them first or the FK blocks the cascade on legacy schemas
      // that lack ON DELETE CASCADE on cheques_source_*_fkey.
      await del('DELETE FROM cheques');
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
      // Drafts embed product_ids in their JSONB payload — keeping them
      // around after products are dropped would let a recall pull invalid
      // product references back into a new bill.
      await del('DELETE FROM sales_bill_drafts');
      await del('DELETE FROM purchase_bill_drafts');
      // Stock transfers reference products via their items table; drop
      // the transfers (items CASCADE) before products or the RESTRICT
      // on stock_transfer_items.product_id blocks the wipe.
      await del('DELETE FROM stock_transfers');
      // product_batches and product_colors both FK to products with
      // RESTRICT, and product_batch_stock has an ON DELETE RESTRICT
      // FK to product_batches (NOT cascade — an earlier comment here
      // claimed cascade and was wrong). Wipe per-godown-per-batch
      // stock first or the next DELETE blows up with FK violation.
      // All bill_items / stock_ledger rows referencing these batches
      // were already cleared by the financial wipe above.
      await del('DELETE FROM product_batch_stock');
      await del('DELETE FROM product_batches');
      await del('DELETE FROM product_colors');
      // cost_layers.product_id is FK NO ACTION (no cascade); explicit
      // wipe required before products go, otherwise FIFO/weighted-avg
      // history pins the products table.
      await del('DELETE FROM cost_layers');
      await del('DELETE FROM products');
    }

    // ── Parties ───────────────────────────────────────────
    // Nuking parties cascades to everything ledger-related: opening JVs,
    // journal vouchers, and every ledger_entries row.
    if (categories.includes('parties')) {
      // Same FK-order constraint as the payments branch.
      await del('DELETE FROM cheques');
      await del('DELETE FROM payment_splits');
      await del('DELETE FROM payments_receipts');
      await del('DELETE FROM ledger_entries');
      await del('DELETE FROM journal_vouchers');
      // Drafts reference customer_id/supplier_id (FK now SET NULL) and
      // embed party data in their payload. A full parties wipe means
      // every held draft is now disconnected from the customer/supplier
      // it was held for — drop them rather than leave walk-in orphans.
      await del('DELETE FROM sales_bill_drafts');
      await del('DELETE FROM purchase_bill_drafts');
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
    // Audit H11 — record the cleanup with the exact category list and the
    // confirming user's identity. Irreversible operations like this MUST
    // leave a trail.
    recordAudit({
      req, action: 'settings.cleanup',
      entityType: 'settings', entityId: 'cleanup',
      after: { categories: req.body.categories },
      notes: `Irreversible data wipe (${(req.body.categories || []).join(', ')})`,
    });
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

// ── Branding asset uploads (logo + signature) ──────────────────────
//
// Both endpoints accept ONE file (field name 'file') via multer's
// memory storage, validate the MIME type, write to BRANDING_DIR with
// a safe filename, then store the RELATIVE filename on the
// system_settings row. The frontend renders <img src="/api/settings/branding/<filename>" />
// so the asset lives behind auth — no public URL.
//
// Old asset is left on disk on replace (cheap garbage; an admin can
// clear the folder if disk space matters). Removing the old file
// would race with print jobs still rendering against it.

exports.uploadBrandingAsset = (assetKind /* 'logo' | 'signature' */) => async (req, res) => {
  if (!['logo', 'signature'].includes(assetKind)) {
    return res.status(400).json({ error: 'Unknown asset kind.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Send as multipart/form-data with field "file".' });
  }
  if (!ALLOWED_BRANDING_MIME.has(req.file.mimetype)) {
    return res.status(400).json({
      error: `File type ${req.file.mimetype} not allowed. Use PNG, JPEG, GIF, WebP, or SVG.`,
    });
  }
  if (req.file.size > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'File too large (max 5 MB).' });
  }
  try {
    const filename = _safeBrandingFilename(req.file.originalname, assetKind);
    const fullPath = path.join(BRANDING_DIR, filename);
    // Re-resolve and verify the resulting path is still within
    // BRANDING_DIR before writing. Defence-in-depth against any future
    // change to _safeBrandingFilename that lets a separator slip in.
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(BRANDING_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }
    await fs.promises.writeFile(resolved, req.file.buffer);
    // Persist only the BASENAME on the settings row — the GET endpoint
    // reconstructs the full path against BRANDING_DIR. Storing the
    // absolute path would break if BRANDING_DIR ever moves (Electron
    // install folder relocation, OS reinstall, etc.).
    const settings = await SystemSettings.findByPk(1);
    if (!settings) return res.status(500).json({ error: 'Settings row missing.' });
    const column = assetKind === 'logo' ? 'logo_path' : 'signature_path';
    await settings.update({ [column]: filename });
    res.json({ ok: true, filename, [column]: filename });
  } catch (error) {
    console.error('uploadBrandingAsset error:', error);
    res.status(500).json({ error: 'Upload failed.' });
  }
};

// GET /api/settings/branding/:kind — serves the stored logo OR
// signature inline. Kept behind auth (no public assets).
exports.getBrandingAsset = (assetKind) => async (req, res) => {
  if (!['logo', 'signature'].includes(assetKind)) {
    return res.status(400).json({ error: 'Unknown asset kind.' });
  }
  try {
    const settings = await SystemSettings.findByPk(1);
    const column = assetKind === 'logo' ? 'logo_path' : 'signature_path';
    const filename = settings && settings[column];
    if (!filename) return res.status(404).json({ error: 'No file uploaded yet.' });
    // Path-traversal guard on the filename read from the DB. A garbage
    // value (set via direct SQL, restore, etc.) cannot escape BRANDING_DIR.
    if (/[\\/]|\.\./.test(filename) || filename.includes('\0')) {
      return res.status(400).json({ error: 'Stored filename is unsafe.' });
    }
    const fullPath = path.resolve(path.join(BRANDING_DIR, filename));
    if (!fullPath.startsWith(path.resolve(BRANDING_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Stored filename resolves outside the branding directory.' });
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk.' });
    res.sendFile(fullPath);
  } catch (error) {
    console.error('getBrandingAsset error:', error);
    respondWithError(res, error);
  }
};

// DELETE /api/settings/branding/:kind — clears the column. Doesn't
// remove the file from disk (see comment on uploadBrandingAsset).
exports.removeBrandingAsset = (assetKind) => async (req, res) => {
  if (!['logo', 'signature'].includes(assetKind)) {
    return res.status(400).json({ error: 'Unknown asset kind.' });
  }
  try {
    const settings = await SystemSettings.findByPk(1);
    if (!settings) return res.status(404).json({ error: 'Settings row missing.' });
    const column = assetKind === 'logo' ? 'logo_path' : 'signature_path';
    await settings.update({ [column]: null });
    res.json({ ok: true });
  } catch (error) {
    respondWithError(res, error);
  }
};

// ── Self-service profile (My Account) ──────────────────────────────
//
// Three endpoints — all gated by authenticateToken only (no extra
// permission check; every logged-in user can view + edit their own
// profile and rotate their own password).
//
// SECURITY: an attacker with a stolen JWT could only edit THEIR OWN
// profile via these endpoints — the controller pins everything to
// req.user.user_id. They can't change role_id, custom_permissions,
// or allowed_godowns (those are administrative).

exports.getMyProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.user_id, {
      include: [{ model: Role }],
      attributes: { exclude: ['password_hash'] },
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({
      user_id:        user.user_id,
      username:       user.username,
      full_name:      user.full_name,
      email:          user.email,
      mobile_number:  user.mobile_number,
      role_name:      user.Role?.role_name || null,
      last_login:     user.last_login,
      created_date:   user.created_date,
      allowed_godowns: user.allowed_godowns,
      // Effective permission set (custom override OR role default) so
      // the My Account read-only "what I can do" section can render.
      permissions:    user.custom_permissions || user.Role?.permissions_json || {},
    });
  } catch (error) {
    console.error('getMyProfile error:', error);
    respondWithError(res, error);
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    // Only the four self-service columns are writable here. role_id,
    // is_active, custom_permissions, allowed_godowns are admin-only.
    const allowed = ['full_name', 'email', 'mobile_number'];
    const safe = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) safe[k] = req.body[k];
    }
    if (safe.full_name !== undefined) {
      const t = String(safe.full_name).trim();
      if (t.length === 0) return res.status(400).json({ error: 'Full name cannot be empty.', field: 'full_name' });
      if (t.length > 100) return res.status(400).json({ error: 'Full name too long (max 100 chars).', field: 'full_name' });
      safe.full_name = t;
    }
    if (safe.email !== undefined && safe.email !== '') {
      const r = fmt.validateEmail(safe.email);
      if (!r.ok) return res.status(400).json({ error: r.error, field: 'email' });
    }
    if (safe.mobile_number !== undefined && safe.mobile_number !== '') {
      const r = fmt.validateMobile(safe.mobile_number);
      if (!r.ok) return res.status(400).json({ error: r.error, field: 'mobile_number' });
      safe.mobile_number = r.normalized;
    }
    const user = await User.findByPk(req.user.user_id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await user.update(safe);
    res.json({ ok: true });
  } catch (error) {
    console.error('updateMyProfile error:', error);
    respondWithError(res, error);
  }
};
