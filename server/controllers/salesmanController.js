/*
 * Salesman CRUD controller.
 *
 * Concerns kept here:
 *   - List / create / update / soft-delete / hard-delete salesmen.
 *   - Controller-enforced uniqueness: name (case-insensitive) and code
 *     (case-insensitive, stored upper-cased). The DB carries NO unique
 *     constraint — see server/models/Salesman.js for why.
 *   - Refuse to hard-delete a salesman referenced by any sales bill; the
 *     supported path once a salesman has activity is soft-delete
 *     (PUT is_active=false), which preserves historical attribution.
 *
 * PURE ATTRIBUTION — this controller and its table never touch any total,
 * tax, discount, ledger voucher, balance, return, or stock figure. A salesman
 * is only ever a label on a bill. Do not import or call any financial helper
 * from here.
 *
 * Permissions (wired in routes/salesmen.js):
 *   - List/read: authenticated users (the bill-form dropdown needs the list).
 *   - Create/update/delete: settings.manage_company.
 */

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Salesman, SalesBill } = require('../models');

// Case-insensitive exact-name lookup that also tolerates names containing
// LIKE wildcards (so we compare on lower(name) rather than ILIKE).
function nameMatchWhere(name) {
  return sequelize.where(
    sequelize.fn('lower', sequelize.col('name')),
    String(name).trim().toLowerCase(),
  );
}

exports.getAll = async (req, res) => {
  try {
    const { include_inactive } = req.query;
    const where = include_inactive === 'true' ? {} : { is_active: true };
    const rows = await Salesman.findAll({
      where,
      order: [['is_active', 'DESC'], ['name', 'ASC']],
    });
    res.json(rows);
  } catch (err) {
    console.error('[salesman.getAll]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const row = await Salesman.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Salesman not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { name, code, phone, email, commission_percentage, notes } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const trimmedName = String(name).trim();
    const normCode = code && String(code).trim() ? String(code).trim().toUpperCase() : null;

    // Duplicate name (case-insensitive).
    const dupName = await Salesman.findOne({ where: nameMatchWhere(trimmedName) });
    if (dupName) {
      return res.status(400).json({ error: 'A salesman with that name already exists' });
    }
    // Duplicate code (only when a code is supplied).
    if (normCode) {
      const dupCode = await Salesman.findOne({ where: { code: normCode } });
      if (dupCode) {
        return res.status(400).json({ error: 'A salesman with that code already exists' });
      }
    }

    const row = await Salesman.create({
      name: trimmedName,
      code: normCode,
      phone: phone ? String(phone).trim() : null,
      email: email ? String(email).trim() : null,
      // Commission is informational only (reporting). Clamp to a sane range so
      // a typo can't store a nonsensical percentage; it is never auto-applied.
      commission_percentage: clampPct(commission_percentage),
      notes: notes ? String(notes).trim() : null,
      is_active: true,
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('[salesman.create]', err);
    res.status(500).json({ error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const row = await Salesman.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Salesman not found' });

    const updates = { ...req.body };

    // Server-managed / immutable fields — never accept from the client.
    delete updates.salesman_id;
    delete updates.created_date;
    delete updates.modified_date;

    if (updates.name !== undefined) {
      const trimmedName = String(updates.name).trim();
      if (!trimmedName) return res.status(400).json({ error: 'Name is required' });
      const dupName = await Salesman.findOne({
        where: { [Op.and]: [nameMatchWhere(trimmedName), { salesman_id: { [Op.ne]: row.salesman_id } }] },
      });
      if (dupName) return res.status(400).json({ error: 'A salesman with that name already exists' });
      updates.name = trimmedName;
    }

    if (updates.code !== undefined) {
      const normCode = updates.code && String(updates.code).trim()
        ? String(updates.code).trim().toUpperCase()
        : null;
      if (normCode) {
        const dupCode = await Salesman.findOne({
          where: { code: normCode, salesman_id: { [Op.ne]: row.salesman_id } },
        });
        if (dupCode) return res.status(400).json({ error: 'A salesman with that code already exists' });
      }
      updates.code = normCode;
    }

    if (updates.phone !== undefined) updates.phone = updates.phone ? String(updates.phone).trim() : null;
    if (updates.email !== undefined) updates.email = updates.email ? String(updates.email).trim() : null;
    if (updates.notes !== undefined) updates.notes = updates.notes ? String(updates.notes).trim() : null;
    if (updates.commission_percentage !== undefined) {
      updates.commission_percentage = clampPct(updates.commission_percentage);
    }

    await row.update(updates);
    res.json(row);
  } catch (err) {
    console.error('[salesman.update]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Hard-delete a salesman. Refuses when the salesman is referenced by any
 * sales bill — historical attribution must stay intact. In that case the UI
 * should offer soft-delete (PUT is_active=false), which hides the salesman
 * from the bill-form dropdown without rewriting past bills.
 */
exports.delete = async (req, res) => {
  try {
    const row = await Salesman.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Salesman not found' });

    const refCount = await SalesBill.count({ where: { salesman_id: row.salesman_id } });
    if (refCount > 0) {
      return res.status(400).json({
        error: `Salesman is credited on ${refCount} sales bill(s). Deactivate instead of deleting to preserve history.`,
      });
    }

    await row.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error('[salesman.delete]', err);
    res.status(500).json({ error: err.message });
  }
};

// Clamp commission to [0, 100] with 2-dp; returns 0 for blank/invalid.
// Informational only — never applied to any money calculation.
function clampPct(v) {
  const n = parseFloat(v);
  if (!isFinite(n) || n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}
